import { quantityFactorToBase } from './format';
import { itemCostKnown } from './selectors';
import type { InventoryItem, SupplierItem, Unit } from './types';

export function suggestedPurchaseUnitCostCents(input: {
  restaurantId: string;
  item: InventoryItem | undefined;
  supplierId: string;
  supplierItems: SupplierItem[];
  unit: Unit;
}): number | null {
  const { restaurantId, item, supplierId, supplierItems, unit } = input;
  if (!item || item.restaurantId !== restaurantId) return null;
  const offer = supplierItems.find((candidate) => candidate.restaurantId === restaurantId
    && candidate.itemId === item.id && candidate.supplierId === supplierId
    && candidate.lastPurchaseAt != null);
  const basePrice = offer?.lastPriceCents ?? (itemCostKnown(item) ? item.costCents : null);
  const factor = quantityFactorToBase(unit, item.unit, item.conversions);
  if (basePrice == null || factor == null) return null;
  return Math.round(basePrice * factor);
}
