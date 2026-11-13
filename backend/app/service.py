import hashlib
import json
import re
import unicodedata
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import HTTPException
from pymongo import ReturnDocument
from pymongo.errors import DuplicateKeyError

from app.auth import Principal
from app.schemas import (IngredientCreate, IngredientUpdate, MovementCreate, PurchaseCreate, PurchaseDraftUpdate,
                         PurchaseReceive, RecipePut, SupplierCreate, CountCreate, CountSelection, CountLineUpdate,
                         LossCreate, SupplierUpdate, MovementReversal, RecipeConsumptionUpdate)

QUANTITY_SCALE = 1000
QUANTITY_QUANTUM = Decimal("0.001")
MAX_STOCK_MILLI = 9_223_372_036_854_775_807
LOSS_REASON_ORDER = ("Vencimento", "Preparo errado", "Sobra", "Quebra",
                     "Erro operacional", "Qualidade", "Outros")


def ingredient_cost_known(ingredient: dict) -> bool:
    """Read explicit cost state, falling back safely for legacy documents."""
    return bool(ingredient.get("cost_known", int(ingredient.get("cost_cents", 0)) > 0))


def quantity_milli(value) -> int:
    return int((Decimal(str(value)) * QUANTITY_SCALE).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def quantity_from_milli(value: int) -> float:
    return float(Decimal(value) / QUANTITY_SCALE)


def now() -> datetime:
    return datetime.now(timezone.utc)


def utc_datetime(value: datetime) -> datetime:
    """PyMongo defaults to naive UTC datetimes; expose and compare them as aware UTC."""
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def movement_insights(db, principal: Principal) -> dict:
    tenant = principal.restaurant_id
    recent = list(db.movements.find({"restaurant_id": tenant})
        .sort([("occurred_at", -1), ("_id", -1)]).limit(100))
    reversal_lookup = {"$lookup": {
        "from": "movements",
        "let": {"movement_id": "$_id"},
        "pipeline": [{"$match": {"restaurant_id": tenant,
            "$expr": {"$eq": ["$reversal_of", "$$movement_id"]}}}, {"$limit": 1},
            {"$project": {"_id": 1}}],
        "as": "_reversals",
    }}
    valid_only = [reversal_lookup, {"$match": {"_reversals": {"$eq": []}}}]
    latest_two_supplier_prices = list(db.movements.aggregate([
        {"$match": {"restaurant_id": tenant, "kind": "purchase",
            "supplier_id": {"$exists": True, "$ne": None}}},
        *valid_only,
        {"$addFields": {"_price_sort_key": {"$concat": [
            {"$dateToString": {"format": "%Y%m%d%H%M%S%L", "date": "$occurred_at", "timezone": "UTC"}},
            ":", {"$toString": "$_id"},
        ]}}},
        {"$setWindowFields": {
            "partitionBy": {"ingredient_id": "$ingredient_id", "supplier_id": "$supplier_id"},
            "sortBy": {"_price_sort_key": -1},
            "output": {"_price_rank": {"$documentNumber": {}}},
        }},
        {"$match": {"_price_rank": {"$lte": 2}}},
        {"$project": {"_reversals": 0, "_price_rank": 0, "_price_sort_key": 0}},
        {"$sort": {"occurred_at": -1, "_id": -1}},
    ]))
    return {"recent_movements": recent,
            "latest_two_supplier_price_movements": latest_two_supplier_prices}


def ingredient_price_history(db, principal: Principal, ingredient_id: str) -> dict:
    """Return a compact price history for one ingredient, without loading the restaurant ledger."""
    tenant = principal.restaurant_id
    if db.ingredients.find_one({"_id": ingredient_id, "restaurant_id": tenant}) is None:
        raise HTTPException(status_code=404, detail="Ingredient not found")
    cutoff = now() - timedelta(days=120)
    reversal_lookup = {"$lookup": {
        "from": "movements", "let": {"movement_id": "$_id"},
        "pipeline": [{"$match": {"restaurant_id": tenant,
            "$expr": {"$eq": ["$reversal_of", "$$movement_id"]}}}, {"$limit": 1},
            {"$project": {"_id": 1}}],
        "as": "_reversals",
    }}
    supplier_lookup = {"$lookup": {
        "from": "suppliers", "let": {"supplier_id": "$supplier_id"},
        "pipeline": [{"$match": {"restaurant_id": tenant,
            "$expr": {"$eq": ["$_id", "$$supplier_id"]}}}, {"$limit": 1},
            {"$project": {"_id": 1}}],
        "as": "_supplier",
    }}
    pipeline = [
        {"$match": {"restaurant_id": tenant, "ingredient_id": ingredient_id,
            "kind": "purchase", "unit_cost_cents": {"$gte": 0},
            "supplier_id": {"$exists": True, "$ne": None}}},
        reversal_lookup,
        {"$match": {"_reversals": {"$eq": []}}},
        supplier_lookup,
        {"$match": {"_supplier": {"$ne": []}}},
        {"$facet": {
            "points": [
                {"$sort": {"occurred_at": -1, "_id": -1}}, {"$limit": 6},
                {"$project": {"_reversals": 0, "_supplier": 0}},
            ],
            "summary": [
                {"$match": {"occurred_at": {"$gte": cutoff}}},
                {"$sort": {"occurred_at": 1, "_id": 1}},
                {"$group": {"_id": None, "first_cost_cents": {"$first": "$unit_cost_cents"},
                    "last_cost_cents": {"$last": "$unit_cost_cents"}, "count": {"$sum": 1}}},
            ],
        }},
    ]
    result = list(db.movements.aggregate(pipeline))
    data = result[0] if result else {"points": [], "summary": []}
    summary = data.get("summary", [])
    summary_row = summary[0] if summary else None
    summary_value = ({"first_cost_cents": summary_row["first_cost_cents"],
                      "last_cost_cents": summary_row["last_cost_cents"],
                      "count": int(summary_row["count"])} if summary_row else None)
    return {"points": data.get("points", []), "summary": summary_value}


def price_rise_insights(db, principal: Principal) -> dict:
    """Aggregate the same 120-day, valid receipt price series used by the dashboard."""
    tenant = principal.restaurant_id
    cutoff = now() - timedelta(days=120)
    reversal_lookup = {"$lookup": {"from": "movements", "let": {"movement_id": "$_id"},
        "pipeline": [{"$match": {"restaurant_id": tenant,
            "$expr": {"$eq": ["$reversal_of", "$$movement_id"]}}}, {"$limit": 1}],
        "as": "_reversals"}}
    supplier_lookup = {"$lookup": {"from": "suppliers", "let": {"supplier_id": "$supplier_id"},
        "pipeline": [{"$match": {"restaurant_id": tenant,
            "$expr": {"$eq": ["$_id", "$$supplier_id"]}}}, {"$limit": 1}],
        "as": "_supplier"}}
    groups = list(db.movements.aggregate([
        {"$match": {"restaurant_id": tenant, "kind": "purchase",
            "occurred_at": {"$gte": cutoff}, "unit_cost_cents": {"$gte": 0},
            "supplier_id": {"$exists": True, "$ne": None}}},
        reversal_lookup,
        {"$match": {"_reversals": {"$eq": []}}},
        supplier_lookup,
        {"$match": {"_supplier": {"$ne": []}}},
        {"$sort": {"occurred_at": 1, "_id": 1}},
        {"$group": {"_id": "$ingredient_id", "first_cost_cents": {"$first": "$unit_cost_cents"},
            "last_cost_cents": {"$last": "$unit_cost_cents"}, "points": {"$sum": 1}}},
    ]))
    ingredient_ids = [group["_id"] for group in groups]
    ingredients = {item["_id"]: item for item in db.ingredients.find({
        "restaurant_id": tenant, "active": {"$ne": False}, "_id": {"$in": ingredient_ids},
    })} if ingredient_ids else {}
    rising = []
    for group in groups:
        item = ingredients.get(group["_id"])
        first = int(group["first_cost_cents"])
        last = int(group["last_cost_cents"])
        variation = (last - first) / first if first > 0 else 0
        if item is not None and group["points"] >= 2 and variation >= 0.05:
            rising.append({"ingredient": item, "first_unit_cost_cents": first,
                "last_unit_cost_cents": last, "variation": variation, "points": int(group["points"])})
    rising.sort(key=lambda row: (-row["variation"], row["ingredient"].get("name_normalized", ""),
                                 row["ingredient"]["_id"]))
    return {"count": len(rising), "top": rising[0] if rising else None}


def inventory_insights(db, principal: Principal) -> dict:
    """Tenant-scoped inventory totals for list headers and dashboards, without downloading the catalog."""
    quantity = {"$ifNull": ["$current_quantity_milli", {"$multiply": ["$current_quantity", 1000]}]}
    minimum = {"$ifNull": ["$min_quantity_milli", {"$multiply": ["$min_quantity", 1000]}]}
    positive = {"$gt": [quantity, 0]}
    status_conditions = {
        "empty": {"$lte": [quantity, 0]},
        "critical": {"$and": [positive, {"$lt": [{"$multiply": [quantity, 2]}, minimum]}]},
        "attention": {"$and": [positive, {"$lt": [quantity, minimum]},
                                 {"$gte": [{"$multiply": [quantity, 2]}, minimum]}]},
        "near_minimum": {"$and": [positive, {"$gte": [quantity, minimum]},
                                    {"$lt": [{"$multiply": [quantity, 4]}, {"$multiply": [minimum, 5]}]}]},
        "normal": {"$and": [positive,
                             {"$gte": [{"$multiply": [quantity, 4]},
                                       {"$multiply": [minimum, 5]}]}]},
    }
    cost = {"$ifNull": ["$cost_cents", 0]}
    cost_known = {"$ifNull": ["$cost_known", {"$gt": [cost, 0]}]}
    value_cents = {"$floor": {"$add": [
        {"$divide": [{"$multiply": [quantity, cost]}, 1000]}, 0.5,
    ]}}
    sums = {"total": {"$sum": 1},
        "known_stock_value_cents": {"$sum": {"$cond": [cost_known, value_cents, 0]}},
        "without_cost": {"$sum": {"$cond": [cost_known, 0, 1]}},
    }
    for status, condition in status_conditions.items():
        sums[status] = {"$sum": {"$cond": [condition, 1, 0]}}
        sums[f"active_{status}"] = {"$sum": {"$cond": [
            {"$and": [{"$ne": ["$active", False]}, condition]}, 1, 0,
        ]}}
    sums["active_total"] = {"$sum": {"$cond": [{"$ne": ["$active", False]}, 1, 0]}}
    rows = list(db.ingredients.aggregate([
        {"$match": {"restaurant_id": principal.restaurant_id}},
        {"$group": {"_id": None, **sums}},
    ]))
    if not rows:
        return {"total": 0, "known_stock_value_cents": 0, "without_cost": 0,
                "active_total": 0,
                **{key: 0 for status in status_conditions
                   for key in (status, f"active_{status}")}}
    return {key: int(value or 0) for key, value in rows[0].items() if key != "_id"}


def operational_insights(db, principal: Principal) -> dict:
    """Current-month tenant-scoped loss and physical-count financial summaries."""
    reference = now()
    local_now = reference.astimezone(timezone(timedelta(hours=-3)))
    month_start_local = local_now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    month_end_local = (month_start_local.replace(day=28) + timedelta(days=4)).replace(
        day=1, hour=0, minute=0, second=0, microsecond=0,
    )
    month_start = month_start_local.astimezone(timezone.utc)
    month_end = month_end_local.astimezone(timezone.utc)
    month_query = {"restaurant_id": principal.restaurant_id,
                   "occurred_at": {"$gte": month_start, "$lt": month_end}}

    priced_loss = {"$or": [
        {"$eq": ["$value_complete", True]},
        {"$and": [
            {"$ne": ["$value_complete", False]},
            {"$gt": [{"$ifNull": ["$value_cents", 0]}, 0]},
        ]},
    ]}
    loss_rows = list(db.losses.aggregate([
        {"$match": month_query},
        {"$group": {"_id": None, "count": {"$sum": 1},
            "priced_count": {"$sum": {"$cond": [priced_loss, 1, 0]}},
            "value_cents": {"$sum": {"$cond": [priced_loss,
                {"$ifNull": ["$value_cents", 0]}, 0]}},
        }},
    ]))
    week_loss_rows = list(db.losses.aggregate([
        {"$match": {"restaurant_id": principal.restaurant_id,
                    "occurred_at": {"$gte": reference - timedelta(days=7)}}},
        {"$group": {"_id": None, "value_cents": {"$sum": {"$cond": [priced_loss,
            {"$ifNull": ["$value_cents", 0]}, 0]}}}},
    ]))
    top_reason_rows = list(db.losses.aggregate([
        {"$match": {**month_query, "$expr": priced_loss}},
        {"$group": {"_id": "$reason", "value_cents": {"$sum": {"$ifNull": ["$value_cents", 0]}}}},
    ]))
    reason_rank = {reason: index for index, reason in enumerate(LOSS_REASON_ORDER)}
    top_reason_rows.sort(key=lambda row: (-int(row.get("value_cents", 0)),
                                          reason_rank.get(row.get("_id"), len(reason_rank)),
                                          str(row.get("_id") or "")))
    reason_totals = [{"reason": row["_id"], "value_cents": int(row.get("value_cents", 0))}
                     for row in top_reason_rows if row.get("_id")]
    top_item_rows = list(db.losses.aggregate([
        {"$match": {**month_query, "$expr": priced_loss,
                    "ingredient_id": {"$exists": True, "$ne": None}}},
        {"$group": {"_id": "$ingredient_id", "value_cents": {"$sum": {"$ifNull": ["$value_cents", 0]}}}},
        {"$sort": {"value_cents": -1, "_id": 1}},
    ]))
    top_item = None
    top_item_row = next((row for row in top_item_rows if int(row.get("value_cents", 0)) > 0), None)
    if top_item_row:
        ingredient = db.ingredients.find_one({"_id": top_item_row["_id"],
            "restaurant_id": principal.restaurant_id}, {"name": 1})
        if ingredient:
            top_item = {"ingredient_id": top_item_row["_id"], "ingredient_name": ingredient["name"],
                        "value_cents": int(top_item_row["value_cents"])}
    line_divergence = {"$reduce": {
        "input": {"$ifNull": ["$lines", []]}, "initialValue": 0,
        "in": {"$add": ["$$value", {"$cond": [
            {"$eq": ["$$this.financial_impact_complete", True]},
            {"$abs": {"$ifNull": ["$$this.financial_impact_cents", 0]}}, 0,
        ]}]},
    }}
    legacy_divergence = {"$cond": [
        {"$gt": [{"$size": {"$ifNull": ["$lines", []]}}, 0]},
        line_divergence,
        {"$abs": {"$ifNull": ["$financial_impact_cents", 0]}},
    ]}
    gross_divergence = {"$ifNull": ["$financial_divergence_cents", legacy_divergence]}
    count_rows = list(db.counts.aggregate([
        {"$match": {"restaurant_id": principal.restaurant_id, "status": "approved",
                     "approved_at": {"$gte": month_start, "$lt": month_end}}},
        {"$group": {"_id": None, "approved_count": {"$sum": 1},
            "unknown_financial_count": {"$sum": {"$cond": [
                {"$eq": ["$financial_impact_complete", True]}, 0, 1,
            ]}},
            "divergence_cents": {"$sum": {"$cond": [
                {"$eq": ["$financial_impact_complete", True]},
                gross_divergence, 0,
            ]}},
        }},
    ]))
    latest_count = db.counts.find_one({"restaurant_id": principal.restaurant_id, "status": "approved",
        "approved_at": {"$gte": month_start, "$lt": month_end}},
        sort=[("approved_at", -1), ("_id", -1)])
    last_count_insight = None
    if latest_count:
        counted_lines = [line for line in latest_count.get("lines", [])
                         if line.get("counted_quantity") is not None
                         or line.get("counted_quantity_milli") is not None]
        if counted_lines:
            def line_delta(line):
                expected = line.get("expected_quantity_milli")
                expected = quantity_milli(line.get("expected_quantity", 0)) if expected is None else int(expected)
                counted = line.get("counted_quantity_milli")
                counted = quantity_milli(line.get("counted_quantity", 0)) if counted is None else int(counted)
                return counted - expected

            biggest_line = max(counted_lines, key=lambda line: abs(line_delta(line)))
            ingredient = db.ingredients.find_one({"_id": biggest_line["ingredient_id"],
                "restaurant_id": principal.restaurant_id}, {"name": 1, "base_unit": 1})
            if ingredient:
                impact_complete = latest_count.get("financial_impact_complete") is True
                impact = latest_count.get("financial_impact_cents") if impact_complete else None
                divergence = latest_count.get("financial_divergence_cents")
                if divergence is None and impact_complete:
                    priced_lines = [line for line in latest_count.get("lines", [])
                                    if line.get("financial_impact_complete") is True]
                    divergence = (sum(abs(int(line.get("financial_impact_cents") or 0))
                                      for line in priced_lines)
                                  if priced_lines else abs(int(impact or 0)))
                last_count_insight = {
                    "id": latest_count["_id"], "code": latest_count.get("code", latest_count["_id"]),
                    "approved_at": utc_datetime(latest_count["approved_at"]),
                    "ingredient_name": ingredient["name"],
                    "unit": ingredient["base_unit"], "difference_milli": line_delta(biggest_line),
                    "impact_cents": abs(int(impact or 0)) if impact_complete else None,
                    "divergence_cents": int(divergence or 0) if impact_complete else None,
                    "impact_complete": impact_complete,
                }
    loss = loss_rows[0] if loss_rows else {}
    top_reason = next((row for row in top_reason_rows if int(row.get("value_cents", 0)) > 0), None)
    counts = count_rows[0] if count_rows else {}
    return {
        "losses": {"count": int(loss.get("count", 0)),
            "priced_count": int(loss.get("priced_count", 0)),
            "unpriced_count": int(loss.get("count", 0) - loss.get("priced_count", 0)),
            "value_cents": int(loss.get("value_cents", 0)),
            "week_value_cents": int((week_loss_rows[0] if week_loss_rows else {}).get("value_cents", 0)),
            "reason_totals": reason_totals,
            "top_item": top_item,
            "top_month_reason": ({"reason": top_reason["_id"], "value_cents": int(top_reason["value_cents"])}
                if top_reason else None)},
        "counts": {"approved_count": int(counts.get("approved_count", 0)),
            "unknown_financial_count": int(counts.get("unknown_financial_count", 0)),
            "divergence_cents": int(counts.get("divergence_cents", 0)),
            "last_divergence": last_count_insight},
    }


def list_loss_month_page(db, principal: Principal, *, limit: int = 50, offset: int = 0,
                         reason: str | None = None) -> dict:
    """Page current business-month losses without loading the tenant's full loss history."""
    reference = now().astimezone(timezone(timedelta(hours=-3)))
    month_start = reference.replace(day=1, hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    next_month = (reference.replace(day=28) + timedelta(days=4)).replace(
        day=1, hour=0, minute=0, second=0, microsecond=0,
    ).astimezone(timezone.utc)
    query = {"restaurant_id": principal.restaurant_id,
             "occurred_at": {"$gte": month_start, "$lt": next_month}}
    if reason:
        query["reason"] = reason
    total = db.losses.count_documents(query)
    items = list(db.losses.find(query).sort([("occurred_at", -1), ("_id", -1)])
        .skip(offset).limit(limit))
    return {"items": items, "total": total, "has_more": offset + len(items) < total}


def get_loss(db, principal: Principal, loss_id: str) -> dict:
    loss = db.losses.find_one({"_id": loss_id, "restaurant_id": principal.restaurant_id})
    if loss is None:
        raise HTTPException(status_code=404, detail="Loss not found")
    return loss


def count_insights(db, principal: Principal) -> dict:
    """Tenant-scoped lifetime summary for the count history list."""
    tenant = principal.restaurant_id
    statuses = list(db.counts.aggregate([
        {"$match": {"restaurant_id": tenant}},
        {"$group": {"_id": "$status", "count": {"$sum": 1}}},
    ]))
    line_divergence = {"$reduce": {
        "input": {"$ifNull": ["$lines", []]}, "initialValue": 0,
        "in": {"$add": ["$$value", {"$cond": [
            {"$eq": ["$$this.financial_impact_complete", True]},
            {"$abs": {"$ifNull": ["$$this.financial_impact_cents", 0]}}, 0,
        ]}]},
    }}
    legacy_divergence = {"$cond": [
        {"$gt": [{"$size": {"$ifNull": ["$lines", []]}}, 0]},
        line_divergence,
        {"$abs": {"$ifNull": ["$financial_impact_cents", 0]}},
    ]}
    gross_divergence = {"$ifNull": ["$financial_divergence_cents", legacy_divergence]}
    approved_rows = list(db.counts.aggregate([
        {"$match": {"restaurant_id": tenant, "status": "approved"}},
        {"$group": {"_id": None,
            "unknown_financial_count": {"$sum": {"$cond": [
                {"$eq": ["$financial_impact_complete", True]}, 0, 1,
            ]}},
            "divergence_cents": {"$sum": {"$cond": [
                {"$eq": ["$financial_impact_complete", True]},
                gross_divergence, 0,
            ]}},
        }},
    ]))
    latest_open = db.counts.find_one({"restaurant_id": tenant, "status": "open"},
        sort=[("created_at", -1), ("_id", -1)])
    return {"status_counts": {row["_id"]: int(row["count"]) for row in statuses if row.get("_id")},
        "unknown_financial_count": int((approved_rows[0] if approved_rows else {}).get("unknown_financial_count", 0)),
        "divergence_cents": int((approved_rows[0] if approved_rows else {}).get("divergence_cents", 0)),
        "latest_open": latest_open}


def get_count(db, principal: Principal, count_id: str) -> dict:
    count = db.counts.find_one({"_id": count_id, "restaurant_id": principal.restaurant_id})
    if count is None:
        raise HTTPException(status_code=404, detail="Count not found")
    return count


def replenishment_recommendations(db, principal: Principal, limit: int = 5) -> dict:
    """Server-calculated minimum-stock purchases for active ingredients in this tenant."""
    quantity_milli_expr = {"$ifNull": ["$current_quantity_milli",
                                        {"$round": [{"$multiply": ["$current_quantity", 1000]}]}]}
    minimum_milli_expr = {"$ifNull": ["$min_quantity_milli",
                                      {"$round": [{"$multiply": ["$min_quantity", 1000]}]}]}
    base_query = {"restaurant_id": principal.restaurant_id, "active": {"$ne": False},
                  "$expr": {"$lt": [quantity_milli_expr, minimum_milli_expr]}}
    total = db.ingredients.count_documents(base_query)
    ingredient_fields = ("_id", "restaurant_id", "name", "name_normalized", "category", "base_unit",
        "current_quantity", "current_quantity_milli", "min_quantity", "min_quantity_milli", "cost_cents",
        "primary_supplier_id", "updated_at", "active", "internal_code", "barcode", "conversions",
        "cost_updated_at", "cost_known", "version")
    ingredients = list(db.ingredients.aggregate([
        {"$match": base_query},
        {"$addFields": {"_recommendation_quantity_milli": quantity_milli_expr,
            "_recommendation_minimum_milli": minimum_milli_expr}},
        {"$addFields": {
            "_recommendation_priority": {"$switch": {"branches": [
                {"case": {"$lte": ["$_recommendation_quantity_milli", 0]}, "then": 0},
                {"case": {"$lt": [{"$multiply": ["$_recommendation_quantity_milli", 2]},
                                    "$_recommendation_minimum_milli"]}, "then": 1},
            ], "default": 2}},
            "_recommendation_shortage_ratio": {"$divide": [
                {"$subtract": ["$_recommendation_minimum_milli", "$_recommendation_quantity_milli"]},
                {"$max": ["$_recommendation_minimum_milli", 1]},
            ]},
        }},
        {"$sort": {"_recommendation_priority": 1, "_recommendation_shortage_ratio": -1,
                    "name_normalized": 1, "_id": 1}},
        {"$limit": limit},
        {"$project": {"_recommendation_quantity_milli": 0, "_recommendation_minimum_milli": 0,
                       "_recommendation_priority": 0, "_recommendation_shortage_ratio": 0}},
    ]))
    supplier_ids = list({item.get("primary_supplier_id") for item in ingredients
                         if item.get("primary_supplier_id")})
    suppliers = {supplier["_id"]: supplier for supplier in db.suppliers.find({
        "restaurant_id": principal.restaurant_id, "_id": {"$in": supplier_ids},
    })} if supplier_ids else {}

    recommendations = []
    for ingredient in ingredients:
        current_milli = int(ingredient.get("current_quantity_milli",
            quantity_milli(ingredient.get("current_quantity", 0))))
        minimum_milli = int(ingredient.get("min_quantity_milli",
            quantity_milli(ingredient.get("min_quantity", 0))))
        stock_status = ("empty" if current_milli <= 0 else
                        "critical" if current_milli * 2 < minimum_milli else "attention")
        shortage = Decimal(minimum_milli - current_milli) / Decimal(QUANTITY_SCALE)
        unit = ingredient["base_unit"].lower()
        if unit == "un":
            recommended = shortage.to_integral_value(rounding=ROUND_CEILING)
        elif unit in {"g", "ml"}:
            recommended = (shortage / Decimal(50)).to_integral_value(rounding=ROUND_CEILING) * Decimal(50)
        else:
            recommended = (shortage * 2).to_integral_value(rounding=ROUND_CEILING) / Decimal(2)
        recommended = max(recommended, Decimal(0))
        cost = int(ingredient.get("cost_cents", 0))
        estimated = int((recommended * cost).quantize(Decimal("1"), rounding=ROUND_HALF_UP)) if ingredient_cost_known(ingredient) else None
        supplier = suppliers.get(ingredient.get("primary_supplier_id"))
        recommendations.append({
            "ingredient": ingredient,
            "basis": "minimum",
            "stock_status": stock_status,
            "avg_daily_consumption": 0,
            "days_remaining": 0,
            "lead_time_days": int((supplier or {}).get("avg_lead_time_days", 0)),
            "coverage_days": 0,
            "safety_quantity": 0,
            "recommended_quantity": float(recommended),
            "estimated_cost_cents": estimated,
        })
    return {"items": recommendations, "total": total}


def purchase_insights(db, principal: Principal) -> dict:
    """Small tenant-scoped aggregates used by the dashboard and supplier summaries."""
    tenant = principal.restaurant_id
    reference = now()
    # The product currently presents dates in Brazil's fixed UTC-3 business timezone.
    local_reference = reference.astimezone(timezone(timedelta(hours=-3)))
    month_start = local_reference.replace(day=1, hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    next_month_local = (month_start.astimezone(timezone(timedelta(hours=-3)))
                        .replace(day=28) + timedelta(days=4))
    next_month_local = next_month_local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    month_end = next_month_local.astimezone(timezone.utc)
    statuses = list(db.purchases.aggregate([
        {"$match": {"restaurant_id": tenant}},
        {"$group": {"_id": "$status", "count": {"$sum": 1}}},
    ]))
    month_rows = list(db.purchases.aggregate([
        {"$match": {"restaurant_id": tenant, "status": {"$ne": "cancelled"},
                     "created_at": {"$gte": month_start, "$lt": month_end}}},
        {"$project": {"line_totals": {"$map": {"input": "$lines", "as": "line",
            "in": {"$floor": {"$add": [{"$divide": [
                {"$multiply": [{"$ifNull": ["$$line.quantity_ordered_milli",
                    {"$round": [{"$multiply": ["$$line.quantity_ordered", 1000]}]}]},
                    "$$line.expected_unit_cost_cents"]}, 1000]}, 0.5]}}}}}},
        {"$group": {"_id": None, "order_count": {"$sum": 1},
                     "expected_total_cents": {"$sum": {"$sum": "$line_totals"}}}},
    ]))
    supplier_orders = list(db.purchases.aggregate([
        {"$match": {"restaurant_id": tenant, "supplier_id": {"$exists": True, "$ne": None}}},
        {"$group": {"_id": "$supplier_id", "order_count": {"$sum": 1}}},
    ]))
    cutoff = reference - timedelta(days=90)
    reversal_lookup = {"$lookup": {"from": "movements", "let": {"movement_id": "$_id"},
        "pipeline": [{"$match": {"restaurant_id": tenant,
            "$expr": {"$eq": ["$reversal_of", "$$movement_id"]}}}, {"$limit": 1}],
        "as": "_reversals"}}
    receipts = list(db.movements.aggregate([
        {"$match": {"restaurant_id": tenant, "kind": "purchase",
            "supplier_id": {"$exists": True, "$ne": None}}},
        reversal_lookup, {"$match": {"_reversals": {"$eq": []}}},
        {"$sort": {"occurred_at": -1, "_id": -1}},
        {"$group": {"_id": "$supplier_id", "last_at": {"$first": "$occurred_at"},
            "purchase_id": {"$first": "$purchase_reference"},
            "recent_value_cents": {"$sum": {"$cond": [
                {"$gte": ["$occurred_at", cutoff]},
                {"$floor": {"$add": [{"$divide": [{"$multiply": [
                    {"$ifNull": ["$quantity_milli", {"$round": [{"$multiply": ["$quantity", 1000]}]}]},
                    {"$ifNull": ["$unit_cost_cents", 0]}]}, 1000]}, 0.5]}}, 0]}}}},
        {"$lookup": {"from": "purchases", "let": {"purchase_id": "$purchase_id"},
            "pipeline": [{"$match": {"restaurant_id": tenant,
                "$expr": {"$eq": ["$_id", "$$purchase_id"]}}},
                {"$project": {"_id": 0, "code": 1}}], "as": "_purchase"}},
        {"$project": {"_reversals": 0}},
    ]))
    supplier_summary = {}
    for row in supplier_orders:
        supplier_summary[row["_id"]] = {"order_count": row["order_count"],
            "recent_received_value_cents": 0, "last_receipt_at": None, "last_receipt_code": None}
    for row in receipts:
        item = supplier_summary.setdefault(row["_id"], {"order_count": 0,
            "recent_received_value_cents": 0, "last_receipt_at": None, "last_receipt_code": None})
        item["recent_received_value_cents"] = row.get("recent_value_cents", 0)
        item["last_receipt_at"] = row.get("last_at")
        item["last_receipt_code"] = (row.get("_purchase") or [{}])[0].get("code")
    month = month_rows[0] if month_rows else {"order_count": 0, "expected_total_cents": 0}
    received_month_rows = list(db.movements.aggregate([
        {"$match": {"restaurant_id": tenant, "kind": "purchase",
                     "occurred_at": {"$gte": month_start, "$lt": month_end}}},
        {"$lookup": {"from": "movements", "let": {"movement_id": "$_id"},
            "pipeline": [{"$match": {"restaurant_id": tenant,
                "$expr": {"$eq": ["$reversal_of", "$$movement_id"]}}}, {"$limit": 1}],
            "as": "_reversals"}},
        {"$match": {"_reversals": {"$eq": []}}},
        {"$group": {"_id": None,
            "received_total_cents": {"$sum": {"$cond": [
                {"$ne": [{"$ifNull": ["$unit_cost_cents", None]}, None]},
                {"$floor": {"$add": [{"$divide": [{"$multiply": [
                    {"$ifNull": ["$quantity_milli", {"$round": [{"$multiply": ["$quantity", 1000]}]}]},
                    "$unit_cost_cents"]}, 1000]}, 0.5]}}, 0]}},
            "received_unpriced_count": {"$sum": {"$cond": [
                {"$eq": [{"$ifNull": ["$unit_cost_cents", None]}, None]}, 1, 0]}},
        }},
    ]))
    received_month = received_month_rows[0] if received_month_rows else {
        "received_total_cents": 0, "received_unpriced_count": 0}
    return {"status_counts": {row["_id"]: row["count"] for row in statuses},
        "month": {"order_count": month["order_count"],
                  "expected_total_cents": month["expected_total_cents"],
                  "received_total_cents": received_month["received_total_cents"],
                  "received_unpriced_count": received_month["received_unpriced_count"]},
        "suppliers": supplier_summary}


def fingerprint(value: dict) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def stock_audit_event(movement: dict, ingredient_name: str) -> dict:
    return {
        "_id": f"audit_{movement['_id']}",
        "restaurant_id": movement["restaurant_id"],
        "user_id": movement["actor_id"],
        "action": "stock.consumption" if movement["kind"] == "consumption_by_order" else "stock.adjust",
        "entity": "item",
        "entity_label": ingredient_name,
        "before": str(movement["balance_before"]),
        "after": str(movement["balance_after"]),
        "reason": movement["reason"],
        "at": movement["occurred_at"],
        "source_type": "movement",
        "source_id": movement["_id"],
    }


def recipe_insights(db, principal: Principal) -> dict:
    """Summarize recipe cost snapshots without transferring the full catalog."""
    pipeline = [
        {"$match": {"restaurant_id": principal.restaurant_id}},
        {"$lookup": {
            "from": "recipe_snapshots",
            "let": {"product_id": "$product_id", "tenant_id": "$restaurant_id"},
            "pipeline": [
                {"$match": {"$expr": {"$and": [
                    {"$eq": ["$product_id", "$$product_id"]},
                    {"$eq": ["$restaurant_id", "$$tenant_id"]},
                ]}}},
                {"$sort": {"occurred_at": -1, "_id": -1}},
                {"$limit": 1},
            ],
            "as": "_latest_snapshot",
        }},
        {"$addFields": {"_latest_snapshot": {"$arrayElemAt": ["$_latest_snapshot", 0]}}},
        {"$addFields": {
            "_active": {"$ne": [{"$ifNull": ["$active", True]}, False]},
            "_calculable": {"$and": [
                {"$eq": [{"$ifNull": ["$_latest_snapshot.cost_complete", False]}, True]},
                {"$gt": [{"$ifNull": ["$_latest_snapshot.sale_price_cents", 0]}, 0]},
            ]},
            "_cost_ratio": {"$cond": [
                {"$and": [
                    {"$eq": [{"$ifNull": ["$_latest_snapshot.cost_complete", False]}, True]},
                    {"$gt": [{"$ifNull": ["$_latest_snapshot.sale_price_cents", 0]}, 0]},
                ]},
                {"$divide": ["$_latest_snapshot.cost_cents", "$_latest_snapshot.sale_price_cents"]},
                0,
            ]},
        }},
        {"$group": {
            "_id": None,
            "total": {"$sum": 1},
            "active_count": {"$sum": {"$cond": ["$_active", 1, 0]}},
            "calculable_count": {"$sum": {"$cond": ["$_calculable", 1, 0]}},
            "cost_ratio_sum": {"$sum": "$_cost_ratio"},
            "attention_count": {"$sum": {"$cond": [
                {"$and": ["$_calculable", {"$gt": ["$_cost_ratio", 0.35]}]}, 1, 0,
            ]}},
        }},
        {"$project": {"_id": 0, "total": 1, "active_count": 1,
            "calculable_count": 1, "attention_count": 1,
            "incomplete_count": {"$subtract": ["$total", "$calculable_count"]},
            "average_cost_ratio": {"$cond": [
                {"$gt": ["$calculable_count", 0]},
                {"$divide": ["$cost_ratio_sum", "$calculable_count"]}, 0,
            ]}}},
    ]
    rows = list(db.recipes.aggregate(pipeline))
    return rows[0] if rows else {"total": 0, "active_count": 0, "calculable_count": 0,
        "attention_count": 0, "incomplete_count": 0, "average_cost_ratio": 0}


def get_recipe(db, principal: Principal, product_id: str) -> dict:
    recipe = db.recipes.find_one({"restaurant_id": principal.restaurant_id, "product_id": product_id})
    if not recipe:
        raise HTTPException(status_code=404, detail="Recipe not found")
    return recipe


def global_search(db, principal: Principal, query: str, per_group: int = 20) -> list[dict]:
    """Return a bounded, tenant-scoped search index for the global command menu."""
    term = query.strip()[:100]
    if len(term) < 2:
        return []
    def normalize_text(value: str) -> str:
        return "".join(character for character in unicodedata.normalize("NFD", value.casefold())
                       if unicodedata.category(character) != "Mn")

    accents = {"a": "aáàâãä", "e": "eéèêë", "i": "iíìîï", "o": "oóòôõö",
        "u": "uúùûü", "c": "cç", "n": "nñ"}
    tokens = normalize_text(term).split()

    def token_regex(token: str) -> str:
        return "".join(f"[{accents[character]}]" if character in accents else re.escape(character)
                       for character in token)

    def candidate_query(fields: tuple[str, ...]) -> dict:
        return {"$or": [{field: {"$regex": token_regex(token), "$options": "i"}}
                        for token in tokens for field in fields]}

    def all_terms_query(fields: tuple[str, ...]) -> dict:
        return {"$and": [
            {"$or": [{field: {"$regex": token_regex(token), "$options": "i"}}
                     for field in fields]}
            for token in tokens
        ]}

    def record_has_all_terms(values: list[str]) -> bool:
        text = normalize_text(" ".join(value for value in values if value))
        return all(token in text for token in tokens)

    tenant = principal.restaurant_id
    results: list[dict] = []

    def add(group: str, identifier: str, title: str, subtitle: str, href: str,
            searchable: list[str], status: str | None = None):
        results.append({"id": identifier, "group": group, "title": title, "subtitle": subtitle,
            "href": href, "searchable": " ".join(value for value in searchable if value),
            **({"status": status} if status else {})})

    item_fields = ("name_normalized", "name", "category", "internal_code", "barcode")
    item_query = {"restaurant_id": tenant, **candidate_query(item_fields)}
    item_candidates = list(db.ingredients.find(item_query).sort([("name", 1), ("_id", 1)]).limit(100))
    items_by_id = {item["_id"]: item for item in item_candidates}
    matched_items = [item for item in item_candidates if record_has_all_terms([
        item.get("name", ""), item.get("_id", ""), item.get("category", ""),
        item.get("base_unit", ""), item.get("internal_code", ""), item.get("barcode", "")])]
    for item in matched_items[:per_group]:
        current = Decimal(str(item.get("current_quantity", 0)))
        minimum = Decimal(str(item.get("min_quantity", 0)))
        status = ("empty" if current <= Decimal("0.0001") else
                  "critical" if current < minimum * Decimal("0.5") else
                  "attention" if current < minimum else
                  "near_minimum" if minimum > 0 and current < minimum * Decimal("1.25") else None)
        add("Estoque", f"item:{item['_id']}", item.get("name", "Insumo"),
            f"{item.get('category', 'Outros')} · {item.get('current_quantity', 0)} {item.get('base_unit', 'un')}",
            f"/estoque/{item['_id']}", [item.get("name", ""), item.get("_id", ""),
                item.get("category", ""), item.get("base_unit", ""), item.get("internal_code", ""),
                item.get("barcode", "")], status)

    supplier_fields = ("name", "name_normalized", "contact", "phone", "whatsapp", "notes")
    supplier_query = {"restaurant_id": tenant, **candidate_query(supplier_fields)}
    supplier_candidates = list(db.suppliers.find(supplier_query).sort([("name", 1), ("_id", 1)]).limit(100))
    suppliers_by_id = {supplier["_id"]: supplier for supplier in supplier_candidates}
    matched_suppliers = [supplier for supplier in supplier_candidates if record_has_all_terms([
        supplier.get(field, "") for field in supplier_fields] + [supplier.get("_id", "")])]
    for supplier in matched_suppliers[:per_group]:
        add("Fornecedores", f"supplier:{supplier['_id']}", supplier.get("name", "Fornecedor"),
            "Fornecedor", f"/fornecedores/{supplier['_id']}", [supplier.get("name", ""),
                supplier.get("_id", ""), supplier.get("contact", ""), supplier.get("phone", ""),
                supplier.get("whatsapp", ""), supplier.get("notes", "")])

    matched_item_ids = list(items_by_id)
    recipe_query = {"restaurant_id": tenant, "$or": [
        all_terms_query(("product_name", "product_id")),
        {"lines.ingredient_id": {"$in": matched_item_ids}},
    ]}
    recipes = list(db.recipes.find(recipe_query).sort([("product_name", 1), ("_id", 1)]).limit(per_group))
    for recipe in recipes:
        ingredient_names = [items_by_id[line.get("ingredient_id")]["name"]
            for line in recipe.get("lines", []) if line.get("ingredient_id") in items_by_id]
        add("Fichas técnicas", f"recipe:{recipe['product_id']}", recipe.get("product_name", "Ficha técnica"),
            f"Ficha técnica · {len(recipe.get('lines', []))} ingredientes", f"/fichas/{recipe['product_id']}",
            [recipe.get("product_name", ""), recipe.get("product_id", ""), *ingredient_names])

    linked_item_ids = matched_item_ids
    linked_supplier_ids = list(suppliers_by_id)
    purchase_query = {"restaurant_id": tenant, "$or": [
        all_terms_query(("code", "_id", "note")),
        {"supplier_id": {"$in": linked_supplier_ids}},
        {"lines.ingredient_id": {"$in": linked_item_ids}},
    ]}
    purchases = list(db.purchases.find(purchase_query).sort([("created_at", -1), ("_id", -1)]).limit(per_group))
    for purchase in purchases:
        supplier = suppliers_by_id.get(purchase.get("supplier_id"))
        item_names = [items_by_id[line.get("ingredient_id")]["name"]
            for line in purchase.get("lines", []) if line.get("ingredient_id") in items_by_id]
        status_label = {"draft": "Rascunho", "requested": "Solicitada", "partial": "Parcial",
            "received": "Recebida", "cancelled": "Cancelada"}.get(purchase.get("status"), "Compra")
        code = purchase.get("code", purchase.get("_id", "Compra"))
        add("Compras", f"purchase:{purchase['_id']}", f"{code} · {supplier.get('name', 'Fornecedor') if supplier else 'Fornecedor'}",
            f"Compra · {status_label}", f"/compras/{purchase['_id']}",
            [code, purchase.get("_id", ""), supplier.get("name", "") if supplier else "",
                purchase.get("note", ""), status_label, *item_names])

    count_query = {"restaurant_id": tenant, "$or": [
        all_terms_query(("code", "_id")),
        {"lines.ingredient_id": {"$in": linked_item_ids}},
    ]}
    counts = list(db.counts.find(count_query).sort([("created_at", -1), ("_id", -1)]).limit(per_group))
    for count in counts:
        label = {"open": "Em andamento", "review": "Em revisão", "approved": "Aprovada"}.get(
            count.get("status"), "Contagem")
        item_names = [items_by_id[line.get("ingredient_id")]["name"]
            for line in count.get("lines", []) if line.get("ingredient_id") in items_by_id]
        code = count.get("code", count.get("_id", "Contagem"))
        add("Contagens", f"count:{count['_id']}", code, f"Contagem · {label}",
            f"/contagem/{count['_id']}", [code, count.get("_id", ""), *item_names, label])

    loss_query = {"restaurant_id": tenant, "$or": [
        all_terms_query(("reason", "note", "_id")),
        {"ingredient_id": {"$in": linked_item_ids}},
    ]}
    losses = list(db.losses.find(loss_query).sort([("occurred_at", -1), ("_id", -1)]).limit(per_group))
    for loss in losses:
        item = items_by_id.get(loss.get("ingredient_id"), {})
        occurred = loss.get("occurred_at")
        date_label = utc_datetime(occurred).strftime("%d/%m/%Y") if isinstance(occurred, datetime) else ""
        name = item.get("name", "Insumo")
        reason = loss.get("reason", "Perda")
        add("Perdas & movimentos", f"loss:{loss['_id']}", f"{name} · {reason}",
            f"Perda · {date_label}", f"/perdas?focus={loss['_id']}",
            [loss.get("_id", ""), name, item.get("category", ""), reason, loss.get("note", ""), date_label])

    movement_query = {"restaurant_id": tenant, "$or": [
        all_terms_query(("reason", "purchase_reference", "_id")),
        {"ingredient_id": {"$in": linked_item_ids}},
    ]}
    movements = list(db.movements.find(movement_query).sort([("occurred_at", -1), ("_id", -1)]).limit(per_group))
    type_labels = {"purchase": "Compra", "adjustment_in": "Entrada manual", "adjustment_out": "Saída manual",
        "count_in": "Ajuste de inventário", "count_out": "Ajuste de inventário", "loss": "Perda"}
    for movement in movements:
        item = items_by_id.get(movement.get("ingredient_id"), {})
        occurred = movement.get("occurred_at")
        date_label = utc_datetime(occurred).strftime("%d/%m/%Y") if isinstance(occurred, datetime) else ""
        name = item.get("name", "Insumo")
        label = type_labels.get(movement.get("kind"), "Movimentação")
        add("Perdas & movimentos", f"movement:{movement['_id']}", name,
            f"Movimentação · {label} · {date_label}", f"/estoque/{movement.get('ingredient_id', '')}",
            [movement.get("_id", ""), name, item.get("category", ""), movement.get("reason", ""),
                movement.get("purchase_reference", ""), label, date_label])

    return results


def record_audit_event(db, *, event_id: str, tenant: str, user_id: str, action: str,
                       entity: str, label: str, before: str | None, after: str | None,
                       reason: str, occurred_at: datetime, source_type: str,
                       source_id: str, session=None) -> str | None:
    collection = getattr(db, "audit_events", None)
    if collection is None:
        return None
    collection.insert_one({
        "_id": event_id, "restaurant_id": tenant, "user_id": user_id,
        "action": action, "entity": entity, "entity_label": label,
        "before": before, "after": after, "reason": reason, "at": occurred_at,
        "source_type": source_type, "source_id": source_id,
    }, session=session)
    return event_id


def _catalog_snapshot(fields: dict, source: dict | None = None) -> str | None:
    ignored = {"name_normalized", "min_quantity_milli", "cost_updated_at", "updated_at", "updated_by"}
    values = {key: (source or {}).get(key) if source is not None else value
              for key, value in fields.items() if key not in ignored and key not in {"notes", "phone", "whatsapp", "contact"}}
    return json.dumps(values, ensure_ascii=False, sort_keys=True, default=str) if values else None


def _freeze_legacy_recipe_conversion(db, ingredient: dict, principal: Principal,
                                     ingredient_id: str, session) -> None:
    """Capture pre-change conversion factors on recipes created before factors were stored."""
    for recipe in db.recipes.find({
        "restaurant_id": principal.restaurant_id,
        "lines.ingredient_id": ingredient_id,
    }, session=session):
        changed = False
        lines = []
        for line in recipe.get("lines", []):
            saved_line = dict(line)
            if saved_line.get("ingredient_id") == ingredient_id \
                    and "conversion_to_base" not in saved_line:
                saved_line["conversion_to_base"] = conversion_factor(ingredient, saved_line["unit"])
                changed = True
            lines.append(saved_line)
        if changed:
            version = int(recipe.get("version", 1))
            version_filter = ({"version": version} if "version" in recipe
                              else {"version": {"$exists": False}})
            timestamp = now()
            event_id = record_audit_event(db,
                event_id=f"audit_recipe_conversion_freeze:{uuid4().hex}",
                tenant=principal.restaurant_id, user_id=principal.user_id,
                action="recipe.conversion.freeze", entity="recipe",
                label=recipe["product_name"],
                before=_catalog_snapshot({"lines": recipe["lines"]}),
                after=_catalog_snapshot({"lines": lines}),
                reason="Fator de conversão legado congelado antes da alteração do insumo",
                occurred_at=timestamp, source_type="recipe",
                source_id=recipe["_id"], session=session)
            update = {"$set": {"lines": lines, "updated_at": timestamp,
                               "updated_by": principal.user_id,
                               "version": version + 1}}
            if event_id:
                update["$set"]["conversion_audit_event_id"] = event_id
            result = db.recipes.update_one(
                {"_id": recipe["_id"], "restaurant_id": principal.restaurant_id,
                 **version_filter},
                update, session=session,
            )
            if result.matched_count != 1:
                raise HTTPException(status_code=409,
                    detail="Recipe changed while its legacy unit conversion was being frozen")


def ingredient_document(data: IngredientCreate, principal: Principal) -> dict:
    timestamp = now()
    cost_known = data.cost_known if data.cost_known is not None else data.cost_cents > 0
    return {
        "_id": f"ing_{uuid4().hex}",
        "restaurant_id": principal.restaurant_id,
        "created_by": principal.user_id,
        "name": data.name.strip(),
        "name_normalized": data.name.strip().casefold(),
        "category": data.category,
        "base_unit": data.base_unit,
        "current_quantity": 0.0,
        "current_quantity_milli": 0,
        "min_quantity": quantity_from_milli(quantity_milli(data.min_quantity)),
        "min_quantity_milli": quantity_milli(data.min_quantity),
        "cost_cents": data.cost_cents,
        "cost_known": cost_known,
        "primary_supplier_id": data.primary_supplier_id,
        "conversions": data.conversions,
        "internal_code": data.internal_code,
        "barcode": data.barcode,
        "notes": data.notes,
        "cost_updated_at": timestamp if cost_known else None,
        "active": True,
        "version": 1,
        "stock_version": 0,
        "created_at": timestamp,
        "updated_at": timestamp,
    }


def create_ingredient(db, data: IngredientCreate, principal: Principal,
                      idempotency_key: str | None = None) -> dict:
    request_hash = fingerprint(data.model_dump(mode="json")) if idempotency_key is not None else None
    if idempotency_key is not None:
        if not idempotency_key.strip() or len(idempotency_key) > 200:
            raise HTTPException(status_code=422, detail="A valid Idempotency-Key is required")
        prior = db.ingredients.find_one({"restaurant_id": principal.restaurant_id,
                                         "idempotency_key": idempotency_key})
        if prior is not None:
            if prior.get("request_fingerprint") != request_hash:
                raise HTTPException(status_code=409, detail="Idempotency key was already used for another ingredient")
            return prior
    if data.primary_supplier_id and db.suppliers.find_one({"_id": data.primary_supplier_id,
                                                           "restaurant_id": principal.restaurant_id,
                                                           "active": True}) is None:
        raise HTTPException(status_code=422, detail="Supplier not found or inactive")
    doc = ingredient_document(data, principal)
    if idempotency_key is not None:
        doc["idempotency_key"] = idempotency_key
        doc["request_fingerprint"] = request_hash
    def create(session):
        if idempotency_key is not None:
            prior = db.ingredients.find_one({"restaurant_id": principal.restaurant_id,
                "idempotency_key": idempotency_key}, session=session)
            if prior is not None:
                if prior.get("request_fingerprint") != request_hash:
                    raise HTTPException(status_code=409,
                        detail="Idempotency key was already used for another ingredient")
                doc.clear()
                doc.update(prior)
                return prior
        event_id = record_audit_event(db, event_id=f"audit_ingredient_create:{doc['_id']}",
            tenant=principal.restaurant_id, user_id=principal.user_id, action="ingredient.update",
            entity="item", label=doc["name"], before=None,
            after=_catalog_snapshot({"name": doc["name"], "category": doc["category"],
                "base_unit": doc["base_unit"], "min_quantity": doc["min_quantity"],
                "cost_cents": doc["cost_cents"], "cost_known": doc["cost_known"], "initial_quantity": data.initial_quantity,
                "conversions": doc["conversions"]}), reason="Cadastro de insumo",
            occurred_at=doc["created_at"], source_type="ingredient", source_id=doc["_id"], session=session)
        if event_id:
            doc["created_audit_event_id"] = event_id
        db.ingredients.insert_one(doc, session=session)
        if data.initial_quantity:
            initial = MovementCreate(kind="adjustment_in", quantity=data.initial_quantity,
                                     unit_cost_cents=data.cost_cents, reason="Saldo inicial cadastrado",
                                     purchase_reference="INITIAL")
            _apply_movement(db, doc["_id"], initial, principal, f"initial:{doc['_id']}", session)
        return doc

    try:
        with db.client.start_session() as session:
            session.with_transaction(create)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            if idempotency_key is not None:
                prior = db.ingredients.find_one({"restaurant_id": principal.restaurant_id,
                    "idempotency_key": idempotency_key})
                if prior is not None and prior.get("request_fingerprint") == request_hash:
                    return prior
                if prior is not None:
                    raise HTTPException(status_code=409,
                        detail="Idempotency key was already used for another ingredient") from exc
            raise HTTPException(status_code=409, detail="Ingredient name already exists") from exc
        raise
    return db.ingredients.find_one({"_id": doc["_id"], "restaurant_id": principal.restaurant_id}) or doc


def update_ingredient(db, ingredient_id: str, data: IngredientUpdate, principal: Principal) -> dict:
    fields = data.model_dump(exclude_unset=True, exclude={"expected_version"})
    if not fields:
        raise HTTPException(status_code=422, detail="No fields to update")
    query = {"_id": ingredient_id, "restaurant_id": principal.restaurant_id}

    def update(session):
        prior = db.ingredients.find_one(query, session=session)
        if prior is None:
            raise HTTPException(status_code=404, detail="Ingredient not found")
        if "base_unit" in fields and fields["base_unit"].lower() != prior["base_unit"].lower() \
                and db.movements.count_documents({"restaurant_id": principal.restaurant_id,
                    "ingredient_id": ingredient_id}, session=session):
            raise HTTPException(status_code=409, detail="Base unit cannot change after stock movements exist")
        if "base_unit" in fields and fields["base_unit"].lower() != prior["base_unit"].lower() \
                and db.recipes.count_documents({"restaurant_id": principal.restaurant_id,
                    "lines.ingredient_id": ingredient_id}, session=session):
            raise HTTPException(status_code=409, detail="Base unit cannot change while recipes use this ingredient")
        changes = dict(fields)
        if "name" in changes:
            changes["name"] = changes["name"].strip()
            changes["name_normalized"] = changes["name"].casefold()
        if "primary_supplier_id" in changes and changes["primary_supplier_id"] is not None:
            if db.suppliers.find_one({"_id": changes["primary_supplier_id"],
                "restaurant_id": principal.restaurant_id, "active": True}, session=session) is None:
                raise HTTPException(status_code=422, detail="Supplier not found or inactive")
        if "min_quantity" in changes:
            changes["min_quantity_milli"] = quantity_milli(changes["min_quantity"])
            changes["min_quantity"] = quantity_from_milli(changes["min_quantity_milli"])
        semantic = {key: value for key, value in changes.items()
                    if key not in {"name_normalized", "min_quantity_milli"}}
        actual = {key: value for key, value in semantic.items() if prior.get(key) != value}
        if not actual:
            return prior
        current_version = int(prior.get("version", 1))
        if data.expected_version != current_version:
            raise HTTPException(status_code=409, detail="Ingredient changed since it was loaded; refresh and retry")
        if "conversions" in actual:
            _freeze_legacy_recipe_conversion(
                db, prior, principal, ingredient_id, session,
            )
        cost_semantics_changed = bool({"cost_cents", "cost_known"} & actual.keys())
        if cost_semantics_changed:
            if "cost_known" in changes:
                cost_known = changes["cost_known"]
            elif "cost_cents" in actual:
                # Older clients only send cost_cents; keep their historical zero=unknown rule.
                cost_known = int(changes["cost_cents"]) > 0
            else:
                cost_known = ingredient_cost_known(prior)
            changes["cost_known"] = cost_known
            changes["cost_updated_at"] = now() if cost_known else None
        timestamp = now()
        changes["updated_at"] = timestamp
        changes["updated_by"] = principal.user_id
        before = _catalog_snapshot(actual, prior)
        after = _catalog_snapshot(actual)
        event_id = record_audit_event(db, event_id=f"audit_ingredient_update:{uuid4().hex}",
            tenant=principal.restaurant_id, user_id=principal.user_id, action="ingredient.update",
            entity="item", label=changes.get("name", prior["name"]), before=before, after=after,
            reason="Cadastro de insumo atualizado", occurred_at=timestamp,
            source_type="ingredient", source_id=ingredient_id, session=session)
        if event_id:
            changes["updated_audit_event_id"] = event_id
        version_filter = {"version": current_version} if "version" in prior else {"version": {"$exists": False}}
        result = db.ingredients.find_one_and_update(
            {**query, **version_filter},
            {"$set": {**changes, "version": current_version + 1}},
            return_document=ReturnDocument.AFTER, session=session)
        if result is None:
            raise HTTPException(status_code=409, detail="Ingredient changed concurrently")
        if cost_semantics_changed:
            snapshot_recipes_using_ingredient(
                db, ingredient_id, principal, timestamp,
                "Custo de insumo atualizado manualmente", session,
            )
        return result

    try:
        with db.client.start_session() as session:
            return session.with_transaction(update)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            raise HTTPException(status_code=409, detail="Ingredient name already exists") from exc
        raise


def _apply_movement(db, ingredient_id: str, data: MovementCreate, principal: Principal,
                    idempotency_key: str, session, *, conversion_to_base=None) -> dict:
    query = {"_id": ingredient_id, "restaurant_id": principal.restaurant_id}
    count_reconciliation = data.kind in {"count_in", "count_out"}
    if not count_reconciliation:
        query["active"] = True
    ingredient = db.ingredients.find_one(query, session=session)
    if ingredient is None:
        exists = db.ingredients.find_one(
            {"_id": ingredient_id, "restaurant_id": principal.restaurant_id}, session=session
        )
        if exists is None:
            raise HTTPException(status_code=404, detail="Ingredient not found")
        raise HTTPException(status_code=409, detail="Ingredient inactive")
    entered_unit = (data.unit or ingredient["base_unit"]).lower()
    factor = Decimal(str(conversion_to_base if conversion_to_base is not None
                         else conversion_factor(ingredient, entered_unit)))
    quantity_milli_delta = quantity_milli(Decimal(str(data.quantity)) * factor)
    if quantity_milli_delta <= 0:
        raise HTTPException(status_code=422, detail="Quantity is below the stock precision of 0.001 base units")
    if quantity_milli_delta > MAX_STOCK_MILLI:
        raise HTTPException(status_code=422, detail="Converted quantity exceeds the supported stock range")
    sign = -1 if data.kind in {"adjustment_out", "consumption_by_order", "loss", "count_out"} else 1
    balance_before_milli = ingredient.get("current_quantity_milli")
    balance_before_milli = quantity_milli(ingredient["current_quantity"]) if balance_before_milli is None else int(balance_before_milli)
    if balance_before_milli < 0 or balance_before_milli > MAX_STOCK_MILLI:
        raise HTTPException(status_code=409, detail="Stored stock balance is outside the supported range")
    if data.expected_balance is not None and quantity_milli(data.expected_balance) != balance_before_milli:
        raise HTTPException(status_code=409, detail="Stock changed since it was loaded; refresh and retry")
    balance_after_milli = balance_before_milli + sign * quantity_milli_delta
    if balance_after_milli < 0:
        raise HTTPException(status_code=409, detail="Insufficient stock")
    if balance_after_milli > MAX_STOCK_MILLI:
        raise HTTPException(status_code=422, detail="Resulting stock balance exceeds the supported range")
    balance_guard = ({"current_quantity_milli": balance_before_milli}
        if "current_quantity_milli" in ingredient else {
            "current_quantity_milli": {"$exists": False}, "current_quantity": ingredient["current_quantity"]
        })
    update_query = {"_id": ingredient_id, "restaurant_id": principal.restaurant_id, **balance_guard}
    if not count_reconciliation:
        update_query["active"] = True
    updated = db.ingredients.find_one_and_update(
        update_query,
        {"$set": {"current_quantity_milli": balance_after_milli,
                  "current_quantity": quantity_from_milli(balance_after_milli), "updated_at": now()},
         "$inc": {"stock_version": 1}},
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
        "quantity": quantity_from_milli(quantity_milli_delta),
        "quantity_milli": quantity_milli_delta,
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
        "balance_before": quantity_from_milli(balance_before_milli),
        "balance_before_milli": balance_before_milli,
        "balance_after": updated["current_quantity"],
        "balance_after_milli": balance_after_milli,
        "stock_version_after": int(updated.get("stock_version", 1)),
    }
    audit_events = getattr(db, "audit_events", None)
    if audit_events is not None and data.kind != "loss" and not movement.get("purchase_reference"):
        event = stock_audit_event(movement, updated["name"])
        movement["audit_event_id"] = event["_id"]
        audit_events.insert_one(event, session=session)
    db.movements.insert_one(movement, session=session)
    return movement


def append_movement(db, ingredient_id: str, data: MovementCreate, principal: Principal, idempotency_key: str) -> dict:
    if not idempotency_key.strip() or len(idempotency_key) > 200:
        raise HTTPException(status_code=422, detail="A valid Idempotency-Key is required")
    if data.kind not in {"adjustment_in", "adjustment_out"}:
        raise HTTPException(status_code=422, detail="Only manual stock adjustments can use this endpoint")
    if data.supplier_id is not None or data.purchase_reference is not None:
        raise HTTPException(status_code=422, detail="Supplier and purchase references are reserved for purchase receipts")
    if data.unit_cost_cents is not None:
        raise HTTPException(status_code=422, detail="Manual stock adjustments cannot declare a purchase unit cost")
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


def reverse_manual_movement(db, movement_id: str, data: MovementReversal, principal: Principal,
                            idempotency_key: str) -> dict:
    """Create an auditable compensating movement for a manual stock correction."""
    if not idempotency_key.strip() or len(idempotency_key) > 200:
        raise HTTPException(status_code=422, detail="A valid Idempotency-Key is required")
    request_hash = fingerprint({"movement_id": movement_id, "reason": data.reason})

    def apply(session):
        prior = db.movements.find_one({"restaurant_id": principal.restaurant_id,
            "idempotency_key": idempotency_key}, session=session)
        if prior is not None:
            if prior.get("request_fingerprint") != request_hash:
                raise HTTPException(status_code=409, detail="Idempotency key was already used for another reversal")
            return prior
        original = db.movements.find_one({"_id": movement_id,
            "restaurant_id": principal.restaurant_id}, session=session)
        if original is None:
            raise HTTPException(status_code=404, detail="Movement not found")
        if (original.get("kind") not in {"adjustment_in", "adjustment_out"}
                or original.get("purchase_reference") or original.get("reversal_of")):
            raise HTTPException(status_code=409, detail="Only manual stock adjustments can be reversed here")
        existing = db.movements.find_one({"restaurant_id": principal.restaurant_id,
            "reversal_of": movement_id}, session=session)
        if existing is not None or original.get("reversed_by_movement_id"):
            raise HTTPException(status_code=409, detail="Movement was already reversed")
        reverse_kind = "adjustment_out" if original["kind"] == "adjustment_in" else "adjustment_in"
        reversal = _apply_movement(db, original["ingredient_id"], MovementCreate(
            kind=reverse_kind, quantity=quantity_from_milli(int(original["quantity_milli"])),
            unit_cost_cents=original.get("unit_cost_cents"),
            reason=f"Estorno do movimento {movement_id}: {data.reason}",
            unit=original["unit"]), principal, idempotency_key, session)
        reversal_updates = {"reversal_of": movement_id, "request_fingerprint": request_hash}
        db.movements.update_one({"_id": reversal["_id"], "restaurant_id": principal.restaurant_id},
                                {"$set": reversal_updates}, session=session)
        reversal.update(reversal_updates)
        original_mark = db.movements.update_one({"_id": movement_id,
            "restaurant_id": principal.restaurant_id, "reversed_by_movement_id": {"$exists": False}},
            {"$set": {"reversed_by_movement_id": reversal["_id"]}}, session=session)
        if getattr(original_mark, "modified_count", 0) != 1:
            raise HTTPException(status_code=409, detail="Movement was already reversed")
        return reversal

    try:
        with db.client.start_session() as session:
            return session.with_transaction(apply)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            prior = db.movements.find_one({"restaurant_id": principal.restaurant_id,
                "idempotency_key": idempotency_key})
            if prior and prior.get("request_fingerprint") == request_hash:
                return prior
            raise HTTPException(status_code=409, detail="Duplicate movement reversal") from exc
        raise


def conversion_factor(ingredient: dict, unit: str) -> float:
    base = ingredient["base_unit"].lower()
    if unit.lower() == base:
        return 1.0
    built_in = {("kg", "g"): 0.001, ("g", "kg"): 1000.0,
                ("l", "ml"): 0.001, ("ml", "l"): 1000.0}
    if (base, unit.lower()) in built_in:
        return built_in[(base, unit.lower())]
    conversions = {str(key).strip().lower(): value
                   for key, value in ingredient.get("conversions", {}).items()}
    factor = conversions.get(unit.strip().lower())
    if not isinstance(factor, (int, float)) or factor <= 0:
        raise HTTPException(status_code=422, detail=f"No conversion from {unit} to {base} is configured")
    return float(factor)


def _fence_ingredient_versions(db, ingredients: dict, session) -> None:
    """Write-touch catalog rows so a concurrent conversion edit conflicts with frozen snapshots."""
    for ingredient_id, ingredient in ingredients.items():
        version = int(ingredient.get("version", 1))
        version_filter = ({"version": version} if "version" in ingredient
                          else {"version": {"$exists": False}})
        result = db.ingredients.update_one(
            {"_id": ingredient_id, "restaurant_id": ingredient["restaurant_id"],
             "active": True, **version_filter},
            {"$inc": {"snapshot_revision": 1}}, session=session,
        )
        if result.matched_count != 1:
            raise HTTPException(status_code=409,
                detail="Ingredient changed while its unit conversion was being captured")


def create_purchase(db, data: PurchaseCreate, principal: Principal, idempotency_key: str) -> dict:
    if not idempotency_key.strip() or len(idempotency_key) > 200:
        raise HTTPException(status_code=422, detail="A valid Idempotency-Key is required")
    request_hash = fingerprint(data.model_dump(mode="json"))
    prior = db.purchases.find_one({"restaurant_id": principal.restaurant_id,
                                   "idempotency_key": idempotency_key})
    if prior is not None:
        if prior.get("request_fingerprint") != request_hash:
            raise HTTPException(status_code=409, detail="Idempotency key was already used for another purchase")
        return prior
    for line in data.lines:
        if quantity_milli(line.quantity_ordered) <= 0:
            raise HTTPException(status_code=422, detail="Purchase quantity is below the 0.001 unit precision")
    timestamp = now()
    purchase = {
        "_id": f"pur_{uuid4().hex}", "restaurant_id": principal.restaurant_id,
        "supplier_id": data.supplier_id, "status": "draft", "version": 1, "created_by": principal.user_id,
        "created_at": timestamp, "updated_at": timestamp, "expected_delivery_at": data.expected_delivery_at,
        "received_at": None, "received_by": None, "note": data.note,
        "idempotency_key": idempotency_key,
        "lines": [],
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
        ingredient_ids = [line.ingredient_id for line in data.lines]
        ingredients = list(db.ingredients.find({"_id": {"$in": ingredient_ids},
            "restaurant_id": principal.restaurant_id, "active": True}, session=session))
        if len(ingredients) != len(set(ingredient_ids)):
            raise HTTPException(status_code=422,
                detail="Purchase contains an unknown or inactive ingredient")
        ingredient_by_id = {ingredient["_id"]: ingredient for ingredient in ingredients}
        if data.supplier_id and db.suppliers.find_one({"_id": data.supplier_id,
            "restaurant_id": principal.restaurant_id, "active": True}, session=session) is None:
            raise HTTPException(status_code=422, detail="Supplier not found or inactive")
        for line in data.lines:
            conversion_factor(ingredient_by_id[line.ingredient_id], line.unit)
        _fence_ingredient_versions(db, ingredient_by_id, session)
        purchase["lines"] = [{"id": f"line_{uuid4().hex}", **line.model_dump(),
            "conversion_to_base": conversion_factor(ingredient_by_id[line.ingredient_id], line.unit),
            "quantity_ordered": quantity_from_milli(quantity_milli(line.quantity_ordered)),
            "quantity_ordered_milli": quantity_milli(line.quantity_ordered),
            "quantity_received": 0.0, "quantity_received_milli": 0,
            "received_unit_cost_cents": None} for line in data.lines]
        counter = db.counters.find_one_and_update(
            {"_id": f"purchase_code:{principal.restaurant_id}"},
            {"$inc": {"value": 1}, "$setOnInsert": {"restaurant_id": principal.restaurant_id}},
            upsert=True, return_document=ReturnDocument.AFTER, session=session,
        )
        purchase["code"] = f"PC-{counter['value']:04d}"
        purchase["request_fingerprint"] = request_hash
        event_id = record_audit_event(db, event_id=f"audit_purchase_create:{purchase['_id']}",
            tenant=principal.restaurant_id, user_id=principal.user_id, action="purchase.create",
            entity="purchase", label=purchase["code"], before=None, after="draft",
            reason="Rascunho de compra criado", occurred_at=timestamp,
            source_type="purchase", source_id=purchase["_id"], session=session)
        if event_id:
            purchase["created_audit_event_id"] = event_id
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


def update_purchase_draft(db, purchase_id: str, data: PurchaseDraftUpdate, principal: Principal) -> dict:
    tenant = principal.restaurant_id
    query = {"_id": purchase_id, "restaurant_id": tenant}
    timestamp = now()

    def update(session):
        purchase = db.purchases.find_one(query, session=session)
        if purchase is None:
            raise HTTPException(status_code=404, detail="Purchase not found")
        if purchase.get("status") != "draft":
            raise HTTPException(status_code=409, detail="Only draft purchases can be edited")
        stored_version = int(purchase.get("version", 1))
        if data.expected_version != stored_version:
            raise HTTPException(status_code=409, detail="Purchase changed since it was loaded; refresh and retry")

        ingredient_ids = [line.ingredient_id for line in data.lines]
        ingredients = list(db.ingredients.find({"_id": {"$in": ingredient_ids},
                                                "restaurant_id": tenant, "active": True}, session=session))
        if len(ingredients) != len(set(ingredient_ids)):
            raise HTTPException(status_code=422, detail="Purchase contains an unknown or inactive ingredient")
        ingredient_by_id = {item["_id"]: item for item in ingredients}
        factors_by_ingredient = {}
        for line in data.lines:
            if quantity_milli(line.quantity_ordered) <= 0:
                raise HTTPException(status_code=422, detail="Purchase quantity is below the 0.001 unit precision")
            factors_by_ingredient[line.ingredient_id] = conversion_factor(
                ingredient_by_id[line.ingredient_id], line.unit)
        if data.supplier_id and db.suppliers.find_one({"_id": data.supplier_id,
                                                       "restaurant_id": tenant, "active": True},
                                                      session=session) is None:
            raise HTTPException(status_code=422, detail="Supplier not found or inactive")

        old_lines = {line["ingredient_id"]: line for line in purchase.get("lines", [])}
        lines = []
        for line in data.lines:
            quantity_milli_value = quantity_milli(line.quantity_ordered)
            existing = old_lines.get(line.ingredient_id)
            same_existing_unit = existing and existing.get("unit", "").strip().lower() == line.unit.strip().lower()
            factor = (existing.get("conversion_to_base") if same_existing_unit else None)
            if factor is None:
                factor = factors_by_ingredient[line.ingredient_id]
            lines.append({"id": existing["id"] if existing else f"line_{uuid4().hex}",
                          **line.model_dump(),
                          "conversion_to_base": factor,
                          "quantity_ordered": quantity_from_milli(quantity_milli_value),
                          "quantity_ordered_milli": quantity_milli_value,
                          "quantity_received": 0.0, "quantity_received_milli": 0,
                          "received_unit_cost_cents": None})

        def snapshot(value):
            return {"supplier_id": value.get("supplier_id"),
                    "expected_delivery_at": value.get("expected_delivery_at"),
                    "note": value.get("note", ""),
                    "lines": [{"ingredient_id": line["ingredient_id"],
                               "quantity_ordered": line["quantity_ordered"],
                               "unit": line["unit"],
                               "conversion_to_base": line.get("conversion_to_base"),
                               "expected_unit_cost_cents": line["expected_unit_cost_cents"]}
                              for line in value.get("lines", [])]}

        before = snapshot(purchase)
        after = {"supplier_id": data.supplier_id,
                 "expected_delivery_at": data.expected_delivery_at,
                 "note": data.note,
                 "lines": [{"ingredient_id": line["ingredient_id"],
                            "quantity_ordered": line["quantity_ordered"],
                            "unit": line["unit"],
                            "conversion_to_base": line.get("conversion_to_base"),
                            "expected_unit_cost_cents": line["expected_unit_cost_cents"]}
                           for line in lines]}
        if before == after:
            return purchase
        _fence_ingredient_versions(db, ingredient_by_id, session)

        version_filter = {"version": stored_version} if "version" in purchase else {"version": {"$exists": False}}
        updated = db.purchases.find_one_and_update(
            {**query, "status": "draft", **version_filter},
            {"$set": {**after, "lines": lines, "updated_at": timestamp,
                      "updated_by": principal.user_id, "version": stored_version + 1}},
            return_document=ReturnDocument.AFTER, session=session,
        )
        if updated is None:
            raise HTTPException(status_code=409, detail="Purchase changed concurrently")
        change_id = f"pch_{uuid4().hex}"
        change = {"_id": change_id, "restaurant_id": tenant, "purchase_id": purchase_id,
                  "actor_id": principal.user_id, "action": "purchase.update", "before": before,
                  "after": after, "occurred_at": timestamp}
        event_id = record_audit_event(db, event_id=f"audit_{change_id}", tenant=tenant,
            user_id=principal.user_id, action="purchase.update", entity="purchase",
            label=purchase.get("code", purchase_id),
            before=f"{len(before.get('lines', []))} linhas · {before.get('note', '')}",
            after=f"{len(after.get('lines', []))} linhas · {after.get('note', '')}",
            reason="Rascunho de compra editado", occurred_at=timestamp,
            source_type="purchase_change", source_id=change_id, session=session)
        if event_id:
            change["audit_event_id"] = event_id
        db.purchase_changes.insert_one(change, session=session)
        return updated

    with db.client.start_session() as session:
        return session.with_transaction(update)


def create_supplier(db, data: SupplierCreate, principal: Principal,
                    idempotency_key: str | None = None) -> dict:
    request_hash = fingerprint(data.model_dump(mode="json")) if idempotency_key is not None else None
    if idempotency_key is not None:
        if not idempotency_key.strip() or len(idempotency_key) > 200:
            raise HTTPException(status_code=422, detail="A valid Idempotency-Key is required")
        prior = db.suppliers.find_one({"restaurant_id": principal.restaurant_id,
                                       "idempotency_key": idempotency_key})
        if prior is not None:
            if prior.get("request_fingerprint") != request_hash:
                raise HTTPException(status_code=409, detail="Idempotency key was already used for another supplier")
            return prior
    timestamp = now()
    supplier = {
        "_id": f"sup_{uuid4().hex}", "restaurant_id": principal.restaurant_id,
        "created_by": principal.user_id,
        "name": data.name, "name_normalized": data.name.casefold(), "contact": data.contact,
        "phone": data.phone, "whatsapp": data.whatsapp, "notes": data.notes,
        "avg_lead_time_days": data.avg_lead_time_days, "min_order_cents": data.min_order_cents,
        "active": True, "created_at": timestamp, "updated_at": timestamp,
        "version": 1,
    }
    if idempotency_key is not None:
        supplier["idempotency_key"] = idempotency_key
        supplier["request_fingerprint"] = request_hash
    def create(session):
        if idempotency_key is not None:
            prior = db.suppliers.find_one({"restaurant_id": principal.restaurant_id,
                "idempotency_key": idempotency_key}, session=session)
            if prior is not None:
                if prior.get("request_fingerprint") != request_hash:
                    raise HTTPException(status_code=409,
                        detail="Idempotency key was already used for another supplier")
                supplier.clear()
                supplier.update(prior)
                return
        event_id = record_audit_event(db, event_id=f"audit_supplier_create:{supplier['_id']}",
            tenant=principal.restaurant_id, user_id=principal.user_id, action="supplier.create",
            entity="supplier", label=supplier["name"], before=None,
            after=_catalog_snapshot({"name": supplier["name"],
                "avg_lead_time_days": supplier["avg_lead_time_days"],
                "min_order_cents": supplier["min_order_cents"]}),
            reason="Cadastro de fornecedor", occurred_at=timestamp,
            source_type="supplier", source_id=supplier["_id"], session=session)
        if event_id:
            supplier["created_audit_event_id"] = event_id
        db.suppliers.insert_one(supplier, session=session)

    try:
        with db.client.start_session() as session:
            session.with_transaction(create)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            if idempotency_key is not None:
                prior = db.suppliers.find_one({"restaurant_id": principal.restaurant_id,
                    "idempotency_key": idempotency_key})
                if prior is not None and prior.get("request_fingerprint") == request_hash:
                    return prior
                if prior is not None:
                    raise HTTPException(status_code=409,
                        detail="Idempotency key was already used for another supplier") from exc
            raise HTTPException(status_code=409, detail="Supplier name already exists") from exc
        raise
    return supplier


def update_supplier(db, supplier_id: str, data: SupplierUpdate, principal: Principal) -> dict:
    fields = data.model_dump(exclude_unset=True, exclude={"expected_version"})
    if not fields:
        raise HTTPException(status_code=422, detail="No fields to update")
    query = {"_id": supplier_id, "restaurant_id": principal.restaurant_id}

    def update(session):
        prior = db.suppliers.find_one(query, session=session)
        if prior is None:
            raise HTTPException(status_code=404, detail="Supplier not found")
        changes = dict(fields)
        if "name" in changes:
            changes["name"] = changes["name"].strip()
            changes["name_normalized"] = changes["name"].casefold()
        actual = {key: value for key, value in changes.items()
                  if key != "name_normalized" and prior.get(key) != value}
        if not actual:
            return prior
        current_version = int(prior.get("version", 1))
        if data.expected_version != current_version:
            raise HTTPException(status_code=409, detail="Supplier changed since it was loaded; refresh and retry")
        timestamp = now()
        changes["updated_at"] = timestamp
        changes["updated_by"] = principal.user_id
        event_id = record_audit_event(db, event_id=f"audit_supplier_update:{uuid4().hex}",
            tenant=principal.restaurant_id, user_id=principal.user_id, action="supplier.update",
            entity="supplier", label=changes.get("name", prior["name"]),
            before=_catalog_snapshot(actual, prior), after=_catalog_snapshot(actual),
            reason="Cadastro de fornecedor atualizado", occurred_at=timestamp,
            source_type="supplier", source_id=supplier_id, session=session)
        if event_id:
            changes["updated_audit_event_id"] = event_id
        version_filter = {"version": current_version} if "version" in prior else {"version": {"$exists": False}}
        result = db.suppliers.find_one_and_update(
            {**query, **version_filter},
            {"$set": {**changes, "version": current_version + 1}},
            return_document=ReturnDocument.AFTER, session=session)
        if result is None:
            raise HTTPException(status_code=409, detail="Supplier changed concurrently")
        return result

    try:
        with db.client.start_session() as session:
            return session.with_transaction(update)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            raise HTTPException(status_code=409, detail="Supplier name already exists") from exc
        raise


def set_purchase_status(db, purchase_id: str, status: str, principal: Principal,
                        expected_version: int) -> dict:
    if status not in {"requested", "cancelled"}:
        raise HTTPException(status_code=422, detail="Invalid purchase transition")
    query = {"_id": purchase_id, "restaurant_id": principal.restaurant_id}

    def transition(session):
        purchase = db.purchases.find_one(query, session=session)
        if purchase is None:
            raise HTTPException(status_code=404, detail="Purchase not found")
        if purchase.get("status") == status:
            return purchase
        current_version = int(purchase.get("version", 1))
        if expected_version != current_version:
            raise HTTPException(status_code=409, detail="Purchase changed since it was loaded; refresh and retry")
        if status == "requested" and purchase["status"] != "draft":
            raise HTTPException(status_code=409, detail="Only draft purchases can be requested")
        if status == "cancelled" and purchase["status"] in {"cancelled", "received"}:
            raise HTTPException(status_code=409, detail="Purchase can no longer be cancelled")
        timestamp = now()
        audit_field = "request_audit_event_id" if status == "requested" else "cancel_audit_event_id"
        event_id = record_audit_event(db, event_id=f"audit_purchase_{status}:{purchase_id}",
            tenant=principal.restaurant_id, user_id=principal.user_id,
            action="purchase.create" if status == "requested" else "purchase.cancel",
            entity="purchase", label=purchase.get("code", purchase_id),
            before="draft" if status == "requested" else purchase["status"], after=status,
            reason="Compra enviada ao fornecedor" if status == "requested" else "Compra cancelada",
            occurred_at=timestamp, source_type="purchase", source_id=purchase_id, session=session)
        updates = {"status": status, "updated_at": timestamp,
                   "cancelled_at": timestamp if status == "cancelled" else None,
                   "cancelled_by": principal.user_id if status == "cancelled" else None,
                   "requested_at": timestamp if status == "requested" else None,
                   "requested_by": principal.user_id if status == "requested" else None}
        if event_id:
            updates[audit_field] = event_id
        stored_version = current_version
        version_filter = {"version": stored_version} if "version" in purchase else {"version": {"$exists": False}}
        updated = db.purchases.find_one_and_update(
            {**query, "status": purchase["status"], **version_filter},
            {"$set": {**updates, "version": stored_version + 1}},
            return_document=ReturnDocument.AFTER, session=session)
        if updated is None:
            raise HTTPException(status_code=409, detail="Purchase changed concurrently")
        return updated

    with db.client.start_session() as session:
        return session.with_transaction(transition)


def receive_purchase(db, purchase_id: str, data: PurchaseReceive, principal: Principal,
                     idempotency_key: str) -> dict:
    if not idempotency_key.strip() or len(idempotency_key) > 200:
        raise HTTPException(status_code=422, detail="A valid Idempotency-Key is required")
    receipt_id = f"rec_{uuid4().hex}"
    request_hash = fingerprint({"purchase_id": purchase_id,
                                "lines": [line.model_dump(mode="json") for line in data.lines]})

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
        current_version = int(purchase.get("version", 1))
        if data.expected_version != current_version:
            raise HTTPException(status_code=409, detail="Purchase changed since it was loaded; refresh and retry")
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
            ordered_milli = int(line.get("quantity_ordered_milli", quantity_milli(line["quantity_ordered"])))
            received_milli = int(line.get("quantity_received_milli", quantity_milli(line["quantity_received"])))
            if incoming:
                incoming_milli = quantity_milli(incoming.quantity_received)
                if incoming_milli <= 0:
                    raise HTTPException(status_code=422, detail="Received quantity is below the 0.001 unit precision")
                if received_milli + incoming_milli > ordered_milli:
                    raise HTTPException(status_code=422, detail="Received quantity exceeds quantity ordered")
                received_milli += incoming_milli
                updated["quantity_received_milli"] = received_milli
                updated["quantity_received"] = quantity_from_milli(received_milli)
                updated["received_unit_cost_cents"] = incoming.unit_cost_cents
                receipt_items.append((updated, incoming))
            updated_lines.append(updated)
        all_received = all(line.get("quantity_received_milli", quantity_milli(line["quantity_received"]))
                           >= line.get("quantity_ordered_milli", quantity_milli(line["quantity_ordered"]))
                           for line in updated_lines)
        any_received = any(line.get("quantity_received_milli", quantity_milli(line["quantity_received"])) > 0
                           for line in updated_lines)
        status = "received" if all_received else ("partial" if any_received else "requested")
        timestamp = now()
        stored_version = int(purchase.get("version", 1))
        version_filter = {"version": stored_version} if "version" in purchase else {"version": {"$exists": False}}
        changed = db.purchases.find_one_and_update(
            {"_id": purchase_id, "restaurant_id": principal.restaurant_id, **version_filter},
            {"$set": {"lines": updated_lines, "status": status, "updated_at": timestamp,
                      "received_at": timestamp if all_received else None,
                      "received_by": principal.user_id if all_received else None,
                      "version": stored_version + 1}},
            return_document=ReturnDocument.AFTER, session=session,
        )
        if changed is None:
            raise HTTPException(status_code=409, detail="Purchase changed concurrently; retry with a new key")
        receipt = {"_id": receipt_id, "restaurant_id": principal.restaurant_id,
                   "purchase_id": purchase_id, "idempotency_key": idempotency_key,
                   "request_fingerprint": request_hash, "actor_id": principal.user_id,
                   "received_at": timestamp, "lines": [line.model_dump() for line in data.lines]}
        event_id = record_audit_event(db, event_id=f"audit_receipt_receive:{receipt_id}",
            tenant=principal.restaurant_id, user_id=principal.user_id, action="purchase.receive",
            entity="purchase", label=purchase.get("code", purchase_id), before=purchase["status"],
            after=f"{len(data.lines)} linha(s) recebida(s)", reason="Recebimento de mercadorias",
            occurred_at=timestamp, source_type="purchase_receipt", source_id=receipt_id, session=session)
        if event_id:
            receipt["audit_event_id"] = event_id
        db.purchase_receipts.insert_one(receipt, session=session)
        for line, incoming in receipt_items:
            ingredient = db.ingredients.find_one({"_id": line["ingredient_id"],
                                                  "restaurant_id": principal.restaurant_id, "active": True},
                                                 session=session)
            if ingredient is None:
                raise HTTPException(status_code=409, detail="Purchase ingredient is unavailable")
            unit_factor = Decimal(str(line.get("conversion_to_base")
                                       or conversion_factor(ingredient, line["unit"])))
            base_cost = int((Decimal(incoming.unit_cost_cents) / unit_factor).quantize(
                Decimal("1"), rounding=ROUND_HALF_UP))
            old_milli = ingredient.get("current_quantity_milli")
            old_milli = quantity_milli(ingredient["current_quantity"]) if old_milli is None else int(old_milli)
            old_quantity = Decimal(old_milli) / QUANTITY_SCALE
            received_milli = quantity_milli(Decimal(str(incoming.quantity_received)) * unit_factor)
            received_base_quantity = Decimal(received_milli) / QUANTITY_SCALE
            total_quantity = old_quantity + received_base_quantity
            old_cost_known = ingredient_cost_known(ingredient)
            next_cost_known = old_cost_known or old_quantity <= 0
            if old_quantity <= 0:
                weighted_cost = base_cost
            elif old_cost_known:
                weighted_cost = int(((old_quantity * Decimal(ingredient["cost_cents"])
                                      + received_base_quantity * Decimal(base_cost))
                                     / total_quantity).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
            else:
                # Existing stock has no defensible valuation; do not fabricate an average.
                weighted_cost = int(ingredient.get("cost_cents", 0))
            movement_data = MovementCreate(kind="purchase", quantity=incoming.quantity_received,
                unit_cost_cents=base_cost, reason=f"Received purchase {purchase_id}",
                supplier_id=purchase.get("supplier_id"), purchase_reference=purchase_id, unit=line["unit"])
            _apply_movement(db, line["ingredient_id"], movement_data, principal,
                            f"{receipt_id}:{line['id']}", session,
                            conversion_to_base=unit_factor)
            ingredient_updates = {
                "$set": {"cost_cents": weighted_cost, "cost_known": next_cost_known,
                         "cost_updated_at": timestamp if next_cost_known else None},
                "$push": {"price_history": {"unit_cost_cents": base_cost, "supplier_id": purchase.get("supplier_id"),
                    "purchase_id": purchase_id, "purchase_unit": line["unit"],
                    "purchase_unit_cost_cents": incoming.unit_cost_cents, "occurred_at": timestamp}},
            }
            cost_changed = (weighted_cost != ingredient["cost_cents"]
                            or next_cost_known != old_cost_known)
            if cost_changed:
                ingredient_updates["$set"]["version"] = int(ingredient.get("version", 1)) + 1
            db.ingredients.update_one(
                {"_id": line["ingredient_id"], "restaurant_id": principal.restaurant_id},
                ingredient_updates,
                session=session,
            )
            if cost_changed:
                snapshot_recipes_using_ingredient(
                    db, line["ingredient_id"], principal, timestamp,
                    "Custo de insumo atualizado por recebimento", session,
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


def reverse_purchase_receipt(db, purchase_id: str, receipt_id: str, data, principal: Principal,
                             idempotency_key: str) -> dict:
    """Compensate one whole receipt; never erase its original movements or receipt record."""
    if not idempotency_key.strip() or len(idempotency_key) > 200:
        raise HTTPException(status_code=422, detail="A valid Idempotency-Key is required")
    request_hash = fingerprint({"purchase_id": purchase_id, "receipt_id": receipt_id,
                                "reason": data.reason})
    timestamp = now()

    def apply(session):
        receipt = db.purchase_receipts.find_one({"_id": receipt_id, "restaurant_id": principal.restaurant_id,
                                                  "purchase_id": purchase_id}, session=session)
        if receipt is None:
            raise HTTPException(status_code=404, detail="Receipt not found")
        if receipt.get("reversed_at"):
            if (receipt.get("reversal_idempotency_key") == idempotency_key
                    and receipt.get("reversal_request_fingerprint") == request_hash
                    and receipt.get("reversed_by") == principal.user_id):
                prior_purchase = db.purchases.find_one({"_id": purchase_id,
                    "restaurant_id": principal.restaurant_id}, session=session)
                if prior_purchase is not None:
                    return prior_purchase
            raise HTTPException(status_code=409, detail="Receipt was already reversed")
        purchase = db.purchases.find_one({"_id": purchase_id, "restaurant_id": principal.restaurant_id},
                                         session=session)
        if purchase is None:
            raise HTTPException(status_code=404, detail="Purchase not found")
        purchase_lines = {line["id"]: dict(line) for line in purchase["lines"]}
        receipt_lines = receipt.get("lines", [])
        reversal_items = []
        for line in receipt_lines:
            purchase_line = purchase_lines.get(line["line_id"])
            if purchase_line is None:
                raise HTTPException(status_code=409, detail="Receipt no longer matches its purchase")
            original = db.movements.find_one({"restaurant_id": principal.restaurant_id,
                "idempotency_key": f"{receipt_id}:{line['line_id']}", "kind": "purchase"}, session=session)
            if original is None:
                raise HTTPException(status_code=409, detail="Original receipt movement is missing")
            received_milli = int(purchase_line.get("quantity_received_milli",
                quantity_milli(purchase_line["quantity_received"])))
            line_milli = quantity_milli(line["quantity_received"])
            if received_milli < line_milli:
                raise HTTPException(status_code=409, detail="Receipt quantities no longer reconcile with purchase")
            purchase_line["quantity_received_milli"] = received_milli - line_milli
            purchase_line["quantity_received"] = quantity_from_milli(received_milli - line_milli)
            reversal_items.append((line, original, purchase_line))

        for line, original, purchase_line in reversal_items:
            ingredient = db.ingredients.find_one({"_id": original["ingredient_id"],
                "restaurant_id": principal.restaurant_id, "active": True}, session=session)
            if ingredient is None:
                raise HTTPException(status_code=409, detail="Receipt ingredient is unavailable")
            current_milli = int(ingredient.get("current_quantity_milli",
                quantity_milli(ingredient["current_quantity"])))
            reverse_milli = int(original["quantity_milli"])
            if current_milli < reverse_milli:
                raise HTTPException(status_code=409,
                    detail="Insufficient available stock to reverse this receipt; reconcile stock first")
            remaining_milli = current_milli - reverse_milli
            updated_cost_known = ingredient_cost_known(ingredient)
            updated_cost = int(ingredient.get("cost_cents", 0))
            if updated_cost_known:
                current_value = Decimal(current_milli) * Decimal(updated_cost)
                reverse_value = Decimal(reverse_milli) * Decimal(original.get("unit_cost_cents") or 0)
                remaining_value = current_value - reverse_value
                if remaining_value < 0:
                    raise HTTPException(status_code=409,
                        detail="Receipt value exceeds current inventory value; reconcile cost before reversal")
                if remaining_milli:
                    updated_cost = int((remaining_value / Decimal(remaining_milli)).quantize(
                        Decimal("1"), rounding=ROUND_HALF_UP))
            reversal = MovementCreate(kind="adjustment_out", quantity=quantity_from_milli(reverse_milli),
                unit_cost_cents=original.get("unit_cost_cents"),
                reason=f"Estorno do recebimento {receipt_id}: {data.reason}",
                purchase_reference=purchase_id, unit=ingredient["base_unit"])
            movement = _apply_movement(db, ingredient["_id"], reversal, principal,
                f"reversal:{receipt_id}:{line['line_id']}", session)
            db.movements.update_one({"_id": movement["_id"], "restaurant_id": principal.restaurant_id},
                {"$set": {"reversal_of": original["_id"], "receipt_id": receipt_id}}, session=session)
            ingredient_updates = {
                "$set": {"cost_cents": updated_cost, "cost_known": updated_cost_known,
                         "cost_updated_at": timestamp if updated_cost_known else None},
                "$push": {"price_history": {"unit_cost_cents": updated_cost,
                    "purchase_id": purchase_id, "receipt_id": receipt_id,
                    "reversal": True, "reason": data.reason, "occurred_at": timestamp}},
            }
            cost_changed = (updated_cost != ingredient["cost_cents"]
                            or updated_cost_known != ingredient_cost_known(ingredient))
            if cost_changed:
                ingredient_updates["$set"]["version"] = int(ingredient.get("version", 1)) + 1
            db.ingredients.update_one({"_id": ingredient["_id"], "restaurant_id": principal.restaurant_id},
                ingredient_updates, session=session)
            if cost_changed:
                snapshot_recipes_using_ingredient(db, ingredient["_id"], principal, timestamp,
                    "Custo de insumo atualizado por estorno de recebimento", session)

        all_received = all(int(line.get("quantity_received_milli",
            quantity_milli(line["quantity_received"]))) >= int(line.get("quantity_ordered_milli",
            quantity_milli(line["quantity_ordered"]))) for line in purchase_lines.values())
        any_received = any(int(line.get("quantity_received_milli",
            quantity_milli(line["quantity_received"]))) > 0 for line in purchase_lines.values())
        next_status = ("cancelled" if purchase.get("status") == "cancelled"
                       else "received" if all_received else ("partial" if any_received else "requested"))
        stored_version = int(purchase.get("version", 1))
        version_filter = {"version": stored_version} if "version" in purchase else {"version": {"$exists": False}}
        updated_purchase = db.purchases.find_one_and_update(
            {"_id": purchase_id, "restaurant_id": principal.restaurant_id, **version_filter},
            {"$set": {"lines": list(purchase_lines.values()), "status": next_status,
                      "updated_at": timestamp, "received_at": timestamp if all_received else None,
                      "received_by": principal.user_id if all_received else None,
                      "version": stored_version + 1}},
            return_document=ReturnDocument.AFTER, session=session)
        if updated_purchase is None:
            raise HTTPException(status_code=409, detail="Purchase changed concurrently")
        reversal_event_id = record_audit_event(db, event_id=f"audit_receipt_reversal:{receipt_id}",
            tenant=principal.restaurant_id, user_id=principal.user_id,
            action="purchase.receipt.reverse", entity="purchase", label=purchase.get("code", purchase_id),
            before="recebido", after="estornado", reason=data.reason, occurred_at=timestamp,
            source_type="purchase_receipt_reversal", source_id=receipt_id, session=session)
        receipt_updates = {"reversed_at": timestamp, "reversed_by": principal.user_id,
                           "reversal_reason": data.reason,
                           "reversal_idempotency_key": idempotency_key,
                           "reversal_request_fingerprint": request_hash}
        if reversal_event_id:
            receipt_updates["reversal_audit_event_id"] = reversal_event_id
        marked = db.purchase_receipts.update_one(
            {"_id": receipt_id, "restaurant_id": principal.restaurant_id, "reversed_at": {"$exists": False}},
            {"$set": receipt_updates}, session=session)
        if marked.modified_count != 1:
            raise HTTPException(status_code=409, detail="Receipt was already reversed")
        return updated_purchase

    try:
        with db.client.start_session() as session:
            return session.with_transaction(apply)
    except DuplicateKeyError as exc:
        prior = db.purchase_receipts.find_one({"_id": receipt_id,
            "restaurant_id": principal.restaurant_id, "purchase_id": purchase_id})
        if (prior is not None and prior.get("reversed_at")
                and prior.get("reversal_idempotency_key") == idempotency_key
                and prior.get("reversal_request_fingerprint") == request_hash
                and prior.get("reversed_by") == principal.user_id):
            purchase = db.purchases.find_one({"_id": purchase_id,
                "restaurant_id": principal.restaurant_id})
            if purchase is not None:
                return purchase
        raise HTTPException(status_code=409, detail="Receipt was already reversed") from exc


def list_purchase_receipts(db, purchase_id: str, principal: Principal) -> list[dict]:
    if db.purchases.find_one({"_id": purchase_id, "restaurant_id": principal.restaurant_id},
                             {"_id": 1}) is None:
        raise HTTPException(status_code=404, detail="Purchase not found")
    receipts = db.purchase_receipts.find({"restaurant_id": principal.restaurant_id,
        "purchase_id": purchase_id}).sort("received_at", -1)
    return [{"id": receipt["_id"], "received_at": receipt["received_at"],
        "actor_id": receipt["actor_id"], "lines": receipt.get("lines", []),
        "reversed_at": receipt.get("reversed_at"), "reversed_by": receipt.get("reversed_by"),
        "reversal_reason": receipt.get("reversal_reason")} for receipt in receipts]


def upsert_recipe(db, data: RecipePut, principal: Principal) -> dict:
    ingredient_ids = [line.ingredient_id for line in data.lines]
    for line in data.lines:
        line_quantity_milli = quantity_milli(line.quantity)
        if line_quantity_milli <= 0:
            raise HTTPException(status_code=422, detail="Recipe quantity is below the 0.001 unit precision")
    timestamp = now()
    recipe = {}
    normalized_lines = []
    by_id = {}

    def save(session):
        nonlocal normalized_lines, by_id
        found = list(db.ingredients.find({"_id": {"$in": ingredient_ids},
            "restaurant_id": principal.restaurant_id, "active": True}, session=session))
        if len(found) != len(set(ingredient_ids)):
            raise HTTPException(status_code=422,
                detail="Recipe contains an unknown or inactive ingredient")
        by_id = {item["_id"]: item for item in found}
        normalized_lines = []
        for line in data.lines:
            ingredient = by_id[line.ingredient_id]
            factor = conversion_factor(ingredient, line.unit)
            line_quantity_milli = quantity_milli(line.quantity)
            normalized_lines.append({**line.model_dump(),
                "quantity": quantity_from_milli(line_quantity_milli),
                "quantity_milli": line_quantity_milli,
                "conversion_to_base": factor})
        prior = db.recipes.find_one({"restaurant_id": principal.restaurant_id,
                                     "product_id": data.product_id}, session=session)
        same_composition = (prior is not None and prior.get("lines") == normalized_lines
                            and int(prior.get("yield_portions", 1)) == data.yield_portions)
        unchanged = prior is not None and prior.get("product_name") == data.product_name \
            and prior.get("sale_price_cents") == data.sale_price_cents \
            and int(prior.get("yield_portions", 1)) == data.yield_portions \
            and prior.get("lines") == normalized_lines
        if unchanged:
            return prior
        _fence_ingredient_versions(db, by_id, session)
        recipe.clear()
        recipe.update({
            "_id": f"recipe_{principal.restaurant_id}_{data.product_id}",
            "restaurant_id": principal.restaurant_id,
            "product_id": data.product_id,
            "product_name": data.product_name,
            "lines": normalized_lines,
            "yield_portions": data.yield_portions,
            "sale_price_cents": data.sale_price_cents,
            "active": True,
            "consumption_enabled": bool(same_composition and prior.get("consumption_enabled", False)),
            "version": 1,
            "updated_by": principal.user_id,
            "updated_at": timestamp,
        })
        recipe["active"] = prior.get("active", True) if prior else True
        if prior is None:
            if data.expected_version is not None:
                raise HTTPException(status_code=409, detail="Recipe changed or was removed; refresh and retry")
        else:
            current_version = int(prior.get("version", 1))
            if data.expected_version is None or current_version != data.expected_version:
                raise HTTPException(status_code=409, detail="Recipe changed since it was loaded; refresh and retry")
            recipe["version"] = current_version + 1
        recipe["created_at"] = prior.get("created_at", timestamp) if prior else timestamp
        if prior is None:
            db.recipes.insert_one(recipe, session=session)
        else:
            version_filter = {"version": int(prior["version"])} if "version" in prior else {"version": {"$exists": False}}
            updated = db.recipes.replace_one(
                {"restaurant_id": principal.restaurant_id, "product_id": data.product_id,
                 **version_filter},
                recipe, upsert=False, session=session,
            )
            if updated.matched_count != 1:
                raise HTTPException(status_code=409, detail="Recipe changed concurrently; refresh and retry")
        snapshot = _recipe_snapshot(recipe, by_id, principal, timestamp,
                                    "Ficha cadastrada" if prior is None else "Ficha atualizada")
        event_id = record_audit_event(db, event_id=f"audit_{snapshot['_id']}",
            tenant=principal.restaurant_id, user_id=principal.user_id, action="recipe.cost.snapshot",
            entity="recipe", label=snapshot["product_name"], before=None,
            after=str(snapshot["cost_cents"]), reason=snapshot["trigger"], occurred_at=timestamp,
            source_type="recipe_snapshot", source_id=snapshot["_id"], session=session)
        if event_id:
            snapshot["audit_event_id"] = event_id
        db.recipe_snapshots.insert_one(snapshot, session=session)
        return db.recipes.find_one({"restaurant_id": principal.restaurant_id,
                                    "product_id": data.product_id}, session=session)

    try:
        with db.client.start_session() as session:
            return session.with_transaction(save)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            prior = db.recipes.find_one({"restaurant_id": principal.restaurant_id,
                                         "product_id": data.product_id})
            if (prior is not None and prior.get("product_name") == data.product_name
                    and prior.get("sale_price_cents") == data.sale_price_cents
                    and int(prior.get("yield_portions", 1)) == data.yield_portions
                    and prior.get("lines") == normalized_lines):
                return prior
            raise HTTPException(status_code=409, detail="Recipe was created or changed concurrently") from exc
        raise


def set_recipe_active(db, product_id: str, active: bool, expected_version: int,
                      principal: Principal) -> dict:
    query = {"restaurant_id": principal.restaurant_id, "product_id": product_id}

    def update(session):
        prior = db.recipes.find_one(query, session=session)
        if prior is None:
            raise HTTPException(status_code=404, detail="Recipe not found")
        current_version = int(prior.get("version", 1))
        if bool(prior.get("active", True)) == active:
            return prior
        if current_version != expected_version:
            raise HTTPException(status_code=409, detail="Recipe changed since it was loaded; refresh and retry")
        timestamp = now()
        changes = {"active": active, "version": current_version + 1,
                   "updated_at": timestamp, "updated_by": principal.user_id}
        if not active:
            changes["consumption_enabled"] = False
        event_id = record_audit_event(db, event_id=f"audit_recipe_status:{uuid4().hex}",
            tenant=principal.restaurant_id, user_id=principal.user_id, action="recipe.update",
            entity="recipe", label=prior["product_name"],
            before="ativa" if prior.get("active", True) else "inativa",
            after="ativa" if active else "inativa",
            reason="Ficha técnica reativada" if active else "Ficha técnica desativada",
            occurred_at=timestamp, source_type="recipe", source_id=prior["_id"], session=session)
        if event_id:
            changes["updated_audit_event_id"] = event_id
        version_filter = {"version": current_version} if "version" in prior else {"version": {"$exists": False}}
        updated = db.recipes.find_one_and_update(
            {**query, **version_filter}, {"$set": changes},
            return_document=ReturnDocument.AFTER, session=session)
        if updated is None:
            raise HTTPException(status_code=409, detail="Recipe changed concurrently; refresh and retry")
        return updated

    with db.client.start_session() as session:
        return session.with_transaction(update)


def set_recipe_consumption(db, product_id: str, data: RecipeConsumptionUpdate,
                           principal: Principal) -> dict:
    query = {"restaurant_id": principal.restaurant_id, "product_id": product_id}

    def update(session):
        prior = db.recipes.find_one(query, session=session)
        if prior is None:
            raise HTTPException(status_code=404, detail="Recipe not found")
        if not prior.get("active", True):
            raise HTTPException(status_code=409, detail="Activate the recipe before enabling automatic consumption")
        version = int(prior.get("version", 1))
        if version != data.expected_version:
            raise HTTPException(status_code=409, detail="Recipe changed since it was loaded; refresh and retry")
        enabled = bool(prior.get("consumption_enabled", False))
        if enabled == data.consumption_enabled:
            return prior
        if data.consumption_enabled:
            ingredient_ids = [line["ingredient_id"] for line in prior.get("lines", [])]
            ingredients = list(db.ingredients.find({"restaurant_id": principal.restaurant_id,
                "_id": {"$in": ingredient_ids}, "active": True}, session=session))
            if not ingredient_ids or len(ingredients) != len(set(ingredient_ids)):
                raise HTTPException(status_code=409,
                    detail="The recipe must contain only active ingredients before consumption is enabled")
        timestamp = now()
        reason = "Consumo automático validado e ativado" if data.consumption_enabled else "Consumo automático desativado"
        audit_id = record_audit_event(db, event_id=f"audit_recipe_consumption:{uuid4().hex}",
            tenant=principal.restaurant_id, user_id=principal.user_id, action="recipe.update",
            entity="recipe", label=prior["product_name"],
            before="consumo ativo" if enabled else "consumo inativo",
            after="consumo ativo" if data.consumption_enabled else "consumo inativo",
            reason=reason, occurred_at=timestamp, source_type="recipe", source_id=prior["_id"],
            session=session)
        changes = {"consumption_enabled": data.consumption_enabled, "version": version + 1,
                   "updated_at": timestamp, "updated_by": principal.user_id}
        if audit_id:
            changes["updated_audit_event_id"] = audit_id
        version_filter = {"version": version} if "version" in prior else {"version": {"$exists": False}}
        updated = db.recipes.find_one_and_update({**query, **version_filter}, {"$set": changes},
            return_document=ReturnDocument.AFTER, session=session)
        if updated is None:
            raise HTTPException(status_code=409, detail="Recipe changed concurrently; refresh and retry")
        return updated

    with db.client.start_session() as session:
        return session.with_transaction(update)


def _recipe_snapshot(recipe: dict, ingredients: dict, principal: Principal,
                     timestamp: datetime, trigger: str) -> dict:
    line_snapshots = []
    total_cost_cents = 0
    unknown_ingredient_ids = []
    for line in recipe["lines"]:
        ingredient = ingredients[line["ingredient_id"]]
        if not ingredient_cost_known(ingredient):
            unknown_ingredient_ids.append(line["ingredient_id"])
        factor = Decimal(str(line.get("conversion_to_base")
                             or conversion_factor(ingredient, line["unit"])))
        quantity = Decimal(str(line["quantity"]))
        line_cost = quantity * factor * Decimal(ingredient["cost_cents"])
        line_cost_cents = int(line_cost.quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        total_cost_cents += line_cost_cents
        line_snapshots.append({
            "ingredient_id": line["ingredient_id"],
            "ingredient_name": ingredient["name"],
            "quantity": line["quantity"],
            "unit": line["unit"],
            "conversion_to_base": format(factor.normalize(), "f"),
            "unit_cost_cents": ingredient["cost_cents"],
            "line_cost_cents": line_cost_cents,
        })
    yield_portions = max(1, int(recipe.get("yield_portions", 1)))
    cost_per_portion_cents = int((Decimal(total_cost_cents) / yield_portions).quantize(
        Decimal("1"), rounding=ROUND_HALF_UP))
    return {
        "_id": f"rs_{uuid4().hex}", "restaurant_id": principal.restaurant_id,
        "product_id": recipe["product_id"], "product_name": recipe["product_name"],
        "yield_portions": yield_portions,
        "batch_cost_cents": total_cost_cents,
        "cost_cents": cost_per_portion_cents,
        "cost_complete": not unknown_ingredient_ids,
        "unknown_ingredient_ids": unknown_ingredient_ids,
        "sale_price_cents": recipe["sale_price_cents"], "occurred_at": timestamp,
        "trigger": trigger, "actor_id": principal.user_id, "lines": line_snapshots,
    }


def snapshot_recipes_using_ingredient(db, ingredient_id: str, principal: Principal,
                                      timestamp: datetime, trigger: str, session) -> int:
    recipes = list(db.recipes.find({
        "restaurant_id": principal.restaurant_id,
        "lines.ingredient_id": ingredient_id,
    }, session=session))
    if not recipes:
        return 0
    ingredient_ids = {line["ingredient_id"] for recipe in recipes for line in recipe["lines"]}
    ingredients = {item["_id"]: item for item in db.ingredients.find({
        "_id": {"$in": list(ingredient_ids)}, "restaurant_id": principal.restaurant_id,
    }, session=session)}
    snapshots = []
    for recipe in recipes:
        if len(recipe["lines"]) != sum(line["ingredient_id"] in ingredients for line in recipe["lines"]):
            continue
        snapshot = _recipe_snapshot(recipe, ingredients, principal, timestamp, trigger)
        current_version = int(recipe.get("version", 1))
        version_filter = ({"version": int(recipe["version"])} if "version" in recipe
                          else {"version": {"$exists": False}})
        changed = db.recipes.update_one(
            {"_id": recipe["_id"], "restaurant_id": principal.restaurant_id, **version_filter},
            {"$set": {"version": current_version + 1}}, session=session,
        )
        if changed.matched_count != 1:
            raise HTTPException(status_code=409, detail="Recipe changed while its cost snapshot was being recorded")
        event_id = record_audit_event(db, event_id=f"audit_{snapshot['_id']}",
            tenant=principal.restaurant_id, user_id=principal.user_id, action="recipe.cost.snapshot",
            entity="recipe", label=snapshot["product_name"], before=None,
            after=str(snapshot["cost_cents"]), reason=snapshot["trigger"], occurred_at=timestamp,
            source_type="recipe_snapshot", source_id=snapshot["_id"], session=session)
        if event_id:
            snapshot["audit_event_id"] = event_id
        snapshots.append(snapshot)
    if snapshots:
        db.recipe_snapshots.insert_many(snapshots, session=session)
    return len(snapshots)


def count_selection_query(selection: CountSelection, principal: Principal) -> dict:
    query = {"restaurant_id": principal.restaurant_id}
    if selection.scope == "low":
        query["active"] = {"$ne": False}
        quantity = {"$ifNull": ["$current_quantity_milli", {"$multiply": ["$current_quantity", 1000]}]}
        minimum = {"$ifNull": ["$min_quantity_milli", {"$multiply": ["$min_quantity", 1000]}]}
        query["$expr"] = {"$lte": [quantity, minimum]}
    elif selection.scope == "category":
        query["category"] = selection.category.strip()
    if selection.search:
        term = re.escape(selection.search.strip().casefold())
        if term:
            query["$or"] = [
                {"name_normalized": {"$regex": term}},
                {"name": {"$regex": re.escape(selection.search.strip()), "$options": "i"}},
            ]
    if selection.include_ids is not None:
        query["_id"] = {"$in": selection.include_ids}
    elif selection.exclude_ids:
        query["_id"] = {"$nin": selection.exclude_ids}
    return query


def create_count(db, data: CountCreate, principal: Principal, idempotency_key: str) -> dict:
    if not idempotency_key.strip() or len(idempotency_key) > 160:
        raise HTTPException(status_code=422, detail="A valid Idempotency-Key is required")
    request_hash = fingerprint(data.model_dump())
    timestamp = now()
    count = {
        "_id": f"cnt_{uuid4().hex}", "restaurant_id": principal.restaurant_id,
        "status": "open", "created_by": principal.user_id, "created_at": timestamp,
        "updated_at": timestamp, "approved_at": None, "approved_by": None,
        "version": 1,
        "create_key": idempotency_key, "request_fingerprint": request_hash, "lines": [],
    }

    def create(session):
        prior = db.counts.find_one({"restaurant_id": principal.restaurant_id,
                                    "create_key": idempotency_key}, session=session)
        if prior:
            if prior.get("request_fingerprint") != request_hash:
                raise HTTPException(status_code=409, detail="Idempotency key was already used for another count")
            count.clear()
            count.update(prior)
            return count
        if data.selection is not None:
            query = count_selection_query(data.selection, principal)
            ingredients = list(db.ingredients.find(query, session=session)
                .sort([("name_normalized", 1), ("_id", 1)]).limit(501))
            if len(ingredients) > 500:
                raise HTTPException(status_code=422, detail="A physical count cannot include more than 500 ingredients")
            ingredient_ids = [item["_id"] for item in ingredients]
        else:
            ingredient_ids = data.ingredient_ids or []
            ingredients = list(db.ingredients.find({
                "_id": {"$in": ingredient_ids}, "restaurant_id": principal.restaurant_id,
            }, session=session))
        if not ingredient_ids or len(ingredients) != len(ingredient_ids):
            raise HTTPException(status_code=422, detail="Count contains an unknown ingredient")
        by_id = {item["_id"]: item for item in ingredients}
        count["lines"] = [{"ingredient_id": item_id,
                            "expected_quantity": quantity_from_milli(
                                by_id[item_id].get("current_quantity_milli", quantity_milli(by_id[item_id]["current_quantity"]))
                            ),
                            "expected_quantity_milli": by_id[item_id].get(
                                "current_quantity_milli", quantity_milli(by_id[item_id]["current_quantity"])
                            ),
                            "expected_stock_version": by_id[item_id].get("stock_version"),
                            "counted_quantity": None,
                            "unit": by_id[item_id]["base_unit"]}
                           for item_id in ingredient_ids]
        counter = db.counters.find_one_and_update(
            {"_id": f"count_code:{principal.restaurant_id}"},
            {"$inc": {"value": 1}, "$setOnInsert": {"restaurant_id": principal.restaurant_id}},
            upsert=True, return_document=ReturnDocument.AFTER, session=session,
        )
        count["code"] = f"CT-{counter['value']:04d}"
        event_id = record_audit_event(db, event_id=f"audit_count_create:{count['_id']}",
            tenant=principal.restaurant_id, user_id=principal.user_id, action="count.create",
            entity="count", label=count["code"], before=None, after="open",
            reason="Contagem iniciada", occurred_at=timestamp,
            source_type="count", source_id=count["_id"], session=session)
        if event_id:
            count["create_audit_event_id"] = event_id
        db.counts.insert_one(count, session=session)
        return count

    try:
        with db.client.start_session() as session:
            return session.with_transaction(create)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            prior = db.counts.find_one({"restaurant_id": principal.restaurant_id,
                                        "create_key": idempotency_key})
            if prior and prior.get("request_fingerprint") == request_hash:
                return prior
            raise HTTPException(status_code=409, detail="Duplicate count idempotency key") from exc
        raise


def set_count_line(db, count_id: str, ingredient_id: str, data: CountLineUpdate,
                   principal: Principal) -> dict:
    timestamp = now()
    counted_milli = None if data.counted_quantity is None else quantity_milli(data.counted_quantity)
    def update(session):
        count = db.counts.find_one({"_id": count_id, "restaurant_id": principal.restaurant_id}, session=session)
        if count is None:
            raise HTTPException(status_code=404, detail="Count not found")
        if count.get("status") != "open":
            raise HTTPException(status_code=409, detail="Count is already closed")
        line = next((entry for entry in count.get("lines", [])
                     if entry["ingredient_id"] == ingredient_id), None)
        if line is None:
            raise HTTPException(status_code=404, detail="Ingredient is not part of this count")
        previous_milli = line.get("counted_quantity_milli")
        if previous_milli is None and line.get("counted_quantity") is not None:
            previous_milli = quantity_milli(line["counted_quantity"])
        if previous_milli == counted_milli:
            return count
        version = int(count.get("version", 1))
        if version != data.expected_version:
            raise HTTPException(status_code=409, detail="Count changed since it was loaded; refresh and retry")
        ingredient = db.ingredients.find_one({"_id": ingredient_id,
            "restaurant_id": principal.restaurant_id}, {"_id": 1, "name": 1}, session=session)
        label = ingredient.get("name", ingredient_id) if ingredient else ingredient_id
        event_id = record_audit_event(db, event_id=f"audit_count_line:{uuid4().hex}",
            tenant=principal.restaurant_id, user_id=principal.user_id, action="count.line.update",
            entity="count", label=f"{count.get('code', count_id)} · {label}",
            before=None if previous_milli is None else str(quantity_from_milli(previous_milli)),
            after=None if counted_milli is None else str(quantity_from_milli(counted_milli)),
            reason="Quantidade física atualizada", occurred_at=timestamp,
            source_type="count_line", source_id=count_id, session=session)
        updates = {"lines.$.counted_quantity": None if counted_milli is None else quantity_from_milli(counted_milli),
                   "lines.$.counted_quantity_milli": counted_milli, "updated_at": timestamp,
                   "version": version + 1}
        version_filter = {"version": version} if "version" in count else {"version": {"$exists": False}}
        result = db.counts.update_one(
            {"_id": count_id, "restaurant_id": principal.restaurant_id, "status": "open",
             **version_filter, "lines.ingredient_id": ingredient_id},
            {"$set": updates}, session=session)
        if result.matched_count != 1:
            raise HTTPException(status_code=409, detail="Count changed concurrently; refresh and retry")
        return db.counts.find_one({"_id": count_id, "restaurant_id": principal.restaurant_id}, session=session)

    with db.client.start_session() as session:
        return session.with_transaction(update)


def approve_count(db, count_id: str, principal: Principal, idempotency_key: str,
                  expected_version: int) -> dict:
    if not idempotency_key.strip() or len(idempotency_key) > 160:
        raise HTTPException(status_code=422, detail="A valid Idempotency-Key is required")

    request_hash = fingerprint({"count_id": count_id, "expected_version": expected_version})

    def approve(session):
        count = db.counts.find_one({"_id": count_id, "restaurant_id": principal.restaurant_id}, session=session)
        if count is None:
            raise HTTPException(status_code=404, detail="Count not found")
        if count.get("status") == "approved":
            if (count.get("approval_key") == idempotency_key
                    and count.get("approval_version", expected_version) == expected_version
                    and count.get("approval_request_fingerprint") == request_hash):
                return count
            raise HTTPException(status_code=409, detail="Count was already approved")
        if count.get("status") != "open":
            raise HTTPException(status_code=409, detail="Count cannot be approved")
        version = int(count.get("version", 1))
        if version != expected_version:
            raise HTTPException(status_code=409, detail="Count changed since it was reviewed; refresh before approval")
        if any(line.get("counted_quantity") is None for line in count["lines"]):
            raise HTTPException(status_code=422, detail="Every count line needs a physical quantity")

        ingredient_ids = [line["ingredient_id"] for line in count["lines"]]
        ingredients = {item["_id"]: item for item in db.ingredients.find(
            {"_id": {"$in": ingredient_ids}, "restaurant_id": principal.restaurant_id},
            session=session,
        )}
        if len(ingredients) != len(count["lines"]):
            raise HTTPException(status_code=409, detail="A counted ingredient is unavailable")
        financial_impact_cents = 0
        financial_divergence_cents = 0
        financial_impact_complete = True
        financial_lines = []
        for line in count["lines"]:
            current_value = ingredients[line["ingredient_id"]]
            current_milli = current_value.get("current_quantity_milli")
            current_milli = quantity_milli(current_value["current_quantity"]) if current_milli is None else int(current_milli)
            expected_milli = line.get("expected_quantity_milli")
            expected_milli = quantity_milli(line["expected_quantity"]) if expected_milli is None else int(expected_milli)
            if current_milli != expected_milli:
                raise HTTPException(status_code=409, detail="Stock changed after count started; start a new count")
            expected_stock_version = line.get("expected_stock_version")
            if (expected_stock_version is not None
                    and int(current_value.get("stock_version", 0)) != int(expected_stock_version)):
                raise HTTPException(status_code=409,
                    detail="Stock moved after count started; start a new count")

        # Touch every stock document, including zero-delta lines, so a concurrent movement
        # cannot commit between the snapshot check and count approval without a write conflict.
        for line in count["lines"]:
            ingredient_id = line["ingredient_id"]
            current_value = ingredients[ingredient_id]
            current_milli = current_value.get("current_quantity_milli")
            current_milli = quantity_milli(current_value["current_quantity"]) if current_milli is None else int(current_milli)
            balance_filter = ({"current_quantity_milli": current_milli}
                if "current_quantity_milli" in current_value else {
                    "current_quantity_milli": {"$exists": False},
                    "current_quantity": current_value["current_quantity"],
                })
            stock_version_filter = ({"stock_version": current_value["stock_version"]}
                if "stock_version" in current_value else {"stock_version": {"$exists": False}})
            fenced = db.ingredients.update_one(
                {"_id": ingredient_id, "restaurant_id": principal.restaurant_id,
                 **balance_filter, **stock_version_filter},
                {"$inc": {"count_approval_revision": 1}}, session=session,
            )
            if fenced.matched_count != 1:
                raise HTTPException(status_code=409,
                    detail="Stock changed while the count was being approved; start a new count")

        for line in count["lines"]:
            expected_milli = line.get("expected_quantity_milli")
            expected_milli = quantity_milli(line["expected_quantity"]) if expected_milli is None else int(expected_milli)
            counted_milli = line.get("counted_quantity_milli")
            counted_milli = quantity_milli(line["counted_quantity"]) if counted_milli is None else int(counted_milli)
            delta_milli = counted_milli - expected_milli
            financial_line = dict(line)
            ingredient = ingredients[line["ingredient_id"]]
            unit_cost_cents = int(ingredient.get("cost_cents", 0))
            cost_known = ingredient_cost_known(ingredient)
            financial_line["valuation_complete"] = cost_known
            if cost_known:
                financial_line["expected_value_cents"] = int((Decimal(expected_milli) * Decimal(unit_cost_cents)
                    / Decimal(1000)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
                financial_line["counted_value_cents"] = int((Decimal(counted_milli) * Decimal(unit_cost_cents)
                    / Decimal(1000)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
            else:
                financial_line["expected_value_cents"] = None
                financial_line["counted_value_cents"] = None
            if not delta_milli:
                financial_line["financial_impact_cents"] = 0
                financial_line["financial_impact_complete"] = True
                financial_lines.append(financial_line)
                continue
            if not cost_known:
                financial_impact_complete = False
                financial_line["financial_impact_cents"] = None
                financial_line["financial_impact_complete"] = False
            else:
                line_impact_cents = int((Decimal(delta_milli) * Decimal(unit_cost_cents)
                    / Decimal(1000)).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
                financial_impact_cents += line_impact_cents
                financial_divergence_cents += abs(line_impact_cents)
                financial_line["financial_impact_cents"] = line_impact_cents
                financial_line["financial_impact_complete"] = True
            financial_lines.append(financial_line)
            movement = MovementCreate(
                kind="count_in" if delta_milli > 0 else "count_out",
                quantity=quantity_from_milli(abs(delta_milli)),
                reason=f"Contagem física {count['code']}", unit=line["unit"],
                unit_cost_cents=unit_cost_cents if cost_known else None,
                purchase_reference=count_id,
            )
            _apply_movement(db, line["ingredient_id"], movement, principal,
                            f"{idempotency_key}:{line['ingredient_id']}", session)

        timestamp = now()
        event_id = record_audit_event(db, event_id=f"audit_count_approve:{count_id}",
            tenant=principal.restaurant_id, user_id=principal.user_id, action="count.approve",
            entity="count", label=count.get("code", count_id), before="open", after="approved",
            reason="Contagem conferida e aprovada", occurred_at=timestamp,
            source_type="count_approval", source_id=count_id, session=session)
        count_updates = {"status": "approved", "approved_at": timestamp,
                         "approved_by": principal.user_id, "approval_key": idempotency_key,
                         "approval_version": expected_version,
                         "approval_request_fingerprint": request_hash,
                         "updated_at": timestamp, "version": version + 1,
                         "lines": financial_lines,
                         "financial_impact_cents": financial_impact_cents if financial_impact_complete else None,
                          "financial_divergence_cents": financial_divergence_cents if financial_impact_complete else None,
                         "financial_impact_complete": financial_impact_complete}
        if event_id:
            count_updates["approval_audit_event_id"] = event_id
        version_filter = {"version": version} if "version" in count else {"version": {"$exists": False}}
        changed = db.counts.find_one_and_update(
            {"_id": count_id, "restaurant_id": principal.restaurant_id,
             "status": "open", **version_filter},
            {"$set": count_updates},
            return_document=ReturnDocument.AFTER, session=session,
        )
        if changed is None:
            raise HTTPException(status_code=409, detail="Count changed concurrently")
        return changed

    with db.client.start_session() as session:
        return session.with_transaction(approve)


def register_loss(db, data: LossCreate, principal: Principal, idempotency_key: str) -> dict:
    if not idempotency_key.strip() or len(idempotency_key) > 200:
        raise HTTPException(status_code=422, detail="A valid Idempotency-Key is required")
    request_hash = fingerprint(data.model_dump())

    def register(session):
        prior = db.losses.find_one({"restaurant_id": principal.restaurant_id,
                                    "idempotency_key": idempotency_key}, session=session)
        if prior:
            if prior.get("request_fingerprint") != request_hash:
                raise HTTPException(status_code=409, detail="Idempotency key was already used for another loss")
            return prior
        ingredient = db.ingredients.find_one(
            {"_id": data.ingredient_id, "restaurant_id": principal.restaurant_id, "active": True},
            session=session,
        )
        if ingredient is None:
            raise HTTPException(status_code=404, detail="Ingredient not found or inactive")
        unit = data.unit or ingredient["base_unit"]
        factor = Decimal(str(conversion_factor(ingredient, unit)))
        base_quantity = (Decimal(str(data.quantity)) * factor).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)
        value_complete = ingredient_cost_known(ingredient)
        value_cents = int((base_quantity * Decimal(str(ingredient["cost_cents"]))).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP)) if value_complete else None
        timestamp = now()
        movement_data = MovementCreate(kind="loss", quantity=float(data.quantity), unit=unit,
                                       unit_cost_cents=ingredient["cost_cents"] if value_complete else None,
                                       reason=data.reason)
        movement = _apply_movement(db, data.ingredient_id, movement_data, principal,
                                   idempotency_key, session)
        loss = {
            "_id": f"loss_{uuid4().hex}", "restaurant_id": principal.restaurant_id,
            "ingredient_id": data.ingredient_id, "quantity": float(base_quantity),
            "quantity_milli": quantity_milli(base_quantity),
            "entered_quantity": data.quantity, "unit": ingredient["base_unit"],
            "reason": data.reason, "note": data.note.strip(), "value_cents": value_cents,
            "value_complete": value_complete,
            "unit_cost_cents": ingredient["cost_cents"] if value_complete else None, "actor_id": principal.user_id,
            "occurred_at": timestamp, "idempotency_key": idempotency_key,
            "request_fingerprint": request_hash, "movement_id": movement["_id"],
        }
        audit_events = getattr(db, "audit_events", None)
        if audit_events is not None:
            event = {
                "_id": f"audit_{loss['_id']}", "restaurant_id": principal.restaurant_id,
                "user_id": principal.user_id, "action": "loss.register", "entity": "item",
                "entity_label": ingredient["name"], "before": None,
                "after": f"{loss['quantity']} {loss['unit']} · " +
                         (f"{loss['value_cents']} centavos" if value_complete else "custo não cadastrado"),
                "reason": loss["reason"] + (f" · {loss['note']}" if loss["note"] else ""),
                "at": timestamp, "source_type": "loss", "source_id": loss["_id"],
            }
            loss["audit_event_id"] = event["_id"]
            audit_events.insert_one(event, session=session)
        db.losses.insert_one(loss, session=session)
        return loss

    try:
        with db.client.start_session() as session:
            return session.with_transaction(register)
    except Exception as exc:
        if getattr(exc, "code", None) == 11000:
            prior = db.losses.find_one({"restaurant_id": principal.restaurant_id,
                                        "idempotency_key": idempotency_key})
            if prior and prior.get("request_fingerprint") == request_hash:
                return prior
            raise HTTPException(status_code=409, detail="Duplicate loss idempotency key") from exc
        raise


def list_audit_entries(db, principal: Principal, *, limit: int = 100,
                       before: tuple[datetime, str] | None = None,
                       include_legacy: bool = False, legacy_only: bool = False) -> list[dict]:
    tenant = principal.restaurant_id
    entries = []

    def add(event_id, user_id, action, entity, label, before_value, after_value, reason, occurred_at):
        if not user_id or not occurred_at:
            return
        occurred_at = utc_datetime(occurred_at)
        entries.append({"id": str(event_id), "restaurant_id": tenant, "user_id": user_id,
                        "action": action, "entity": entity, "entity_label": label,
                        "before": before_value, "after": after_value, "reason": reason, "at": occurred_at})

    def in_page(event_id, occurred_at):
        if before is None:
            return True
        event_key = (occurred_at, str(event_id))
        return event_key < before

    def source_query(timestamp_field: str, extra: dict | None = None, *, public_id_matches_db_id: bool = False):
        query = {"restaurant_id": tenant, **(extra or {})}
        if before is not None:
            time, event_id = before
            if public_id_matches_db_id:
                query["$or"] = [
                    {timestamp_field: {"$lt": time}},
                    {timestamp_field: time, "_id": {"$lt": event_id}},
                ]
            else:
                # Legacy public IDs can be synthetic; filter by time in Mongo
                # and use the public key for the final in-memory merge.
                query[timestamp_field] = {"$lte": time}
        return query

    # Current event records are always queried from the tenant-scoped index.
    lookahead = limit + 1
    audit_events = getattr(db, "audit_events", None)
    if audit_events is not None and not legacy_only:
        for event in audit_events.find(source_query("at", public_id_matches_db_id=True)).sort(
                [("at", -1), ("_id", -1)]).limit(lookahead):
            add(event["_id"], event.get("user_id"), event["action"], event["entity"],
                event["entity_label"], event.get("before"), event.get("after"),
                event["reason"], event.get("at"))

    migrations = getattr(db, "audit_migrations", None)
    migration = migrations.find_one({"_id": tenant, "status": "complete"}) if migrations is not None else None
    if migration is not None and not include_legacy:
        entries.sort(key=lambda entry: (entry["at"], entry["id"]), reverse=True)
        return entries[:lookahead]

    # Before legacy migration completes, combine legacy sources with persisted
    # events to preserve the full history during rollout.
    ingredients = {item["_id"]: item for item in db.ingredients.find({"restaurant_id": tenant},
        {"_id": 1, "name": 1, "base_unit": 1, "created_at": 1, "created_by": 1,
         "updated_at": 1, "updated_by": 1, "created_audit_event_id": 1, "updated_audit_event_id": 1
         })}
    # Purchases are also used to label legacy movements, so keep the tenant
    # projection complete until all historical source rows are migrated.
    purchases = {purchase["_id"]: purchase for purchase in db.purchases.find({"restaurant_id": tenant},
        {"_id": 1, "code": 1, "created_by": 1, "created_at": 1, "requested_by": 1,
         "requested_at": 1, "cancelled_by": 1, "cancelled_at": 1,
         "created_audit_event_id": 1, "request_audit_event_id": 1, "cancel_audit_event_id": 1})}

    for item in ingredients.values():
        if not item.get("created_audit_event_id"):
            if in_page(f"ingredient-create:{item['_id']}", item.get("created_at")):
                add(f"ingredient-create:{item['_id']}", item.get("created_by"), "ingredient.update", "item",
                item["name"], None, item["name"], "Cadastro de insumo", item.get("created_at"))
        if item.get("updated_by") and item.get("updated_at") != item.get("created_at") \
                and not item.get("updated_audit_event_id"):
            event_id = f"ingredient-update:{item['_id']}:{item['updated_at'].isoformat()}"
            if in_page(event_id, item["updated_at"]):
                add(event_id, item["updated_by"],
                "ingredient.update", "item", item["name"], None, item["name"],
                "Cadastro ou status do insumo atualizado", item.get("updated_at"))

    for supplier in db.suppliers.find({"restaurant_id": tenant},
        {"_id": 1, "name": 1, "created_at": 1, "created_by": 1, "updated_at": 1, "updated_by": 1,
         "created_audit_event_id": 1, "updated_audit_event_id": 1}):
        if not supplier.get("created_audit_event_id"):
            if in_page(f"supplier-create:{supplier['_id']}", supplier.get("created_at")):
                add(f"supplier-create:{supplier['_id']}", supplier.get("created_by"), "supplier.create", "supplier",
                supplier["name"], None, supplier["name"], "Cadastro de fornecedor", supplier.get("created_at"))
        if supplier.get("updated_by") and supplier.get("updated_at") != supplier.get("created_at") \
                and not supplier.get("updated_audit_event_id"):
            event_id = f"supplier-update:{supplier['_id']}:{supplier['updated_at'].isoformat()}"
            if in_page(event_id, supplier["updated_at"]):
                add(event_id, supplier["updated_by"],
                "supplier.update", "supplier", supplier["name"], None, supplier["name"],
                "Cadastro ou status do fornecedor atualizado", supplier.get("updated_at"))

    for movement in db.movements.find(source_query("occurred_at", {"audit_event_id": {"$exists": False}},
            public_id_matches_db_id=True)).sort(
            [("occurred_at", -1), ("_id", -1)]):
        if movement["kind"] == "loss":
            continue
        item = ingredients.get(movement["ingredient_id"], {})
        purchase = purchases.get(movement.get("purchase_reference"), {})
        action = "count.approve" if movement["kind"].startswith("count_") else (
            "purchase.receive" if movement["kind"] == "purchase" and purchase
            else "stock.adjust")
        reason = movement["reason"]
        if purchase.get("code"):
            reason = f"{reason} · {purchase['code']}"
        add(movement["_id"], movement.get("actor_id"), action, "item",
            item.get("name", movement["ingredient_id"]),
            str(movement.get("balance_before", "")), str(movement.get("balance_after", "")),
            reason, movement.get("occurred_at"))

    for loss in db.losses.find(source_query("occurred_at", {"audit_event_id": {"$exists": False}},
            public_id_matches_db_id=True)).sort(
            [("occurred_at", -1), ("_id", -1)]):
        item = ingredients.get(loss["ingredient_id"], {})
        note = loss.get("note", "").strip()
        reason = loss["reason"] + (f" · {note}" if note else "")
        loss_value = (f"{loss['value_cents']} centavos" if loss.get("value_complete", loss.get("value_cents") is not None)
                      else "custo não cadastrado")
        add(loss["_id"], loss.get("actor_id"), "loss.register", "item",
            item.get("name", loss["ingredient_id"]), None,
            f"{loss['quantity']} {loss['unit']} · {loss_value}", reason,
            loss.get("occurred_at"))

    for purchase in purchases.values():
        if not purchase.get("created_audit_event_id"):
            if in_page(f"purchase-create:{purchase['_id']}", purchase.get("created_at")):
                add(f"purchase-create:{purchase['_id']}", purchase.get("created_by"), "purchase.create", "purchase",
                purchase.get("code", purchase["_id"]), None, "draft", "Rascunho de compra criado",
                purchase.get("created_at"))
        if not purchase.get("request_audit_event_id"):
            if in_page(f"purchase-request:{purchase['_id']}", purchase.get("requested_at")):
                add(f"purchase-request:{purchase['_id']}", purchase.get("requested_by"), "purchase.create", "purchase",
                purchase.get("code", purchase["_id"]), "draft", "requested", "Compra enviada ao fornecedor",
                purchase.get("requested_at"))
        if not purchase.get("cancel_audit_event_id"):
            if in_page(f"purchase-cancel:{purchase['_id']}", purchase.get("cancelled_at")):
                add(f"purchase-cancel:{purchase['_id']}", purchase.get("cancelled_by"), "purchase.cancel", "purchase",
                purchase.get("code", purchase["_id"]), None, "cancelled", "Compra cancelada",
                purchase.get("cancelled_at"))

    for change in db.purchase_changes.find(source_query("occurred_at", {
            "audit_event_id": {"$exists": False}}, public_id_matches_db_id=True)).sort(
            [("occurred_at", -1), ("_id", -1)]):
        purchase = purchases.get(change["purchase_id"], {})
        old = change.get("before", {})
        new = change.get("after", {})
        add(change["_id"], change.get("actor_id"), "purchase.update", "purchase",
            purchase.get("code", change["purchase_id"]),
            f"{len(old.get('lines', []))} linhas · {old.get('note', '')}",
            f"{len(new.get('lines', []))} linhas · {new.get('note', '')}",
            "Rascunho de compra editado", change.get("occurred_at"))

    for snapshot in db.recipe_snapshots.find(source_query("occurred_at", {
            "audit_event_id": {"$exists": False}}, public_id_matches_db_id=True)).sort(
            [("occurred_at", -1), ("_id", -1)]):
        add(snapshot["_id"], snapshot.get("actor_id"), "recipe.cost.snapshot", "recipe",
            snapshot.get("product_name", snapshot["product_id"]), None,
            str(snapshot["cost_cents"]), snapshot["trigger"], snapshot.get("occurred_at"))

    for count in db.counts.find(source_query("approved_at", {"status": "approved",
            "approval_audit_event_id": {"$exists": False}})).sort(
            [("approved_at", -1), ("_id", -1)]):
        add(f"count-approve:{count['_id']}", count.get("approved_by"), "count.approve", "count",
            count.get("code", count["_id"]), "open", "approved", "Contagem conferida e aprovada",
            count.get("approved_at"))

    for receipt in db.purchase_receipts.find(source_query("received_at")).sort(
            [("received_at", -1), ("_id", -1)]):
        purchase = purchases.get(receipt["purchase_id"], {})
        if not receipt.get("audit_event_id"):
            if in_page(receipt["_id"], receipt.get("received_at")):
                add(receipt["_id"], receipt.get("actor_id"), "purchase.receive", "purchase",
                purchase.get("code", receipt["purchase_id"]), None,
                f"{len(receipt.get('lines', []))} linha(s) recebida(s)", "Recebimento de mercadorias",
                receipt.get("received_at"))
        if receipt.get("reversed_at") and not receipt.get("reversal_audit_event_id"):
            reversal_id = f"receipt-reversal:{receipt['_id']}"
            if in_page(reversal_id, receipt["reversed_at"]):
                add(reversal_id, receipt.get("reversed_by"),
                "purchase.receipt.reverse", "purchase", purchase.get("code", receipt["purchase_id"]),
                "recebido", "estornado", receipt.get("reversal_reason", "Estorno de recebimento"),
                receipt.get("reversed_at"))

    entries = [entry for entry in entries if in_page(entry["id"], entry["at"])]
    deduplicated = {}
    for entry in entries:
        deduplicated.setdefault(entry["id"], entry)
    entries = list(deduplicated.values())
    entries.sort(key=lambda entry: (entry["at"], entry["id"]), reverse=True)
    return entries[:lookahead]
