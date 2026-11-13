import pytest
from pydantic import ValidationError

from app.schemas import (CountApproval, CountCreate, CountLineUpdate, CountSelection, IngredientCreate, IngredientUpdate, LossCreate, PurchaseDraftUpdate,
                         PurchaseLineCreate, PurchaseReceiptReversal, PurchaseReceive, PurchaseStatusUpdate,
                         RecipeLine, RecipePut, SupplierUpdate, MovementCreate)


def test_count_rejects_duplicate_ingredients():
    with pytest.raises(ValidationError):
        CountCreate(ingredient_ids=["ingredient-a", "ingredient-a"])


def test_purchase_status_transition_requires_a_positive_observed_version():
    assert PurchaseStatusUpdate(expected_version=3).expected_version == 3
    with pytest.raises(ValidationError):
        PurchaseStatusUpdate()
    with pytest.raises(ValidationError):
        PurchaseStatusUpdate(expected_version=0)


def test_count_requires_exactly_one_selection_source():
    with pytest.raises(ValidationError):
        CountCreate()
    with pytest.raises(ValidationError):
        CountCreate(ingredient_ids=["ingredient-a"], selection=CountSelection())
    assert CountCreate(selection=CountSelection(scope="all")).selection.scope == "all"


def test_count_selection_validates_scope_and_deduplicates_selected_ids():
    with pytest.raises(ValidationError):
        CountSelection(scope="category")
    with pytest.raises(ValidationError):
        CountSelection(include_ids=["ingredient-a", "ingredient-a"])
    with pytest.raises(ValidationError):
        CountSelection(include_ids=["ingredient-a"], exclude_ids=["ingredient-b"])


def test_recipe_rejects_duplicate_ingredients():
    line = RecipeLine(ingredient_id="ingredient-a", quantity=1, unit="un")
    with pytest.raises(ValidationError):
        RecipePut(product_id="burger", product_name="Burger", lines=[line, line])


@pytest.mark.parametrize("yield_portions", [0, -1, 10001, True, 2.5])
def test_recipe_yield_portions_must_be_between_one_and_ten_thousand(yield_portions):
    with pytest.raises(ValidationError):
        RecipePut(product_id="soup", product_name="Sopa",
                  lines=[RecipeLine(ingredient_id="veg", quantity=1, unit="kg")],
                  yield_portions=yield_portions)


@pytest.mark.parametrize("quantity", [0, -0.1, float("inf"), float("nan")])
def test_loss_rejects_non_positive_or_non_finite_quantity(quantity):
    with pytest.raises(ValidationError):
        LossCreate(ingredient_id="ingredient-a", quantity=quantity, reason="Vencimento")


@pytest.mark.parametrize("quantity", [0.0004, 1.2345, 1.2349])
def test_stock_mutation_schemas_reject_quantities_that_would_be_rounded_to_milli_units(quantity):
    with pytest.raises(ValidationError):
        LossCreate(ingredient_id="ingredient-a", quantity=quantity, reason="Quebra")
    with pytest.raises(ValidationError):
        MovementCreate(kind="adjustment_out", quantity=quantity, reason="Ajuste")
    with pytest.raises(ValidationError):
        PurchaseLineCreate(ingredient_id="ingredient-a", quantity_ordered=quantity,
                           unit="kg", expected_unit_cost_cents=0)
    with pytest.raises(ValidationError):
        PurchaseReceive(lines=[{"line_id": "line-a", "quantity_received": quantity,
                                "unit_cost_cents": 0}], expected_version=1)
    with pytest.raises(ValidationError):
        CountLineUpdate(counted_quantity=quantity, expected_version=1)
    with pytest.raises(ValidationError):
        RecipeLine(ingredient_id="ingredient-a", quantity=quantity, unit="kg")


def test_stock_mutation_schemas_accept_exact_thousandth_precision():
    assert LossCreate(ingredient_id="ingredient-a", quantity=1.234,
                      reason="Quebra").quantity == 1.234
    assert MovementCreate(kind="adjustment_out", quantity=1.234, reason="Ajuste",
                          expected_balance=5.001).quantity == 1.234
    assert PurchaseLineCreate(ingredient_id="ingredient-a", quantity_ordered=1.234,
                              unit="kg", expected_unit_cost_cents=0).quantity_ordered == 1.234
    assert PurchaseReceive(lines=[{"line_id": "line-a", "quantity_received": 1.234,
                                   "unit_cost_cents": 0}], expected_version=1).lines[0].quantity_received == 1.234
    assert CountLineUpdate(counted_quantity=1.234, expected_version=1).counted_quantity == 1.234
    assert RecipeLine(ingredient_id="ingredient-a", quantity=1.234, unit="kg").quantity == 1.234
    assert IngredientCreate(name="Rice", category="Secos", base_unit="kg",
                            initial_quantity=1.234, min_quantity=0.001).initial_quantity == 1.234


def test_ingredient_stock_levels_and_observed_balance_reject_sub_milli_precision():
    with pytest.raises(ValidationError):
        IngredientCreate(name="Rice", category="Secos", base_unit="kg",
                         initial_quantity=1.2345)
    with pytest.raises(ValidationError):
        IngredientCreate(name="Rice", category="Secos", base_unit="kg",
                         min_quantity=0.0005)
    with pytest.raises(ValidationError):
        IngredientUpdate(expected_version=1, min_quantity=1.2345)
    with pytest.raises(ValidationError):
        MovementCreate(kind="adjustment_out", quantity=1, expected_balance=5.0005,
                       reason="Ajuste")


def test_update_schemas_reject_blank_names_and_invalid_categories():
    with pytest.raises(ValidationError):
        IngredientUpdate(expected_version=1, name="  ")
    with pytest.raises(ValidationError):
        IngredientUpdate(expected_version=1, category="Unknown")
    with pytest.raises(ValidationError):
        SupplierUpdate(expected_version=1, name="  ")
    with pytest.raises(ValidationError):
        IngredientUpdate(expected_version=1, min_quantity=None)
    with pytest.raises(ValidationError):
        SupplierUpdate(expected_version=1, active=None)
    with pytest.raises(ValidationError):
        IngredientUpdate(min_quantity=3)
    with pytest.raises(ValidationError):
        SupplierUpdate(active=False)
    assert IngredientUpdate(expected_version=2, min_quantity=3).expected_version == 2
    assert SupplierUpdate(expected_version=2, active=False).expected_version == 2


def test_count_line_allows_explicit_clear_and_rejects_negative_qty():
    assert CountLineUpdate(counted_quantity=None, expected_version=1).counted_quantity is None
    with pytest.raises(ValidationError):
        CountLineUpdate(counted_quantity=-1, expected_version=1)
    with pytest.raises(ValidationError):
        CountLineUpdate(expected_version=1)
    with pytest.raises(ValidationError):
        CountApproval(expected_version=0)


def test_purchase_draft_update_requires_version_and_unique_lines():
    line = PurchaseLineCreate(ingredient_id="ingredient-a", quantity_ordered=2,
                              unit="kg", expected_unit_cost_cents=2500)
    with pytest.raises(ValidationError):
        PurchaseDraftUpdate(expected_version=3, lines=[line, line])
    with pytest.raises(ValidationError):
        PurchaseDraftUpdate(lines=[line])
    with pytest.raises(ValidationError):
        PurchaseDraftUpdate(expected_updated_at="2026-01-01T00:00:00Z", lines=[line])
    assert PurchaseDraftUpdate(expected_version=3, lines=[line]).expected_version == 3


def test_purchase_receipt_requires_expected_version():
    line = {"line_id": "line-a", "quantity_received": 1, "unit_cost_cents": 100}
    with pytest.raises(ValidationError):
        PurchaseReceive(lines=[line])
    assert PurchaseReceive(expected_version=2, lines=[line]).expected_version == 2


def test_receipt_reversal_requires_a_non_blank_reason():
    with pytest.raises(ValidationError):
        PurchaseReceiptReversal(reason="   ")
    assert PurchaseReceiptReversal(reason="  erro de quantidade  ").reason == "erro de quantidade"


def test_movement_reason_is_trimmed_and_whitespace_is_rejected():
    assert MovementCreate(kind="adjustment_in", quantity=1,
                          reason="  contagem física  ").reason == "contagem física"
    with pytest.raises(ValidationError):
        MovementCreate(kind="adjustment_out", quantity=1, reason="   ")


def test_ingredient_custom_package_conversions_are_normalized_and_bounded():
    ingredient = IngredientCreate(name="Queijo", category="Laticínios", base_unit="g",
                                 conversions={" Caixa ": 12000, "pacote": 500})
    assert ingredient.conversions == {"caixa": 12000, "pacote": 500}
    with pytest.raises(ValidationError):
        IngredientCreate(name="Queijo", category="Laticínios", base_unit="g",
                         conversions={"cx": 12, " CX ": 10})
    with pytest.raises(ValidationError):
        IngredientCreate(name="Queijo", category="Laticínios", base_unit="g",
                         conversions={"kg": 12})


def test_purchase_line_accepts_named_packaging_unit():
    line = PurchaseLineCreate(ingredient_id="ingredient-a", quantity_ordered=2,
                              unit=" Caixa ", expected_unit_cost_cents=3600)
    assert line.unit == "caixa"


@pytest.mark.parametrize("value", [9_000_000_000_000_001, float("inf"), float("nan")])
def test_stock_quantity_inputs_reject_values_outside_the_persistable_range(value):
    with pytest.raises(ValidationError):
        IngredientCreate(name="Excesso", category="Outros", base_unit="un", initial_quantity=value)
    with pytest.raises(ValidationError):
        MovementCreate(kind="adjustment_in", quantity=value, reason="Teste")


def test_money_inputs_reject_values_outside_mongodb_int64_range():
    too_large = 9_223_372_036_854_775_808
    with pytest.raises(ValidationError):
        IngredientCreate(name="Excesso", category="Outros", base_unit="un", cost_cents=too_large)
    with pytest.raises(ValidationError):
        PurchaseLineCreate(ingredient_id="ingredient-a", quantity_ordered=1, unit="un",
                           expected_unit_cost_cents=too_large)
