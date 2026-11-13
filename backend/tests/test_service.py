from types import SimpleNamespace
from datetime import timezone

import pytest
from fastapi import HTTPException

from app.auth import Principal
from app.schemas import (CountCreate, CountLineUpdate, CountSelection, IngredientCreate, LossCreate, MovementCreate,
                         PurchaseCreate, PurchaseLineCreate, PurchaseReceive, PurchaseReceiveLine, SupplierCreate)
from app.service import (_apply_movement, _recipe_snapshot, create_count, create_ingredient, create_purchase, create_supplier, fingerprint,
                         ingredient_price_history, list_audit_entries, list_purchase_receipts, now, register_loss, set_recipe_active)


class FakeIngredients:
    def __init__(self):
        self.docs = {}

    def insert_one(self, doc, session=None):
        self.docs[doc["_id"]] = dict(doc)

    def find_one_and_update(self, query, update, return_document=None, session=None):
        doc = self.docs.get(query["_id"])
        if not doc or doc["restaurant_id"] != query["restaurant_id"] or not doc["active"]:
            return None
        for key, expected in query.items():
            if key in {"_id", "restaurant_id", "active"}:
                continue
            if isinstance(expected, dict) and "$exists" in expected:
                if (key in doc) != expected["$exists"]:
                    return None
            elif doc.get(key) != expected:
                return None
        for key, amount in update.get("$inc", {}).items():
            doc[key] = doc.get(key, 0) + amount
        doc.update(update.get("$set", {}))
        return dict(doc)

    def update_one(self, query, update, session=None):
        doc = self.docs.get(query.get("_id"))
        if not doc or any(doc.get(key) != value for key, value in query.items()
                          if not isinstance(value, dict)):
            return SimpleNamespace(matched_count=0, modified_count=0)
        for key, value in update.get("$inc", {}).items():
            doc[key] = doc.get(key, 0) + value
        doc.update(update.get("$set", {}))
        return SimpleNamespace(matched_count=1, modified_count=1)

    def find_one(self, query, session=None):
        if "_id" in query:
            doc = self.docs.get(query["_id"])
            return doc if doc and all(doc.get(key) == value for key, value in query.items()) else None
        return next((doc for doc in self.docs.values()
                     if all(doc.get(key) == value for key, value in query.items())), None)

    def find(self, query=None, session=None):
        query = query or {}
        wanted_ids = query.get("_id", {}).get("$in")
        return [dict(doc) for doc in self.docs.values()
                if (wanted_ids is None or doc.get("_id") in wanted_ids)
                and all(doc.get(key) == value for key, value in query.items() if key != "_id")]


class FakeMovements:
    def __init__(self):
        self.docs = []

    def insert_one(self, doc, session=None):
        self.docs.append(dict(doc))

    def find_one(self, query, session=None):
        def matches(doc):
            for key, value in query.items():
                if isinstance(value, dict) and "$exists" in value:
                    if (key in doc) != value["$exists"]:
                        return False
                elif doc.get(key) != value:
                    return False
            return True
        return next((doc for doc in self.docs if matches(doc)), None)

    def update_one(self, query, update, session=None):
        doc = self.find_one(query, session)
        if doc:
            for key, expected in query.items():
                if isinstance(expected, dict) and "$exists" in expected and (key in doc) != expected["$exists"]:
                    return SimpleNamespace(modified_count=0)
            doc.update(update.get("$set", {}))
            return SimpleNamespace(modified_count=1)
        return SimpleNamespace(modified_count=0)


class FakeLosses:
    def __init__(self):
        self.docs = {}

    def find_one(self, query, session=None):
        return next((doc for doc in self.docs.values()
                     if all(doc.get(key) == value for key, value in query.items())), None)

    def insert_one(self, doc, session=None):
        self.docs[doc["_id"]] = dict(doc)


class FakeSuppliers(FakeLosses):
    pass


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


class FakeAuditCursor:
    def __init__(self, values):
        self.values = values

    def sort(self, keys, *_args, **_kwargs):
        if isinstance(keys, list):
            for key, direction in reversed(keys):
                if key == "_id":
                    self.values.sort(key=lambda row: row.get(key), reverse=direction < 0)
                else:
                    self.values.sort(key=lambda row: row.get(key), reverse=direction < 0)
        else:
            self.values.sort(key=lambda row: row.get(keys), reverse=(_args and _args[0] < 0))
        return self

    def limit(self, count):
        self.values = self.values[:count]
        return self

    def __iter__(self):
        return iter(self.values)


class FakeAuditCollection:
    def __init__(self, values=()):
        self.values = list(values)

    def find(self, query=None, *_args, **_kwargs):
        query = query or {}
        def comparable(left, right):
            if hasattr(left, "tzinfo") and hasattr(right, "tzinfo"):
                left = left.replace(tzinfo=timezone.utc) if left.tzinfo is None else left.astimezone(timezone.utc)
                right = right.replace(tzinfo=timezone.utc) if right.tzinfo is None else right.astimezone(timezone.utc)
            return left, right

        def matches(document):
            for key, expected in query.items():
                if key == "$or":
                    if not any(all(
                        ((document.get(branch_key) is not None and comparable(document[branch_key], condition["$lt"])[0]
                          < comparable(document[branch_key], condition["$lt"])[1])
                         if "$lt" in condition else comparable(document.get(branch_key), condition)[0]
                         == comparable(document.get(branch_key), condition)[1])
                        if isinstance(condition, dict) else
                        (comparable(document.get(branch_key), condition)[0] == comparable(document.get(branch_key), condition)[1]
                         if hasattr(condition, "tzinfo") else document.get(branch_key) == condition)
                        for branch_key, condition in branch.items()
                    ) for branch in expected):
                        return False
                    continue
                if isinstance(expected, dict) and "$exists" in expected:
                    if (key in document) != expected["$exists"]:
                        return False
                elif isinstance(expected, dict):
                    value = document.get(key)
                    if "$lt" in expected and not (value is not None and comparable(value, expected["$lt"])[0] < comparable(value, expected["$lt"])[1]):
                        return False
                    if "$lte" in expected and not (value is not None and comparable(value, expected["$lte"])[0] <= comparable(value, expected["$lte"])[1]):
                        return False
                elif document.get(key) != expected:
                    return False
            return True
        return FakeAuditCursor([value for value in self.values if matches(value)])

    def insert_one(self, document, session=None):
        self.values.append(dict(document))


class FakeAuditDb:
    def __init__(self, movements):
        self.ingredients = FakeAuditCollection()
        self.suppliers = FakeAuditCollection()
        self.purchases = FakeAuditCollection()
        self.movements = FakeAuditCollection(movements)
        self.losses = FakeAuditCollection()
        self.purchase_changes = FakeAuditCollection()
        self.recipe_snapshots = FakeAuditCollection()
        self.counts = FakeAuditCollection()
        self.purchase_receipts = FakeAuditCollection()
        self.audit_events = FakeAuditCollection()


class FakeDb:
    def __init__(self):
        self.ingredients = FakeIngredients()
        self.movements = FakeMovements()
        self.losses = FakeLosses()
        self.suppliers = FakeSuppliers()
        self.audit_events = FakeAuditCollection()
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
    assert item["current_quantity_milli"] == 5000
    assert len(db.movements.docs) == 1
    assert db.movements.docs[0]["balance_after"] == 5
    assert db.movements.docs[0]["kind"] == "adjustment_in"
    assert db.movements.docs[0]["purchase_reference"] == "INITIAL"
    assert db.movements.docs[0]["reason"] == "Saldo inicial cadastrado"


def test_converted_stock_quantity_overflow_is_rejected_before_any_write(setup):
    from app.service import append_movement

    db, principal, item = setup
    db.ingredients.docs[item["_id"]]["conversions"] = {"caixa": 999_999}
    before = item["current_quantity_milli"]
    with pytest.raises(HTTPException) as error:
        append_movement(db, item["_id"], MovementCreate(
            kind="adjustment_in", quantity=9_000_000_000_000_000,
            unit="caixa", reason="Teste de limite", expected_balance=5), principal,
            "overflow-key")

    assert error.value.status_code == 422
    assert db.ingredients.docs[item["_id"]]["current_quantity_milli"] == before
    assert len(db.movements.docs) == 1


def test_ingredient_create_preserves_explicit_zero_cost_as_known():
    db = FakeDb()
    principal = Principal("user-a", "restaurant-a", ("admin",))
    created = create_ingredient(db, IngredientCreate(name="Water", category="Outros",
        base_unit="l", cost_cents=0, cost_known=True), principal)

    assert created["cost_cents"] == 0
    assert created["cost_known"] is True
    assert created["cost_updated_at"] is not None


def test_ingredient_create_ignores_client_supplied_restaurant_id():
    db = FakeDb()
    principal = Principal("user-a", "restaurant-authenticated", ("admin",))
    data = IngredientCreate.model_validate({
        "name": "Tenant Scoped Item", "category": "Secos", "base_unit": "kg",
        "restaurant_id": "restaurant-from-client", "initial_quantity": 0,
    })

    created = create_ingredient(db, data, principal)

    assert created["restaurant_id"] == principal.restaurant_id
    assert "restaurant_id" not in data.model_dump()


def test_count_reconciliation_can_adjust_inactive_stock_but_manual_adjustments_cannot():
    principal = Principal("user-a", "restaurant-a", ("manager",))
    ingredient = {"_id": "inactive-item", "restaurant_id": principal.restaurant_id,
        "name": "Discontinued stock", "active": False, "base_unit": "kg",
        "current_quantity": 3, "current_quantity_milli": 3000, "cost_cents": 1000}

    class IngredientCollection:
        update_queries = []
        read_queries = []

        def find_one(self, query, session=None):
            self.read_queries.append(dict(query))
            if query.get("_id") != ingredient["_id"] or query.get("restaurant_id") != principal.restaurant_id:
                return None
            if query.get("active") is True and ingredient["active"] is False:
                return None
            return dict(ingredient)

        def find_one_and_update(self, query, update, return_document=None, session=None):
            self.update_queries.append(dict(query))
            if query.get("active") is True and ingredient["active"] is False:
                return None
            if query.get("current_quantity_milli") != ingredient["current_quantity_milli"]:
                return None
            ingredient.update(update["$set"])
            return dict(ingredient)

    ingredients = IngredientCollection()
    movements = FakeMovements()
    db = SimpleNamespace(ingredients=ingredients, movements=movements)

    movement = _apply_movement(db, ingredient["_id"], MovementCreate(kind="count_out",
        quantity=0.5, reason="Contagem física CT-0001"), principal, "count:line", None)

    assert movement["balance_after"] == 2.5
    assert "active" not in ingredients.update_queries[-1]
    with pytest.raises(HTTPException) as error:
        _apply_movement(db, ingredient["_id"], MovementCreate(kind="adjustment_out",
            quantity=0.25, reason="Ajuste manual"), principal, "manual:key", None)
    assert error.value.status_code == 409
    assert ingredients.read_queries[-2].get("active") is True


def test_count_creation_freezes_server_resolved_selection_candidates():
    principal = Principal("user-a", "restaurant-a", ("manager",))
    ingredients = [
        {"_id": "item-b", "restaurant_id": principal.restaurant_id, "name": "B", "name_normalized": "b",
         "current_quantity": 2, "current_quantity_milli": 2000, "base_unit": "kg"},
        {"_id": "item-a", "restaurant_id": principal.restaurant_id, "name": "A", "name_normalized": "a",
         "current_quantity": 4, "current_quantity_milli": 4000, "base_unit": "un"},
        {"_id": "foreign", "restaurant_id": "restaurant-b", "name": "Foreign", "name_normalized": "foreign",
         "current_quantity": 9, "current_quantity_milli": 9000, "base_unit": "kg"},
    ]

    class Cursor(list):
        def sort(self, fields):
            for field, direction in reversed(fields):
                super().sort(key=lambda row: row.get(field, ""), reverse=direction < 0)
            return self

        def limit(self, count):
            return Cursor(self[:count])

    class Ingredients:
        def find(self, query, session=None):
            rows = [row for row in ingredients if row["restaurant_id"] == query["restaurant_id"]]
            ids = query.get("_id", {})
            if "$in" in ids:
                rows = [row for row in rows if row["_id"] in ids["$in"]]
            if "$nin" in ids:
                rows = [row for row in rows if row["_id"] not in ids["$nin"]]
            return Cursor(rows)

    class Counts:
        rows = []

        def find_one(self, query, session=None):
            return next((row for row in self.rows if all(row.get(key) == value for key, value in query.items())), None)

        def insert_one(self, row, session=None):
            self.rows.append(dict(row))

    class Counters:
        value = 0

        def find_one_and_update(self, query, update, **_kwargs):
            self.value += update["$inc"]["value"]
            return {"value": self.value}

    db = SimpleNamespace(client=FakeClient(), ingredients=Ingredients(), counts=Counts(), counters=Counters(),
        audit_events=FakeAuditCollection())
    count = create_count(db, CountCreate(selection=CountSelection(scope="all", exclude_ids=["item-b"])),
                         principal, "count-selection")

    assert [line["ingredient_id"] for line in count["lines"]] == ["item-a"]
    assert count["lines"][0]["expected_quantity_milli"] == 4000
    assert count["create_audit_event_id"]


def test_ingredient_create_replays_same_result_without_duplicate_initial_movement():
    db = FakeDb()
    principal = Principal("user-a", "restaurant-a", ("admin",))
    data = IngredientCreate(name="Rice", category="Secos", base_unit="kg", initial_quantity=3)

    first = create_ingredient(db, data, principal, "ingredient-request-1")
    replay = create_ingredient(db, data, principal, "ingredient-request-1")

    assert replay["_id"] == first["_id"]
    assert replay["current_quantity"] == 3
    assert len(db.ingredients.docs) == 1
    assert len(db.movements.docs) == 1
    assert len(db.audit_events.values) == 1


def test_ingredient_idempotency_key_rejects_changed_payload_and_is_tenant_scoped():
    db = FakeDb()
    principal = Principal("user-a", "restaurant-a", ("admin",))
    first = IngredientCreate(name="Rice", category="Secos", base_unit="kg")
    create_ingredient(db, first, principal, "shared-request-key")

    with pytest.raises(HTTPException) as conflict:
        create_ingredient(db, first.model_copy(update={"name": "Beans"}), principal, "shared-request-key")
    assert conflict.value.status_code == 409

    other = Principal("user-b", "restaurant-b", ("admin",))
    other_tenant = create_ingredient(db, first, other, "shared-request-key")
    assert other_tenant["restaurant_id"] == "restaurant-b"
    assert len(db.ingredients.docs) == 2


def test_supplier_create_replays_and_rejects_changed_payload():
    db = FakeDb()
    principal = Principal("user-a", "restaurant-a", ("admin",))
    data = SupplierCreate(name="Fresh Foods")

    first = create_supplier(db, data, principal, "supplier-request-1")
    replay = create_supplier(db, data, principal, "supplier-request-1")

    assert replay["_id"] == first["_id"]
    assert len(db.suppliers.docs) == 1
    assert len(db.audit_events.values) == 1
    with pytest.raises(HTTPException) as conflict:
        create_supplier(db, data.model_copy(update={"name": "Other Foods"}), principal,
                        "supplier-request-1")
    assert conflict.value.status_code == 409


def test_recipe_activation_is_tenant_scoped_versioned_and_audited():
    class Recipes:
        def __init__(self):
            self.document = {"_id": "recipe_restaurant-a_burger",
                "restaurant_id": "restaurant-a", "product_id": "burger",
                "product_name": "Burger", "active": True, "version": 1}

        def find_one(self, query, session=None):
            doc = self.document
            return dict(doc) if all(doc.get(key) == value for key, value in query.items()) else None

        def find_one_and_update(self, query, update, return_document=None, session=None):
            if not all(self.document.get(key) == value for key, value in query.items()):
                return None
            self.document.update(update["$set"])
            return dict(self.document)

    db = FakeDb()
    db.recipes = Recipes()
    principal = Principal("manager-a", "restaurant-a", ("manager",))

    inactive = set_recipe_active(db, "burger", False, 1, principal)

    assert inactive["active"] is False
    assert inactive["version"] == 2
    assert inactive["updated_by"] == principal.user_id
    assert db.audit_events.values[0]["before"] == "ativa"
    assert db.audit_events.values[0]["after"] == "inativa"
    assert db.audit_events.values[0]["restaurant_id"] == principal.restaurant_id
    assert set_recipe_active(db, "burger", False, 1, principal)["version"] == 2
    with pytest.raises(HTTPException) as stale:
        set_recipe_active(db, "burger", True, 1, principal)
    assert stale.value.status_code == 409
    with pytest.raises(HTTPException) as other_tenant:
        set_recipe_active(db, "burger", True, 2,
                          Principal("manager-b", "restaurant-b", ("manager",)))
    assert other_tenant.value.status_code == 404


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
        append_movement(db, item["_id"], MovementCreate(kind="adjustment_out", quantity=2, reason="Ajuste"), other, "receipt-1")
    assert error.value.status_code == 404


def test_manual_movement_endpoint_rejects_internal_purchase_count_and_loss_events(setup):
    db, principal, item = setup
    from app.service import append_movement
    invalid_payloads = [
        MovementCreate(kind="purchase", quantity=2, reason="Compra falsa"),
        MovementCreate(kind="count_in", quantity=2, reason="Contagem falsa"),
        MovementCreate(kind="loss", quantity=2, reason="Perda fora do fluxo"),
        MovementCreate(kind="adjustment_in", quantity=2, reason="Fornecedor forjado", supplier_id="supplier-x"),
        MovementCreate(kind="adjustment_in", quantity=2, reason="Pedido forjado", purchase_reference="purchase-x"),
        MovementCreate(kind="adjustment_in", quantity=2, reason="Custo forjado", unit_cost_cents=999_999),
    ]
    for index, data in enumerate(invalid_payloads):
        with pytest.raises(HTTPException) as error:
            append_movement(db, item["_id"], data, principal, f"forbidden-{index}")
        assert error.value.status_code == 422
    assert db.ingredients.docs[item["_id"]]["current_quantity"] == 5
    assert len(db.movements.docs) == 1


def test_manual_outgoing_movement_reduces_balance_and_records_audit(setup):
    db, principal, item = setup
    from app.service import append_movement
    movement = append_movement(
        db, item["_id"], MovementCreate(kind="adjustment_out", quantity=1.25,
                                         reason="Consumo manual"), principal, "manual-out-1"
    )

    assert db.ingredients.docs[item["_id"]]["current_quantity"] == 3.75
    assert movement["kind"] == "adjustment_out"
    assert movement["balance_before"] == 5
    assert movement["balance_after"] == 3.75
    assert movement["stock_version_after"] == 2
    assert db.ingredients.docs[item["_id"]]["stock_version"] == 2
    event = next(event for event in db.audit_events.values if event.get("source_id") == movement["_id"])
    assert event["before"] == "5.0"
    assert event["after"] == "3.75"


def test_same_movement_key_returns_original_result_without_double_stock_change(setup):
    db, principal, item = setup
    from app.service import append_movement
    data = MovementCreate(kind="adjustment_in", quantity=2, reason="Entrada manual")
    first = append_movement(db, item["_id"], data, principal, "same-invoice")
    retry = append_movement(db, item["_id"], data, principal, "same-invoice")
    assert retry["_id"] == first["_id"]
    assert db.ingredients.docs[item["_id"]]["current_quantity"] == 7
    assert len(db.movements.docs) == 2


def test_purchase_retry_returns_original_before_revalidating_current_catalog():
    principal = Principal("user-a", "restaurant-a", ("manager",))
    data = PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id="ingredient-now-inactive", quantity_ordered=2,
        unit="kg", expected_unit_cost_cents=500,
    )])
    prior = {"_id": "purchase-original", "restaurant_id": principal.restaurant_id,
             "idempotency_key": "purchase-retry", "request_fingerprint": fingerprint(
                 data.model_dump(mode="json"))}

    class Purchases:
        def find_one(self, query, *_args, **_kwargs):
            assert query == {"restaurant_id": principal.restaurant_id,
                             "idempotency_key": "purchase-retry"}
            return prior

    class NeverReadIngredients:
        def find(self, *_args, **_kwargs):
            raise AssertionError("a completed idempotent retry must not revalidate the catalog")

    result = create_purchase(SimpleNamespace(purchases=Purchases(), ingredients=NeverReadIngredients()),
                             data, principal, "purchase-retry")
    assert result is prior


def test_reused_movement_key_with_different_payload_is_rejected(setup):
    db, principal, item = setup
    from app.service import append_movement
    append_movement(db, item["_id"], MovementCreate(kind="adjustment_in", quantity=2, reason="Entrada manual"),
                    principal, "same-invoice")
    with pytest.raises(HTTPException) as error:
        append_movement(db, item["_id"], MovementCreate(kind="adjustment_in", quantity=3, reason="Entrada manual diferente"),
                        principal, "same-invoice")
    assert error.value.status_code == 409
    assert db.ingredients.docs[item["_id"]]["current_quantity"] == 7


def test_manual_movement_reversal_is_compensating_audited_and_idempotent(setup):
    from app.service import append_movement, reverse_manual_movement
    from app.schemas import MovementReversal

    db, principal, item = setup
    original = append_movement(db, item["_id"], MovementCreate(
        kind="adjustment_out", quantity=1.25, reason="Saída lançada por engano"), principal, "manual-out-reversible")
    data = MovementReversal(reason="Lançamento incorreto")
    reversal = reverse_manual_movement(db, original["_id"], data, principal, "manual-out-reversal")
    assert reversal["kind"] == "adjustment_in"
    assert reversal["quantity_milli"] == 1250
    assert reversal["reversal_of"] == original["_id"]
    assert original["stock_version_after"] == 2
    assert reversal["stock_version_after"] == 3
    assert db.ingredients.docs[item["_id"]]["stock_version"] == 3
    assert db.ingredients.docs[item["_id"]]["current_quantity"] == 5
    assert db.movements.find_one({"_id": original["_id"]})["reversed_by_movement_id"] == reversal["_id"]

    retry = reverse_manual_movement(db, original["_id"], data, principal, "manual-out-reversal")
    assert retry["_id"] == reversal["_id"]
    assert db.ingredients.docs[item["_id"]]["current_quantity"] == 5
    assert len(db.movements.docs) == 3

    with pytest.raises(HTTPException) as reversal_of_reversal:
        reverse_manual_movement(db, reversal["_id"], data, principal, "manual-reversal-chain")
    assert reversal_of_reversal.value.status_code == 409

    with pytest.raises(HTTPException) as second_reversal:
        reverse_manual_movement(db, original["_id"], MovementReversal(reason="Outro motivo"),
                                principal, "manual-out-reversal-2")
    assert second_reversal.value.status_code == 409


def test_manual_movement_reversal_rejects_cross_tenant_and_non_manual_movements(setup):
    from app.service import append_movement, reverse_manual_movement
    from app.schemas import MovementReversal

    db, principal, item = setup
    purchase = {"_id": "internal-purchase-movement", "restaurant_id": principal.restaurant_id,
                "ingredient_id": item["_id"], "kind": "purchase", "quantity_milli": 1000,
                "unit_cost_cents": 100, "unit": "kg"}
    db.movements.insert_one(purchase)
    with pytest.raises(HTTPException) as non_manual:
        reverse_manual_movement(db, purchase["_id"], MovementReversal(reason="Correção"),
                                principal, "purchase-reversal-key")
    assert non_manual.value.status_code == 409

    other = Principal("other", "restaurant-b", ("manager",))
    with pytest.raises(HTTPException) as cross_tenant:
        reverse_manual_movement(db, purchase["_id"], MovementReversal(reason="Correção"),
                                other, "cross-tenant-reversal-key")
    assert cross_tenant.value.status_code == 404


def test_reversal_of_incoming_adjustment_refuses_to_create_negative_stock(setup):
    from app.service import append_movement, reverse_manual_movement
    from app.schemas import MovementReversal

    db, principal, item = setup
    original = append_movement(db, item["_id"], MovementCreate(
        kind="adjustment_in", quantity=2, reason="Entrada manual"), principal, "manual-in-reversible")
    append_movement(db, item["_id"], MovementCreate(
        kind="adjustment_out", quantity=6.5, reason="Consumo posterior"), principal, "consume-before-reversal")
    with pytest.raises(HTTPException) as insufficient:
        reverse_manual_movement(db, original["_id"], MovementReversal(reason="Lançamento incorreto"),
                                principal, "manual-in-reversal")
    assert insufficient.value.status_code == 409
    assert db.ingredients.docs[item["_id"]]["current_quantity"] == 0.5


def test_adjustment_rejects_a_stale_balance_snapshot(setup):
    db, principal, item = setup
    from app.service import append_movement
    with pytest.raises(HTTPException) as error:
        append_movement(
            db, item["_id"],
            MovementCreate(kind="adjustment_out", quantity=1, expected_balance=4, reason="Contagem"),
            principal, "stale-count",
        )
    assert error.value.status_code == 409
    assert db.ingredients.docs[item["_id"]]["current_quantity"] == 5
    assert len(db.movements.docs) == 1


def test_count_line_rejects_stale_version_before_writing_audit_or_value():
    from app.service import set_count_line
    db = FakeDb()
    count = {"_id": "count-1", "restaurant_id": "restaurant-a", "code": "CT-0001",
             "status": "open", "version": 2,
             "lines": [{"ingredient_id": "ingredient-1", "counted_quantity": 5,
                        "counted_quantity_milli": 5000}]}
    db.counts = SimpleNamespace(find_one=lambda query, **_kwargs: count
                                if query == {"_id": "count-1", "restaurant_id": "restaurant-a"} else None)

    with pytest.raises(HTTPException) as error:
        set_count_line(db, "count-1", "ingredient-1",
                       CountLineUpdate(counted_quantity=4.5, expected_version=1),
                       Principal("user-a", "restaurant-a", ("manager",)))

    assert error.value.status_code == 409
    assert count["lines"][0]["counted_quantity"] == 5
    assert db.audit_events.values == []


def test_count_approval_rejects_stale_review_version():
    from app.service import approve_count
    db = FakeDb()
    count = {"_id": "count-1", "restaurant_id": "restaurant-a", "status": "open", "version": 3}
    db.counts = SimpleNamespace(find_one=lambda query, **_kwargs: count
                                if query == {"_id": "count-1", "restaurant_id": "restaurant-a"} else None)

    with pytest.raises(HTTPException) as error:
        approve_count(db, "count-1", Principal("user-a", "restaurant-a", ("manager",)),
                      "approval-key", expected_version=2)

    assert error.value.status_code == 409


def test_count_approval_rejects_new_stock_revision_even_if_balance_matches():
    from app.service import approve_count

    count = {"_id": "count-1", "restaurant_id": "restaurant-a", "status": "open",
        "version": 2, "lines": [{"ingredient_id": "ingredient-1", "expected_quantity": 5,
            "expected_quantity_milli": 5000, "expected_stock_version": 3,
            "counted_quantity": 4, "counted_quantity_milli": 4000, "unit": "kg"}]}

    class Ingredients:
        def find(self, query, session=None):
            assert query["restaurant_id"] == "restaurant-a"
            return [{"_id": "ingredient-1", "restaurant_id": "restaurant-a",
                "current_quantity": 5, "current_quantity_milli": 5000,
                "stock_version": 5, "cost_cents": 1000}]

        def update_one(self, *_args, **_kwargs):
            raise AssertionError("a stale stock snapshot cannot be fenced or approved")

    db = SimpleNamespace(client=FakeClient(), ingredients=Ingredients(), counts=SimpleNamespace(
        find_one=lambda query, session=None: count
        if query == {"_id": "count-1", "restaurant_id": "restaurant-a"} else None))

    with pytest.raises(HTTPException) as error:
        approve_count(db, "count-1", Principal("user-a", "restaurant-a", ("manager",)),
                      "approval-key", 2)

    assert error.value.status_code == 409
    assert "moved" in error.value.detail


def test_count_approval_retry_requires_same_key_and_request_fingerprint():
    from app.service import approve_count

    request_hash = fingerprint({"count_id": "count-1", "expected_version": 2})
    count = {"_id": "count-1", "restaurant_id": "restaurant-a", "status": "approved",
             "approval_key": "approval-key", "approval_version": 2,
             "approval_request_fingerprint": request_hash}
    db = SimpleNamespace(client=FakeClient(), counts=SimpleNamespace(
        find_one=lambda query, session=None: count
        if query == {"_id": "count-1", "restaurant_id": "restaurant-a"} else None))
    principal = Principal("user-a", "restaurant-a", ("manager",))

    assert approve_count(db, "count-1", principal, "approval-key", 2) is count
    with pytest.raises(HTTPException) as conflict:
        approve_count(db, "count-1", principal, "approval-key", 3)

    assert conflict.value.status_code == 409


def test_legacy_approved_count_without_fingerprint_cannot_be_replayed():
    from app.service import approve_count

    count = {"_id": "count-1", "restaurant_id": "restaurant-a", "status": "approved",
             "approval_key": "approval-key", "approval_version": 2}
    db = SimpleNamespace(client=FakeClient(), counts=SimpleNamespace(
        find_one=lambda query, session=None: count
        if query == {"_id": "count-1", "restaurant_id": "restaurant-a"} else None))

    with pytest.raises(HTTPException) as conflict:
        approve_count(db, "count-1", Principal("user-a", "restaurant-a", ("manager",)),
                      "approval-key", 2)

    assert conflict.value.status_code == 409


def test_purchase_receipt_rejects_stale_version_before_any_write():
    from app.service import receive_purchase

    purchase = {"_id": "purchase-1", "restaurant_id": "restaurant-a",
                "status": "requested", "version": 5}

    class Purchases:
        def find_one(self, query, session=None):
            return purchase if query == {"_id": "purchase-1", "restaurant_id": "restaurant-a"} else None

    class Receipts:
        def find_one(self, _query, session=None):
            return None

        def insert_one(self, *_args, **_kwargs):
            raise AssertionError("stale receipt must not be written")

    db = SimpleNamespace(client=FakeClient(), purchases=Purchases(), purchase_receipts=Receipts())

    with pytest.raises(HTTPException) as stale:
        receive_purchase(db, "purchase-1", PurchaseReceive(expected_version=4, lines=[
            PurchaseReceiveLine(line_id="line-1", quantity_received=1, unit_cost_cents=100),
        ]), Principal("user-a", "restaurant-a", ("manager",)), "stale-receipt-key")

    assert stale.value.status_code == 409
    assert purchase["version"] == 5


def test_purchase_receipt_retry_resolves_before_current_purchase_state():
    from app.service import receive_purchase

    principal = Principal("user-a", "restaurant-a", ("manager",))
    data = PurchaseReceive(expected_version=1, lines=[PurchaseReceiveLine(
        line_id="line-1", quantity_received=2, unit_cost_cents=350,
    )])
    request_hash = fingerprint({"purchase_id": "purchase-1",
        "lines": [line.model_dump(mode="json") for line in data.lines]})
    existing_receipt = {"_id": "receipt-1", "restaurant_id": principal.restaurant_id,
        "purchase_id": "purchase-1", "idempotency_key": "receipt-retry",
        "request_fingerprint": request_hash}
    current_purchase = {"_id": "purchase-1", "restaurant_id": principal.restaurant_id,
        "status": "received", "version": 3}

    class Receipts:
        calls = 0

        def find_one(self, query, session=None):
            self.calls += 1
            assert query == {"restaurant_id": principal.restaurant_id,
                             "idempotency_key": "receipt-retry"}
            return existing_receipt

    class Purchases:
        calls = 0

        def find_one(self, query, session=None):
            self.calls += 1
            assert query == {"_id": "purchase-1", "restaurant_id": principal.restaurant_id}
            return current_purchase

    receipts = Receipts()
    purchases = Purchases()
    db = SimpleNamespace(client=FakeClient(), purchase_receipts=receipts, purchases=purchases)

    result = receive_purchase(db, "purchase-1", data, principal, "receipt-retry")

    assert result is current_purchase
    assert receipts.calls == 1
    assert purchases.calls == 1


@pytest.mark.parametrize(("cost_cents", "counted_quantity", "counted_milli", "expected_complete",
                          "expected_impact", "expected_value", "counted_value"), [
    (2000, 4.75, 4750, True, -500, 10000, 9500),
    (2, 4.75, 4750, True, -1, 10, 10),
    (500, 4.999, 4999, True, -1, 2500, 2500),
    (0, 4.75, 4750, False, None, None, None),
])
def test_count_approval_freezes_financial_impact_and_movement_cost(
        monkeypatch, cost_cents, counted_quantity, counted_milli, expected_complete, expected_impact,
        expected_value, counted_value):
    from app.service import approve_count

    count = {"_id": "count-1", "restaurant_id": "restaurant-a", "code": "CT-0001",
        "status": "open", "version": 1,
        "lines": [{"ingredient_id": "ingredient-1", "expected_quantity": 5,
                   "expected_quantity_milli": 5000, "counted_quantity": counted_quantity,
                   "counted_quantity_milli": counted_milli, "unit": "kg"}]}

    class Counts:
        def find_one(self, query, session=None):
            return count if query == {"_id": "count-1", "restaurant_id": "restaurant-a"} else None

        def find_one_and_update(self, query, update, **_kwargs):
            if query.get("version") != count["version"] or count["status"] != "open":
                return None
            count.update(update["$set"])
            return dict(count)

    class Ingredients:
        docs = {"ingredient-1": {"_id": "ingredient-1", "restaurant_id": "restaurant-a",
            "current_quantity": 5, "current_quantity_milli": 5000, "cost_cents": cost_cents}}

        def find(self, query, session=None):
            assert query["restaurant_id"] == "restaurant-a"
            return [self.docs["ingredient-1"]]

        def update_one(self, query, update, session=None):
            doc = self.docs.get(query["_id"])
            if not doc or doc["restaurant_id"] != query["restaurant_id"] \
                    or doc.get("current_quantity_milli") != query["current_quantity_milli"]:
                return SimpleNamespace(matched_count=0)
            for key, increment in update["$inc"].items():
                doc[key] = doc.get(key, 0) + increment
            return SimpleNamespace(matched_count=1)

    movement_costs = []
    monkeypatch.setattr("app.service._apply_movement", lambda _db, _ingredient, movement, *_args:
        movement_costs.append(movement.unit_cost_cents))
    db = SimpleNamespace(client=FakeClient(), counts=Counts(), ingredients=Ingredients(),
                         audit_events=FakeAuditCollection())

    result = approve_count(db, "count-1", Principal("user-a", "restaurant-a", ("manager",)),
                           "count-approval-key", 1)

    assert result["financial_impact_complete"] is expected_complete
    assert result["financial_impact_cents"] == expected_impact
    assert result["financial_divergence_cents"] == (abs(expected_impact) if expected_impact is not None else None)
    assert result["lines"][0]["financial_impact_complete"] is expected_complete
    assert result["lines"][0]["financial_impact_cents"] == expected_impact
    assert result["lines"][0]["valuation_complete"] is (cost_cents > 0)
    assert result["lines"][0]["expected_value_cents"] == expected_value
    assert result["lines"][0]["counted_value_cents"] == counted_value
    assert movement_costs == [cost_cents if cost_cents > 0 else None]
    assert db.ingredients.docs["ingredient-1"]["count_approval_revision"] == 1


def test_purchase_receipts_query_is_tenant_scoped():
    owner = Principal("buyer-a", "restaurant-a", ("admin",))
    other = Principal("buyer-b", "restaurant-b", ("admin",))

    class Purchases:
        def find_one(self, query, projection=None):
            return {"_id": query["_id"]} if query == {"_id": "purchase-a", "restaurant_id": "restaurant-a"} else None

    class Cursor(list):
        def sort(self, key, direction):
            return Cursor(sorted(self, key=lambda row: row[key], reverse=direction < 0))

    rows = [
        {"_id": "receipt-a", "restaurant_id": "restaurant-a", "purchase_id": "purchase-a",
         "received_at": "2026-01-01", "actor_id": "buyer-a", "lines": []},
        {"_id": "receipt-b", "restaurant_id": "restaurant-b", "purchase_id": "purchase-a",
         "received_at": "2026-01-02", "actor_id": "buyer-b", "lines": []},
    ]

    class Receipts:
        def find(self, query):
            return Cursor([row for row in rows if all(row.get(key) == value for key, value in query.items())])

    db = SimpleNamespace(purchases=Purchases(), purchase_receipts=Receipts())
    result = list_purchase_receipts(db, "purchase-a", owner)
    assert [receipt["id"] for receipt in result] == ["receipt-a"]
    with pytest.raises(HTTPException) as error:
        list_purchase_receipts(db, "purchase-a", other)
    assert error.value.status_code == 404


def test_ingredient_price_history_is_compact_and_tenant_scoped():
    principal = Principal("manager-a", "restaurant-a", ("manager",))
    movements = FakeMovements()
    point = {"_id": "receipt-a", "restaurant_id": "restaurant-a", "ingredient_id": "item-a",
             "supplier_id": "supplier-a", "kind": "purchase", "unit_cost_cents": 150,
             "occurred_at": now()}
    movements.aggregate = lambda pipeline: [{"points": [point], "summary": [
        {"_id": None, "first_cost_cents": 100, "last_cost_cents": 150, "count": 4}]}]
    ingredients = FakeIngredients()
    ingredients.docs["item-a"] = {"_id": "item-a", "restaurant_id": "restaurant-a"}
    db = SimpleNamespace(ingredients=ingredients, movements=movements)

    result = ingredient_price_history(db, principal, "item-a")

    assert result == {"points": [point], "summary": {
        "first_cost_cents": 100, "last_cost_cents": 150, "count": 4}}


def test_ingredient_price_history_hides_foreign_ingredient():
    principal = Principal("manager-a", "restaurant-a", ("manager",))
    ingredients = FakeIngredients()
    ingredients.docs["item-a"] = {"_id": "item-a", "restaurant_id": "restaurant-b"}
    db = SimpleNamespace(ingredients=ingredients, movements=FakeMovements())

    with pytest.raises(HTTPException) as error:
        ingredient_price_history(db, principal, "item-a")

    assert error.value.status_code == 404


def test_recipe_snapshot_marks_unknown_ingredient_cost_as_incomplete():
    principal = Principal("chef", "restaurant-a", ("admin",))
    recipe = {"product_id": "burger", "product_name": "Burger", "sale_price_cents": 2500,
        "lines": [{"ingredient_id": "beef", "quantity": 0.2, "unit": "kg"}]}
    ingredient = {"_id": "beef", "name": "Carne", "base_unit": "kg", "cost_cents": 0}
    snapshot = _recipe_snapshot(recipe, {"beef": ingredient}, principal, now(), "Ficha cadastrada")
    assert snapshot["cost_cents"] == 0
    assert snapshot["cost_complete"] is False
    assert snapshot["unknown_ingredient_ids"] == ["beef"]


def test_recipe_snapshot_treats_explicit_zero_cost_as_known():
    principal = Principal("chef", "restaurant-a", ("admin",))
    recipe = {"product_id": "sample", "product_name": "Sample", "sale_price_cents": 500,
        "lines": [{"ingredient_id": "water", "quantity": 1, "unit": "l"}]}
    ingredient = {"_id": "water", "name": "Água", "base_unit": "l",
        "cost_cents": 0, "cost_known": True}

    snapshot = _recipe_snapshot(recipe, {"water": ingredient}, principal, now(), "Teste")

    assert snapshot["cost_complete"] is True
    assert snapshot["unknown_ingredient_ids"] == []


def test_recipe_snapshot_uses_the_conversion_factor_frozen_in_the_recipe():
    principal = Principal("chef", "restaurant-a", ("admin",))
    recipe = {"product_id": "cheese-board", "product_name": "Tábua",
        "sale_price_cents": 5000,
        "lines": [{"ingredient_id": "cheese", "quantity": 1, "unit": "caixa",
                   "conversion_to_base": 12}]}
    ingredient = {"_id": "cheese", "name": "Queijo", "base_unit": "un",
        "conversions": {"caixa": 24}, "cost_cents": 100}

    snapshot = _recipe_snapshot(recipe, {"cheese": ingredient}, principal, now(), "Teste")

    assert snapshot["cost_cents"] == 1200
    assert snapshot["lines"][0]["conversion_to_base"] == "12"


def test_recipe_snapshot_calculates_cost_per_portion_from_batch_yield():
    principal = Principal("chef", "restaurant-a", ("admin",))
    recipe = {"product_id": "soup", "product_name": "Sopa",
        "sale_price_cents": 900, "yield_portions": 4,
        "lines": [{"ingredient_id": "vegetables", "quantity": 2, "unit": "kg"}]}
    ingredient = {"_id": "vegetables", "name": "Legumes", "base_unit": "kg", "cost_cents": 500}

    snapshot = _recipe_snapshot(recipe, {"vegetables": ingredient}, principal, now(), "Teste")

    assert snapshot["yield_portions"] == 4
    assert snapshot["batch_cost_cents"] == 1000
    assert snapshot["cost_cents"] == 250


def test_recipe_snapshot_total_is_the_sum_of_line_costs_in_whole_cents():
    principal = Principal("chef", "restaurant-a", ("admin",))
    recipe = {"product_id": "tasting", "product_name": "Degustação", "sale_price_cents": 100,
        "lines": [{"ingredient_id": item_id, "quantity": 0.001, "unit": "un"}
                  for item_id in ("a", "b", "c")]}
    ingredients = {item_id: {"_id": item_id, "name": item_id, "base_unit": "un", "cost_cents": 500}
                   for item_id in ("a", "b", "c")}

    snapshot = _recipe_snapshot(recipe, ingredients, principal, now(), "Teste")

    assert [line["line_cost_cents"] for line in snapshot["lines"]] == [1, 1, 1]
    assert snapshot["cost_cents"] == sum(line["line_cost_cents"] for line in snapshot["lines"]) == 3


def test_loss_without_registered_cost_is_recorded_as_unpriced():
    db = FakeDb()
    principal = Principal("user-a", "restaurant-a", ("admin",))
    ingredient = create_ingredient(db, IngredientCreate(name="Oil", category="Secos",
        base_unit="l", initial_quantity=3, cost_cents=0), principal)
    loss = register_loss(db, LossCreate(ingredient_id=ingredient["_id"], quantity=0.5,
        reason="Quebra"), principal, "unpriced-loss")
    retry = register_loss(db, LossCreate(ingredient_id=ingredient["_id"], quantity=0.5,
        reason="Quebra"), principal, "unpriced-loss")
    assert retry["_id"] == loss["_id"]
    assert loss["value_complete"] is False
    assert loss["value_cents"] is None
    assert db.ingredients.docs[ingredient["_id"]]["current_quantity"] == 2.5
    movement = db.movements.docs[-1]
    assert movement["unit_cost_cents"] is None
    loss_event = next(event for event in db.audit_events.values if event["source_type"] == "loss")
    assert sum(event.get("source_id") == loss["_id"] for event in db.audit_events.values) == 1
    assert loss_event["restaurant_id"] == principal.restaurant_id
    assert loss_event["action"] == "loss.register"


def test_stock_movement_persists_matching_audit_event(setup):
    db, principal, item = setup
    from app.service import append_movement

    movement = append_movement(db, item["_id"], MovementCreate(
        kind="adjustment_in", quantity=2, reason="Entrega manual"), principal, "audited-inbound")
    event = next(event for event in db.audit_events.values if event.get("source_id") == movement["_id"])
    assert movement["audit_event_id"] == event["_id"]
    assert event["restaurant_id"] == principal.restaurant_id
    assert event["before"] == "5.0"
    assert event["after"] == "7.0"


def test_audit_feed_does_not_truncate_after_two_thousand_events():
    principal = Principal("audit-user", "restaurant-a", ("manager",))
    timestamp = now()
    movements = [{"_id": f"movement-{index:04d}", "restaurant_id": principal.restaurant_id,
        "ingredient_id": "ingredient-a", "kind": "adjustment_in", "actor_id": principal.user_id,
        "reason": "Seed audit event", "balance_before": 0, "balance_after": 1,
        "occurred_at": timestamp} for index in range(2105)]
    db = FakeAuditDb(movements)
    first = list_audit_entries(db, principal, limit=500)
    assert len(first) == 501
    assert first[0]["id"] == "movement-2104"
    assert first[-2]["id"] == "movement-1605"
    next_timestamp, next_id = first[-2]["at"], first[-2]["id"]
    second = list_audit_entries(db, principal, limit=500, before=(next_timestamp, next_id))
    pages = [first[:500], second[:500]]
    cursor = (second[499]["at"], second[499]["id"])
    while True:
        page = list_audit_entries(db, principal, limit=500, before=cursor)
        pages.append(page[:500])
        if len(page) <= 500:
            break
        cursor = (page[499]["at"], page[499]["id"])
    flattened = [entry["id"] for page in pages for entry in page]
    assert len(flattened) == 2105
    assert len(set(flattened)) == 2105


def test_audit_cursor_handles_pymongo_naive_utc_timestamps():
    principal = Principal("audit-user", "restaurant-a", ("manager",))
    timestamp = now().replace(tzinfo=None)
    movements = [{"_id": f"movement-{index:04d}", "restaurant_id": principal.restaurant_id,
        "ingredient_id": "ingredient-a", "kind": "adjustment_in", "actor_id": principal.user_id,
        "reason": "Mongo naive UTC", "balance_before": 0, "balance_after": 1,
        "occurred_at": timestamp} for index in range(4)]
    db = FakeAuditDb(movements)
    first = list_audit_entries(db, principal, limit=2)
    assert first[0]["at"].tzinfo is not None
    second = list_audit_entries(db, principal, limit=2, before=(first[1]["at"], first[1]["id"]))
    assert second[0]["id"] == "movement-0001"


def test_audit_feed_reads_persisted_event_without_repeating_its_movement():
    principal = Principal("audit-user", "restaurant-a", ("manager",))
    timestamp = now()
    movement = {"_id": "movement-current", "restaurant_id": principal.restaurant_id,
        "ingredient_id": "ingredient-a", "kind": "adjustment_in", "actor_id": principal.user_id,
        "reason": "Entrada", "balance_before": 0, "balance_after": 1, "occurred_at": timestamp,
        "audit_event_id": "audit_movement-current"}
    db = FakeAuditDb([movement])
    db.audit_events.values.append({"_id": "audit_movement-current", "restaurant_id": principal.restaurant_id,
        "user_id": principal.user_id, "action": "stock.adjust", "entity": "item",
        "entity_label": "Farinha", "before": "0", "after": "1", "reason": "Entrada",
        "at": timestamp, "source_type": "movement", "source_id": movement["_id"]})
    entries = list_audit_entries(db, principal)
    assert len(entries) == 1
    assert entries[0]["id"] == "audit_movement-current"
