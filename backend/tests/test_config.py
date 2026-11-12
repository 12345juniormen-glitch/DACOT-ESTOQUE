from app.config import Settings
import pytest


def test_cors_origins_accept_comma_separated_render_setting(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "https://estoque.example.com,https://preview.example.com")
    settings = Settings()
    assert settings.cors_origins == ["https://estoque.example.com", "https://preview.example.com"]


@pytest.mark.parametrize("origin", [
    "*", "http://estoque.example.com", "https://estoque.example.com/path",
    "https://estoque.example.com?next=evil", "https://user@estoque.example.com",
])
def test_production_cors_rejects_non_exact_or_insecure_origins(origin):
    with pytest.raises(ValueError):
        Settings(environment="production", cors_origins=[origin])


def test_production_cors_requires_exact_https_origin():
    with pytest.raises(ValueError):
        Settings(environment="production", cors_origins=[])
    settings = Settings(environment="production", cors_origins=["https://estoque.dacot.com.br"])
    assert settings.cors_origins == ["https://estoque.dacot.com.br"]


def test_handoff_issuer_and_audience_are_fixed_to_inventory_contract():
    with pytest.raises(ValueError):
        Settings(handoff_issuer="other-hub")
    with pytest.raises(ValueError):
        Settings(handoff_audience="dacot-orders")
