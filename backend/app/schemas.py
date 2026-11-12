from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class HandoffExchange(BaseModel):
    handoff: str = Field(min_length=20, max_length=10000)


class IngredientCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    category: Literal["Carnes", "Hortifruti", "Laticínios", "Bebidas", "Secos", "Congelados", "Embalagens", "Outros"]
    base_unit: Literal["g", "kg", "ml", "l", "un"]
    min_quantity: float = Field(default=0, ge=0, allow_inf_nan=False)
    initial_quantity: float = Field(default=0, ge=0, allow_inf_nan=False)
    cost_cents: int = Field(default=0, ge=0)
    primary_supplier_id: str | None = None
    conversions: dict[str, float] = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def trim_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("name cannot be blank")
        return value

    @field_validator("conversions")
    @classmethod
    def valid_conversions(cls, value: dict[str, float]) -> dict[str, float]:
        if any(not key.strip() or not 0 < factor < 1_000_000 for key, factor in value.items()):
            raise ValueError("conversion factors must be positive and bounded")
        return value


class IngredientUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    category: str | None = Field(default=None, min_length=1, max_length=80)
    base_unit: Literal["g", "kg", "ml", "l", "un"] | None = None
    min_quantity: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    cost_cents: int | None = Field(default=None, ge=0)
    conversions: dict[str, float] | None = None
    active: bool | None = None

    @field_validator("conversions")
    @classmethod
    def valid_conversions(cls, value: dict[str, float] | None) -> dict[str, float] | None:
        if value is not None and any(not key.strip() or not 0 < factor < 1_000_000 for key, factor in value.items()):
            raise ValueError("conversion factors must be positive and bounded")
        return value


class MovementCreate(BaseModel):
    kind: Literal["purchase", "adjustment_in", "adjustment_out"]
    quantity: float = Field(gt=0, allow_inf_nan=False)
    unit_cost_cents: int | None = Field(default=None, ge=0)
    reason: str = Field(min_length=1, max_length=300)
    supplier_id: str | None = None
    purchase_reference: str | None = Field(default=None, max_length=120)
    unit: Literal["g", "kg", "ml", "l", "L", "un"] | None = None


class PurchaseLineCreate(BaseModel):
    ingredient_id: str
    quantity_ordered: float = Field(gt=0, allow_inf_nan=False)
    unit: Literal["g", "kg", "ml", "l", "L", "un"]
    expected_unit_cost_cents: int = Field(ge=0)


class PurchaseCreate(BaseModel):
    supplier_id: str | None = None
    expected_delivery_at: datetime | None = None
    note: str = Field(default="", max_length=1000)
    lines: list[PurchaseLineCreate] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_ingredients(self):
        ids = [line.ingredient_id for line in self.lines]
        if len(ids) != len(set(ids)):
            raise ValueError("a purchase cannot repeat an ingredient")
        return self


class PurchaseReceiveLine(BaseModel):
    line_id: str
    quantity_received: float = Field(gt=0, allow_inf_nan=False)
    unit_cost_cents: int = Field(ge=0)


class PurchaseReceive(BaseModel):
    lines: list[PurchaseReceiveLine] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_lines(self):
        ids = [line.line_id for line in self.lines]
        if len(ids) != len(set(ids)):
            raise ValueError("a receipt cannot repeat a purchase line")
        return self


class SupplierCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    contact: str = Field(default="", max_length=160)
    phone: str = Field(default="", max_length=40)
    whatsapp: str = Field(default="", max_length=40)
    notes: str = Field(default="", max_length=2000)
    avg_lead_time_days: int = Field(default=0, ge=0, le=365)
    min_order_cents: int = Field(default=0, ge=0)

    @field_validator("name")
    @classmethod
    def trim_supplier_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("supplier name cannot be blank")
        return value


class RecipeLine(BaseModel):
    ingredient_id: str
    quantity: float = Field(gt=0, allow_inf_nan=False)
    unit: str


class RecipePut(BaseModel):
    product_id: str = Field(min_length=1, max_length=120)
    product_name: str = Field(min_length=1, max_length=160)
    lines: list[RecipeLine] = Field(min_length=1)
    sale_price_cents: int = Field(default=0, ge=0)


class IngredientOut(BaseModel):
    id: str
    restaurant_id: str
    name: str
    category: str
    base_unit: str
    current_quantity: float
    min_quantity: float
    cost_cents: int
    conversions: dict[str, float]
    active: bool
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
