from datetime import datetime
from decimal import Decimal
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


# Quantities are persisted in thousandths in a signed MongoDB int64 field.
# Leave headroom so standard quantities fit before unit conversions.
MAX_QUANTITY = 9_000_000_000_000_000
MAX_CENTS = 9_223_372_036_854_775_807


def validate_stock_quantity_precision(value: float | None) -> float | None:
    """Reject inputs the milli-unit stock ledger would otherwise silently round."""
    if value is None:
        return value
    scaled = Decimal(str(value)) * 1000
    if scaled != scaled.to_integral_value():
        raise ValueError("quantity must be representable in increments of 0.001")
    return value


class HandoffExchange(BaseModel):
    handoff: str = Field(min_length=20, max_length=10000)


class IngredientCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    category: Literal["Carnes", "Hortifruti", "Laticínios", "Bebidas", "Secos", "Congelados", "Embalagens", "Outros"]
    base_unit: Literal["g", "kg", "ml", "l", "un"]
    min_quantity: float = Field(default=0, ge=0, le=MAX_QUANTITY, allow_inf_nan=False)
    initial_quantity: float = Field(default=0, ge=0, le=MAX_QUANTITY, allow_inf_nan=False)
    cost_cents: int = Field(default=0, ge=0, le=MAX_CENTS)
    cost_known: bool | None = None
    primary_supplier_id: str | None = None
    conversions: dict[str, float] = Field(default_factory=dict)
    internal_code: str | None = Field(default=None, max_length=80)
    barcode: str | None = Field(default=None, max_length=100)
    notes: str = Field(default="", max_length=1000)

    @field_validator("min_quantity", "initial_quantity")
    @classmethod
    def validate_stock_quantities(cls, value: float) -> float:
        return validate_stock_quantity_precision(value)

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
        normalized = [key.strip().lower() for key in value]
        if (len(value) > 20 or len(normalized) != len(set(normalized))
                or any(not re.fullmatch(r"[^\W_][\w .-]{0,31}", key.strip(), re.UNICODE)
                       or key.strip().lower() in {"g", "kg", "ml", "l", "un"}
                       or not 0 < factor < 1_000_000 for key, factor in value.items())):
            raise ValueError("conversion factors must be positive and bounded")
        return {key.strip().lower(): factor for key, factor in value.items()}


class IngredientUpdate(BaseModel):
    expected_version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=120)
    category: Literal["Carnes", "Hortifruti", "Laticínios", "Bebidas", "Secos", "Congelados", "Embalagens", "Outros"] | None = None
    base_unit: Literal["g", "kg", "ml", "l", "un"] | None = None
    min_quantity: float | None = Field(default=None, ge=0, le=MAX_QUANTITY, allow_inf_nan=False)
    cost_cents: int | None = Field(default=None, ge=0, le=MAX_CENTS)
    cost_known: bool | None = None
    conversions: dict[str, float] | None = None
    active: bool | None = None
    primary_supplier_id: str | None = None
    internal_code: str | None = Field(default=None, max_length=80)
    barcode: str | None = Field(default=None, max_length=100)
    notes: str | None = Field(default=None, max_length=1000)

    @field_validator("min_quantity")
    @classmethod
    def validate_minimum_precision(cls, value: float | None) -> float | None:
        return validate_stock_quantity_precision(value)

    @model_validator(mode="after")
    def reject_null_non_nullable_fields(self):
        nullable = {"primary_supplier_id", "internal_code", "barcode"}
        for field_name in self.model_fields_set - nullable:
            if getattr(self, field_name) is None:
                raise ValueError(f"{field_name} cannot be null")
        return self

    @field_validator("name")
    @classmethod
    def trim_updated_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("name cannot be blank")
        return value

    @field_validator("conversions")
    @classmethod
    def valid_conversions(cls, value: dict[str, float] | None) -> dict[str, float] | None:
        if value is None:
            return value
        normalized = [key.strip().lower() for key in value]
        if (len(value) > 20 or len(normalized) != len(set(normalized))
                or any(not re.fullmatch(r"[^\W_][\w .-]{0,31}", key.strip(), re.UNICODE)
                       or key.strip().lower() in {"g", "kg", "ml", "l", "un"}
                       or not 0 < factor < 1_000_000 for key, factor in value.items())):
            raise ValueError("conversion factors must be positive and bounded")
        return {key.strip().lower(): factor for key, factor in value.items()}


class MovementCreate(BaseModel):
    kind: Literal["purchase", "adjustment_in", "adjustment_out", "consumption_by_order", "loss", "count_in", "count_out"]
    quantity: float = Field(gt=0, le=MAX_QUANTITY, allow_inf_nan=False)
    unit_cost_cents: int | None = Field(default=None, ge=0, le=MAX_CENTS)
    reason: str = Field(min_length=1, max_length=300)
    supplier_id: str | None = None
    purchase_reference: str | None = Field(default=None, max_length=120)
    unit: str | None = Field(default=None, min_length=1, max_length=32)
    expected_balance: float | None = Field(default=None, ge=0, le=MAX_QUANTITY, allow_inf_nan=False)

    @field_validator("quantity", "expected_balance")
    @classmethod
    def validate_movement_precision(cls, value: float | None) -> float | None:
        return validate_stock_quantity_precision(value)

    @field_validator("reason")
    @classmethod
    def trim_reason(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("A movement reason is required")
        return value

    @field_validator("unit")
    @classmethod
    def normalize_movement_unit(cls, value: str | None) -> str | None:
        return value.strip().lower() if value else value


class PurchaseLineCreate(BaseModel):
    ingredient_id: str
    quantity_ordered: float = Field(gt=0, le=MAX_QUANTITY, allow_inf_nan=False)
    unit: str = Field(min_length=1, max_length=32)
    expected_unit_cost_cents: int = Field(ge=0, le=MAX_CENTS)

    @field_validator("quantity_ordered")
    @classmethod
    def validate_order_quantity_precision(cls, value: float) -> float:
        return validate_stock_quantity_precision(value)

    @field_validator("unit")
    @classmethod
    def normalize_purchase_unit(cls, value: str) -> str:
        value = value.strip().lower()
        if not value:
            raise ValueError("purchase unit cannot be blank")
        return value


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


class PurchaseDraftUpdate(PurchaseCreate):
    expected_version: int = Field(ge=1)


class PurchaseStatusUpdate(BaseModel):
    expected_version: int = Field(ge=1)


class PurchaseReceiveLine(BaseModel):
    line_id: str
    quantity_received: float = Field(gt=0, le=MAX_QUANTITY, allow_inf_nan=False)
    unit_cost_cents: int = Field(ge=0, le=MAX_CENTS)

    @field_validator("quantity_received")
    @classmethod
    def validate_received_quantity_precision(cls, value: float) -> float:
        return validate_stock_quantity_precision(value)


class PurchaseReceive(BaseModel):
    expected_version: int = Field(ge=1)
    lines: list[PurchaseReceiveLine] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def unique_lines(self):
        ids = [line.line_id for line in self.lines]
        if len(ids) != len(set(ids)):
            raise ValueError("a receipt cannot repeat a purchase line")
        return self


class PurchaseReceiptReversal(BaseModel):
    reason: str = Field(min_length=3, max_length=300)

    @field_validator("reason")
    @classmethod
    def trim_reason(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 3:
            raise ValueError("A reversal reason is required")
        return value


class MovementReversal(BaseModel):
    reason: str = Field(min_length=3, max_length=300)

    @field_validator("reason")
    @classmethod
    def trim_reason(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 3:
            raise ValueError("A reversal reason is required")
        return value


class SupplierCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    contact: str = Field(default="", max_length=160)
    phone: str = Field(default="", max_length=40)
    whatsapp: str = Field(default="", max_length=40)
    notes: str = Field(default="", max_length=2000)
    avg_lead_time_days: int = Field(default=0, ge=0, le=365)
    min_order_cents: int = Field(default=0, ge=0, le=MAX_CENTS)

    @field_validator("name")
    @classmethod
    def trim_supplier_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("supplier name cannot be blank")
        return value


class SupplierUpdate(BaseModel):
    expected_version: int = Field(ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=160)
    contact: str | None = Field(default=None, max_length=160)
    phone: str | None = Field(default=None, max_length=40)
    whatsapp: str | None = Field(default=None, max_length=40)
    notes: str | None = Field(default=None, max_length=2000)
    avg_lead_time_days: int | None = Field(default=None, ge=0, le=365)
    min_order_cents: int | None = Field(default=None, ge=0, le=MAX_CENTS)
    active: bool | None = None

    @model_validator(mode="after")
    def reject_explicit_null_fields(self):
        for field_name in self.model_fields_set:
            if getattr(self, field_name) is None:
                raise ValueError(f"{field_name} cannot be null")
        return self

    @field_validator("name")
    @classmethod
    def trim_updated_supplier_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("supplier name cannot be blank")
        return value


class RecipeLine(BaseModel):
    ingredient_id: str
    quantity: float = Field(gt=0, le=MAX_QUANTITY, allow_inf_nan=False)
    unit: str

    @field_validator("quantity")
    @classmethod
    def validate_recipe_quantity_precision(cls, value: float) -> float:
        return validate_stock_quantity_precision(value)

    @field_validator("unit")
    @classmethod
    def normalize_recipe_unit(cls, value: str) -> str:
        value = value.strip().lower()
        if not value:
            raise ValueError("recipe unit cannot be blank")
        return value


class RecipePut(BaseModel):
    product_id: str = Field(min_length=1, max_length=120)
    product_name: str = Field(min_length=1, max_length=160)
    lines: list[RecipeLine] = Field(min_length=1)
    yield_portions: int = Field(default=1, ge=1, le=10000, strict=True)
    sale_price_cents: int = Field(default=0, ge=0, le=MAX_CENTS)
    expected_version: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def unique_ingredients(self):
        ids = [line.ingredient_id for line in self.lines]
        if len(ids) != len(set(ids)):
            raise ValueError("a recipe cannot repeat an ingredient")
        return self


class RecipeStatusUpdate(BaseModel):
    active: bool
    expected_version: int = Field(ge=1)


class RecipeConsumptionUpdate(BaseModel):
    consumption_enabled: bool
    expected_version: int = Field(ge=1)


class CountSelection(BaseModel):
    scope: Literal["all", "low", "category"] = "all"
    category: str | None = Field(default=None, min_length=1, max_length=80)
    search: str | None = Field(default=None, max_length=80)
    include_ids: list[str] | None = Field(default=None, max_length=500)
    exclude_ids: list[str] = Field(default_factory=list, max_length=500)

    @field_validator("category")
    @classmethod
    def normalize_selection_category(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("category cannot be blank")
        return value

    @field_validator("search")
    @classmethod
    def normalize_selection_search(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        return value or None

    @field_validator("include_ids", "exclude_ids")
    @classmethod
    def validate_ingredient_ids(cls, value: list[str] | None) -> list[str] | None:
        if value is not None and any(not item.strip() or len(item) > 200 for item in value):
            raise ValueError("ingredient selection IDs must be non-empty and at most 200 characters")
        return value

    @model_validator(mode="after")
    def validate_selection(self):
        if self.scope == "category" and not (self.category and self.category.strip()):
            raise ValueError("category is required for category-scoped counts")
        if self.scope != "category" and self.category is not None:
            raise ValueError("category is only valid for category-scoped counts")
        if self.include_ids is not None and self.exclude_ids:
            raise ValueError("include_ids and exclude_ids cannot be combined")
        if self.include_ids is not None and len(self.include_ids) != len(set(self.include_ids)):
            raise ValueError("a count selection cannot repeat an ingredient")
        if len(self.exclude_ids) != len(set(self.exclude_ids)):
            raise ValueError("a count selection cannot repeat an excluded ingredient")
        return self


class CountCreate(BaseModel):
    ingredient_ids: list[str] | None = Field(default=None, min_length=1, max_length=500)
    selection: CountSelection | None = None

    @model_validator(mode="after")
    def validate_count_request(self):
        if (self.ingredient_ids is None) == (self.selection is None):
            raise ValueError("provide either ingredient_ids or a count selection")
        if self.ingredient_ids is not None and len(self.ingredient_ids) != len(set(self.ingredient_ids)):
            raise ValueError("a count cannot repeat an ingredient")
        return self


class CountLineUpdate(BaseModel):
    counted_quantity: float | None = Field(ge=0, le=MAX_QUANTITY, allow_inf_nan=False)
    expected_version: int = Field(ge=1)

    @field_validator("counted_quantity")
    @classmethod
    def validate_counted_quantity_precision(cls, value: float | None) -> float | None:
        return validate_stock_quantity_precision(value)


class CountApproval(BaseModel):
    expected_version: int = Field(ge=1)


class LossCreate(BaseModel):
    ingredient_id: str
    quantity: float = Field(gt=0, le=MAX_QUANTITY, allow_inf_nan=False)
    reason: Literal["Vencimento", "Preparo errado", "Sobra", "Quebra", "Erro operacional", "Qualidade", "Outros"]
    note: str = Field(default="", max_length=500)
    unit: str | None = Field(default=None, min_length=1, max_length=32)

    @field_validator("quantity")
    @classmethod
    def validate_loss_quantity_precision(cls, value: float) -> float:
        return validate_stock_quantity_precision(value)

    @field_validator("unit")
    @classmethod
    def normalize_loss_unit(cls, value: str | None) -> str | None:
        return value.strip().lower() if value else value


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
