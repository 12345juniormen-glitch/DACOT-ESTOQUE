import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import jwt
import pytest
from fastapi import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient
from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError

from app import auth, main
from app.auth import Principal, create_local_session, digest
from app.audit_migration import backfill_legacy_audit
from app.config import Settings, get_settings
from app.database import Database
from app.schemas import (IngredientCreate, IngredientUpdate, MovementCreate, PurchaseCreate, PurchaseLineCreate,
                         PurchaseDraftUpdate, PurchaseReceive, PurchaseReceiveLine, CountCreate, CountLineUpdate,
                         CountApproval, CountSelection, LossCreate,
                         SupplierCreate, SupplierUpdate, RecipePut, RecipeLine, PurchaseReceiptReversal, MovementReversal)
from app.service import (append_movement, create_ingredient, create_purchase, receive_purchase, reverse_purchase_receipt,
                         create_count, set_count_line, approve_count, register_loss, update_purchase_draft,
                         create_supplier, update_supplier, update_ingredient, upsert_recipe, set_purchase_status,
                         list_purchase_receipts, reverse_manual_movement, set_recipe_active, movement_insights,
                         ingredient_price_history, purchase_insights, recipe_insights, get_recipe)
from app.service import (list_audit_entries, utc_datetime, list_loss_month_page, get_loss,
                         count_insights, get_count)
from app.service import operational_insights, replenishment_recommendations, price_rise_insights, global_search

TEST_URI = os.getenv("MONGODB_TEST_URI")
pytestmark = pytest.mark.skipif(not TEST_URI, reason="MONGODB_TEST_URI not set (isolated non-production MongoDB required)")


def _validate_test_database_configuration(test_uri: str | None, app_uri: str | None,
                                          allow_database_drop: str | None) -> None:
    if not test_uri:
        raise RuntimeError("MONGODB_TEST_URI must point to a dedicated test MongoDB")
    if allow_database_drop != "YES":
        raise RuntimeError(
            "Mongo integration tests create and drop isolated databases; "
            "set MONGODB_TEST_ALLOW_DB_CREATE_DROP=YES only for a dedicated test MongoDB user"
        )
    if test_uri == app_uri:
        raise RuntimeError("MONGODB_TEST_URI must not be the same URI configured for the application")


@pytest.fixture
def store():
    _validate_test_database_configuration(TEST_URI, os.getenv("MONGODB_URI"),
                                          os.getenv("MONGODB_TEST_ALLOW_DB_CREATE_DROP"))
    database_name = f"dacot_estoque_tests_{uuid4().hex}"
    database = Database(Settings(mongodb_uri=TEST_URI, mongodb_database=database_name, environment="test"))
    try:
        database.ensure_indexes()
    except Exception:
        database.close()
        raise
    try:
        yield database.db
    finally:
        try:
            database.client.drop_database(database_name)
        finally:
            database.close()


def test_hub_handoff_api_persistence_and_revocation_end_to_end(store, monkeypatch):
    secret = "isolated-e2e-handoff-secret-for-test-only-123456"
    restaurant_id = "65a000000000000000000002"
    now = datetime.now(timezone.utc)
    handoff = jwt.encode({
        "iss": "dacot-hub", "aud": "dacot-estoque",
        "sub": "tenant_user:65a000000000000000000001",
        "restaurant_id": restaurant_id, "restaurant_slug": "integration-test",
        "role": "admin", "module": "inventory",
        "hub_access": {"user": 1, "tenant": 2, "module": 3},
        "jti": f"test-{uuid4().hex}", "iat": int(now.timestamp()),
        "nbf": int(now.timestamp()), "exp": int((now + timedelta(seconds=60)).timestamp()),
        "handoff_version": 1,
    }, secret, algorithm="HS256")
    integration_settings = Settings(
        environment="production", mongodb_uri=TEST_URI, mongodb_database=store.name,
        handoff_jwt_secret=secret, hub_base_url="https://hub.integration.test",
        hub_module_key="test-only-inventory-module-service-key-123456",
        cors_origins=["https://estoque.dacot.com.br"],
    )
    hub_access = {"active": True}

    def confirm_status(_claims, _settings):
        if not hub_access["active"]:
            raise HTTPException(status_code=403, detail="Inventory module is inactive for this restaurant")

    def confirm_access(_claims, _settings):
        if not hub_access["active"]:
            raise HTTPException(status_code=403, detail="Inventory access is inactive or revoked in DACOT-HUB")

    monkeypatch.setattr(main, "settings", integration_settings)
    monkeypatch.setattr(main, "hub_confirms_module_active", confirm_status)
    monkeypatch.setattr(auth, "hub_confirms_access", confirm_access)
    monkeypatch.setitem(main.app.dependency_overrides, get_settings, lambda: integration_settings)
    cors_options = next(middleware.kwargs for middleware in main.app.user_middleware
                        if middleware.cls is CORSMiddleware)
    monkeypatch.setitem(cors_options, "allow_origins", integration_settings.cors_origins)
    monkeypatch.setattr(main.app, "middleware_stack", None)
    state_had_database = hasattr(main.app.state, "database")
    previous_database = getattr(main.app.state, "database", None)

    try:
        with TestClient(main.app, base_url="https://api-estoque.dacot.com.br") as client:
            tab_session_id = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
            headers = {"Origin": "https://estoque.dacot.com.br",
                       "X-DACOT-Tab-Session": tab_session_id}
            preflight = client.options("/api/v1/auth/session/exchange", headers={
                "Origin": "https://estoque.dacot.com.br",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-dacot-tab-session",
            })
            assert preflight.status_code == 200
            assert preflight.headers["access-control-allow-origin"] == "https://estoque.dacot.com.br"
            assert preflight.headers["access-control-allow-credentials"] == "true"
            rejected_preflight = client.options("/api/v1/auth/session/exchange", headers={
                "Origin": "https://attacker.example",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,x-dacot-tab-session",
            })
            assert rejected_preflight.status_code == 400
            assert "access-control-allow-origin" not in rejected_preflight.headers
            exchange = client.post("/api/v1/auth/session/exchange",
                json={"handoff": handoff}, headers=headers)
            assert exchange.status_code == 204
            assert "httponly" in exchange.headers["set-cookie"].lower()
            assert "secure" in exchange.headers["set-cookie"].lower()
            assert "samesite=lax" in exchange.headers["set-cookie"].lower()

            session = client.get("/api/v1/me", headers=headers)
            assert session.status_code == 200, session.text
            assert session.json()["restaurant_id"] == restaurant_id

            created = client.post("/api/v1/ingredients", headers={**headers, "Idempotency-Key": "e2e-stock-create"},
                json={"name": "E2E Rice", "category": "Secos", "base_unit": "kg",
                      "initial_quantity": 2, "min_quantity": 1, "cost_cents": 125})
            assert created.status_code == 201
            ingredient_id = created.json()["_id"]
            assert created.json()["current_quantity_milli"] == 2000

            persisted = store.ingredients.find_one({"_id": ingredient_id,
                "restaurant_id": restaurant_id})
            assert persisted is not None
            assert store.movements.count_documents({"restaurant_id": restaurant_id,
                "ingredient_id": ingredient_id, "kind": "adjustment_in",
                "reason": "Saldo inicial cadastrado"}) == 1

            created_supplier = client.post("/api/v1/suppliers", headers={**headers,
                "Idempotency-Key": "e2e-supplier-create"}, json={"name": "E2E Supplier"})
            assert created_supplier.status_code == 201, created_supplier.text
            supplier_id = created_supplier.json()["_id"]

            created_purchase = client.post("/api/v1/purchases", headers={**headers,
                "Idempotency-Key": "e2e-purchase-create"}, json={
                    "supplier_id": supplier_id,
                    "lines": [{"ingredient_id": ingredient_id, "quantity_ordered": 3,
                        "unit": "kg", "expected_unit_cost_cents": 200}],
                })
            assert created_purchase.status_code == 201, created_purchase.text
            purchase = created_purchase.json()
            requested_purchase = client.post(f"/api/v1/purchases/{purchase['_id']}/request", headers=headers,
                json={"expected_version": purchase["version"]})
            assert requested_purchase.status_code == 200
            receipt_payload = {"expected_version": requested_purchase.json()["version"],
                "lines": [{"line_id": purchase["lines"][0]["id"],
                    "quantity_received": 1, "unit_cost_cents": 200}]}
            received = client.post(f"/api/v1/purchases/{purchase['_id']}/receipts", headers={**headers,
                "Idempotency-Key": "e2e-receipt"}, json=receipt_payload)
            assert received.status_code == 201, received.text
            response_data = received.json()
            assert response_data["purchase"]["status"] == "partial"
            assert response_data["ingredients"][0]["current_quantity"] == 3
            assert response_data["movements"][0]["kind"] == "purchase"
            foreign_movement_id = f"foreign-movement-{uuid4().hex}"
            store.movements.insert_one({
                "_id": foreign_movement_id,
                "restaurant_id": "65a000000000000000000003",
                "ingredient_id": "foreign-ingredient",
                "supplier_id": "foreign-supplier",
                "kind": "purchase",
                "occurred_at": datetime.now(timezone.utc),
            })
            insights = client.get("/api/v1/movement-insights", headers=headers)
            assert insights.status_code == 200, insights.text
            assert "price_movements" not in insights.json()
            assert "latest_purchase_movements" not in insights.json()
            assert any(movement["ingredient_id"] == ingredient_id
                for movement in insights.json()["latest_two_supplier_price_movements"])
            for group in ("recent_movements", "latest_two_supplier_price_movements"):
                assert all(movement["restaurant_id"] == restaurant_id
                    for movement in insights.json()[group])
                assert all(movement["_id"] != foreign_movement_id
                    for movement in insights.json()[group])
            price_history = client.get(f"/api/v1/ingredients/{ingredient_id}/price-history", headers=headers)
            assert price_history.status_code == 200, price_history.text
            assert len(price_history.json()["points"]) == 1
            assert price_history.json()["summary"]["count"] == 1
            replayed_receipt = client.post(f"/api/v1/purchases/{purchase['_id']}/receipts", headers={**headers,
                "Idempotency-Key": "e2e-receipt"}, json=receipt_payload)
            assert replayed_receipt.status_code == 201
            assert replayed_receipt.json() == response_data

            receipt_doc = store.purchase_receipts.find_one({"restaurant_id": restaurant_id,
                "idempotency_key": "e2e-receipt"})
            reversed_receipt = client.post(
                f"/api/v1/purchases/{purchase['_id']}/receipts/{receipt_doc['_id']}/reversal",
                headers={**headers, "Idempotency-Key": "e2e-reversal"},
                json={"reason": "Recebimento incorreto"})
            assert reversed_receipt.status_code == 200, reversed_receipt.text
            reversal_data = reversed_receipt.json()
            assert reversal_data["purchase"]["lines"][0]["quantity_received"] == 0
            assert reversal_data["ingredients"][0]["current_quantity"] == 2
            assert {movement["kind"] for movement in reversal_data["movements"]} == {
                "purchase", "adjustment_out"}
            insights_after_reversal = client.get("/api/v1/movement-insights", headers=headers)
            assert insights_after_reversal.status_code == 200
            assert not any(movement["ingredient_id"] == ingredient_id
                for movement in insights_after_reversal.json()["latest_two_supplier_price_movements"])
            price_history_after_reversal = client.get(
                f"/api/v1/ingredients/{ingredient_id}/price-history", headers=headers)
            assert price_history_after_reversal.status_code == 200
            assert price_history_after_reversal.json() == {"points": [], "summary": None}

            reloaded = client.get("/api/v1/ingredients", headers=headers)
            assert reloaded.status_code == 200
            assert [item["_id"] for item in reloaded.json()] == [ingredient_id]

            hub_access["active"] = False
            revoked = client.get("/api/v1/me", headers=headers)
            assert revoked.status_code == 403
            assert "revoked" in revoked.json()["detail"].lower()
            assert store.ingredients.find_one({"_id": ingredient_id,
                "restaurant_id": restaurant_id}) is not None
    finally:
        if state_had_database:
            main.app.state.database = previous_database
        elif hasattr(main.app.state, "database"):
            delattr(main.app.state, "database")


def test_movement_insights_preserves_two_latest_valid_prices_per_supplier_and_tenant(store):
    owner = Principal("price-owner", "65a000000000000000000002", ("manager",))
    other_tenant_id = "65a000000000000000000003"
    now = datetime.now(timezone.utc)

    def purchase(movement_id, tenant_id, days_ago, cents):
        return {"_id": movement_id, "restaurant_id": tenant_id,
            "ingredient_id": "ingredient-a", "supplier_id": "supplier-a",
            "kind": "purchase", "occurred_at": now - timedelta(days=days_ago),
            "unit_cost_cents": cents, "idempotency_key": f"test-{movement_id}"}

    store.movements.insert_many([
        purchase("price-old", owner.restaurant_id, 300, 100),
        purchase("price-reversed-middle", owner.restaurant_id, 200, 200),
        purchase("price-recent", owner.restaurant_id, 100, 300),
        purchase("price-reversed-latest", owner.restaurant_id, 10, 400),
        {"_id": "reverse-middle", "restaurant_id": owner.restaurant_id,
            "reversal_of": "price-reversed-middle", "kind": "adjustment_out",
            "occurred_at": now - timedelta(days=199), "idempotency_key": "test-reverse-middle"},
        {"_id": "reverse-latest", "restaurant_id": owner.restaurant_id,
            "reversal_of": "price-reversed-latest", "kind": "adjustment_out",
            "occurred_at": now - timedelta(days=9), "idempotency_key": "test-reverse-latest"},
        purchase("foreign-price", other_tenant_id, 1, 900),
    ])

    result = movement_insights(store, owner)

    recent_supplier_prices = result["latest_two_supplier_price_movements"]
    assert [movement["_id"] for movement in recent_supplier_prices] == ["price-recent", "price-old"]
    assert all(movement["restaurant_id"] == owner.restaurant_id for movement in recent_supplier_prices)
    assert "price_movements" not in result
    assert "latest_purchase_movements" not in result
    assert all(movement["restaurant_id"] == owner.restaurant_id
        for movement in result["recent_movements"])


def test_purchase_insights_aggregates_month_supplier_receipts_and_tenant(store):
    owner = Principal("insight-owner", "65a000000000000000000002", ("manager",))
    other = "65a000000000000000000003"
    reference = datetime.now(timezone.utc)
    store.purchases.insert_many([
        {"_id": "insight-current", "restaurant_id": owner.restaurant_id,
         "supplier_id": "supplier-a", "status": "requested", "created_at": reference,
         "idempotency_key": "insight-current-key", "code": "PI-001",
         "lines": [{"quantity_ordered_milli": 1500, "expected_unit_cost_cents": 101}]},
        {"_id": "insight-cancelled", "restaurant_id": owner.restaurant_id,
         "supplier_id": "supplier-a", "status": "cancelled", "created_at": reference,
         "idempotency_key": "insight-cancelled-key", "code": "PI-002",
         "lines": [{"quantity_ordered_milli": 1000, "expected_unit_cost_cents": 500}]},
        {"_id": "insight-foreign", "restaurant_id": other, "supplier_id": "supplier-b",
         "status": "draft", "created_at": reference,
         "idempotency_key": "insight-foreign-key", "code": "PI-001",
         "lines": [{"quantity_ordered_milli": 1000, "expected_unit_cost_cents": 9999}]},
    ])
    store.movements.insert_many([
        {"_id": "insight-receipt", "restaurant_id": owner.restaurant_id,
         "kind": "purchase", "supplier_id": "supplier-a", "purchase_reference": "insight-current",
         "occurred_at": reference, "quantity_milli": 1500, "quantity": 1.5, "unit_cost_cents": 101,
         "idempotency_key": "insight-receipt-key"},
        {"_id": "insight-reversed", "restaurant_id": owner.restaurant_id,
         "kind": "purchase", "supplier_id": "supplier-a", "purchase_reference": "insight-cancelled",
         "occurred_at": reference - timedelta(days=1), "quantity_milli": 1000,
         "quantity": 1, "unit_cost_cents": 500, "idempotency_key": "insight-reversed-key"},
        {"_id": "insight-reversal", "restaurant_id": owner.restaurant_id,
         "kind": "adjustment_out", "reversal_of": "insight-reversed",
         "occurred_at": reference, "quantity_milli": 1000, "quantity": 1,
         "idempotency_key": "insight-reversal-key"},
        {"_id": "insight-foreign-movement", "restaurant_id": other, "kind": "purchase",
         "supplier_id": "supplier-b", "purchase_reference": "insight-foreign",
         "occurred_at": reference, "quantity_milli": 1, "quantity": .001, "unit_cost_cents": 9999,
         "idempotency_key": "insight-foreign-movement-key"},
    ])

    result = purchase_insights(store, owner)

    assert result["status_counts"] == {"requested": 1, "cancelled": 1}
    assert result["month"] == {"order_count": 1, "expected_total_cents": 152,
        "received_total_cents": 152, "received_unpriced_count": 0}
    assert result["suppliers"]["supplier-a"]["order_count"] == 2
    assert result["suppliers"]["supplier-a"]["recent_received_value_cents"] == 152
    assert result["suppliers"]["supplier-a"]["last_receipt_code"] == "PI-001"
    assert "supplier-b" not in result["suppliers"]


def test_supplier_prefix_search_is_paginated_active_aware_and_tenant_scoped(store):
    owner = Principal("supplier-search-owner", "65a000000000000000000002", ("manager",))
    other = "65a000000000000000000003"
    store.suppliers.insert_many([
        {"_id": "supplier-alpha", "restaurant_id": owner.restaurant_id,
         "name": "Distribuidora Alfa", "name_normalized": "distribuidora alfa", "active": True},
        {"_id": "supplier-beta", "restaurant_id": owner.restaurant_id,
         "name": "Distribuidora Beta", "name_normalized": "distribuidora beta", "active": False},
        {"_id": "supplier-foreign", "restaurant_id": other,
         "name": "Distribuidora Gama", "name_normalized": "distribuidora gama", "active": True},
    ])
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database=SimpleNamespace(db=store))))

    active = main.list_suppliers(request, include_inactive=False, search="Distribuidora",
        limit=1, offset=0, principal=owner)
    all_statuses = main.list_suppliers(request, include_inactive=True, search="Distribuidora",
        limit=10, offset=0, principal=owner)
    resolved = main.get_suppliers_by_ids(request,
        ids=["supplier-alpha", "supplier-beta", "supplier-foreign"], principal=owner)
    one = main.get_supplier("supplier-alpha", request, owner)

    assert [supplier["_id"] for supplier in active] == ["supplier-alpha"]
    assert [supplier["_id"] for supplier in all_statuses] == ["supplier-alpha", "supplier-beta"]
    assert {supplier["_id"] for supplier in resolved} == {"supplier-alpha", "supplier-beta"}
    assert one["restaurant_id"] == owner.restaurant_id
    with pytest.raises(HTTPException) as error:
        main.get_supplier("supplier-foreign", request, owner)
    assert error.value.status_code == 404


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


def test_stock_balance_uses_integer_milli_units_without_float_drift(store):
    principal = Principal("precision-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Precise Rice", category="Secos", base_unit="kg",
        initial_quantity=1), principal)
    for index in range(3):
        append_movement(store, item["_id"], MovementCreate(kind="adjustment_out", quantity=0.333,
            reason="Precision test"), principal, f"precision-{index}")

    current = store.ingredients.find_one({"_id": item["_id"]})
    movements = list(store.movements.find({"ingredient_id": item["_id"], "kind": "adjustment_out"}))
    assert current["current_quantity_milli"] == 1
    assert current["current_quantity"] == 0.001
    assert len(movements) == 3
    assert all(movement["quantity_milli"] == 333 for movement in movements)


def test_stock_version_advances_with_each_ledger_balance_change(store):
    principal = Principal("stock-version-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Versioned rice", category="Secos",
        base_unit="kg", initial_quantity=2), principal)
    assert item["stock_version"] == 1

    movement = append_movement(store, item["_id"], MovementCreate(kind="adjustment_in",
        quantity=1, reason="Versioned manual entry"), principal, "stock-version-entry")
    assert movement["stock_version_after"] == 2

    reversal = reverse_manual_movement(store, movement["_id"],
        MovementReversal(reason="Reverse version check"), principal, "stock-version-reversal")
    assert reversal["stock_version_after"] == 3
    current = store.ingredients.find_one({"_id": item["_id"], "restaurant_id": principal.restaurant_id})
    assert current["stock_version"] == 3
    assert current["current_quantity"] == 2


def test_legacy_balance_is_normalized_to_milli_units_on_first_movement(store):
    principal = Principal("legacy-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Legacy Stock", category="Secos", base_unit="kg",
        initial_quantity=0), principal)
    store.ingredients.update_one({"_id": item["_id"]}, {
        "$set": {"current_quantity": 2.345}, "$unset": {"current_quantity_milli": ""},
    })
    movement = append_movement(store, item["_id"], MovementCreate(kind="adjustment_out", quantity=0.345,
        reason="Legacy normalization"), principal, "legacy-stock-adjustment")

    current = store.ingredients.find_one({"_id": item["_id"]})
    assert current["current_quantity_milli"] == 2000
    assert current["current_quantity"] == 2.0
    assert movement["balance_before_milli"] == 2345


def test_manual_movement_reversal_is_atomic_tenant_scoped_and_retry_safe(store):
    owner = Principal("manual-reversal-owner", "65a000000000000000000002", ("manager",))
    other = Principal("manual-reversal-other", "65a000000000000000000003", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Reversal Flour", category="Secos", base_unit="kg",
        initial_quantity=4), owner)
    original = append_movement(store, item["_id"], MovementCreate(kind="adjustment_out", quantity=1.25,
        reason="Incorrect manual removal"), owner, "manual-reversal-original")
    data = MovementReversal(reason="Operator entered the wrong quantity")
    result = reverse_manual_movement(store, original["_id"], data, owner, "manual-reversal-retry-key")
    retry = reverse_manual_movement(store, original["_id"], data, owner, "manual-reversal-retry-key")

    assert retry["_id"] == result["_id"]
    assert store.movements.count_documents({"restaurant_id": owner.restaurant_id,
        "reversal_of": original["_id"]}) == 1
    assert store.ingredients.find_one({"_id": item["_id"], "restaurant_id": owner.restaurant_id})[
        "current_quantity_milli"] == 4000
    assert store.movements.find_one({"_id": original["_id"], "restaurant_id": owner.restaurant_id})[
        "reversed_by_movement_id"] == result["_id"]
    with pytest.raises(HTTPException) as cross_tenant:
        reverse_manual_movement(store, original["_id"], data, other, "other-tenant-reversal")
    assert cross_tenant.value.status_code == 404


def test_persisted_audit_feed_is_scoped_to_authenticated_restaurant(store):
    owner = Principal("audit-owner", "65a000000000000000000002", ("manager",))
    other = Principal("other-owner", "65a000000000000000000003", ("manager",))
    ingredient = create_ingredient(store, IngredientCreate(name="Audit Flour", category="Secos", base_unit="kg",
        initial_quantity=2), owner)
    create_ingredient(store, IngredientCreate(name="Audit Flour", category="Secos", base_unit="kg",
        initial_quantity=3), other)
    first_update = update_ingredient(store, ingredient["_id"], IngredientUpdate(
        expected_version=ingredient["version"], min_quantity=1), owner)
    update_ingredient(store, ingredient["_id"], IngredientUpdate(
        expected_version=first_update["version"], min_quantity=1), owner)

    assert store.audit_events.count_documents({"restaurant_id": owner.restaurant_id,
        "source_type": "ingredient", "source_id": ingredient["_id"]}) == 2

    owner_entries = list_audit_entries(store, owner)
    other_entries = list_audit_entries(store, other)
    stock_event = next(entry for entry in owner_entries if entry["entity_label"] == "Audit Flour"
                       and entry["action"] == "stock.adjust")
    assert stock_event["user_id"] == owner.user_id
    assert stock_event["before"] == "0.0"
    assert stock_event["after"] == "2.0"
    assert all(entry["restaurant_id"] == owner.restaurant_id for entry in owner_entries)
    assert all(entry["restaurant_id"] == other.restaurant_id for entry in other_entries)


def test_legacy_audit_backfill_is_resumable_and_enables_indexed_feed(store):
    principal = Principal("legacy-audit-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(
        name="Legacy Audit Flour", category="Secos", base_unit="kg"), principal)
    timestamp = datetime.now(timezone.utc)
    legacy = {
        "_id": "mov_legacy_backfill_test", "restaurant_id": principal.restaurant_id,
        "ingredient_id": item["_id"], "kind": "adjustment_in", "quantity": 1,
        "unit": "kg", "actor_id": principal.user_id, "reason": "Imported historical record",
        "balance_before": 0, "balance_after": 1, "occurred_at": timestamp,
    }
    store.movements.insert_one(legacy)

    first = backfill_legacy_audit(store, principal.restaurant_id, batch_size=1, apply=True)
    retry = backfill_legacy_audit(store, principal.restaurant_id, batch_size=1, apply=True)
    assert first["inserted"] >= 1
    assert retry["inserted"] == 0
    assert store.movements.find_one({"_id": legacy["_id"]})["audit_event_id"] == legacy["_id"]
    assert store.audit_events.count_documents({"restaurant_id": principal.restaurant_id,
        "_id": legacy["_id"]}) == 1
    assert store.audit_migrations.find_one({"_id": principal.restaurant_id})["status"] == "complete"
    events = list_audit_entries(store, principal, limit=500)
    assert sum(entry["id"] == legacy["_id"] for entry in events) == 1


def test_failed_movement_insert_rolls_back_balance(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Flour", category="Secos", base_unit="kg",
                                                      initial_quantity=4), principal)
    append_movement(store, item["_id"], MovementCreate(kind="adjustment_in", quantity=1, reason="once"),
                    principal, "unique-receipt-key")
    with pytest.raises(HTTPException) as error:
        append_movement(store, item["_id"], MovementCreate(kind="adjustment_in", quantity=2, reason="duplicate"),
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
    assert purchase["version"] == 1
    requested = set_purchase_status(store, purchase["_id"], "requested", principal, purchase["version"])
    line_id = purchase["lines"][0]["id"]
    receipt = PurchaseReceive(expected_version=requested["version"], lines=[PurchaseReceiveLine(line_id=line_id, quantity_received=2,
                             unit_cost_cents=1200)])
    result = receive_purchase(store, purchase["_id"], receipt, principal, "receipt-key")
    assert result["status"] == "partial"
    assert result["version"] == requested["version"] + 1
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == 2
    receipt_doc = store.purchase_receipts.find_one({"restaurant_id": principal.restaurant_id,
        "idempotency_key": "receipt-key"})
    assert store.audit_events.count_documents({"restaurant_id": principal.restaurant_id,
        "source_type": "purchase_receipt", "source_id": receipt_doc["_id"]}) == 1
    retry = receive_purchase(store, purchase["_id"], receipt, principal, "receipt-key")
    assert retry["_id"] == result["_id"]
    assert retry["version"] == result["version"]
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == 2
    assert store.purchase_receipts.count_documents({"restaurant_id": principal.restaurant_id,
        "purchase_id": purchase["_id"]}) == 1


def test_purchase_receipt_and_reversal_return_canonical_affected_records(store):
    principal = Principal("receipt-response-owner", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Rice", category="Secos", base_unit="kg",
        initial_quantity=1, cost_cents=100), principal)
    upsert_recipe(store, RecipePut(product_id="rice-bowl", product_name="Rice bowl",
        sale_price_cents=1500, lines=[RecipeLine(ingredient_id=item["_id"], quantity=1, unit="kg")]),
        principal)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=item["_id"], quantity_ordered=2, unit="kg", expected_unit_cost_cents=400,
    )]), principal, "receipt-response-purchase")
    requested = set_purchase_status(store, purchase["_id"], "requested", principal, purchase["version"])
    received = receive_purchase(store, purchase["_id"], PurchaseReceive(
        expected_version=requested["version"], lines=[PurchaseReceiveLine(
            line_id=purchase["lines"][0]["id"], quantity_received=2, unit_cost_cents=400,
        )]), principal, "receipt-response-key")
    receipt = store.purchase_receipts.find_one({"restaurant_id": principal.restaurant_id,
        "idempotency_key": "receipt-response-key"})
    canonical = main.purchase_stock_mutation_response(store, received, receipt["_id"], principal.restaurant_id)

    assert canonical["purchase"]["_id"] == purchase["_id"]
    assert canonical["ingredients"][0]["current_quantity"] == 3
    assert canonical["ingredients"][0]["cost_cents"] == 300
    assert len(canonical["movements"]) == 1
    assert canonical["recipes"][0]["version"] == 2
    assert canonical["recipe_snapshots"][0]["trigger"] == "Custo de insumo atualizado por recebimento"

    reversed_purchase = reverse_purchase_receipt(store, purchase["_id"], receipt["_id"],
        PurchaseReceiptReversal(reason="Quantidade lançada incorretamente"), principal,
        "receipt-response-reversal")
    reversed_result = main.purchase_stock_mutation_response(
        store, reversed_purchase, receipt["_id"], principal.restaurant_id, reversed_receipt=True)
    assert reversed_result["ingredients"][0]["current_quantity"] == 1
    assert {movement["kind"] for movement in reversed_result["movements"]} == {"purchase", "adjustment_out"}
    assert any(movement.get("reversal_of") for movement in reversed_result["movements"])
    assert reversed_result["recipes"][0]["version"] == 3
    assert reversed_result["recipe_snapshots"][0]["trigger"] == \
        "Custo de insumo atualizado por estorno de recebimento"
    with pytest.raises(HTTPException) as isolated:
        main.purchase_stock_mutation_response(store, received, receipt["_id"], "65a000000000000000000003")
    assert isolated.value.status_code == 409


def test_purchase_receipt_rejects_a_stale_version_without_stock_changes(store):
    principal = Principal("stale-receiver", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Stale receipt", category="Secos",
        base_unit="kg"), principal)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=item["_id"], quantity_ordered=4, unit="kg", expected_unit_cost_cents=700,
    )]), principal, "stale-receipt-purchase")
    requested = set_purchase_status(store, purchase["_id"], "requested", principal, purchase["version"])
    line_id = purchase["lines"][0]["id"]

    with pytest.raises(HTTPException) as stale:
        receive_purchase(store, purchase["_id"], PurchaseReceive(expected_version=purchase["version"], lines=[
            PurchaseReceiveLine(line_id=line_id, quantity_received=2, unit_cost_cents=700),
        ]), principal, "stale-receipt-key")

    assert stale.value.status_code == 409
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == 0
    assert store.purchase_receipts.count_documents({"restaurant_id": principal.restaurant_id,
        "purchase_id": purchase["_id"]}) == 0
    assert requested["version"] == purchase["version"] + 1


def test_receiving_priced_goods_does_not_fabricate_cost_for_existing_unknown_stock(store):
    principal = Principal("unknown-cost-owner", f"tenant-{uuid4().hex}", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Unknown carryover", category="Secos",
        base_unit="kg", initial_quantity=5), principal)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=item["_id"], quantity_ordered=5, unit="kg", expected_unit_cost_cents=1000,
    )]), principal, f"unknown-cost-purchase-{uuid4().hex}")
    requested = set_purchase_status(store, purchase["_id"], "requested", principal, purchase["version"])

    receive_purchase(store, purchase["_id"], PurchaseReceive(expected_version=requested["version"], lines=[
        PurchaseReceiveLine(line_id=purchase["lines"][0]["id"], quantity_received=5,
            unit_cost_cents=1000),
    ]), principal, f"unknown-cost-receipt-{uuid4().hex}")

    persisted = store.ingredients.find_one({"_id": item["_id"], "restaurant_id": principal.restaurant_id})
    assert persisted["current_quantity"] == 10
    assert persisted["cost_cents"] == 0
    assert persisted["cost_known"] is False

    receipt = store.purchase_receipts.find_one({"restaurant_id": principal.restaurant_id,
        "purchase_id": purchase["_id"]})
    reverse_purchase_receipt(store, purchase["_id"], receipt["_id"],
        PurchaseReceiptReversal(reason="Estorno de teste"), principal,
        f"unknown-cost-reversal-{uuid4().hex}")
    persisted = store.ingredients.find_one({"_id": item["_id"], "restaurant_id": principal.restaurant_id})
    assert persisted["current_quantity"] == 5
    assert persisted["cost_cents"] == 0
    assert persisted["cost_known"] is False
    assert store.movements.count_documents({"restaurant_id": principal.restaurant_id,
        "ingredient_id": item["_id"], "kind": "adjustment_out", "reversal_of": {"$exists": True}}) == 1


def test_concurrent_receipts_from_same_purchase_version_only_apply_one_payload(store):
    principal = Principal("concurrent-receiver", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Concurrent receipt", category="Secos",
        base_unit="kg"), principal)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=item["_id"], quantity_ordered=10, unit="kg", expected_unit_cost_cents=700,
    )]), principal, "concurrent-receipt-purchase")
    requested = set_purchase_status(store, purchase["_id"], "requested", principal, purchase["version"])
    line_id = purchase["lines"][0]["id"]

    def receive(key):
        try:
            return receive_purchase(store, purchase["_id"], PurchaseReceive(
                expected_version=requested["version"], lines=[PurchaseReceiveLine(
                    line_id=line_id, quantity_received=5, unit_cost_cents=700,
                )]), principal, key)
        except HTTPException as error:
            return error

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(receive, ("concurrent-receipt-a", "concurrent-receipt-b")))

    assert sum(isinstance(outcome, HTTPException) and outcome.status_code == 409 for outcome in outcomes) == 1
    saved = store.purchases.find_one({"_id": purchase["_id"], "restaurant_id": principal.restaurant_id})
    assert saved["version"] == requested["version"] + 1
    assert saved["lines"][0]["quantity_received"] == 5
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == 5
    assert store.purchase_receipts.count_documents({"restaurant_id": principal.restaurant_id,
        "purchase_id": purchase["_id"]}) == 1


def test_purchase_freezes_pack_conversion_for_receipt(store):
    principal = Principal("pack-buyer", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Napkins", category="Embalagens", base_unit="un",
        conversions={"caixa": 12}), principal)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=item["_id"], quantity_ordered=2, unit="caixa", expected_unit_cost_cents=1200,
    )]), principal, "pack-conversion-purchase")
    assert purchase["lines"][0]["conversion_to_base"] == 12
    store.ingredients.update_one({"_id": item["_id"]}, {"$set": {"conversions.caixa": 24}})
    requested = set_purchase_status(store, purchase["_id"], "requested", principal, purchase["version"])
    receive_purchase(store, purchase["_id"], PurchaseReceive(expected_version=requested["version"], lines=[PurchaseReceiveLine(
        line_id=purchase["lines"][0]["id"], quantity_received=2, unit_cost_cents=1200,
    )]), principal, "pack-conversion-receipt")
    updated = store.ingredients.find_one({"_id": item["_id"]})
    assert updated["current_quantity_milli"] == 24_000
    assert updated["cost_cents"] == 100


def test_frozen_purchase_and_recipe_units_touch_ingredient_within_transaction(store):
    principal = Principal("catalog-buyer", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Package item", category="Secos",
        base_unit="un", cost_cents=100, conversions={"caixa": 12}), principal)

    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=item["_id"], quantity_ordered=1, unit="caixa", expected_unit_cost_cents=1200,
    )]), principal, "transaction-fenced-purchase")
    assert purchase["lines"][0]["conversion_to_base"] == 12
    assert store.ingredients.find_one({"_id": item["_id"]})["snapshot_revision"] == 1

    recipe_data = RecipePut(product_id="package-product", product_name="Package product",
        lines=[RecipeLine(ingredient_id=item["_id"], quantity=1, unit="caixa")])
    saved = upsert_recipe(store, recipe_data, principal)
    assert saved["lines"][0]["conversion_to_base"] == 12
    assert store.ingredients.find_one({"_id": item["_id"]})["snapshot_revision"] == 2

    # A retry that makes no recipe change does not take another write fence.
    upsert_recipe(store, recipe_data.model_copy(update={"expected_version": saved["version"]}), principal)
    assert store.ingredients.find_one({"_id": item["_id"]})["snapshot_revision"] == 2


def test_receipt_reversal_is_compensating_audited_and_tenant_scoped(store):
    owner = Principal("buyer", "65a000000000000000000002", ("manager",))
    other = Principal("other", "65a000000000000000000003", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Milk", category="Laticínios",
        base_unit="l", initial_quantity=5, cost_cents=100), owner)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=item["_id"], quantity_ordered=2, unit="l", expected_unit_cost_cents=300,
    )]), owner, "reversal-purchase")
    requested = set_purchase_status(store, purchase["_id"], "requested", owner, purchase["version"])
    receive_purchase(store, purchase["_id"], PurchaseReceive(expected_version=requested["version"], lines=[PurchaseReceiveLine(
        line_id=purchase["lines"][0]["id"], quantity_received=2, unit_cost_cents=300,
    )]), owner, "reversal-receipt-key")
    received_ingredient = store.ingredients.find_one({"_id": item["_id"]})
    assert received_ingredient["version"] == item["version"] + 1
    receipt = store.purchase_receipts.find_one({"restaurant_id": owner.restaurant_id,
        "idempotency_key": "reversal-receipt-key"})
    assert [entry["id"] for entry in list_purchase_receipts(store, purchase["_id"], owner)] == [receipt["_id"]]
    with pytest.raises(HTTPException) as receipt_isolation:
        list_purchase_receipts(store, purchase["_id"], other)
    assert receipt_isolation.value.status_code == 404

    with pytest.raises(HTTPException) as cross_tenant:
        reverse_purchase_receipt(store, purchase["_id"], receipt["_id"],
            PurchaseReceiptReversal(reason="Erro de lançamento"), other, "reversal-cross-tenant")
    assert cross_tenant.value.status_code == 404

    result = reverse_purchase_receipt(store, purchase["_id"], receipt["_id"],
        PurchaseReceiptReversal(reason="Quantidade lançada incorretamente"), owner, "reversal-owner-key")
    reversed_ingredient = store.ingredients.find_one({"_id": item["_id"]})
    assert result["status"] == "requested"
    assert result["lines"][0]["quantity_received"] == 0
    assert reversed_ingredient["current_quantity"] == 5
    assert reversed_ingredient["version"] == received_ingredient["version"] + 1
    original = store.movements.find_one({"restaurant_id": owner.restaurant_id,
        "idempotency_key": f"{receipt['_id']}:{purchase['lines'][0]['id']}"})
    reversal = store.movements.find_one({"restaurant_id": owner.restaurant_id,
        "reversal_of": original["_id"]})
    assert reversal["kind"] == "adjustment_out"
    assert "Quantidade lançada incorretamente" in reversal["reason"]
    assert store.purchase_receipts.find_one({"_id": receipt["_id"]})["reversed_by"] == owner.user_id
    repeated = reverse_purchase_receipt(store, purchase["_id"], receipt["_id"],
        PurchaseReceiptReversal(reason="Quantidade lançada incorretamente"), owner, "reversal-owner-key")
    assert repeated["_id"] == result["_id"]
    assert store.movements.count_documents({"restaurant_id": owner.restaurant_id,
        "reversal_of": original["_id"]}) == 1
    with pytest.raises(HTTPException) as mismatched_retry:
        reverse_purchase_receipt(store, purchase["_id"], receipt["_id"],
            PurchaseReceiptReversal(reason="Estorno repetido"), owner, "different-reversal-key")
    assert mismatched_retry.value.status_code == 409
    assert store.audit_events.count_documents({"_id": f"audit_receipt_reversal:{receipt['_id']}"}) == 1


def test_receipt_reversal_rejects_consumed_stock_without_partial_changes(store):
    owner = Principal("buyer", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Beans reversal", category="Secos",
        base_unit="kg", initial_quantity=0), owner)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=item["_id"], quantity_ordered=2, unit="kg", expected_unit_cost_cents=100,
    )]), owner, "reversal-insufficient-purchase")
    requested = set_purchase_status(store, purchase["_id"], "requested", owner, purchase["version"])
    receipt_data = PurchaseReceive(expected_version=requested["version"], lines=[PurchaseReceiveLine(
        line_id=purchase["lines"][0]["id"], quantity_received=2, unit_cost_cents=100,
    )])
    receive_purchase(store, purchase["_id"], receipt_data, owner, "reversal-insufficient-receipt")
    receipt = store.purchase_receipts.find_one({"restaurant_id": owner.restaurant_id,
        "idempotency_key": "reversal-insufficient-receipt"})
    register_loss(store, LossCreate(ingredient_id=item["_id"], quantity=1,
        reason="Outros", note="Uso após recebimento"), owner, "reversal-consume-stock")
    before = store.ingredients.find_one({"_id": item["_id"]})["current_quantity"]
    with pytest.raises(HTTPException) as error:
        reverse_purchase_receipt(store, purchase["_id"], receipt["_id"],
            PurchaseReceiptReversal(reason="Recebimento incorreto"), owner, "reversal-insufficient-key")
    assert error.value.status_code == 409
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == before
    assert store.purchase_receipts.find_one({"_id": receipt["_id"]}).get("reversed_at") is None
    retry = receive_purchase(store, purchase["_id"], receipt_data, owner, "reversal-insufficient-receipt")
    assert retry["status"] == "received"
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == 1
    assert store.purchase_receipts.count_documents({"restaurant_id": owner.restaurant_id,
        "purchase_id": purchase["_id"]}) == 1


def test_concurrent_receipt_reversals_return_one_success_and_one_conflict(store):
    principal = Principal("concurrent-reversal-manager", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Concurrent reverse stock", category="Secos",
        base_unit="kg", initial_quantity=5, cost_cents=100), principal)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=item["_id"], quantity_ordered=2, unit="kg", expected_unit_cost_cents=100,
    )]), principal, "concurrent-reversal-purchase")
    requested = set_purchase_status(store, purchase["_id"], "requested", principal, purchase["version"])
    received = receive_purchase(store, purchase["_id"], PurchaseReceive(
        expected_version=requested["version"], lines=[PurchaseReceiveLine(
            line_id=purchase["lines"][0]["id"], quantity_received=2, unit_cost_cents=100,
        )]), principal, "concurrent-reversal-receipt")
    receipt = store.purchase_receipts.find_one({"restaurant_id": principal.restaurant_id,
        "purchase_id": purchase["_id"]})
    data = PurchaseReceiptReversal(reason="Duplicate concurrent reversal")

    def reverse(key):
        try:
            return reverse_purchase_receipt(store, received["_id"], receipt["_id"], data,
                principal, key)
        except HTTPException as error:
            return error

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(reverse, ("concurrent-reversal-a", "concurrent-reversal-b")))

    assert sum(not isinstance(outcome, HTTPException) for outcome in outcomes) == 1
    conflicts = [outcome for outcome in outcomes if isinstance(outcome, HTTPException)]
    assert len(conflicts) == 1 and conflicts[0].status_code == 409
    saved_receipt = store.purchase_receipts.find_one({"_id": receipt["_id"],
        "restaurant_id": principal.restaurant_id})
    assert saved_receipt["reversed_at"] is not None
    original_movement = store.movements.find_one({"restaurant_id": principal.restaurant_id,
        "idempotency_key": f"{receipt['_id']}:{purchase['lines'][0]['id']}"})
    assert store.movements.count_documents({"restaurant_id": principal.restaurant_id,
        "reversal_of": original_movement["_id"]}) == 1
    assert store.movements.count_documents({"restaurant_id": principal.restaurant_id,
        "kind": "adjustment_out", "purchase_reference": purchase["_id"]}) == 1
    assert store.ingredients.find_one({"_id": item["_id"],
        "restaurant_id": principal.restaurant_id})["current_quantity_milli"] == 5000
    assert store.purchases.find_one({"_id": purchase["_id"],
        "restaurant_id": principal.restaurant_id})["lines"][0]["quantity_received_milli"] == 0


def test_reversing_partial_receipt_does_not_reopen_cancelled_purchase(store):
    owner = Principal("cancelled-partial-buyer", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Cancelled partial", category="Secos",
        base_unit="kg"), owner)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=item["_id"], quantity_ordered=4, unit="kg", expected_unit_cost_cents=700,
    )]), owner, "cancelled-partial-purchase")
    requested = set_purchase_status(store, purchase["_id"], "requested", owner, purchase["version"])
    received = receive_purchase(store, purchase["_id"], PurchaseReceive(
        expected_version=requested["version"], lines=[PurchaseReceiveLine(
            line_id=purchase["lines"][0]["id"], quantity_received=2, unit_cost_cents=700,
        )]), owner, "cancelled-partial-receipt")
    cancelled = set_purchase_status(store, purchase["_id"], "cancelled", owner, received["version"])
    receipt = store.purchase_receipts.find_one({"restaurant_id": owner.restaurant_id,
        "idempotency_key": "cancelled-partial-receipt"})

    result = reverse_purchase_receipt(store, purchase["_id"], receipt["_id"],
        PurchaseReceiptReversal(reason="Recebimento indevido"), owner, "cancelled-partial-reversal")

    assert received["status"] == "partial"
    assert cancelled["status"] == "cancelled"
    assert result["status"] == "cancelled"
    assert result["lines"][0]["quantity_received"] == 0
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == 0


def test_purchase_creation_is_idempotent_and_tenant_scoped(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Beans", category="Secos", base_unit="kg"), principal)
    data = PurchaseCreate(lines=[PurchaseLineCreate(ingredient_id=item["_id"], quantity_ordered=4,
                         unit="kg", expected_unit_cost_cents=800)])
    first = create_purchase(store, data, principal, "purchase-retry-key")
    update_ingredient(store, item["_id"], IngredientUpdate(active=False, expected_version=1), principal)
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


def test_draft_purchase_edit_is_tenant_scoped_versioned_and_audited(store):
    owner = Principal("buyer-a", "65a000000000000000000002", ("manager",))
    other = Principal("buyer-b", "65a000000000000000000003", ("manager",))
    ingredient = create_ingredient(store, IngredientCreate(name="Rice", category="Secos",
        base_unit="kg", initial_quantity=4), owner)
    purchase = create_purchase(store, PurchaseCreate(note="initial", lines=[PurchaseLineCreate(
        ingredient_id=ingredient["_id"], quantity_ordered=2, unit="kg", expected_unit_cost_cents=700,
    )]), owner, "editable-purchase")
    assert purchase["version"] == 1
    original_line_id = purchase["lines"][0]["id"]
    edit = PurchaseDraftUpdate(expected_version=purchase["version"], note="updated note",
        lines=[PurchaseLineCreate(ingredient_id=ingredient["_id"], quantity_ordered=3,
                                  unit="kg", expected_unit_cost_cents=750)])

    with pytest.raises(HTTPException) as cross_tenant:
        update_purchase_draft(store, purchase["_id"], edit, other)
    assert cross_tenant.value.status_code == 404

    updated = update_purchase_draft(store, purchase["_id"], edit, owner)
    assert updated["status"] == "draft"
    assert updated["version"] == 2
    assert updated["note"] == "updated note"
    assert updated["lines"][0]["id"] == original_line_id
    assert updated["lines"][0]["quantity_ordered_milli"] == 3000
    assert store.ingredients.find_one({"_id": ingredient["_id"]})["current_quantity"] == 4
    changes = list(store.purchase_changes.find({"restaurant_id": owner.restaurant_id,
                                                 "purchase_id": purchase["_id"]}))
    assert len(changes) == 1
    assert changes[0]["actor_id"] == owner.user_id
    audit = list_audit_entries(store, owner)
    assert any(entry["action"] == "purchase.update" and entry["user_id"] == owner.user_id for entry in audit)

    with pytest.raises(HTTPException) as stale:
        update_purchase_draft(store, purchase["_id"], edit, owner)
    assert stale.value.status_code == 409
    requested = set_purchase_status(store, purchase["_id"], "requested", owner, updated["version"])
    assert requested["version"] == 3
    requested_retry = set_purchase_status(store, purchase["_id"], "requested", owner, purchase["version"])
    assert requested_retry["version"] == requested["version"]
    assert store.audit_events.count_documents({"_id": f"audit_purchase_requested:{purchase['_id']}",
        "restaurant_id": owner.restaurant_id}) == 1
    after_request = edit.model_copy(update={"expected_version": requested["version"]})
    with pytest.raises(HTTPException) as locked:
        update_purchase_draft(store, purchase["_id"], after_request, owner)
    assert locked.value.status_code == 409


def test_concurrent_draft_edits_with_same_version_allow_only_one_writer(store):
    owner = Principal("buyer-concurrent", "65a000000000000000000002", ("manager",))
    ingredient = create_ingredient(store, IngredientCreate(name="Concurrent rice", category="Secos",
        base_unit="kg"), owner)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=ingredient["_id"], quantity_ordered=2, unit="kg", expected_unit_cost_cents=700,
    )]), owner, "concurrent-draft-purchase")
    edits = [PurchaseDraftUpdate(expected_version=purchase["version"], note=f"edit-{index}",
        lines=[PurchaseLineCreate(ingredient_id=ingredient["_id"], quantity_ordered=2 + index,
                                  unit="kg", expected_unit_cost_cents=700)]) for index in (1, 2)]

    def attempt(edit):
        try:
            return update_purchase_draft(store, purchase["_id"], edit, owner)
        except HTTPException as error:
            return error

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, edits))

    assert sum(isinstance(result, HTTPException) and result.status_code == 409 for result in results) == 1
    saved = store.purchases.find_one({"_id": purchase["_id"], "restaurant_id": owner.restaurant_id})
    assert saved["version"] == 2
    assert saved["note"] in {"edit-1", "edit-2"}
    assert store.purchase_changes.count_documents({"restaurant_id": owner.restaurant_id,
        "purchase_id": purchase["_id"]}) == 1


def test_purchase_status_retry_is_idempotent_and_does_not_duplicate_audit(store):
    owner = Principal("buyer-retry", "65a000000000000000000002", ("manager",))
    ingredient = create_ingredient(store, IngredientCreate(name="Status retry", category="Secos",
        base_unit="kg"), owner)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=ingredient["_id"], quantity_ordered=1, unit="kg", expected_unit_cost_cents=500,
    )]), owner, "status-retry-purchase")

    first = set_purchase_status(store, purchase["_id"], "requested", owner, purchase["version"])
    retry = set_purchase_status(store, purchase["_id"], "requested", owner, purchase["version"])

    assert first["status"] == retry["status"] == "requested"
    assert first["version"] == retry["version"] == 2
    assert store.audit_events.count_documents({"_id": f"audit_purchase_requested:{purchase['_id']}",
        "restaurant_id": owner.restaurant_id}) == 1


def test_purchase_status_transition_rejects_stale_version_after_draft_edit(store):
    owner = Principal("buyer-stale-status", f"tenant-{uuid4().hex}", ("manager",))
    ingredient = create_ingredient(store, IngredientCreate(name="Stale status item", category="Secos",
        base_unit="kg"), owner)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=ingredient["_id"], quantity_ordered=1, unit="kg", expected_unit_cost_cents=500,
    )]), owner, f"stale-status-purchase-{uuid4().hex}")
    edited = update_purchase_draft(store, purchase["_id"], PurchaseDraftUpdate(
        expected_version=purchase["version"], note="Updated before request",
        lines=[PurchaseLineCreate(ingredient_id=ingredient["_id"], quantity_ordered=2,
            unit="kg", expected_unit_cost_cents=500)]), owner)

    with pytest.raises(HTTPException) as stale:
        set_purchase_status(store, purchase["_id"], "requested", owner, purchase["version"])

    assert stale.value.status_code == 409
    current = store.purchases.find_one({"_id": purchase["_id"], "restaurant_id": owner.restaurant_id})
    assert current["status"] == "draft"
    requested = set_purchase_status(store, purchase["_id"], "requested", owner, edited["version"])
    assert requested["status"] == "requested"


def test_legacy_draft_purchase_uses_default_version_when_version_field_is_missing(store):
    owner = Principal("legacy-buyer", "65a000000000000000000002", ("manager",))
    ingredient = create_ingredient(store, IngredientCreate(name="Legacy rice", category="Secos",
        base_unit="kg"), owner)
    purchase = create_purchase(store, PurchaseCreate(note="legacy", lines=[PurchaseLineCreate(
        ingredient_id=ingredient["_id"], quantity_ordered=1, unit="kg", expected_unit_cost_cents=500,
    )]), owner, "legacy-edit-purchase")
    store.purchases.update_one({"_id": purchase["_id"], "restaurant_id": owner.restaurant_id},
        {"$unset": {"updated_at": "", "version": ""}})
    edit = PurchaseDraftUpdate(expected_version=1, note="edited legacy draft",
        lines=[PurchaseLineCreate(ingredient_id=ingredient["_id"], quantity_ordered=2,
                                  unit="kg", expected_unit_cost_cents=550)])

    updated = update_purchase_draft(store, purchase["_id"], edit, owner)

    assert updated["note"] == "edited legacy draft"
    assert updated["version"] == 2
    assert utc_datetime(updated["updated_at"]) > utc_datetime(purchase["created_at"])
    assert updated["lines"][0]["quantity_ordered_milli"] == 2000


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
    receipt = PurchaseReceive(expected_version=purchase["version"], lines=[PurchaseReceiveLine(
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
    assert store.audit_events.count_documents({"restaurant_id": principal.restaurant_id,
                                               "action": "purchase.receive"}) == 0


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


def test_loss_updates_stock_and_is_idempotent(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Cheese", category="Laticínios",
        base_unit="kg", initial_quantity=5, cost_cents=1000), principal)
    payload = LossCreate(ingredient_id=item["_id"], quantity=0.5, reason="Vencimento", note="Lote vencido")

    first = register_loss(store, payload, principal, "loss-once")
    retry = register_loss(store, payload, principal, "loss-once")

    assert retry["_id"] == first["_id"]
    assert first["value_cents"] == 500
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == 4.5
    movement = store.movements.find_one({"_id": first["movement_id"]})
    assert movement["kind"] == "loss"
    assert movement["actor_id"] == principal.user_id
    assert movement["balance_before"] == 5
    assert movement["balance_after"] == 4.5
    assert store.movements.count_documents({"ingredient_id": item["_id"]}) == 2
    loss_events = list(store.audit_events.find({"restaurant_id": principal.restaurant_id,
                                                "source_type": "loss", "source_id": first["_id"]}))
    assert len(loss_events) == 1


def test_loss_and_count_approval_api_return_canonical_movements(store, monkeypatch):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Event stock", category="Secos",
        base_unit="kg", initial_quantity=5, cost_cents=1000), principal)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        database=SimpleNamespace(db=store))))
    monkeypatch.setattr(main, "require_allowed_origin", lambda _request: None)

    loss = main.post_loss(LossCreate(ingredient_id=item["_id"], quantity=0.5,
        reason="Quebra", note="Embalagem danificada"), request, "loss-api-key", principal)
    assert loss["quantity"] == 0.5
    assert loss["movement"]["kind"] == "loss"
    assert loss["movement"]["balance_after"] == 4.5

    count = create_count(store, CountCreate(ingredient_ids=[item["_id"]]), principal,
                         f"count-create-{uuid4().hex}")
    count = set_count_line(store, count["_id"], item["_id"], CountLineUpdate(
        counted_quantity=4.25, expected_version=count["version"]), principal)
    approved = main.post_count_approval(count["_id"], CountApproval(
        expected_version=count["version"]), request, f"count-approve-{uuid4().hex}", principal)

    assert approved["status"] == "approved"
    assert len(approved["movements"]) == 1
    assert approved["movements"][0]["kind"] == "count_out"
    assert approved["movements"][0]["balance_after"] == 4.25


def test_loss_idempotency_key_cannot_be_reused_for_different_payload(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Oil", category="Secos",
        base_unit="l", initial_quantity=3), principal)
    register_loss(store, LossCreate(ingredient_id=item["_id"], quantity=0.5,
        reason="Erro operacional"), principal, "loss-key")

    with pytest.raises(HTTPException) as error:
        register_loss(store, LossCreate(ingredient_id=item["_id"], quantity=0.25,
            reason="Erro operacional"), principal, "loss-key")

    assert error.value.status_code == 409
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == 2.5


def test_count_approval_adjusts_stock_once_and_records_audit_movements(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Beef", category="Carnes",
        base_unit="kg", initial_quantity=5, cost_cents=2000), principal)
    count = create_count(store, CountCreate(ingredient_ids=[item["_id"]]), principal, "count-start")
    count = set_count_line(store, count["_id"], item["_id"], CountLineUpdate(
        counted_quantity=4.75, expected_version=count["version"]), principal)
    count = set_count_line(store, count["_id"], item["_id"], CountLineUpdate(
        counted_quantity=4.75, expected_version=count["version"]), principal)
    assert store.audit_events.count_documents({"restaurant_id": principal.restaurant_id,
        "source_type": "count_line", "source_id": count["_id"]}) == 1

    first = approve_count(store, count["_id"], principal, "count-approve", count["version"])
    retry = approve_count(store, count["_id"], principal, "count-approve", count["version"])

    assert first["status"] == "approved" and retry["status"] == "approved"
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == 4.75
    movements = list(store.movements.find({"ingredient_id": item["_id"]}))
    count_movements = [movement for movement in movements if movement["kind"] == "count_out"]
    assert len(count_movements) == 1
    assert count_movements[0]["purchase_reference"] == count["_id"]
    assert count_movements[0]["reason"] == f"Contagem física {count['code']}"
    assert count_movements[0]["unit_cost_cents"] == 2000
    assert first["financial_impact_complete"] is True
    assert first["financial_impact_cents"] == -500
    assert first["lines"][0]["financial_impact_complete"] is True
    assert first["lines"][0]["financial_impact_cents"] == -500
    assert first["lines"][0]["valuation_complete"] is True
    assert first["lines"][0]["expected_value_cents"] == 10000
    assert first["lines"][0]["counted_value_cents"] == 9500
    update_ingredient(store, item["_id"], IngredientUpdate(
        expected_version=item["version"], cost_cents=4000), principal)
    preserved_count = store.counts.find_one({"_id": count["_id"]})
    assert preserved_count["financial_impact_cents"] == -500
    assert preserved_count["lines"][0]["expected_value_cents"] == 10000
    assert preserved_count["lines"][0]["counted_value_cents"] == 9500
    assert store.audit_events.count_documents({"restaurant_id": principal.restaurant_id,
        "source_type": "count_approval", "source_id": count["_id"]}) == 1
    with pytest.raises(HTTPException) as reused_key:
        approve_count(store, count["_id"], principal, "count-approve", count["version"] + 1)
    assert reused_key.value.status_code == 409


def test_count_financial_divergence_does_not_net_opposing_item_variances(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    surplus = create_ingredient(store, IngredientCreate(name="Count surplus", category="Secos",
        base_unit="kg", initial_quantity=5, cost_cents=1000), principal)
    shortage = create_ingredient(store, IngredientCreate(name="Count shortage", category="Secos",
        base_unit="kg", initial_quantity=5, cost_cents=1000), principal)
    count = create_count(store, CountCreate(ingredient_ids=[surplus["_id"], shortage["_id"]]),
                         principal, "count-offset-create")
    count = set_count_line(store, count["_id"], surplus["_id"], CountLineUpdate(
        counted_quantity=6, expected_version=count["version"]), principal)
    count = set_count_line(store, count["_id"], shortage["_id"], CountLineUpdate(
        counted_quantity=4, expected_version=count["version"]), principal)

    approved = approve_count(store, count["_id"], principal, "count-offset-approve", count["version"])
    insights = operational_insights(store, principal)
    history = count_insights(store, principal)

    assert approved["financial_impact_cents"] == 0
    assert approved["financial_divergence_cents"] == 2000
    assert insights["counts"]["divergence_cents"] == 2000
    assert insights["counts"]["last_divergence"]["impact_cents"] == 0
    assert insights["counts"]["last_divergence"]["divergence_cents"] == 2000
    assert history["divergence_cents"] == 2000


def test_physical_count_can_reconcile_inactive_ingredient_without_reactivating_it(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Discontinued ingredient", category="Secos",
        base_unit="kg", initial_quantity=5, cost_cents=1200), principal)
    inactive = update_ingredient(store, item["_id"], IngredientUpdate(active=False,
        expected_version=item["version"]), principal)
    assert inactive["active"] is False

    count = create_count(store, CountCreate(ingredient_ids=[item["_id"]]), principal,
        f"inactive-count-start-{uuid4().hex}")
    count = set_count_line(store, count["_id"], item["_id"], CountLineUpdate(
        counted_quantity=4.5, expected_version=count["version"]), principal)
    approved = approve_count(store, count["_id"], principal,
        f"inactive-count-approve-{uuid4().hex}", count["version"])

    persisted = store.ingredients.find_one({"_id": item["_id"],
        "restaurant_id": principal.restaurant_id})
    assert approved["status"] == "approved"
    assert persisted["active"] is False
    assert persisted["current_quantity"] == 4.5
    assert store.movements.count_documents({"restaurant_id": principal.restaurant_id,
        "ingredient_id": item["_id"], "kind": "count_out"}) == 1


def test_count_selection_is_resolved_by_tenant_category_search_and_exclusions(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    included = create_ingredient(store, IngredientCreate(name="Rice bag", category="Secos",
        base_unit="kg", initial_quantity=2, min_quantity=4), principal)
    excluded = create_ingredient(store, IngredientCreate(name="Rice flour", category="Secos",
        base_unit="kg", initial_quantity=1, min_quantity=4), principal)
    other_category = create_ingredient(store, IngredientCreate(name="Rice garnish", category="Carnes",
        base_unit="kg", initial_quantity=1, min_quantity=4), principal)
    other_tenant = Principal("other-user", "65a000000000000000000003", ("manager",))
    foreign = create_ingredient(store, IngredientCreate(name="Rice foreign", category="Secos",
        base_unit="kg", initial_quantity=1, min_quantity=4), other_tenant)

    count = create_count(store, CountCreate(selection=CountSelection(scope="category",
        category="Secos", search="rice", exclude_ids=[excluded["_id"]])), principal,
        f"count-selection-{uuid4().hex}")

    assert [line["ingredient_id"] for line in count["lines"]] == [included["_id"]]
    assert other_category["_id"] not in [line["ingredient_id"] for line in count["lines"]]
    assert foreign["_id"] not in [line["ingredient_id"] for line in count["lines"]]


def test_inventory_insights_match_stock_status_and_money_rules_per_tenant(store):
    from app.service import inventory_insights

    suffix = uuid4().hex
    principal = Principal("test-user", f"tenant-{suffix}", ("manager",))
    other = Principal("other-user", f"other-{suffix}", ("manager",))
    samples = [
        ("empty", 0, 2, 200),
        ("critical", 0.5, 2, 300),
        ("attention", 1, 2, 100),
        ("near", 2.4, 2, 250),
        ("normal", 5, 2, 120),
        ("unpriced", 1, 0, 0),
    ]
    created = {}
    for label, quantity, minimum, cost in samples:
        created[label] = create_ingredient(store, IngredientCreate(name=f"{label}-{suffix}", category="Secos",
            base_unit="kg", initial_quantity=quantity, min_quantity=minimum, cost_cents=cost), principal)
    store.ingredients.update_one({"_id": created["unpriced"]["_id"],
        "restaurant_id": principal.restaurant_id}, {"$set": {"active": False}})
    create_ingredient(store, IngredientCreate(name=f"foreign-{suffix}", category="Secos",
        base_unit="kg", initial_quantity=100, min_quantity=1, cost_cents=500), other)

    summary = inventory_insights(store, principal)

    assert summary == {"total": 6, "active_total": 5, "known_stock_value_cents": 1450,
        "without_cost": 1, "empty": 1, "active_empty": 1, "critical": 1,
        "active_critical": 1, "attention": 1, "active_attention": 1,
        "near_minimum": 1, "active_near_minimum": 1, "normal": 2,
        "active_normal": 1}


def test_operational_insights_are_monthly_tenant_scoped_and_preserve_unknown_valuation(store):
    suffix = uuid4().hex
    tenant = f"tenant-{suffix}"
    principal = Principal("test-user", tenant, ("manager",))
    other = Principal("other-user", f"other-{suffix}", ("manager",))
    timestamp = datetime.now(timezone(timedelta(hours=-3))).astimezone(timezone.utc)
    timestamp = timestamp.replace(microsecond=(timestamp.microsecond // 1000) * 1000)
    month_start_local = timestamp.astimezone(timezone(timedelta(hours=-3))).replace(
        day=1, hour=0, minute=0, second=0, microsecond=0,
    )
    month_start = month_start_local.astimezone(timezone.utc)
    prior_month = month_start - timedelta(days=1)
    week_old = timestamp - timedelta(days=8)
    include_week_old_loss = week_old >= month_start
    count_item = create_ingredient(store, IngredientCreate(name=f"Count detail {suffix}", category="Secos",
        base_unit="kg", initial_quantity=2, min_quantity=0, cost_cents=100), principal)

    loss_documents = [
        {"_id": f"loss-priced-{suffix}", "restaurant_id": tenant,
         "occurred_at": timestamp, "idempotency_key": f"loss-priced-{suffix}",
         "value_cents": 125, "value_complete": True, "reason": "Vencimento",
         "ingredient_id": count_item["_id"]},
        {"_id": f"loss-unpriced-{suffix}", "restaurant_id": tenant,
         "occurred_at": timestamp, "idempotency_key": f"loss-unpriced-{suffix}",
         "value_cents": None, "value_complete": False, "reason": "Quebra"},
        {"_id": f"loss-old-{suffix}", "restaurant_id": tenant,
         "occurred_at": prior_month, "idempotency_key": f"loss-old-{suffix}",
         "value_cents": 999, "value_complete": True},
        {"_id": f"loss-foreign-{suffix}", "restaurant_id": other.restaurant_id,
         "occurred_at": timestamp, "idempotency_key": f"loss-foreign-{suffix}",
         "value_cents": 999, "value_complete": True},
    ]
    if include_week_old_loss:
        loss_documents.append({"_id": f"loss-week-old-{suffix}", "restaurant_id": tenant,
            "occurred_at": week_old, "idempotency_key": f"loss-week-old-{suffix}",
            "value_cents": 200, "value_complete": True, "reason": "Sobra",
            "ingredient_id": count_item["_id"]})
    store.losses.insert_many(loss_documents)
    store.counts.insert_many([
        {"_id": f"count-loss-{suffix}", "restaurant_id": tenant,
         "create_key": f"count-loss-{suffix}",
         "status": "approved", "approved_at": timestamp,
         "financial_impact_complete": True, "financial_impact_cents": -230},
        {"_id": f"count-gain-{suffix}", "restaurant_id": tenant,
         "create_key": f"count-gain-{suffix}",
         "status": "approved", "approved_at": timestamp,
         "financial_impact_complete": True, "financial_impact_cents": 80},
        {"_id": f"count-unknown-{suffix}", "restaurant_id": tenant,
         "create_key": f"count-unknown-{suffix}",
         "code": f"CNT-{suffix[:6]}", "status": "approved", "approved_at": timestamp + timedelta(seconds=1),
         "financial_impact_complete": False, "financial_impact_cents": None,
         "lines": [{"ingredient_id": count_item["_id"], "expected_quantity": 1,
                    "expected_quantity_milli": 1000, "counted_quantity": 1.5,
                    "counted_quantity_milli": 1500, "unit": "kg"}]},
        {"_id": f"count-old-{suffix}", "restaurant_id": tenant,
         "create_key": f"count-old-{suffix}",
         "status": "approved", "approved_at": prior_month,
         "financial_impact_complete": True, "financial_impact_cents": 999},
        {"_id": f"count-foreign-{suffix}", "restaurant_id": other.restaurant_id,
         "create_key": f"count-foreign-{suffix}",
         "status": "approved", "approved_at": timestamp,
         "financial_impact_complete": True, "financial_impact_cents": 999},
    ])

    result = operational_insights(store, principal)

    assert result == {
        "losses": {"count": 2 + int(include_week_old_loss),
            "priced_count": 1 + int(include_week_old_loss), "unpriced_count": 1,
            "value_cents": 125 + (200 if include_week_old_loss else 0),
            "week_value_cents": 125,
            "reason_totals": ([{"reason": "Sobra", "value_cents": 200},
                {"reason": "Vencimento", "value_cents": 125}] if include_week_old_loss
                else [{"reason": "Vencimento", "value_cents": 125}]),
            "top_item": {"ingredient_id": count_item["_id"],
                "ingredient_name": f"Count detail {suffix}",
                "value_cents": 125 + (200 if include_week_old_loss else 0)},
            "top_month_reason": ({"reason": "Sobra", "value_cents": 200}
                if include_week_old_loss else {"reason": "Vencimento", "value_cents": 125})},
        "counts": {"approved_count": 3, "unknown_financial_count": 1, "divergence_cents": 310,
            "last_divergence": {"id": f"count-unknown-{suffix}", "code": f"CNT-{suffix[:6]}",
                "approved_at": timestamp + timedelta(seconds=1), "ingredient_name": f"Count detail {suffix}",
                "unit": "kg", "difference_milli": 500, "impact_cents": None,
                "divergence_cents": None,
                "impact_complete": False}},
    }
    page = list_loss_month_page(store, principal, limit=1, offset=0, reason="Vencimento")
    assert page["total"] == 1 and page["has_more"] is False
    assert page["items"][0]["_id"] == f"loss-priced-{suffix}"
    unpriced_page = list_loss_month_page(store, principal, limit=1, offset=0, reason="Quebra")
    assert unpriced_page["total"] == 1
    assert unpriced_page["items"][0]["value_complete"] is False
    with pytest.raises(HTTPException) as error:
        get_loss(store, principal, f"loss-foreign-{suffix}")
    assert error.value.status_code == 404


def test_count_insights_and_detail_lookup_are_tenant_scoped(store):
    suffix = uuid4().hex
    tenant = f"tenant-{suffix}"
    principal = Principal("manager", tenant, ("manager",))
    other = Principal("other", f"other-{suffix}", ("manager",))
    now_at = datetime.now(timezone.utc)
    store.counts.insert_many([
        {"_id": f"count-approved-{suffix}", "restaurant_id": tenant,
         "create_key": f"count-approved-{suffix}", "status": "approved",
         "created_at": now_at, "financial_impact_complete": True, "financial_impact_cents": -123,
         "lines": []},
        {"_id": f"count-unknown-{suffix}", "restaurant_id": tenant,
         "create_key": f"count-unknown-{suffix}", "status": "approved",
         "created_at": now_at - timedelta(seconds=1), "financial_impact_complete": False,
         "financial_impact_cents": None, "lines": []},
        {"_id": f"count-open-{suffix}", "restaurant_id": tenant,
         "create_key": f"count-open-{suffix}", "status": "open", "created_at": now_at,
         "lines": []},
        {"_id": f"count-foreign-{suffix}", "restaurant_id": other.restaurant_id,
         "create_key": f"count-foreign-{suffix}", "status": "approved", "created_at": now_at,
         "financial_impact_complete": True, "financial_impact_cents": -999, "lines": []},
    ])

    summary = count_insights(store, principal)

    assert summary["status_counts"] == {"approved": 2, "open": 1}
    assert summary["unknown_financial_count"] == 1
    assert summary["divergence_cents"] == 123
    assert summary["latest_open"]["_id"] == f"count-open-{suffix}"
    assert get_count(store, principal, f"count-approved-{suffix}")["restaurant_id"] == tenant
    with pytest.raises(HTTPException) as error:
        get_count(store, principal, f"count-foreign-{suffix}")
    assert error.value.status_code == 404


def test_recipe_insights_use_latest_cost_snapshot_and_isolate_tenants(store):
    suffix = uuid4().hex
    tenant = f"tenant-{suffix}"
    principal = Principal("manager", tenant, ("manager",))
    other = f"other-{suffix}"
    now_at = datetime.now(timezone.utc)
    recipes = [
        {"_id": f"recipe-active-{suffix}", "restaurant_id": tenant,
         "product_id": f"active-{suffix}", "product_name": "Active", "active": True},
        {"_id": f"recipe-inactive-{suffix}", "restaurant_id": tenant,
         "product_id": f"inactive-{suffix}", "product_name": "Inactive", "active": False},
        {"_id": f"recipe-legacy-{suffix}", "restaurant_id": tenant,
         "product_id": f"legacy-{suffix}", "product_name": "Legacy"},
        {"_id": f"recipe-foreign-{suffix}", "restaurant_id": other,
         "product_id": f"foreign-{suffix}", "product_name": "Foreign"},
    ]
    store.recipes.insert_many(recipes)
    store.recipe_snapshots.insert_many([
        {"_id": f"snapshot-old-{suffix}", "restaurant_id": tenant,
         "product_id": f"active-{suffix}", "occurred_at": now_at - timedelta(days=1),
         "cost_cents": 100, "sale_price_cents": 1000, "cost_complete": True},
        {"_id": f"snapshot-latest-{suffix}", "restaurant_id": tenant,
         "product_id": f"active-{suffix}", "occurred_at": now_at,
         "cost_cents": 400, "sale_price_cents": 1000, "cost_complete": True},
        {"_id": f"snapshot-inactive-{suffix}", "restaurant_id": tenant,
         "product_id": f"inactive-{suffix}", "occurred_at": now_at,
         "cost_cents": 200, "sale_price_cents": 1000, "cost_complete": True},
        {"_id": f"snapshot-foreign-{suffix}", "restaurant_id": other,
         "product_id": f"foreign-{suffix}", "occurred_at": now_at,
         "cost_cents": 900, "sale_price_cents": 1000, "cost_complete": True},
    ])

    summary = recipe_insights(store, principal)

    assert {key: value for key, value in summary.items() if key != "average_cost_ratio"} == {
        "total": 3, "active_count": 2, "calculable_count": 2,
        "attention_count": 1, "incomplete_count": 1}
    assert summary["average_cost_ratio"] == pytest.approx(0.3)
    assert get_recipe(store, principal, f"active-{suffix}")["restaurant_id"] == tenant
    with pytest.raises(HTTPException) as error:
        get_recipe(store, principal, f"foreign-{suffix}")
    assert error.value.status_code == 404


def test_global_search_is_bounded_and_tenant_scoped_across_operational_records(store):
    suffix = uuid4().hex
    tenant = f"tenant-{suffix}"
    other = f"other-{suffix}"
    principal = Principal("manager", tenant, ("manager",))
    now_at = datetime.now(timezone.utc)
    item_id = f"ingredient-{suffix}"
    supplier_id = f"supplier-{suffix}"
    store.ingredients.insert_many([
        {"_id": item_id, "restaurant_id": tenant, "name": "Tomate da Casa", "name_normalized": "tomate da casa",
         "category": "Hortifruti", "base_unit": "kg", "current_quantity": 2, "min_quantity": 1},
        {"_id": f"foreign-item-{suffix}", "restaurant_id": other, "name": "Tomate Estrangeiro",
         "name_normalized": "tomate estrangeiro", "category": "Hortifruti", "base_unit": "kg"},
    ])
    store.suppliers.insert_one({"_id": supplier_id, "restaurant_id": tenant, "name": "Fornecedor Local",
        "name_normalized": "fornecedor local", "contact": "", "phone": "", "whatsapp": "", "notes": ""})
    store.recipes.insert_one({"_id": f"recipe-{suffix}", "restaurant_id": tenant,
        "product_id": f"product-{suffix}", "product_name": "Molho da Casa",
        "lines": [{"ingredient_id": item_id}]})
    store.purchases.insert_one({"_id": f"purchase-{suffix}", "restaurant_id": tenant,
        "code": f"CMP-{suffix[:6]}", "supplier_id": supplier_id, "status": "received",
        "created_at": now_at, "note": "", "lines": [{"ingredient_id": item_id}]})
    store.counts.insert_one({"_id": f"count-{suffix}", "restaurant_id": tenant,
        "code": f"CNT-{suffix[:6]}", "status": "approved", "created_at": now_at,
        "lines": [{"ingredient_id": item_id}]})
    store.losses.insert_one({"_id": f"loss-{suffix}", "restaurant_id": tenant,
        "ingredient_id": item_id, "reason": "Quebra", "note": "", "occurred_at": now_at})
    store.movements.insert_one({"_id": f"movement-{suffix}", "restaurant_id": tenant,
        "ingredient_id": item_id, "kind": "purchase", "reason": "Compra tomate",
        "purchase_reference": f"CMP-{suffix[:6]}", "occurred_at": now_at})
    store.purchases.insert_one({"_id": f"foreign-purchase-{suffix}", "restaurant_id": other,
        "code": f"Tomate-Foreign-{suffix}", "status": "received", "created_at": now_at, "lines": []})

    results = global_search(store, principal, "tomate")

    groups = {result["group"] for result in results}
    assert {"Estoque", "Compras", "Fichas técnicas", "Contagens", "Perdas & movimentos"} <= groups
    assert len(results) <= 6 * 20
    assert all(f"foreign-{suffix}" not in str(result) for result in results)
    cross_field = global_search(store, principal, "tomate fornecedor")
    assert any(result["id"] == f"purchase:purchase-{suffix}" for result in cross_field)
    assert any(result["id"] == f"supplier:{supplier_id}" for result in global_search(store, principal, "fornecedor"))
    assert global_search(store, principal, "ó") == []


def test_replenishment_recommendations_use_authoritative_tenant_stock_and_unit_rounding(store):
    suffix = uuid4().hex
    principal = Principal("test-user", f"tenant-{suffix}", ("manager",))
    other = Principal("other-user", f"other-{suffix}", ("manager",))
    ingredients = [
        create_ingredient(store, IngredientCreate(name=f"Kg {suffix}", category="Secos",
            base_unit="kg", initial_quantity=0.7, min_quantity=1.3, cost_cents=200), principal),
        create_ingredient(store, IngredientCreate(name=f"Grams {suffix}", category="Secos",
            base_unit="g", initial_quantity=40, min_quantity=100, cost_cents=2), principal),
        create_ingredient(store, IngredientCreate(name=f"Units {suffix}", category="Secos",
            base_unit="un", initial_quantity=2, min_quantity=4.1, cost_cents=75), principal),
        create_ingredient(store, IngredientCreate(name=f"No cost {suffix}", category="Secos",
            base_unit="kg", initial_quantity=0, min_quantity=1, cost_cents=0), principal),
        create_ingredient(store, IngredientCreate(name=f"Inactive {suffix}", category="Secos",
            base_unit="kg", initial_quantity=0, min_quantity=3, cost_cents=100), principal),
    ]
    inactive = ingredients[-1]
    store.ingredients.update_one({"_id": inactive["_id"], "restaurant_id": principal.restaurant_id},
                                 {"$set": {"active": False}})
    supplier_id = f"supplier-{suffix}"
    store.suppliers.insert_one({"_id": supplier_id, "restaurant_id": principal.restaurant_id,
                                "avg_lead_time_days": 4})
    store.ingredients.update_one({"_id": ingredients[0]["_id"],
        "restaurant_id": principal.restaurant_id}, {"$set": {"primary_supplier_id": supplier_id}})
    create_ingredient(store, IngredientCreate(name=f"Foreign {suffix}", category="Secos",
        base_unit="kg", initial_quantity=0, min_quantity=9, cost_cents=900), other)

    result = replenishment_recommendations(store, principal, limit=5)

    by_name = {item["ingredient"]["name"].split()[0]: item for item in result["items"]}
    assert result["total"] == 4
    assert set(by_name) == {"Kg", "Grams", "Units", "No"}
    assert by_name["Kg"]["recommended_quantity"] == 1
    assert by_name["Kg"]["estimated_cost_cents"] == 200
    assert by_name["Kg"]["lead_time_days"] == 4
    assert by_name["Grams"]["recommended_quantity"] == 100
    assert by_name["Grams"]["estimated_cost_cents"] == 200
    assert by_name["Units"]["recommended_quantity"] == 3
    assert by_name["Units"]["estimated_cost_cents"] == 225
    assert by_name["No"]["estimated_cost_cents"] is None
    assert by_name["No"]["stock_status"] == "empty"
    assert [row["ingredient"]["name"].split()[0] for row in result["items"][:3]] == [
        "No", "Grams", "Units",
    ]


def test_price_rise_insights_use_valid_supplier_prices_and_exclude_reversals_and_other_tenants(store):
    suffix = uuid4().hex
    principal = Principal("test-user", f"tenant-{suffix}", ("manager",))
    other = Principal("other-user", f"other-{suffix}", ("manager",))
    active_items = [
        create_ingredient(store, IngredientCreate(name=f"Top {suffix}", category="Secos",
            base_unit="kg", initial_quantity=1, cost_cents=100), principal),
        create_ingredient(store, IngredientCreate(name=f"Second {suffix}", category="Secos",
            base_unit="kg", initial_quantity=1, cost_cents=100), principal),
        create_ingredient(store, IngredientCreate(name=f"Threshold {suffix}", category="Secos",
            base_unit="kg", initial_quantity=1, cost_cents=100), principal),
        create_ingredient(store, IngredientCreate(name=f"Inactive {suffix}", category="Secos",
            base_unit="kg", initial_quantity=1, cost_cents=100), principal),
    ]
    store.ingredients.update_one({"_id": active_items[3]["_id"],
        "restaurant_id": principal.restaurant_id}, {"$set": {"active": False}})
    foreign_item = create_ingredient(store, IngredientCreate(name=f"Foreign {suffix}", category="Secos",
        base_unit="kg", initial_quantity=1, cost_cents=100), other)
    supplier_id = f"supplier-{suffix}"
    store.suppliers.insert_one({"_id": supplier_id, "restaurant_id": principal.restaurant_id})
    timestamp = datetime.now(timezone.utc)

    def add_purchase(movement_id, item_id, cost, days_ago, tenant=principal.restaurant_id,
                     supplier=supplier_id):
        store.movements.insert_one({"_id": movement_id, "restaurant_id": tenant,
            "ingredient_id": item_id, "kind": "purchase", "supplier_id": supplier,
            "unit_cost_cents": cost, "occurred_at": timestamp - timedelta(days=days_ago),
            "idempotency_key": movement_id})

    def add_pair(item, label, first, last):
        add_purchase(f"{label}-first-{suffix}", item["_id"], first, 2)
        add_purchase(f"{label}-last-{suffix}", item["_id"], last, 1)

    add_pair(active_items[0], "top", 100, 120)
    add_pair(active_items[1], "second", 100, 110)
    add_pair(active_items[2], "threshold", 100, 105)
    add_pair(active_items[3], "inactive", 100, 300)
    add_purchase(f"foreign-first-{suffix}", foreign_item["_id"], 100, 2,
                 tenant=other.restaurant_id)
    add_purchase(f"foreign-last-{suffix}", foreign_item["_id"], 500, 1,
                 tenant=other.restaurant_id)
    add_purchase(f"top-reversed-{suffix}", active_items[0]["_id"], 300, 0.5)
    store.movements.insert_one({"_id": f"reverse-top-{suffix}", "restaurant_id": principal.restaurant_id,
        "ingredient_id": active_items[0]["_id"], "kind": "adjustment_out",
        "reversal_of": f"top-reversed-{suffix}", "occurred_at": timestamp,
        "idempotency_key": f"reverse-top-{suffix}"})

    result = price_rise_insights(store, principal)

    assert result["count"] == 3
    assert result["top"]["ingredient"]["_id"] == active_items[0]["_id"]
    assert result["top"]["first_unit_cost_cents"] == 100
    assert result["top"]["last_unit_cost_cents"] == 120
    assert result["top"]["points"] == 2


def test_inventory_filtered_page_returns_exact_summary_and_tenant_scoped_rows(store):
    principal = Principal("test-user", f"tenant-{uuid4().hex}", ("manager",))
    foreign_principal = Principal("other-user", f"other-{uuid4().hex}", ("manager",))
    suffix = uuid4().hex
    create_ingredient(store, IngredientCreate(name=f"Grain A {suffix}", category="Secos",
        base_unit="kg", initial_quantity=2, min_quantity=0, cost_cents=100), principal)
    create_ingredient(store, IngredientCreate(name=f"Grain B {suffix}", category="Secos",
        base_unit="kg", initial_quantity=3, min_quantity=0, cost_cents=50), principal)
    create_ingredient(store, IngredientCreate(name=f"Grain C {suffix}", category="Carnes",
        base_unit="kg", initial_quantity=8, min_quantity=0, cost_cents=900), principal)
    create_ingredient(store, IngredientCreate(name=f"Grain foreign {suffix}", category="Secos",
        base_unit="kg", initial_quantity=50, min_quantity=0, cost_cents=900), foreign_principal)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        database=SimpleNamespace(db=store))))

    result = main.list_ingredients(request, low_stock=False, active_only=False, search=None,
        category="Secos", status=None, sort="name", limit=2, offset=0,
        include_summary=True, principal=principal)

    assert result["total"] == 2
    assert result["summary"] == {"known_stock_value_cents": 350, "without_cost": 0}
    assert len(result["items"]) == 2
    assert all(item["restaurant_id"] == principal.restaurant_id for item in result["items"])


def test_concurrent_retries_of_same_count_approval_apply_one_adjustment(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Concurrent count", category="Secos",
        base_unit="kg", initial_quantity=5), principal)
    count = create_count(store, CountCreate(ingredient_ids=[item["_id"]]), principal, "count-concurrent-create")
    count = set_count_line(store, count["_id"], item["_id"], CountLineUpdate(
        counted_quantity=4.5, expected_version=count["version"]), principal)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(
            lambda _: approve_count(store, count["_id"], principal, "count-concurrent-approval",
                                    count["version"]),
            (1, 2),
        ))

    assert all(result["status"] == "approved" for result in results)
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == 4.5
    assert store.movements.count_documents({"ingredient_id": item["_id"], "kind": "count_out"}) == 1
    assert store.audit_events.count_documents({"restaurant_id": principal.restaurant_id,
        "source_type": "count_approval", "source_id": count["_id"]}) == 1


def test_count_snapshot_marks_financial_impact_incomplete_without_unit_cost(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Unpriced count item", category="Secos",
        base_unit="kg", initial_quantity=3), principal)
    count = create_count(store, CountCreate(ingredient_ids=[item["_id"]]), principal, "count-unpriced-start")
    counted = set_count_line(store, count["_id"], item["_id"], CountLineUpdate(
        counted_quantity=2.5, expected_version=count["version"]), principal)

    approved = approve_count(store, count["_id"], principal, "count-unpriced-approve", counted["version"])

    assert approved["financial_impact_complete"] is False
    assert approved["financial_impact_cents"] is None
    assert approved["lines"][0]["financial_impact_complete"] is False
    assert approved["lines"][0]["financial_impact_cents"] is None
    assert approved["lines"][0]["valuation_complete"] is False
    assert approved["lines"][0]["expected_value_cents"] is None
    assert approved["lines"][0]["counted_value_cents"] is None
    movement = store.movements.find_one({"restaurant_id": principal.restaurant_id,
        "ingredient_id": item["_id"], "kind": "count_out"})
    assert movement["unit_cost_cents"] is None


def test_zero_delta_count_approval_fences_stock_without_creating_a_movement(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Unchanged count", category="Secos",
        base_unit="kg", initial_quantity=5), principal)
    count = create_count(store, CountCreate(ingredient_ids=[item["_id"]]), principal, "count-zero-delta-create")
    count = set_count_line(store, count["_id"], item["_id"], CountLineUpdate(
        counted_quantity=5, expected_version=count["version"]), principal)

    approved = approve_count(store, count["_id"], principal, "count-zero-delta-approval", count["version"])

    current = store.ingredients.find_one({"_id": item["_id"], "restaurant_id": principal.restaurant_id})
    assert approved["status"] == "approved"
    assert current["current_quantity"] == 5
    assert current["count_approval_revision"] == 1
    assert store.movements.count_documents({"ingredient_id": item["_id"],
        "kind": {"$in": ["count_in", "count_out"]}}) == 0


def test_count_refuses_approval_if_stock_changed_after_snapshot(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Rice", category="Secos",
        base_unit="kg", initial_quantity=5), principal)
    count = create_count(store, CountCreate(ingredient_ids=[item["_id"]]), principal, "count-start-conflict")
    count = set_count_line(store, count["_id"], item["_id"], CountLineUpdate(
        counted_quantity=4, expected_version=count["version"]), principal)
    append_movement(store, item["_id"], MovementCreate(kind="adjustment_out", quantity=1,
        reason="Movimento durante contagem"), principal, "stock-change-during-count")

    with pytest.raises(HTTPException) as error:
        approve_count(store, count["_id"], principal, "count-approve-conflict", count["version"])

    assert error.value.status_code == 409
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == 4


def test_count_refuses_net_zero_stock_movements_after_snapshot(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Net zero count conflict", category="Secos",
        base_unit="kg", initial_quantity=5), principal)
    count = create_count(store, CountCreate(ingredient_ids=[item["_id"]]), principal,
                         f"count-net-zero-{uuid4().hex}")
    count = set_count_line(store, count["_id"], item["_id"], CountLineUpdate(
        counted_quantity=4, expected_version=count["version"]), principal)
    append_movement(store, item["_id"], MovementCreate(kind="adjustment_out", quantity=1,
        reason="Saída durante contagem"), principal, f"count-net-out-{uuid4().hex}")
    append_movement(store, item["_id"], MovementCreate(kind="adjustment_in", quantity=1,
        reason="Entrada durante contagem"), principal, f"count-net-in-{uuid4().hex}")

    current = store.ingredients.find_one({"_id": item["_id"], "restaurant_id": principal.restaurant_id})
    assert current["current_quantity"] == item["current_quantity"]
    assert current["stock_version"] != count["lines"][0]["expected_stock_version"]
    with pytest.raises(HTTPException) as error:
        approve_count(store, count["_id"], principal, f"count-net-approve-{uuid4().hex}", count["version"])

    assert error.value.status_code == 409
    assert store.counts.find_one({"_id": count["_id"]})["status"] == "open"


def test_count_rejects_stale_line_edits_and_stale_approval_versions(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Concurrent count edit", category="Secos",
        base_unit="kg", initial_quantity=5), principal)
    count = create_count(store, CountCreate(ingredient_ids=[item["_id"]]), principal, "count-version-start")
    stale_version = count["version"]
    current = set_count_line(store, count["_id"], item["_id"], CountLineUpdate(
        counted_quantity=4.5, expected_version=stale_version), principal)

    with pytest.raises(HTTPException) as stale_edit:
        set_count_line(store, count["_id"], item["_id"], CountLineUpdate(
            counted_quantity=4, expected_version=stale_version), principal)
    assert stale_edit.value.status_code == 409
    assert current["lines"][0]["counted_quantity"] == 4.5
    assert store.counts.find_one({"_id": count["_id"]})["version"] == current["version"]

    with pytest.raises(HTTPException) as stale_approval:
        approve_count(store, count["_id"], principal, "count-version-stale-approve", stale_version)
    assert stale_approval.value.status_code == 409
    assert store.counts.find_one({"_id": count["_id"]})["status"] == "open"

    approved = approve_count(store, count["_id"], principal, "count-version-approve", current["version"])
    assert approved["status"] == "approved"
    assert store.ingredients.find_one({"_id": item["_id"]})["current_quantity"] == 4.5
    assert store.counts.find_one({"_id": count["_id"]})["status"] == "approved"
    assert store.movements.count_documents({"ingredient_id": item["_id"], "kind": "count_out"}) == 1


def test_receipt_keeps_purchase_price_and_updates_weighted_average_cost(store):
    principal = Principal("test-user", "65a000000000000000000002", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Coffee", category="Secos",
        base_unit="kg", initial_quantity=10, cost_cents=1000), principal)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=item["_id"], quantity_ordered=10, unit="kg", expected_unit_cost_cents=2000,
    )]), principal, "weighted-cost-purchase")
    store.purchases.update_one({"_id": purchase["_id"]}, {"$set": {"status": "requested"}})
    receipt = PurchaseReceive(expected_version=purchase["version"], lines=[PurchaseReceiveLine(
        line_id=purchase["lines"][0]["id"], quantity_received=10, unit_cost_cents=2000,
    )])

    receive_purchase(store, purchase["_id"], receipt, principal, "weighted-cost-receipt")

    updated = store.ingredients.find_one({"_id": item["_id"]})
    assert updated["current_quantity"] == 20
    assert updated["cost_cents"] == 1500
    assert updated["version"] == item["version"] + 1
    assert updated["price_history"][-1]["unit_cost_cents"] == 2000
    assert updated["price_history"][-1]["purchase_unit_cost_cents"] == 2000
    with pytest.raises(HTTPException) as stale_cost_editor:
        update_ingredient(store, item["_id"], IngredientUpdate(
            cost_cents=900, expected_version=item["version"]), principal)
    assert stale_cost_editor.value.status_code == 409
    assert store.ingredients.find_one({"_id": item["_id"]})["cost_cents"] == 1500


def test_supplier_update_is_tenant_scoped_and_can_be_reactivated(store):
    owner = Principal("owner", "65a000000000000000000002", ("manager",))
    other = Principal("other", "65a000000000000000000003", ("manager",))
    supplier = create_supplier(store, SupplierCreate(name="Fresh Foods"), owner)

    updated = update_supplier(store, supplier["_id"], SupplierUpdate(
        expected_version=supplier["version"], name="Fresh Foods Ltd", active=False), owner)
    assert updated["name"] == "Fresh Foods Ltd"
    assert updated["active"] is False
    update_supplier(store, supplier["_id"], SupplierUpdate(
        expected_version=updated["version"], name="Fresh Foods Ltd", active=False), owner)

    with pytest.raises(HTTPException) as error:
        update_supplier(store, supplier["_id"], SupplierUpdate(
            expected_version=updated["version"], name="Hijacked"), other)
    assert error.value.status_code == 404
    assert store.suppliers.find_one({"_id": supplier["_id"]})["name"] == "Fresh Foods Ltd"

    reactivated = update_supplier(store, supplier["_id"], SupplierUpdate(
        expected_version=updated["version"], active=True), owner)
    assert reactivated["active"] is True
    assert store.audit_events.count_documents({"restaurant_id": owner.restaurant_id,
        "source_type": "supplier", "source_id": supplier["_id"]}) == 3


def test_ingredient_and_supplier_updates_reject_stale_versions(store):
    owner = Principal("catalog-version-owner", "65a000000000000000000002", ("manager",))
    ingredient = create_ingredient(store, IngredientCreate(name="Versioned ingredient", category="Secos",
        base_unit="kg"), owner)
    supplier = create_supplier(store, SupplierCreate(name="Versioned supplier"), owner)
    assert ingredient["version"] == supplier["version"] == 1

    changed_ingredient = update_ingredient(store, ingredient["_id"], IngredientUpdate(
        min_quantity=2, expected_version=1), owner)
    changed_supplier = update_supplier(store, supplier["_id"], SupplierUpdate(
        phone="123", expected_version=1), owner)
    assert changed_ingredient["version"] == changed_supplier["version"] == 2

    with pytest.raises(HTTPException) as stale_ingredient:
        update_ingredient(store, ingredient["_id"], IngredientUpdate(
            min_quantity=4, expected_version=1), owner)
    with pytest.raises(HTTPException) as stale_supplier:
        update_supplier(store, supplier["_id"], SupplierUpdate(
            phone="456", expected_version=1), owner)
    assert stale_ingredient.value.status_code == stale_supplier.value.status_code == 409
    assert store.ingredients.find_one({"_id": ingredient["_id"]})["min_quantity"] == 2
    assert store.suppliers.find_one({"_id": supplier["_id"]})["phone"] == "123"

    legacy_ingredient = create_ingredient(store, IngredientCreate(
        name="Legacy version ingredient", category="Secos", base_unit="kg"), owner)
    legacy_supplier = create_supplier(store, SupplierCreate(name="Legacy version supplier"), owner)
    store.ingredients.update_one({"_id": legacy_ingredient["_id"]}, {"$unset": {"version": ""}})
    store.suppliers.update_one({"_id": legacy_supplier["_id"]}, {"$unset": {"version": ""}})
    assert update_ingredient(store, legacy_ingredient["_id"], IngredientUpdate(
        min_quantity=1, expected_version=1), owner)["version"] == 2
    assert update_supplier(store, legacy_supplier["_id"], SupplierUpdate(
        phone="789", expected_version=1), owner)["version"] == 2


def test_duplicate_supplier_creation_rolls_back_its_audit_event(store):
    owner = Principal("supplier-creator", "65a000000000000000000002", ("manager",))
    original = create_supplier(store, SupplierCreate(name="Same supplier"), owner)

    with pytest.raises(HTTPException) as duplicate:
        create_supplier(store, SupplierCreate(name="Same supplier"), owner)

    assert duplicate.value.status_code == 409
    assert store.suppliers.count_documents({"restaurant_id": owner.restaurant_id}) == 1
    assert store.audit_events.count_documents({"restaurant_id": owner.restaurant_id,
        "source_type": "supplier", "action": "supplier.create"}) == 1
    assert store.audit_events.find_one({"_id": original["created_audit_event_id"]}) is not None


def test_concurrent_idempotent_ingredient_create_commits_one_catalog_item_and_initial_movement(store):
    owner = Principal("ingredient-idempotency-owner", "65a000000000000000000012", ("manager",))
    data = IngredientCreate(name="Retry-safe rice", category="Secos", base_unit="kg",
                            initial_quantity=2)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _index: create_ingredient(
            store, data, owner, "same-ingredient-request"), (1, 2)))

    assert results[0]["_id"] == results[1]["_id"]
    assert results[0]["current_quantity"] == results[1]["current_quantity"] == 2
    assert store.ingredients.count_documents({"restaurant_id": owner.restaurant_id}) == 1
    assert store.movements.count_documents({"restaurant_id": owner.restaurant_id,
        "ingredient_id": results[0]["_id"], "kind": "adjustment_in"}) == 1
    assert store.audit_events.count_documents({"restaurant_id": owner.restaurant_id,
        "source_type": "ingredient", "source_id": results[0]["_id"]}) == 1

    with pytest.raises(HTTPException) as changed_payload:
        create_ingredient(store, data.model_copy(update={"name": "Different rice"}), owner,
                          "same-ingredient-request")
    assert changed_payload.value.status_code == 409

    other = Principal("ingredient-idempotency-other", "65a000000000000000000013", ("manager",))
    other_tenant = create_ingredient(store, data, other, "same-ingredient-request")
    assert other_tenant["restaurant_id"] == other.restaurant_id


def test_concurrent_idempotent_supplier_create_commits_one_supplier_and_audit_event(store):
    owner = Principal("supplier-idempotency-owner", "65a000000000000000000014", ("manager",))
    data = SupplierCreate(name="Retry-safe supplier")

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _index: create_supplier(
            store, data, owner, "same-supplier-request"), (1, 2)))

    assert results[0]["_id"] == results[1]["_id"]
    assert store.suppliers.count_documents({"restaurant_id": owner.restaurant_id}) == 1
    assert store.audit_events.count_documents({"restaurant_id": owner.restaurant_id,
        "source_type": "supplier", "source_id": results[0]["_id"]}) == 1
    with pytest.raises(HTTPException) as changed_payload:
        create_supplier(store, data.model_copy(update={"name": "Changed supplier"}), owner,
                        "same-supplier-request")
    assert changed_payload.value.status_code == 409


def test_recipe_snapshots_freeze_cost_and_ignore_identical_retries(store):
    principal = Principal("recipe-owner", "65a000000000000000000002", ("manager",))
    other = Principal("other-owner", "65a000000000000000000003", ("manager",))
    ingredient = create_ingredient(store, IngredientCreate(name="Beef", category="Carnes", base_unit="kg",
        initial_quantity=5, cost_cents=1000), principal)
    first_version = RecipePut(product_id="burger", product_name="Burger", sale_price_cents=2500,
        yield_portions=2,
        lines=[RecipeLine(ingredient_id=ingredient["_id"], quantity=250, unit="g")])

    saved = upsert_recipe(store, first_version, principal)
    retry = upsert_recipe(store, first_version.model_copy(update={
        "expected_version": saved["version"]}), principal)
    assert saved["product_id"] == retry["product_id"]
    assert store.recipe_snapshots.count_documents({"restaurant_id": principal.restaurant_id}) == 1
    first_snapshot = store.recipe_snapshots.find_one({"restaurant_id": principal.restaurant_id})
    assert store.audit_events.count_documents({"restaurant_id": principal.restaurant_id,
        "source_type": "recipe_snapshot", "source_id": first_snapshot["_id"]}) == 1
    assert first_snapshot["yield_portions"] == 2
    assert first_snapshot["batch_cost_cents"] == 250
    assert first_snapshot["cost_cents"] == 125
    assert first_snapshot["lines"][0]["unit_cost_cents"] == 1000
    assert store.recipe_snapshots.count_documents({"restaurant_id": other.restaurant_id}) == 0

    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=ingredient["_id"], quantity_ordered=1, unit="kg", expected_unit_cost_cents=3000,
    )]), principal, "recipe-cost-update")
    requested = set_purchase_status(store, purchase["_id"], "requested", principal, purchase["version"])
    receive_purchase(store, purchase["_id"], PurchaseReceive(expected_version=requested["version"], lines=[PurchaseReceiveLine(
        line_id=purchase["lines"][0]["id"], quantity_received=1, unit_cost_cents=3000,
    )]), principal, "recipe-cost-receipt")
    current_recipe = store.recipes.find_one({"restaurant_id": principal.restaurant_id, "product_id": "burger"})
    assert current_recipe["version"] == saved["version"] + 1
    second_version = first_version.model_copy(update={"sale_price_cents": 3000, "yield_portions": 4,
        "expected_version": current_recipe["version"]})
    updated_recipe = upsert_recipe(store, second_version, principal)
    assert updated_recipe["yield_portions"] == 4
    stale_version = first_version.model_copy(update={"sale_price_cents": 2800,
        "expected_version": saved["version"]})
    with pytest.raises(HTTPException) as stale_edit:
        upsert_recipe(store, stale_version, principal)
    assert stale_edit.value.status_code == 409
    snapshots = list(store.recipe_snapshots.find({"restaurant_id": principal.restaurant_id}).sort("occurred_at", 1))
    assert [snapshot["cost_cents"] for snapshot in snapshots] == [125, 167, 83]
    assert [snapshot["batch_cost_cents"] for snapshot in snapshots] == [250, 333, 333]
    assert [snapshot["yield_portions"] for snapshot in snapshots] == [2, 2, 4]
    assert snapshots[1]["trigger"] == "Custo de insumo atualizado por recebimento"


def test_recipe_deactivation_is_persisted_audited_and_tenant_scoped(store):
    principal = Principal("recipe-owner", "65a000000000000000000002", ("manager",))
    other = Principal("other-owner", "65a000000000000000000003", ("manager",))
    item = create_ingredient(store, IngredientCreate(name="Active recipe flour", category="Secos",
        base_unit="kg", initial_quantity=10, cost_cents=100), principal)
    recipe = upsert_recipe(store, RecipePut(product_id="flour-bread", product_name="Bread",
        sale_price_cents=800, lines=[RecipeLine(ingredient_id=item["_id"], quantity=0.5, unit="kg")]), principal)

    inactive = set_recipe_active(store, "flour-bread", False, recipe["version"], principal)

    assert inactive["active"] is False
    assert inactive["version"] == recipe["version"] + 1
    assert store.recipes.find_one({"product_id": "flour-bread", "restaurant_id": other.restaurant_id}) is None
    event = store.audit_events.find_one({"restaurant_id": principal.restaurant_id,
        "source_id": recipe["_id"], "reason": "Ficha técnica desativada"})
    assert event is not None
    with pytest.raises(HTTPException) as stale:
        set_recipe_active(store, "flour-bread", True, recipe["version"], principal)
    assert stale.value.status_code == 409
    edited_inactive = upsert_recipe(store, RecipePut(product_id="flour-bread", product_name="Bread v2",
        sale_price_cents=850, expected_version=inactive["version"],
        lines=[RecipeLine(ingredient_id=item["_id"], quantity=0.6, unit="kg")]), principal)
    assert edited_inactive["active"] is False
    reactivated = set_recipe_active(store, "flour-bread", True, edited_inactive["version"], principal)
    assert reactivated["active"] is True
    assert reactivated["version"] == edited_inactive["version"] + 1


def test_manual_cost_update_snapshots_recipe_and_preserves_frozen_unit_conversion(store):
    principal = Principal("recipe-owner", "65a000000000000000000002", ("manager",))
    ingredient = create_ingredient(store, IngredientCreate(
        name="Boxed cheese", category="Laticínios", base_unit="un", cost_cents=100,
        conversions={"caixa": 12},
    ), principal)
    recipe = RecipePut(product_id="cheese-board", product_name="Tábua", sale_price_cents=3000,
        lines=[RecipeLine(ingredient_id=ingredient["_id"], quantity=1, unit="caixa")])
    saved_recipe = upsert_recipe(store, recipe, principal)
    # Simulate a recipe written before conversion factors were persisted per line.
    store.recipes.update_one(
        {"restaurant_id": principal.restaurant_id, "product_id": "cheese-board"},
        {"$unset": {"lines.$[line].conversion_to_base": "", "version": ""}},
        array_filters=[{"line.ingredient_id": ingredient["_id"]}],
    )

    update_ingredient(store, ingredient["_id"], IngredientUpdate(
        expected_version=ingredient["version"], cost_cents=200, conversions={"caixa": 24},
    ), principal)

    current_recipe = store.recipes.find_one({"restaurant_id": principal.restaurant_id,
                                             "product_id": "cheese-board"})
    # Freezing the old factor and recording the new cost snapshot are separate
    # recipe changes, so both advance the optimistic version.
    assert current_recipe["version"] == saved_recipe["version"] + 2
    assert current_recipe["lines"][0]["conversion_to_base"] == 12
    assert store.audit_events.count_documents({"restaurant_id": principal.restaurant_id,
        "source_type": "recipe", "source_id": current_recipe["_id"],
        "action": "recipe.conversion.freeze"}) == 1
    with pytest.raises(HTTPException) as stale_editor:
        upsert_recipe(store, RecipePut(product_id="cheese-board", product_name="Tábua",
            sale_price_cents=3000, expected_version=saved_recipe["version"],
            lines=[RecipeLine(ingredient_id=ingredient["_id"], quantity=1, unit="caixa")]),
            principal)
    assert stale_editor.value.status_code == 409

    snapshots = list(store.recipe_snapshots.find({"restaurant_id": principal.restaurant_id}).sort("occurred_at", 1))
    assert [snapshot["cost_cents"] for snapshot in snapshots] == [1200, 2400]
    assert snapshots[-1]["trigger"] == "Custo de insumo atualizado manualmente"
    assert float(snapshots[-1]["lines"][0]["conversion_to_base"]) == 12
    with pytest.raises(HTTPException) as error:
        update_ingredient(store, ingredient["_id"], IngredientUpdate(
            expected_version=ingredient["version"], base_unit="kg"), principal)
    assert error.value.status_code == 409


def test_purchase_and_receipt_convert_purchase_unit_to_base_unit(store):
    principal = Principal("unit-owner", "65a000000000000000000002", ("manager",))
    ingredient = create_ingredient(store, IngredientCreate(
        name="Cheese", category="Laticínios", base_unit="g", initial_quantity=1000, cost_cents=1,
    ), principal)
    purchase = create_purchase(store, PurchaseCreate(lines=[PurchaseLineCreate(
        ingredient_id=ingredient["_id"], quantity_ordered=2, unit="kg", expected_unit_cost_cents=2000,
    )]), principal, "unit-purchase")
    assert purchase["lines"][0]["unit"] == "kg"
    requested = set_purchase_status(store, purchase["_id"], "requested", principal, purchase["version"])
    receive_purchase(store, purchase["_id"], PurchaseReceive(expected_version=requested["version"], lines=[PurchaseReceiveLine(
        line_id=purchase["lines"][0]["id"], quantity_received=2, unit_cost_cents=2000,
    )]), principal, "unit-receipt")
    saved_ingredient = store.ingredients.find_one({"_id": ingredient["_id"], "restaurant_id": principal.restaurant_id})
    assert saved_ingredient["current_quantity_milli"] == 3_000_000
    assert saved_ingredient["cost_cents"] == 2
    movement = store.movements.find_one({"restaurant_id": principal.restaurant_id,
                                         "purchase_reference": purchase["_id"]})
    assert movement["quantity"] == 2000
    assert movement["unit"] == "g"
def test_inventory_remote_filters_and_supplier_search_with_real_mongodb(store):
    tenant = Principal("manager-a", "inventory-search-tenant", ("manager",))
    other_tenant = Principal("manager-b", "inventory-search-other-tenant", ("manager",))
    supplier = create_supplier(store, SupplierCreate(name="Casa do Fornecedor"), tenant,
                               f"supplier-{uuid4().hex}")
    foreign_supplier = create_supplier(store, SupplierCreate(name="Casa do Fornecedor"), other_tenant,
                                       f"supplier-{uuid4().hex}")
    item = create_ingredient(store, IngredientCreate(
        name="Queijo prato", category="Latic\u00EDnios", base_unit="kg", initial_quantity=1,
        min_quantity=10, primary_supplier_id=supplier["_id"],
    ), tenant, f"ingredient-{uuid4().hex}")
    create_ingredient(store, IngredientCreate(
        name="Queijo prato", category="Latic\u00EDnios", base_unit="kg", initial_quantity=1,
        min_quantity=10, primary_supplier_id=foreign_supplier["_id"],
    ), other_tenant, f"ingredient-{uuid4().hex}")
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        database=SimpleNamespace(db=store))))

    by_supplier = main.list_ingredients(request, low_stock=False, search="fornecedor",
        category=None, status=None, sort="name", limit=10, offset=0, principal=tenant)
    by_category = main.list_ingredients(request, low_stock=False, search=None,
        category="Latic\u00EDnios", status="critical", sort="priority", limit=10,
        offset=0, principal=tenant)

    assert [row["_id"] for row in by_supplier] == [item["_id"]]
    assert [row["_id"] for row in by_category] == [item["_id"]]
