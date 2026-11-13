from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from pymongo.errors import DuplicateKeyError
import pytest

from app.audit_migration import backfill_legacy_audit
from app.auth import Principal
from app.service import list_audit_entries


class Cursor(list):
    def sort(self, keys):
        for key, direction in reversed(keys):
            super().sort(key=lambda row: row.get(key), reverse=direction < 0)
        return self

    def limit(self, amount):
        return Cursor(self[:amount])


class Collection:
    def __init__(self, rows=()):
        self.rows = [dict(row) for row in rows]
        self.find_calls = 0

    @staticmethod
    def matches(row, query):
        for key, value in query.items():
            if key == "$or":
                if not any(Collection.matches(row, branch) for branch in value):
                    return False
            elif isinstance(value, dict) and "$exists" in value:
                if (key in row) is not value["$exists"]:
                    return False
            elif isinstance(value, dict) and "$lt" in value:
                if row.get(key) is None or not row[key] < value["$lt"]:
                    return False
            elif isinstance(value, dict) and "$lte" in value:
                if row.get(key) is None or not row[key] <= value["$lte"]:
                    return False
            elif row.get(key) != value:
                return False
        return True

    def find(self, query=None, *_args):
        self.find_calls += 1
        return Cursor([row for row in self.rows if self.matches(row, query or {})])

    def find_one(self, query, *_args, **_kwargs):
        return next((row for row in self.rows if self.matches(row, query)), None)

    def insert_one(self, row, **_kwargs):
        if self.find_one({"_id": row["_id"]}):
            raise DuplicateKeyError("duplicate key")
        self.rows.append(dict(row))

    def update_one(self, query, update, upsert=False, **_kwargs):
        row = self.find_one(query)
        if row is None:
            if not upsert:
                return SimpleNamespace(matched_count=0, modified_count=0)
            row = {key: value for key, value in query.items() if key != "$or"}
            self.rows.append(row)
        row.update(update.get("$set", {}))
        return SimpleNamespace(matched_count=1, modified_count=1)


class FakeDb:
    def __init__(self):
        self.audit_events = Collection()
        self.audit_migrations = Collection()
        self.ingredients = Collection()
        self.suppliers = Collection()
        self.purchases = Collection()
        self.movements = Collection([{
            "_id": "mov_legacy_1", "restaurant_id": "restaurant-a", "ingredient_id": "ing_1",
            "kind": "adjustment_in", "actor_id": "user-1", "reason": "Legacy receipt",
            "balance_before": 0, "balance_after": 1,
            "occurred_at": datetime(2026, 1, 1, tzinfo=timezone.utc),
        }])
        self.losses = Collection()
        self.purchase_changes = Collection()
        self.recipe_snapshots = Collection()
        self.counts = Collection()
        self.purchase_receipts = Collection()


def test_backfill_is_idempotent_marks_sources_and_enables_fast_reads():
    db = FakeDb()
    result = backfill_legacy_audit(db, "restaurant-a", batch_size=1, apply=True)
    assert result == {"scanned": 1, "inserted": 1, "applied": True}
    assert db.movements.rows[0]["audit_event_id"] == "mov_legacy_1"
    assert db.audit_events.rows[0]["source_type"] == "movements"
    assert db.audit_events.rows[0]["source_id"] == "mov_legacy_1"

    retried = backfill_legacy_audit(db, "restaurant-a", batch_size=1, apply=True)
    assert retried == {"scanned": 0, "inserted": 0, "applied": True}
    assert len(db.audit_events.rows) == 1

    db.movements.find_calls = 0
    entries = list_audit_entries(db, Principal("user-1", "restaurant-a", ("manager",)), limit=10)
    assert len(entries) == 1
    assert db.movements.find_calls == 0


def test_dry_run_counts_legacy_events_without_writing_or_completing():
    db = FakeDb()
    result = backfill_legacy_audit(db, "restaurant-a", batch_size=10, apply=False)
    assert result == {"scanned": 1, "inserted": 0, "applied": False}
    assert db.audit_events.rows == []
    assert db.audit_migrations.rows == []


def test_backfill_does_not_skip_rows_when_marker_writes_shrink_legacy_feed():
    db = FakeDb()
    for index in range(600):
        db.movements.rows.append({
            "_id": f"mov_extra_{index:04d}", "restaurant_id": "restaurant-a", "ingredient_id": "ing_1",
            "kind": "adjustment_in", "actor_id": "user-1", "reason": f"Legacy receipt {index}",
            "balance_before": index, "balance_after": index + 1,
            "occurred_at": datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=index),
        })

    result = backfill_legacy_audit(db, "restaurant-a", batch_size=2, apply=True)

    assert result["scanned"] == 601
    assert result["inserted"] == 601
    assert len(db.audit_events.rows) == 601
    assert all(row.get("audit_event_id") == row["_id"] for row in db.movements.rows)
    assert db.audit_migrations.rows[0]["status"] == "complete"


def test_interrupted_backfill_resumes_without_losing_or_duplicating_history():
    db = FakeDb()
    for index in range(5):
        db.movements.rows.append({
            "_id": f"mov_resume_{index}", "restaurant_id": "restaurant-a", "ingredient_id": "ing_1",
            "kind": "adjustment_in", "actor_id": "user-1", "reason": f"Resumable event {index}",
            "balance_before": index, "balance_after": index + 1,
            "occurred_at": datetime(2026, 2, 1 + index, tzinfo=timezone.utc),
        })

    # Simulate a crash after a partial write by forcing a failure on the third row.
    original_insert = db.audit_events.insert_one
    inserted_ids = set()

    def fail_once(event):
        if event["_id"] == "mov_resume_2" and "mov_resume_2" not in inserted_ids:
            raise RuntimeError("simulated interruption")
        original_insert(event)
        inserted_ids.add(event["_id"])

    db.audit_events.insert_one = fail_once
    from pytest import raises
    with raises(RuntimeError, match="simulated interruption"):
        backfill_legacy_audit(db, "restaurant-a", batch_size=2, apply=True)
    assert db.audit_migrations.rows == []

    db.audit_events.insert_one = original_insert
    resumed = backfill_legacy_audit(db, "restaurant-a", batch_size=2, apply=True)

    assert resumed["scanned"] == 6
    assert len(db.audit_events.rows) == 6
    assert len({event["_id"] for event in db.audit_events.rows}) == 6
    assert db.audit_migrations.rows[0]["status"] == "complete"


def test_backfill_retry_after_event_insert_before_source_marker_is_idempotent():
    db = FakeDb()
    original_update = db.movements.update_one

    def fail_marker_once(query, update, **kwargs):
        if "audit_event_id" in update.get("$set", {}):
            db.movements.update_one = original_update
            raise RuntimeError("simulated interruption before source marker")
        return original_update(query, update, **kwargs)

    db.movements.update_one = fail_marker_once
    from pytest import raises
    with raises(RuntimeError, match="before source marker"):
        backfill_legacy_audit(db, "restaurant-a", batch_size=1, apply=True)
    assert len(db.audit_events.rows) == 1
    assert db.audit_migrations.rows == []

    resumed = backfill_legacy_audit(db, "restaurant-a", batch_size=1, apply=True)

    assert resumed["inserted"] == 0
    assert len(db.audit_events.rows) == 1
    assert db.movements.rows[0]["audit_event_id"] == "mov_legacy_1"
    assert db.audit_migrations.rows[0]["status"] == "complete"


def test_backfill_refuses_event_id_collision_with_another_restaurant():
    db = FakeDb()
    db.audit_events.insert_one({
        "_id": "mov_legacy_1", "restaurant_id": "restaurant-b", "user_id": "user-b",
        "action": "stock.adjust", "entity": "item", "entity_label": "Other tenant",
        "before": "0", "after": "1", "reason": "Existing event",
        "at": datetime(2026, 2, 1, tzinfo=timezone.utc),
    })

    from pytest import raises
    with raises(RuntimeError, match="collides with another restaurant"):
        backfill_legacy_audit(db, "restaurant-a", batch_size=10, apply=True)

    assert len(db.audit_events.rows) == 1
    assert db.audit_migrations.rows == []
    assert "audit_event_id" not in db.movements.rows[0]


def test_backfill_refuses_same_tenant_event_id_collision_with_different_content():
    db = FakeDb()
    db.audit_events.insert_one({
        "_id": "mov_legacy_1", "restaurant_id": "restaurant-a", "user_id": "user-1",
        "action": "purchase.cancel", "entity": "purchase", "entity_label": "Different event",
        "before": None, "after": "cancelled", "reason": "Different operation",
        "at": datetime(2026, 1, 1, tzinfo=timezone.utc),
    })

    from pytest import raises
    with raises(RuntimeError, match="collides with different event content"):
        backfill_legacy_audit(db, "restaurant-a", batch_size=10, apply=True)

    assert len(db.audit_events.rows) == 1
    assert db.audit_migrations.rows == []
    assert "audit_event_id" not in db.movements.rows[0]


def test_backfill_does_not_reclassify_current_audit_events():
    db = FakeDb()
    current = {
        "_id": "audit_current_1", "restaurant_id": "restaurant-a", "user_id": "user-1",
        "action": "stock.adjust", "entity": "item", "entity_label": "Current event",
        "before": "0", "after": "1", "reason": "Current operation",
        "at": datetime(2026, 3, 1, tzinfo=timezone.utc), "source_type": "movement",
        "source_id": "mov_current_1",
    }
    db.audit_events.insert_one(current)

    result = backfill_legacy_audit(db, "restaurant-a", batch_size=1, apply=True)

    assert result == {"scanned": 1, "inserted": 1, "applied": True}
    persisted_current = db.audit_events.find_one({"_id": "audit_current_1"})
    assert persisted_current == current
    assert "backfilled" not in persisted_current
    assert db.movements.rows[0].get("audit_event_id") == "mov_legacy_1"


def test_migration_cli_only_prepares_indexes_in_explicit_apply_mode(monkeypatch, capsys):
    import app.audit_migration as migration
    import app.config
    import app.database

    class FakeDatabase:
        db = object()

        def __init__(self):
            self.index_setup_calls = 0
            self.closed = False

        def ensure_indexes(self):
            self.index_setup_calls += 1

        def close(self):
            self.closed = True

    for apply in (False, True):
        fake_database = FakeDatabase()
        monkeypatch.setattr(app.config, "get_settings", lambda: SimpleNamespace(environment="test"))
        monkeypatch.setattr(app.database, "Database", lambda _settings: fake_database)
        monkeypatch.setattr(migration, "backfill_legacy_audit", lambda *_args, **_kwargs: {
            "scanned": 0, "inserted": 0, "applied": apply,
        })
        arguments = ["--restaurant-id", "restaurant-a"]
        if apply:
            arguments.append("--apply")

        migration.main(arguments)

        assert fake_database.index_setup_calls == int(apply)
        assert fake_database.closed is True
        assert capsys.readouterr().out.strip() == str({
            "scanned": 0, "inserted": 0, "applied": apply,
        })


def test_migration_cli_refuses_production_apply_without_explicit_ack(monkeypatch):
    import app.config
    import app.database
    import app.audit_migration as migration

    monkeypatch.setattr(app.config, "get_settings", lambda: SimpleNamespace(environment="production"))
    monkeypatch.setattr(app.database, "Database", lambda _settings: pytest.fail(
        "production database must not be opened without explicit acknowledgement"))

    with pytest.raises(SystemExit) as error:
        migration.main(["--restaurant-id", "restaurant-a", "--apply"])

    assert error.value.code == 2
