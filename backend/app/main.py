from contextlib import asynccontextmanager
import base64
from datetime import datetime, timezone
import json
import re

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pymongo.errors import PyMongoError

from app.auth import (TAB_SESSION_HEADER, Principal, authenticated_principal, cookie_name,
                      create_local_session, decode_handoff, digest, hub_confirms_module_active,
                      issue_browser_binding, refresh_local_session, require_any_role,
                      valid_browser_binding, valid_tab_session_id)
from app.config import get_settings
from app.database import Database, MongoTransactionSupportError
from app.order_integration import (IntegrationActivation, IntegrationResolution, OrderSnapshotEvent,
                                   process_order_event, resolve_order_exception,
                                   verify_request_signature)
from app.schemas import (HandoffExchange, IngredientCreate, IngredientUpdate, MovementCreate,
                         PurchaseCreate, PurchaseDraftUpdate, PurchaseReceive, PurchaseReceiptReversal,
                         PurchaseStatusUpdate, RecipePut, SupplierCreate, SupplierUpdate, CountCreate,
                         CountSelection, CountLineUpdate, CountApproval, LossCreate, MovementReversal,
                         RecipeStatusUpdate, RecipeConsumptionUpdate)
from app.service import (append_movement, create_ingredient, create_purchase, receive_purchase, reverse_purchase_receipt,
                         create_supplier, set_purchase_status, upsert_recipe, update_ingredient,
                         update_supplier, create_count, set_count_line, approve_count, register_loss,
                         list_audit_entries, update_purchase_draft, list_purchase_receipts, reverse_manual_movement,
                         set_recipe_active, movement_insights, purchase_insights, inventory_insights,
                         operational_insights, replenishment_recommendations, price_rise_insights,
                         ingredient_price_history, count_selection_query, list_loss_month_page, get_loss, count_insights, get_count,
                         recipe_insights, get_recipe, global_search, set_recipe_consumption)

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.environment == "production" and not settings.hub_auth_configured:
        raise RuntimeError("DACOT-HUB authentication is not configured")
    database = Database(settings)
    app.state.database = database
    try:
        if settings.environment != "test":
            database.check_transaction_support()
            database.ensure_indexes()
        yield
    finally:
        database.close()


app = FastAPI(title="DACOT Estoque API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Idempotency-Key", TAB_SESSION_HEADER],
)


@app.middleware("http")
async def prevent_private_api_caching(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
    return response


def db_from(request: Request):
    return request.app.state.database.db


def require_allowed_origin(request: Request) -> None:
    """Reject cross-site cookie-authenticated writes (CORS alone is not CSRF protection)."""
    origin = request.headers.get("origin")
    if origin is None or origin not in settings.cors_origins:
        raise HTTPException(status_code=403, detail="Request origin is not authorized")


def writer_roles():
    return require_any_role("admin", "manager")


def admin_roles():
    def require_admin(principal: Principal = Depends(authenticated_principal)) -> Principal:
        if "admin" not in principal.roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return principal

    return require_admin


_PERSISTENCE_ONLY_FIELDS = {
    "idempotency_key", "request_fingerprint", "reversal_idempotency_key",
    "reversal_request_fingerprint", "create_key", "approval_key", "approval_request_fingerprint",
    "count_approval_revision",
}


def public_api_value(value):
    """Remove persistence-only retry metadata from API payloads without mutating stored docs."""
    if isinstance(value, list):
        return [public_api_value(entry) for entry in value]
    if not isinstance(value, dict):
        return value
    return {key: public_api_value(item) for key, item in value.items()
            if key not in _PERSISTENCE_ONLY_FIELDS}


def list_page(collection, query: dict, sort: list[tuple[str, int]], limit: int, offset: int):
    return public_api_value(list(collection.find(query).sort(sort).skip(offset).limit(limit)))


def purchase_stock_mutation_response(db, purchase: dict, receipt_id: str, restaurant_id: str,
                                     reversed_receipt: bool = False) -> dict:
    receipt = db.purchase_receipts.find_one({"_id": receipt_id, "restaurant_id": restaurant_id})
    if receipt is None:
        raise HTTPException(status_code=409, detail="Purchase receipt could not be reconciled")
    line_ids = [line["line_id"] for line in receipt.get("lines", [])]
    key_prefix = "reversal:" if reversed_receipt else ""
    movement_keys = [f"{key_prefix}{receipt_id}:{line_id}" for line_id in line_ids]
    movements = list(db.movements.find({"restaurant_id": restaurant_id,
                                        "idempotency_key": {"$in": movement_keys}})) if movement_keys else []
    reversal_of = [movement.get("reversal_of") for movement in movements if movement.get("reversal_of")]
    if reversal_of:
        originals = list(db.movements.find({"restaurant_id": restaurant_id, "_id": {"$in": reversal_of}}))
        movements.extend(originals)
    ingredient_ids = list({movement["ingredient_id"] for movement in movements})
    ingredients = list(db.ingredients.find({"restaurant_id": restaurant_id, "_id": {"$in": ingredient_ids}})) \
        if ingredient_ids else []
    occurred_at = receipt.get("reversed_at") if reversed_receipt else receipt.get("received_at")
    trigger = "Custo de insumo atualizado por estorno de recebimento" if reversed_receipt \
        else "Custo de insumo atualizado por recebimento"
    snapshots = list(db.recipe_snapshots.find({"restaurant_id": restaurant_id,
        "occurred_at": occurred_at, "trigger": trigger})) if occurred_at else []
    product_ids = list({snapshot["product_id"] for snapshot in snapshots})
    recipes = list(db.recipes.find({"restaurant_id": restaurant_id, "product_id": {"$in": product_ids}})) \
        if product_ids else []
    return {"purchase": purchase, "ingredients": ingredients, "movements": movements,
            "recipes": recipes, "recipe_snapshots": snapshots}


def encode_audit_cursor(entry: dict) -> str:
    payload = json.dumps({"at": entry["at"].isoformat(), "id": entry["id"]}, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


def decode_audit_cursor(value: str | None) -> tuple[datetime, str] | None:
    if value is None:
        return None
    if len(value) > 1000:
        raise HTTPException(status_code=422, detail="Invalid audit cursor")
    try:
        payload = json.loads(base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)))
        if not isinstance(payload, dict) or set(payload) != {"at", "id"}:
            raise ValueError
        timestamp = datetime.fromisoformat(payload["at"])
        if timestamp.tzinfo is None or not isinstance(payload["id"], str) or not payload["id"]:
            raise ValueError
        return timestamp, payload["id"]
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=422, detail="Invalid audit cursor") from exc


@app.post("/api/v1/auth/session/exchange", status_code=204)
def exchange_handoff(data: HandoffExchange, request: Request, response: Response,
                     tab_id: str = Header(alias=TAB_SESSION_HEADER)):
    require_allowed_origin(request)
    if not valid_tab_session_id(tab_id):
        raise HTTPException(status_code=422, detail="Valid tab session ID required")
    claims = decode_handoff(data.handoff, settings)
    hub_confirms_module_active(claims, settings)
    existing_binding = request.cookies.get(cookie_name(settings))
    binding = existing_binding if valid_browser_binding(existing_binding) else issue_browser_binding()
    try:
        create_local_session(db_from(request), binding=binding, tab_id=tab_id, claims=claims)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            raise HTTPException(status_code=401, detail="DACOT-HUB handoff has already been used") from exc
        raise
    production = settings.environment == "production"
    response.set_cookie(cookie_name(settings), binding, httponly=True, secure=production,
                        samesite="lax",
                        path="/", max_age=7 * 24 * 60 * 60)
    response.status_code = 204
    return response


@app.post("/api/v1/auth/refresh", status_code=204)
def refresh_auth_session(request: Request, response: Response,
                         tab_id: str = Header(alias=TAB_SESSION_HEADER)):
    require_allowed_origin(request)
    binding = request.cookies.get(cookie_name(settings))
    if not binding or not valid_tab_session_id(tab_id):
        raise HTTPException(status_code=401, detail="Authenticated DACOT session required")
    refresh_local_session(db_from(request), binding=binding, tab_id=tab_id, settings=settings)
    response.status_code = 204
    return response


@app.post("/api/v1/auth/logout", status_code=204)
def logout(request: Request, response: Response,
           tab_id: str = Header(alias=TAB_SESSION_HEADER)):
    require_allowed_origin(request)
    binding = request.cookies.get(cookie_name(settings))
    if binding and valid_tab_session_id(tab_id):
        db_from(request).auth_sessions.update_one(
            {"browser_binding_hash": digest(binding), "tab_session_id_hash": digest(tab_id), "revoked_at": None},
            {"$set": {"revoked_at": datetime.now(timezone.utc),
                      "revocation_reason": "logout"}},
        )
    production = settings.environment == "production"
    response.delete_cookie(cookie_name(settings), path="/", secure=production, httponly=True,
                           samesite="lax")
    response.status_code = 204
    return response


@app.get("/health")
def health(request: Request):
    try:
        request.app.state.database.client.admin.command("ping")
    except PyMongoError as exc:
        raise HTTPException(status_code=503, detail="Database unavailable") from exc
    try:
        request.app.state.database.check_transaction_support()
    except PyMongoError as exc:
        raise HTTPException(status_code=503, detail="Database transaction capability unavailable") from exc
    except MongoTransactionSupportError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if not settings.hub_auth_configured:
        raise HTTPException(status_code=503, detail="DACOT-HUB authentication is not configured")
    return {"status": "ok", "database": "ok", "transactions": "supported"}


@app.get("/api/v1/me")
def me(principal: Principal = Depends(authenticated_principal)):
    return {"user_id": principal.user_id, "restaurant_id": principal.restaurant_id,
            "restaurant_slug": principal.restaurant_slug, "role": principal.roles[0]}


@app.get("/api/v1/audit")
def audit(request: Request, limit: int = Query(default=100, ge=1, le=500),
          cursor: str | None = Query(default=None, max_length=1000),
          principal: Principal = Depends(authenticated_principal)):
    rows = list_audit_entries(db_from(request), principal, limit=limit + 1,
                              before=decode_audit_cursor(cursor))
    has_more = len(rows) > limit
    page = rows[:limit]
    return {"items": page, "has_more": has_more,
            "next_cursor": encode_audit_cursor(page[-1]) if has_more and page else None}


@app.get("/api/v1/ingredients")
def list_ingredients(request: Request, low_stock: bool = False,
                     active_only: bool = False,
                     supplier_id: str | None = None,
                     search: str | None = Query(default=None, min_length=1, max_length=80),
                     category: str | None = Query(default=None, min_length=1, max_length=80),
                     status: str | None = Query(default=None, pattern="^(normal|near_minimum|attention|critical|empty|needs-attention)$"),
                     sort: str = Query(default="name", pattern="^(name|quantity_asc|updated_desc|cost_desc|priority|value_desc)$"),
                     include_summary: bool = False,
                     limit: int = Query(default=500, ge=1, le=500), offset: int = Query(default=0, ge=0),
                     principal: Principal = Depends(authenticated_principal)):
    query = {"restaurant_id": principal.restaurant_id}
    if active_only:
        # Legacy ingredients without an `active` field are active by default.
        query["active"] = {"$ne": False}
    if supplier_id is not None:
        if not supplier_id.strip() or len(supplier_id) > 200:
            raise HTTPException(status_code=422, detail="Supplier ID must be non-empty and at most 200 characters")
        query["primary_supplier_id"] = supplier_id
    if search:
        term = search.strip().casefold()
        if not term:
            raise HTTPException(status_code=422, detail="Search cannot be blank")
        search_pattern = re.escape(term)
    if category:
        query["category"] = category.strip()
    quantity = {"$ifNull": ["$current_quantity_milli", {"$multiply": ["$current_quantity", 1000]}]}
    minimum = {"$ifNull": ["$min_quantity_milli", {"$multiply": ["$min_quantity", 1000]}]}
    stock_expressions = []
    if low_stock:
        stock_expressions.append({"$lte": [quantity, minimum]})
    if status:
        conditions = {
            "empty": {"$lte": [quantity, 0]},
            "normal": {"$and": [{"$gt": [quantity, 0]},
                                  {"$gte": [{"$multiply": [quantity, 4]}, {"$multiply": [minimum, 5]}]}]},
            "near_minimum": {"$and": [{"$gt": [quantity, 0]}, {"$gte": [quantity, minimum]},
                                        {"$lt": [{"$multiply": [quantity, 4]},
                                                 {"$multiply": [minimum, 5]}]}]},
            "attention": {"$and": [{"$gt": [quantity, 0]}, {"$lt": [quantity, minimum]},
                                     {"$gte": [{"$multiply": [quantity, 2]}, minimum]}]},
            "critical": {"$and": [{"$gt": [quantity, 0]},
                                   {"$lt": [{"$multiply": [quantity, 2]}, minimum]}]},
            "needs-attention": {"$or": [
                {"$lte": [quantity, 0]},
                {"$and": [{"$gt": [quantity, 0]},
                           {"$lt": [{"$multiply": [quantity, 2]}, minimum]}]},
                {"$and": [{"$gt": [quantity, 0]}, {"$lt": [quantity, minimum]},
                           {"$gte": [{"$multiply": [quantity, 2]}, minimum]}]},
                {"$and": [{"$gt": [quantity, 0]}, {"$gte": [quantity, minimum]},
                           {"$lt": [{"$multiply": [quantity, 4]},
                                    {"$multiply": [minimum, 5]}]}]},
            ]},
        }
        stock_expressions.append(conditions[status])
    if stock_expressions:
        query["$expr"] = stock_expressions[0] if len(stock_expressions) == 1 else {"$and": stock_expressions}
    sort_fields = {
        "name": [("name_normalized", 1), ("_id", 1)],
        "updated_desc": [("updated_at", -1), ("_id", 1)],
        "cost_desc": [("cost_cents", -1), ("_id", 1)],
    }
    search_stages = []
    if search:
        search_stages = [
            {"$lookup": {
                "from": "suppliers",
                "let": {"supplier_id": "$primary_supplier_id"},
                "pipeline": [{"$match": {"$expr": {"$and": [
                    {"$eq": ["$_id", "$$supplier_id"]},
                    {"$eq": ["$restaurant_id", principal.restaurant_id]},
                ]}}}, {"$project": {"name_normalized": 1}}],
                "as": "_search_supplier",
            }},
            {"$match": {"$or": [
                {"name_normalized": {"$regex": search_pattern}},
                {"category": {"$regex": search_pattern, "$options": "i"}},
                {"_search_supplier.name_normalized": {"$regex": search_pattern}},
            ]}},
        ]
    if include_summary:
        sort_quantity = {"$ifNull": ["$current_quantity_milli",
                                      {"$multiply": ["$current_quantity", 1000]}]}
        sort_minimum = {"$ifNull": ["$min_quantity_milli",
                                    {"$multiply": ["$min_quantity", 1000]}]}
        computed = {"_sort_quantity_milli": sort_quantity}
        sort_spec = dict(sort_fields.get(sort, [("_sort_quantity_milli", 1), ("_id", 1)]))
        if sort in {"quantity_asc", "priority", "value_desc"}:
            sort_spec = {"_sort_quantity_milli": 1, "_id": 1}
        if sort == "priority":
            computed["_sort_status"] = {"$switch": {
                "branches": [
                    {"case": {"$lte": [sort_quantity, 0]}, "then": 0},
                    {"case": {"$and": [{"$gt": [sort_quantity, 0]},
                                         {"$lt": [{"$multiply": [sort_quantity, 2]}, sort_minimum]}]}, "then": 1},
                    {"case": {"$and": [{"$gt": [sort_quantity, 0]},
                                         {"$lt": [sort_quantity, sort_minimum]}]}, "then": 2},
                    {"case": {"$and": [{"$gt": [sort_quantity, 0]},
                                         {"$gte": [sort_quantity, sort_minimum]},
                                         {"$lt": [{"$multiply": [sort_quantity, 4]},
                                                   {"$multiply": [sort_minimum, 5]}]}]}, "then": 3},
                ], "default": 4,
            }}
            sort_spec = {"_sort_status": 1, "_sort_quantity_milli": 1,
                         "name_normalized": 1, "_id": 1}
        elif sort == "value_desc":
            computed["_sort_value_cents"] = {"$multiply": [
                {"$divide": [sort_quantity, 1000]}, {"$ifNull": ["$cost_cents", 0]},
            ]}
            sort_spec = {"_sort_value_cents": -1, "_id": 1}
        cost_known = {"$ifNull": ["$cost_known", {"$gt": [{"$ifNull": ["$cost_cents", 0]}, 0]}]}
        value_cents = {"$floor": {"$add": [
            {"$divide": [{"$multiply": [sort_quantity, {"$ifNull": ["$cost_cents", 0]}]}, 1000]}, 0.5,
        ]}}
        summary_pipeline = [{"$group": {"_id": None,
            "total": {"$sum": 1},
            "known_stock_value_cents": {"$sum": {"$cond": [
                cost_known, value_cents, 0]}},
            "without_cost": {"$sum": {"$cond": [
                cost_known, 0, 1]}},
        }}]
        page_pipeline = [{"$addFields": computed}, {"$sort": sort_spec},
            {"$skip": offset}, {"$limit": limit},
            {"$project": {"_search_supplier": 0, "_sort_quantity_milli": 0,
                          "_sort_status": 0, "_sort_value_cents": 0}}]
        rows = list(db_from(request).ingredients.aggregate([
            {"$match": query}, *search_stages,
            {"$facet": {"items": page_pipeline, "summary": summary_pipeline}},
        ]))
        result = rows[0] if rows else {"items": [], "summary": []}
        summary = result["summary"][0] if result["summary"] else {
            "total": 0, "known_stock_value_cents": 0, "without_cost": 0,
        }
        return public_api_value({"items": result["items"], "total": summary["total"],
            "summary": {key: summary[key] for key in ("known_stock_value_cents", "without_cost")}})
    if search or sort in {"quantity_asc", "priority", "value_desc"}:
        pipeline = [{"$match": query}, *search_stages]
        sort_quantity = {"$ifNull": ["$current_quantity_milli",
                                      {"$multiply": ["$current_quantity", 1000]}]}
        sort_minimum = {"$ifNull": ["$min_quantity_milli",
                                    {"$multiply": ["$min_quantity", 1000]}]}
        computed = {"_sort_quantity_milli": sort_quantity}
        sort_spec = {"_sort_quantity_milli": 1, "_id": 1}
        if sort in {"priority", "value_desc"}:
            if sort == "priority":
                computed["_sort_status"] = {"$switch": {
                    "branches": [
                        {"case": {"$lte": [sort_quantity, 0]}, "then": 0},
                        {"case": {"$and": [{"$gt": [sort_quantity, 0]},
                                             {"$lt": [{"$multiply": [sort_quantity, 2]}, sort_minimum]}]}, "then": 1},
                        {"case": {"$and": [{"$gt": [sort_quantity, 0]},
                                             {"$lt": [sort_quantity, sort_minimum]}]}, "then": 2},
                        {"case": {"$and": [{"$gt": [sort_quantity, 0]},
                                             {"$gte": [sort_quantity, sort_minimum]},
                                             {"$lt": [{"$multiply": [sort_quantity, 4]},
                                                       {"$multiply": [sort_minimum, 5]}]}]}, "then": 3},
                    ], "default": 4,
                }}
                sort_spec = {"_sort_status": 1, "_sort_quantity_milli": 1,
                             "name_normalized": 1, "_id": 1}
            else:
                computed["_sort_value_cents"] = {"$multiply": [
                    {"$divide": [sort_quantity, 1000]}, {"$ifNull": ["$cost_cents", 0]},
                ]}
                sort_spec = {"_sort_value_cents": -1, "_id": 1}
        pipeline.extend([
            {"$addFields": computed},
            {"$sort": sort_spec},
            {"$skip": offset},
            {"$limit": limit},
            {"$project": {"_search_supplier": 0, "_sort_quantity_milli": 0,
                           "_sort_status": 0, "_sort_value_cents": 0}},
        ])
        return public_api_value(list(db_from(request).ingredients.aggregate(pipeline)))
    return list_page(db_from(request).ingredients, query, sort_fields[sort], limit, offset)


@app.get("/api/v1/inventory-insights")
def get_inventory_insights(request: Request,
                           principal: Principal = Depends(authenticated_principal)):
    return inventory_insights(db_from(request), principal)


@app.get("/api/v1/suppliers")
def list_suppliers(request: Request, include_inactive: bool = False,
                   search: str | None = Query(default=None, max_length=100),
                   limit: int = Query(default=500, ge=1, le=500), offset: int = Query(default=0, ge=0),
                   principal: Principal = Depends(authenticated_principal)):
    query = {"restaurant_id": principal.restaurant_id}
    if not include_inactive:
        query["active"] = True
    if search and search.strip():
        query["name_normalized"] = {"$regex": f"^{re.escape(search.strip().casefold())}"}
    return list_page(db_from(request).suppliers, query, [("name", 1), ("_id", 1)], limit, offset)


@app.get("/api/v1/suppliers/by-ids")
def get_suppliers_by_ids(request: Request, ids: list[str] = Query(default=[], max_length=100),
                         principal: Principal = Depends(authenticated_principal)):
    if not ids:
        return []
    if any(not supplier_id.strip() or len(supplier_id) > 200 for supplier_id in ids):
        raise HTTPException(status_code=422, detail="Supplier IDs must be non-empty and at most 200 characters")
    return public_api_value(list(db_from(request).suppliers.find({
        "restaurant_id": principal.restaurant_id, "_id": {"$in": list(dict.fromkeys(ids))},
    }).sort([("name", 1), ("_id", 1)])))


@app.get("/api/v1/suppliers/{supplier_id}")
def get_supplier(supplier_id: str, request: Request,
                 principal: Principal = Depends(authenticated_principal)):
    supplier = db_from(request).suppliers.find_one({
        "_id": supplier_id, "restaurant_id": principal.restaurant_id,
    })
    if supplier is None:
        raise HTTPException(status_code=404, detail="Supplier not found")
    return public_api_value(supplier)


@app.post("/api/v1/suppliers", status_code=201)
def post_supplier(data: SupplierCreate, request: Request,
                  idempotency_key: str = Header(alias="Idempotency-Key"),
                  principal: Principal = Depends(admin_roles())):
    require_allowed_origin(request)
    return public_api_value(create_supplier(db_from(request), data, principal, idempotency_key))


@app.patch("/api/v1/suppliers/{supplier_id}")
def patch_supplier(supplier_id: str, data: SupplierUpdate, request: Request,
                   principal: Principal = Depends(admin_roles())):
    require_allowed_origin(request)
    return public_api_value(update_supplier(db_from(request), supplier_id, data, principal))


@app.get("/api/v1/ingredients/count-candidates")
def get_count_candidates(request: Request,
                         scope: str = Query(default="all", pattern="^(all|low|category)$"),
                         category: str | None = Query(default=None, min_length=1, max_length=80),
                         search: str | None = Query(default=None, max_length=80),
                         selection_mode: str = Query(default="all", pattern="^(all|custom)$"),
                         include_ids: list[str] = Query(default=[], max_length=500),
                         exclude_ids: list[str] = Query(default=[], max_length=500),
                         limit: int = Query(default=50, ge=1, le=100),
                         offset: int = Query(default=0, ge=0),
                         principal: Principal = Depends(authenticated_principal)):
    if scope == "category" and not category:
        raise HTTPException(status_code=422, detail="Category is required for category-scoped counts")
    if scope != "category" and category is not None:
        raise HTTPException(status_code=422, detail="Category is only valid for category-scoped counts")
    if selection_mode == "all" and include_ids:
        raise HTTPException(status_code=422, detail="include_ids require custom selection mode")
    if selection_mode == "custom" and exclude_ids:
        raise HTTPException(status_code=422, detail="exclude_ids cannot be used with custom selection mode")
    selection_ids = include_ids if selection_mode == "custom" else exclude_ids
    if len(selection_ids) != len(set(selection_ids)):
        raise HTTPException(status_code=422, detail="Selection cannot repeat ingredient IDs")
    if any(not ingredient_id.strip() or len(ingredient_id) > 200 for ingredient_id in selection_ids):
        raise HTTPException(status_code=422, detail="Selection ingredient IDs must be non-empty and at most 200 characters")
    base_selection = CountSelection(scope=scope, category=category, search=search)
    selected_selection = CountSelection(scope=scope, category=category, search=search,
        include_ids=include_ids if selection_mode == "custom" else None,
        exclude_ids=exclude_ids if selection_mode == "all" else [])
    db = db_from(request)
    base_query = count_selection_query(base_selection, principal)
    selected_query = count_selection_query(selected_selection, principal)
    items = list(db.ingredients.find(base_query)
        .sort([("name_normalized", 1), ("_id", 1)]).skip(offset).limit(limit))
    categories = sorted(category for category in db.ingredients.distinct(
        "category", {"restaurant_id": principal.restaurant_id}) if isinstance(category, str) and category)
    return public_api_value({"items": items, "total": db.ingredients.count_documents(base_query),
        "selected_count": db.ingredients.count_documents(selected_query), "categories": categories})


@app.get("/api/v1/ingredients/by-ids")
def get_ingredients_by_ids(request: Request, ids: list[str] = Query(default=[], max_length=100),
                          principal: Principal = Depends(authenticated_principal)):
    if not ids:
        return []
    if any(not ingredient_id.strip() or len(ingredient_id) > 200 for ingredient_id in ids):
        raise HTTPException(status_code=422, detail="Ingredient IDs must be non-empty and at most 200 characters")
    return public_api_value(list(db_from(request).ingredients.find({
        "restaurant_id": principal.restaurant_id, "_id": {"$in": list(dict.fromkeys(ids))},
    }).sort([("name", 1), ("_id", 1)])))


@app.get("/api/v1/ingredients/{ingredient_id}")
def get_ingredient(ingredient_id: str, request: Request,
                   principal: Principal = Depends(authenticated_principal)):
    ingredient = db_from(request).ingredients.find_one(
        {"_id": ingredient_id, "restaurant_id": principal.restaurant_id}
    )
    if ingredient is None:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    return public_api_value(ingredient)


@app.post("/api/v1/ingredients", status_code=201)
def post_ingredient(data: IngredientCreate, request: Request,
                    idempotency_key: str = Header(alias="Idempotency-Key"),
                    principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    return public_api_value(create_ingredient(db_from(request), data, principal, idempotency_key))


@app.patch("/api/v1/ingredients/{ingredient_id}")
def patch_ingredient(ingredient_id: str, data: IngredientUpdate, request: Request,
                     principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    return public_api_value(update_ingredient(db_from(request), ingredient_id, data, principal))


@app.post("/api/v1/ingredients/{ingredient_id}/movements", status_code=201)
def post_movement(ingredient_id: str, data: MovementCreate, request: Request,
                  idempotency_key: str = Header(alias="Idempotency-Key"),
                  principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    if data.kind in {"adjustment_in", "adjustment_out"} and data.expected_balance is None:
        raise HTTPException(status_code=422,
            detail="expected_balance is required for manual stock adjustments")
    return public_api_value(append_movement(db_from(request), ingredient_id, data, principal, idempotency_key))


@app.get("/api/v1/purchases")
def list_purchases(request: Request, status: str | None = Query(default=None,
                       pattern="^(draft|requested|partial|received|cancelled)$"),
                   supplier_id: str | None = Query(default=None, min_length=1, max_length=200),
                   limit: int = Query(default=500, ge=1, le=500),
                   offset: int = Query(default=0, ge=0),
                   principal: Principal = Depends(authenticated_principal)):
    query = {"restaurant_id": principal.restaurant_id}
    if status is not None:
        query["status"] = status
    if supplier_id is not None:
        query["supplier_id"] = supplier_id
    return list_page(db_from(request).purchases, query,
                     [("created_at", -1), ("_id", -1)], limit, offset)


@app.post("/api/v1/purchases", status_code=201)
def post_purchase(data: PurchaseCreate, request: Request,
                  idempotency_key: str = Header(alias="Idempotency-Key"),
                  principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    return public_api_value(create_purchase(db_from(request), data, principal, idempotency_key))


@app.get("/api/v1/purchases/{purchase_id}")
def get_purchase(purchase_id: str, request: Request,
                 principal: Principal = Depends(authenticated_principal)):
    purchase = db_from(request).purchases.find_one(
        {"_id": purchase_id, "restaurant_id": principal.restaurant_id}
    )
    if purchase is None:
        raise HTTPException(status_code=404, detail="Purchase not found")
    return public_api_value(purchase)


@app.put("/api/v1/purchases/{purchase_id}")
def put_purchase_draft(purchase_id: str, data: PurchaseDraftUpdate, request: Request,
                       principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    return public_api_value(update_purchase_draft(db_from(request), purchase_id, data, principal))


@app.post("/api/v1/purchases/{purchase_id}/receipts", status_code=201)
def post_purchase_receipt(purchase_id: str, data: PurchaseReceive, request: Request,
                          idempotency_key: str = Header(alias="Idempotency-Key"),
                          principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    db = db_from(request)
    purchase = receive_purchase(db, purchase_id, data, principal, idempotency_key)
    receipt = db.purchase_receipts.find_one({"restaurant_id": principal.restaurant_id,
                                             "idempotency_key": idempotency_key})
    if receipt is None:
        raise HTTPException(status_code=409, detail="Purchase receipt could not be reconciled")
    return public_api_value(purchase_stock_mutation_response(
        db, purchase, receipt["_id"], principal.restaurant_id))


@app.post("/api/v1/purchases/{purchase_id}/receipts/{receipt_id}/reversal")
def post_purchase_receipt_reversal(purchase_id: str, receipt_id: str, data: PurchaseReceiptReversal,
                                   request: Request,
                                   idempotency_key: str = Header(alias="Idempotency-Key"),
                                   principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    db = db_from(request)
    purchase = reverse_purchase_receipt(db, purchase_id, receipt_id, data, principal, idempotency_key)
    return public_api_value(purchase_stock_mutation_response(
        db, purchase, receipt_id, principal.restaurant_id, reversed_receipt=True))


@app.get("/api/v1/purchases/{purchase_id}/receipts")
def get_purchase_receipts(purchase_id: str, request: Request,
                          principal: Principal = Depends(authenticated_principal)):
    return public_api_value(list_purchase_receipts(db_from(request), purchase_id, principal))


@app.get("/api/v1/ingredients/{ingredient_id}/movements")
def list_movements(ingredient_id: str, request: Request,
                   limit: int = Query(default=500, ge=1, le=500), offset: int = Query(default=0, ge=0),
                   principal: Principal = Depends(authenticated_principal)):
    db = db_from(request)
    if db.ingredients.find_one({"_id": ingredient_id, "restaurant_id": principal.restaurant_id}) is None:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    return list_page(db.movements, {"ingredient_id": ingredient_id, "restaurant_id": principal.restaurant_id},
                     [("occurred_at", -1), ("_id", -1)], limit, offset)


@app.get("/api/v1/ingredients/{ingredient_id}/price-history")
def get_ingredient_price_history(ingredient_id: str, request: Request,
                                 principal: Principal = Depends(authenticated_principal)):
    return public_api_value(ingredient_price_history(db_from(request), principal, ingredient_id))


@app.get("/api/v1/movements")
def list_all_movements(request: Request, limit: int = Query(default=500, ge=1, le=500),
                       offset: int = Query(default=0, ge=0),
                       principal: Principal = Depends(authenticated_principal)):
    return list_page(db_from(request).movements, {"restaurant_id": principal.restaurant_id},
                     [("occurred_at", -1), ("_id", -1)], limit, offset)


@app.get("/api/v1/movement-insights")
def get_movement_insights(request: Request,
                          principal: Principal = Depends(authenticated_principal)):
    return public_api_value(movement_insights(db_from(request), principal))


@app.get("/api/v1/purchase-insights")
def get_purchase_insights(request: Request,
                          principal: Principal = Depends(authenticated_principal)):
    return public_api_value(purchase_insights(db_from(request), principal))


@app.get("/api/v1/operational-insights")
def get_operational_insights(request: Request,
                             principal: Principal = Depends(authenticated_principal)):
    return operational_insights(db_from(request), principal)


@app.get("/api/v1/replenishment-recommendations")
def get_replenishment_recommendations(request: Request, limit: int = Query(default=5, ge=1, le=20),
                                      principal: Principal = Depends(authenticated_principal)):
    result = replenishment_recommendations(db_from(request), principal, limit)
    return public_api_value(result)


@app.get("/api/v1/price-rise-insights")
def get_price_rise_insights(request: Request,
                            principal: Principal = Depends(authenticated_principal)):
    return public_api_value(price_rise_insights(db_from(request), principal))


@app.post("/api/v1/movements/{movement_id}/reversal", status_code=201)
def post_movement_reversal(movement_id: str, data: MovementReversal, request: Request,
                           idempotency_key: str = Header(alias="Idempotency-Key"),
                           principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    return public_api_value(reverse_manual_movement(db_from(request), movement_id, data, principal, idempotency_key))


@app.get("/api/v1/counts")
def list_counts(request: Request, limit: int = Query(default=500, ge=1, le=500),
                 offset: int = Query(default=0, ge=0),
                 principal: Principal = Depends(authenticated_principal)):
    return list_page(db_from(request).counts, {"restaurant_id": principal.restaurant_id},
                     [("created_at", -1), ("_id", -1)], limit, offset)


@app.get("/api/v1/count-insights")
def get_count_insights(request: Request,
                       principal: Principal = Depends(authenticated_principal)):
    return public_api_value(count_insights(db_from(request), principal))


@app.get("/api/v1/counts/{count_id}")
def get_count_by_id(count_id: str, request: Request,
                    principal: Principal = Depends(authenticated_principal)):
    return public_api_value(get_count(db_from(request), principal, count_id))


@app.post("/api/v1/counts", status_code=201)
def post_count(data: CountCreate, request: Request,
               idempotency_key: str = Header(alias="Idempotency-Key"),
               principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    return public_api_value(create_count(db_from(request), data, principal, idempotency_key))


@app.patch("/api/v1/counts/{count_id}/lines/{ingredient_id}")
def patch_count_line(count_id: str, ingredient_id: str, data: CountLineUpdate, request: Request,
                     principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    return public_api_value(set_count_line(db_from(request), count_id, ingredient_id, data, principal))


@app.post("/api/v1/counts/{count_id}/approve")
def post_count_approval(count_id: str, data: CountApproval, request: Request,
                        idempotency_key: str = Header(alias="Idempotency-Key"),
                        principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    db = db_from(request)
    approved = approve_count(db, count_id, principal, idempotency_key, data.expected_version)
    movements = list(db.movements.find({"restaurant_id": principal.restaurant_id,
                                        "purchase_reference": count_id})
                     .sort([("occurred_at", 1), ("_id", 1)]))
    return public_api_value({**approved, "movements": movements})


@app.get("/api/v1/losses")
def list_losses(request: Request, limit: int = Query(default=500, ge=1, le=500),
                 offset: int = Query(default=0, ge=0),
                 principal: Principal = Depends(authenticated_principal)):
    return list_page(db_from(request).losses, {"restaurant_id": principal.restaurant_id},
                     [("occurred_at", -1), ("_id", -1)], limit, offset)


@app.get("/api/v1/losses/month")
def get_month_losses(request: Request, limit: int = Query(default=50, ge=1, le=200),
                     offset: int = Query(default=0, ge=0), reason: str | None = Query(default=None),
                     principal: Principal = Depends(authenticated_principal)):
    if reason is not None and reason not in {"Vencimento", "Preparo errado", "Sobra", "Quebra",
                                               "Erro operacional", "Qualidade", "Outros"}:
        raise HTTPException(status_code=422, detail="Invalid loss reason")
    return public_api_value(list_loss_month_page(db_from(request), principal,
        limit=limit, offset=offset, reason=reason))


@app.get("/api/v1/losses/{loss_id}")
def get_loss_by_id(loss_id: str, request: Request,
                   principal: Principal = Depends(authenticated_principal)):
    return public_api_value(get_loss(db_from(request), principal, loss_id))


@app.post("/api/v1/losses", status_code=201)
def post_loss(data: LossCreate, request: Request,
              idempotency_key: str = Header(alias="Idempotency-Key"),
              principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    db = db_from(request)
    loss = register_loss(db, data, principal, idempotency_key)
    movement = db.movements.find_one({"_id": loss.get("movement_id"),
                                      "restaurant_id": principal.restaurant_id})
    return public_api_value({**loss, "movement": movement})


@app.post("/api/v1/purchases/{purchase_id}/request")
def request_purchase(purchase_id: str, data: PurchaseStatusUpdate, request: Request,
                     principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    return public_api_value(set_purchase_status(db_from(request), purchase_id, "requested", principal,
                                                data.expected_version))


@app.post("/api/v1/purchases/{purchase_id}/cancel")
def cancel_purchase(purchase_id: str, data: PurchaseStatusUpdate, request: Request,
                    principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    return public_api_value(set_purchase_status(db_from(request), purchase_id, "cancelled", principal,
                                                data.expected_version))


@app.put("/api/v1/recipes/{product_id}")
def put_recipe(product_id: str, data: RecipePut, request: Request,
               principal: Principal = Depends(admin_roles())):
    require_allowed_origin(request)
    if data.product_id != product_id:
        raise HTTPException(status_code=422, detail="Product identifier mismatch")
    return upsert_recipe(db_from(request), data, principal)


@app.patch("/api/v1/recipes/{product_id}/status")
def patch_recipe_status(product_id: str, data: RecipeStatusUpdate, request: Request,
                        principal: Principal = Depends(admin_roles())):
    require_allowed_origin(request)
    return set_recipe_active(db_from(request), product_id, data.active,
                             data.expected_version, principal)


@app.patch("/api/v1/recipes/{product_id}/consumption")
def patch_recipe_consumption(product_id: str, data: RecipeConsumptionUpdate, request: Request,
                             principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    return public_api_value(set_recipe_consumption(db_from(request), product_id, data, principal))


@app.get("/api/v1/recipes")
def list_recipes(request: Request, limit: int = Query(default=500, ge=1, le=500),
                 offset: int = Query(default=0, ge=0), ingredient_id: str | None = Query(default=None, min_length=1, max_length=200),
                 principal: Principal = Depends(authenticated_principal)):
    query = {"restaurant_id": principal.restaurant_id}
    if ingredient_id:
        query["lines.ingredient_id"] = ingredient_id
    return list_page(db_from(request).recipes, query,
                     [("product_name", 1), ("_id", 1)], limit, offset)


@app.get("/api/v1/recipe-insights")
def get_recipe_insights(request: Request,
                        principal: Principal = Depends(authenticated_principal)):
    require_allowed_origin(request)
    return public_api_value(recipe_insights(db_from(request), principal))


@app.get("/api/v1/search")
def search_records(request: Request, q: str = Query(min_length=2, max_length=100),
                   principal: Principal = Depends(authenticated_principal)):
    return public_api_value(global_search(db_from(request), principal, q))


@app.get("/api/v1/recipes/snapshots")
def list_recipe_snapshots(request: Request, limit: int = Query(default=500, ge=1, le=500),
                          offset: int = Query(default=0, ge=0),
                          product_id: str | None = Query(default=None, min_length=1, max_length=200),
                          ingredient_id: str | None = Query(default=None, min_length=1, max_length=200),
                          principal: Principal = Depends(authenticated_principal)):
    if product_id and ingredient_id:
        raise HTTPException(status_code=422, detail="Use product_id or ingredient_id, not both")
    db = db_from(request)
    query = {"restaurant_id": principal.restaurant_id}
    if product_id:
        query["product_id"] = product_id
    elif ingredient_id:
        product_ids = [recipe["product_id"] for recipe in db.recipes.find(
            {"restaurant_id": principal.restaurant_id, "lines.ingredient_id": ingredient_id},
            {"product_id": 1})]
        query["product_id"] = {"$in": product_ids}
    return list_page(db.recipe_snapshots, query,
                     [("occurred_at", -1), ("_id", -1)], limit, offset)


@app.get("/api/v1/recipes/{product_id}")
def get_recipe_by_id(product_id: str, request: Request,
                     principal: Principal = Depends(authenticated_principal)):
    require_allowed_origin(request)
    return public_api_value(get_recipe(db_from(request), principal, product_id))


@app.post("/api/v1/integrations/orders/events")
async def receive_order_integration_event(request: Request,
                                         x_dacot_source: str | None = Header(default=None),
                                         x_dacot_timestamp: str | None = Header(default=None),
                                         x_dacot_signature: str | None = Header(default=None)):
    if x_dacot_source != "dacot-pedidos":
        raise HTTPException(status_code=401, detail="Unauthorized integration source")
    body = await request.body()
    if len(body) > 262144:
        raise HTTPException(status_code=413, detail="Integration event is too large")
    verify_request_signature(settings.orders_integration_secret, x_dacot_timestamp,
                             x_dacot_signature, body, settings.orders_integration_previous_secret)
    try:
        event = OrderSnapshotEvent.model_validate_json(body)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Invalid order integration event") from exc
    return public_api_value(process_order_event(db_from(request), event))


@app.get("/api/v1/integrations/orders")
def get_orders_integration(request: Request,
                           principal: Principal = Depends(authenticated_principal)):
    db = db_from(request)
    activation = db.order_integrations.find_one({"restaurant_id": principal.restaurant_id})
    events = list(db.order_integration_events.find(
        {"restaurant_id": principal.restaurant_id}, {"_id": 0, "fingerprint": 0, "event": 0}
    ).sort("processed_at", -1).limit(50))
    exceptions = list(db.order_integration_exceptions.find(
        {"restaurant_id": principal.restaurant_id, "status": {"$in": ["blocked", "needs_action"]}},
        {"_id": 0, "fingerprint": 0}
    ).sort("processed_at", -1).limit(50))
    return public_api_value({"active": bool(activation and activation.get("active")),
        "enabled_at": activation.get("enabled_at") if activation else None,
        "processed_count": db.order_integration_events.count_documents(
            {"restaurant_id": principal.restaurant_id, "status": "processed"}),
        "pending_count": db.order_integration_events.count_documents(
            {"restaurant_id": principal.restaurant_id, "status": {"$in": ["blocked", "needs_action"]}}),
        "events": events, "exceptions": exceptions})


@app.get("/api/v1/integrations/orders/catalog")
def get_orders_integration_catalog(request: Request,
                                  principal: Principal = Depends(authenticated_principal)):
    db = db_from(request)
    rows = list(db.order_integration_events.aggregate([
        {"$match": {"restaurant_id": principal.restaurant_id}},
        {"$sort": {"processed_at": -1}},
        {"$unwind": "$event.items"},
        {"$group": {"_id": "$event.items.product_id",
                     "product_name": {"$first": "$event.items.product_name"},
                     "last_seen": {"$first": "$processed_at"}}},
        {"$sort": {"product_name": 1, "_id": 1}},
        {"$limit": 500},
    ]))
    product_ids = [row["_id"] for row in rows]
    recipes = {recipe["product_id"]: recipe for recipe in db.recipes.find(
        {"restaurant_id": principal.restaurant_id, "product_id": {"$in": product_ids}},
        {"_id": 0, "product_id": 1, "active": 1, "consumption_enabled": 1,
         "version": 1, "product_name": 1},
    )} if product_ids else {}
    return [{"product_id": row["_id"], "product_name": row.get("product_name") or row["_id"],
             "last_seen": row.get("last_seen"),
             "recipe_exists": row["_id"] in recipes,
        "recipe_active": bool(recipes.get(row["_id"], {}).get("active", True))
                if row["_id"] in recipes else False,
             "consumption_enabled": bool(recipes.get(row["_id"], {}).get("consumption_enabled", False)),
             "recipe_version": int(recipes[row["_id"]].get("version", 1))
                if row["_id"] in recipes else None}
            for row in rows]


@app.put("/api/v1/integrations/orders/activation")
def set_orders_integration_activation(data: IntegrationActivation, request: Request,
                                      principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    db = db_from(request)
    current = db.order_integrations.find_one({"restaurant_id": principal.restaurant_id})
    timestamp = datetime.now(timezone.utc)
    updates = {"active": data.active, "updated_at": timestamp, "updated_by": principal.user_id}
    if data.active and not (current and current.get("active")):
        updates["enabled_at"] = timestamp
    db.order_integrations.update_one({"restaurant_id": principal.restaurant_id},
        {"$set": updates, "$setOnInsert": {"restaurant_id": principal.restaurant_id}}, upsert=True)
    return {"active": data.active, "enabled_at": updates.get("enabled_at",
        current.get("enabled_at") if current else None)}


@app.post("/api/v1/integrations/orders/events/{event_id}/retry")
def retry_order_integration_event(event_id: str, request: Request,
                                  principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    db = db_from(request)
    stored = db.order_integration_events.find_one({"restaurant_id": principal.restaurant_id,
                                                    "event_id": event_id})
    if stored is None:
        raise HTTPException(status_code=404, detail="Integration event not found")
    try:
        event = OrderSnapshotEvent.model_validate(stored["event"])
    except ValueError as exc:
        raise HTTPException(status_code=409, detail="Stored integration event is invalid") from exc
    return public_api_value(process_order_event(db, event, retry=True))


@app.post("/api/v1/integrations/orders/exceptions/{event_id}/resolve")
def resolve_order_integration_exception(event_id: str, data: IntegrationResolution, request: Request,
                                        principal: Principal = Depends(writer_roles())):
    require_allowed_origin(request)
    return public_api_value(resolve_order_exception(db_from(request), principal.restaurant_id,
        event_id, principal.user_id, data.reason))
