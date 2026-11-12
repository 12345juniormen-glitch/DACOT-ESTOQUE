from datetime import datetime, timedelta, timezone

import jwt
import pytest
from fastapi import HTTPException

from app import auth
from app.auth import decode_handoff
from app.config import Settings

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
