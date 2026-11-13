from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.main import audit, decode_audit_cursor, encode_audit_cursor, list_page, public_api_value
from app.auth import Principal
from app.schemas import MovementCreate


class FakeCursor:
    def __init__(self, values):
        self.values = values
        self.sort_keys = None
        self.offset = None
        self.page_size = None

    def sort(self, keys):
        self.sort_keys = keys
        return self

    def skip(self, offset):
        self.offset = offset
        self.values = self.values[offset:]
        return self

    def limit(self, limit):
        self.page_size = limit
        self.values = self.values[:limit]
        return self

    def __iter__(self):
        return iter(self.values)


def test_public_manual_adjustment_requires_the_balance_seen_by_the_operator(monkeypatch):
    from app import main

    monkeypatch.setattr(main, "require_allowed_origin", lambda _request: None)
    with pytest.raises(HTTPException) as error:
        main.post_movement("ingredient-a", MovementCreate(
            kind="adjustment_in", quantity=1, reason="Conferência manual"),
            SimpleNamespace(), "movement-key", Principal("manager", "restaurant-a", ("manager",)))

    assert error.value.status_code == 422
    assert error.value.detail == "expected_balance is required for manual stock adjustments"


class FakeCollection:
    def __init__(self, values):
        self.values = values
        self.query = None
        self.cursor = None

    def find(self, query, *_args):
        self.query = query
        self.cursor = FakeCursor(self.values)
        return self.cursor


def test_list_page_applies_offset_and_limit_after_tenant_query():
    collection = FakeCollection([{"_id": str(index), "restaurant_id": "tenant-a"} for index in range(7)])
    page = list_page(collection, {"restaurant_id": "tenant-a"}, [("_id", 1)], limit=3, offset=2)
    assert collection.query == {"restaurant_id": "tenant-a"}
    assert [row["_id"] for row in page] == ["2", "3", "4"]


def test_public_api_value_recursively_hides_retry_metadata_without_mutating_documents():
    stored = {"idempotency_key": "retry-key", "request_fingerprint": "hash",
              "receipt": {"reversal_idempotency_key": "reverse-key",
                          "reversal_request_fingerprint": "reverse-hash"},
              "count": {"create_key": "count-key", "approval_key": "approval-key",
                        "approval_request_fingerprint": "approval-hash", "approval_version": 4},
              "name": "Rice"}

    public = public_api_value(stored)

    assert public == {"receipt": {}, "count": {"approval_version": 4}, "name": "Rice"}
    assert stored["idempotency_key"] == "retry-key"
    assert stored["receipt"]["reversal_idempotency_key"] == "reverse-key"


def test_ingredient_quantity_sort_uses_legacy_quantity_fallback_and_tenant_scope():
    from app import main

    class AggregateCollection:
        def __init__(self):
            self.pipeline = None

        def aggregate(self, pipeline):
            self.pipeline = pipeline
            return iter([{"_id": "ingredient-a", "current_quantity": 0.75,
                          "idempotency_key": "internal-key", "request_fingerprint": "internal-hash"}])

    collection = AggregateCollection()
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        database=SimpleNamespace(db=SimpleNamespace(ingredients=collection)))))
    principal = Principal("user-a", "restaurant-a", ("manager",))

    result = main.list_ingredients(request, low_stock=False, search=None, category=None,
        status=None, sort="quantity_asc", limit=500, offset=0, principal=principal)

    assert result == [{"_id": "ingredient-a", "current_quantity": 0.75}]
    assert collection.pipeline[0] == {"$match": {"restaurant_id": "restaurant-a"}}
    assert collection.pipeline[1]["$addFields"]["_sort_quantity_milli"]["$ifNull"] == [
        "$current_quantity_milli", {"$multiply": ["$current_quantity", 1000]},
    ]


def test_audit_cursor_round_trips_timestamp_and_identifier():
    entry = {"at": datetime(2026, 11, 12, 10, 30, tzinfo=timezone.utc), "id": "audit:stable-id"}
    assert decode_audit_cursor(encode_audit_cursor(entry)) == (entry["at"], entry["id"])


@pytest.mark.parametrize("cursor", ["!", "e30", "eyJhdCI6Im5vLWRhdGUiLCJpZCI6IngifQ"])
def test_invalid_audit_cursors_are_rejected(cursor):
    with pytest.raises(HTTPException) as error:
        decode_audit_cursor(cursor)
    assert error.value.status_code == 422


def test_audit_cursor_rejects_oversized_value():
    with pytest.raises(HTTPException) as error:
        decode_audit_cursor("a" * 1001)
    assert error.value.status_code == 422


def test_audit_cursor_is_only_a_position_and_does_not_supply_tenant():
    class FakeDb:
        audit_events = FakeCollection([])
        ingredients = FakeCollection([])
        suppliers = FakeCollection([])
        purchases = FakeCollection([])
        movements = FakeCollection([])
        losses = FakeCollection([])
        purchase_changes = FakeCollection([])
        recipe_snapshots = FakeCollection([])
        counts = FakeCollection([])
        purchase_receipts = FakeCollection([])

    from app.service import list_audit_entries
    tenant = "restaurant-from-authenticated-principal"
    list_audit_entries(FakeDb(), Principal("user", tenant, ("manager",)), limit=10)
    assert FakeDb.audit_events.query == {"restaurant_id": tenant}


def test_business_write_routes_match_the_frontend_role_matrix():
    from app import main

    manager = Principal("manager", "restaurant-a", ("manager",))
    admin = Principal("admin", "restaurant-a", ("admin",))
    admin_only_paths = {
        ("POST", "/api/v1/suppliers"),
        ("PATCH", "/api/v1/suppliers/{supplier_id}"),
        ("PUT", "/api/v1/recipes/{product_id}"),
        ("PATCH", "/api/v1/recipes/{product_id}/status"),
    }
    manager_paths = {
        ("POST", "/api/v1/ingredients"),
        ("PATCH", "/api/v1/ingredients/{ingredient_id}"),
        ("POST", "/api/v1/ingredients/{ingredient_id}/movements"),
        ("POST", "/api/v1/purchases"),
        ("PUT", "/api/v1/purchases/{purchase_id}"),
        ("POST", "/api/v1/purchases/{purchase_id}/receipts"),
        ("POST", "/api/v1/purchases/{purchase_id}/receipts/{receipt_id}/reversal"),
        ("POST", "/api/v1/purchases/{purchase_id}/request"),
        ("POST", "/api/v1/purchases/{purchase_id}/cancel"),
        ("POST", "/api/v1/movements/{movement_id}/reversal"),
        ("POST", "/api/v1/counts"),
        ("PATCH", "/api/v1/counts/{count_id}/lines/{ingredient_id}"),
        ("POST", "/api/v1/counts/{count_id}/approve"),
        ("POST", "/api/v1/losses"),
    }
    routes = {(method, route.path): route for route in main.app.routes
        if hasattr(route, "dependant") for method in route.methods or set()}

    assert admin_only_paths | manager_paths <= routes.keys()
    assert admin_only_paths.isdisjoint(manager_paths)
    for key in admin_only_paths | manager_paths:
        route = routes[key]
        authorization_dependencies = [dependency.call for dependency in route.dependant.dependencies]
        if key in admin_only_paths:
            authorization = next(call for call in authorization_dependencies
                if getattr(call, "__name__", "") == "require_admin")
            assert authorization(admin) is admin
            with pytest.raises(HTTPException) as denied:
                authorization(manager)
            assert denied.value.status_code == 403
        else:
            manager_authorizers = []
            for authorization in authorization_dependencies:
                try:
                    if authorization(manager) is manager:
                        manager_authorizers.append(authorization)
                except HTTPException as error:
                    assert error.status_code == 403
            assert len(manager_authorizers) == 1, f"{key} must authorize manager through exactly one route dependency"
            assert manager_authorizers[0](admin) is admin


def test_audit_endpoint_returns_limited_page_and_stable_next_cursor(monkeypatch):
    from app import main

    timestamp = datetime(2026, 11, 12, 10, 30, tzinfo=timezone.utc)
    monkeypatch.setattr(main, "db_from", lambda _request: object())
    monkeypatch.setattr(main, "list_audit_entries", lambda _db, _principal, **kwargs: [
        {"at": timestamp, "id": "event-3"},
        {"at": timestamp, "id": "event-2"},
        {"at": timestamp, "id": "event-1"},
    ][:kwargs["limit"]])
    response = audit(SimpleNamespace(), limit=2, cursor=None,
        principal=Principal("user", "restaurant-a", ("manager",)))
    assert response["items"] == [{"at": timestamp, "id": "event-3"}, {"at": timestamp, "id": "event-2"}]
    assert response["has_more"] is True
    assert decode_audit_cursor(response["next_cursor"]) == (timestamp, "event-2")


@pytest.mark.parametrize(("route_name", "collection_name", "sort"), [
    ("list_ingredients", "ingredients", [("name", 1), ("_id", 1)]),
    ("list_suppliers", "suppliers", [("name", 1), ("_id", 1)]),
    ("list_purchases", "purchases", [("created_at", -1), ("_id", -1)]),
    ("list_counts", "counts", [("created_at", -1), ("_id", -1)]),
    ("list_losses", "losses", [("occurred_at", -1), ("_id", -1)]),
    ("list_recipes", "recipes", [("product_name", 1), ("_id", 1)]),
    ("list_recipe_snapshots", "recipe_snapshots", [("occurred_at", -1), ("_id", -1)]),
    ("list_all_movements", "movements", [("occurred_at", -1), ("_id", -1)]),
])
def test_business_list_endpoints_are_tenant_scoped_paginated_and_hide_internal_keys(
        route_name, collection_name, sort):
    from app import main

    rows = [{"_id": value, "restaurant_id": "restaurant-a",
             "idempotency_key": "internal-key", "request_fingerprint": "internal-hash",
             "create_key": "internal-create-key", "approval_key": "internal-approval-key"}
            for value in ("one", "two", "three")]
    collection = FakeCollection(rows)
    database = SimpleNamespace(db=SimpleNamespace(**{collection_name: collection}))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database=database)))
    principal = Principal("user-a", "restaurant-a", ("manager",))

    route = getattr(main, route_name)
    extra = {"search": None, "category": None, "status": None, "sort": "name"} if route_name == "list_ingredients" else {}
    if route_name == "list_purchases":
        extra = {"status": None, "supplier_id": None}
    if route_name == "list_suppliers":
        extra = {"include_inactive": False, "search": None}
    if route_name == "list_recipes":
        extra = {"ingredient_id": None}
    elif route_name == "list_recipe_snapshots":
        extra = {"product_id": None, "ingredient_id": None}
    result = route(request, limit=2, offset=1, principal=principal, **extra)

    expected_query = {"restaurant_id": "restaurant-a"}
    if route_name == "list_suppliers":
        expected_query["active"] = True
    assert collection.query == expected_query
    assert collection.cursor.sort_keys == ([('name_normalized', 1), ('_id', 1)]
                                            if route_name == "list_ingredients" else sort)
    assert collection.cursor.offset == 1
    assert collection.cursor.page_size == 2
    assert result == [
        {"_id": "two", "restaurant_id": "restaurant-a"},
        {"_id": "three", "restaurant_id": "restaurant-a"},
    ]


def test_purchase_list_filters_status_and_supplier_with_authenticated_tenant():
    from app import main

    collection = FakeCollection([])
    database = SimpleNamespace(db=SimpleNamespace(purchases=collection))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database=database)))
    principal = Principal("buyer", "restaurant-a", ("manager",))

    result = main.list_purchases(request, status="partial", supplier_id="supplier-a",
        limit=25, offset=50, principal=principal)

    assert result == []
    assert collection.query == {"restaurant_id": "restaurant-a", "status": "partial",
        "supplier_id": "supplier-a"}
    assert collection.cursor.sort_keys == [("created_at", -1), ("_id", -1)]
    assert collection.cursor.offset == 50
    assert collection.cursor.page_size == 25


def test_supplier_search_uses_escaped_prefix_and_authenticated_tenant():
    from app import main

    collection = FakeCollection([])
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        database=SimpleNamespace(db=SimpleNamespace(suppliers=collection)))))
    principal = Principal("manager", "restaurant-a", ("manager",))

    result = main.list_suppliers(request, include_inactive=True, search="Distrib.+",
        limit=20, offset=40, principal=principal)

    assert result == []
    assert collection.query == {"restaurant_id": "restaurant-a",
        "name_normalized": {"$regex": r"^distrib\.\+"}}
    assert collection.cursor.sort_keys == [("name", 1), ("_id", 1)]
    assert collection.cursor.offset == 40
    assert collection.cursor.page_size == 20


def test_supplier_by_ids_is_tenant_scoped_and_deduplicates_ids():
    from app import main

    collection = FakeCollection([{"_id": "supplier-a", "restaurant_id": "restaurant-a"}])
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        database=SimpleNamespace(db=SimpleNamespace(suppliers=collection)))))
    principal = Principal("manager", "restaurant-a", ("manager",))

    result = main.get_suppliers_by_ids(request, ids=["supplier-a", "supplier-a", "supplier-foreign"],
        principal=principal)

    assert result == [{"_id": "supplier-a", "restaurant_id": "restaurant-a"}]
    assert collection.query == {"restaurant_id": "restaurant-a",
        "_id": {"$in": ["supplier-a", "supplier-foreign"]}}
    assert collection.cursor.sort_keys == [("name", 1), ("_id", 1)]


def test_ingredient_by_ids_is_tenant_scoped_and_deduplicates_ids():
    from app import main

    collection = FakeCollection([{"_id": "ingredient-a", "restaurant_id": "restaurant-a"}])
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        database=SimpleNamespace(db=SimpleNamespace(ingredients=collection)))))
    principal = Principal("manager", "restaurant-a", ("manager",))

    result = main.get_ingredients_by_ids(request,
        ids=["ingredient-a", "ingredient-a", "ingredient-foreign"], principal=principal)

    assert result == [{"_id": "ingredient-a", "restaurant_id": "restaurant-a"}]
    assert collection.query == {"restaurant_id": "restaurant-a",
        "_id": {"$in": ["ingredient-a", "ingredient-foreign"]}}
    assert collection.cursor.sort_keys == [("name", 1), ("_id", 1)]


def test_purchase_insights_endpoint_uses_authenticated_principal(monkeypatch):
    from app import main

    principal = Principal("manager", "restaurant-a", ("manager",))
    database = object()
    monkeypatch.setattr(main, "db_from", lambda _request: database)
    monkeypatch.setattr(main, "purchase_insights", lambda db, actor: {
        "status_counts": {"draft": 3}, "month": {"order_count": 2, "expected_total_cents": 1234,
        "received_total_cents": 900, "received_unpriced_count": 1},
        "suppliers": {"supplier-a": {"order_count": 2, "recent_received_value_cents": 500,
            "last_receipt_at": None, "last_receipt_code": None}},
    } if db is database and actor.restaurant_id == "restaurant-a" else {})

    result = main.get_purchase_insights(SimpleNamespace(), principal)

    assert result["month"]["expected_total_cents"] == 1234
    assert result["month"]["received_total_cents"] == 900
    assert result["month"]["received_unpriced_count"] == 1
    assert "supplier-a" in result["suppliers"]


def test_inventory_insights_endpoint_uses_authenticated_principal(monkeypatch):
    from app import main

    principal = Principal("manager", "restaurant-a", ("manager",))
    database = object()
    monkeypatch.setattr(main, "db_from", lambda _request: database)
    monkeypatch.setattr(main, "inventory_insights", lambda db, actor: {
        "total": 4, "known_stock_value_cents": 1200, "without_cost": 1,
        "empty": 1, "critical": 0, "attention": 1, "near_minimum": 0, "normal": 2,
    } if db is database and actor.restaurant_id == "restaurant-a" else {})

    result = main.get_inventory_insights(SimpleNamespace(), principal)

    assert result["total"] == 4
    assert result["known_stock_value_cents"] == 1200


def test_operational_insights_endpoint_uses_authenticated_principal(monkeypatch):
    from app import main

    principal = Principal("manager", "restaurant-a", ("manager",))
    database = object()
    expected = {"losses": {"count": 2, "priced_count": 1, "unpriced_count": 1,
                            "value_cents": 125, "week_value_cents": 125,
                            "reason_totals": [{"reason": "Vencimento", "value_cents": 125}],
                            "top_item": None,
                            "top_month_reason": {"reason": "Vencimento", "value_cents": 125}},
                "counts": {"approved_count": 3, "unknown_financial_count": 1,
                           "divergence_cents": 310, "last_divergence": None}}
    monkeypatch.setattr(main, "db_from", lambda _request: database)
    monkeypatch.setattr(main, "operational_insights", lambda db, actor: expected
        if db is database and actor.restaurant_id == "restaurant-a" else {})

    result = main.get_operational_insights(SimpleNamespace(), principal)

    assert result == expected


def test_month_loss_endpoint_validates_reason_and_uses_authenticated_tenant(monkeypatch):
    from app import main

    principal = Principal("manager", "restaurant-a", ("manager",))
    database = object()
    expected = {"items": [], "total": 0, "has_more": False}
    monkeypatch.setattr(main, "db_from", lambda _request: database)
    monkeypatch.setattr(main, "list_loss_month_page", lambda db, actor, **kwargs: expected
        if db is database and actor.restaurant_id == "restaurant-a"
        and kwargs == {"limit": 50, "offset": 0, "reason": "Sobra"} else {})

    result = main.get_month_losses(SimpleNamespace(), 50, 0, "Sobra", principal)

    assert result == expected
    with pytest.raises(HTTPException) as error:
        main.get_month_losses(SimpleNamespace(), 50, 0, "inventado", principal)
    assert error.value.status_code == 422


def test_count_insights_endpoint_uses_authenticated_principal(monkeypatch):
    from app import main

    principal = Principal("manager", "restaurant-a", ("manager",))
    database = object()
    expected = {"status_counts": {"open": 2}, "unknown_financial_count": 1,
                "divergence_cents": 250, "latest_open": None}
    monkeypatch.setattr(main, "db_from", lambda _request: database)
    monkeypatch.setattr(main, "count_insights", lambda db, actor: expected
        if db is database and actor.restaurant_id == "restaurant-a" else {})

    assert main.get_count_insights(SimpleNamespace(), principal) == expected


def test_recipe_insights_endpoint_uses_authenticated_principal(monkeypatch):
    from app import main

    principal = Principal("manager", "restaurant-a", ("manager",))
    database = object()
    expected = {"total": 4, "active_count": 3, "calculable_count": 2,
                "attention_count": 1, "incomplete_count": 2, "average_cost_ratio": 0.3}
    monkeypatch.setattr(main, "require_allowed_origin", lambda _request: None)
    monkeypatch.setattr(main, "db_from", lambda _request: database)
    monkeypatch.setattr(main, "recipe_insights", lambda db, actor: expected
        if db is database and actor.restaurant_id == "restaurant-a" else {})

    assert main.get_recipe_insights(SimpleNamespace(), principal) == expected


def test_recipe_detail_endpoint_uses_authenticated_principal(monkeypatch):
    from app import main

    principal = Principal("manager", "restaurant-a", ("manager",))
    database = object()
    expected = {"product_id": "recipe-a", "restaurant_id": "restaurant-a"}
    monkeypatch.setattr(main, "require_allowed_origin", lambda _request: None)
    monkeypatch.setattr(main, "db_from", lambda _request: database)
    monkeypatch.setattr(main, "get_recipe", lambda db, actor, product_id: expected
        if db is database and actor.restaurant_id == "restaurant-a" and product_id == "recipe-a" else {})

    assert main.get_recipe_by_id("recipe-a", SimpleNamespace(), principal) == expected


def test_global_search_endpoint_uses_authenticated_principal(monkeypatch):
    from app import main

    principal = Principal("manager", "restaurant-a", ("manager",))
    database = object()
    expected = [{"id": "item:ingredient-a", "group": "Estoque", "title": "Tomate"}]
    monkeypatch.setattr(main, "db_from", lambda _request: database)
    monkeypatch.setattr(main, "global_search", lambda db, actor, query: expected
        if db is database and actor.restaurant_id == "restaurant-a" and query == "tomate" else [])

    assert main.search_records(SimpleNamespace(), "tomate", principal) == expected


def test_replenishment_recommendations_endpoint_uses_authenticated_principal(monkeypatch):
    from app import main

    principal = Principal("manager", "restaurant-a", ("manager",))
    database = object()
    expected = {"items": [], "total": 0}
    monkeypatch.setattr(main, "db_from", lambda _request: database)
    monkeypatch.setattr(main, "replenishment_recommendations", lambda db, actor, limit: expected
        if db is database and actor.restaurant_id == "restaurant-a" and limit == 5 else {})

    result = main.get_replenishment_recommendations(SimpleNamespace(), 5, principal)

    assert result == expected


def test_price_rise_insights_endpoint_uses_authenticated_principal(monkeypatch):
    from app import main

    principal = Principal("manager", "restaurant-a", ("manager",))
    database = object()
    expected = {"count": 0, "top": None}
    monkeypatch.setattr(main, "db_from", lambda _request: database)
    monkeypatch.setattr(main, "price_rise_insights", lambda db, actor: expected
        if db is database and actor.restaurant_id == "restaurant-a" else {})

    result = main.get_price_rise_insights(SimpleNamespace(), principal)

    assert result == expected


def test_ingredient_price_history_endpoint_uses_authenticated_principal(monkeypatch):
    from app import main

    principal = Principal("manager", "restaurant-a", ("manager",))
    database = object()
    expected = {"points": [], "summary": None}
    monkeypatch.setattr(main, "db_from", lambda _request: database)
    monkeypatch.setattr(main, "ingredient_price_history", lambda db, actor, ingredient_id: expected
        if db is database and actor.restaurant_id == "restaurant-a" and ingredient_id == "item-a" else {})

    result = main.get_ingredient_price_history("item-a", SimpleNamespace(), principal)

    assert result == expected


def test_catalog_create_update_and_detail_responses_hide_idempotency_metadata(monkeypatch):
    from app import main
    from app.schemas import IngredientCreate, IngredientUpdate, SupplierCreate, SupplierUpdate

    document = {"_id": "catalog-item", "name": "Example",
                "idempotency_key": "internal-key", "request_fingerprint": "internal-hash"}
    monkeypatch.setattr(main, "require_allowed_origin", lambda _request: None)
    monkeypatch.setattr(main, "db_from", lambda _request: SimpleNamespace(
        ingredients=SimpleNamespace(find_one=lambda _query: dict(document))))
    monkeypatch.setattr(main, "create_ingredient", lambda *_args: dict(document))
    monkeypatch.setattr(main, "update_ingredient", lambda *_args: dict(document))
    monkeypatch.setattr(main, "create_supplier", lambda *_args: dict(document))
    monkeypatch.setattr(main, "update_supplier", lambda *_args: dict(document))
    request = SimpleNamespace()
    principal = Principal("user-a", "restaurant-a", ("manager",))

    responses = [
        main.get_ingredient("catalog-item", request, principal),
        main.post_ingredient(IngredientCreate(name="Example", category="Secos", base_unit="kg"),
                             request, "request-key", principal),
        main.patch_ingredient("catalog-item", IngredientUpdate(expected_version=1, min_quantity=1),
                              request, principal),
        main.post_supplier(SupplierCreate(name="Example supplier"), request, "request-key", principal),
        main.patch_supplier("supplier-item", SupplierUpdate(expected_version=1, phone="123"),
                            request, principal),
    ]

    assert all(response == {"_id": "catalog-item", "name": "Example"} for response in responses)
    assert document["idempotency_key"] == "internal-key"  # Response filtering does not mutate persistence data.


def test_ingredient_search_filters_are_composed_with_authenticated_tenant_and_pagination():
    from app import main

    class AggregateCollection:
        pipeline = None

        def aggregate(self, pipeline):
            self.pipeline = pipeline
            return iter([])

    collection = AggregateCollection()
    database = SimpleNamespace(db=SimpleNamespace(ingredients=collection))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database=database)))
    principal = Principal("user-a", "restaurant-a", ("manager",))

    result = main.list_ingredients(request, search=" Quei", category="Laticínios",
        status="critical", sort="name", low_stock=True, limit=25, offset=50,
        principal=principal)

    assert result == []
    assert collection.pipeline[0]["$match"]["restaurant_id"] == "restaurant-a"
    assert collection.pipeline[0]["$match"]["category"] == "Laticínios"
    assert collection.pipeline[0]["$match"]["$expr"]["$and"][0] == {
        "$lte": [
            {"$ifNull": ["$current_quantity_milli", {"$multiply": ["$current_quantity", 1000]}]},
            {"$ifNull": ["$min_quantity_milli", {"$multiply": ["$min_quantity", 1000]}]},
        ],
    }
    supplier_lookup = collection.pipeline[1]["$lookup"]
    assert supplier_lookup["from"] == "suppliers"
    assert {"$eq": ["$restaurant_id", "restaurant-a"]} in supplier_lookup["pipeline"][0]["$match"]["$expr"]["$and"]
    search_filter = collection.pipeline[2]["$match"]["$or"]
    assert search_filter[0] == {"name_normalized": {"$regex": "quei"}}
    assert search_filter[1] == {"category": {"$regex": "quei", "$options": "i"}}
    assert search_filter[2] == {"_search_supplier.name_normalized": {"$regex": "quei"}}
    assert collection.pipeline[-3] == {"$skip": 50}
    assert collection.pipeline[-2] == {"$limit": 25}


def test_ingredient_page_summary_uses_same_tenant_filter_and_page_facet():
    from app import main

    class AggregateCollection:
        pipeline = None

        def aggregate(self, pipeline):
            self.pipeline = pipeline
            return iter([{"items": [{"_id": "ingredient-a", "restaurant_id": "restaurant-a"}],
                "summary": [{"_id": None, "total": 3,
                    "known_stock_value_cents": 1500, "without_cost": 1}]}])

    collection = AggregateCollection()
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        database=SimpleNamespace(db=SimpleNamespace(ingredients=collection)))))
    principal = Principal("user-a", "restaurant-a", ("manager",))

    result = main.list_ingredients(request, search=None, category="Secos", status="critical",
        supplier_id="supplier-a", sort="name", limit=51, offset=50,
        include_summary=True, principal=principal)

    assert result == {"items": [{"_id": "ingredient-a", "restaurant_id": "restaurant-a"}],
        "total": 3, "summary": {"known_stock_value_cents": 1500, "without_cost": 1}}
    match = collection.pipeline[0]["$match"]
    assert match["restaurant_id"] == "restaurant-a"
    assert match["category"] == "Secos"
    assert match["primary_supplier_id"] == "supplier-a"
    assert "$and" in match["$expr"]
    facet = collection.pipeline[-1]["$facet"]
    assert facet["items"][2] == {"$skip": 50}
    assert facet["items"][3] == {"$limit": 51}
    assert facet["summary"][0]["$group"]["total"] == {"$sum": 1}


def test_later_inventory_pages_sort_missing_cost_as_zero_value():
    from app import main

    class AggregateCollection:
        pipeline = None

        def aggregate(self, pipeline):
            self.pipeline = pipeline
            return iter([])

    collection = AggregateCollection()
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        database=SimpleNamespace(db=SimpleNamespace(ingredients=collection)))))
    principal = Principal("user-a", "restaurant-a", ("manager",))

    result = main.list_ingredients(request, search=None, category=None, status=None,
        sort="value_desc", limit=51, offset=50, include_summary=False, principal=principal)

    assert result == []
    assert collection.pipeline[1]["$addFields"]["_sort_value_cents"] == {
        "$multiply": [
            {"$divide": [
                {"$ifNull": ["$current_quantity_milli", {"$multiply": ["$current_quantity", 1000]}]},
                1000,
            ]},
            {"$ifNull": ["$cost_cents", 0]},
        ],
    }


def test_inventory_priority_filter_and_sort_are_server_side_and_tenant_scoped():
    from app import main

    class AggregateCollection:
        pipeline = None

        def aggregate(self, pipeline):
            self.pipeline = pipeline
            return iter([])

    collection = AggregateCollection()
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        database=SimpleNamespace(db=SimpleNamespace(ingredients=collection)))))
    principal = Principal("user-a", "restaurant-a", ("manager",))

    main.list_ingredients(request, low_stock=False, search=None, category=None,
        status="needs-attention", sort="priority", limit=51, offset=100, principal=principal)

    match = collection.pipeline[0]["$match"]
    assert match["restaurant_id"] == "restaurant-a"
    assert "$or" in match["$expr"]
    assert collection.pipeline[1]["$addFields"]["_sort_status"]["$switch"]
    assert collection.pipeline[2]["$sort"] == {
        "_sort_status": 1, "_sort_quantity_milli": 1, "name_normalized": 1, "_id": 1,
    }
    assert collection.pipeline[3] == {"$skip": 100}
    assert collection.pipeline[4] == {"$limit": 51}


def test_near_minimum_filter_uses_exact_milli_unit_threshold_and_tenant_scope():
    from app import main

    collection = FakeCollection([])
    database = SimpleNamespace(db=SimpleNamespace(ingredients=collection))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database=database)))
    principal = Principal("user-a", "restaurant-a", ("manager",))

    result = main.list_ingredients(request, low_stock=False, search=None, category=None,
        status="near_minimum", sort="name", limit=25, offset=0, principal=principal)

    quantity = {"$ifNull": ["$current_quantity_milli", {"$multiply": ["$current_quantity", 1000]}]}
    minimum = {"$ifNull": ["$min_quantity_milli", {"$multiply": ["$min_quantity", 1000]}]}
    assert result == []
    assert collection.query["restaurant_id"] == "restaurant-a"
    assert collection.query["$expr"] == {"$and": [
        {"$gt": [quantity, 0]},
        {"$gte": [quantity, minimum]},
        {"$lt": [{"$multiply": [quantity, 4]}, {"$multiply": [minimum, 5]}]},
    ]}


def test_active_ingredient_search_includes_legacy_records_and_is_tenant_scoped():
    from app import main

    class AggregateCollection:
        pipeline = None

        def aggregate(self, pipeline):
            self.pipeline = pipeline
            return iter([])

    collection = AggregateCollection()
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        database=SimpleNamespace(db=SimpleNamespace(ingredients=collection)))))
    principal = Principal("user-a", "restaurant-a", ("manager",))

    result = main.list_ingredients(request, low_stock=False, active_only=True, search="tomate",
        category=None, status=None, sort="name", limit=51, offset=0, principal=principal)

    assert result == []
    assert collection.pipeline[0]["$match"]["restaurant_id"] == "restaurant-a"
    assert collection.pipeline[0]["$match"]["active"] == {"$ne": False}


def test_count_candidate_filters_and_exclusions_are_server_side_and_tenant_scoped():
    from app import main

    class CandidateCollection:
        queries = []

        def find(self, query):
            self.queries.append(("find", query))
            return FakeCursor([{"_id": "ingredient-a", "restaurant_id": "restaurant-a",
                "name": "Tomate", "name_normalized": "tomate"}])

        def count_documents(self, query):
            self.queries.append(("count", query))
            return 4 if "_id" in query else 5

        def distinct(self, field, query):
            assert field == "category"
            assert query == {"restaurant_id": "restaurant-a"}
            return ["Hortifruti", "Carnes"]

    collection = CandidateCollection()
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        database=SimpleNamespace(db=SimpleNamespace(ingredients=collection)))))
    principal = Principal("user-a", "restaurant-a", ("manager",))

    result = main.get_count_candidates(request, scope="low", category=None, search="tomate",
        selection_mode="all", include_ids=[], exclude_ids=["ingredient-x"],
        limit=20, offset=0, principal=principal)

    base_query = collection.queries[0][1]
    selected_query = collection.queries[-1][1]
    assert base_query["restaurant_id"] == "restaurant-a"
    assert base_query["active"] == {"$ne": False}
    assert base_query["$expr"]["$lte"]
    assert base_query["$or"] == [
        {"name_normalized": {"$regex": "tomate"}},
        {"name": {"$regex": "tomate", "$options": "i"}},
    ]
    assert selected_query["_id"] == {"$nin": ["ingredient-x"]}
    assert result["total"] == 5
    assert result["selected_count"] == 4
    assert result["categories"] == ["Carnes", "Hortifruti"]


def test_count_candidate_custom_selection_uses_only_explicit_ids():
    from app import main

    class CandidateCollection:
        queries = []

        def find(self, query):
            self.queries.append(("find", query))
            return FakeCursor([])

        def count_documents(self, query):
            self.queries.append(("count", query))
            return 2 if query.get("_id", {}).get("$in") else 0

        def distinct(self, _field, _query):
            return []

    collection = CandidateCollection()
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(
        database=SimpleNamespace(db=SimpleNamespace(ingredients=collection)))))
    principal = Principal("user-a", "restaurant-a", ("manager",))

    main.get_count_candidates(request, scope="category", category="Carnes", search="",
        selection_mode="custom", include_ids=["ingredient-a", "ingredient-b"], exclude_ids=[],
        limit=20, offset=0, principal=principal)

    selected_query = collection.queries[-1][1]
    assert selected_query["restaurant_id"] == "restaurant-a"
    assert selected_query["category"] == "Carnes"
    assert selected_query["_id"] == {"$in": ["ingredient-a", "ingredient-b"]}


@pytest.mark.parametrize(("route_name", "collection_name", "identifier_name", "identifier_value"), [
    ("get_ingredient", "ingredients", "ingredient_id", "ingredient-from-another-tenant"),
    ("get_purchase", "purchases", "purchase_id", "purchase-from-another-tenant"),
])
def test_detail_endpoints_do_not_disclose_cross_tenant_records(
        route_name, collection_name, identifier_name, identifier_value):
    from app import main

    class MissingCollection:
        query = None

        def find_one(self, query):
            self.query = query
            return None

    collection = MissingCollection()
    database = SimpleNamespace(db=SimpleNamespace(**{collection_name: collection}))
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database=database)))
    principal = Principal("user-a", "restaurant-a", ("manager",))

    with pytest.raises(HTTPException) as error:
        getattr(main, route_name)(request=request, principal=principal,
                                  **{identifier_name: identifier_value})

    assert error.value.status_code == 404
    assert collection.query == {"_id": identifier_value, "restaurant_id": "restaurant-a"}


def test_recipe_history_filter_is_tenant_scoped_by_product_or_ingredient():
    from app import main

    class RecipeCollection(FakeCollection):
        def find(self, query, *_args):
            self.query = query
            self.cursor = FakeCursor([{"product_id": "recipe-a"}])
            return self.cursor

    recipes = RecipeCollection([])
    snapshots = FakeCollection([])
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database=SimpleNamespace(
        db=SimpleNamespace(recipes=recipes, recipe_snapshots=snapshots)))))
    principal = Principal("user-a", "restaurant-a", ("manager",))

    main.list_recipe_snapshots(request, limit=50, offset=0, product_id=None,
        ingredient_id="ingredient-a", principal=principal)
    assert recipes.query == {"restaurant_id": "restaurant-a", "lines.ingredient_id": "ingredient-a"}
    assert snapshots.query == {"restaurant_id": "restaurant-a", "product_id": {"$in": ["recipe-a"]}}

    main.list_recipe_snapshots(request, limit=50, offset=0, product_id="recipe-a",
        ingredient_id=None, principal=principal)
    assert snapshots.query == {"restaurant_id": "restaurant-a", "product_id": "recipe-a"}


def test_recipe_history_rejects_ambiguous_filter():
    from app import main

    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database=SimpleNamespace(db=None))))
    with pytest.raises(HTTPException) as error:
        main.list_recipe_snapshots(request, limit=50, offset=0, product_id="recipe-a",
            ingredient_id="ingredient-a", principal=Principal("u", "r", ("manager",)))
    assert error.value.status_code == 422
