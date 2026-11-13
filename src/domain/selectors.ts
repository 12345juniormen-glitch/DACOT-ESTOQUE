import { DAY_MS, NOW, isThisMonth, isWithinDays } from './clock';
import { ingredientLineCostCents, roundCentsFromMilliUnits } from './format';
import type {
  AppState,
  Cents,
  CountSession,
  InventoryItem,
  ItemStatus,
  Loss,
  Movement,
  Purchase,
  PurchaseLine,
  Recipe,
  RecommendedPurchase,
  Supplier,
  SupplierItem,
  Unit,
} from './types';

export interface SupplierOffer extends SupplierItem {
  supplier: Supplier;
}

export function referenceDate(state: Pick<AppState, 'asOf'>): Date {
  if (!state.asOf) return NOW;
  const parsed = new Date(state.asOf);
  return Number.isNaN(parsed.getTime()) ? NOW : parsed;
}

export function itemStatus(item: InventoryItem): ItemStatus {
  if (item.currentQty <= 0.0001) return 'empty';
  if (item.currentQty < item.minQty * 0.5) return 'critical';
  if (item.currentQty < item.minQty) return 'attention';
  if (item.minQty > 0 && item.currentQty < item.minQty * 1.25) return 'near_minimum';
  return 'normal';
}

export function compareReplenishmentPriority(left: InventoryItem, right: InventoryItem): number {
  const priority: Record<ItemStatus, number> = {
    empty: 0, critical: 1, attention: 2, near_minimum: 3, normal: 4,
  };
  return priority[itemStatus(left)] - priority[itemStatus(right)]
    || left.currentQty - right.currentQty
    || left.name.localeCompare(right.name, 'pt-BR');
}

export function itemValueCents(item: InventoryItem): Cents {
  return Math.round(item.currentQty * item.costCents);
}

export function itemCostKnown(item: InventoryItem): boolean {
  return item.costKnown ?? (Number.isFinite(item.costCents) && item.costCents > 0);
}

export function itemMovementValueCents(item: InventoryItem, quantity: number): Cents | null {
  if (!itemCostKnown(item)) return null;
  return roundCentsFromMilliUnits(quantity, item.costCents);
}

export function itemsWithoutCost(state: AppState): InventoryItem[] {
  return state.items.filter((item) => !itemCostKnown(item));
}

export function stockValueCents(state: AppState): Cents {
  return state.items.reduce((sum, item) => sum + (itemCostKnown(item) ? itemValueCents(item) : 0), 0);
}

export function purchasesThisMonth(state: AppState): Purchase[] {
  const reference = referenceDate(state);
  return state.purchases.filter(
    (p) => p.status !== 'cancelled' && isThisMonth(p.createdAt, reference),
  );
}

export function purchasesMonthCents(state: AppState): Cents {
  if (state.purchaseMonthInsight) return state.purchaseMonthInsight.expectedTotalCents;
  return purchasesThisMonth(state).reduce(
    (sum, p) => sum + purchaseTotalCents(p, 'expected'),
    0,
  );
}

export function purchasesMonthCount(state: AppState): number {
  return state.purchaseMonthInsight?.orderCount ?? purchasesThisMonth(state).length;
}

export function receivedGoodsThisMonth(state: AppState): { valueCents: Cents; unpricedCount: number } {
  const reversed = new Set(state.movements.flatMap((movement) =>
    movement.reversalOf ? [movement.reversalOf] : []));
  const receipts = state.movements.filter((movement) => movement.type === 'PURCHASE'
    && movement.restaurantId === state.restaurant.id
    && isThisMonth(movement.occurredAt, referenceDate(state))
    && !reversed.has(movement.id));
  return {
    valueCents: receipts.reduce((sum, movement) => sum + (movement.unitCostCents == null
      ? 0 : Math.round(movement.qty * movement.unitCostCents)), 0),
    unpricedCount: receipts.filter((movement) => movement.unitCostCents == null).length,
  };
}

export function lossesThisMonth(state: AppState) {
  const reference = referenceDate(state);
  return state.losses.filter((l) => isThisMonth(l.at, reference));
}

export function lossesMonthCents(state: AppState): Cents {
  return lossesThisMonth(state).reduce((sum, l) => sum + (l.valueCents ?? 0), 0);
}

export type LossPurchaseComparison =
  | { status: 'unavailable' | 'no-receipts' | 'unpriced-receipts' | 'unpriced-losses' | 'no-losses'; percentage: null }
  | { status: 'percentage'; percentage: number };

export function comparePricedLossesToReceivedGoods(lossValueCents: number | null,
  lossCount: number | null, pricedLossCount: number | null,
  receivedValueCents: number | null, unpricedReceiptCount: number | null): LossPurchaseComparison {
  if (lossValueCents == null || lossCount == null || pricedLossCount == null
      || receivedValueCents == null || unpricedReceiptCount == null) return { status: 'unavailable', percentage: null };
  if (unpricedReceiptCount > 0) return { status: 'unpriced-receipts', percentage: null };
  if (receivedValueCents <= 0) return { status: 'no-receipts', percentage: null };
  if (pricedLossCount <= 0) {
    return lossCount > 0 ? { status: 'unpriced-losses', percentage: null }
      : { status: 'no-losses', percentage: null };
  }
  return { status: 'percentage', percentage: lossValueCents / receivedValueCents * 100 };
}

export function lossesWeekCents(state: AppState): Cents {
  const reference = referenceDate(state);
  return state.losses
    .filter((l) => isWithinDays(l.at, 7, reference))
    .reduce((sum, l) => sum + (l.valueCents ?? 0), 0);
}

export function lossesWithoutCost(losses: Loss[]): number {
  return losses.filter((loss) => loss.valueCents == null).length;
}

export function belowMinItems(state: AppState): InventoryItem[] {
  return state.items.filter((item) => item.active !== false
    && ['attention', 'critical', 'empty'].includes(itemStatus(item)));
}

export function approvedCountsThisMonth(state: AppState): CountSession[] {
  const reference = referenceDate(state);
  return state.counts.filter(
    (c) => c.status === 'approved' && c.approvedAt != null && isThisMonth(c.approvedAt, reference),
  );
}

export function divergenceCents(state: AppState): Cents {
  return approvedCountsThisMonth(state).reduce(
    (sum, count) => sum + (countFinancialDivergenceCents(state, count) ?? 0),
    0,
  );
}

export function countsWithUnknownFinancialImpact(state: AppState): number {
  return approvedCountsThisMonth(state).filter((count) => countFinancialDivergenceCents(state, count) == null).length;
}

export function purchaseTotalCents(
  purchase: Purchase,
  mode: 'expected' | 'received' = 'expected',
): Cents {
  return purchase.lines.reduce((sum, line) => {
    if (mode === 'received') {
      const unit =
        line.receivedUnitCostCents ??
        line.expectedUnitCostCents;
      return sum + Math.round(line.qtyReceived * unit);
    }
    return sum + Math.round(line.qtyOrdered * line.expectedUnitCostCents);
  }, 0);
}

export function countFinancialCents(state: AppState, count: CountSession): Cents | null {
  if (count.status === 'approved' && count.financialImpactComplete !== undefined) {
    return count.financialImpactComplete ? count.financialImpactCents ?? 0 : null;
  }
  let total = 0;
  for (const line of count.lines) {
    if (line.countedQty == null) continue;
    const item = state.items.find((i) => i.id === line.itemId);
    if (!item) {
      if (Math.round((line.countedQty - line.expectedQty) * 1000) !== 0) return null;
      continue;
    }
    const delta = line.countedQty - line.expectedQty;
    if (Math.round(delta * 1000) === 0) continue;
    if (!itemCostKnown(item)) return null;
    total += roundCentsFromMilliUnits(delta, item.costCents);
  }
  return total;
}

export function countFinancialDivergenceCents(state: AppState, count: CountSession): Cents | null {
  if (count.status === 'approved' && count.financialImpactComplete !== undefined) {
    if (!count.financialImpactComplete) return null;
    if (count.financialDivergenceCents != null) return count.financialDivergenceCents;
    const frozenLines = count.lines.filter((line) => line.financialImpactComplete === true);
    return frozenLines.length
      ? frozenLines.reduce((sum, line) => sum + Math.abs(line.financialImpactCents ?? 0), 0)
      : Math.abs(count.financialImpactCents ?? 0);
  }
  let total = 0;
  for (const line of count.lines) {
    if (line.countedQty == null) continue;
    const delta = line.countedQty - line.expectedQty;
    if (Math.round(delta * 1000) === 0) continue;
    const item = state.items.find((candidate) => candidate.id === line.itemId);
    if (!item || !itemCostKnown(item)) return null;
    total += Math.abs(roundCentsFromMilliUnits(delta, item.costCents));
  }
  return total;
}

export function countDivergences(count: CountSession): number {
  return count.lines.filter(
    (line) => line.countedQty != null
      && Math.round((line.countedQty - line.expectedQty) * 1000) !== 0,
  ).length;
}

export function consumptionSince(state: AppState, itemId: string, days: number): number {
  const from = referenceDate(state).getTime() - days * DAY_MS;
  return state.movements
    .filter(
      (m) =>
        m.itemId === itemId &&
        m.type === 'CONSUMPTION' &&
        new Date(m.occurredAt).getTime() >= from,
    )
    .reduce((sum, m) => sum + m.qty, 0);
}

export function avgDailyConsumption(state: AppState, itemId: string, days = 30): number {
  return consumptionSince(state, itemId, days) / days;
}

export function consumptionCoverageLabel(quantity: number, daysRemaining: number): string {
  if (quantity <= 0) return 'Sem estoque';
  if (daysRemaining < 1) return 'Saldo cobre menos de 1 dia';
  return `Saldo cobre cerca de ${Math.max(1, Math.round(daysRemaining))} dias`;
}

export interface PriceVariation {
  item: InventoryItem;
  firstCents: Cents;
  lastCents: Cents;
  variation: number;
  points: number;
}

export function priceVariation(state: AppState, item: InventoryItem): PriceVariation | null {
  const from = referenceDate(state).getTime() - 120 * DAY_MS;
  const points = state.pricePoints
    .filter((p) => p.itemId === item.id && p.unitCostCents > 0 && new Date(p.at).getTime() >= from)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  if (points.length < 2) return null;
  const first = points[0].unitCostCents;
  const last = points[points.length - 1].unitCostCents;
  return {
    item,
    firstCents: first,
    lastCents: last,
    variation: first === 0 ? 0 : (last - first) / first,
    points: points.length,
  };
}

export function risingCostItems(state: AppState): PriceVariation[] {
  return state.items
    .filter((item) => item.active !== false)
    .map((item) => priceVariation(state, item))
    .filter((v): v is PriceVariation => v != null && v.variation >= 0.05)
    .sort((a, b) => b.variation - a.variation);
}

export function primaryOffer(state: AppState, item: InventoryItem): SupplierOffer | null {
  if (!item.primarySupplierId) return null;
  return supplierOffers(state, item.id).find((o) => o.supplierId === item.primarySupplierId) ?? null;
}

export function supplierOffers(state: AppState, itemId: string): SupplierOffer[] {
  return state.supplierItems
    .filter((si) => si.itemId === itemId)
    .map((si) => {
      const supplier = state.suppliers.find((s) => s.id === si.supplierId);
      return supplier ? { ...si, supplier } : null;
    })
    .filter((x): x is SupplierOffer => x != null)
    .sort((a, b) => {
      const aKnown = a.lastPurchaseAt != null || a.lastPriceCents > 0;
      const bKnown = b.lastPurchaseAt != null || b.lastPriceCents > 0;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return a.lastPriceCents - b.lastPriceCents;
    });
}

export function supplierOfferHasPrice(offer: SupplierItem): boolean {
  return offer.lastPurchaseAt != null || offer.lastPriceCents > 0;
}

export function supplierItemCount(state: AppState, supplierId: string): number {
  return new Set(
    state.supplierItems.filter((si) => si.supplierId === supplierId).map((si) => si.itemId),
  ).size;
}

export interface PurchaseReceiptSummary {
  purchase: Purchase;
  line: PurchaseLine;
  receivedAt: string;
  unitCostCents: Cents | null;
  unit: Unit;
}

function latestPurchaseReceipt(
  state: AppState,
  matches: (purchase: Purchase, line: PurchaseLine) => boolean,
): PurchaseReceiptSummary | null {
  const reversed = new Set(state.movements.flatMap((movement) =>
    movement.reversalOf ? [movement.reversalOf] : []));
  const receipts = state.movements
    .filter((movement) => movement.type === 'PURCHASE'
      && movement.restaurantId === state.restaurant.id
      && !reversed.has(movement.id))
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());

  for (const movement of receipts) {
    const purchase = state.purchases.find((entry) => entry.restaurantId === movement.restaurantId
      && (entry.id === movement.origin || entry.code === movement.origin));
    if (!purchase) continue;
    const line = purchase.lines.find((entry) => entry.itemId === movement.itemId && entry.qtyReceived > 0);
    if (!line || !matches(purchase, line)) continue;
    return { purchase, line, receivedAt: movement.occurredAt,
      unitCostCents: movement.unitCostCents, unit: movement.unit };
  }
  return null;
}

export function latestItemPurchaseReceipt(state: AppState, itemId: string): PurchaseReceiptSummary | null {
  return latestPurchaseReceipt(state, (_purchase, line) => line.itemId === itemId);
}

export function supplierLastPurchase(state: AppState, supplierId: string): PurchaseReceiptSummary | null {
  return latestPurchaseReceipt(state, (purchase) => purchase.supplierId === supplierId);
}

export function supplierRecentValue(state: AppState, supplierId: string): Cents {
  const insight = state.supplierPurchaseInsights?.[supplierId];
  if (insight) return insight.recentReceivedValueCents;
  const reference = referenceDate(state);
  const reversed = new Set(state.movements.flatMap((movement) =>
    movement.reversalOf ? [movement.reversalOf] : []));
  return state.movements.reduce((sum, movement) => {
    if (movement.type !== 'PURCHASE' || movement.restaurantId !== state.restaurant.id
        || reversed.has(movement.id) || movement.unitCostCents == null
        || !isWithinDays(movement.occurredAt, 90, reference)) return sum;
    const purchase = state.purchases.find((entry) => entry.restaurantId === movement.restaurantId
      && (entry.id === movement.origin || entry.code === movement.origin));
    if (purchase?.supplierId !== supplierId) return sum;
    return sum + roundCentsFromMilliUnits(movement.qty, movement.unitCostCents);
  }, 0);
}

export function supplierReceiptInsight(state: AppState, supplierId: string) {
  const insight = state.supplierPurchaseInsights?.[supplierId];
  if (insight) return { receivedAt: insight.lastReceiptAt, purchaseCode: insight.lastReceiptCode };
  const legacy = supplierLastPurchase(state, supplierId);
  return legacy ? { receivedAt: legacy.receivedAt, purchaseCode: legacy.purchase.code } : null;
}

export function recommendedPurchases(state: AppState): RecommendedPurchase[] {
  const result: RecommendedPurchase[] = [];

  for (const item of state.items) {
    if (item.active === false) continue;
    const avg = avgDailyConsumption(state, item.id);
    const offer = primaryOffer(state, item);
    if (avg <= 0) {
      if (item.currentQty >= item.minQty) continue;
      const recommendedQty = roundPurchaseQty(item.minQty - item.currentQty, item.unit);
      result.push({
        item,
        basis: 'minimum',
        avgDaily: 0,
        daysRemaining: 0,
        leadTimeDays: offer?.leadTimeDays ?? 0,
        coverageDays: 0,
        safetyQty: 0,
        recommendedQty,
        estimatedCostCents: itemCostKnown(item) ? Math.round(recommendedQty * item.costCents) : null,
        formula: `Estoque atual ${fmtQty(item.currentQty)} ${item.unit} abaixo do mínimo ${fmtQty(item.minQty)} ${item.unit}`,
      });
      continue;
    }
    const leadTimeDays = offer?.leadTimeDays ?? 2;
    const coverageDays = leadTimeDays + 4;
    const safetyQty = avg * 2;
    const raw = avg * coverageDays + safetyQty - item.currentQty;
    if (raw <= 0) continue;
    const daysRemaining = item.currentQty / avg;
    if (item.currentQty >= item.minQty * 1.25 && daysRemaining > coverageDays) continue;

    const recommendedQty = roundPurchaseQty(raw, item.unit);
    result.push({
      item,
      basis: 'consumption',
      avgDaily: avg,
      daysRemaining,
      leadTimeDays,
      coverageDays,
      safetyQty: Math.round(safetyQty * 100) / 100,
      recommendedQty,
      estimatedCostCents: itemCostKnown(item) ? Math.round(recommendedQty * item.costCents) : null,
      formula: `${fmtQty(avg)} ${item.unit}/dia × ${coverageDays} dias + ${fmtQty(safetyQty)} ${item.unit} − ${fmtQty(item.currentQty)} ${item.unit}`,
    });
  }

  return result.sort((a, b) => {
    if (a.basis !== b.basis) return a.basis === 'minimum' ? -1 : 1;
    return a.daysRemaining - b.daysRemaining;
  });
}

function fmtQty(value: number): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(value);
}

export function roundPurchaseQty(value: number, unit: string): number {
  if (unit === 'un') return Math.ceil(value);
  if (unit === 'g' || unit === 'ml') return Math.ceil(value / 50) * 50;
  return Math.ceil(value * 2) / 2;
}

export function recipeCostCents(state: AppState, recipe: Recipe): Cents {
  return recipe.ingredients.reduce((sum, ingredient) => {
    const item = state.items.find((i) => i.id === ingredient.itemId);
    if (!item) return sum;
    return sum + ingredientLineCostCents(
      ingredient.qty, ingredient.unit, item.unit, item.costCents, item.conversions,
      ingredient.conversionToBase,
    );
  }, 0);
}

export function recipeCostPerPortionCents(state: AppState, recipe: Recipe): Cents {
  const portions = Math.max(1, Math.floor(recipe.yieldPortions || 1));
  return Math.round(recipeCostCents(state, recipe) / portions);
}

export function recipeCostGaps(state: AppState, recipe: Recipe): string[] {
  return recipe.ingredients.flatMap((ingredient) => {
    const item = state.items.find((candidate) => candidate.id === ingredient.itemId);
    if (!item) return [`Insumo indisponível (${ingredient.itemId})`];
    return itemCostKnown(item) ? [] : [item.name];
  });
}

export function recipeMarginCalculable(state: AppState, recipe: Recipe): boolean {
  return recipe.salePriceCents > 0 && recipe.ingredients.length > 0 && recipeCostGaps(state, recipe).length === 0;
}

export function recipeMargin(recipe: Recipe, cost: Cents) {
  const marginCents = recipe.salePriceCents - cost;
  return {
    marginCents,
    costPct: recipe.salePriceCents === 0 ? 0 : cost / recipe.salePriceCents,
    marginPct: recipe.salePriceCents === 0 ? 0 : marginCents / recipe.salePriceCents,
  };
}

export function recipesUsingItem(state: AppState, itemId: string): Recipe[] {
  return state.recipes.filter((r) => r.ingredients.some((i) => i.itemId === itemId));
}

export function itemMovements(state: AppState, itemId: string): Movement[] {
  return state.movements
    .filter((m) => m.itemId === itemId)
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());
}

export function recentMovements(state: AppState, limit = 6): Movement[] {
  return [...state.movements]
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, limit);
}

export function topLossItem(state: AppState) {
  const totals = new Map<string, Cents>();
  for (const loss of lossesThisMonth(state)) {
    if (loss.valueCents == null) continue;
    totals.set(loss.itemId, (totals.get(loss.itemId) ?? 0) + loss.valueCents);
  }
  const [itemId, valueCents] = [...totals.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  const item = state.items.find((i) => i.id === itemId) ?? null;
  return item ? { item, valueCents: valueCents ?? 0 } : null;
}

export function topLossReason(state: AppState) {
  const totals = new Map<string, Cents>();
  for (const loss of lossesThisMonth(state)) {
    if (loss.valueCents == null) continue;
    totals.set(loss.reason, (totals.get(loss.reason) ?? 0) + loss.valueCents);
  }
  const [reason, valueCents] = [...totals.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return reason ? { reason, valueCents: valueCents ?? 0 } : null;
}

export interface AttentionItem {
  id: string;
  severity: 'high' | 'medium';
  tag: string;
  title: string;
  detail: string;
  valueCents: Cents | null;
  valueLabel: string | null;
  href: string;
  actionLabel: string;
}

export function lossAlertSeverity(weekLossCents: Cents): 'high' | 'medium' {
  return weekLossCents > 30_000 ? 'high' : 'medium';
}

export function attentionItems(state: AppState): AttentionItem[] {
  const alerts: AttentionItem[] = [];
  const rising = risingCostItems(state);
  const recs = recommendedPurchases(state);

  const empty = state.items.filter((i) => i.active !== false && itemStatus(i) === 'empty');
  for (const item of empty.slice(0, 2)) {
    const rec = recs.find((r) => r.item.id === item.id);
    alerts.push({
      id: `empty-${item.id}`,
      severity: 'high',
      tag: 'Sem estoque',
      title: `${item.name} está sem estoque.`,
      detail: `O item está zerado e há ficha técnica ativa usando este insumo.${rec ? ' Compra sugerida já calculada.' : ''}`,
      valueCents: rec?.estimatedCostCents ?? null,
      valueLabel: rec ? 'reposição estimada' : null,
      href: `/estoque/${item.id}`,
      actionLabel: 'Ver insumo',
    });
  }

  const risky = recs.filter((r) => r.basis === 'minimum' || r.daysRemaining <= r.coverageDays).slice(0, 3);
  for (const rec of risky) {
    const status = itemStatus(rec.item);
    if (status === 'empty') continue;
    if (rec.basis === 'minimum') {
      alerts.push({
        id: `minimum-${rec.item.id}`,
        severity: status === 'critical' ? 'high' : 'medium',
        tag: 'Reposição',
        title: `${rec.item.name} está abaixo do estoque mínimo.`,
        detail: `Comprar ${fmtQty(rec.recommendedQty)} ${rec.item.unit} para recompor o mínimo de ${fmtQty(rec.item.minQty)} ${rec.item.unit}.`,
        valueCents: rec.estimatedCostCents,
        valueLabel: 'reposição estimada',
        href: `/estoque/${rec.item.id}`,
        actionLabel: 'Ver insumo',
      });
      continue;
    }
    const days = Math.max(1, Math.round(rec.daysRemaining));
    alerts.push({
      id: `runout-${rec.item.id}`,
      severity: status === 'critical' || rec.daysRemaining < 2 ? 'high' : 'medium',
      tag: 'Reposição',
      title:
        rec.daysRemaining < 1
          ? `${rec.item.name} acaba hoje.`
          : `${rec.item.name} deve acabar em aproximadamente ${days} ${days === 1 ? 'dia' : 'dias'}.`,
      detail: `Consumo médio de ${fmtQty(rec.avgDaily)} ${rec.item.unit}/dia. Compra sugerida de ${fmtQty(rec.recommendedQty)} ${rec.item.unit} para cobrir ${rec.coverageDays} dias.`,
      valueCents: rec.estimatedCostCents,
      valueLabel: 'compra sugerida',
      href: `/estoque/${rec.item.id}`,
      actionLabel: 'Ver cálculo',
    });
  }

  const topRise = rising[0];
  if (topRise) {
    const avg = avgDailyConsumption(state, topRise.item.id);
    const monthlyImpact = Math.round((topRise.lastCents - topRise.firstCents) * avg * 30);
    alerts.push({
      id: `rise-${topRise.item.id}`,
      severity: 'high',
      tag: 'Custo em alta',
      title: `${topRise.item.name} aumentou ${pct(topRise.variation)} nas últimas compras.`,
      detail: `Passou de ${moneyShort(topRise.firstCents)} para ${moneyShort(topRise.lastCents)} por ${topRise.item.unit}. O consumo atual custa mais por mês.`,
      valueCents: monthlyImpact,
      valueLabel: 'custo extra/mês',
      href: `/estoque/${topRise.item.id}`,
      actionLabel: 'Ver histórico',
    });
  }

  const lastCount = approvedCountsThisMonth(state)
    .sort((a, b) => new Date(b.approvedAt ?? '').getTime() - new Date(a.approvedAt ?? '').getTime())[0];
  if (lastCount) {
    const biggest = [...lastCount.lines]
      .filter((l) => l.countedQty != null)
      .sort(
        (a, b) =>
          Math.abs((b.countedQty ?? 0) - b.expectedQty) -
          Math.abs((a.countedQty ?? 0) - a.expectedQty),
      )[0];
    const item = biggest ? state.items.find((i) => i.id === biggest.itemId) : null;
    const financial = countFinancialDivergenceCents(state, lastCount);
    if (biggest && item) {
      const diff = (biggest.countedQty ?? 0) - biggest.expectedQty;
      alerts.push({
        id: `count-${lastCount.id}`,
        severity: 'high',
        tag: 'Divergência',
        title: `Contagem encontrou ${diff > 0 ? '+' : '−'}${fmtQty(Math.abs(diff))} ${item.unit} de ${item.name.toLowerCase()}.`,
        detail: `${lastCount.code} aprovada em ${new Date(lastCount.approvedAt ?? '').toLocaleDateString('pt-BR')}. ${financial == null ? 'Impacto financeiro não calculável: há insumo sem custo cadastrado.' : `Divergência financeira bruta de ${moneyShort(financial)} na contagem.`}`,
        valueCents: financial,
        valueLabel: financial == null ? null : 'divergência bruta',
        href: `/contagem`,
        actionLabel: 'Revisar contagem',
      });
    }
  }

  const weekLosses = lossesWeekCents(state);
  if (weekLosses > 0) {
    const top = topLossReason(state);
    alerts.push({
      id: 'losses-week',
      severity: lossAlertSeverity(weekLosses),
      tag: 'Perdas',
      title: `Você perdeu ${moneyShort(weekLosses)} em desperdícios nos últimos 7 dias.`,
      detail: top ? `${top.reason} é o motivo com maior impacto no mês.` : 'Registre o motivo de cada perda para identificar a origem.',
      valueCents: weekLosses,
      valueLabel: 'últimos 7 dias',
      href: '/perdas',
      actionLabel: 'Ver perdas',
    });
  }

  const buyNow = recs[0];
  if (buyNow) {
    alerts.push({
      id: `buy-${buyNow.item.id}`,
      severity: 'medium',
      tag: 'Compra recomendada',
      title: `Compra de ${buyNow.item.name.toLowerCase()} recomendada: ${fmtQty(buyNow.recommendedQty)} ${buyNow.item.unit}.`,
      detail: `Cobre ${buyNow.coverageDays} dias de operação e mantém 2 dias de estoque de segurança.`,
      valueCents: buyNow.estimatedCostCents,
      valueLabel: 'valor estimado',
      href: '/compras',
      actionLabel: 'Planejar compra',
    });
  }

  return alerts;
}

export function moneyShort(cents: Cents): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(cents / 100);
}

export function pct(value: number): string {
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(value * 100)}%`;
}

export function avgLeadTime(state: AppState): number {
  if (!state.suppliers.length) return 0;
  return (
    state.suppliers.reduce((sum, s) => sum + s.avgLeadTimeDays, 0) / state.suppliers.length
  );
}
