from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.auth import Principal
from app.schemas import IngredientCreate, MovementCreate
from app.service import create_ingredient


class FakeIngredients:
    def __init__(self):
        self.docs = {}

    def insert_one(self, doc, session=None):
        self.docs[doc["_id"]] = dict(doc)

    def find_one_and_update(self, query, update, return_document=None, session=None):
        doc = self.docs.get(query["_id"])
        if not doc or doc["restaurant_id"] != query["restaurant_id"] or not doc["active"]:
            return None
        minimum = query.get("current_quantity", {}).get("$gte")
        if minimum is not None and doc["current_quantity"] < minimum:
            return None
        doc["current_quantity"] += update["$inc"]["current_quantity"]
        doc.update(update.get("$set", {}))
        return dict(doc)

    def find_one(self, query, session=None):
        doc = self.docs.get(query["_id"])
        return doc if doc and doc["restaurant_id"] == query["restaurant_id"] else None


class FakeMovements:
    def __init__(self):
        self.docs = []

    def insert_one(self, doc, session=None):
        self.docs.append(dict(doc))

    def find_one(self, query, session=None):
        return next((doc for doc in self.docs if all(doc.get(key) == value for key, value in query.items())), None)

    def update_one(self, query, update, session=None):
        doc = self.find_one(query, session)
        if doc:
            doc.update(update.get("$set", {}))


class FakeSession:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def with_transaction(self, callback):
        return callback(self)


class FakeClient:
    def start_session(self):
        return FakeSession()


class FakeDb:
    def __init__(self):
        self.ingredients = FakeIngredients()
        self.movements = FakeMovements()
        self.client = FakeClient()


@pytest.fixture
def setup():
    db = FakeDb()
    principal = Principal("user-a", "restaurant-a", ("admin",))
    data = IngredientCreate(name="Tomate", category="Hortifruti", base_unit="kg", initial_quantity=5)
    doc = create_ingredient(db, data, principal)
    return db, principal, doc


def test_initial_balance_always_creates_audited_movement(setup):
    db, _, item = setup
    assert item["current_quantity"] == 5
    assert len(db.movements.docs) == 1
    assert db.movements.docs[0]["balance_after"] == 5


def test_negative_stock_is_rejected(setup):
    db, principal, item = setup
    with pytest.raises(HTTPException) as error:
        from app.service import append_movement
        append_movement(db, item["_id"], MovementCreate(kind="adjustment_out", quantity=6, reason="Count"), principal, "count-1")
    assert error.value.status_code == 409
    assert item["current_quantity"] == 5


def test_cross_restaurant_stock_access_is_not_found(setup):
    db, _, item = setup
    other = Principal("user-b", "restaurant-b", ("admin",))
    from app.service import append_movement
    with pytest.raises(HTTPException) as error:
        append_movement(db, item["_id"], MovementCreate(kind="purchase", quantity=2, reason="Receipt"), other, "receipt-1")
    assert error.value.status_code == 404


def test_purchase_updates_balance_and_records_actor(setup):
    db, principal, item = setup
    from app.service import append_movement
    movement = append_movement(
        db, item["_id"], MovementCreate(kind="purchase", quantity=2, reason="Invoice 42"), principal, "invoice-42"
    )
    assert db.ingredients.docs[item["_id"]]["current_quantity"] == 7
    assert movement["balance_after"] == 7
    assert movement["actor_id"] == principal.user_id
    assert movement["idempotency_key"] == "invoice-42"


def test_same_movement_key_returns_original_result_without_double_stock_change(setup):
    db, principal, item = setup
    from app.service import append_movement
    data = MovementCreate(kind="purchase", quantity=2, reason="Invoice 42")
    first = append_movement(db, item["_id"], data, principal, "same-invoice")
    retry = append_movement(db, item["_id"], data, principal, "same-invoice")
    assert retry["_id"] == first["_id"]
    assert db.ingredients.docs[item["_id"]]["current_quantity"] == 7
    assert len(db.movements.docs) == 2


def test_reused_movement_key_with_different_payload_is_rejected(setup):
    db, principal, item = setup
    from app.service import append_movement
    append_movement(db, item["_id"], MovementCreate(kind="purchase", quantity=2, reason="Invoice 42"),
                    principal, "same-invoice")
    with pytest.raises(HTTPException) as error:
        append_movement(db, item["_id"], MovementCreate(kind="purchase", quantity=3, reason="Invoice 43"),
                        principal, "same-invoice")
    assert error.value.status_code == 409
    assert db.ingredients.docs[item["_id"]]["current_quantity"] == 7
