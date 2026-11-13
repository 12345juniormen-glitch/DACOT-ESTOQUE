/**
 * DACOT — Estoque & Compras
 * Modelo de domínio da V1 (front-end). Todos os valores monetários são
 * inteiros em centavos. Toda entidade carrega restaurantId (multi-tenant).
 */

export type Cents = number;

export type Role = 'admin' | 'manager' | 'operator';

export type Unit = 'kg' | 'g' | 'L' | 'ml' | 'un' | (string & {});

export const UNIT_LABEL: Record<Unit, string> = {
  kg: 'kg',
  g: 'g',
  L: 'L',
  ml: 'ml',
  un: 'un',
};

export const CATEGORIES = [
  'Carnes',
  'Hortifruti',
  'Laticínios',
  'Bebidas',
  'Secos',
  'Congelados',
  'Embalagens',
  'Outros',
] as const;

export type ItemCategory = (typeof CATEGORIES)[number];

export type ItemStatus = 'normal' | 'near_minimum' | 'attention' | 'critical' | 'empty';

export const STATUS_LABEL: Record<ItemStatus, string> = {
  normal: 'Normal',
  near_minimum: 'Próximo do mínimo',
  attention: 'Atenção',
  critical: 'Crítico',
  empty: 'Sem estoque',
};

export type MovementType =
  | 'PURCHASE'
  | 'OPENING_BALANCE'
  | 'CONSUMPTION'
  | 'ADJUSTMENT'
  | 'COUNT_ADJUSTMENT'
  | 'LOSS'
  | 'MANUAL_IN'
  | 'MANUAL_OUT';

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  PURCHASE: 'Compra',
  OPENING_BALANCE: 'Saldo inicial',
  CONSUMPTION: 'Consumo por vendas',
  ADJUSTMENT: 'Ajuste de inventário',
  COUNT_ADJUSTMENT: 'Correção de contagem',
  LOSS: 'Perda',
  MANUAL_IN: 'Entrada manual',
  MANUAL_OUT: 'Saída manual',
};

export interface Restaurant {
  id: string;
  name: string;
  city: string;
}

export interface User {
  id: string;
  restaurantId: string;
  name: string;
  role: Role;
  initials: string;
}

export interface Supplier {
  id: string;
  restaurantId: string;
  name: string;
  contact: string;
  phone: string;
  whatsapp: string;
  notes: string;
  avgLeadTimeDays: number;
  minOrderCents: Cents;
  createdAt: string;
  version?: number;
  active?: boolean;
}

/** Oferta/preço de um fornecedor para um insumo. */
export interface SupplierItem {
  id: string;
  restaurantId: string;
  supplierId: string;
  itemId: string;
  lastPriceCents: Cents;
  lastPurchaseAt: string | null;
  leadTimeDays: number;
  minOrderCents: Cents;
}

export interface InventoryItem {
  id: string;
  restaurantId: string;
  name: string;
  category: ItemCategory;
  unit: Unit;
  currentQty: number;
  minQty: number;
  costCents: Cents;
  /** Distinguishes an explicitly confirmed zero price from an unknown cost. */
  costKnown?: boolean;
  primarySupplierId: string | null;
  updatedAt: string;
  version?: number;
  stockVersion?: number;
  active?: boolean;
  internalCode?: string | null;
  barcode?: string | null;
  notes?: string;
  conversions?: Record<string, number>;
  costUpdatedAt?: string | null;
  /** Consumo médio usado apenas como semente de demonstração. */
  referenceDailyUse?: number;
}

export interface Movement {
  id: string;
  restaurantId: string;
  itemId: string;
  type: MovementType;
  /** Sempre positivo; o sentido vem de `direction`. */
  qty: number;
  direction: 'in' | 'out';
  unit: Unit;
  unitCostCents: Cents | null;
  occurredAt: string;
  reason: string;
  origin: string;
  userId: string;
  balanceAfter: number;
  stockVersionAfter?: number;
  supplierId?: string | null;
  reversalOf?: string | null;
  canReverse?: boolean;
  reversedByMovementId?: string | null;
}

export interface PurchaseLine {
  id: string;
  itemId: string;
  unit?: Unit;
  qtyOrdered: number;
  qtyReceived: number;
  expectedUnitCostCents: Cents;
  receivedUnitCostCents: Cents | null;
}

export type PurchaseStatus =
  | 'draft'
  | 'requested'
  | 'partial'
  | 'received'
  | 'cancelled';

export const PURCHASE_STATUS_LABEL: Record<PurchaseStatus, string> = {
  draft: 'Rascunho',
  requested: 'Solicitado',
  partial: 'Parcialmente recebido',
  received: 'Recebido',
  cancelled: 'Cancelado',
};

export interface Purchase {
  id: string;
  restaurantId: string;
  code: string;
  supplierId: string;
  status: PurchaseStatus;
  version?: number;
  createdAt: string;
  updatedAt?: string;
  expectedDeliveryAt: string | null;
  receivedAt: string | null;
  receivedBy: string | null;
  note: string;
  lines: PurchaseLine[];
}

export interface RecipeIngredient {
  itemId: string;
  /** Quantidade na unidade informada (ex.: 160 g de carne). */
  qty: number;
  unit: Unit;
  /** Conversion captured by the backend when this recipe version was saved. */
  conversionToBase?: number;
}

export interface Recipe {
  id: string;
  restaurantId: string;
  name: string;
  salePriceCents: Cents;
  /** Number of saleable portions produced by the full ingredient batch. */
  yieldPortions: number;
  ingredients: RecipeIngredient[];
  createdAt: string;
  updatedAt: string;
  version: number;
  active?: boolean;
  consumptionEnabled?: boolean;
}

/** Custo congelado da ficha — protege o histórico de pedidos já realizados. */
export interface RecipeSnapshot {
  id: string;
  restaurantId: string;
  recipeId: string;
  costCents: Cents;
  yieldPortions?: number;
  batchCostCents?: Cents;
  salePriceCents: Cents;
  at: string;
  trigger: string;
  /** false when at least one ingredient had no registered cost at snapshot time. */
  costComplete?: boolean;
}

export type CountStatus = 'open' | 'review' | 'approved';

export interface CountLine {
  itemId: string;
  expectedQty: number;
  countedQty: number | null;
  /** Per-line value frozen on approval; null is distinct from zero/unpriced. */
  financialImpactCents?: Cents | null;
  financialImpactComplete?: boolean;
  expectedValueCents?: Cents | null;
  countedValueCents?: Cents | null;
  valuationComplete?: boolean;
}

export interface CountSession {
  id: string;
  restaurantId: string;
  code: string;
  status: CountStatus;
  startedAt: string;
  updatedAt?: string;
  version?: number;
  approvedAt: string | null;
  createdBy: string;
  approvedBy: string | null;
  /** Frozen signed value of stock variance at approval time. */
  financialImpactCents?: Cents | null;
  /** Frozen gross value of per-line variances at approval time. */
  financialDivergenceCents?: Cents | null;
  /** False when at least one changed line had no known unit cost at approval. */
  financialImpactComplete?: boolean;
  lines: CountLine[];
}

export type LossReason =
  | 'Vencimento'
  | 'Preparo errado'
  | 'Sobra'
  | 'Quebra'
  | 'Erro operacional'
  | 'Qualidade'
  | 'Outros';

export const LOSS_REASONS: LossReason[] = [
  'Vencimento',
  'Preparo errado',
  'Sobra',
  'Quebra',
  'Erro operacional',
  'Qualidade',
  'Outros',
];

export interface Loss {
  id: string;
  restaurantId: string;
  itemId: string;
  qty: number;
  reason: LossReason;
  note: string;
  valueCents: Cents | null;
  at: string;
  userId: string;
}

export interface PricePoint {
  id: string;
  restaurantId: string;
  itemId: string;
  supplierId: string;
  unitCostCents: Cents;
  at: string;
  source: 'purchase' | 'history';
}

export type AuditAction =
  | 'stock.adjust'
  | 'stock.consumption'
  | 'ingredient.update'
  | 'loss.register'
  | 'purchase.receive'
  | 'purchase.receipt.reverse'
  | 'purchase.create'
  | 'purchase.update'
  | 'purchase.cancel'
  | 'count.approve'
  | 'count.create'
  | 'count.line.update'
  | 'recipe.update'
  | 'recipe.cost.snapshot'
  | 'recipe.conversion.freeze'
  | 'cost.change'
  | 'supplier.create'
  | 'supplier.update';

export interface AuditEntry {
  id: string;
  restaurantId: string;
  userId: string;
  action: AuditAction;
  entity: string;
  entityLabel: string;
  before: string | null;
  after: string | null;
  reason: string;
  at: string;
}

export type OrderEventType =
  | 'ORDER_CREATED'
  | 'ORDER_UPDATED'
  | 'ORDER_DELIVERED'
  | 'ORDER_CANCELLED';

export interface OrderLine {
  recipeId: string;
  qty: number;
}

export interface OrderEvent {
  id: string;
  type: OrderEventType;
  restaurantId: string;
  orderId: string;
  occurredAt: string;
  lines: OrderLine[];
  /** Marca de processamento — base da idempotência. */
  processedAt: string | null;
  consumption?: { itemId: string; qty: number }[];
}

export interface AppState {
  /** Reference instant for time-window selectors; frozen in demo, refreshed in production. */
  asOf?: string;
  restaurant: Restaurant;
  users: User[];
  currentUserId: string;
  suppliers: Supplier[];
  supplierItems: SupplierItem[];
  items: InventoryItem[];
  purchases: Purchase[];
  purchaseStatusCounts?: Partial<Record<PurchaseStatus, number>>;
  purchaseMonthInsight?: { orderCount: number; expectedTotalCents: Cents;
    receivedTotalCents: Cents; receivedUnpricedCount: number };
  supplierPurchaseInsights?: Record<string, {
    orderCount: number;
    recentReceivedValueCents: Cents;
    lastReceiptAt: string | null;
    lastReceiptCode: string | null;
  }>;
  recipes: Recipe[];
  recipeSnapshots: RecipeSnapshot[];
  counts: CountSession[];
  losses: Loss[];
  movements: Movement[];
  pricePoints: PricePoint[];
  audit: AuditEntry[];
  events: OrderEvent[];
  processedEventIds: string[];
}

export interface RecommendedPurchase {
  item: InventoryItem;
  basis: 'consumption' | 'minimum';
  stockStatus?: 'empty' | 'critical' | 'attention';
  avgDaily: number;
  daysRemaining: number;
  leadTimeDays: number;
  coverageDays: number;
  safetyQty: number;
  recommendedQty: number;
  estimatedCostCents: Cents | null;
  formula: string;
}
