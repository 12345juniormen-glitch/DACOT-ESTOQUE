from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi.testclient import TestClient

from app import main
from app.config import Settings

SECRET = "inventory-test-signing-secret-1234567890"


def make_handoff():
    now = datetime.now(timezone.utc)
    return jwt.encode({
        "iss": "dacot-hub", "aud": "dacot-estoque",
        "sub": "tenant_user:65a000000000000000000001",
        "restaurant_id": "65a000000000000000000002", "role": "manager",
        "module": "inventory", "hub_access": {"user": 0, "tenant": 0, "module": 0},
        "jti": "inventory-session-test-unique-id", "iat": int(now.timestamp()),
        "nbf": int(now.timestamp()), "exp": int((now + timedelta(seconds=60)).timestamp()),
        "handoff_version": 1,
    }, SECRET, algorithm="HS256")


@pytest.fixture
def client(monkeypatch):
    test_settings = Settings(environment="production", handoff_jwt_secret=SECRET,
        hub_base_url="https://hub.example.test", hub_module_key="inventory-key-test-1234567890",
        cors_origins=["https://estoque.dacot.com.br"])
    monkeypatch.setattr(main, "settings", test_settings)
    monkeypatch.setattr(main, "hub_confirms_module_active", lambda claims, settings: None)
    monkeypatch.setattr(main, "db_from", lambda request: object())
    monkeypatch.setattr(main, "create_local_session", lambda *args, **kwargs: None)
    monkeypatch.setattr(main, "issue_browser_binding", lambda: "test-browser-binding")
    return TestClient(main.app)


def test_exchange_issues_secure_httponly_host_cookie(client):
    response = client.post("/api/v1/auth/session/exchange", json={"handoff": make_handoff()},
                          headers={"X-DACOT-Tab-Session": "6ba7b810-9dad-11d1-80b4-00c04fd430c8"})
    assert response.status_code == 204
    cookie = response.headers["set-cookie"].lower()
    assert cookie.startswith("__host-dacot-estoque-browser=")
    assert "httponly" in cookie and "secure" in cookie
    assert "samesite=none" in cookie and "path=/" in cookie


def test_exchange_rejects_invalid_tab_binding(client):
    response = client.post("/api/v1/auth/session/exchange", json={"handoff": make_handoff()},
                          headers={"X-DACOT-Tab-Session": "invalid"})
    assert response.status_code == 422
