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
    return TestClient(main.app, base_url="https://api-estoque.dacot.com.br")


def test_exchange_issues_secure_httponly_host_cookie(client):
    response = client.post("/api/v1/auth/session/exchange", json={"handoff": make_handoff()},
                          headers={"Origin": "https://estoque.dacot.com.br",
                                   "X-DACOT-Tab-Session": "6ba7b810-9dad-11d1-80b4-00c04fd430c8"})
    assert response.status_code == 204
    cookie = response.headers["set-cookie"].lower()
    assert cookie.startswith("__host-dacot-estoque-browser=")
    assert "httponly" in cookie and "secure" in cookie
    assert "samesite=lax" in cookie and "path=/" in cookie


def test_exchange_rejects_handoff_that_expires_during_hub_check(client, monkeypatch):
    def expires_at_hub(claims, _settings):
        claims["exp"] = int(datetime.now(timezone.utc).timestamp()) - 1

    created = []
    monkeypatch.setattr(main, "hub_confirms_module_active", expires_at_hub)
    monkeypatch.setattr(main, "create_local_session", lambda *args, **kwargs: created.append(True))
    response = client.post("/api/v1/auth/session/exchange", json={"handoff": make_handoff()},
        headers={"Origin": "https://estoque.dacot.com.br",
                 "X-DACOT-Tab-Session": "6ba7b810-9dad-11d1-80b4-00c04fd430c8"})
    assert response.status_code == 401
    assert created == []


def test_api_responses_disable_private_caching_including_auth_errors(client):
    from types import SimpleNamespace

    main.app.state.database = SimpleNamespace(db=SimpleNamespace(
        auth_sessions=SimpleNamespace(find_one=lambda _query: None)))
    response = client.get("/api/v1/ingredients")
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["referrer-policy"] == "no-referrer"


def test_exchange_rejects_invalid_tab_binding(client):
    response = client.post("/api/v1/auth/session/exchange", json={"handoff": make_handoff()},
                          headers={"Origin": "https://estoque.dacot.com.br",
                                   "X-DACOT-Tab-Session": "invalid"})
    assert response.status_code == 422


def test_exchange_rejects_missing_origin(client):
    response = client.post("/api/v1/auth/session/exchange", json={"handoff": make_handoff()},
                          headers={"X-DACOT-Tab-Session": "6ba7b810-9dad-11d1-80b4-00c04fd430c8"})
    assert response.status_code == 403


def test_exchange_rejects_untrusted_origin(client):
    response = client.post("/api/v1/auth/session/exchange", json={"handoff": make_handoff()},
        headers={"Origin": "https://attacker.example",
                 "X-DACOT-Tab-Session": "6ba7b810-9dad-11d1-80b4-00c04fd430c8"})
    assert response.status_code == 403


def test_exchange_reuses_valid_browser_binding_for_another_tab(client, monkeypatch):
    binding = "A" * 43
    created = []
    monkeypatch.setattr(main, "create_local_session",
        lambda _db, *, binding, tab_id, claims: created.append((binding, tab_id)))
    response = client.post("/api/v1/auth/session/exchange", json={"handoff": make_handoff()},
        headers={"X-DACOT-Tab-Session": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
                 "Origin": "https://estoque.dacot.com.br",
                 "Cookie": f"__Host-dacot-estoque-browser={binding}"})

    assert response.status_code == 204
    assert created == [(binding, "6ba7b810-9dad-11d1-80b4-00c04fd430c8")]
    assert response.headers["set-cookie"].startswith(f"__Host-dacot-estoque-browser={binding}")


def test_refresh_requires_an_allowed_origin(client):
    response = client.post("/api/v1/auth/refresh", headers={
        "Origin": "https://attacker.example",
        "X-DACOT-Tab-Session": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    })
    assert response.status_code == 403


def test_refresh_accepts_the_configured_frontend_origin(client):
    response = client.post("/api/v1/auth/refresh", headers={
        "Origin": "https://estoque.dacot.com.br",
        "X-DACOT-Tab-Session": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    })
    # Origin validation occurs before session lookup.
    assert response.status_code == 401


def test_logout_requires_allowed_origin_and_revokes_the_bound_session(client, monkeypatch):
    class Sessions:
        query = None
        update = None

        def update_one(self, query, update):
            self.query = query
            self.update = update

    sessions = Sessions()
    monkeypatch.setattr(main, "db_from", lambda _request: type("DatabaseStub", (), {
        "auth_sessions": sessions,
    })())
    headers = {
        "Origin": "https://estoque.dacot.com.br",
        "Cookie": "__Host-dacot-estoque-browser=bound-browser-session",
        "X-DACOT-Tab-Session": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    }

    response = client.post("/api/v1/auth/logout", headers=headers)

    assert response.status_code == 204
    assert sessions.query["browser_binding_hash"]
    assert sessions.query["tab_session_id_hash"]
    assert sessions.query["revoked_at"] is None
    assert sessions.update["$set"]["revocation_reason"] == "logout"
    assert "max-age=0" in response.headers["set-cookie"].lower()
    assert "samesite=lax" in response.headers["set-cookie"].lower()


def test_logout_rejects_untrusted_origin_without_revoking_session(client, monkeypatch):
    called = False

    def db_from(_request):
        nonlocal called
        called = True
        return object()

    monkeypatch.setattr(main, "db_from", db_from)
    response = client.post("/api/v1/auth/logout", headers={
        "Origin": "https://attacker.example",
        "X-DACOT-Tab-Session": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    })

    assert response.status_code == 403
    assert called is False


@pytest.mark.parametrize("role,expected_status", [("manager", 403), ("admin", 200)])
def test_admin_only_management_routes_enforce_role_at_http_boundary(
        client, monkeypatch, role, expected_status):
    from app import auth
    from app.auth import Principal

    main.app.dependency_overrides[auth.authenticated_principal] = lambda: Principal(
        "test-user", "65a000000000000000000002", (role,))
    monkeypatch.setattr(main, "create_supplier", lambda *_args: {"ok": True})
    monkeypatch.setattr(main, "update_supplier", lambda *_args: {"ok": True})
    monkeypatch.setattr(main, "upsert_recipe", lambda *_args: {"ok": True})
    monkeypatch.setattr(main, "set_recipe_active", lambda *_args: {"ok": True})
    headers = {"Origin": "https://estoque.dacot.com.br", "Idempotency-Key": "role-test-key"}
    requests = [
        ("POST", "/api/v1/suppliers", {"name": "Fornecedor teste"}),
        ("PATCH", "/api/v1/suppliers/supplier-a", {"expected_version": 1, "name": "Fornecedor atualizado"}),
        ("PUT", "/api/v1/recipes/product-a", {
            "product_id": "product-a", "product_name": "Produto teste",
            "lines": [{"ingredient_id": "ingredient-a", "quantity": 1, "unit": "un"}],
        }),
        ("PATCH", "/api/v1/recipes/product-a/status", {"active": False, "expected_version": 1}),
    ]
    try:
        for method, path, payload in requests:
            response = client.request(method, path, json=payload, headers=headers)
            assert response.status_code == (201 if role == "admin" and method == "POST"
                                            and path == "/api/v1/suppliers" else expected_status), path
    finally:
        main.app.dependency_overrides.pop(auth.authenticated_principal, None)
