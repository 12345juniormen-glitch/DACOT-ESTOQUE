from functools import lru_cache
from typing import Annotated
from urllib.parse import urlsplit

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    environment: str = "development"
    mongodb_uri: str = "mongodb://localhost:27017"
    mongodb_database: str = "dacot_estoque"
    handoff_jwt_secret: str | None = None
    handoff_issuer: str = "dacot-hub"
    handoff_audience: str = "dacot-estoque"
    hub_base_url: str | None = None
    hub_module_key: str | None = None
    cors_origins: Annotated[list[str], NoDecode] = []

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @model_validator(mode="after")
    def validate_runtime_security(self):
        if self.handoff_issuer != "dacot-hub":
            raise ValueError("HANDOFF_ISSUER must be dacot-hub")
        if self.handoff_audience != "dacot-estoque":
            raise ValueError("HANDOFF_AUDIENCE must be dacot-estoque")
        if self.environment == "production" and not self.cors_origins:
            raise ValueError("CORS_ORIGINS must contain the exact frontend origin in production")
        canonical_origins = set()
        for origin in self.cors_origins:
            try:
                parsed = urlsplit(origin)
                _ = parsed.port
            except ValueError as exc:
                raise ValueError("CORS_ORIGINS contains an invalid origin") from exc
            if (not origin or origin != origin.strip() or any(char.isspace() for char in origin)
                    or "*" in origin or parsed.scheme not in {"http", "https"}
                    or not parsed.hostname or parsed.username or parsed.password
                    or parsed.path or parsed.query or parsed.fragment):
                raise ValueError("CORS_ORIGINS must contain exact origins without paths or wildcards")
            if self.environment == "production" and parsed.scheme != "https":
                raise ValueError("CORS_ORIGINS must use HTTPS in production")
            canonical = f"{parsed.scheme}://{parsed.netloc}".lower()
            if canonical in canonical_origins:
                raise ValueError("CORS_ORIGINS contains duplicate origins")
            canonical_origins.add(canonical)
        return self

    @field_validator("cors_origins", mode="before")
    @classmethod
    def split_origins(cls, value):
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        return value

    @property
    def hub_auth_configured(self) -> bool:
        return bool(self.handoff_jwt_secret and len(self.handoff_jwt_secret) >= 32
                    and self.hub_base_url and self.hub_module_key and len(self.hub_module_key) >= 32)


@lru_cache
def get_settings() -> Settings:
    return Settings()
