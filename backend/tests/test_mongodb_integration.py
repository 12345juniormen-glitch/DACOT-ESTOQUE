import os
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError

from app.auth import Principal, create_local_session, digest
from app.config import Settings
from app.database import Database
from app.schemas import IngredientCreate, MovementCreate, PurchaseCreate, PurchaseLineCreate, PurchaseReceive, PurchaseReceiveLine
from app.service import append_movement, create_ingredient, create_purchase, receive_purchase

TEST_URI = os.getenv("MONGODB_TEST_URI")
pytestmark = pytest.mark.skipif(not TEST_URI, reason="MONGODB_TEST_URI not set (isolated non-production MongoDB required)")


@pytest.fixture
def store():
    database_name = f"dacot_estoque_tests_{uuid4().hex}"
    database = Database(Settings(mongodb_uri=TEST_URI, mongodb_database=database_name, environment="test"))
    database.ensure_indexes()
    yield database.db
    database.client.drop_database(database_name)
    database.close()


def test_concurrent_decrements_cannot_overdraw(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Rice", category="Secos", base_unit="kg",
                                                      initial_quantity=10), principal)

    def take(index):
        try:
            append_movement(store, item["_id"], MovementCreate(kind="adjustment_out", quantity=7,
                           reason="Concurrent test"), principal, f"concurrent-{index}")
            return True
        except HTTPException as exc:
            if exc.status_code == 409:
                return False
            raise

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(take, (1, 2)))
    current = store.ingredients.find_one({"_id": item["_id"], "restaurant_id": principal.restaurant_id})
    assert sum(results) == 1
    assert current["current_quantity"] == 3
    assert store.movements.count_documents({"ingredient_id": item["_id"]}) == 2


def test_failed_movement_insert_rolls_back_balance(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Flour", category="Secos", base_unit="kg",
                                                      initial_quantity=4), principal)
    append_movement(store, item["_id"], MovementCreate(kind="purchase", quantity=1, reason="once"),
                    principal, "unique-receipt-key")
    with pytest.raises(HTTPException) as error:
        append_movement(store, item["_id"], MovementCreate(kind="purchase", quantity=2, reason="duplicate"),
                        principal, "unique-receipt-key")
    assert error.value.status_code == 409
    current = store.ingredients.find_one({"_id": item["_id"], "restaurant_id": principal.restaurant_id})
    assert current["current_quantity"] == 5


def test_purchase_receipt_is_atomic_and_idempotent(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Oil", category="Secos", base_unit="l"), principal)
    purchase_data = PurchaseCreate(lines=[PurchaseLineCreate(ingredient_id=item["_id"], quantity_ordered=3,
                               unit="l", expected_unit_cost_cents=1000)])
    purchase = create_purchase(store, purchase_data, principal, "purchase-key")
    store.purchases.update_one({"_id": purchase["_id"]}, {"$set": {"status": "requested"}})
    line_id = purchase["lines"][0]["id"]
    receipt = PurchaseReceive(lines=[PurchaseReceiveLine(line_id=line_id, quantity_received=2,
                             unit_cost_cents=1200)])
    result = receive_purchase(store, purchase["_id"], receipt, principal, "receipt-key")
    assert result["status"] == "partial"
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == 2
    retry = receive_purchase(store, purchase["_id"], receipt, principal, "receipt-key")
    assert retry["status"] == "partial"
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == 2


def test_purchase_creation_is_idempotent_and_tenant_scoped(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Beans", category="Secos", base_unit="kg"), principal)
    data = PurchaseCreate(lines=[PurchaseLineCreate(ingredient_id=item["_id"], quantity_ordered=4,
                         unit="kg", expected_unit_cost_cents=800)])
    first = create_purchase(store, data, principal, "purchase-retry-key")
    retry = create_purchase(store, data, principal, "purchase-retry-key")
    assert retry["_id"] == first["_id"]
    assert store.purchases.count_documents({"restaurant_id": principal.restaurant_id}) == 1
    with pytest.raises(HTTPException) as conflict:
        create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
            ingredient_id=item["_id"], quantity_ordered=9, unit="kg", expected_unit_cost_cents=800,
        )]), principal, "purchase-retry-key")
    assert conflict.value.status_code == 409
    other = Principal("test-user-2", "65a000000000000000000003", ("manager",))
    other_item = create_ingredient(store, IngredientCreate(name="Beans", category="Secos", base_unit="kg"), other)
    other_data = PurchaseCreate(lines=[PurchaseLineCreate(ingredient_id=other_item["_id"], quantity_ordered=4,
                               unit="kg", expected_unit_cost_cents=800)])
    other_retry = create_purchase(store, other_data, other, "purchase-retry-key")
    assert other_retry["_id"] != first["_id"]


def test_purchase_cannot_reference_another_restaurants_ingredient(store):
    owner = Principal("owner-a", "65a000000000000000000002", ("manager",))
    other = Principal("owner-b", "65a000000000000000000003", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Salt", category="Secos", base_unit="kg"), owner)
    data = PurchaseCreate(lines=[PurchaseLineCreate(ingredient_id=item["_id"], quantity_ordered=1,
                         unit="kg", expected_unit_cost_cents=100)])
    with pytest.raises(HTTPException) as error:
        create_purchase(store, data, other, "cross-tenant-purchase")
    assert error.value.status_code == 422
    assert store.purchases.count_documents({"restaurant_id": other.restaurant_id}) == 0


def test_failed_purchase_receipt_rolls_back_purchase_receipt_and_stock(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Tomatoes", category="Hortifruti",
        base_unit="kg", initial_quantity=2), principal)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=item["_id"], quantity_ordered=3, unit="kg", expected_unit_cost_cents=500,
    )]), principal, "rollback-purchase")
    store.purchases.update_one({"_id": purchase["_id"]}, {"$set": {"status": "requested"}})
    store.ingredients.update_one({"_id": item["_id"], "restaurant_id": principal.restaurant_id},
                                 {"$set": {"active": False}})
    receipt = PurchaseReceive(lines=[PurchaseReceiveLine(
        line_id=purchase["lines"][0]["id"], quantity_received=1, unit_cost_cents=550,
    )])

    with pytest.raises(HTTPException) as error:
        receive_purchase(store, purchase["_id"], receipt, principal, "rollback-receipt")

    assert error.value.status_code == 409
    current_purchase = store.purchases.find_one({"_id": purchase["_id"],
                                                 "restaurant_id": principal.restaurant_id})
    assert current_purchase["status"] == "requested"
    assert current_purchase["lines"][0]["quantity_received"] == 0
    assert store.purchase_receipts.count_documents({"restaurant_id": principal.restaurant_id,
                                                    "idempotency_key": "rollback-receipt"}) == 0
    current_item = store.ingredients.find_one({"_id": item["_id"],
                                               "restaurant_id": principal.restaurant_id})
    assert current_item["current_quantity"] == 2
    assert store.movements.count_documents({"restaurant_id": principal.restaurant_id,
                                            "purchase_reference": purchase["_id"]}) == 0


def test_handoff_consumption_and_local_session_are_persisted_once(store):
    tab_id = str(uuid4())
    claims = {
        "sub": "tenant_user:65a000000000000000000001",
        "restaurant_id": "65a000000000000000000002", "restaurant_slug": "test-restaurant",
        "role": "manager", "hub_access": {"user": 1, "tenant": 2, "module": 3},
        "jti": "mongo-test-handoff-jti-unique", "exp": 2_000_000_000,
    }
    create_local_session(store, binding="test-browser-binding", tab_id=tab_id, claims=claims)
    session = store.auth_sessions.find_one({
        "browser_binding_hash": digest("test-browser-binding"),
        "tab_session_id_hash": digest(tab_id),
    })
    assert session["user_id"] == claims["sub"].removeprefix("tenant_user:")
    assert session["restaurant_id"] == claims["restaurant_id"]
    assert session["hub_access"] == claims["hub_access"]
    assert store.consumed_handoffs.count_documents({"_id": claims["jti"]}) == 1

    with pytest.raises(DuplicateKeyError):
        create_local_session(store, binding="another-binding", tab_id=str(uuid4()), claims=claims)
    assert store.auth_sessions.count_documents({}) == 1
    assert store.consumed_handoffs.count_documents({"_id": claims["jti"]}) == 1
