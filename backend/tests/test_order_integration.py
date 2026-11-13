import hashlib
import hmac
import os
import time
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.order_integration import (OrderSnapshotEvent, process_order_event,
                                   resolve_order_exception, verify_request_signature)
from app.auth import Principal
from app.schemas import (IngredientCreate, RecipeLine, RecipePut, MovementCreate,
                         RecipeConsumptionUpdate)
from app.service import (append_movement, create_ingredient, upsert_recipe,
                         set_recipe_consumption)
from app.config import Settings
from app.database import Database


SECRET = "test-only-orders-integration-secret-0123456789"
PATH = b"POST\n/api/v1/integrations/orders/events\n"
TEST_URI = os.getenv("MONGODB_TEST_URI")


@pytest.fixture
def isolated_store():
    if not TEST_URI:
        pytest.skip("MONGODB_TEST_URI not set (isolated non-production MongoDB required)")
    if os.getenv("MONGODB_TEST_ALLOW_DB_CREATE_DROP") != "YES":
        raise RuntimeError("Set MONGODB_TEST_ALLOW_DB_CREATE_DROP=YES only for a dedicated test MongoDB")
    if TEST_URI == os.getenv("MONGODB_URI"):
        raise RuntimeError("MONGODB_TEST_URI must not equal the application MongoDB URI")
    database_name = f"dacot_orders_integration_test_{uuid4().hex}"
    database = Database(Settings(mongodb_uri=TEST_URI, mongodb_database=database_name, environment="test"))
    database.ensure_indexes()
    try:
        yield database.db
    finally:
        try:
            database.client.drop_database(database_name)
        finally:
            database.close()


def signature(body: bytes, timestamp: str) -> str:
    return hmac.new(SECRET.encode(), PATH + timestamp.encode() + b"\n" + body,
                    hashlib.sha256).hexdigest()


def test_service_signature_is_bound_to_timestamp_path_and_body():
    timestamp = str(int(time.time()))
    body = b'{"event_id":"event-1234567890"}'
    verify_request_signature(SECRET, timestamp, signature(body, timestamp), body)
    old_secret = "test-only-previous-orders-integration-secret"
    old_signature = hmac.new(old_secret.encode(), PATH + timestamp.encode() + b"\n" + body,
                             hashlib.sha256).hexdigest()
    verify_request_signature(SECRET, timestamp, old_signature, body, old_secret)
    with pytest.raises(HTTPException) as invalid:
        verify_request_signature(SECRET, timestamp, "0" * 64, body)
    assert invalid.value.status_code == 401
    with pytest.raises(HTTPException) as expired:
        verify_request_signature(SECRET, str(int(time.time()) - 301), "0" * 64, body)
    assert expired.value.status_code == 401


def test_event_contract_rejects_free_text_and_unknown_fields():
    base = {"event_id": uuid4().hex, "event_type": "order.snapshot", "event_version": 1,
        "source": "dacot-pedidos", "restaurant_id": "restaurant-a", "order_id": "order-a",
        "order_number": 1001, "order_revision": 1, "status": "in_preparation",
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        "items": [{"product_id": "product-a", "product_name": "Produto", "quantity": 1}]}
    assert OrderSnapshotEvent.model_validate(base).order_revision == 1
    with pytest.raises(ValueError):
        OrderSnapshotEvent.model_validate({**base, "items": [{**base["items"][0], "notes": "sem cebola"}]})


def _event(restaurant_id: str, order_id: str, revision: int, quantity: int) -> OrderSnapshotEvent:
    return OrderSnapshotEvent(event_id=uuid4().hex, event_type="order.snapshot", event_version=1,
        source="dacot-pedidos", restaurant_id=restaurant_id, order_id=order_id,
        order_number=1001, order_revision=revision, status="in_preparation",
        occurred_at=datetime.now(timezone.utc),
        items=[{"product_id": "burger", "product_name": "X-Burguer", "quantity": quantity}])


def test_real_replica_set_order_consumption_is_atomic_idempotent_and_tenant_scoped(isolated_store):
    store = isolated_store
    tenant = "65a000000000000000000002"
    other_tenant = "65a000000000000000000003"
    actor = Principal("test-manager", tenant, ("manager",))
    ingredient = create_ingredient(store, IngredientCreate(name="Beef", category="Carnes",
        base_unit="kg", initial_quantity=0.5), actor)
    recipe = upsert_recipe(store, RecipePut(product_id="burger", product_name="X-Burguer",
        lines=[RecipeLine(ingredient_id=ingredient["_id"], quantity=150, unit="g")],
        sale_price_cents=2000), actor)
    store.order_integrations.insert_one({"restaurant_id": tenant, "active": True,
        "enabled_at": datetime.now(timezone.utc).replace(year=2020)})

    event = _event(tenant, "order-a", 1, 5)
    blocked = process_order_event(store, event)
    assert blocked["status"] == "blocked"
    assert "validada" in blocked["reason"].lower()
    set_recipe_consumption(store, "burger", RecipeConsumptionUpdate(
        consumption_enabled=True, expected_version=recipe["version"]), actor)
    blocked = process_order_event(store, event, retry=True)
    assert "insuficiente" in blocked["reason"].lower()
    assert store.movements.count_documents({"restaurant_id": tenant, "kind": "consumption_by_order"}) == 0
    assert store.ingredients.find_one({"_id": ingredient["_id"], "restaurant_id": tenant})[
        "current_quantity_milli"] == 500

    append_movement(store, ingredient["_id"], MovementCreate(kind="adjustment_in", quantity=1,
        reason="Reposição de teste"), actor, "integration-test-restock")
    processed = process_order_event(store, event, retry=True)
    assert processed["status"] == "processed"
    assert store.ingredients.find_one({"_id": ingredient["_id"], "restaurant_id": tenant})[
        "current_quantity_milli"] == 750
    assert store.movements.count_documents({"restaurant_id": tenant, "kind": "consumption_by_order"}) == 1
    consumed = store.movements.find_one({"restaurant_id": tenant, "kind": "consumption_by_order"})
    assert consumed["quantity_milli"] == 750

    duplicate = process_order_event(store, event)
    assert duplicate["status"] == "processed"
    assert "_id" not in duplicate
    assert store.movements.count_documents({"restaurant_id": tenant, "kind": "consumption_by_order"}) == 1

    changed = OrderSnapshotEvent(event_id=uuid4().hex, event_type="order.snapshot", event_version=1,
        source="dacot-pedidos", restaurant_id=tenant, order_id="order-a", order_number=1001,
        order_revision=2, status="in_preparation", occurred_at=datetime.now(timezone.utc),
        items=[{"product_id": "burger-two", "product_name": "Outro lanche", "quantity": 1}])
    recipe_two = upsert_recipe(store, RecipePut(product_id="burger-two", product_name="Outro lanche",
        lines=[RecipeLine(ingredient_id=ingredient["_id"], quantity=100, unit="g")],
        sale_price_cents=1500), actor)
    set_recipe_consumption(store, "burger-two", RecipeConsumptionUpdate(
        consumption_enabled=True, expected_version=recipe_two["version"]), actor)
    changed_exception = process_order_event(store, changed)
    assert changed_exception["status"] == "needs_action"
    resolved = resolve_order_exception(store, tenant, changed.event_id, actor.user_id,
        "Troca confirmada; o primeiro preparo foi consumido.")
    assert resolved["status"] == "resolved" and resolved["new_movements"] == 1
    assert store.ingredients.find_one({"_id": ingredient["_id"], "restaurant_id": tenant})[
        "current_quantity_milli"] == 650
    assert store.movements.count_documents({"restaurant_id": tenant, "kind": "consumption_by_order"}) == 2

    cancelled = changed.model_copy(update={"event_id": uuid4().hex, "order_revision": 3,
        "status": "cancelled", "occurred_at": datetime.now(timezone.utc)})
    cancel_exception = process_order_event(store, cancelled)
    assert cancel_exception["status"] == "needs_action"
    cancel_resolved = resolve_order_exception(store, tenant, cancelled.event_id, actor.user_id,
        "Preparo já realizado; manter consumo contabilizado.")
    assert cancel_resolved["status"] == "resolved" and cancel_resolved["new_movements"] == 0
    assert store.ingredients.find_one({"_id": ingredient["_id"], "restaurant_id": tenant})[
        "current_quantity_milli"] == 650
    stale = process_order_event(store, _event(tenant, "order-a", 1, 5))
    assert stale["status"] == "ignored_stale"

    unauthorized = _event(other_tenant, "foreign-order", 1, 1)
    with pytest.raises(HTTPException) as error:
        process_order_event(store, unauthorized)
    assert error.value.status_code == 403
    assert store.inventory_order_state.find_one({"restaurant_id": other_tenant,
        "order_id": "foreign-order"}) is None
