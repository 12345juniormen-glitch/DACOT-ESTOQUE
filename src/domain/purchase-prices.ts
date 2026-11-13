import { roundQty } from './format';
import type { Movement, PricePoint, Supplier, SupplierItem } from './types';

/** Keep an explicitly entered zero price; use the estimate only when no actual value exists. */
export function receiptUnitCostCents(actual: number | null | undefined, expected: number): number {
  return actual ?? expected;
}

export function receivedStockValues(
  currentQty: number,
  currentCostCents: number,
  receivedQty: number,
  purchaseUnitCostCents: number,
  factorToBase: number,
): { quantity: number; receivedQuantity: number; unitCostCents: number } {
  const baseQty = roundQty(receivedQty * factorToBase);
  const baseCostCents = Math.round(purchaseUnitCostCents / factorToBase);
  const quantity = roundQty(currentQty + baseQty);
  const unitCostCents = quantity > 0
    ? Math.round((currentQty * currentCostCents + baseQty * baseCostCents) / quantity)
    : baseCostCents;
  return { quantity, receivedQuantity: baseQty, unitCostCents };
}

/** Rebuild supplier price offers from the canonical, auditable stock movement ledger. */
export function purchasePriceHistory(
  movements: Movement[],
  suppliers: Supplier[],
): { pricePoints: PricePoint[]; supplierItems: SupplierItem[] } {
  const supplierById = new Map(suppliers.map((supplier) => [supplier.id, supplier]));
  const reversedMovements = new Set(movements.flatMap((movement) => movement.reversalOf ? [movement.reversalOf] : []));
  const points = movements
    .filter((movement) => movement.type === 'PURCHASE'
      && !!movement.supplierId
      && !reversedMovements.has(movement.id)
      && movement.unitCostCents != null
      && supplierById.has(movement.supplierId))
    .map((movement): PricePoint => ({
      id: movement.id,
      restaurantId: movement.restaurantId,
      itemId: movement.itemId,
      supplierId: movement.supplierId!,
      unitCostCents: movement.unitCostCents!,
      at: movement.occurredAt,
      source: 'purchase',
    }));

  const latestByPair = new Map<string, PricePoint>();
  for (const point of points) {
    const key = `${point.restaurantId}:${point.supplierId}:${point.itemId}`;
    const current = latestByPair.get(key);
    if (!current || new Date(point.at).getTime() > new Date(current.at).getTime()) latestByPair.set(key, point);
  }

  const supplierItems = [...latestByPair.values()].map((point): SupplierItem => {
    const supplier = supplierById.get(point.supplierId)!;
    return {
      id: `offer:${point.restaurantId}:${point.supplierId}:${point.itemId}`,
      restaurantId: point.restaurantId,
      supplierId: point.supplierId,
      itemId: point.itemId,
      lastPriceCents: point.unitCostCents,
      lastPurchaseAt: point.at,
      leadTimeDays: supplier.avgLeadTimeDays,
      minOrderCents: supplier.minOrderCents,
    };
  });
  return { pricePoints: points, supplierItems };
}
