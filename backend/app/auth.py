import hashlib
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID
from urllib.parse import urlparse

import httpx
import jwt
from fastapi import Depends, HTTPException, Request
from jwt import InvalidTokenError

from app.config import Settings, get_settings

MODULE_KEY = "inventory"
HANDOFF_VERSION = 1
HANDOFF_MAX_TTL_SECONDS = 60
VALID_ROLES = {"admin", "manager"}
ACCESS_TTL = timedelta(minutes=60)
REFRESH_TTL = timedelta(days=7)
COOKIE_NAME = "dacot_estoque_browser"
TAB_SESSION_HEADER = "X-DACOT-Tab-Session"


@dataclass(frozen=True)
class Principal:
    user_id: str
    restaurant_id: str
    roles: tuple[str, ...]
    restaurant_slug: str | None = None


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def valid_tab_session_id(value: str | None) -> bool:
    if not value:
        return False
    try:
        return str(UUID(value)) == value.lower()
    except ValueError:
        return False


def cookie_name(settings: Settings) -> str:
    return "__Host-dacot-estoque-browser" if settings.environment == "production" else COOKIE_NAME


def decode_handoff(token: str, settings: Settings) -> dict:
    if not settings.handoff_jwt_secret or len(settings.handoff_jwt_secret) < 32:
        raise HTTPException(status_code=503, detail="DACOT-HUB handoff is not configured")
    try:
        claims = jwt.decode(
            token,
            settings.handoff_jwt_secret,
            algorithms=["HS256"],
            issuer=settings.handoff_issuer,
            audience=settings.handoff_audience,
            options={"require": ["iss", "aud", "sub", "restaurant_id", "role", "module",
                                 "hub_access", "jti", "iat", "nbf", "exp", "handoff_version"]},
            leeway=5,
        )
    except InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired DACOT-HUB handoff") from exc

    issued_at, expires_at = claims["iat"], claims["exp"]
    tenant_id = claims["restaurant_id"]
    subject = claims["sub"]
    now_epoch = int(datetime.now(timezone.utc).timestamp())
    if (type(issued_at) is not int or type(expires_at) is not int
            or expires_at <= now_epoch
            or issued_at > int(datetime.now(timezone.utc).timestamp()) + 5
            or expires_at <= issued_at or expires_at - issued_at > HANDOFF_MAX_TTL_SECONDS):
        raise HTTPException(status_code=401, detail="Invalid handoff lifetime")
    if (claims["iss"] != settings.handoff_issuer
            or claims["aud"] != settings.handoff_audience
            or claims["module"] != MODULE_KEY or type(claims["handoff_version"]) is not int
            or claims["handoff_version"] != HANDOFF_VERSION
            or not isinstance(claims["role"], str) or claims["role"] not in VALID_ROLES
            or not isinstance(claims["hub_access"], dict)
            or set(claims["hub_access"]) != {"user", "tenant", "module"}
            or any(type(value) is not int or value < 0 for value in claims["hub_access"].values())
            or not isinstance(tenant_id, str) or not re.fullmatch(r"[0-9a-fA-F]{24}", tenant_id)
            or not isinstance(subject, str) or not re.fullmatch(r"tenant_user:[0-9a-fA-F]{24}", subject)
            or not isinstance(claims["jti"], str) or len(claims["jti"]) < 16
            or ("restaurant_slug" in claims and (not isinstance(claims["restaurant_slug"], str)
                                                  or len(claims["restaurant_slug"]) > 120))):
        raise HTTPException(status_code=401, detail="Invalid DACOT-HUB handoff claims")
    return claims


def _hub_url(settings: Settings) -> str:
    if not settings.hub_base_url or not settings.hub_module_key or len(settings.hub_module_key) < 32:
        raise HTTPException(status_code=503, detail="DACOT-HUB inventory integration is not configured")
    parsed_base = urlparse(settings.hub_base_url)
    if (parsed_base.scheme not in {"http", "https"} or not parsed_base.hostname
            or parsed_base.username or parsed_base.password or parsed_base.query or parsed_base.fragment
            or (settings.environment == "production" and parsed_base.scheme != "https")):
        raise HTTPException(status_code=503, detail="DACOT-HUB URL must use HTTPS in production")
    return settings.hub_base_url.rstrip("/")


def _hub_headers(settings: Settings) -> dict[str, str]:
    return {"X-Module-Key": settings.hub_module_key or ""}


def hub_confirms_access(claims: dict, settings: Settings) -> None:
    base_url = _hub_url(settings)
    url = (f"{base_url}/api/public/tenants/{claims['restaurant_id']}"
           f"/modules/{MODULE_KEY}/access")
    try:
        response = httpx.post(
            url, headers=_hub_headers(settings), timeout=5, follow_redirects=False,
            trust_env=False, json={"subject": claims["sub"], "role": claims["role"],
                                   "hub_access": claims["hub_access"]},
        )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="DACOT-HUB is unavailable") from exc
    if response.status_code in (401, 403):
        raise HTTPException(status_code=503, detail="DACOT-HUB rejected the inventory module key")
    if response.status_code != 200:
        raise HTTPException(status_code=503, detail="DACOT-HUB access validation failed")
    try:
        access = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="Invalid access response from DACOT-HUB") from exc
    if not isinstance(access, dict) or access.get("active") is not True:
        raise HTTPException(status_code=403, detail="Inventory access is inactive or revoked in DACOT-HUB")


def hub_confirms_module_active(claims: dict, settings: Settings) -> None:
    base_url = _hub_url(settings)
    url = (f"{base_url}/api/public/tenants/{claims['restaurant_id']}"
           f"/modules/{MODULE_KEY}/status")
    try:
        response = httpx.get(url, headers=_hub_headers(settings), timeout=5,
                             follow_redirects=False, trust_env=False)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="DACOT-HUB is unavailable") from exc
    if response.status_code in (401, 403):
        raise HTTPException(status_code=503, detail="DACOT-HUB rejected the inventory module key")
    if response.status_code != 200:
        raise HTTPException(status_code=503, detail="DACOT-HUB module status validation failed")
    try:
        status = response.json()
    except ValueError as exc:
        raise HTTPException(status_code=503, detail="Invalid module status response from DACOT-HUB") from exc
    if (not isinstance(status, dict) or status.get("active") is not True
            or status.get("module") != MODULE_KEY):
        raise HTTPException(status_code=403, detail="Inventory module is inactive for this restaurant")
    hub_confirms_access(claims, settings)


def principal_from_session(request: Request, settings: Settings) -> Principal:
    database = request.app.state.database.db
    binding = request.cookies.get(cookie_name(settings))
    tab_id = request.headers.get(TAB_SESSION_HEADER)
    if not binding or not valid_tab_session_id(tab_id):
        raise HTTPException(status_code=401, detail="Authenticated DACOT session required")
    now = datetime.now(timezone.utc)
    session = database.auth_sessions.find_one({
        "browser_binding_hash": digest(binding),
        "tab_session_id_hash": digest(tab_id),
        "revoked_at": None,
        "access_expires_at": {"$gt": now},
        "expires_at": {"$gt": now},
    })
    if not session:
        raise HTTPException(status_code=401, detail="Authenticated DACOT session required")
    if session.get("role") not in VALID_ROLES or not isinstance(session.get("hub_access"), dict):
        raise HTTPException(status_code=401, detail="Invalid DACOT-HUB session")
    session_identity = {
        "user_id": session["user_id"], "restaurant_id": session["restaurant_id"],
        "role": session["role"], "hub_access": dict(session["hub_access"]),
    }
    hub_confirms_access({
        "sub": f"tenant_user:{session_identity['user_id']}",
        "restaurant_id": session_identity["restaurant_id"],
        "role": session_identity["role"],
        "hub_access": session_identity["hub_access"],
    }, settings)
    still_active = database.auth_sessions.update_one({
        "_id": session["_id"], "revoked_at": None,
        "access_expires_at": {"$gt": now}, "expires_at": {"$gt": now},
        **session_identity,
    }, {"$set": {"last_seen_at": now}})
    if still_active.matched_count != 1:
        raise HTTPException(status_code=401, detail="Authenticated DACOT session required")
    return Principal(session_identity["user_id"], session_identity["restaurant_id"],
                     (session_identity["role"],), session.get("restaurant_slug"))


def authenticated_principal(request: Request, settings: Settings = Depends(get_settings)) -> Principal:
    return principal_from_session(request, settings)


def require_any_role(*allowed_roles: str):
    def dependency(principal: Principal = Depends(authenticated_principal)) -> Principal:
        if not set(principal.roles).intersection(allowed_roles):
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return principal

    return dependency


def issue_browser_binding() -> str:
    return secrets.token_urlsafe(32)


def valid_browser_binding(value: str | None) -> bool:
    return bool(value and re.fullmatch(r"[A-Za-z0-9_-]{43}", value))


def create_local_session(db, *, binding: str, tab_id: str, claims: dict) -> None:
    now = datetime.now(timezone.utc)
    expires_at = datetime.fromtimestamp(claims["exp"], timezone.utc)
    with db.client.start_session() as mongo_session:
        mongo_session.with_transaction(lambda session: (
            db.consumed_handoffs.insert_one({
                "_id": claims["jti"], "expires_at": expires_at + timedelta(seconds=60),
            }, session=session),
            db.auth_sessions.update_one(
                {"browser_binding_hash": digest(binding), "tab_session_id_hash": digest(tab_id)},
                {"$set": {
                    "browser_binding_hash": digest(binding),
                    "tab_session_id_hash": digest(tab_id),
                    "user_id": claims["sub"].removeprefix("tenant_user:"),
                    "restaurant_id": claims["restaurant_id"].lower(),
                    "restaurant_slug": claims.get("restaurant_slug"),
                    "role": claims["role"],
                    "hub_access": claims["hub_access"],
                    "created_at": now,
                    "last_seen_at": now,
                    "access_expires_at": now + ACCESS_TTL,
                    "refresh_expires_at": now + REFRESH_TTL,
                    "expires_at": now + REFRESH_TTL,
                    "revoked_at": None,
                }}, upsert=True, session=session,
            ),
        ))


def refresh_local_session(db, *, binding: str, tab_id: str, settings: Settings) -> dict:
    now = datetime.now(timezone.utc)
    session = db.auth_sessions.find_one({
        "browser_binding_hash": digest(binding), "tab_session_id_hash": digest(tab_id),
        "revoked_at": None, "refresh_expires_at": {"$gt": now}, "expires_at": {"$gt": now},
    })
    if not session:
        raise HTTPException(status_code=401, detail="Session expired")
    if session.get("role") not in VALID_ROLES or not isinstance(session.get("hub_access"), dict):
        raise HTTPException(status_code=401, detail="Invalid DACOT-HUB session")
    session_identity = {
        "user_id": session["user_id"], "restaurant_id": session["restaurant_id"],
        "role": session["role"], "hub_access": dict(session["hub_access"]),
    }
    hub_confirms_module_active({
        "sub": f"tenant_user:{session_identity['user_id']}",
        "restaurant_id": session_identity["restaurant_id"],
        "role": session_identity["role"],
        "hub_access": session_identity["hub_access"],
    }, settings)
    result = db.auth_sessions.update_one(
        {"_id": session["_id"], "revoked_at": None,
         "refresh_expires_at": {"$gt": now}, "expires_at": {"$gt": now},
         **session_identity},
        {"$set": {"access_expires_at": now + ACCESS_TTL, "last_seen_at": now}},
    )
    if result.modified_count != 1:
        raise HTTPException(status_code=401, detail="Session expired")
    return session
