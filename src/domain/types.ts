/**
 * DACOT — Estoque & Compras
 * Modelo de domínio da V1 (front-end). Todos os valores monetários são
 * inteiros em centavos. Toda entidade carrega restaurantId (multi-tenant).
 */

export type Cents = number;

export type Role = 'admin' | 'manager' | 'operator';

export type Unit = 'kg' | 'g' | 'L' | 'ml' | 'un';

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

export type ItemStatus = 'normal' | 'attention' | 'critical' | 'empty';

export const STATUS_LABEL: Record<ItemStatus, string> = {
  normal: 'Normal',
  attention: 'Atenção',
  critical: 'Crítico',
  empty: 'Sem estoque',
};

export type MovementType =
  | 'PURCHASE'
  | 'CONSUMPTION'
  | 'ADJUSTMENT'
  | 'LOSS'
  | 'MANUAL_IN'
  | 'MANUAL_OUT';

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  PURCHASE: 'Compra',
  CONSUMPTION: 'Consumo por vendas',
  ADJUSTMENT: 'Ajuste de inventário',
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
  primarySupplierId: string | null;
  updatedAt: string;
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
}

export interface PurchaseLine {
  id: string;
  itemId: string;
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
  createdAt: string;
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
}

export interface Recipe {
  id: string;
  restaurantId: string;
  name: string;
  salePriceCents: Cents;
  ingredients: RecipeIngredient[];
  createdAt: string;
  updatedAt: string;
}

/** Custo congelado da ficha — protege o histórico de pedidos já realizados. */
export interface RecipeSnapshot {
  id: string;
  restaurantId: string;
  recipeId: string;
  costCents: Cents;
  salePriceCents: Cents;
  at: string;
  trigger: string;
}

export type CountStatus = 'open' | 'review' | 'approved';

export interface CountLine {
  itemId: string;
  expectedQty: number;
  countedQty: number | null;
}

export interface CountSession {
  id: string;
  restaurantId: string;
  code: string;
  status: CountStatus;
  startedAt: string;
  approvedAt: string | null;
  createdBy: string;
  approvedBy: string | null;
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
  valueCents: Cents;
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
  | 'loss.register'
  | 'purchase.receive'
  | 'purchase.create'
  | 'purchase.cancel'
  | 'count.approve'
  | 'recipe.update'
  | 'recipe.cost.snapshot'
  | 'cost.change'
  | 'supplier.create';

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
  restaurant: Restaurant;
  users: User[];
  currentUserId: string;
  suppliers: Supplier[];
  supplierItems: SupplierItem[];
  items: InventoryItem[];
  purchases: Purchase[];
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
  avgDaily: number;
  daysRemaining: number;
  leadTimeDays: number;
  coverageDays: number;
  safetyQty: number;
  recommendedQty: number;
  estimatedCostCents: Cents;
  formula: string;
}
