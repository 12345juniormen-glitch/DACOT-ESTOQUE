import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pymongo.errors import ServerSelectionTimeoutError

from app import main
from app.database import Database, MongoTransactionSupportError, supports_transactions


@pytest.mark.parametrize("hello", [
    {"setName": "rs0", "isWritablePrimary": True},
    {"msg": "isdbgrid"},
])
def test_health_reports_transaction_support_for_replica_set_or_sharded_cluster(monkeypatch, hello):
    commands = []

    class Admin:
        def command(self, name):
            commands.append(name)
            return hello if name == "hello" else {"ok": 1}

    database = Database.__new__(Database)
    database.client = SimpleNamespace(admin=Admin())
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database=database)))
    monkeypatch.setattr(main, "settings", SimpleNamespace(hub_auth_configured=True))

    result = main.health(request)

    assert result == {"status": "ok", "database": "ok", "transactions": "supported"}
    assert commands == ["ping", "hello"]
    assert supports_transactions(hello)


def test_health_rejects_standalone_mongodb(monkeypatch):
    class Admin:
        def command(self, name):
            return {"ok": 1}

    database = Database.__new__(Database)
    database.client = SimpleNamespace(admin=Admin())
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database=database)))
    monkeypatch.setattr(main, "settings", SimpleNamespace(hub_auth_configured=True))

    with pytest.raises(HTTPException) as error:
        main.health(request)

    assert error.value.status_code == 503
    assert "replica set or sharded cluster" in error.value.detail
    assert not supports_transactions({"isWritablePrimary": True})


@pytest.mark.parametrize("failing_command", ["ping", "hello"])
def test_health_reports_database_command_failures_as_unavailable(monkeypatch, failing_command):
    class Admin:
        def command(self, name):
            if name == failing_command:
                raise ServerSelectionTimeoutError("database host unavailable")
            return {"setName": "rs0", "ok": 1}

    database = Database.__new__(Database)
    database.client = SimpleNamespace(admin=Admin())
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(database=database)))
    monkeypatch.setattr(main, "settings", SimpleNamespace(hub_auth_configured=True))

    with pytest.raises(HTTPException) as error:
        main.health(request)

    assert error.value.status_code == 503
    assert "unavailable" in error.value.detail.lower()


def test_application_startup_refuses_mongodb_without_transactions(monkeypatch):
    closed = False

    class UnsupportedDatabase:
        def __init__(self, _settings):
            pass

        def check_transaction_support(self):
            raise MongoTransactionSupportError("replica set or sharded cluster required")

        def ensure_indexes(self):
            raise AssertionError("Indexes must not be created before transaction support is checked")

        def close(self):
            nonlocal closed
            closed = True

    monkeypatch.setattr(main, "settings", SimpleNamespace(environment="development", hub_auth_configured=True))
    monkeypatch.setattr(main, "Database", UnsupportedDatabase)

    async def start():
        async with main.lifespan(main.app):
            raise AssertionError("Application must not serve with unsupported MongoDB")

    with pytest.raises(MongoTransactionSupportError):
        asyncio.run(start())
    assert closed


def test_production_startup_refuses_missing_hub_auth_configuration(monkeypatch):
    monkeypatch.setattr(main, "settings", SimpleNamespace(environment="production", hub_auth_configured=False))
    monkeypatch.setattr(main, "Database", lambda _settings: pytest.fail("Database must not be opened"))

    async def start():
        async with main.lifespan(main.app):
            raise AssertionError("Application must not serve without HUB auth")

    with pytest.raises(RuntimeError, match="DACOT-HUB authentication is not configured"):
        asyncio.run(start())
