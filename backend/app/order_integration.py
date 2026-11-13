"""Authenticated, idempotent order snapshots from DACOT-PEDIDOS."""
import hashlib
import hmac
import json
import re
import time
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pymongo.errors import DuplicateKeyError

from app.auth import Principal
from app.schemas import MovementCreate
from app.service import _apply_movement, quantity_from_milli, quantity_milli

SOURCE = "dacot-pedidos"
EVENT_VERSION = 1
MAX_CLOCK_SKEW_SECONDS = 300


def _utc_datetime(value: datetime) -> datetime:
    """PyMongo may return naive UTC values unless tz_aware is enabled."""
    if value.tzinfo is None or value.utcoffset() is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


class OrderItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product_id: str = Field(min_length=1, max_length=120)
    product_name: str | None = Field(default=None, max_length=160)
    quantity: int = Field(ge=1, le=999)


class OrderSnapshotEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event_id: str = Field(min_length=16, max_length=100)
    event_type: Literal["order.snapshot"]
    event_version: Literal[1]
    source: Literal["dacot-pedidos"]
    restaurant_id: str = Field(min_length=1, max_length=120)
    order_id: str = Field(min_length=1, max_length=120)
    order_number: int = Field(ge=1)
    order_revision: int = Field(ge=1)
    status: Literal["new", "in_preparation", "ready", "delivered", "cancelled"]
    occurred_at: datetime
    items: list[OrderItem] = Field(min_length=1, max_length=100)

    @field_validator("occurred_at")
    @classmethod
    def require_timezone(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("occurred_at must include a timezone")
        return value


class IntegrationActivation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    active: bool


class IntegrationResolution(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["keep_consumed"]
    reason: str = Field(min_length=5, max_length=300)

    @field_validator("reason")
    @classmethod
    def trim_reason(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 5:
            raise ValueError("A resolution reason is required")
        return value


def verify_request_signature(secret: str | None, timestamp: str | None,
                             signature: str | None, body: bytes,
                             previous_secret: str | None = None) -> None:
    if not secret or len(secret) < 32:
        raise HTTPException(status_code=503, detail="Orders integration is not configured")
    if not timestamp or not timestamp.isascii() or not timestamp.isdecimal():
        raise HTTPException(status_code=401, detail="Invalid integration timestamp")
    if not signature or not re.fullmatch(r"(?:sha256=)?[0-9a-fA-F]{64}", signature):
        raise HTTPException(status_code=401, detail="Invalid integration signature")
    try:
        issued_at = int(timestamp)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid integration timestamp") from exc
    now = int(time.time())
    if abs(now - issued_at) > MAX_CLOCK_SKEW_SECONDS:
        raise HTTPException(status_code=401, detail="Expired integration request")
    message = b"POST\n/api/v1/integrations/orders/events\n" + timestamp.encode("ascii") + b"\n" + body
    supplied = (signature or "").removeprefix("sha256=")
    candidates = [secret]
    if previous_secret and len(previous_secret) >= 32:
        candidates.append(previous_secret)
    if not any(hmac.compare_digest(hmac.new(candidate.encode("utf-8"), message,
            hashlib.sha256).hexdigest(), supplied) for candidate in candidates):
        raise HTTPException(status_code=401, detail="Invalid integration signature")


def _event_fingerprint(event: OrderSnapshotEvent) -> str:
    packed = json.dumps(event.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(packed.encode()).hexdigest()


def _event_result(document: dict) -> dict:
    """Return only the stable API result fields, never Mongo's internal _id."""
    allowed = ("restaurant_id", "event_id", "order_id", "order_revision", "status",
               "processed_at", "reason", "decision", "resolution_reason", "resolved_by",
               "resolved_at")
    return {key: document[key] for key in allowed if key in document}


def _recipe_snapshot(db, restaurant_id: str, product_id: str, session) -> dict:
    recipe = db.recipes.find_one({"restaurant_id": restaurant_id, "product_id": product_id,
                                  "active": True, "consumption_enabled": True}, session=session)
    if not recipe:
        raise HTTPException(status_code=422, detail="Produto vendido sem ficha técnica validada para consumo automático")
    lines = []
    for line in recipe.get("lines", []):
        ingredient = db.ingredients.find_one({"_id": line["ingredient_id"],
            "restaurant_id": restaurant_id, "active": True}, session=session)
        if ingredient is None:
            raise HTTPException(status_code=422, detail="Ficha contém ingrediente inativo ou indisponível")
        lines.append({
            "ingredient_id": line["ingredient_id"], "quantity": str(line["quantity"]),
            "unit": line["unit"], "conversion_to_base": str(line["conversion_to_base"]),
            "ingredient_name": ingredient["name"], "base_unit": ingredient["base_unit"],
        })
    return {"product_id": product_id, "product_name": recipe["product_name"],
            "recipe_id": recipe["_id"], "recipe_version": int(recipe.get("version", 1)),
            "yield_portions": int(recipe.get("yield_portions", 1)), "lines": lines}


def _increment_by_ingredient(items: dict[str, int], prior_products: dict,
                             recipe_snapshots: dict[str, dict]) -> tuple[dict[str, int], list[dict]]:
    increments: dict[str, int] = {}
    next_products = dict(prior_products)
    for product_id, prior in prior_products.items():
        previous_order_quantity = int(prior.get("last_order_quantity", prior.get("consumed_quantity", 0)))
        if product_id not in items and previous_order_quantity > 0:
            raise HTTPException(status_code=409,
                detail="Produto removido após início do consumo; revisão requer decisão do gestor")
    for product_id, requested_quantity in items.items():
        prior = prior_products.get(product_id)
        consumed_quantity = int(prior.get("consumed_quantity", 0)) if prior else 0
        previous_order_quantity = int(prior.get("last_order_quantity", consumed_quantity)) if prior else 0
        if requested_quantity < previous_order_quantity:
            raise HTTPException(status_code=409,
                detail="Pedido reduzido após o consumo; revisão requer decisão do gestor")
        additional = max(0, requested_quantity - consumed_quantity)
        snapshot = prior.get("recipe_snapshot") if prior else recipe_snapshots[product_id]
        next_products[product_id] = {"consumed_quantity": max(consumed_quantity, requested_quantity),
                                     "last_order_quantity": requested_quantity,
                                     "recipe_snapshot": snapshot}
        if additional == 0:
            continue
        yield_portions = int(snapshot["yield_portions"])
        for line in snapshot["lines"]:
            raw = (Decimal(str(line["quantity"])) * Decimal(additional)
                   * Decimal(str(line["conversion_to_base"])) / Decimal(yield_portions))
            milli_exact = raw * Decimal(1000)
            milli = int(milli_exact.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
            if milli <= 0 or Decimal(milli) != milli_exact:
                raise HTTPException(status_code=422,
                    detail="Consumo excede a precisão de 0,001 unidade do estoque")
            increments[line["ingredient_id"]] = increments.get(line["ingredient_id"], 0) + milli
    return increments, list(next_products.values())


def process_order_event(db, event: OrderSnapshotEvent, *, retry: bool = False) -> dict:
    tenant = event.restaurant_id
    event_key = {"restaurant_id": tenant, "event_id": event.event_id}
    fingerprint = _event_fingerprint(event)
    existing = db.order_integration_events.find_one(event_key)
    if existing and existing.get("fingerprint") != fingerprint:
        raise HTTPException(status_code=409, detail="Event ID was reused with different content")
    if existing and existing.get("status") not in {"blocked", "needs_action"}:
        return _event_result(existing)
    if existing and not retry:
        return _event_result(existing)

    activation = db.order_integrations.find_one({"restaurant_id": tenant, "active": True})
    if activation is None:
        raise HTTPException(status_code=403, detail="Order integration is not enabled for this restaurant")
    if _utc_datetime(event.occurred_at) < _utc_datetime(activation["enabled_at"]):
        raise HTTPException(status_code=409, detail="Event predates the integration activation point")

    items: dict[str, int] = {}
    for item in event.items:
        items[item.product_id] = items.get(item.product_id, 0) + item.quantity
    timestamp = datetime.now(timezone.utc)
    state_query = {"restaurant_id": tenant, "order_id": event.order_id}

    def process(session):
        prior_event = db.order_integration_events.find_one(event_key, session=session)
        if prior_event and prior_event.get("fingerprint") != fingerprint:
            raise HTTPException(status_code=409, detail="Event ID was reused with different content")
        if prior_event and prior_event.get("status") not in {"blocked", "needs_action"}:
            return _event_result(prior_event)
        state = db.inventory_order_state.find_one(state_query, session=session)
        if state and event.order_revision <= int(state.get("order_revision", 0)):
            result = {"restaurant_id": tenant, "event_id": event.event_id,
                      "order_id": event.order_id, "order_revision": event.order_revision,
                      "status": "ignored_stale", "processed_at": timestamp}
            db.order_integration_events.replace_one(event_key, {**result, "fingerprint": fingerprint},
                upsert=True, session=session)
            return result
        prior_products = dict((state or {}).get("products", {}))
        status = "processed"
        next_products = prior_products
        increments: dict[str, int] = {}
        if event.status == "cancelled" and prior_products:
            status = "needs_action"
            reason = "Pedido cancelado após consumo; confirme perda ou devolução física antes de ajustar estoque"
        elif event.status in {"in_preparation", "ready", "delivered"}:
            recipe_snapshots = {}
            try:
                for product_id in items:
                    if product_id not in prior_products:
                        recipe_snapshots[product_id] = _recipe_snapshot(db, tenant, product_id, session)
                increments, product_values = _increment_by_ingredient(items, prior_products, recipe_snapshots)
                next_products = {entry["recipe_snapshot"]["product_id"]: entry for entry in product_values}
            except HTTPException as exc:
                status = "needs_action" if exc.status_code == 409 else "blocked"
                reason = str(exc.detail)
        if increments:
            for ingredient_id, quantity in increments.items():
                ingredient = db.ingredients.find_one({"_id": ingredient_id, "restaurant_id": tenant,
                    "active": True}, session=session)
                if ingredient is None:
                    raise HTTPException(status_code=422, detail="Ficha contém ingrediente indisponível")
                balance = int(ingredient.get("current_quantity_milli",
                    quantity_milli(ingredient.get("current_quantity", 0))))
                if balance < quantity:
                    raise HTTPException(status_code=409, detail=f"Estoque insuficiente para {ingredient['name']}")
            principal = Principal("dacot-pedidos", tenant, ("service",))
            for ingredient_id, quantity in increments.items():
                ingredient = db.ingredients.find_one({"_id": ingredient_id,
                    "restaurant_id": tenant}, session=session)
                movement = _apply_movement(db, ingredient_id, MovementCreate(
                    kind="consumption_by_order", quantity=quantity_from_milli(quantity),
                    unit=ingredient["base_unit"], reason=f"Consumo do pedido {event.order_number}"
                ), principal,
                    f"order:{event.order_id}:revision:{event.order_revision}:{ingredient_id}",
                    session)
                db.movements.update_one({"_id": movement["_id"], "restaurant_id": tenant},
                    {"$set": {"source": SOURCE, "source_order_id": event.order_id,
                        "source_order_number": event.order_number,
                        "source_event_id": event.event_id, "order_revision": event.order_revision,
                        "recipe_snapshots": [p["recipe_snapshot"] for p in next_products.values()]}}
                    , session=session)
        # A blocked revision must remain retryable after a recipe/stock correction.
        if status != "blocked":
            if state is None:
                state_doc = {**state_query, "order_number": event.order_number,
                             "order_revision": event.order_revision, "status": event.status,
                             "products": next_products, "updated_at": timestamp}
                db.inventory_order_state.insert_one(state_doc, session=session)
            else:
                db.inventory_order_state.update_one(state_query, {"$set": {
                    "order_number": event.order_number, "order_revision": event.order_revision,
                    "status": event.status, "products": next_products, "updated_at": timestamp,
                }}, session=session)
        result = {"restaurant_id": tenant, "event_id": event.event_id,
                  "order_id": event.order_id, "order_revision": event.order_revision,
                  "status": status, "processed_at": timestamp}
        if status in {"blocked", "needs_action"}:
            result["reason"] = reason
            db.order_integration_exceptions.replace_one(event_key, {**result, "fingerprint": fingerprint},
                upsert=True, session=session)
        db.order_integration_events.replace_one(event_key,
            {**result, "fingerprint": fingerprint, "event": event.model_dump(mode="json")},
            upsert=True, session=session)
        return result

    try:
        with db.client.start_session() as session:
            return session.with_transaction(process)
    except HTTPException as exc:
        if exc.status_code not in {409, 422}:
            raise
        reason = str(exc.detail)
        status = "blocked" if "Estoque insuficiente" in reason else (
            "needs_action" if exc.status_code == 409 else "blocked")
        result = {"restaurant_id": tenant, "event_id": event.event_id,
                  "order_id": event.order_id, "order_revision": event.order_revision,
                  "status": status, "reason": reason, "processed_at": timestamp}
        db.order_integration_events.replace_one(event_key,
            {**result, "fingerprint": fingerprint, "event": event.model_dump(mode="json")}, upsert=True)
        db.order_integration_exceptions.replace_one(event_key,
            {**result, "fingerprint": fingerprint}, upsert=True)
        return result
    except DuplicateKeyError:
        prior = db.order_integration_events.find_one(event_key)
        if prior and prior.get("fingerprint") == fingerprint:
            return _event_result(prior)
        raise HTTPException(status_code=409, detail="Duplicate order integration event")


def resolve_order_exception(db, restaurant_id: str, event_id: str, actor_id: str,
                            reason: str) -> dict:
    event_query = {"restaurant_id": restaurant_id, "event_id": event_id}
    exception = db.order_integration_exceptions.find_one(event_query)
    if exception is None:
        raise HTTPException(status_code=404, detail="Integration exception not found")
    if exception.get("status") != "needs_action":
        raise HTTPException(status_code=409, detail="This exception is not awaiting a manager decision")
    stored = db.order_integration_events.find_one(event_query)
    if stored is None:
        raise HTTPException(status_code=409, detail="Original order event is unavailable")
    event = OrderSnapshotEvent.model_validate(stored["event"])
    timestamp = datetime.now(timezone.utc)
    state_query = {"restaurant_id": restaurant_id, "order_id": event.order_id}
    item_quantities: dict[str, int] = {}
    for item in event.items:
        item_quantities[item.product_id] = item_quantities.get(item.product_id, 0) + item.quantity

    def resolve(session):
        latest = db.order_integration_exceptions.find_one(event_query, session=session)
        if latest is None or latest.get("status") != "needs_action":
            raise HTTPException(status_code=409, detail="Integration exception was already resolved")
        state = db.inventory_order_state.find_one(state_query, session=session)
        products = dict((state or {}).get("products", {}))
        for product_id, product in products.items():
            product["last_order_quantity"] = item_quantities.get(product_id, 0)

        increments: dict[str, int] = {}
        next_products = products
        if event.status in {"in_preparation", "ready", "delivered"}:
            recipe_snapshots = {}
            for product_id in item_quantities:
                if product_id not in products:
                    recipe_snapshots[product_id] = _recipe_snapshot(db, restaurant_id,
                        product_id, session)
            increments, entries = _increment_by_ingredient(item_quantities, products, recipe_snapshots)
            next_products = {entry["recipe_snapshot"]["product_id"]: entry for entry in entries}
            for ingredient_id, quantity in increments.items():
                ingredient = db.ingredients.find_one({"_id": ingredient_id,
                    "restaurant_id": restaurant_id, "active": True}, session=session)
                if ingredient is None:
                    raise HTTPException(status_code=409, detail="An ingredient in this order is unavailable")
                balance = int(ingredient.get("current_quantity_milli",
                    quantity_milli(ingredient.get("current_quantity", 0))))
                if balance < quantity:
                    raise HTTPException(status_code=409,
                        detail=f"Estoque insuficiente para {ingredient['name']}; corrija o saldo antes de resolver")
            principal = Principal(actor_id, restaurant_id, ("manager",))
            for ingredient_id, quantity in increments.items():
                ingredient = db.ingredients.find_one({"_id": ingredient_id,
                    "restaurant_id": restaurant_id}, session=session)
                movement = _apply_movement(db, ingredient_id, MovementCreate(
                    kind="consumption_by_order", quantity=quantity_from_milli(quantity),
                    unit=ingredient["base_unit"], reason=f"Consumo do pedido {event.order_number}"
                ), principal,
                    f"order:{event.order_id}:revision:{event.order_revision}:{ingredient_id}", session)
                db.movements.update_one({"_id": movement["_id"], "restaurant_id": restaurant_id},
                    {"$set": {"source": SOURCE, "source_order_id": event.order_id,
                        "source_order_number": event.order_number, "source_event_id": event.event_id,
                        "order_revision": event.order_revision,
                        "recipe_snapshots": [p["recipe_snapshot"] for p in next_products.values()]}},
                    session=session)

        state_data = {"order_number": event.order_number, "order_revision": event.order_revision,
                      "status": event.status, "products": next_products, "updated_at": timestamp}
        if state is None:
            db.inventory_order_state.insert_one({**state_query, **state_data}, session=session)
        else:
            db.inventory_order_state.update_one(state_query, {"$set": state_data}, session=session)
        resolution = {"status": "resolved", "decision": "keep_consumed",
                      "resolution_reason": reason, "resolved_by": actor_id, "resolved_at": timestamp}
        db.order_integration_events.update_one(event_query, {"$set": resolution}, session=session)
        db.order_integration_exceptions.update_one(event_query, {"$set": resolution}, session=session)
        return {"event_id": event_id, "status": "resolved", "decision": "keep_consumed",
                "resolution_reason": reason, "resolved_at": timestamp,
                "new_movements": len(increments)}

    with db.client.start_session() as session:
        return session.with_transaction(resolve)
