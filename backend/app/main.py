from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from pymongo.errors import PyMongoError

from app.auth import (TAB_SESSION_HEADER, Principal, authenticated_principal, cookie_name,
                      create_local_session, decode_handoff, digest, hub_confirms_module_active,
                      issue_browser_binding, refresh_local_session, require_any_role, valid_tab_session_id)
from app.config import get_settings
from app.database import Database
from app.schemas import (HandoffExchange, IngredientCreate, IngredientUpdate, MovementCreate,
                         PurchaseCreate, PurchaseReceive, RecipePut, SupplierCreate)
from app.service import (append_movement, create_ingredient, create_purchase, receive_purchase,
                         create_supplier, set_purchase_status, upsert_recipe, update_ingredient)

settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    database = Database(settings)
    app.state.database = database
    if settings.environment != "test":
        database.ensure_indexes()
    yield
    database.close()


app = FastAPI(title="DACOT Estoque API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Idempotency-Key", TAB_SESSION_HEADER],
)


def db_from(request: Request):
    return request.app.state.database.db


def writer_roles():
    return require_any_role("admin", "manager")


@app.post("/api/v1/auth/session/exchange", status_code=204)
def exchange_handoff(data: HandoffExchange, request: Request, response: Response,
                     tab_id: str = Header(alias=TAB_SESSION_HEADER)):
    if not valid_tab_session_id(tab_id):
        raise HTTPException(status_code=422, detail="Valid tab session ID required")
    claims = decode_handoff(data.handoff, settings)
    hub_confirms_module_active(claims, settings)
    binding = issue_browser_binding()
    try:
        create_local_session(db_from(request), binding=binding, tab_id=tab_id, claims=claims)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            raise HTTPException(status_code=401, detail="DACOT-HUB handoff has already been used") from exc
        raise
    production = settings.environment == "production"
    response.set_cookie(cookie_name(settings), binding, httponly=True, secure=production,
                        samesite="none" if production else "lax",
                        path="/", max_age=7 * 24 * 60 * 60)
    response.status_code = 204
    return response


@app.post("/api/v1/auth/refresh", status_code=204)
def refresh_auth_session(request: Request, response: Response,
                         tab_id: str = Header(alias=TAB_SESSION_HEADER)):
    binding = request.cookies.get(cookie_name(settings))
    if not binding or not valid_tab_session_id(tab_id):
        raise HTTPException(status_code=401, detail="Authenticated DACOT session required")
    refresh_local_session(db_from(request), binding=binding, tab_id=tab_id, settings=settings)
    response.status_code = 204
    return response


@app.post("/api/v1/auth/logout", status_code=204)
def logout(request: Request, response: Response,
           tab_id: str = Header(alias=TAB_SESSION_HEADER)):
    binding = request.cookies.get(cookie_name(settings))
    if binding and valid_tab_session_id(tab_id):
        db_from(request).auth_sessions.update_one(
            {"browser_binding_hash": digest(binding), "tab_session_id_hash": digest(tab_id), "revoked_at": None},
            {"$set": {"revoked_at": datetime.now(timezone.utc),
                      "revocation_reason": "logout"}},
        )
    production = settings.environment == "production"
    response.delete_cookie(cookie_name(settings), path="/", secure=production, httponly=True,
                           samesite="none" if production else "lax")
    response.status_code = 204
    return response


@app.get("/health")
def health(request: Request):
    try:
        request.app.state.database.client.admin.command("ping")
    except PyMongoError as exc:
        raise HTTPException(status_code=503, detail="Database unavailable") from exc
    if not settings.hub_auth_configured:
        raise HTTPException(status_code=503, detail="DACOT-HUB authentication is not configured")
    return {"status": "ok", "database": "ok"}


@app.get("/api/v1/me")
def me(principal: Principal = Depends(authenticated_principal)):
    return {"user_id": principal.user_id, "restaurant_id": principal.restaurant_id,
            "restaurant_slug": principal.restaurant_slug, "role": principal.roles[0]}


@app.get("/api/v1/ingredients")
def list_ingredients(request: Request, low_stock: bool = False,
                     principal: Principal = Depends(authenticated_principal)):
    query = {"restaurant_id": principal.restaurant_id}
    if low_stock:
        query["$expr"] = {"$lte": ["$current_quantity", "$min_quantity"]}
    return list(db_from(request).ingredients.find(query).sort("name", 1))


@app.get("/api/v1/suppliers")
def list_suppliers(request: Request, principal: Principal = Depends(authenticated_principal)):
    return list(db_from(request).suppliers.find({"restaurant_id": principal.restaurant_id,
                                                 "active": True}).sort("name", 1))


@app.post("/api/v1/suppliers", status_code=201)
def post_supplier(data: SupplierCreate, request: Request,
                  principal: Principal = Depends(writer_roles())):
    return create_supplier(db_from(request), data, principal)


@app.get("/api/v1/ingredients/{ingredient_id}")
def get_ingredient(ingredient_id: str, request: Request,
                   principal: Principal = Depends(authenticated_principal)):
    ingredient = db_from(request).ingredients.find_one(
        {"_id": ingredient_id, "restaurant_id": principal.restaurant_id}
    )
    if ingredient is None:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    return ingredient


@app.post("/api/v1/ingredients", status_code=201)
def post_ingredient(data: IngredientCreate, request: Request,
                    principal: Principal = Depends(writer_roles())):
    return create_ingredient(db_from(request), data, principal)


@app.patch("/api/v1/ingredients/{ingredient_id}")
def patch_ingredient(ingredient_id: str, data: IngredientUpdate, request: Request,
                     principal: Principal = Depends(writer_roles())):
    return update_ingredient(db_from(request), ingredient_id, data, principal)


@app.post("/api/v1/ingredients/{ingredient_id}/movements", status_code=201)
def post_movement(ingredient_id: str, data: MovementCreate, request: Request,
                  idempotency_key: str = Header(alias="Idempotency-Key"),
                  principal: Principal = Depends(writer_roles())):
    return append_movement(db_from(request), ingredient_id, data, principal, idempotency_key)


@app.get("/api/v1/purchases")
def list_purchases(request: Request, principal: Principal = Depends(authenticated_principal)):
    return list(db_from(request).purchases.find({"restaurant_id": principal.restaurant_id})
                .sort("created_at", -1))


@app.post("/api/v1/purchases", status_code=201)
def post_purchase(data: PurchaseCreate, request: Request,
                  idempotency_key: str = Header(alias="Idempotency-Key"),
                  principal: Principal = Depends(writer_roles())):
    return create_purchase(db_from(request), data, principal, idempotency_key)


@app.get("/api/v1/purchases/{purchase_id}")
def get_purchase(purchase_id: str, request: Request,
                 principal: Principal = Depends(authenticated_principal)):
    purchase = db_from(request).purchases.find_one(
        {"_id": purchase_id, "restaurant_id": principal.restaurant_id}
    )
    if purchase is None:
        raise HTTPException(status_code=404, detail="Purchase not found")
    return purchase


@app.post("/api/v1/purchases/{purchase_id}/receipts", status_code=201)
def post_purchase_receipt(purchase_id: str, data: PurchaseReceive, request: Request,
                          idempotency_key: str = Header(alias="Idempotency-Key"),
                          principal: Principal = Depends(writer_roles())):
    return receive_purchase(db_from(request), purchase_id, data, principal, idempotency_key)


@app.get("/api/v1/ingredients/{ingredient_id}/movements")
def list_movements(ingredient_id: str, request: Request,
                   principal: Principal = Depends(authenticated_principal)):
    db = db_from(request)
    if db.ingredients.find_one({"_id": ingredient_id, "restaurant_id": principal.restaurant_id}) is None:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    return list(db.movements.find({"ingredient_id": ingredient_id, "restaurant_id": principal.restaurant_id})
                .sort("occurred_at", -1))


@app.get("/api/v1/movements")
def list_all_movements(request: Request, principal: Principal = Depends(authenticated_principal)):
    return list(db_from(request).movements.find({"restaurant_id": principal.restaurant_id})
                .sort("occurred_at", -1).limit(5000))


@app.post("/api/v1/purchases/{purchase_id}/request")
def request_purchase(purchase_id: str, request: Request,
                     principal: Principal = Depends(writer_roles())):
    return set_purchase_status(db_from(request), purchase_id, "requested", principal)


@app.post("/api/v1/purchases/{purchase_id}/cancel")
def cancel_purchase(purchase_id: str, request: Request,
                    principal: Principal = Depends(writer_roles())):
    return set_purchase_status(db_from(request), purchase_id, "cancelled", principal)


@app.put("/api/v1/recipes/{product_id}")
def put_recipe(product_id: str, data: RecipePut, request: Request,
               principal: Principal = Depends(writer_roles())):
    if data.product_id != product_id:
        raise HTTPException(status_code=422, detail="Product identifier mismatch")
    return upsert_recipe(db_from(request), data, principal)


@app.get("/api/v1/recipes")
def list_recipes(request: Request, principal: Principal = Depends(authenticated_principal)):
    return list(db_from(request).recipes.find({"restaurant_id": principal.restaurant_id}).sort("product_name", 1))
