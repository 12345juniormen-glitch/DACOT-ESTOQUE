from datetime import datetime, timedelta, timezone
import inspect
from types import SimpleNamespace
from urllib.parse import quote

import jwt
import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app import auth
from app.auth import decode_handoff
from app.config import Settings
from app.main import app

SECRET = "unit-test-secret-not-for-any-environment-1234567890"


@pytest.fixture
def settings():
    return Settings(handoff_jwt_secret=SECRET)


def token(**overrides):
    now = int(datetime.now(timezone.utc).timestamp())
    claims = {
        "iss": "dacot-hub", "aud": "dacot-estoque", "sub": "tenant_user:65a000000000000000000001",
        "restaurant_id": "65a000000000000000000002", "role": "manager", "module": "inventory",
        "hub_access": {"user": 1, "tenant": 2, "module": 3},
        "jti": "random-once-token-id-123456", "iat": now, "nbf": now - 5,
        "exp": now + 60, "handoff_version": 1,
    }
    claims.update(overrides)
    return jwt.encode(claims, SECRET, algorithm="HS256")


def test_accepts_valid_hub_handoff(settings):
    claims = decode_handoff(token(), settings)
    assert claims["restaurant_id"] == "65a000000000000000000002"
    assert claims["role"] == "manager"


@pytest.mark.parametrize("overrides", [
    {"iss": "wrong-issuer"}, {"aud": "dacot-orders"}, {"module": "orders"},
    {"role": "super_admin"}, {"role": "waiter"}, {"restaurant_id": "restaurant-a"},
    {"handoff_version": 2}, {"hub_access": {"user": 1, "tenant": True, "module": 3}},
    {"exp": int(datetime.now(timezone.utc).timestamp()) - 10},
])
def test_rejects_invalid_or_expired_handoff(settings, overrides):
    with pytest.raises(HTTPException) as error:
        decode_handoff(token(**overrides), settings)
    assert error.value.status_code == 401


def test_rejects_wrong_signature(settings):
    bad_token = jwt.encode({"iss": "dacot-hub"}, "different-test-secret-12345678901234567890", algorithm="HS256")
    with pytest.raises(HTTPException) as error:
        decode_handoff(bad_token, settings)
    assert error.value.status_code == 401


def test_rejects_lifetime_longer_than_hub_contract(settings):
    now = int(datetime.now(timezone.utc).timestamp())
    with pytest.raises(HTTPException) as error:
        decode_handoff(token(iat=now, nbf=now - 5, exp=now + 61), settings)
    assert error.value.status_code == 401


def test_tab_session_id_validation():
    assert auth.valid_tab_session_id("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
    assert not auth.valid_tab_session_id(None)
    assert not auth.valid_tab_session_id("not-a-uuid")


def test_browser_binding_validation_accepts_only_generated_token_shape():
    assert auth.valid_browser_binding("A" * 43)
    assert not auth.valid_browser_binding(None)
    assert not auth.valid_browser_binding("short-cookie")
    assert not auth.valid_browser_binding("A" * 42 + ".")


def test_local_sessions_share_browser_binding_but_remain_independent_per_tab(settings):
    class FakeMongoSession:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def with_transaction(self, callback):
            return callback(self)

    class FakeClient:
        def start_session(self):
            return FakeMongoSession()

    class Collection:
        def __init__(self):
            self.documents = []

        def insert_one(self, document, session=None):
            self.documents.append(dict(document))

        def update_one(self, query, update, upsert=False, session=None):
            document = next((item for item in self.documents
                if all(item.get(key) == value for key, value in query.items())), None)
            if document is None and upsert:
                document = dict(query)
                self.documents.append(document)
            if document is not None:
                document.update(update.get("$set", {}))

    database = SimpleNamespace(client=FakeClient(), auth_sessions=Collection(),
                               consumed_handoffs=Collection())
    first_tab = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
    second_tab = "550e8400-e29b-41d4-a716-446655440000"
    binding = "A" * 43
    first_claims = decode_handoff(token(jti="handoff-first-tab"), settings)
    second_claims = decode_handoff(token(jti="handoff-second-tab"), settings)

    auth.create_local_session(database, binding=binding, tab_id=first_tab, claims=first_claims)
    auth.create_local_session(database, binding=binding, tab_id=second_tab, claims=second_claims)

    sessions = database.auth_sessions.documents
    assert len(sessions) == 2
    assert {session["browser_binding_hash"] for session in sessions} == {auth.digest(binding)}
    assert {session["tab_session_id_hash"] for session in sessions} == {
        auth.digest(first_tab), auth.digest(second_tab),
    }


def test_hub_rechecks_inventory_status_and_current_access(monkeypatch, settings):
    calls = []

    def fake_get(url, **kwargs):
        calls.append(("get", url, kwargs))
        return type("Response", (), {"status_code": 200,
                                      "json": lambda self: {"active": True, "module": "inventory"}})()

    def fake_post(url, **kwargs):
        calls.append(("post", url, kwargs))
        return type("Response", (), {"status_code": 200,
                                      "json": lambda self: {"active": True}})()

    monkeypatch.setattr(auth.httpx, "get", fake_get)
    monkeypatch.setattr(auth.httpx, "post", fake_post)
    settings.hub_base_url = "https://hub.example.test"
    settings.hub_module_key = "service-test-key-12345678901234567890"
    claims = decode_handoff(token(), settings)

    auth.hub_confirms_module_active(claims, settings)

    assert calls[0][1] == "https://hub.example.test/api/public/tenants/65a000000000000000000002/modules/inventory/status"
    assert calls[1][1] == "https://hub.example.test/api/public/tenants/65a000000000000000000002/modules/inventory/access"
    assert calls[1][2]["json"] == {
        "subject": claims["sub"], "role": claims["role"], "hub_access": claims["hub_access"],
    }
    assert calls[0][2]["headers"] == {"X-Module-Key": settings.hub_module_key}
    assert calls[1][2]["headers"] == {"X-Module-Key": settings.hub_module_key}


def test_hub_access_revocation_fails_closed(monkeypatch, settings):
    monkeypatch.setattr(auth.httpx, "post", lambda *args, **kwargs: type(
        "Response", (), {"status_code": 200, "json": lambda self: {"active": False}},
    )())
    settings.hub_base_url = "https://hub.example.test"
    settings.hub_module_key = "service-test-key-12345678901234567890"
    claims = decode_handoff(token(), settings)
    with pytest.raises(HTTPException) as error:
        auth.hub_confirms_access(claims, settings)
    assert error.value.status_code == 403


@pytest.mark.parametrize("validator", ["hub_confirms_access", "hub_confirms_module_active"])
def test_hub_network_failure_fails_closed_with_service_unavailable(monkeypatch, settings, validator):
    def unavailable(*_args, **_kwargs):
        raise auth.httpx.ConnectError("hub unavailable")

    monkeypatch.setattr(auth.httpx, "post", unavailable)
    monkeypatch.setattr(auth.httpx, "get", unavailable)
    settings.hub_base_url = "https://hub.example.test"
    settings.hub_module_key = "service-test-key-12345678901234567890"
    claims = decode_handoff(token(), settings)

    with pytest.raises(HTTPException) as error:
        getattr(auth, validator)(claims, settings)

    assert error.value.status_code == 503
    assert error.value.detail == "DACOT-HUB is unavailable"


def _session_request(session, settings):
    class Sessions:
        def find_one(self, query):
            assert query["revoked_at"] is None
            return session if session.get("revoked_at") is None else None

        def update_one(self, query, update):
            active = (session.get("revoked_at") is None
                and session.get("access_expires_at") > datetime.now(timezone.utc)
                and session.get("expires_at") > datetime.now(timezone.utc)
                and all(session.get(key) == query.get(key)
                        for key in ("_id", "user_id", "restaurant_id", "role", "hub_access")))
            session.update(update.get("$set", {}))
            return SimpleNamespace(matched_count=1 if active else 0)

    database = SimpleNamespace(auth_sessions=Sessions())
    app = SimpleNamespace(state=SimpleNamespace(database=SimpleNamespace(db=database)))
    binding = "bound-browser-session"
    tab_id = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"
    headers = [
        (b"cookie", f"{auth.cookie_name(settings)}={quote(binding)}".encode()),
        (auth.TAB_SESSION_HEADER.lower().encode(), tab_id.encode()),
    ]
    return Request({"type": "http", "headers": headers, "method": "GET",
                    "path": "/api/v1/me", "query_string": b"", "server": ("test", 80),
                    "scheme": "http", "client": ("test", 1), "app": app})


def test_every_authenticated_session_request_rechecks_current_hub_access(monkeypatch, settings):
    settings.environment = "production"
    now = datetime.now(timezone.utc)
    session = {
        "_id": "session-1", "user_id": "65a000000000000000000001",
        "restaurant_id": "65a000000000000000000002", "restaurant_slug": "test-restaurant",
        "role": "manager", "hub_access": {"user": 1, "tenant": 2, "module": 3},
        "revoked_at": None, "access_expires_at": now + timedelta(minutes=5),
        "expires_at": now + timedelta(days=2),
    }
    calls = []
    monkeypatch.setattr(auth, "hub_confirms_access", lambda claims, _settings: calls.append(claims))

    principal = auth.principal_from_session(_session_request(session, settings), settings)

    assert principal.restaurant_id == session["restaurant_id"]
    assert len(calls) == 1
    assert calls[0]["sub"] == f"tenant_user:{session['user_id']}"
    assert calls[0]["restaurant_id"] == session["restaurant_id"]
    assert calls[0]["role"] == session["role"]


def test_revoked_session_is_rejected_before_hub_access(monkeypatch, settings):
    settings.environment = "production"
    now = datetime.now(timezone.utc)
    calls = []
    monkeypatch.setattr(auth, "hub_confirms_access", lambda *_args: calls.append(True))
    request = _session_request({
        "_id": "session-revoked", "user_id": "65a000000000000000000001",
        "restaurant_id": "65a000000000000000000002", "role": "manager",
        "hub_access": {"user": 1, "tenant": 2, "module": 3},
        "revoked_at": now, "access_expires_at": now + timedelta(minutes=5),
        "expires_at": now + timedelta(days=2),
    }, settings)

    with pytest.raises(HTTPException) as error:
        auth.principal_from_session(request, settings)

    assert error.value.status_code == 401
    assert calls == []


def test_session_revoked_during_hub_check_is_rejected(monkeypatch, settings):
    settings.environment = "production"
    now = datetime.now(timezone.utc)
    session = {
        "_id": "session-racing-revoke", "user_id": "65a000000000000000000001",
        "restaurant_id": "65a000000000000000000002", "role": "manager",
        "hub_access": {"user": 1, "tenant": 2, "module": 3}, "revoked_at": None,
        "access_expires_at": now + timedelta(minutes=5), "expires_at": now + timedelta(days=2),
    }

    def revoke_during_hub_check(_claims, _settings):
        session["revoked_at"] = datetime.now(timezone.utc)

    monkeypatch.setattr(auth, "hub_confirms_access", revoke_during_hub_check)
    request = _session_request(session, settings)

    with pytest.raises(HTTPException) as error:
        auth.principal_from_session(request, settings)

    assert error.value.status_code == 401


def test_session_expiring_during_hub_check_is_rejected(monkeypatch, settings):
    now = datetime.now(timezone.utc)
    class Clock(datetime):
        calls = 0

        @classmethod
        def now(cls, tz=None):
            cls.calls += 1
            return now if cls.calls == 1 else now + timedelta(seconds=2)

    monkeypatch.setattr(auth, "datetime", Clock)
    session = {
        "_id": "session-expires-at-hub", "user_id": "65a000000000000000000001",
        "restaurant_id": "65a000000000000000000002", "role": "manager",
        "hub_access": {"user": 1, "tenant": 2, "module": 3}, "revoked_at": None,
        "access_expires_at": now + timedelta(seconds=1), "expires_at": now + timedelta(days=2),
    }
    class Sessions:
        def find_one(self, _query):
            return session

        def update_one(self, query, _update):
            active = session["access_expires_at"] > query["access_expires_at"]["$gt"]
            return SimpleNamespace(matched_count=int(active))

    request = _session_request(session, settings)
    request.app.state.database.db.auth_sessions = Sessions()
    monkeypatch.setattr(auth, "hub_confirms_access", lambda *_: None)
    with pytest.raises(HTTPException) as error:
        auth.principal_from_session(request, settings)
    assert error.value.status_code == 401


def test_session_replaced_for_another_restaurant_during_hub_check_is_rejected(monkeypatch, settings):
    settings.environment = "production"
    now = datetime.now(timezone.utc)
    session = {
        "_id": "session-replaced", "user_id": "65a000000000000000000001",
        "restaurant_id": "65a000000000000000000002", "role": "manager",
        "hub_access": {"user": 1, "tenant": 2, "module": 3}, "revoked_at": None,
        "access_expires_at": now + timedelta(minutes=5), "expires_at": now + timedelta(days=2),
    }

    def replace_session(_claims, _settings):
        session["restaurant_id"] = "65a000000000000000000003"
        session["hub_access"] = {"user": 1, "tenant": 1, "module": 3}

    monkeypatch.setattr(auth, "hub_confirms_access", replace_session)
    request = _session_request(session, settings)

    with pytest.raises(HTTPException) as error:
        auth.principal_from_session(request, settings)

    assert error.value.status_code == 401


def test_refresh_does_not_extend_a_session_replaced_during_hub_check(monkeypatch, settings):
    now = datetime.now(timezone.utc)
    original_access_expiry = now + timedelta(minutes=5)
    session = {
        "_id": "refresh-session-replaced", "user_id": "65a000000000000000000001",
        "restaurant_id": "65a000000000000000000002", "role": "manager",
        "hub_access": {"user": 1, "tenant": 2, "module": 3}, "revoked_at": None,
        "access_expires_at": original_access_expiry,
        "refresh_expires_at": now + timedelta(days=2), "expires_at": now + timedelta(days=2),
    }

    class Sessions:
        def find_one(self, _query):
            return session

        def update_one(self, query, _update):
            identity_matches = all(session.get(key) == query.get(key)
                for key in ("_id", "user_id", "restaurant_id", "role", "hub_access"))
            return SimpleNamespace(modified_count=1 if identity_matches else 0)

    database = SimpleNamespace(auth_sessions=Sessions())

    def replace_session(_claims, _settings):
        session["restaurant_id"] = "65a000000000000000000003"

    monkeypatch.setattr(auth, "hub_confirms_module_active", replace_session)

    with pytest.raises(HTTPException) as error:
        auth.refresh_local_session(database, binding="binding", tab_id="tab", settings=settings)

    assert error.value.status_code == 401
    assert session["access_expires_at"] == original_access_expiry


def test_all_data_api_routes_require_authenticated_principal():
    public_session_routes = {
        "/api/v1/auth/session/exchange",
        "/api/v1/auth/refresh",
        "/api/v1/auth/logout",
    }

    def contains_auth_dependency(dependency):
        return (dependency.call is auth.authenticated_principal
                or any(contains_auth_dependency(child) for child in dependency.dependencies))

    data_routes = [route for route in app.routes
                   if getattr(route, "path", "").startswith("/api/v1/")
                   and route.path not in public_session_routes]

    assert data_routes
    assert all(any(contains_auth_dependency(dependency)
                   for dependency in route.dependant.dependencies)
               for route in data_routes)


def test_all_cookie_authenticated_write_routes_validate_request_origin():
    write_methods = {"POST", "PUT", "PATCH", "DELETE"}
    routes = [route for route in app.routes
              if getattr(route, "methods", set()).intersection(write_methods)]

    assert routes
    assert all("require_allowed_origin(request)" in inspect.getsource(route.endpoint)
               for route in routes)


def test_all_data_write_routes_declare_a_backend_role_policy():
    public_session_routes = {
        "/api/v1/auth/session/exchange",
        "/api/v1/auth/refresh",
        "/api/v1/auth/logout",
    }
    write_methods = {"POST", "PUT", "PATCH", "DELETE"}
    routes = [route for route in app.routes
              if getattr(route, "methods", set()).intersection(write_methods)
              and getattr(route, "path", "").startswith("/api/v1/")
              and route.path not in public_session_routes]

    assert routes
    assert all("Depends(writer_roles())" in inspect.getsource(route.endpoint)
               or "Depends(admin_roles())" in inspect.getsource(route.endpoint)
               for route in routes)


@pytest.mark.parametrize("path", ["/api/v1/ingredients", "/api/v1/suppliers"])
def test_catalog_create_requires_idempotency_header(path):
    operation = app.openapi()["paths"][path]["post"]
    idempotency = next(parameter for parameter in operation["parameters"]
                       if parameter["name"] == "Idempotency-Key")
    assert idempotency["in"] == "header"
    assert idempotency["required"] is True
