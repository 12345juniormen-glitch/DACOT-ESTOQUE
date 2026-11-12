import hashlib
import json
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import HTTPException
from pymongo import ReturnDocument

from app.auth import Principal
from app.schemas import (IngredientCreate, IngredientUpdate, MovementCreate, PurchaseCreate,
                         PurchaseReceive, RecipePut, SupplierCreate)


def now() -> datetime:
    return datetime.now(timezone.utc)


def fingerprint(value: dict) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def ingredient_document(data: IngredientCreate, principal: Principal) -> dict:
    timestamp = now()
    return {
        "_id": f"ing_{uuid4().hex}",
        "restaurant_id": principal.restaurant_id,
        "name": data.name.strip(),
        "name_normalized": data.name.strip().casefold(),
        "category": data.category,
        "base_unit": data.base_unit,
        "current_quantity": 0.0,
        "min_quantity": data.min_quantity,
        "cost_cents": data.cost_cents,
        "primary_supplier_id": data.primary_supplier_id,
        "conversions": data.conversions,
        "active": True,
        "created_at": timestamp,
        "updated_at": timestamp,
    }


def create_ingredient(db, data: IngredientCreate, principal: Principal) -> dict:
    if data.primary_supplier_id and db.suppliers.find_one({"_id": data.primary_supplier_id,
                                                           "restaurant_id": principal.restaurant_id,
                                                           "active": True}) is None:
        raise HTTPException(status_code=422, detail="Supplier not found or inactive")
    doc = ingredient_document(data, principal)
    def create(session):
        db.ingredients.insert_one(doc, session=session)
        if data.initial_quantity:
            initial = MovementCreate(kind="purchase", quantity=data.initial_quantity,
                                     unit_cost_cents=data.cost_cents, reason="Initial balance",
                                     purchase_reference="INITIAL")
            _apply_movement(db, doc["_id"], initial, principal, f"initial:{doc['_id']}", session)
        return doc

    try:
        with db.client.start_session() as session:
            session.with_transaction(create)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            raise HTTPException(status_code=409, detail="Ingredient name already exists") from exc
        raise
    doc["current_quantity"] = data.initial_quantity
    return doc


def update_ingredient(db, ingredient_id: str, data: IngredientUpdate, principal: Principal) -> dict:
    fields = data.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(status_code=422, detail="No fields to update")
    if "base_unit" in fields:
        prior = db.ingredients.find_one({"_id": ingredient_id, "restaurant_id": principal.restaurant_id})
        if prior is None:
            raise HTTPException(status_code=404, detail="Ingredient not found")
        if fields["base_unit"] and fields["base_unit"].lower() != prior["base_unit"].lower() \
                and db.movements.count_documents({"restaurant_id": principal.restaurant_id,
                                                  "ingredient_id": ingredient_id}):
            raise HTTPException(status_code=409, detail="Base unit cannot change after stock movements exist")
    if "name" in fields:
        fields["name"] = fields["name"].strip()
        fields["name_normalized"] = fields["name"].casefold()
    fields["updated_at"] = now()
    try:
        result = db.ingredients.find_one_and_update(
            {"_id": ingredient_id, "restaurant_id": principal.restaurant_id},
            {"$set": fields},
            return_document=ReturnDocument.AFTER,
        )
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            raise HTTPException(status_code=409, detail="Ingredient name already exists") from exc
        raise
    if result is None:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    return result


def _apply_movement(db, ingredient_id: str, data: MovementCreate, principal: Principal,
                    idempotency_key: str, session) -> dict:
    ingredient = db.ingredients.find_one(
        {"_id": ingredient_id, "restaurant_id": principal.restaurant_id, "active": True},
        session=session,
    )
    if ingredient is None:
        exists = db.ingredients.find_one(
            {"_id": ingredient_id, "restaurant_id": principal.restaurant_id}, session=session
        )
        if exists is None:
            raise HTTPException(status_code=404, detail="Ingredient not found")
        raise HTTPException(status_code=409, detail="Ingredient inactive")
    entered_unit = (data.unit or ingredient["base_unit"]).lower()
    factor = conversion_factor(ingredient, entered_unit)
    base_quantity = data.quantity * factor
    sign = -1 if data.kind == "adjustment_out" else 1
    delta = sign * base_quantity
    updated = db.ingredients.find_one_and_update(
        {"_id": ingredient_id, "restaurant_id": principal.restaurant_id, "active": True,
         **({"current_quantity": {"$gte": base_quantity}} if sign < 0 else {})},
        {"$inc": {"current_quantity": delta}, "$set": {"updated_at": now()}},
        return_document=ReturnDocument.AFTER,
        session=session,
    )
    if updated is None:
        exists = db.ingredients.find_one(
            {"_id": ingredient_id, "restaurant_id": principal.restaurant_id}, session=session
        )
        if exists is None:
            raise HTTPException(status_code=404, detail="Ingredient not found")
        raise HTTPException(status_code=409, detail="Insufficient stock or ingredient inactive")
    movement = {
        "_id": f"mov_{uuid4().hex}",
        "restaurant_id": principal.restaurant_id,
        "ingredient_id": ingredient_id,
        "kind": data.kind,
        "quantity": base_quantity,
        "unit": updated["base_unit"],
        "quantity_entered": data.quantity,
        "entered_unit": entered_unit,
        "unit_cost_cents": data.unit_cost_cents,
        "reason": data.reason,
        "supplier_id": data.supplier_id,
        "purchase_reference": data.purchase_reference,
        "actor_id": principal.user_id,
        "idempotency_key": idempotency_key,
        "occurred_at": now(),
        "balance_after": updated["current_quantity"],
    }
    db.movements.insert_one(movement, session=session)
    return movement


def append_movement(db, ingredient_id: str, data: MovementCreate, principal: Principal, idempotency_key: str) -> dict:
    if not idempotency_key.strip() or len(idempotency_key) > 200:
        raise HTTPException(status_code=422, detail="A valid Idempotency-Key is required")
    request_hash = fingerprint({"ingredient_id": ingredient_id, **data.model_dump()})
    def apply(session):
        prior = db.movements.find_one({"restaurant_id": principal.restaurant_id,
                                       "idempotency_key": idempotency_key}, session=session)
        if prior is not None:
            if prior.get("request_fingerprint") != request_hash:
                raise HTTPException(status_code=409, detail="Idempotency key was already used for another movement")
            return prior
        movement = _apply_movement(db, ingredient_id, data, principal, idempotency_key, session)
        db.movements.update_one({"_id": movement["_id"], "restaurant_id": principal.restaurant_id},
                                {"$set": {"request_fingerprint": request_hash}}, session=session)
        movement["request_fingerprint"] = request_hash
        return movement

    try:
        with db.client.start_session() as session:
            return session.with_transaction(apply)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            prior = db.movements.find_one({"restaurant_id": principal.restaurant_id,
                                           "idempotency_key": idempotency_key})
            if prior and prior.get("request_fingerprint") == request_hash:
                return prior
            raise HTTPException(status_code=409, detail="Idempotency key was already used for another movement") from exc
        raise


def conversion_factor(ingredient: dict, unit: str) -> float:
    base = ingredient["base_unit"].lower()
    if unit.lower() == base:
        return 1.0
    built_in = {("kg", "g"): 0.001, ("g", "kg"): 1000.0,
                ("l", "ml"): 0.001, ("ml", "l"): 1000.0}
    if (base, unit.lower()) in built_in:
        return built_in[(base, unit.lower())]
    factor = ingredient.get("conversions", {}).get(unit)
    if factor is None:
        factor = ingredient.get("conversions", {}).get(unit.lower())
    if not isinstance(factor, (int, float)) or factor <= 0:
        raise HTTPException(status_code=422, detail=f"No conversion from {unit} to {base} is configured")
    return float(factor)


def create_purchase(db, data: PurchaseCreate, principal: Principal, idempotency_key: str) -> dict:
    if not idempotency_key.strip() or len(idempotency_key) > 200:
        raise HTTPException(status_code=422, detail="A valid Idempotency-Key is required")
    ingredient_ids = [line.ingredient_id for line in data.lines]
    ingredients = list(db.ingredients.find({"_id": {"$in": ingredient_ids},
                                           "restaurant_id": principal.restaurant_id, "active": True}))
    if len(ingredients) != len(ingredient_ids):
        raise HTTPException(status_code=422, detail="Purchase contains an unknown or inactive ingredient")
    ingredient_by_id = {ingredient["_id"]: ingredient for ingredient in ingredients}
    for line in data.lines:
        conversion_factor(ingredient_by_id[line.ingredient_id], line.unit)
    if data.supplier_id and db.suppliers.find_one({"_id": data.supplier_id,
                                                   "restaurant_id": principal.restaurant_id,
                                                   "active": True}) is None:
        raise HTTPException(status_code=422, detail="Supplier not found or inactive")
    timestamp = now()
    request_hash = fingerprint(data.model_dump(mode="json"))
    purchase = {
        "_id": f"pur_{uuid4().hex}", "restaurant_id": principal.restaurant_id,
        "supplier_id": data.supplier_id, "status": "draft", "created_by": principal.user_id,
        "created_at": timestamp, "updated_at": timestamp, "expected_delivery_at": data.expected_delivery_at,
        "received_at": None, "received_by": None, "note": data.note,
        "idempotency_key": idempotency_key,
        "lines": [{"id": f"line_{uuid4().hex}", **line.model_dump(), "quantity_received": 0.0,
                   "received_unit_cost_cents": None} for line in data.lines],
    }

    def create(session):
        prior = db.purchases.find_one({"restaurant_id": principal.restaurant_id,
                                       "idempotency_key": idempotency_key}, session=session)
        if prior is not None:
            if prior.get("request_fingerprint") != request_hash:
                raise HTTPException(status_code=409, detail="Idempotency key was already used for another purchase")
            purchase.clear()
            purchase.update(prior)
            return
        counter = db.counters.find_one_and_update(
            {"_id": f"purchase_code:{principal.restaurant_id}"},
            {"$inc": {"value": 1}, "$setOnInsert": {"restaurant_id": principal.restaurant_id}},
            upsert=True, return_document=ReturnDocument.AFTER, session=session,
        )
        purchase["code"] = f"PC-{counter['value']:04d}"
        purchase["request_fingerprint"] = request_hash
        db.purchases.insert_one(purchase, session=session)

    try:
        with db.client.start_session() as session:
            session.with_transaction(create)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            prior = db.purchases.find_one({"restaurant_id": principal.restaurant_id,
                                           "idempotency_key": idempotency_key})
            if prior and prior.get("request_fingerprint") == request_hash:
                return prior
            raise HTTPException(status_code=409, detail="Duplicate purchase idempotency key") from exc
        raise
    return purchase


def create_supplier(db, data: SupplierCreate, principal: Principal) -> dict:
    timestamp = now()
    supplier = {
        "_id": f"sup_{uuid4().hex}", "restaurant_id": principal.restaurant_id,
        "name": data.name, "name_normalized": data.name.casefold(), "contact": data.contact,
        "phone": data.phone, "whatsapp": data.whatsapp, "notes": data.notes,
        "avg_lead_time_days": data.avg_lead_time_days, "min_order_cents": data.min_order_cents,
        "active": True, "created_at": timestamp, "updated_at": timestamp,
    }
    try:
        db.suppliers.insert_one(supplier)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            raise HTTPException(status_code=409, detail="Supplier name already exists") from exc
        raise
    return supplier


def set_purchase_status(db, purchase_id: str, status: str, principal: Principal) -> dict:
    if status not in {"requested", "cancelled"}:
        raise HTTPException(status_code=422, detail="Invalid purchase transition")
    query = {"_id": purchase_id, "restaurant_id": principal.restaurant_id}
    purchase = db.purchases.find_one(query)
    if purchase is None:
        raise HTTPException(status_code=404, detail="Purchase not found")
    if status == "requested" and purchase["status"] != "draft":
        raise HTTPException(status_code=409, detail="Only draft purchases can be requested")
    if status == "cancelled" and purchase["status"] in {"cancelled", "received"}:
        raise HTTPException(status_code=409, detail="Purchase can no longer be cancelled")
    updated = db.purchases.find_one_and_update(
        {**query, "updated_at": purchase.get("updated_at")},
        {"$set": {"status": status, "updated_at": now(),
                  "cancelled_at": now() if status == "cancelled" else None,
                  "cancelled_by": principal.user_id if status == "cancelled" else None,
                  "requested_at": now() if status == "requested" else None,
                  "requested_by": principal.user_id if status == "requested" else None}},
        return_document=ReturnDocument.AFTER,
    )
    if updated is None:
        raise HTTPException(status_code=409, detail="Purchase changed concurrently")
    return updated


def receive_purchase(db, purchase_id: str, data: PurchaseReceive, principal: Principal,
                     idempotency_key: str) -> dict:
    if not idempotency_key.strip() or len(idempotency_key) > 200:
        raise HTTPException(status_code=422, detail="A valid Idempotency-Key is required")
    receipt_id = f"rec_{uuid4().hex}"
    request_hash = fingerprint({"purchase_id": purchase_id, **data.model_dump(mode="json")})

    def apply(session):
        prior_receipt = db.purchase_receipts.find_one({"restaurant_id": principal.restaurant_id,
                                                       "idempotency_key": idempotency_key}, session=session)
        if prior_receipt is not None:
            if prior_receipt.get("request_fingerprint") != request_hash:
                raise HTTPException(status_code=409, detail="Idempotency key was already used for another receipt")
            return db.purchases.find_one({"_id": prior_receipt["purchase_id"],
                                          "restaurant_id": principal.restaurant_id}, session=session)
        purchase = db.purchases.find_one({"_id": purchase_id, "restaurant_id": principal.restaurant_id},
                                         session=session)
        if purchase is None:
            raise HTTPException(status_code=404, detail="Purchase not found")
        if purchase["status"] in {"cancelled", "received"}:
            raise HTTPException(status_code=409, detail="Purchase can no longer be received")
        receipt_lines = {line.line_id: line for line in data.lines}
        purchase_lines = {line["id"]: line for line in purchase["lines"]}
        if not set(receipt_lines).issubset(purchase_lines):
            raise HTTPException(status_code=422, detail="Receipt contains an unknown purchase line")

        updated_lines = []
        receipt_items = []
        for line in purchase["lines"]:
            incoming = receipt_lines.get(line["id"])
            updated = dict(line)
            if incoming:
                if line["quantity_received"] + incoming.quantity_received > line["quantity_ordered"] + 1e-9:
                    raise HTTPException(status_code=422, detail="Received quantity exceeds quantity ordered")
                updated["quantity_received"] += incoming.quantity_received
                updated["received_unit_cost_cents"] = incoming.unit_cost_cents
                receipt_items.append((updated, incoming))
            updated_lines.append(updated)
        all_received = all(line["quantity_received"] >= line["quantity_ordered"] - 1e-9 for line in updated_lines)
        any_received = any(line["quantity_received"] > 0 for line in updated_lines)
        status = "received" if all_received else ("partial" if any_received else "requested")
        timestamp = now()
        changed = db.purchases.find_one_and_update(
            {"_id": purchase_id, "restaurant_id": principal.restaurant_id,
             "updated_at": purchase.get("updated_at")},
            {"$set": {"lines": updated_lines, "status": status, "updated_at": timestamp,
                      "received_at": timestamp if all_received else None,
                      "received_by": principal.user_id if all_received else None}},
            return_document=ReturnDocument.AFTER, session=session,
        )
        if changed is None:
            raise HTTPException(status_code=409, detail="Purchase changed concurrently; retry with a new key")
        db.purchase_receipts.insert_one({"_id": receipt_id, "restaurant_id": principal.restaurant_id,
                                         "purchase_id": purchase_id, "idempotency_key": idempotency_key,
                                         "request_fingerprint": request_hash,
                                         "actor_id": principal.user_id, "received_at": timestamp,
                                         "lines": [line.model_dump() for line in data.lines]}, session=session)
        for line, incoming in receipt_items:
            ingredient = db.ingredients.find_one({"_id": line["ingredient_id"],
                                                  "restaurant_id": principal.restaurant_id, "active": True},
                                                 session=session)
            if ingredient is None:
                raise HTTPException(status_code=409, detail="Purchase ingredient is unavailable")
            base_cost = round(incoming.unit_cost_cents / conversion_factor(ingredient, line["unit"]))
            movement_data = MovementCreate(kind="purchase", quantity=incoming.quantity_received,
                unit_cost_cents=base_cost, reason=f"Received purchase {purchase_id}",
                supplier_id=purchase.get("supplier_id"), purchase_reference=purchase_id, unit=line["unit"])
            _apply_movement(db, line["ingredient_id"], movement_data, principal,
                            f"{receipt_id}:{line['id']}", session)
            db.ingredients.update_one(
                {"_id": line["ingredient_id"], "restaurant_id": principal.restaurant_id},
                {"$set": {"cost_cents": base_cost},
                 "$push": {"price_history": {"unit_cost_cents": base_cost, "supplier_id": purchase.get("supplier_id"),
                                              "purchase_id": purchase_id, "occurred_at": timestamp}}},
                session=session,
            )
        return changed

    try:
        with db.client.start_session() as session:
            return session.with_transaction(apply)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            prior = db.purchase_receipts.find_one({"restaurant_id": principal.restaurant_id,
                                                   "idempotency_key": idempotency_key})
            if prior and prior.get("request_fingerprint") == request_hash:
                return db.purchases.find_one({"_id": prior["purchase_id"],
                                              "restaurant_id": principal.restaurant_id})
            raise HTTPException(status_code=409, detail="Duplicate receipt idempotency key") from exc
        raise


def upsert_recipe(db, data: RecipePut, principal: Principal) -> dict:
    ingredient_ids = [line.ingredient_id for line in data.lines]
    found = list(db.ingredients.find({"_id": {"$in": ingredient_ids}, "restaurant_id": principal.restaurant_id,
                                     "active": True}, {"_id": 1}))
    if len(found) != len(set(ingredient_ids)):
        raise HTTPException(status_code=422, detail="Recipe contains an unknown or inactive ingredient")
    timestamp = now()
    recipe = {
        "_id": f"recipe_{principal.restaurant_id}_{data.product_id}",
        "restaurant_id": principal.restaurant_id,
        "product_id": data.product_id,
        "product_name": data.product_name,
        "lines": [line.model_dump() for line in data.lines],
        "sale_price_cents": data.sale_price_cents,
        "updated_by": principal.user_id,
        "updated_at": timestamp,
    }
    db.recipes.update_one({"restaurant_id": principal.restaurant_id, "product_id": data.product_id},
                          {"$set": recipe, "$setOnInsert": {"created_at": timestamp}}, upsert=True)
    return recipe
