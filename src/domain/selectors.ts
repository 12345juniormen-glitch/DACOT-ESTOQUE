import { DAY_MS, NOW, isThisMonth, isWithinDays } from './clock';
import { convertQty } from './format';
import type {
  AppState,
  Cents,
  CountSession,
  InventoryItem,
  ItemStatus,
  Movement,
  Purchase,
  Recipe,
  RecommendedPurchase,
  Supplier,
  SupplierItem,
} from './types';

export interface SupplierOffer extends SupplierItem {
  supplier: Supplier;
}

export function itemStatus(item: InventoryItem): ItemStatus {
  if (item.currentQty <= 0.0001) return 'empty';
  if (item.currentQty < item.minQty * 0.5) return 'critical';
  if (item.currentQty < item.minQty) return 'attention';
  return 'normal';
}

export function itemValueCents(item: InventoryItem): Cents {
  return Math.round(item.currentQty * item.costCents);
}

export function stockValueCents(state: AppState): Cents {
  return state.items.reduce((sum, item) => sum + itemValueCents(item), 0);
}

export function purchasesThisMonth(state: AppState): Purchase[] {
  return state.purchases.filter(
    (p) => p.status !== 'cancelled' && isThisMonth(p.createdAt),
  );
}

export function purchasesMonthCents(state: AppState): Cents {
  return purchasesThisMonth(state).reduce(
    (sum, p) => sum + purchaseTotalCents(p, 'expected'),
    0,
  );
}

export function lossesThisMonth(state: AppState) {
  return state.losses.filter((l) => isThisMonth(l.at));
}

export function lossesMonthCents(state: AppState): Cents {
  return lossesThisMonth(state).reduce((sum, l) => sum + l.valueCents, 0);
}

export function lossesWeekCents(state: AppState): Cents {
  return state.losses
    .filter((l) => isWithinDays(l.at, 7))
    .reduce((sum, l) => sum + l.valueCents, 0);
}

export function belowMinItems(state: AppState): InventoryItem[] {
  return state.items.filter((item) => itemStatus(item) !== 'normal');
}

export function approvedCountsThisMonth(state: AppState): CountSession[] {
  return state.counts.filter(
    (c) => c.status === 'approved' && c.approvedAt != null && isThisMonth(c.approvedAt),
  );
}

export function divergenceCents(state: AppState): Cents {
  return approvedCountsThisMonth(state).reduce(
    (sum, count) => sum + Math.abs(countFinancialCents(state, count)),
    0,
  );
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

export function countFinancialCents(state: AppState, count: CountSession): Cents {
  return count.lines.reduce((sum, line) => {
    if (line.countedQty == null) return sum;
    const item = state.items.find((i) => i.id === line.itemId);
    if (!item) return sum;
    return sum + Math.round((line.countedQty - line.expectedQty) * item.costCents);
  }, 0);
}

export function countDivergences(count: CountSession): number {
  return count.lines.filter(
    (line) => line.countedQty != null && Math.abs(line.countedQty - line.expectedQty) > 0.001,
  ).length;
}

export function consumptionSince(state: AppState, itemId: string, days: number): number {
  const from = NOW.getTime() - days * DAY_MS;
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

export interface PriceVariation {
  item: InventoryItem;
  firstCents: Cents;
  lastCents: Cents;
  variation: number;
  points: number;
}

export function priceVariation(state: AppState, item: InventoryItem): PriceVariation | null {
  const from = NOW.getTime() - 120 * DAY_MS;
  const points = state.pricePoints
    .filter((p) => p.itemId === item.id && new Date(p.at).getTime() >= from)
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
    .sort((a, b) => a.lastPriceCents - b.lastPriceCents);
}

export function supplierItemCount(state: AppState, supplierId: string): number {
  return new Set(
    state.supplierItems.filter((si) => si.supplierId === supplierId).map((si) => si.itemId),
  ).size;
}

export function supplierLastPurchase(state: AppState, supplierId: string): Purchase | null {
  return (
    state.purchases
      .filter((p) => p.supplierId === supplierId && p.status === 'received')
      .sort((a, b) => new Date(b.receivedAt ?? b.createdAt).getTime() - new Date(a.receivedAt ?? a.createdAt).getTime())[0] ??
    null
  );
}

export function supplierRecentValue(state: AppState, supplierId: string): Cents {
  return state.purchases
    .filter(
      (p) =>
        p.supplierId === supplierId &&
        p.status !== 'cancelled' &&
        isWithinDays(p.createdAt, 90),
    )
    .reduce((sum, p) => sum + purchaseTotalCents(p), 0);
}

export function recommendedPurchases(state: AppState): RecommendedPurchase[] {
  const result: RecommendedPurchase[] = [];

  for (const item of state.items) {
    const avg = avgDailyConsumption(state, item.id);
    if (avg <= 0) continue;
    const offer = primaryOffer(state, item);
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
      avgDaily: avg,
      daysRemaining,
      leadTimeDays,
      coverageDays,
      safetyQty: Math.round(safetyQty * 100) / 100,
      recommendedQty,
      estimatedCostCents: Math.round(recommendedQty * item.costCents),
      formula: `${fmtQty(avg)} ${item.unit}/dia × ${coverageDays} dias + ${fmtQty(safetyQty)} ${item.unit} − ${fmtQty(item.currentQty)} ${item.unit}`,
    });
  }

  return result.sort((a, b) => a.daysRemaining - b.daysRemaining);
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
    const qtyInItemUnit = convertQty(ingredient.qty, ingredient.unit, item.unit);
    return sum + qtyInItemUnit * item.costCents;
  }, 0);
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
    totals.set(loss.itemId, (totals.get(loss.itemId) ?? 0) + loss.valueCents);
  }
  const [itemId, valueCents] = [...totals.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  const item = state.items.find((i) => i.id === itemId) ?? null;
  return item ? { item, valueCents: valueCents ?? 0 } : null;
}

export function topLossReason(state: AppState) {
  const totals = new Map<string, Cents>();
  for (const loss of lossesThisMonth(state)) {
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

export function attentionItems(state: AppState): AttentionItem[] {
  const alerts: AttentionItem[] = [];
  const rising = risingCostItems(state);
  const recs = recommendedPurchases(state);

  const empty = state.items.filter((i) => itemStatus(i) === 'empty');
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

  const risky = recs.filter((r) => r.daysRemaining <= r.coverageDays).slice(0, 3);
  for (const rec of risky) {
    const status = itemStatus(rec.item);
    if (status === 'empty') continue;
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
    const financial = countFinancialCents(state, lastCount);
    if (biggest && item) {
      const diff = (biggest.countedQty ?? 0) - biggest.expectedQty;
      alerts.push({
        id: `count-${lastCount.id}`,
        severity: 'high',
        tag: 'Divergência',
        title: `Contagem encontrou ${diff > 0 ? '+' : '−'}${fmtQty(Math.abs(diff))} ${item.unit} de ${item.name.toLowerCase()}.`,
        detail: `${lastCount.code} aprovada em ${new Date(lastCount.approvedAt ?? '').toLocaleDateString('pt-BR')}. Diferença financeira total de ${moneyShort(Math.abs(financial))} na contagem.`,
        valueCents: Math.abs(financial),
        valueLabel: 'impacto na contagem',
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
      severity: weekLosses > 30000 ? 'medium' : 'high',
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
