"""Resumable migration of synthesized legacy audit entries into audit_events."""

from pymongo.errors import DuplicateKeyError

from app.auth import Principal
from app.service import list_audit_entries, utc_datetime


def _legacy_source(entry: dict) -> tuple[str, str, str] | None:
    event_id = entry["id"]
    action = entry["action"]
    entity = entry["entity"]

    if action in {"stock.adjust", "purchase.receive"} and entity == "item":
        return "movements", event_id, "audit_event_id"
    if action == "count.approve" and entity == "item":
        return "movements", event_id, "audit_event_id"
    if action == "loss.register":
        return "losses", event_id, "audit_event_id"
    if action == "purchase.update" and entity == "purchase":
        return "purchase_changes", event_id, "audit_event_id"
    if action == "recipe.cost.snapshot":
        return "recipe_snapshots", event_id, "audit_event_id"
    if action == "count.approve" and entity == "count" and event_id.startswith("count-approve:"):
        return "counts", event_id.removeprefix("count-approve:"), "approval_audit_event_id"
    if action == "purchase.receive" and entity == "purchase":
        return "purchase_receipts", event_id, "audit_event_id"
    if action == "purchase.receipt.reverse" and event_id.startswith("receipt-reversal:"):
        return "purchase_receipts", event_id.removeprefix("receipt-reversal:"), "reversal_audit_event_id"
    if action == "ingredient.update" and entity == "item":
        if event_id.startswith("ingredient-create:"):
            return "ingredients", event_id.removeprefix("ingredient-create:"), "created_audit_event_id"
        if event_id.startswith("ingredient-update:"):
            ingredient_id = event_id.split(":", 2)[1]
            return "ingredients", ingredient_id, "updated_audit_event_id"
    if action == "supplier.create":
        return "suppliers", event_id.removeprefix("supplier-create:"), "created_audit_event_id"
    if action == "supplier.update":
        supplier_id = event_id.split(":", 2)[1] if event_id.startswith("supplier-update:") else event_id
        return "suppliers", supplier_id, "updated_audit_event_id"
    if action == "purchase.create" and entity == "purchase":
        field = "request_audit_event_id" if entry.get("after") == "requested" else "created_audit_event_id"
        purchase_id = event_id.split(":", 1)[1] if ":" in event_id else event_id
        return "purchases", purchase_id, field
    if action == "purchase.cancel" and entity == "purchase":
        purchase_id = event_id.split(":", 1)[1] if ":" in event_id else event_id
        return "purchases", purchase_id, "cancel_audit_event_id"
    return None


def _insert_legacy_event(db, tenant: str, entry: dict) -> bool:
    event_id = entry["id"]
    source = _legacy_source(entry)
    event = {
        "_id": event_id,
        "restaurant_id": tenant,
        "user_id": entry["user_id"],
        "action": entry["action"],
        "entity": entry["entity"],
        "entity_label": entry["entity_label"],
        "before": entry.get("before"),
        "after": entry.get("after"),
        "reason": entry["reason"],
        "at": entry["at"],
        "source_type": source[0] if source else "legacy",
        "source_id": source[1] if source else event_id,
        "backfilled": True,
    }
    inserted = False
    try:
        db.audit_events.insert_one(event)
        inserted = True
    except DuplicateKeyError as exc:
        # A retry after a crash or an overlapping current event is expected.
        existing = db.audit_events.find_one({"_id": event_id})
        if existing is None or existing.get("restaurant_id") != tenant:
            raise RuntimeError("Legacy audit event ID collides with another restaurant") from exc
        comparable_fields = ("restaurant_id", "user_id", "action", "entity", "entity_label",
                             "before", "after", "reason")
        if any(existing.get(field) != event.get(field) for field in comparable_fields) \
                or existing.get("at") is None or utc_datetime(existing["at"]) != utc_datetime(event["at"]):
            raise RuntimeError("Legacy audit event ID collides with different event content") from exc

    return inserted


def _mark_source(db, tenant: str, event: dict) -> None:
    source = _legacy_source({"id": event["_id"], "action": event["action"],
                             "entity": event["entity"], "after": event.get("after")})
    if source:
        collection_name, source_id, marker = source
        getattr(db, collection_name).update_one(
            {"_id": source_id, "restaurant_id": tenant, marker: {"$exists": False}},
            {"$set": {marker: event["_id"]}},
        )


def _backfill_legacy_events(db, tenant: str, batch_size: int) -> tuple[int, int]:
    """Insert legacy feed events in stable pages without hiding source rows mid-scan."""
    principal = Principal("audit-backfill", tenant, ("manager",))
    cursor = None
    scanned = inserted = 0
    while True:
        rows = list_audit_entries(db, principal, limit=batch_size, before=cursor,
                                  include_legacy=True, legacy_only=True)
        page = rows[:batch_size]
        scanned += len(page)
        for entry in page:
            inserted += int(_insert_legacy_event(db, tenant, entry))
        if len(rows) <= batch_size:
            break
        last = page[-1]
        cursor = (last["at"], last["id"])
    return scanned, inserted


def _mark_backfilled_sources(db, tenant: str, batch_size: int) -> None:
    cursor = None
    while True:
        query = {"restaurant_id": tenant, "backfilled": True}
        if cursor is not None:
            at, event_id = cursor
            query["$or"] = [{"at": {"$lt": at}}, {"at": at, "_id": {"$lt": event_id}}]
        rows = list(db.audit_events.find(query).sort([("at", -1), ("_id", -1)]).limit(batch_size + 1))
        page = rows[:batch_size]
        for event in page:
            _mark_source(db, tenant, event)
        if len(rows) <= batch_size:
            break
        last = page[-1]
        cursor = (last["at"], last["_id"])


def backfill_legacy_audit(db, restaurant_id: str, *, batch_size: int = 250,
                          apply: bool = False) -> dict[str, int | bool]:
    """Count or migrate a tenant's complete audit feed without changing domain records."""
    if not 1 <= batch_size <= 500:
        raise ValueError("batch_size must be between 1 and 500")
    # Keep legacy rows visible until every event is persisted, so a crash can
    # safely retry from page one and duplicate event IDs are harmless.
    scanned = 0
    inserted = 0
    if apply:
        scanned, inserted = _backfill_legacy_events(db, restaurant_id, batch_size)
        _mark_backfilled_sources(db, restaurant_id, batch_size)
    else:
        principal = Principal("audit-backfill", restaurant_id, ("manager",))
        cursor = None
        while True:
            rows = list_audit_entries(db, principal, limit=batch_size, before=cursor,
                                      include_legacy=True, legacy_only=True)
            page = rows[:batch_size]
            scanned += len(page)
            if len(rows) <= batch_size:
                break
            last = page[-1]
            cursor = (last["at"], last["id"])

    if apply:
        db.audit_migrations.update_one(
            {"_id": restaurant_id},
            {"$set": {"status": "complete", "entry_count": scanned}},
            upsert=True,
        )
    return {"scanned": scanned, "inserted": inserted, "applied": apply}


def main(argv: list[str] | None = None) -> None:
    import argparse

    from app.config import get_settings
    from app.database import Database

    parser = argparse.ArgumentParser(description="Backfill a single restaurant's legacy audit events.")
    parser.add_argument("--restaurant-id", required=True)
    parser.add_argument("--batch-size", type=int, default=250)
    parser.add_argument("--apply", action="store_true", help="Write legacy audit events and completion marker.")
    parser.add_argument("--allow-production", action="store_true",
                        help="Required with --apply when ENVIRONMENT=production.")
    args = parser.parse_args(argv)
    settings = get_settings()
    if args.apply and settings.environment == "production" and not args.allow_production:
        parser.error("--allow-production is required for write mode in production")
    database = Database(settings)
    try:
        # Dry runs must remain read-only. Index setup may create indexes or
        # replace legacy definitions, so reserve it for explicit apply mode.
        if args.apply:
            database.ensure_indexes()
        result = backfill_legacy_audit(database.db, args.restaurant_id,
                                       batch_size=args.batch_size, apply=args.apply)
        print(result)
    finally:
        database.close()


if __name__ == "__main__":
    main()
