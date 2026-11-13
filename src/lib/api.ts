import type { AuditAction, AuditEntry, CountSession, InventoryItem, Loss, Movement, PricePoint, Purchase, PurchaseStatus, Recipe, RecipeSnapshot, RecommendedPurchase, Role, Supplier, SupplierItem, Unit } from '../domain/types';
import { countMovementCode, isOpeningBalanceMovement } from '../domain/movements';
import { manualMovementPayload } from '../domain/movements';
import { purchasePriceHistory } from '../domain/purchase-prices';
import { authStartupMessage, responseEndsAuthenticatedSession } from '../domain/auth';
import { clearOperationReservation, isDefinitiveHttpRejection, pendingOperationPayload,
  migrateOperationReservation, reserveOperationKey, storedOperationScopes, tenantOperationScope } from '../domain/idempotency';
import { normalizePendingReceiptFingerprint, receiptOperationFingerprint,
  receiptOperationScope } from '../domain/receipts';
import { acquireTabSessionId } from './tab-session';
import { resolveApiOrigin } from '../domain/api-origin';

// Vite production builds must never fall back to seeded/demo data when a
// deployment variable is missing. Local development remains demo by default.
export const APP_MODE = import.meta.env.PROD || import.meta.env.VITE_APP_MODE === 'production'
  ? 'production' : 'demo';
export const DACOT_HUB_MODULES_URL = 'https://hub.dacot.com.br/portal/modulos';
export const SESSION_EXPIRED_EVENT = 'dacot:session-expired';
export function setActiveApiTenant(tenantId: string | null) {
  activeTenantId = tenantId;
}

const apiOrigin = resolveApiOrigin(import.meta.env.VITE_API_BASE_URL, APP_MODE === 'production');
const apiBase = `${apiOrigin.baseUrl ?? 'http://localhost:8000'}/api/v1`;
let refreshInFlight: Promise<boolean> | null = null;
let activeTenantId: string | null = null;
let tabSessionPromise: ReturnType<typeof acquireTabSessionId> | null = null;
let successfulMutationRevision = 0;

export function getApiMutationRevision(): number {
  return successfulMutationRevision;
}

class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export function startupErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return authStartupMessage(error.status, error.message);
  if (error instanceof TypeError) return authStartupMessage(null);
  return authStartupMessage(0, error instanceof Error ? error.message : '');
}

export function isApiConflict(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 409;
}

async function tabSessionId(): Promise<string> {
  if (!tabSessionPromise) {
    const createChannel = typeof BroadcastChannel === 'undefined'
      ? null
      : (name: string) => {
          try {
            const channel = new BroadcastChannel(name);
            let handler: ((event: { data: unknown }) => void) | null = null;
            return {
              set onmessage(next: ((event: { data: unknown }) => void) | null) {
                handler = next;
                channel.onmessage = next ? (event) => next({ data: event.data }) : null;
              },
              get onmessage() { return handler; },
              postMessage: (value: unknown) => channel.postMessage(value),
              close: () => channel.close(),
            };
          } catch {
            return null;
          }
        };
    const navigationType = (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type;
    tabSessionPromise = acquireTabSessionId(sessionStorage, () => crypto.randomUUID(), createChannel,
      undefined, navigationType === 'reload');
  }
  return (await tabSessionPromise).id;
}

async function headers(extra?: HeadersInit): Promise<Headers> {
  const value = new Headers(extra);
  value.set('X-DACOT-Tab-Session', await tabSessionId());
  return value;
}

async function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
  if (apiOrigin.error) throw new Error(apiOrigin.error);
  const requestHeaders = await headers(init.headers);
  if (init.body && !requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'application/json');
  return fetch(`${apiBase}${path}`, { ...init, headers: requestHeaders, credentials: 'include' });
}

async function refreshSession(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = rawRequest('/auth/refresh', { method: 'POST' })
      .then((response) => response.ok)
      .catch(() => false)
      .finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  let response = await rawRequest(path, init);
  if (response.status === 401 && retry && path !== '/auth/session/exchange' && await refreshSession()) {
    response = await rawRequest(path, init);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = typeof data.detail === 'string' ? data.detail : '';
    if (responseEndsAuthenticatedSession(response.status, detail) && path !== '/auth/session/exchange') {
      activeTenantId = null;
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT, {
        detail: startupErrorMessage(new ApiRequestError(detail, response.status)),
      }));
    }
    throw new ApiRequestError(detail || `Falha na API (${response.status})`, response.status);
  }
  const method = (init.method ?? 'GET').toUpperCase();
  if (!path.startsWith('/auth/') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    successfulMutationRevision += 1;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export async function exchangeHandoffFromUrl(): Promise<void> {
  const url = new URL(window.location.href);
  const handoff = url.searchParams.get('handoff');
  if (!handoff) return;
  url.searchParams.delete('handoff');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  await apiRequest<void>('/auth/session/exchange', {
    method: 'POST', body: JSON.stringify({ handoff }),
  }, false);
}

export interface ApiMe {
  user_id: string;
  restaurant_id: string;
  restaurant_slug?: string | null;
  role: Role | 'waiter' | 'kitchen';
}

interface ApiIngredient {
  _id: string;
  restaurant_id: string;
  name: string;
  category: string;
  base_unit: string;
  current_quantity: number;
  min_quantity: number;
  cost_cents: number;
  cost_known?: boolean;
  primary_supplier_id?: string | null;
  updated_at: string;
  active: boolean;
  internal_code?: string | null;
  barcode?: string | null;
  notes?: string;
  conversions?: Record<string, number>;
  cost_updated_at?: string | null;
  version?: number;
  stock_version?: number;
}

interface ApiMovement {
  _id: string;
  restaurant_id: string;
  ingredient_id: string;
  kind: string;
  quantity: number;
  unit: string;
  unit_cost_cents: number | null;
  occurred_at: string;
  reason: string;
  supplier_id?: string | null;
  purchase_reference?: string | null;
  actor_id: string;
  balance_after: number;
  stock_version_after?: number;
  reversal_of?: string | null;
  reversed_by_movement_id?: string | null;
}

interface ApiMovementInsights {
  recent_movements: ApiMovement[];
  latest_two_supplier_price_movements: ApiMovement[];
}

export interface ApiIngredientPriceHistory {
  points: PricePoint[];
  summary: { first_cost_cents: number; last_cost_cents: number; count: number } | null;
}

export interface ApiPurchaseInsights {
  status_counts: Partial<Record<Purchase['status'], number>>;
  month: { order_count: number; expected_total_cents: number;
    received_total_cents: number; received_unpriced_count: number };
  suppliers: Record<string, { order_count: number; recent_received_value_cents: number;
    last_receipt_at: string | null; last_receipt_code: string | null }>;
}

export async function fetchApiPurchaseInsights(): Promise<ApiPurchaseInsights> {
  return apiRequest<ApiPurchaseInsights>('/purchase-insights');
}

export interface ApiOperationalInsights {
  losses: { count: number; priced_count: number; unpriced_count: number; value_cents: number;
    week_value_cents: number; reason_totals: { reason: string; value_cents: number }[];
    top_item: { ingredient_id: string; ingredient_name: string; value_cents: number } | null;
    top_month_reason: { reason: string; value_cents: number } | null };
  counts: { approved_count: number; unknown_financial_count: number; divergence_cents: number;
    last_divergence: { id: string; code: string; approved_at: string; ingredient_name: string;
      unit: string; difference_milli: number; impact_cents: number | null;
      divergence_cents?: number | null;
      impact_complete: boolean } | null };
}

export async function fetchApiOperationalInsights(): Promise<ApiOperationalInsights> {
  return apiRequest<ApiOperationalInsights>('/operational-insights');
}

interface ApiReplenishmentRecommendation {
  ingredient: ApiIngredient;
  basis: 'minimum';
  stock_status: 'empty' | 'critical' | 'attention';
  avg_daily_consumption: number;
  days_remaining: number;
  lead_time_days: number;
  coverage_days: number;
  safety_quantity: number;
  recommended_quantity: number;
  estimated_cost_cents: number | null;
}

export async function fetchApiReplenishmentRecommendations(limit = 5): Promise<{
  items: RecommendedPurchase[]; total: number;
}> {
  const result = await apiRequest<{ items: ApiReplenishmentRecommendation[]; total: number }>(
    `/replenishment-recommendations?limit=${limit}`,
  );
  return {
    total: result.total,
    items: result.items.map((recommendation) => {
      const item = mapIngredient(recommendation.ingredient);
      return {
        item, basis: recommendation.basis, avgDaily: recommendation.avg_daily_consumption,
          stockStatus: recommendation.stock_status,
        daysRemaining: recommendation.days_remaining, leadTimeDays: recommendation.lead_time_days,
        coverageDays: recommendation.coverage_days, safetyQty: recommendation.safety_quantity,
        recommendedQty: recommendation.recommended_quantity,
        estimatedCostCents: recommendation.estimated_cost_cents,
        formula: `Estoque atual ${item.currentQty} ${item.unit} abaixo do mínimo ${item.minQty} ${item.unit}`,
      };
    }),
  };
}

export interface ApiPriceRiseInsights {
  count: number;
  top: { item: InventoryItem; firstCents: number; lastCents: number;
    variation: number; points: number } | null;
}

export async function fetchApiPriceRiseInsights(): Promise<ApiPriceRiseInsights> {
  const result = await apiRequest<{ count: number; top: {
    ingredient: ApiIngredient; first_unit_cost_cents: number; last_unit_cost_cents: number;
    variation: number; points: number;
  } | null }>('/price-rise-insights');
  return { count: result.count, top: result.top ? {
    item: mapIngredient(result.top.ingredient), firstCents: result.top.first_unit_cost_cents,
    lastCents: result.top.last_unit_cost_cents, variation: result.top.variation,
    points: result.top.points,
  } : null };
}

interface ApiPurchase {
  _id: string;
  restaurant_id: string;
  code: string;
  supplier_id: string | null;
  status: Purchase['status'];
  version?: number;
  created_at: string;
  updated_at?: string;
  expected_delivery_at: string | null;
  received_at: string | null;
  received_by: string | null;
  note: string;
  lines: { id: string; ingredient_id: string; quantity_ordered: number; quantity_received: number;
    expected_unit_cost_cents: number; received_unit_cost_cents: number | null; unit?: string }[];
}

interface ApiPurchaseStockMutation {
  purchase: ApiPurchase;
  ingredients: ApiIngredient[];
  movements: ApiMovement[];
  recipes: ApiRecipe[];
  recipe_snapshots: ApiRecipeSnapshot[];
}

export interface PurchaseStockMutation {
  purchase: Purchase;
  items: InventoryItem[];
  movements: Movement[];
  recipes: Recipe[];
  recipeSnapshots: RecipeSnapshot[];
}

export interface PurchaseReceiptRecord {
  id: string;
  received_at: string;
  actor_id: string;
  lines: { line_id: string; quantity_received: number; unit_cost_cents: number }[];
  reversed_at?: string | null;
  reversed_by?: string | null;
  reversal_reason?: string | null;
}

interface ApiRecipe {
  _id: string;
  restaurant_id: string;
  product_id: string;
  product_name: string;
  sale_price_cents: number;
  yield_portions?: number;
  version?: number;
  active?: boolean;
  lines: { ingredient_id: string; quantity: number; unit: string; conversion_to_base?: number }[];
  created_at?: string;
  updated_at: string;
}

interface ApiRecipeSnapshot {
  _id: string; restaurant_id: string; product_id: string; cost_cents: number;
  yield_portions?: number; batch_cost_cents?: number;
  sale_price_cents: number; occurred_at: string; trigger: string; cost_complete?: boolean;
  unknown_ingredient_ids?: string[]; lines?: { unit_cost_cents: number }[];
}

interface ApiAuditEntry {
  id: string; restaurant_id: string; user_id: string; action: AuditAction; entity: string;
  entity_label: string; before: string | null; after: string | null; reason: string; at: string;
}

interface ApiAuditPage {
  items: ApiAuditEntry[]; has_more: boolean; next_cursor: string | null;
}

interface ApiSupplier {
  _id: string; restaurant_id: string; name: string; contact: string; phone: string; whatsapp: string;
  notes: string; avg_lead_time_days: number; min_order_cents: number; created_at: string; version?: number; active?: boolean;
}

interface ApiCount {
  _id: string; restaurant_id: string; code: string; status: CountSession['status'];
  created_at: string; updated_at?: string; version?: number; approved_at: string | null;
  created_by: string; approved_by: string | null;
  financial_impact_cents?: number | null; financial_impact_complete?: boolean;
  financial_divergence_cents?: number | null;
  movements?: ApiMovement[];
  lines: { ingredient_id: string; expected_quantity: number; counted_quantity: number | null; unit: string;
    financial_impact_cents?: number | null; financial_impact_complete?: boolean;
    expected_value_cents?: number | null; counted_value_cents?: number | null; valuation_complete?: boolean }[];
}

interface ApiLoss {
  _id: string; restaurant_id: string; ingredient_id: string; quantity: number; reason: Loss['reason'];
  note: string; value_cents: number | null; value_complete?: boolean; occurred_at: string; actor_id: string;
  movement?: ApiMovement | null;
}

export async function fetchApiLossMonthPage(reason: Loss['reason'] | 'all', offset: number, limit = 50): Promise<{
  losses: Loss[]; total: number; hasMore: boolean;
}> {
  const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
  if (reason !== 'all') query.set('reason', reason);
  const result = await apiRequest<{ items: ApiLoss[]; total: number; has_more: boolean }>(
    `/losses/month?${query.toString()}`,
  );
  return { losses: result.items.map(mapLoss), total: result.total, hasMore: result.has_more };
}

export async function fetchApiLoss(lossId: string): Promise<Loss> {
  return mapLoss(await apiRequest<ApiLoss>(`/losses/${encodeURIComponent(lossId)}`));
}

const asUnit = (value: string): Unit => (value.toLowerCase() === 'l' ? 'L' : value as Unit);
const asCategory = (value: string): InventoryItem['category'] =>
  (['Carnes', 'Hortifruti', 'Laticínios', 'Bebidas', 'Secos', 'Congelados', 'Embalagens', 'Outros'].includes(value)
    ? value : 'Outros') as InventoryItem['category'];

export function mapIngredient(item: ApiIngredient): InventoryItem {
  return {
    id: item._id, restaurantId: item.restaurant_id, name: item.name, category: asCategory(item.category),
    unit: asUnit(item.base_unit), currentQty: item.current_quantity, minQty: item.min_quantity,
    costCents: item.cost_cents, costKnown: item.cost_known ?? item.cost_cents > 0,
    primarySupplierId: item.primary_supplier_id ?? null,
    updatedAt: item.updated_at, active: item.active, internalCode: item.internal_code ?? null,
    barcode: item.barcode ?? null, notes: item.notes ?? '', conversions: item.conversions ?? {},
    costUpdatedAt: item.cost_updated_at ?? null,
    version: item.version ?? 1,
    stockVersion: item.stock_version,
  };
}

export async function fetchApiIngredient(ingredientId: string): Promise<InventoryItem> {
  return mapIngredient(await apiRequest<ApiIngredient>(`/ingredients/${encodeURIComponent(ingredientId)}`));
}

export async function fetchApiIngredientsByIds(ids: string[]): Promise<InventoryItem[]> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const chunks: string[][] = [];
  for (let index = 0; index < uniqueIds.length; index += 100) chunks.push(uniqueIds.slice(index, index + 100));
  const results = await Promise.all(chunks.map(async (chunk) => {
    const query = new URLSearchParams();
    chunk.forEach((id) => query.append('ids', id));
    return apiRequest<ApiIngredient[]>(`/ingredients/by-ids?${query.toString()}`);
  }));
  return results.flat().map(mapIngredient);
}

export function mapMovement(movement: ApiMovement): Movement {
  const openingBalance = isOpeningBalanceMovement(movement.kind, movement.purchase_reference, movement.reason);
  const countCode = countMovementCode(movement.kind, movement.reason);
  const direction = ['adjustment_out', 'count_out', 'loss'].includes(movement.kind) ? 'out' : 'in';
  const type: Movement['type'] = openingBalance ? 'OPENING_BALANCE'
    : movement.kind === 'purchase' ? 'PURCHASE'
      : countCode ? 'COUNT_ADJUSTMENT'
    : movement.kind === 'loss' ? 'LOSS'
      : movement.kind === 'adjustment_in' || movement.kind === 'adjustment_out'
        ? 'ADJUSTMENT' : 'ADJUSTMENT';
  return {
    id: movement._id, restaurantId: movement.restaurant_id, itemId: movement.ingredient_id,
    type, direction,
    qty: movement.quantity, unit: asUnit(movement.unit), unitCostCents: movement.unit_cost_cents,
    occurredAt: movement.occurred_at,
    reason: openingBalance ? 'Saldo inicial informado no cadastro'
      : countCode ? `Diferença confirmada na contagem ${countCode}` : movement.reason,
    origin: openingBalance ? 'Cadastro do insumo'
      : countCode ? `Contagem física ${countCode}` : movement.purchase_reference ?? 'Ajuste manual', userId: movement.actor_id,
    balanceAfter: movement.balance_after,
    stockVersionAfter: movement.stock_version_after,
    supplierId: movement.supplier_id ?? null, reversalOf: movement.reversal_of ?? null,
    canReverse: ['adjustment_in', 'adjustment_out'].includes(movement.kind)
      && !movement.purchase_reference && !movement.reversal_of,
    reversedByMovementId: movement.reversed_by_movement_id ?? null,
  };
}

export function mapPurchase(purchase: ApiPurchase): Purchase {
  return {
    id: purchase._id, restaurantId: purchase.restaurant_id, code: purchase.code,
    supplierId: purchase.supplier_id ?? '', status: purchase.status, createdAt: purchase.created_at,
    version: purchase.version ?? 1,
    updatedAt: purchase.updated_at ?? purchase.created_at,
    expectedDeliveryAt: purchase.expected_delivery_at, receivedAt: purchase.received_at,
    receivedBy: purchase.received_by, note: purchase.note,
    lines: purchase.lines.map((line) => ({
      id: line.id, itemId: line.ingredient_id, qtyOrdered: line.quantity_ordered,
      unit: line.unit ? asUnit(line.unit) : undefined,
      qtyReceived: line.quantity_received, expectedUnitCostCents: line.expected_unit_cost_cents,
      receivedUnitCostCents: line.received_unit_cost_cents,
    })),
  };
}

function mapPurchaseStockMutation(result: ApiPurchaseStockMutation): PurchaseStockMutation {
  return { purchase: mapPurchase(result.purchase), items: result.ingredients.map(mapIngredient),
    movements: result.movements.map(mapMovement), recipes: result.recipes.map(mapRecipe),
    recipeSnapshots: result.recipe_snapshots.map(mapRecipeSnapshot) };
}

function mapRecipe(recipe: ApiRecipe): Recipe {
  return {
    id: recipe.product_id, restaurantId: recipe.restaurant_id, name: recipe.product_name,
    salePriceCents: recipe.sale_price_cents,
    yieldPortions: recipe.yield_portions ?? 1,
    ingredients: recipe.lines.map((line) => ({ itemId: line.ingredient_id, qty: line.quantity,
      unit: asUnit(line.unit), conversionToBase: line.conversion_to_base })),
    createdAt: recipe.created_at ?? recipe.updated_at, updatedAt: recipe.updated_at,
    version: recipe.version ?? 1, active: recipe.active ?? true,
  };
}

function mapRecipeSnapshot(snapshot: ApiRecipeSnapshot): RecipeSnapshot {
  return { id: snapshot._id, restaurantId: snapshot.restaurant_id, recipeId: snapshot.product_id,
    costCents: snapshot.cost_cents, salePriceCents: snapshot.sale_price_cents,
    yieldPortions: snapshot.yield_portions ?? 1, batchCostCents: snapshot.batch_cost_cents ?? snapshot.cost_cents,
    at: snapshot.occurred_at, trigger: snapshot.trigger,
    costComplete: snapshot.cost_complete ?? snapshot.lines?.every((line) => line.unit_cost_cents > 0) ?? false };
}

function mapAuditEntry(entry: ApiAuditEntry): AuditEntry {
  return { id: entry.id, restaurantId: entry.restaurant_id, userId: entry.user_id,
    action: entry.action, entity: entry.entity, entityLabel: entry.entity_label,
    before: entry.before, after: entry.after, reason: entry.reason, at: entry.at };
}

export function mapSupplier(supplier: ApiSupplier): Supplier {
  return {
    id: supplier._id, restaurantId: supplier.restaurant_id, name: supplier.name,
    contact: supplier.contact, phone: supplier.phone, whatsapp: supplier.whatsapp,
    notes: supplier.notes, avgLeadTimeDays: supplier.avg_lead_time_days,
    minOrderCents: supplier.min_order_cents, createdAt: supplier.created_at,
    version: supplier.version ?? 1, active: supplier.active ?? true,
  };
}

export function mapCount(count: ApiCount): CountSession {
  return {
    id: count._id, restaurantId: count.restaurant_id, code: count.code,
    status: count.status, startedAt: count.created_at, updatedAt: count.updated_at ?? count.created_at,
    version: count.version ?? 1,
    approvedAt: count.approved_at,
    createdBy: count.created_by, approvedBy: count.approved_by,
    financialImpactCents: count.financial_impact_cents ?? null,
    financialDivergenceCents: count.financial_divergence_cents ?? null,
    financialImpactComplete: count.status === 'approved' ? count.financial_impact_complete ?? false : undefined,
    lines: count.lines.map((line) => ({ itemId: line.ingredient_id,
      expectedQty: line.expected_quantity, countedQty: line.counted_quantity,
      financialImpactCents: line.financial_impact_cents ?? null,
      financialImpactComplete: count.status === 'approved'
        ? line.financial_impact_complete ?? false : undefined,
      expectedValueCents: line.expected_value_cents ?? null,
      countedValueCents: line.counted_value_cents ?? null,
      valuationComplete: count.status === 'approved' ? line.valuation_complete ?? false : undefined })),
  };
}

function mapLoss(loss: ApiLoss): Loss {
  return { id: loss._id, restaurantId: loss.restaurant_id, itemId: loss.ingredient_id,
    qty: loss.quantity, reason: loss.reason, note: loss.note,
    valueCents: loss.value_complete === false || (loss.value_complete == null && loss.value_cents === 0)
      ? null : loss.value_cents,
    at: loss.occurred_at, userId: loss.actor_id };
}

export async function loadRealState(cachedIngredientIds: string[] = []): Promise<{ me: ApiMe; items: InventoryItem[]; purchases: Purchase[];
  purchaseInsights: ApiPurchaseInsights;
  movements: Movement[]; recipes: Recipe[]; recipeSnapshots: RecipeSnapshot[]; suppliers: Supplier[];
  supplierItems: SupplierItem[]; pricePoints: PricePoint[];
  counts: CountSession[]; losses: Loss[]; audit: AuditEntry[]; auditCursor: string | null; auditHasMore: boolean }> {
  if (apiOrigin.error) throw new Error(apiOrigin.error);
  const [me, purchaseInsights, movementInsights, audit] = await Promise.all([
    apiRequest<ApiMe>('/me'),
    fetchApiPurchaseInsights(), apiRequest<ApiMovementInsights>('/movement-insights'),
    fetchAuditPage(),
  ]);
  const movementById = new Map<string, ApiMovement>();
  [...movementInsights.recent_movements, ...movementInsights.latest_two_supplier_price_movements]
    .forEach((movement) => movementById.set(movement._id, movement));
  const apiMovements = [...movementById.values()];
  // Hydrate only ingredients needed by the initial dashboard context. The full
  // catalog belongs to the paginated inventory screen, not application startup.
  const relevantIngredientIds = [...new Set([
    ...apiMovements.map((movement) => movement.ingredient_id),
    ...cachedIngredientIds,
  ])];
  const items = await fetchApiIngredientsByIds(relevantIngredientIds);
  const supplierIds = [...new Set([
    ...items.map((ingredient) => ingredient.primarySupplierId).filter((id): id is string => !!id),
    ...apiMovements.map((movement) => movement.supplier_id).filter((id): id is string => !!id),
  ])];
  const mappedSuppliers = await fetchApiSuppliersByIds(supplierIds);
  const mappedMovements = apiMovements.map(mapMovement);
  const prices = purchasePriceHistory(mappedMovements, mappedSuppliers);
  return { me, items, purchases: [], purchaseInsights,
    movements: mappedMovements, recipes: [],
    recipeSnapshots: [], suppliers: mappedSuppliers,
    supplierItems: prices.supplierItems, pricePoints: prices.pricePoints,
    counts: [], losses: [], audit: audit.items.map(mapAuditEntry),
    auditCursor: audit.next_cursor, auditHasMore: audit.has_more };
}

export async function fetchApiRecipePage(offset: number, pageSize = 50): Promise<{
  recipes: Recipe[]; hasMore: boolean;
}> {
  const query = new URLSearchParams({ limit: String(pageSize + 1), offset: String(offset) });
  const rows = await apiRequest<ApiRecipe[]>(`/recipes?${query.toString()}`);
  return { recipes: rows.slice(0, pageSize).map(mapRecipe), hasMore: rows.length > pageSize };
}

export interface ApiRecipeInsights {
  total: number;
  active_count: number;
  calculable_count: number;
  attention_count: number;
  incomplete_count: number;
  average_cost_ratio: number;
}

export async function fetchApiRecipeInsights(): Promise<ApiRecipeInsights> {
  return apiRequest<ApiRecipeInsights>('/recipe-insights');
}

export async function fetchApiRecipe(productId: string): Promise<Recipe> {
  return mapRecipe(await apiRequest<ApiRecipe>(`/recipes/${encodeURIComponent(productId)}`));
}

export interface ApiGlobalSearchDocument {
  id: string;
  group: 'Estoque' | 'Compras' | 'Fornecedores' | 'Fichas técnicas' | 'Contagens' | 'Perdas & movimentos';
  title: string;
  subtitle: string;
  href: string;
  searchable: string;
  status?: 'near_minimum' | 'attention' | 'critical' | 'empty';
}

export async function fetchApiGlobalSearch(query: string): Promise<ApiGlobalSearchDocument[]> {
  const params = new URLSearchParams({ q: query.trim() });
  return apiRequest<ApiGlobalSearchDocument[]>(`/search?${params.toString()}`);
}

export async function fetchApiRecipesUsingIngredient(ingredientId: string): Promise<Recipe[]> {
  const query = new URLSearchParams({ ingredient_id: ingredientId });
  return (await fetchAllPages<ApiRecipe>(`/recipes?${query.toString()}`)).map(mapRecipe);
}

export async function fetchApiInventoryPage(filters: {
  search: string;
  category: string | null;
  status: string | null;
  sort: 'name' | 'quantity_asc' | 'updated_desc' | 'cost_desc' | 'priority' | 'value_desc';
  supplierId?: string | null;
}, offset: number, pageSize = 50, activeOnly = false, includeSummary = false): Promise<{
  items: InventoryItem[]; hasMore: boolean; total?: number;
  summary?: Pick<ApiInventoryInsights, 'known_stock_value_cents' | 'without_cost'>;
}> {
  const query = new URLSearchParams({ limit: String(pageSize + 1), offset: String(offset), sort: filters.sort });
  if (filters.search.trim()) query.set('search', filters.search.trim());
  if (filters.category) query.set('category', filters.category);
  if (filters.status) query.set('status', filters.status);
  if (filters.supplierId) query.set('supplier_id', filters.supplierId);
  if (activeOnly) query.set('active_only', 'true');
  if (includeSummary) query.set('include_summary', 'true');
  if (includeSummary) {
    const result = await apiRequest<{ items: ApiIngredient[]; total: number;
      summary: Pick<ApiInventoryInsights, 'known_stock_value_cents' | 'without_cost'> }>(`/ingredients?${query.toString()}`);
    return { items: result.items.slice(0, pageSize).map(mapIngredient),
      hasMore: result.items.length > pageSize, total: result.total, summary: result.summary };
  }
  const rows = await apiRequest<ApiIngredient[]>(`/ingredients?${query.toString()}`);
  return { items: rows.slice(0, pageSize).map(mapIngredient), hasMore: rows.length > pageSize };
}

export interface ApiInventoryInsights {
  total: number;
  active_total: number;
  known_stock_value_cents: number;
  without_cost: number;
  normal: number;
  near_minimum: number;
  attention: number;
  critical: number;
  empty: number;
  active_normal: number;
  active_near_minimum: number;
  active_attention: number;
  active_critical: number;
  active_empty: number;
}

export async function fetchApiInventoryInsights(): Promise<ApiInventoryInsights> {
  return apiRequest<ApiInventoryInsights>('/inventory-insights');
}

export async function fetchApiSupplierPage(search: string, offset: number, pageSize = 50,
  includeInactive = true): Promise<{
  suppliers: Supplier[]; hasMore: boolean;
}> {
  const query = new URLSearchParams({ limit: String(pageSize + 1), offset: String(offset) });
  if (includeInactive) query.set('include_inactive', 'true');
  if (search.trim()) query.set('search', search.trim());
  const rows = await apiRequest<ApiSupplier[]>(`/suppliers?${query.toString()}`);
  return { suppliers: rows.slice(0, pageSize).map(mapSupplier), hasMore: rows.length > pageSize };
}

export async function fetchApiSuppliersByIds(ids: string[]): Promise<Supplier[]> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const chunks: string[][] = [];
  for (let index = 0; index < uniqueIds.length; index += 100) chunks.push(uniqueIds.slice(index, index + 100));
  const results = await Promise.all(chunks.map(async (chunk) => {
    const query = new URLSearchParams();
    chunk.forEach((id) => query.append('ids', id));
    return apiRequest<ApiSupplier[]>(`/suppliers/by-ids?${query.toString()}`);
  }));
  return results.flat().map(mapSupplier);
}

export async function fetchApiSupplier(supplierId: string): Promise<Supplier> {
  return mapSupplier(await apiRequest<ApiSupplier>(`/suppliers/${encodeURIComponent(supplierId)}`));
}

export async function fetchApiIngredientMovementPage(ingredientId: string, offset: number, pageSize = 50): Promise<{
  movements: Movement[]; hasMore: boolean;
}> {
  const query = new URLSearchParams({ limit: String(pageSize + 1), offset: String(offset) });
  const rows = await apiRequest<ApiMovement[]>(
    `/ingredients/${encodeURIComponent(ingredientId)}/movements?${query.toString()}`,
  );
  return { movements: rows.slice(0, pageSize).map(mapMovement), hasMore: rows.length > pageSize };
}

export async function fetchApiIngredientPriceHistory(ingredientId: string): Promise<ApiIngredientPriceHistory> {
  const result = await apiRequest<{ points: ApiMovement[]; summary: ApiIngredientPriceHistory['summary'] }>(
    `/ingredients/${encodeURIComponent(ingredientId)}/price-history`,
  );
  return {
    points: result.points.map((raw) => {
      const movement = mapMovement(raw);
      if (movement.unitCostCents == null || !movement.supplierId) {
        throw new Error('A API retornou um preço de compra incompleto.');
      }
      return { id: movement.id, restaurantId: movement.restaurantId, itemId: movement.itemId,
        supplierId: movement.supplierId, unitCostCents: movement.unitCostCents,
        at: movement.occurredAt, source: 'purchase' };
    }),
    summary: result.summary,
  };
}

export async function fetchApiPurchasePage(status: PurchaseStatus | 'all', offset: number, pageSize = 50,
  supplierId?: string): Promise<{
  purchases: Purchase[]; hasMore: boolean;
}> {
  const query = new URLSearchParams({ limit: String(pageSize + 1), offset: String(offset) });
  if (status !== 'all') query.set('status', status);
  if (supplierId) query.set('supplier_id', supplierId);
  const rows = await apiRequest<ApiPurchase[]>(`/purchases?${query.toString()}`);
  return { purchases: rows.slice(0, pageSize).map(mapPurchase), hasMore: rows.length > pageSize };
}

export async function fetchApiPurchase(purchaseId: string): Promise<Purchase> {
  return mapPurchase(await apiRequest<ApiPurchase>(`/purchases/${encodeURIComponent(purchaseId)}`));
}

export async function fetchApiRecipeSnapshotPage(productId: string, offset = 0, pageSize = 50): Promise<{
  snapshots: RecipeSnapshot[]; hasMore: boolean;
}> {
  const filter = new URLSearchParams({ product_id: productId });
  filter.set('limit', String(pageSize + 1));
  filter.set('offset', String(offset));
  const rows = await apiRequest<ApiRecipeSnapshot[]>(`/recipes/snapshots?${filter.toString()}`);
  return { snapshots: rows.slice(0, pageSize).map(mapRecipeSnapshot), hasMore: rows.length > pageSize };
}

export async function fetchApiAuditPage(cursor: string | null): Promise<{
  items: AuditEntry[]; hasMore: boolean; nextCursor: string | null;
}> {
  const query = new URLSearchParams({ limit: '100' });
  if (cursor) query.set('cursor', cursor);
  const page = await apiRequest<ApiAuditPage>(`/audit?${query.toString()}`);
  if (page.has_more && !page.next_cursor) throw new Error('A API retornou uma página de auditoria sem cursor.');
  return { items: page.items.map(mapAuditEntry), hasMore: page.has_more, nextCursor: page.next_cursor };
}

async function fetchAuditPage(): Promise<ApiAuditPage> {
  return apiRequest<ApiAuditPage>('/audit?limit=100');
}

async function fetchAllPages<T>(path: string, pageSize = 500): Promise<T[]> {
  const result: T[] = [];
  let offset = 0;
  while (true) {
    const separator = path.includes('?') ? '&' : '?';
    const page = await apiRequest<T[]>(`${path}${separator}limit=${pageSize}&offset=${offset}`);
    result.push(...page);
    if (page.length < pageSize) return result;
    offset += page.length;
  }
}

export function toRole(role: ApiMe['role']): Role {
  return role === 'admin' || role === 'manager' ? role : 'operator';
}

async function runIdempotent<T>(scope: string, fingerprint: string,
  request: (idempotencyKey: string, retryPayload: string) => Promise<T>,
  retryPayload = fingerprint): Promise<T> {
  const operation = reserveOperationKey(sessionStorage, tenantOperationScope(activeTenantId, scope),
    fingerprint, () => crypto.randomUUID(), retryPayload);
  try {
    const result = await request(operation.key, operation.payload);
    clearOperationReservation(sessionStorage, operation);
    return result;
  } catch (error) {
    if (isDefinitiveHttpRejection(error)) clearOperationReservation(sessionStorage, operation);
    throw error;
  }
}

export async function createApiIngredient(input: {
  name: string; category: string; unit: Unit; minQty: number; costCents: number; costKnown?: boolean; initialQty: number;
  supplierId: string | null; conversions?: Record<string, number>;
}) {
  const payload = {
    name: input.name, category: input.category, base_unit: input.unit.toLowerCase(),
    min_quantity: input.minQty, cost_cents: input.costCents,
    cost_known: input.costKnown ?? input.costCents > 0, initial_quantity: input.initialQty,
    primary_supplier_id: input.supplierId,
    conversions: input.conversions ?? {},
  };
  return runIdempotent('ingredient-create', JSON.stringify(payload), (key) =>
    apiRequest<ApiIngredient>('/ingredients', { method: 'POST',
      headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload) }));
}

export async function updateApiIngredient(ingredientId: string, expectedVersion: number, input: {
  name?: string; category?: string; minQty?: number; costCents?: number; costKnown?: boolean;
  supplierId?: string | null; internalCode?: string | null; barcode?: string | null;
  notes?: string; active?: boolean; conversions?: Record<string, number>;
}) {
  const payload = {
    expected_version: expectedVersion,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.minQty !== undefined ? { min_quantity: input.minQty } : {}),
    ...(input.costCents !== undefined ? { cost_cents: input.costCents } : {}),
    ...(input.costKnown !== undefined ? { cost_known: input.costKnown } : {}),
    ...(input.supplierId !== undefined ? { primary_supplier_id: input.supplierId } : {}),
    ...(input.internalCode !== undefined ? { internal_code: input.internalCode } : {}),
    ...(input.barcode !== undefined ? { barcode: input.barcode } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.active !== undefined ? { active: input.active } : {}),
    ...(input.conversions !== undefined ? { conversions: input.conversions } : {}),
  };
  const updated = await apiRequest<ApiIngredient>(`/ingredients/${encodeURIComponent(ingredientId)}`, {
    method: 'PATCH', body: JSON.stringify(payload),
  });
  return mapIngredient(updated);
}

export async function createApiSupplier(input: Omit<Supplier, 'id' | 'restaurantId' | 'createdAt'>) {
  const payload = {
    name: input.name, contact: input.contact, phone: input.phone, whatsapp: input.whatsapp,
    notes: input.notes, avg_lead_time_days: input.avgLeadTimeDays, min_order_cents: input.minOrderCents,
  };
  const created = await runIdempotent('supplier-create', JSON.stringify(payload), (key) =>
    apiRequest<ApiSupplier>('/suppliers', { method: 'POST',
      headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload) }));
  return mapSupplier(created);
}

export async function updateApiSupplier(supplierId: string, expectedVersion: number,
  input: Omit<Supplier, 'id' | 'restaurantId' | 'createdAt' | 'version'>) {
  const updated = await apiRequest<ApiSupplier>(`/suppliers/${encodeURIComponent(supplierId)}`, {
    method: 'PATCH', body: JSON.stringify({ expected_version: expectedVersion,
      name: input.name, contact: input.contact, phone: input.phone,
      whatsapp: input.whatsapp, notes: input.notes, avg_lead_time_days: input.avgLeadTimeDays,
      min_order_cents: input.minOrderCents, active: input.active !== false }),
  });
  return mapSupplier(updated);
}

export async function createApiPurchase(input: {
  supplierId: string; expectedDeliveryAt: string | null; note: string;
  lines: { itemId: string; qtyOrdered: number; expectedUnitCostCents: number; unit: Unit }[];
}) {
  const payload = { supplier_id: input.supplierId || null, expected_delivery_at: input.expectedDeliveryAt,
    note: input.note, lines: input.lines.map((line) => ({ ingredient_id: line.itemId,
      quantity_ordered: line.qtyOrdered, unit: line.unit.toLowerCase(), expected_unit_cost_cents: line.expectedUnitCostCents })) };
  return runIdempotent('purchase-create', JSON.stringify(payload), (key) =>
    apiRequest<ApiPurchase>('/purchases', { method: 'POST', headers: { 'Idempotency-Key': key },
      body: JSON.stringify(payload) }));
}

export async function updateApiPurchase(purchase: Purchase, input: {
  supplierId: string; expectedDeliveryAt: string | null; note: string;
  lines: { itemId: string; qtyOrdered: number; expectedUnitCostCents: number; unit: Unit }[];
}) {
  if (!purchase.version) throw new Error('A versão do rascunho não está disponível; recarregue a compra.');
  const payload = { supplier_id: input.supplierId || null, expected_delivery_at: input.expectedDeliveryAt,
    note: input.note, expected_version: purchase.version,
    lines: input.lines.map((line) => ({ ingredient_id: line.itemId,
      quantity_ordered: line.qtyOrdered, unit: line.unit.toLowerCase(), expected_unit_cost_cents: line.expectedUnitCostCents })) };
  const updated = await apiRequest<ApiPurchase>(`/purchases/${encodeURIComponent(purchase.id)}`, {
    method: 'PUT', body: JSON.stringify(payload),
  });
  return mapPurchase(updated);
}

function receiptScopeForPurchase(purchase: Purchase): string {
  const scope = receiptOperationScope(purchase.id);
  if (APP_MODE !== 'production' || !activeTenantId) return scope;
  const currentScoped = tenantOperationScope(activeTenantId, scope);
  const legacyPrefix = tenantOperationScope(activeTenantId, `${scope}-v`);
  const discoveredScopes = storedOperationScopes(sessionStorage, legacyPrefix);
  const legacyTokens: (number | string)[] = [purchase.version ?? purchase.updatedAt ?? purchase.createdAt];
  if (typeof purchase.version === 'number' && purchase.version > 1) {
    legacyTokens.push(purchase.version - 1);
  }
  const previousScopes = [...new Set([...discoveredScopes, ...legacyTokens.map((token) =>
    tenantOperationScope(activeTenantId!, `receipt-${purchase.id}-v${token}`))])];
  migrateOperationReservation(sessionStorage, previousScopes, currentScoped,
    normalizePendingReceiptFingerprint);
  return scope;
}

export function pendingApiReceiptPayload(purchase: Purchase): string | null {
  if (APP_MODE !== 'production' || !activeTenantId) return null;
  return pendingOperationPayload(sessionStorage,
    tenantOperationScope(activeTenantId, receiptScopeForPurchase(purchase)));
}

export async function receiveApiPurchase(purchase: Purchase, lines: { lineId: string; qtyReceived: number;
  unitCostCents: number }[]): Promise<PurchaseStockMutation> {
  const payload = { expected_version: purchase.version ?? 1, lines: lines.map((line) => {
      const previous = purchase.lines.find((entry) => entry.id === line.lineId)?.qtyReceived ?? 0;
      return { line_id: line.lineId, quantity_received: Math.max(0, line.qtyReceived - previous),
        unit_cost_cents: line.unitCostCents };
    }).filter((line) => line.quantity_received > 0) };
  const scope = receiptScopeForPurchase(purchase);
  const result = await runIdempotent(scope, receiptOperationFingerprint(payload.lines), (key, retryPayload) =>
    apiRequest<ApiPurchaseStockMutation>(`/purchases/${encodeURIComponent(purchase.id)}/receipts`, {
      method: 'POST', headers: { 'Idempotency-Key': key }, body: retryPayload,
    }), JSON.stringify(payload));
  return mapPurchaseStockMutation(result);
}

export async function listApiPurchaseReceipts(purchaseId: string) {
  return apiRequest<PurchaseReceiptRecord[]>(`/purchases/${encodeURIComponent(purchaseId)}/receipts`);
}

export async function reverseApiPurchaseReceipt(purchaseId: string, receiptId: string,
  reason: string): Promise<PurchaseStockMutation> {
  const payload = { reason };
  const result = await runIdempotent(`receipt-reversal-${receiptId}`, JSON.stringify({ purchaseId, receiptId, ...payload }), (key) =>
    apiRequest<ApiPurchaseStockMutation>(`/purchases/${encodeURIComponent(purchaseId)}/receipts/${encodeURIComponent(receiptId)}/reversal`, {
      method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload),
    }));
  return mapPurchaseStockMutation(result);
}

export async function reverseApiMovement(movementId: string, reason: string) {
  const payload = { reason };
  return runIdempotent(`movement-reversal-${movementId}`, JSON.stringify(payload), (key) =>
    apiRequest<ApiMovement>(`/movements/${encodeURIComponent(movementId)}/reversal`, {
      method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload),
    }));
}

export async function setApiPurchaseStatus(purchaseId: string, action: 'request' | 'cancel', expectedVersion: number) {
  return apiRequest<ApiPurchase>(`/purchases/${encodeURIComponent(purchaseId)}/${action}`, {
    method: 'POST', body: JSON.stringify({ expected_version: expectedVersion }),
  });
}

export async function saveApiRecipe(recipe: Recipe, expectedVersion: number | null): Promise<Recipe> {
  const saved = await apiRequest<ApiRecipe>(`/recipes/${encodeURIComponent(recipe.id)}`, {
    method: 'PUT',
    body: JSON.stringify({
      product_id: recipe.id,
      product_name: recipe.name,
      sale_price_cents: recipe.salePriceCents,
      yield_portions: recipe.yieldPortions,
      expected_version: expectedVersion,
      lines: recipe.ingredients.map((line) => ({
        ingredient_id: line.itemId, quantity: line.qty, unit: line.unit.toLowerCase(),
      })),
    }),
  });
  return mapRecipe(saved);
}

export async function setApiRecipeActive(productId: string, active: boolean, expectedVersion: number): Promise<Recipe> {
  const updated = await apiRequest<ApiRecipe>(`/recipes/${encodeURIComponent(productId)}/status`, {
    method: 'PATCH', body: JSON.stringify({ active, expected_version: expectedVersion }),
  });
  return mapRecipe(updated);
}

export async function recordApiMovement(input: { itemId: string; kind: 'in' | 'out' | 'adjust';
  qty: number; reason: string; currentQty: number }) {
  const payload = manualMovementPayload(input);
  return runIdempotent(`movement-${input.itemId}`, JSON.stringify(payload), (key) =>
    apiRequest<ApiMovement>(`/ingredients/${encodeURIComponent(input.itemId)}/movements`, {
      method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload),
    }));
}

export interface ApiCountSelection {
  scope: 'all' | 'low' | 'category';
  category: string | null;
  search: string;
  include_ids?: string[];
  exclude_ids?: string[];
}

export interface ApiCountInsights {
  status_counts: Partial<Record<CountSession['status'], number>>;
  unknown_financial_count: number;
  divergence_cents: number;
  latest_open: CountSession | null;
}

export async function fetchApiCountInsights(): Promise<ApiCountInsights> {
  const result = await apiRequest<{ status_counts: Partial<Record<CountSession['status'], number>>;
    unknown_financial_count: number; divergence_cents: number; latest_open: ApiCount | null }>(
    '/count-insights',
  );
  return { status_counts: result.status_counts, unknown_financial_count: result.unknown_financial_count,
    divergence_cents: result.divergence_cents,
    latest_open: result.latest_open ? mapCount(result.latest_open) : null };
}

export async function fetchApiCountPage(offset: number, limit = 50): Promise<{
  counts: CountSession[]; hasMore: boolean;
}> {
  const query = new URLSearchParams({ offset: String(offset), limit: String(limit + 1) });
  const result = await apiRequest<ApiCount[]>(`/counts?${query.toString()}`);
  return { counts: result.slice(0, limit).map(mapCount), hasMore: result.length > limit };
}

export async function fetchApiCount(countId: string): Promise<CountSession> {
  return mapCount(await apiRequest<ApiCount>(`/counts/${encodeURIComponent(countId)}`));
}

export async function fetchApiCountCandidates(input: {
  selection: ApiCountSelection;
  selectionMode: 'all' | 'custom';
  offset: number;
  includeIds?: string[];
  excludeIds?: string[];
  limit?: number;
}): Promise<{ items: InventoryItem[]; total: number; selectedCount: number; categories: string[] }> {
  const query = new URLSearchParams({ scope: input.selection.scope,
    selection_mode: input.selectionMode, limit: String(input.limit ?? 50), offset: String(input.offset) });
  if (input.selection.category) query.set('category', input.selection.category);
  if (input.selection.search.trim()) query.set('search', input.selection.search.trim());
  (input.includeIds ?? []).forEach((id) => query.append('include_ids', id));
  (input.excludeIds ?? []).forEach((id) => query.append('exclude_ids', id));
  const page = await apiRequest<{ items: ApiIngredient[]; total: number; selected_count: number; categories: string[] }>(
    `/ingredients/count-candidates?${query.toString()}`);
  return { items: page.items.map(mapIngredient), total: page.total,
    selectedCount: page.selected_count, categories: page.categories };
}

export async function createApiCount(itemIds: string[], selection?: ApiCountSelection): Promise<CountSession> {
  const payload = selection ? { selection } : { ingredient_ids: itemIds };
  const result = await runIdempotent('count-create', JSON.stringify(payload), (key) =>
    apiRequest<ApiCount>('/counts', { method: 'POST',
      headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload) }));
  return mapCount(result);
}

export async function setApiCountLine(countId: string, itemId: string, countedQty: number | null,
  expectedVersion: number) {
  const result = await apiRequest<ApiCount>(`/counts/${encodeURIComponent(countId)}/lines/${encodeURIComponent(itemId)}`, {
    method: 'PATCH', body: JSON.stringify({ counted_quantity: countedQty, expected_version: expectedVersion }),
  });
  return mapCount(result);
}

export async function approveApiCount(countId: string, expectedVersion: number) {
  const result = await runIdempotent(`count-approve-${countId}`,
    JSON.stringify({ countId, expectedVersion }), (key) =>
    apiRequest<ApiCount>(`/counts/${encodeURIComponent(countId)}/approve`, {
      method: 'POST', headers: { 'Idempotency-Key': key },
      body: JSON.stringify({ expected_version: expectedVersion }),
    }));
  return { count: mapCount(result), movements: (result.movements ?? []).map(mapMovement) };
}

export async function createApiLoss(input: { itemId: string; qty: number; reason: Loss['reason']; note: string }) {
  const payload = { ingredient_id: input.itemId, quantity: input.qty, reason: input.reason, note: input.note };
  const result = await runIdempotent(`loss-${input.itemId}`, JSON.stringify(payload), (key) =>
    apiRequest<ApiLoss>('/losses', { method: 'POST',
      headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload) }));
  return { loss: mapLoss(result), movement: result.movement ? mapMovement(result.movement) : null };
}

export async function logoutApiSession() {
  try {
    return await apiRequest<void>('/auth/logout', { method: 'POST' });
  } finally {
    activeTenantId = null;
  }
}

export type RealStateSnapshot = Awaited<ReturnType<typeof loadRealState>>;
