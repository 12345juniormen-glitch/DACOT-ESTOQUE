import type { InventoryItem, Movement, Purchase, Recipe, Role, Supplier, Unit } from '../domain/types';

// Vite production builds must never fall back to seeded/demo data when a
// deployment variable is missing. Local development remains demo by default.
export const APP_MODE = import.meta.env.PROD || import.meta.env.VITE_APP_MODE === 'production'
  ? 'production' : 'demo';

const configuredApiBase = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '');
const apiBase = `${configuredApiBase || 'http://localhost:8000'}/api/v1`;
const tabKey = 'dacot.tab-session-id';
let refreshInFlight: Promise<boolean> | null = null;

function tabSessionId(): string {
  let id = sessionStorage.getItem(tabKey);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(tabKey, id);
  }
  return id;
}

function headers(extra?: HeadersInit): Headers {
  const value = new Headers(extra);
  value.set('X-DACOT-Tab-Session', tabSessionId());
  return value;
}

async function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const requestHeaders = headers(init.headers);
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
    throw new Error(typeof data.detail === 'string' ? data.detail : `Falha na API (${response.status})`);
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
  primary_supplier_id?: string | null;
  updated_at: string;
  active: boolean;
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
}

interface ApiPurchase {
  _id: string;
  restaurant_id: string;
  code: string;
  supplier_id: string | null;
  status: Purchase['status'];
  created_at: string;
  expected_delivery_at: string | null;
  received_at: string | null;
  received_by: string | null;
  note: string;
  lines: { id: string; ingredient_id: string; quantity_ordered: number; quantity_received: number;
    expected_unit_cost_cents: number; received_unit_cost_cents: number | null }[];
}

interface ApiRecipe {
  _id: string;
  restaurant_id: string;
  product_id: string;
  product_name: string;
  sale_price_cents: number;
  lines: { ingredient_id: string; quantity: number; unit: string }[];
  created_at?: string;
  updated_at: string;
}

interface ApiSupplier {
  _id: string; restaurant_id: string; name: string; contact: string; phone: string; whatsapp: string;
  notes: string; avg_lead_time_days: number; min_order_cents: number; created_at: string;
}

const asUnit = (value: string): Unit => (value.toLowerCase() === 'l' ? 'L' : value as Unit);
const asCategory = (value: string): InventoryItem['category'] =>
  (['Carnes', 'Hortifruti', 'Laticínios', 'Bebidas', 'Secos', 'Congelados', 'Embalagens', 'Outros'].includes(value)
    ? value : 'Outros') as InventoryItem['category'];

export function mapIngredient(item: ApiIngredient): InventoryItem {
  return {
    id: item._id, restaurantId: item.restaurant_id, name: item.name, category: asCategory(item.category),
    unit: asUnit(item.base_unit), currentQty: item.current_quantity, minQty: item.min_quantity,
    costCents: item.cost_cents, primarySupplierId: item.primary_supplier_id ?? null,
    updatedAt: item.updated_at,
  };
}

function mapMovement(movement: ApiMovement): Movement {
  const direction = movement.kind === 'adjustment_out' ? 'out' : 'in';
  return {
    id: movement._id, restaurantId: movement.restaurant_id, itemId: movement.ingredient_id,
    type: movement.kind === 'purchase' ? 'PURCHASE' : 'ADJUSTMENT', direction,
    qty: movement.quantity, unit: asUnit(movement.unit), unitCostCents: movement.unit_cost_cents,
    occurredAt: movement.occurred_at, reason: movement.reason,
    origin: movement.purchase_reference ?? 'Ajuste manual', userId: movement.actor_id,
    balanceAfter: movement.balance_after,
  };
}

function mapPurchase(purchase: ApiPurchase): Purchase {
  return {
    id: purchase._id, restaurantId: purchase.restaurant_id, code: purchase.code,
    supplierId: purchase.supplier_id ?? '', status: purchase.status, createdAt: purchase.created_at,
    expectedDeliveryAt: purchase.expected_delivery_at, receivedAt: purchase.received_at,
    receivedBy: purchase.received_by, note: purchase.note,
    lines: purchase.lines.map((line) => ({
      id: line.id, itemId: line.ingredient_id, qtyOrdered: line.quantity_ordered,
      qtyReceived: line.quantity_received, expectedUnitCostCents: line.expected_unit_cost_cents,
      receivedUnitCostCents: line.received_unit_cost_cents,
    })),
  };
}

function mapRecipe(recipe: ApiRecipe): Recipe {
  return {
    id: recipe.product_id, restaurantId: recipe.restaurant_id, name: recipe.product_name,
    salePriceCents: recipe.sale_price_cents,
    ingredients: recipe.lines.map((line) => ({ itemId: line.ingredient_id, qty: line.quantity, unit: asUnit(line.unit) })),
    createdAt: recipe.created_at ?? recipe.updated_at, updatedAt: recipe.updated_at,
  };
}

function mapSupplier(supplier: ApiSupplier): Supplier {
  return {
    id: supplier._id, restaurantId: supplier.restaurant_id, name: supplier.name,
    contact: supplier.contact, phone: supplier.phone, whatsapp: supplier.whatsapp,
    notes: supplier.notes, avgLeadTimeDays: supplier.avg_lead_time_days,
    minOrderCents: supplier.min_order_cents, createdAt: supplier.created_at,
  };
}

export async function loadRealState(): Promise<{ me: ApiMe; items: InventoryItem[]; purchases: Purchase[];
  movements: Movement[]; recipes: Recipe[]; suppliers: Supplier[] }> {
  if (APP_MODE === 'production' && !configuredApiBase) {
    throw new Error('VITE_API_BASE_URL não foi configurada para o modo de produção.');
  }
  const [me, ingredients, purchases, movements, recipes, suppliers] = await Promise.all([
    apiRequest<ApiMe>('/me'), apiRequest<ApiIngredient[]>('/ingredients'),
    apiRequest<ApiPurchase[]>('/purchases'), apiRequest<ApiMovement[]>('/movements'),
    apiRequest<ApiRecipe[]>('/recipes'), apiRequest<ApiSupplier[]>('/suppliers'),
  ]);
  return { me, items: ingredients.map(mapIngredient), purchases: purchases.map(mapPurchase),
    movements: movements.map(mapMovement), recipes: recipes.map(mapRecipe), suppliers: suppliers.map(mapSupplier) };
}

export function toRole(role: ApiMe['role']): Role {
  return role === 'admin' || role === 'manager' ? role : 'operator';
}

function operationKey(scope: string, fingerprint: string): { key: string; storageKey: string } {
  const storageKey = `dacot.idempotency.${scope}`;
  const stored = sessionStorage.getItem(storageKey);
  if (stored) {
    try {
      const previous = JSON.parse(stored) as { fingerprint: string; key: string };
      if (previous.fingerprint === fingerprint) return { key: previous.key, storageKey };
    } catch { /* replace malformed local retry metadata */ }
  }
  const key = crypto.randomUUID();
  sessionStorage.setItem(storageKey, JSON.stringify({ fingerprint, key }));
  return { key, storageKey };
}

function clearOperationKey(operation: { key: string; storageKey: string }) {
  try {
    const stored = JSON.parse(sessionStorage.getItem(operation.storageKey) ?? 'null') as { key?: string } | null;
    if (stored?.key === operation.key) sessionStorage.removeItem(operation.storageKey);
  } catch { sessionStorage.removeItem(operation.storageKey); }
}

export async function createApiIngredient(input: {
  name: string; category: string; unit: Unit; minQty: number; costCents: number; initialQty: number;
  supplierId: string | null;
}) {
  return apiRequest<ApiIngredient>('/ingredients', { method: 'POST', body: JSON.stringify({
    name: input.name, category: input.category, base_unit: input.unit.toLowerCase(),
    min_quantity: input.minQty, cost_cents: input.costCents, initial_quantity: input.initialQty,
    primary_supplier_id: input.supplierId,
  }) });
}

export async function createApiSupplier(input: Omit<Supplier, 'id' | 'restaurantId' | 'createdAt'>) {
  const created = await apiRequest<ApiSupplier>('/suppliers', { method: 'POST', body: JSON.stringify({
    name: input.name, contact: input.contact, phone: input.phone, whatsapp: input.whatsapp,
    notes: input.notes, avg_lead_time_days: input.avgLeadTimeDays, min_order_cents: input.minOrderCents,
  }) });
  return mapSupplier(created);
}

export async function createApiPurchase(input: {
  supplierId: string; expectedDeliveryAt: string | null; note: string;
  lines: { itemId: string; qtyOrdered: number; expectedUnitCostCents: number; unit: Unit }[];
}) {
  const payload = { supplier_id: input.supplierId || null, expected_delivery_at: input.expectedDeliveryAt,
    note: input.note, lines: input.lines.map((line) => ({ ingredient_id: line.itemId,
      quantity_ordered: line.qtyOrdered, unit: line.unit.toLowerCase(), expected_unit_cost_cents: line.expectedUnitCostCents })) };
  const operation = operationKey('purchase-create', JSON.stringify(payload));
  const result = await apiRequest<ApiPurchase>('/purchases', { method: 'POST', headers: { 'Idempotency-Key': operation.key },
    body: JSON.stringify(payload) });
  clearOperationKey(operation);
  return result;
}

export async function receiveApiPurchase(purchase: Purchase, lines: { lineId: string; qtyReceived: number;
  unitCostCents: number }[]) {
  const payload = { lines: lines.map((line) => {
      const previous = purchase.lines.find((entry) => entry.id === line.lineId)?.qtyReceived ?? 0;
      return { line_id: line.lineId, quantity_received: Math.max(0, line.qtyReceived - previous),
        unit_cost_cents: line.unitCostCents };
    }).filter((line) => line.quantity_received > 0) };
  const scope = `receipt-${purchase.id}`;
  const operation = operationKey(scope, JSON.stringify(payload));
  const result = await apiRequest<ApiPurchase>(`/purchases/${encodeURIComponent(purchase.id)}/receipts`, {
    method: 'POST', headers: { 'Idempotency-Key': operation.key }, body: JSON.stringify(payload),
  });
  clearOperationKey(operation);
  return result;
}

export async function setApiPurchaseStatus(purchaseId: string, action: 'request' | 'cancel') {
  return apiRequest<ApiPurchase>(`/purchases/${encodeURIComponent(purchaseId)}/${action}`, { method: 'POST' });
}

export async function saveApiRecipe(recipe: Recipe) {
  return apiRequest<ApiRecipe>(`/recipes/${encodeURIComponent(recipe.id)}`, {
    method: 'PUT',
    body: JSON.stringify({
      product_id: recipe.id,
      product_name: recipe.name,
      sale_price_cents: recipe.salePriceCents,
      lines: recipe.ingredients.map((line) => ({
        ingredient_id: line.itemId, quantity: line.qty, unit: line.unit.toLowerCase(),
      })),
    }),
  });
}

export async function recordApiMovement(input: { itemId: string; kind: 'in' | 'out' | 'adjust';
  qty: number; reason: string; currentQty: number }) {
  const delta = input.kind === 'adjust' ? input.qty - input.currentQty : input.qty;
  const kind = delta < 0 ? 'adjustment_out' : 'adjustment_in';
  const payload = { kind, quantity: Math.abs(delta), reason: input.reason, unit_cost_cents: null };
  const operation = operationKey(`movement-${input.itemId}`, JSON.stringify(payload));
  const result = await apiRequest<ApiMovement>(`/ingredients/${encodeURIComponent(input.itemId)}/movements`, {
    method: 'POST', headers: { 'Idempotency-Key': operation.key }, body: JSON.stringify(payload),
  });
  clearOperationKey(operation);
  return result;
}

export async function logoutApiSession() {
  return apiRequest<void>('/auth/logout', { method: 'POST' });
}

export type RealStateSnapshot = Awaited<ReturnType<typeof loadRealState>>;
