import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { applyOrderDelivered } from '../domain/events';
import { NOW_ISO } from '../domain/clock';
import { money, qty as fmtQty, quantityFactorToBase, roundCentsFromMilliUnits } from '../domain/format';
import { createDemoState } from '../domain/demo';
import { purchasePriceHistory, receiptUnitCostCents, receivedStockValues } from '../domain/purchase-prices';
import { isStockSnapshotCurrent, reconcileInventoryItem } from '../domain/movements';
import { mergeVersionedRecords, preferVersionedRecord, upsertVersionedRecord } from '../domain/versioned-records';
import { can as roleCan, type Permission } from '../domain/permissions';
import { itemCostKnown, purchaseTotalCents, recipeCostCents, recipeCostPerPortionCents } from '../domain/selectors';
import { APP_MODE, createApiIngredient, createApiPurchase, createApiSupplier, exchangeHandoffFromUrl,
  loadRealState, fetchApiAuditPage, fetchApiIngredientMovementPage, fetchApiRecipesUsingIngredient,
  fetchApiPurchase, fetchApiPurchaseInsights, fetchApiSupplier, fetchApiCount,
  fetchApiSuppliersByIds,
  fetchApiRecipeSnapshotPage,
  recordApiMovement, saveApiRecipe, setApiRecipeActive, createApiCount, setApiCountLine,
  approveApiCount, createApiLoss, mapIngredient, mapMovement, mapPurchase,
  getApiMutationRevision,
  startupErrorMessage,
  type ApiCountSelection,
  receiveApiPurchase, reverseApiPurchaseReceipt, reverseApiMovement, setApiPurchaseStatus, updateApiIngredient, updateApiSupplier,
  updateApiPurchase, toRole, logoutApiSession, setActiveApiTenant, SESSION_EXPIRED_EVENT, isApiConflict } from '../lib/api';
import type {
  AppState,
  AuditAction,
  AuditEntry,
  Cents,
  CountSession,
  InventoryItem,
  ItemCategory,
  LossReason,
  Movement,
  Purchase,
  PurchaseStatus,
  Recipe,
  Supplier,
  Unit,
} from '../domain/types';

interface ToastState {
  message: string;
  tone: 'ok' | 'error';
}

export interface NewItemInput {
  name: string;
  category: ItemCategory;
  unit: Unit;
  minQty: number;
  costCents: Cents;
  costKnown?: boolean;
  initialQty: number;
  supplierId: string | null;
  conversions?: Record<string, number>;
}

export interface ReceiveLineInput {
  lineId: string;
  qtyReceived: number;
  unitCostCents: Cents;
}

export interface NewPurchaseInput {
  supplierId: string;
  expectedDeliveryAt: string | null;
  note: string;
  lines: { itemId: string; qtyOrdered: number; expectedUnitCostCents: Cents; unit?: Unit }[];
}

interface AppContextValue {
  state: AppState;
  mode: 'demo' | 'production';
  ready: boolean;
  startupError: string | null;
  auditHasMore: boolean;
  auditLoading: boolean;
  toast: ToastState | null;
  can: (permission: Permission) => boolean;
  notify: (message: string, tone?: 'ok' | 'error') => void;
  actions: {
    setCurrentUserId: (id: string) => void;
    resetDemo: () => void;
    logout: () => Promise<void>;
    createItem: (input: NewItemInput) => string | null | Promise<string | null>;
    updateItem: (itemId: string, input: {
      name?: string; category?: ItemCategory; minQty?: number; costCents?: Cents; costKnown?: boolean;
      supplierId?: string | null; internalCode?: string | null; barcode?: string | null;
      notes?: string; active?: boolean; conversions?: Record<string, number>;
    }) => boolean | Promise<boolean>;
    recordMovement: (input: {
      itemId: string;
      kind: 'in' | 'out' | 'adjust';
      qty: number;
      reason: string;
    }) => boolean | Promise<boolean>;
    reverseMovement: (movementId: string, reason: string) => boolean | Promise<boolean>;
    registerLoss: (input: {
      itemId: string;
      qty: number;
      reason: LossReason;
      note: string;
    }) => boolean | Promise<boolean>;
    createSupplier: (input: Omit<Supplier, 'id' | 'restaurantId' | 'createdAt'>) => string | null | Promise<string | null>;
    updateSupplier: (supplierId: string, input: Omit<Supplier, 'id' | 'restaurantId' | 'createdAt'>) => boolean | Promise<boolean>;
    cacheSupplier: (supplier: Supplier) => void;
    cacheSuppliers: (suppliers: Supplier[]) => void;
    cacheIngredients: (ingredients: InventoryItem[]) => void;
    cacheRecipes: (recipes: Recipe[]) => void;
    cacheCount: (count: CountSession) => void;
    createCount: (itemIds: string[], selection?: ApiCountSelection) => string | null | Promise<string | null>;
    setCountQty: (countId: string, itemId: string, countedQty: number | null) => boolean | Promise<boolean>;
    approveCount: (countId: string) => boolean | Promise<boolean>;
    createPurchase: (input: NewPurchaseInput) => string | null | Promise<string | null>;
    cachePurchase: (purchase: Purchase) => void;
    updatePurchase: (purchaseId: string, input: NewPurchaseInput) => boolean | Promise<boolean>;
    createRecipe: (input: { name: string; salePriceCents: Cents; itemId: string; qty: number; unit: Unit; yieldPortions: number }) => string | null | Promise<string | null>;
    requestPurchase: (purchaseId: string, expectedVersion: number) => boolean | Promise<boolean>;
    cancelPurchase: (purchaseId: string, expectedVersion: number) => boolean | Promise<boolean>;
    receivePurchase: (purchaseId: string, receipts: ReceiveLineInput[]) => boolean | Promise<boolean>;
    reversePurchaseReceipt: (purchaseId: string, receiptId: string, reason: string) => boolean | Promise<boolean>;
    addRecipeIngredient: (recipeId: string, itemId: string, qty: number, unit: Unit) => boolean | Promise<boolean>;
    updateRecipeIngredient: (recipeId: string, itemId: string, qty: number) => boolean | Promise<boolean>;
    removeRecipeIngredient: (recipeId: string, itemId: string) => void | Promise<boolean>;
    updateRecipePrice: (recipeId: string, salePriceCents: Cents) => boolean | Promise<boolean>;
    updateRecipeYield: (recipeId: string, yieldPortions: number) => boolean | Promise<boolean>;
    setRecipeActive: (recipeId: string, active: boolean) => boolean | Promise<boolean>;
    simulateOrderDelivered: () => void;
    replayLastEvent: () => void;
    loadMoreAudit: () => Promise<void>;
  };
}

const AppContext = createContext<AppContextValue | null>(null);
const DASHBOARD_REFRESH_EVENT = 'dacot:dashboard-refresh';

function emptyState(): AppState {
  return {
    asOf: new Date().toISOString(),
    restaurant: { id: '', name: 'Restaurante', city: '' }, users: [], currentUserId: '',
    suppliers: [], supplierItems: [], items: [], purchases: [], recipes: [], recipeSnapshots: [],
    counts: [], losses: [], movements: [], pricePoints: [], audit: [], events: [], processedEventIds: [],
  };
}

const nowISO = () => APP_MODE === 'demo' ? NOW_ISO : new Date().toISOString();
const uid = (prefix: string) =>
  `${prefix}-${globalThis.crypto?.randomUUID?.()?.slice(0, 8) ?? Math.random().toString(36).slice(2, 10)}`;

function nextCode(existing: string[], prefix: string, base: number): string {
  const numbers = existing
    .map((code) => Number(code.replace(/\D/g, '')))
    .filter((n) => Number.isFinite(n));
  const next = Math.max(base, ...numbers) + 1;
  return `${prefix}-${String(next).padStart(4, '0')}`;
}

function auditEntry(
  state: AppState,
  action: AuditAction,
  entity: string,
  entityLabel: string,
  before: string | null,
  after: string | null,
  reason: string,
): AuditEntry {
  return {
    id: uid('au'),
    restaurantId: state.restaurant.id,
    userId: state.currentUserId,
    action,
    entity,
    entityLabel,
    before,
    after,
    reason,
    at: nowISO(),
  };
}

function mergeAuditEntries(...groups: AuditEntry[][]): AuditEntry[] {
  const unique = new Map<string, AuditEntry>();
  for (const entry of groups.flat()) unique.set(entry.id, entry);
  return [...unique.values()].sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime()
    || right.id.localeCompare(left.id));
}

function rememberCountVersion(versions: Map<string, number>, countId: string, version: number): number {
  const latest = Math.max(versions.get(countId) ?? 0, version);
  versions.set(countId, latest);
  return latest;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setStateRaw] = useState<AppState>(() => APP_MODE === 'demo' ? createDemoState() : emptyState());
  const cachedIngredientIdsRef = useRef<string[]>([]);
  const syncRequestRevisionRef = useRef(0);
  const sessionGenerationRef = useRef(0);
  const sessionLockedRef = useRef(APP_MODE === 'production');
  const setState: Dispatch<SetStateAction<AppState>> = useCallback((update) => {
    if (APP_MODE === 'production' && sessionLockedRef.current) return;
    const generation = sessionGenerationRef.current;
    setStateRaw((previous) => {
      if (APP_MODE === 'production'
          && (sessionLockedRef.current || generation !== sessionGenerationRef.current)) return previous;
      return typeof update === 'function' ? update(previous) : update;
    });
  }, []);
  const [ready, setReady] = useState(APP_MODE === 'demo');
  const [startupError, setStartupError] = useState<string | null>(null);
  const [auditPage, setAuditPage] = useState<{ tenant: string; cursor: string | null; hasMore: boolean; loading: boolean }>(
    { tenant: '', cursor: null, hasMore: false, loading: false },
  );
  const auditLoadingRef = useRef(false);
  const countVersionsRef = useRef(new Map<string, number>());
  const countVersionTenantRef = useRef('');
  const countWritesRef = useRef(new Map<string, Promise<boolean>>());
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const startupStarted = useRef(false);

  useEffect(() => {
    cachedIngredientIdsRef.current = state.items.map((item) => item.id);
  }, [state.items]);

  const clearLocalSession = useCallback(() => {
    sessionGenerationRef.current += 1;
    syncRequestRevisionRef.current += 1;
    sessionLockedRef.current = true;
    setReady(false);
    setActiveApiTenant(null);
    setStateRaw(emptyState());
    countVersionsRef.current.clear();
    countVersionTenantRef.current = '';
    countWritesRef.current.clear();
    setAuditPage({ tenant: '', cursor: null, hasMore: false, loading: false });
  }, []);

  const syncFromApi = useCallback(async (allowInitialSession = false) => {
    const generation = sessionGenerationRef.current;
    const requestRevision = ++syncRequestRevisionRef.current;
    const mutationRevision = getApiMutationRevision();
    if (APP_MODE === 'production' && sessionLockedRef.current && !allowInitialSession) return false;
    const snapshot = await loadRealState(cachedIngredientIdsRef.current);
    if (APP_MODE === 'production'
        && (generation !== sessionGenerationRef.current
          || requestRevision !== syncRequestRevisionRef.current
          || mutationRevision !== getApiMutationRevision()
          || (sessionLockedRef.current && !allowInitialSession))) return false;
    if (APP_MODE === 'production') setActiveApiTenant(snapshot.me.restaurant_id);
    if (APP_MODE === 'production') sessionLockedRef.current = false;
    const me = snapshot.me;
    const role = toRole(me.role);
    if (countVersionTenantRef.current !== me.restaurant_id) {
      countVersionsRef.current.clear();
      countVersionTenantRef.current = me.restaurant_id;
    }
    for (const count of snapshot.counts) {
      const version = count.version ?? 1;
      rememberCountVersion(countVersionsRef.current, count.id, version);
    }
    setState((previous) => {
      if (APP_MODE === 'production'
          && (generation !== sessionGenerationRef.current
            || requestRevision !== syncRequestRevisionRef.current
            || mutationRevision !== getApiMutationRevision()
            || sessionLockedRef.current)) return previous;
      const tenantChanged = previous.restaurant.id !== me.restaurant_id;
      const audit = tenantChanged ? snapshot.audit : mergeAuditEntries(snapshot.audit, previous.audit);
      const currentItems = tenantChanged ? []
        : previous.items.filter((item) => item.restaurantId === me.restaurant_id);
      const currentItemsById = new Map(currentItems.map((item) => [item.id, item]));
      const itemsById = new Map(snapshot.items.map((item) => [item.id,
        reconcileInventoryItem(currentItemsById.get(item.id), item)]));
      const items = [...itemsById.values(), ...currentItems.filter((item) => !itemsById.has(item.id))
        .map((item) => reconcileInventoryItem(item, item))];
      return ({
      ...previous,
      asOf: new Date().toISOString(),
      restaurant: { id: me.restaurant_id, name: me.restaurant_slug || 'Restaurante', city: '' },
      users: [{ id: me.user_id, restaurantId: me.restaurant_id, name: 'Usuário DACOT', role,
        initials: 'DC' }],
      currentUserId: me.user_id,
      items,
      suppliers: mergeVersionedRecords(tenantChanged ? [] : previous.suppliers, snapshot.suppliers),
      purchases: mergeVersionedRecords(tenantChanged ? [] : previous.purchases, snapshot.purchases),
      purchaseStatusCounts: snapshot.purchaseInsights.status_counts,
      purchaseMonthInsight: { orderCount: snapshot.purchaseInsights.month.order_count,
        expectedTotalCents: snapshot.purchaseInsights.month.expected_total_cents,
        receivedTotalCents: snapshot.purchaseInsights.month.received_total_cents,
        receivedUnpricedCount: snapshot.purchaseInsights.month.received_unpriced_count },
      supplierPurchaseInsights: Object.fromEntries(Object.entries(snapshot.purchaseInsights.suppliers)
        .map(([supplierId, insight]) => [supplierId, { orderCount: insight.order_count,
          recentReceivedValueCents: insight.recent_received_value_cents,
          lastReceiptAt: insight.last_receipt_at, lastReceiptCode: insight.last_receipt_code }])),
      supplierItems: snapshot.supplierItems,
      pricePoints: snapshot.pricePoints,
      movements: snapshot.movements,
      recipes: mergeVersionedRecords(tenantChanged ? [] : previous.recipes, snapshot.recipes),
      recipeSnapshots: tenantChanged ? snapshot.recipeSnapshots
        : snapshot.recipeSnapshots.length ? snapshot.recipeSnapshots : previous.recipeSnapshots,
      audit,
      counts: mergeVersionedRecords(tenantChanged ? [] : previous.counts, snapshot.counts),
      losses: snapshot.losses,
      });
    });
    setAuditPage((previous) => previous.tenant !== me.restaurant_id
      ? { tenant: me.restaurant_id, cursor: snapshot.auditCursor, hasMore: snapshot.auditHasMore, loading: false }
      : previous);
    window.dispatchEvent(new Event(DASHBOARD_REFRESH_EVENT));
    return generation === sessionGenerationRef.current;
  }, []);

  const refreshCountFromApi = useCallback(async (countId: string) => {
    const tenantId = state.restaurant.id;
    const generation = sessionGenerationRef.current;
    const count = await fetchApiCount(countId);
    if (count.restaurantId !== tenantId || generation !== sessionGenerationRef.current
        || sessionLockedRef.current) return null;
    const knownVersion = rememberCountVersion(countVersionsRef.current, count.id, count.version ?? 1);
    setState((previous) => {
      if (previous.restaurant.id !== tenantId || (count.version ?? 1) < knownVersion) return previous;
      const counts = upsertVersionedRecord(previous.counts, count);
      rememberCountVersion(countVersionsRef.current, count.id,
        counts.find((entry) => entry.id === count.id)?.version ?? 1);
      return { ...previous, counts };
    });
    return count;
  }, [state.restaurant.id]);

  useEffect(() => {
    if (APP_MODE !== 'production' || startupStarted.current) return;
    startupStarted.current = true;
    void (async () => {
      try {
        await exchangeHandoffFromUrl();
        await syncFromApi(true);
      } catch (error) {
        setStartupError((current) => current ?? startupErrorMessage(error));
      } finally {
        setReady(true);
      }
    })();
  }, [syncFromApi]);

  useEffect(() => {
    if (APP_MODE !== 'production') return;
    const timerId = window.setInterval(() => {
      setState((previous) => ({ ...previous, asOf: new Date().toISOString() }));
    }, 60_000);
    return () => window.clearInterval(timerId);
  }, []);

  useEffect(() => {
    if (APP_MODE !== 'production') return;
    let inFlight = false;
    let lastSyncAt = Date.now();
    const refreshVisibleSession = () => {
      if (document.visibilityState !== 'visible' || inFlight || Date.now() - lastSyncAt < 5_000) return;
      inFlight = true;
      lastSyncAt = Date.now();
      void syncFromApi().catch(() => undefined).finally(() => { inFlight = false; });
    };
    window.addEventListener('focus', refreshVisibleSession);
    document.addEventListener('visibilitychange', refreshVisibleSession);
    return () => {
      window.removeEventListener('focus', refreshVisibleSession);
      document.removeEventListener('visibilitychange', refreshVisibleSession);
    };
  }, [syncFromApi]);

  useEffect(() => {
    const onSessionExpired = (event: Event) => {
      clearLocalSession();
      const eventMessage = (event as CustomEvent<unknown>).detail;
      setStartupError(typeof eventMessage === 'string' ? eventMessage
        : 'A sessão expirou ou o acesso ao módulo foi revogado. Entre novamente pelo DACOT-HUB.');
      setReady(true);
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
  }, [clearLocalSession]);

  const notify = useCallback((message: string, tone: 'ok' | 'error' = 'ok') => {
    setToast({ message, tone });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  const currentUser = state.users.find((u) => u.id === state.currentUserId) ?? state.users[0];
  const can = useCallback(
    (permission: Permission) => roleCan(currentUser?.role ?? 'operator', permission),
    [currentUser?.role],
  );

  const actions = useMemo(() => {
    const require = (permission: Permission) => {
      if (!roleCan(currentUser?.role ?? 'operator', permission)) {
        notify('Seu perfil não tem permissão para esta ação.', 'error');
        return false;
      }
      return true;
    };

    const requireDemo = (permission: Permission) => {
      if (!require(permission)) return false;
      if (APP_MODE === 'production') {
        notify('Esta operação ainda não está conectada ao backend.', 'error');
        return false;
      }
      return true;
    };

    const refreshAfterMutation = async (successMessage: string) => {
      try {
        await syncFromApi();
        notify(successMessage);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'falha de conexão';
        notify(`${successMessage} A gravação foi concluída, mas a tela não atualizou (${detail}); recarregue para consultar os dados.`, 'error');
      }
    };

    const refreshAuditAfterServerMutation = async (successMessage: string) => {
      const tenantId = state.restaurant.id;
      const generation = sessionGenerationRef.current;
      window.dispatchEvent(new Event(DASHBOARD_REFRESH_EVENT));
      try {
        const page = await fetchApiAuditPage(null);
        if (generation !== sessionGenerationRef.current || sessionLockedRef.current) return;
        setState((previous) => previous.restaurant.id !== tenantId ? previous : ({
          ...previous, audit: mergeAuditEntries(page.items, previous.audit),
        }));
        setAuditPage({ tenant: tenantId, cursor: page.nextCursor, hasMore: page.hasMore, loading: false });
        notify(successMessage);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'falha de conexão';
        notify(`${successMessage} A alteração foi salva, mas a auditoria não atualizou (${detail}).`, 'error');
      }
    };

    const refreshPurchaseInsights = async () => {
      const tenantId = state.restaurant.id;
      const generation = sessionGenerationRef.current;
      try {
        const insights = await fetchApiPurchaseInsights();
        if (generation !== sessionGenerationRef.current || sessionLockedRef.current) return;
        setState((previous) => previous.restaurant.id !== tenantId ? previous : ({ ...previous,
          purchaseStatusCounts: insights.status_counts,
          purchaseMonthInsight: { orderCount: insights.month.order_count,
            expectedTotalCents: insights.month.expected_total_cents,
            receivedTotalCents: insights.month.received_total_cents,
            receivedUnpricedCount: insights.month.received_unpriced_count },
          supplierPurchaseInsights: Object.fromEntries(Object.entries(insights.suppliers)
            .map(([supplierId, insight]) => [supplierId, { orderCount: insight.order_count,
              recentReceivedValueCents: insight.recent_received_value_cents,
              lastReceiptAt: insight.last_receipt_at, lastReceiptCode: insight.last_receipt_code }])),
        }));
      } catch (error) {
        notify(error instanceof Error ? `A compra foi salva, mas os indicadores não atualizaram (${error.message}).`
          : 'A compra foi salva, mas os indicadores não atualizaram.', 'error');
      }
    };

    const refreshAfterConflict = async (entity: string, purchaseId?: string) => {
      try {
        if (purchaseId) {
          const tenantId = state.restaurant.id;
          const generation = sessionGenerationRef.current;
          const purchase = await fetchApiPurchase(purchaseId);
          if (purchase.restaurantId !== tenantId || generation !== sessionGenerationRef.current
              || sessionLockedRef.current) return;
          setState((previous) => previous.restaurant.id !== tenantId ? previous : ({ ...previous,
            purchases: upsertVersionedRecord(previous.purchases, purchase),
          }));
          await refreshPurchaseInsights();
        } else {
          await syncFromApi();
        }
        notify(`Os dados de ${entity} mudaram em outra sessão. A tela foi atualizada; confira e tente novamente.`, 'error');
      } catch {
        notify(`Os dados de ${entity} mudaram em outra sessão e não foi possível atualizar a tela. Recarregue antes de tentar novamente.`, 'error');
      }
    };

    const refreshSupplierAfterConflict = async (supplierId: string) => {
      const tenantId = state.restaurant.id;
      const generation = sessionGenerationRef.current;
      try {
        const supplier = await fetchApiSupplier(supplierId);
        if (supplier.restaurantId !== tenantId || generation !== sessionGenerationRef.current
            || sessionLockedRef.current) return;
        setState((previous) => previous.restaurant.id !== tenantId ? previous : ({
          ...previous, suppliers: upsertVersionedRecord(previous.suppliers, supplier),
        }));
        notify('Os dados do fornecedor mudaram em outra sessão. O cadastro foi atualizado; confira e tente novamente.', 'error');
      } catch {
        notify('Os dados do fornecedor mudaram em outra sessão e não foi possível atualizá-los. Recarregue antes de tentar novamente.', 'error');
      }
    };

    const applySavedRecipe = async (saved: Recipe, successMessage: string, refreshSnapshots: boolean,
      tenantId: string, generation: number) => {
      if (saved.restaurantId !== tenantId) {
        notify('A API retornou uma ficha de outro restaurante; a tela foi preservada.', 'error');
        return;
      }
      let snapshots: Awaited<ReturnType<typeof fetchApiRecipeSnapshotPage>>['snapshots'] | null = null;
      let snapshotError: unknown = null;
      if (refreshSnapshots) {
        try {
          snapshots = (await fetchApiRecipeSnapshotPage(saved.id)).snapshots;
        } catch (error) {
          snapshotError = error;
        }
      }
      if (generation !== sessionGenerationRef.current || sessionLockedRef.current) return;
      setState((previous) => previous.restaurant.id !== tenantId ? previous : ({
        ...previous,
        recipes: upsertVersionedRecord(previous.recipes, saved),
        ...(snapshots ? { recipeSnapshots: [...previous.recipeSnapshots
          .filter((snapshot) => snapshot.recipeId !== saved.id), ...snapshots]
          .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime()) } : {}),
      }));
      try {
        const page = await fetchApiAuditPage(null);
        if (generation === sessionGenerationRef.current && !sessionLockedRef.current) {
          setState((previous) => previous.restaurant.id !== tenantId ? previous : ({
            ...previous, audit: mergeAuditEntries(page.items, previous.audit),
          }));
          setAuditPage({ tenant: tenantId, cursor: page.nextCursor, hasMore: page.hasMore, loading: false });
        }
      } catch {
        // Recipe changes are already reflected locally; audit can be refreshed on the next visit.
      }
      if (snapshotError) {
        const detail = snapshotError instanceof Error ? snapshotError.message : 'falha de conexão';
        notify(`${successMessage} A ficha foi salva, mas o histórico de custos não atualizou (${detail}).`, 'error');
      } else {
        notify(successMessage);
      }
    };

    const persistRecipe = async (recipe: Recipe, expectedVersion: number): Promise<boolean> => {
      const tenantId = state.restaurant.id;
      const generation = sessionGenerationRef.current;
      try {
        const saved = await saveApiRecipe(recipe, expectedVersion);
        await applySavedRecipe(saved, 'Ficha técnica atualizada e salva.', true, tenantId, generation);
      } catch (error) {
        if (isApiConflict(error)) {
          await refreshAfterConflict('ficha técnica');
          return false;
        }
        notify(error instanceof Error ? error.message : 'Falha ao salvar ficha técnica.', 'error');
        return false;
      }
      return true;
    };

    const applyPurchaseStockMutation = async (result: Awaited<ReturnType<typeof receiveApiPurchase>>,
      successMessage: string, tenantId: string, generation: number) => {
      if (result.purchase.restaurantId !== tenantId || generation !== sessionGenerationRef.current
          || sessionLockedRef.current) return;
      if ([...result.items, ...result.movements, ...result.recipes, ...result.recipeSnapshots]
        .some((record) => record.restaurantId !== tenantId)) {
        notify('A API retornou registros de outro restaurante; a tela foi preservada.', 'error');
        return;
      }
      const cachedSupplierIds = new Set(state.suppliers
        .filter((supplier) => supplier.restaurantId === tenantId).map((supplier) => supplier.id));
      const missingSupplierIds = [...new Set(result.movements
        .map((movement) => movement.supplierId)
        .filter((supplierId): supplierId is string => !!supplierId && !cachedSupplierIds.has(supplierId)))];
      let fetchedSuppliers: Supplier[] = [];
      let supplierLookupFailed = false;
      if (missingSupplierIds.length) {
        try {
          fetchedSuppliers = (await fetchApiSuppliersByIds(missingSupplierIds))
            .filter((supplier) => supplier.restaurantId === tenantId);
        } catch {
          supplierLookupFailed = true;
        }
      }
      setState((previous) => {
        if (previous.restaurant.id !== tenantId) return previous;
        const itemById = new Map(previous.items.map((item) => [item.id, item]));
        result.items.forEach((item) => {
          itemById.set(item.id, reconcileInventoryItem(itemById.get(item.id), item));
        });
        const movementById = new Map(previous.movements.map((movement) => [movement.id, movement]));
        result.movements.forEach((movement) => movementById.set(movement.id, movement));
        const recipeById = new Map(previous.recipes.map((recipe) => [recipe.id, recipe]));
        result.recipes.forEach((recipe) => recipeById.set(recipe.id,
          preferVersionedRecord(recipeById.get(recipe.id), recipe)));
        const snapshotById = new Map(previous.recipeSnapshots.map((snapshot) => [snapshot.id, snapshot]));
        result.recipeSnapshots.forEach((snapshot) => snapshotById.set(snapshot.id, snapshot));
        const movements = [...movementById.values()].sort((left, right) =>
          new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());
        const recipeSnapshots = [...snapshotById.values()].sort((left, right) =>
          new Date(right.at).getTime() - new Date(left.at).getTime());
        const supplierById = new Map(previous.suppliers.map((supplier) => [supplier.id, supplier]));
        fetchedSuppliers.forEach((supplier) => supplierById.set(supplier.id,
          preferVersionedRecord(supplierById.get(supplier.id), supplier)));
        const suppliers = [...supplierById.values()];
        const prices = purchasePriceHistory(movements, suppliers);
        const previousItemIds = new Set(previous.items.map((item) => item.id));
        return { ...previous,
          items: [...previous.items.map((item) => itemById.get(item.id) ?? item),
            ...result.items.filter((item) => !previousItemIds.has(item.id))],
          suppliers,
          purchases: upsertVersionedRecord(previous.purchases, result.purchase),
          movements, recipes: [...recipeById.values()], recipeSnapshots,
          pricePoints: prices.pricePoints, supplierItems: prices.supplierItems,
        };
      });
      await refreshPurchaseInsights();
      await refreshAuditAfterServerMutation(successMessage);
      if (supplierLookupFailed) {
        notify('O recebimento foi salvo, mas não foi possível atualizar o histórico de preços do fornecedor. Recarregue para conferir.', 'error');
      }
    };

    return {
      logout: async () => {
        if (APP_MODE === 'demo') {
          notify('A demonstração não possui uma sessão para encerrar.');
          return;
        }
        clearLocalSession();
        try {
          await logoutApiSession();
          setStartupError('Sessão encerrada. Para acessar novamente, entre pelo DACOT-HUB.');
          setReady(true);
        } catch (error) {
          setStartupError('Não foi possível confirmar o encerramento da sessão. Tente novamente ou volte ao DACOT-HUB.');
          setReady(true);
          notify(error instanceof Error ? error.message : 'Falha ao encerrar a sessão.', 'error');
        }
      },

      setCurrentUserId: (id: string) => {
        if (APP_MODE === 'demo') setState((prev) => ({ ...prev, currentUserId: id }));
      },

      cacheSupplier: (supplier: Supplier) => {
        if (APP_MODE !== 'production' || supplier.restaurantId !== state.restaurant.id) return;
        setState((previous) => {
          if (previous.restaurant.id !== supplier.restaurantId) return previous;
          const current = previous.suppliers.find((entry) => entry.id === supplier.id);
          const latest = preferVersionedRecord(current, supplier);
          return { ...previous, suppliers: [latest,
            ...previous.suppliers.filter((entry) => entry.id !== supplier.id)] };
        });
      },

      cacheSuppliers: (suppliers: Supplier[]) => {
        if (APP_MODE !== 'production' || suppliers.some((supplier) => supplier.restaurantId !== state.restaurant.id)) return;
        setState((previous) => {
          if (previous.restaurant.id !== state.restaurant.id) return previous;
          const byId = new Map(previous.suppliers.map((supplier) => [supplier.id, supplier]));
          suppliers.forEach((supplier) => byId.set(supplier.id,
            preferVersionedRecord(byId.get(supplier.id), supplier)));
          return { ...previous, suppliers: [...byId.values()] };
        });
      },

      cacheIngredients: (ingredients: InventoryItem[]) => {
        if (APP_MODE !== 'production' || ingredients.some((item) => item.restaurantId !== state.restaurant.id)) return;
        setState((previous) => {
          if (previous.restaurant.id !== state.restaurant.id) return previous;
          const byId = new Map(previous.items.map((item) => [item.id, item]));
          ingredients.forEach((item) => byId.set(item.id, reconcileInventoryItem(byId.get(item.id), item)));
          return { ...previous, items: [...byId.values()] };
        });
      },

      cacheRecipes: (recipes: Recipe[]) => {
        if (APP_MODE !== 'production' || recipes.some((recipe) => recipe.restaurantId !== state.restaurant.id)) return;
        setState((previous) => {
          if (previous.restaurant.id !== state.restaurant.id) return previous;
          const byId = new Map(previous.recipes.map((recipe) => [recipe.id, recipe]));
          recipes.forEach((recipe) => byId.set(recipe.id,
            preferVersionedRecord(byId.get(recipe.id), recipe)));
          return { ...previous, recipes: [...byId.values()] };
        });
      },

      cacheCount: (count: CountSession) => {
        if (APP_MODE !== 'production' || count.restaurantId !== state.restaurant.id) return;
        setState((previous) => {
          if (previous.restaurant.id !== count.restaurantId) return previous;
          const current = previous.counts.find((entry) => entry.id === count.id);
          const knownVersion = countVersionsRef.current.get(count.id);
          if (knownVersion != null && (count.version ?? 1) < knownVersion) return previous;
          const latest = preferVersionedRecord(current, count);
          countVersionsRef.current.set(count.id, Math.max(knownVersion ?? 0, latest.version ?? 1));
          return { ...previous, counts: [latest,
            ...previous.counts.filter((entry) => entry.id !== count.id)] };
        });
      },

      cachePurchase: (purchase: Purchase) => {
        if (APP_MODE !== 'production' || purchase.restaurantId !== state.restaurant.id) return;
        setState((previous) => {
          if (previous.restaurant.id !== purchase.restaurantId) return previous;
          const current = previous.purchases.find((entry) => entry.id === purchase.id);
          const latest = preferVersionedRecord(current, purchase);
          return { ...previous, purchases: [latest,
            ...previous.purchases.filter((entry) => entry.id !== purchase.id)] };
        });
      },

      resetDemo: () => {
        if (APP_MODE === 'demo') {
          setState(createDemoState());
          notify('Dados de demonstração restaurados.');
        }
      },

      createItem: (input: NewItemInput) => {
        if (!require('stock.create')) return null;
        if (APP_MODE === 'production') {
          return createApiIngredient(input).then(async (created) => {
            const ingredient = mapIngredient(created);
            let initialMovements: Movement[] = [];
            let historyRefreshFailed = false;
            if (input.initialQty > 0) {
              try {
                const page = await fetchApiIngredientMovementPage(ingredient.id, 0);
                initialMovements = page.movements;
              } catch {
                historyRefreshFailed = true;
              }
            }
            setState((previous) => {
              if (previous.restaurant.id !== ingredient.restaurantId) return previous;
              const exists = previous.items.some((item) => item.id === ingredient.id);
              const movementsById = new Map(previous.movements.map((movement) => [movement.id, movement]));
              initialMovements.forEach((movement) => movementsById.set(movement.id, movement));
              return {
                ...previous,
                items: exists
                  ? previous.items.map((item) => item.id === ingredient.id
                    ? reconcileInventoryItem(item, ingredient) : item)
                  : [...previous.items, ingredient],
                movements: [...movementsById.values()],
              };
            });
            await refreshAuditAfterServerMutation(`${created.name} cadastrado no estoque.`);
            if (historyRefreshFailed) {
              notify('O insumo e o saldo inicial foram salvos, mas o histórico não atualizou. Recarregue o cadastro para conferir.', 'error');
            }
            return created._id;
          }).catch((error: unknown) => {
            notify(error instanceof Error ? error.message : 'Falha ao cadastrar insumo.', 'error');
            return null;
          });
        }
        const name = input.name.trim();
        if (!name) {
          notify('Informe o nome do insumo.', 'error');
          return null;
        }
        if (state.items.some((i) => i.name.toLowerCase() === name.toLowerCase())) {
          notify('Já existe um insumo com esse nome.', 'error');
          return null;
        }
        const at = nowISO();
        const id = uid('it');
        const item: InventoryItem = {
          id,
          restaurantId: state.restaurant.id,
          name,
          category: input.category,
          unit: input.unit,
          currentQty: input.initialQty,
          minQty: input.minQty,
          costCents: input.costCents, costKnown: input.costKnown ?? input.costCents > 0,
          conversions: input.conversions ?? {},
          primarySupplierId: input.supplierId,
          updatedAt: at,
          version: 1,
        };
        const movements =
          input.initialQty > 0
            ? [
                ...state.movements,
                {
                  id: uid('mv'),
                  restaurantId: state.restaurant.id,
                  itemId: id,
                  type: 'MANUAL_IN' as const,
                  direction: 'in' as const,
                  qty: input.initialQty,
                  unit: input.unit,
                  unitCostCents: input.costCents,
                  occurredAt: at,
                  reason: 'Saldo inicial de cadastro',
                  origin: 'Cadastro de insumo',
                  userId: state.currentUserId,
                  balanceAfter: input.initialQty,
                },
              ]
            : state.movements;
        setState({
          ...state,
          items: [...state.items, item],
          movements,
          supplierItems: input.supplierId
            ? [
                ...state.supplierItems,
                {
                  id: uid('si'),
                  restaurantId: state.restaurant.id,
                  supplierId: input.supplierId,
                  itemId: id,
                  lastPriceCents: input.costCents,
                  lastPurchaseAt: null,
                  leadTimeDays:
                    state.suppliers.find((s) => s.id === input.supplierId)?.avgLeadTimeDays ?? 2,
                  minOrderCents:
                    state.suppliers.find((s) => s.id === input.supplierId)?.minOrderCents ?? 0,
                },
              ]
            : state.supplierItems,
          audit: [
            auditEntry(
              state,
              'stock.adjust',
              'item',
              name,
              null,
              `${fmtQty(input.initialQty, input.unit)} · ${money(input.costCents)}/${input.unit}`,
              'Cadastro de insumo',
            ),
            ...state.audit,
          ],
        });
        notify(`${name} cadastrado no estoque.`);
        return id;
      },

      updateItem: (itemId: string, input: {
        name?: string; category?: ItemCategory; minQty?: number; costCents?: Cents; costKnown?: boolean;
        supplierId?: string | null; internalCode?: string | null; barcode?: string | null;
        notes?: string; active?: boolean; conversions?: Record<string, number>;
      }) => {
        if (!require('stock.create')) return false;
        const current = state.items.find((item) => item.id === itemId);
        if (!current) return false;
        if (APP_MODE === 'production') {
          return updateApiIngredient(itemId, current.version ?? 1, input).then(async (updated) => {
            const recipeDependenciesChanged = ((input.costCents !== undefined
                && input.costCents !== current.costCents)
                || (input.costKnown !== undefined && input.costKnown !== current.costKnown))
              || (input.conversions !== undefined
                && JSON.stringify(input.conversions) !== JSON.stringify(current.conversions));
            let changedRecipes: Recipe[] | null = null;
            let recipeRefreshFailed = false;
            if (recipeDependenciesChanged) {
              try {
                changedRecipes = await fetchApiRecipesUsingIngredient(itemId);
              } catch {
                recipeRefreshFailed = true;
              }
            }
            setState((previous) => {
              if (previous.restaurant.id !== updated.restaurantId) return previous;
              const recipeById = new Map(previous.recipes.map((recipe) => [recipe.id, recipe]));
              changedRecipes?.forEach((recipe) => recipeById.set(recipe.id,
                preferVersionedRecord(recipeById.get(recipe.id), recipe)));
              return {
                ...previous,
                items: previous.items.map((item) => item.id === updated.id
                  ? reconcileInventoryItem(item, updated) : item),
                ...(changedRecipes ? { recipes: [...recipeById.values()] } : {}),
              };
            });
            await refreshAuditAfterServerMutation(`${updated.name} atualizado.`);
            if (recipeRefreshFailed) {
              notify('O insumo foi atualizado, mas as fichas relacionadas não puderam ser atualizadas. Recarregue antes de consultar custos.', 'error');
            }
            return true;
          }).catch(async (error: unknown) => {
            if (isApiConflict(error)) await refreshAfterConflict('insumo');
            else notify(error instanceof Error ? error.message : 'Falha ao atualizar insumo.', 'error');
            return false;
          });
        }
        const name = input.name?.trim() || current.name;
        if (state.items.some((item) => item.id !== itemId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
          notify('Já existe um insumo com esse nome.', 'error');
          return false;
        }
        const updated: InventoryItem = {
          ...current, name, category: input.category ?? current.category,
          minQty: input.minQty ?? current.minQty, costCents: input.costCents ?? current.costCents,
          costKnown: input.costKnown ?? current.costKnown ?? current.costCents > 0,
          primarySupplierId: input.supplierId === undefined ? current.primarySupplierId : input.supplierId,
          internalCode: input.internalCode === undefined ? current.internalCode : input.internalCode,
          barcode: input.barcode === undefined ? current.barcode : input.barcode,
          notes: input.notes ?? current.notes, active: input.active ?? current.active,
          conversions: input.conversions ?? current.conversions,
          updatedAt: nowISO(),
          version: (current.version ?? 1) + 1,
        };
        setState((previous) => ({ ...previous, items: previous.items.map((item) => item.id === itemId ? updated : item),
          audit: [auditEntry(state, 'ingredient.update', 'item', name, current.name, name,
            input.active === false ? 'Insumo desativado' : input.active === true ? 'Insumo reativado' : 'Cadastro atualizado'),
          ...previous.audit],
        }));
        notify(`${name} atualizado.`);
        return true;
      },

      recordMovement: (input: {
        itemId: string;
        kind: 'in' | 'out' | 'adjust';
        qty: number;
        reason: string;
      }) => {
        if (!require('stock.adjust')) return false;
        const item = state.items.find((i) => i.id === input.itemId);
        if (!item) return false;
        if (APP_MODE === 'production') {
          if (!input.reason.trim()) {
            notify('Descreva o motivo da movimentação.', 'error');
            return false;
          }
          if (!Number.isFinite(input.qty) || input.qty < 0
              || (input.kind !== 'adjust' && input.qty <= 0)
              || (input.kind === 'adjust' && Math.abs(input.qty - item.currentQty) < 0.0001)) {
            notify('Informe uma quantidade válida.', 'error');
            return false;
          }
          return recordApiMovement({ ...input, currentQty: item.currentQty }).then(async (result) => {
            const movement = mapMovement(result);
            setState((previous) => ({
              ...previous,
              items: previous.restaurant.id !== movement.restaurantId ? previous.items
                : previous.items.map((entry) => entry.id === item.id
                && isStockSnapshotCurrent(movement.stockVersionAfter, entry.stockVersion,
                  movement.occurredAt, entry.updatedAt)
                ? reconcileInventoryItem(entry, { ...entry, currentQty: movement.balanceAfter,
                    updatedAt: movement.occurredAt, stockVersion: movement.stockVersionAfter })
                : entry),
              movements: previous.restaurant.id !== movement.restaurantId ? previous.movements
                : previous.movements.some((entry) => entry.id === movement.id)
                ? previous.movements : [...previous.movements, movement],
            }));
            await refreshAuditAfterServerMutation(`Estoque de ${item.name} atualizado.`);
            return true;
          }).catch((error: unknown) => {
            notify(error instanceof Error ? error.message : 'Falha ao movimentar estoque.', 'error');
            return false;
          });
        }
        if (!Number.isFinite(input.qty) || input.qty < 0) {
          notify('Informe uma quantidade válida.', 'error');
          return false;
        }
        if (!input.reason.trim()) {
          notify('Descreva o motivo da movimentação.', 'error');
          return false;
        }

        let delta: number;
        let type: Movement['type'];
        if (input.kind === 'adjust') {
          delta = input.qty - item.currentQty;
          type = 'ADJUSTMENT';
          if (Math.abs(delta) < 0.0001) {
            notify('O saldo informado é igual ao estoque atual.', 'error');
            return false;
          }
        } else {
          if (input.qty <= 0) {
            notify('Informe uma quantidade maior que zero.', 'error');
            return false;
          }
          if (input.kind === 'out' && input.qty > item.currentQty + 0.0001) {
            notify('A saída é maior que o estoque disponível.', 'error');
            return false;
          }
          delta = input.kind === 'in' ? input.qty : -input.qty;
          type = input.kind === 'in' ? 'MANUAL_IN' : 'MANUAL_OUT';
        }

        const nextQty = Math.round((item.currentQty + delta) * 1000) / 1000;
        const at = nowISO();
        const movement: Movement = {
          id: uid('mv'),
          restaurantId: state.restaurant.id,
          itemId: item.id,
          type,
          direction: delta > 0 ? 'in' : 'out',
          qty: Math.abs(delta),
          unit: item.unit,
          unitCostCents: item.costCents,
          occurredAt: at,
          reason: input.reason.trim(),
          origin:
            input.kind === 'adjust' ? 'Ajuste manual de saldo' : 'Movimentação manual',
          userId: state.currentUserId,
          balanceAfter: nextQty,
        };

        setState({
          ...state,
          items: state.items.map((i) =>
            i.id === item.id ? { ...i, currentQty: nextQty, updatedAt: at } : i,
          ),
          movements: [...state.movements, movement],
          audit: [
            auditEntry(
              state,
              'stock.adjust',
              'item',
              item.name,
              fmtQty(item.currentQty, item.unit),
              fmtQty(nextQty, item.unit),
              input.reason.trim(),
            ),
            ...state.audit,
          ],
        });
        notify(
          `Estoque de ${item.name} ajustado para ${fmtQty(nextQty, item.unit)}.`,
        );
        return true;
      },

      reverseMovement: (movementId: string, reason: string) => {
        if (!require('stock.adjust')) return false;
        const original = state.movements.find((movement) => movement.id === movementId);
        if (!original || !reason.trim()) {
          notify(!reason.trim() ? 'Informe o motivo do estorno.' : 'Movimentação não encontrada.', 'error');
          return false;
        }
        const item = state.items.find((entry) => entry.id === original.itemId);
        if (!item || original.reversedByMovementId) {
          notify('Esta movimentação não pode ser estornada.', 'error');
          return false;
        }
        if (APP_MODE === 'production') {
          if (!original.canReverse) {
            notify('Somente ajustes manuais podem ser estornados por este fluxo.', 'error');
            return false;
          }
          return reverseApiMovement(movementId, reason.trim()).then(async (result) => {
            const reversal = mapMovement(result);
            setState((previous) => {
              if (previous.restaurant.id !== reversal.restaurantId) return previous;
              const reconciled = previous.movements.map((movement) => movement.id === movementId
                ? { ...movement, reversedByMovementId: reversal.id } : movement);
              return {
                ...previous,
                items: previous.items.map((entry) => entry.id === item.id
                  && isStockSnapshotCurrent(reversal.stockVersionAfter, entry.stockVersion,
                    reversal.occurredAt, entry.updatedAt)
                  ? reconcileInventoryItem(entry, { ...entry, currentQty: reversal.balanceAfter,
                      updatedAt: reversal.occurredAt, stockVersion: reversal.stockVersionAfter })
                  : entry),
                movements: reconciled.some((movement) => movement.id === reversal.id)
                  ? reconciled : [...reconciled, reversal],
              };
            });
            await refreshAuditAfterServerMutation(`Estorno de ${item.name} registrado.`);
            return true;
          }).catch((error: unknown) => {
            notify(error instanceof Error ? error.message : 'Falha ao estornar a movimentação.', 'error');
            return false;
          });
        }
        if (!['ADJUSTMENT', 'MANUAL_IN', 'MANUAL_OUT'].includes(original.type)
            || original.origin.toLowerCase().includes('contagem')) {
          notify('Somente ajustes manuais podem ser estornados por este fluxo.', 'error');
          return false;
        }
        const sign = original.direction === 'in' ? -1 : 1;
        const nextQty = Math.round((item.currentQty + sign * original.qty) * 1000) / 1000;
        if (nextQty < 0) {
          notify('O saldo disponível é insuficiente para estornar esta entrada.', 'error');
          return false;
        }
        const at = nowISO();
        const reversal: Movement = { id: uid('mv'), restaurantId: item.restaurantId, itemId: item.id,
          type: 'ADJUSTMENT', direction: sign > 0 ? 'in' : 'out', qty: original.qty, unit: item.unit,
          unitCostCents: original.unitCostCents, occurredAt: at,
          reason: `Estorno de ${movementId}: ${reason.trim()}`, origin: 'Estorno compensatório',
          userId: state.currentUserId, balanceAfter: nextQty };
        setState((previous) => ({ ...previous,
          items: previous.items.map((entry) => entry.id === item.id
            ? { ...entry, currentQty: nextQty, updatedAt: at } : entry),
          movements: previous.movements.map((movement) => movement.id === movementId
            ? { ...movement, reversedByMovementId: reversal.id } : movement).concat(reversal),
          audit: [auditEntry(previous, 'stock.adjust', 'item', item.name,
            fmtQty(item.currentQty, item.unit), fmtQty(nextQty, item.unit), `Estorno: ${reason.trim()}`),
          ...previous.audit],
        }));
        notify(`Estorno de ${item.name} registrado.`);
        return true;
      },

      registerLoss: (input: {
        itemId: string;
        qty: number;
        reason: LossReason;
        note: string;
      }) => {
        if (!require('losses.manage')) return false;
        const item = state.items.find((i) => i.id === input.itemId);
        if (!item) {
          notify('O insumo ainda não foi carregado. Atualize a busca e tente novamente.', 'error');
          return false;
        }
        if (item.active === false) {
          notify('Não é possível registrar perdas para um insumo inativo.', 'error');
          return false;
        }
        if (APP_MODE === 'production') {
          if (!Number.isFinite(input.qty) || input.qty <= 0 || !input.reason) {
            notify('Informe uma quantidade e um motivo válidos para a perda.', 'error');
            return false;
          }
          return createApiLoss(input).then(async ({ loss, movement }) => {
            if (!movement) {
              await refreshAfterMutation(`Perda de ${item.name} registrada.`);
              return true;
            }
            setState((previous) => {
              if (previous.restaurant.id !== loss.restaurantId) return previous;
              const movements = previous.movements.some((entry) => entry.id === movement.id)
                ? previous.movements : [...previous.movements, movement];
              return {
                ...previous,
                items: previous.items.map((entry) => entry.id === item.id
                  && isStockSnapshotCurrent(movement.stockVersionAfter, entry.stockVersion,
                    movement.occurredAt, entry.updatedAt)
                  ? reconcileInventoryItem(entry, { ...entry, currentQty: movement.balanceAfter,
                      updatedAt: movement.occurredAt, stockVersion: movement.stockVersionAfter })
                  : entry),
                losses: previous.losses.some((entry) => entry.id === loss.id)
                  ? previous.losses : [loss, ...previous.losses],
                movements,
              };
            });
            await refreshAuditAfterServerMutation(`Perda de ${item.name} registrada.`);
            return true;
          }).catch((error: unknown) => {
            notify(error instanceof Error ? error.message : 'Falha ao registrar perda.', 'error');
            return false;
          });
        }
        if (!Number.isFinite(input.qty) || input.qty <= 0) {
          notify('Informe uma quantidade válida para a perda.', 'error');
          return false;
        }
        if (input.qty > item.currentQty + 0.0001) {
          notify('A perda é maior que o estoque disponível.', 'error');
          return false;
        }
        const at = nowISO();
        const valueCents = itemCostKnown(item) ? Math.round(input.qty * item.costCents) : null;
        const nextQty = Math.round((item.currentQty - input.qty) * 1000) / 1000;
        const lossId = uid('ls');
        setState({
          ...state,
          items: state.items.map((i) =>
            i.id === item.id ? { ...i, currentQty: nextQty, updatedAt: at } : i,
          ),
          losses: [
            {
              id: lossId,
              restaurantId: state.restaurant.id,
              itemId: item.id,
              qty: input.qty,
              reason: input.reason,
              note: input.note.trim(),
              valueCents,
              at,
              userId: state.currentUserId,
            },
            ...state.losses,
          ],
          movements: [
            ...state.movements,
            {
              id: uid('mv'),
              restaurantId: state.restaurant.id,
              itemId: item.id,
              type: 'LOSS',
              direction: 'out',
              qty: input.qty,
              unit: item.unit,
              unitCostCents: itemCostKnown(item) ? item.costCents : null,
              occurredAt: at,
              reason: input.reason,
              origin: 'Registro de perda',
              userId: state.currentUserId,
              balanceAfter: nextQty,
            },
          ],
          audit: [
            auditEntry(
              state,
              'loss.register',
              'loss',
              `${item.name} · ${fmtQty(input.qty, item.unit)}`,
              null,
              valueCents == null ? 'Custo não cadastrado' : money(valueCents),
              input.reason,
            ),
            ...state.audit,
          ],
        });
        notify(`Perda de ${item.name} registrada${valueCents == null ? ' sem custo cadastrado' : `: ${money(valueCents)}`}.`);
        return true;
      },

      createSupplier: (input: Omit<Supplier, 'id' | 'restaurantId' | 'createdAt'>) => {
        if (!require('suppliers.manage')) return null;
        if (APP_MODE === 'production') {
          return createApiSupplier(input).then((created) => {
            setState((previous) => {
              if (previous.restaurant.id !== created.restaurantId) return previous;
              return { ...previous, suppliers: upsertVersionedRecord(previous.suppliers, created) };
            });
            notify(`${created.name} cadastrado.`);
            return created.id;
          }).catch((error: unknown) => {
            notify(error instanceof Error ? error.message : 'Falha ao cadastrar fornecedor.', 'error');
            return null;
          });
        }
        if (!input.name.trim()) {
          notify('Informe o nome do fornecedor.', 'error');
          return null;
        }
        const id = uid('sup');
        const supplier: Supplier = {
          ...input,
          id,
          restaurantId: state.restaurant.id,
          createdAt: nowISO(),
          version: 1,
        };
        setState({
          ...state,
          suppliers: [...state.suppliers, supplier],
          audit: [
            auditEntry(state, 'supplier.create', 'supplier', supplier.name, null, null, 'Cadastro de fornecedor'),
            ...state.audit,
          ],
        });
        notify(`${supplier.name} cadastrado.`);
        return id;
      },

      updateSupplier: (supplierId: string, input: Omit<Supplier, 'id' | 'restaurantId' | 'createdAt'>) => {
        if (!require('suppliers.manage')) return false;
        const current = state.suppliers.find((supplier) => supplier.id === supplierId);
        if (!current) return false;
        const name = input.name.trim();
        if (!name) {
          notify('Informe o nome do fornecedor.', 'error');
          return false;
        }
        if (APP_MODE === 'production') {
          return updateApiSupplier(supplierId, current.version ?? 1, { ...input, name }).then((updated) => {
            setState((previous) => ({ ...previous,
              suppliers: previous.restaurant.id !== updated.restaurantId ? previous.suppliers
                : upsertVersionedRecord(previous.suppliers, updated),
            }));
            notify(`${updated.name} atualizado.`);
            return true;
          }).catch(async (error: unknown) => {
            if (isApiConflict(error)) await refreshSupplierAfterConflict(supplierId);
            else notify(error instanceof Error ? error.message : 'Falha ao atualizar fornecedor.', 'error');
            return false;
          });
        }
        if (state.suppliers.some((supplier) => supplier.id !== supplierId && supplier.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
          notify('Já existe um fornecedor com esse nome.', 'error');
          return false;
        }
        const updated = { ...current, ...input, name, version: (current.version ?? 1) + 1 };
        setState((previous) => ({ ...previous,
          suppliers: previous.suppliers.map((supplier) => supplier.id === supplierId ? updated : supplier),
          audit: [auditEntry(state, 'supplier.update', 'supplier', name, current.name, name,
            input.active === false ? 'Fornecedor desativado' : input.active === true ? 'Fornecedor reativado' : 'Cadastro atualizado'),
          ...previous.audit],
        }));
        notify(`${name} atualizado.`);
        return true;
      },

      createCount: (itemIds: string[], selection?: ApiCountSelection) => {
        if (!require('count.perform')) return null;
        if (itemIds.length === 0 && (APP_MODE !== 'production' || !selection)) {
          notify('Selecione ao menos um item para contar.', 'error');
          return null;
        }
        if (APP_MODE === 'production') {
          return createApiCount(itemIds, selection).then(async (created) => {
            countVersionsRef.current.set(created.id, created.version ?? 1);
            setState((previous) => {
              if (previous.restaurant.id !== created.restaurantId) return previous;
              const exists = previous.counts.some((count) => count.id === created.id);
              return { ...previous, counts: exists
                ? previous.counts.map((count) => count.id === created.id ? created : count)
                : [created, ...previous.counts] };
            });
            await refreshAuditAfterServerMutation(`Contagem ${created.code} iniciada.`);
            return created.id;
          }).catch((error: unknown) => {
            notify(error instanceof Error ? error.message : 'Falha ao iniciar contagem.', 'error');
            return null;
          });
        }
        const code = nextCode(
          state.counts.map((c) => c.code),
          'CT',
          42,
        );
        const id = uid('ct');
        const at = nowISO();
        setState({
          ...state,
          counts: [
            {
              id,
              restaurantId: state.restaurant.id,
              code,
              status: 'open',
              startedAt: at,
              approvedAt: null,
              createdBy: state.currentUserId,
              approvedBy: null,
              lines: itemIds.map((itemId) => {
                const item = state.items.find((i) => i.id === itemId);
                return {
                  itemId,
                  expectedQty: item?.currentQty ?? 0,
                  countedQty: null,
                };
              }),
            },
            ...state.counts,
          ],
        });
        return id;
      },

      setCountQty: (countId: string, itemId: string, countedQty: number | null) => {
        if (APP_MODE === 'production') {
          const previousWrite = countWritesRef.current.get(countId) ?? Promise.resolve(true);
          const write = previousWrite.catch(() => false).then(async () => {
            const expectedVersion = countVersionsRef.current.get(countId)
              ?? state.counts.find((count) => count.id === countId)?.version;
            if (expectedVersion == null) {
              notify('Não foi possível confirmar a versão da contagem. Atualize a tela e tente novamente.', 'error');
              return false;
            }
            try {
              const updated = await setApiCountLine(countId, itemId, countedQty, expectedVersion);
              const updatedVersion = updated.version ?? expectedVersion + 1;
              const knownVersion = rememberCountVersion(countVersionsRef.current, countId, updatedVersion);
              // Count-line endpoint returns the canonical updated session without a full reload.
              setState((previous) => previous.restaurant.id !== updated.restaurantId
                || updatedVersion < knownVersion ? previous : ({
                  ...previous, counts: upsertVersionedRecord(previous.counts, updated),
                }));
              return true;
            } catch (error) {
              if (isApiConflict(error)) {
                try { await syncFromApi(); await refreshCountFromApi(countId); }
                catch { /* Preserve the entered count even if refresh fails. */ }
                notify('A contagem mudou em outra sessão. Os dados salvos foram atualizados; confira os valores antes de continuar.', 'error');
                return false;
              }
              notify(error instanceof Error ? error.message : 'Falha ao salvar a quantidade contada.', 'error');
              return false;
            }
          });
          countWritesRef.current.set(countId, write);
          void write.finally(() => {
            if (countWritesRef.current.get(countId) === write) countWritesRef.current.delete(countId);
          });
          return write;
        }
        setState((prev) => ({
          ...prev,
          counts: prev.counts.map((count) =>
            count.id === countId
              ? {
                  ...count,
                  lines: count.lines.map((line) =>
                    line.itemId === itemId ? { ...line, countedQty } : line,
                  ),
                }
              : count,
          ),
        }));
        return true;
      },

      approveCount: (countId: string) => {
        if (!require('count.approve')) return false;
        const count = state.counts.find((c) => c.id === countId);
        if (!count) return false;
        if (APP_MODE === 'production') {
          const expectedVersion = countVersionsRef.current.get(countId) ?? count.version;
          if (expectedVersion == null) {
            notify('Não foi possível confirmar a versão revisada da contagem. Atualize a tela e tente novamente.', 'error');
            return false;
          }
          return approveApiCount(countId, expectedVersion).then(async ({ count: approved, movements }) => {
            const approvedVersion = approved.version ?? expectedVersion + 1;
            const knownVersion = rememberCountVersion(countVersionsRef.current, countId, approvedVersion);
            setState((previous) => {
              if (previous.restaurant.id !== approved.restaurantId) return previous;
              const movementById = new Map(previous.movements.map((movement) => [movement.id, movement]));
              movements.forEach((movement) => movementById.set(movement.id, movement));
              const latestMovementByItem = new Map<string, Movement>();
              movements.forEach((movement) => {
                const current = latestMovementByItem.get(movement.itemId);
                if (!current || (movement.stockVersionAfter ?? 0) >= (current.stockVersionAfter ?? 0)) {
                  latestMovementByItem.set(movement.itemId, movement);
                }
              });
              return {
                ...previous,
                items: previous.items.map((item) => {
                  const movement = latestMovementByItem.get(item.id);
                  return movement && isStockSnapshotCurrent(movement.stockVersionAfter, item.stockVersion,
                    movement.occurredAt, item.updatedAt)
                    ? reconcileInventoryItem(item, { ...item, currentQty: movement.balanceAfter,
                        updatedAt: movement.occurredAt, stockVersion: movement.stockVersionAfter })
                    : item;
                }),
                counts: approvedVersion < knownVersion ? previous.counts
                  : upsertVersionedRecord(previous.counts, approved),
                movements: [...movementById.values()],
              };
            });
            await refreshAuditAfterServerMutation(`Contagem ${count.code} aprovada e ajustada.`);
            return true;
          }).catch(async (error: unknown) => {
            if (isApiConflict(error)) {
              try { await syncFromApi(); await refreshCountFromApi(countId); }
              catch { /* Keep the session open for review. */ }
              notify('O saldo ou a contagem mudou desde a revisão. Nada foi aprovado; confira os dados atualizados e inicie uma nova contagem se o saldo mudou.', 'error');
              return false;
            }
            notify(error instanceof Error ? error.message : 'Falha ao aprovar a contagem.', 'error');
            return false;
          });
        }
        const missing = count.lines.filter((l) => l.countedQty == null);
        if (missing.length > 0) {
          notify(`Ainda há ${missing.length} itens sem contagem.`, 'error');
          return false;
        }
        const at = nowISO();
        const movements: Movement[] = [];
        let items = state.items;
        let totalDiff = 0;
        let totalDiffComplete = true;
        const financialLines = new Map<string, { financialImpactCents: number | null;
          financialImpactComplete: boolean; expectedValueCents: number | null;
          countedValueCents: number | null; valuationComplete: boolean }>();
        for (const line of count.lines) {
          const item = items.find((i) => i.id === line.itemId);
          if (line.countedQty == null) continue;
          const delta = line.countedQty - line.expectedQty;
          const deltaMilli = Math.round(delta * 1000);
          if (!item) {
            if (deltaMilli !== 0) {
              financialLines.set(line.itemId, { financialImpactCents: null, financialImpactComplete: false,
                expectedValueCents: null, countedValueCents: null, valuationComplete: false });
              totalDiffComplete = false;
            } else financialLines.set(line.itemId, { financialImpactCents: 0, financialImpactComplete: true,
              expectedValueCents: null, countedValueCents: null, valuationComplete: false });
            continue;
          }
          const expectedValueCents = itemCostKnown(item)
            ? roundCentsFromMilliUnits(line.expectedQty, item.costCents) : null;
          const countedValueCents = itemCostKnown(item)
            ? roundCentsFromMilliUnits(line.countedQty, item.costCents) : null;
          const lineValuation = { expectedValueCents, countedValueCents, valuationComplete: itemCostKnown(item) };
          if (deltaMilli === 0) {
            financialLines.set(line.itemId, { financialImpactCents: 0, financialImpactComplete: true, ...lineValuation });
            continue;
          }
          if (itemCostKnown(item)) {
            const impactCents = roundCentsFromMilliUnits(delta, item.costCents);
            totalDiff += impactCents;
            financialLines.set(line.itemId, { financialImpactCents: impactCents,
              financialImpactComplete: true, ...lineValuation });
          } else {
            totalDiffComplete = false;
            financialLines.set(line.itemId, { financialImpactCents: null,
              financialImpactComplete: false, ...lineValuation });
          }
          const nextQty = Math.round(line.countedQty * 1000) / 1000;
          items = items.map((i) =>
            i.id === item.id ? { ...i, currentQty: nextQty, updatedAt: at } : i,
          );
          movements.push({
            id: uid('mv'),
            restaurantId: state.restaurant.id,
            itemId: item.id,
            type: 'ADJUSTMENT',
            direction: delta > 0 ? 'in' : 'out',
            qty: Math.abs(delta),
            unit: item.unit,
            unitCostCents: item.costCents,
            occurredAt: at,
            reason: `Contagem física ${count.code}`,
            origin: count.code,
            userId: state.currentUserId,
            balanceAfter: nextQty,
          });
        }

        setState({
          ...state,
          items,
          movements: [...state.movements, ...movements],
          counts: state.counts.map((c) =>
            c.id === countId
              ? {
                  ...c,
                  status: 'approved',
                  approvedAt: at,
                  approvedBy: state.currentUserId,
                  financialImpactCents: totalDiffComplete ? totalDiff : null,
                  financialImpactComplete: totalDiffComplete,
                  lines: c.lines.map((line) => ({ ...line, ...financialLines.get(line.itemId) })),
                }
              : c,
          ),
          audit: [
            auditEntry(
              state,
              'count.approve',
              'count',
              count.code,
              `${count.lines.length} itens esperados`,
              `${movements.length} ajustes gerados`,
              totalDiffComplete ? `Contagem aprovada · impacto de ${money(totalDiff)}`
                : 'Contagem aprovada · impacto financeiro sem custo completo',
            ),
            ...state.audit,
          ],
        });
        notify(
          `Contagem ${count.code} aprovada: ${movements.length} ajustes gerados (${money(totalDiff)}).`,
        );
        return true;
      },

      createPurchase: (input: NewPurchaseInput) => {
        if (!require('purchases.manage')) return null;
        if (!input.supplierId) {
          notify('Selecione o fornecedor.', 'error');
          return null;
        }
        if (!input.lines.length) {
          notify('Inclua ao menos um item no pedido.', 'error');
          return null;
        }
        if (input.lines.some((l) => l.qtyOrdered <= 0)) {
          notify('Todas as quantidades devem ser maiores que zero.', 'error');
          return null;
        }
        if (APP_MODE === 'production') {
          return createApiPurchase({ ...input, lines: input.lines.map((line) => ({
            ...line, unit: line.unit ?? state.items.find((item) => item.id === line.itemId)?.unit ?? 'un',
          })) }).then(async (created) => {
            const purchase = mapPurchase(created);
            setState((previous) => {
              if (previous.restaurant.id !== purchase.restaurantId) return previous;
              return { ...previous, purchases: upsertVersionedRecord(previous.purchases, purchase) };
            });
            await refreshPurchaseInsights();
            await refreshAuditAfterServerMutation(`Pedido ${created.code} criado como rascunho.`);
            return created._id;
          }).catch((error: unknown) => {
            notify(error instanceof Error ? error.message : 'Falha ao criar compra.', 'error');
            return null;
          });
        }
        const code = nextCode(
          state.purchases.map((p) => p.code),
          'PC',
          1047,
        );
        const id = uid('pu');
        const purchase: Purchase = {
          id,
          restaurantId: state.restaurant.id,
          code,
          supplierId: input.supplierId,
          status: 'draft',
          createdAt: nowISO(),
          expectedDeliveryAt: input.expectedDeliveryAt,
          receivedAt: null,
          receivedBy: null,
          note: input.note.trim(),
          lines: input.lines.map((line) => ({
            id: uid('pl'),
            itemId: line.itemId,
            unit: line.unit ?? state.items.find((item) => item.id === line.itemId)?.unit ?? 'un',
            qtyOrdered: line.qtyOrdered,
            qtyReceived: 0,
            expectedUnitCostCents: line.expectedUnitCostCents,
            receivedUnitCostCents: null,
          })),
        };
        setState({
          ...state,
          purchases: [purchase, ...state.purchases],
          audit: [
            auditEntry(
              state,
              'purchase.create',
              'purchase',
              code,
              null,
              input.lines
                .map((l) => `${state.items.find((i) => i.id === l.itemId)?.name ?? l.itemId} ${fmtQty(l.qtyOrdered)}`)
                .join(' · '),
              'Pedido de compra criado',
            ),
            ...state.audit,
          ],
        });
        notify(`Pedido ${code} criado como rascunho.`);
        return id;
      },

      createRecipe: (input: { name: string; salePriceCents: Cents; itemId: string; qty: number; unit: Unit; yieldPortions: number }) => {
        if (!require('recipes.manage')) return null;
        const name = input.name.trim();
        const item = state.items.find((entry) => entry.id === input.itemId && entry.active !== false);
        if (!name || !item || !Number.isFinite(input.qty) || input.qty <= 0 || input.salePriceCents <= 0) {
          notify('Informe o nome, o preço e uma quantidade válida para o primeiro insumo.', 'error');
          return null;
        }
        const slug = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
          .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'produto';
        const productId = `manual-${slug}`;
        if (state.recipes.some((recipe) => recipe.id === productId
          || recipe.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) {
          notify('Já existe uma ficha com esse nome ou identificador neste restaurante.', 'error');
          return null;
        }
        const at = nowISO();
        const recipe: Recipe = {
          id: productId, restaurantId: state.restaurant.id, name,
          salePriceCents: input.salePriceCents, yieldPortions: input.yieldPortions,
          ingredients: [{ itemId: item.id, qty: input.qty, unit: input.unit }],
          createdAt: at, updatedAt: at, version: 1,
        };
        if (APP_MODE === 'production') {
          const tenantId = state.restaurant.id;
          const generation = sessionGenerationRef.current;
          return saveApiRecipe(recipe, null).then(async (saved) => {
            await applySavedRecipe(saved, `Ficha técnica de ${name} cadastrada.`, true, tenantId, generation);
            return recipe.id;
          }).catch((error: unknown) => {
            if (isApiConflict(error)) {
              return refreshAfterConflict('ficha técnica').then(() => null);
            }
            notify(error instanceof Error ? error.message : 'Falha ao cadastrar ficha técnica.', 'error');
            return null;
          });
        }
        const nextState = { ...state, recipes: [recipe, ...state.recipes] };
        setState({
          ...nextState,
          recipeSnapshots: [{ id: uid('rs'), restaurantId: state.restaurant.id,
            recipeId: recipe.id, costCents: recipeCostPerPortionCents(nextState, recipe),
            yieldPortions: recipe.yieldPortions, batchCostCents: recipeCostCents(nextState, recipe),
            salePriceCents: recipe.salePriceCents, at, trigger: 'Ficha cadastrada' }, ...state.recipeSnapshots],
          audit: [auditEntry(state, 'recipe.update', 'recipe', name, null,
            `${item.name} · ${fmtQty(input.qty, input.unit)}`, 'Ficha técnica cadastrada'), ...state.audit],
        });
        notify(`Ficha técnica de ${name} cadastrada.`);
        return recipe.id;
      },

      updatePurchase: (purchaseId: string, input: NewPurchaseInput) => {
        if (!require('purchases.manage')) return false;
        const purchase = state.purchases.find((entry) => entry.id === purchaseId);
        if (!purchase) return false;
        if (purchase.status !== 'draft') {
          notify('Somente rascunhos podem ser editados.', 'error');
          return false;
        }
        if (!input.supplierId || input.lines.length === 0
            || input.lines.some((line) => !Number.isFinite(line.qtyOrdered) || line.qtyOrdered <= 0)) {
          notify('Selecione o fornecedor e informe ao menos um item com quantidade válida.', 'error');
          return false;
        }
        const lines = input.lines.map((line) => ({
          ...line,
          unit: line.unit ?? state.items.find((item) => item.id === line.itemId)?.unit ?? 'un' as Unit,
        }));
        if (APP_MODE === 'production') {
          return updateApiPurchase(purchase, { ...input, lines }).then(async (updated) => {
            setState((previous) => ({ ...previous,
              purchases: previous.restaurant.id !== updated.restaurantId ? previous.purchases
                : upsertVersionedRecord(previous.purchases, updated),
            }));
            await refreshPurchaseInsights();
            await refreshAuditAfterServerMutation(`Rascunho ${purchase.code} atualizado.`);
            return true;
          }).catch(async (error: unknown) => {
            if (isApiConflict(error)) await refreshAfterConflict('rascunho da compra', purchaseId);
            else notify(error instanceof Error ? error.message : 'Falha ao atualizar rascunho.', 'error');
            return false;
          });
        }
        const updated: Purchase = { ...purchase, ...input, lines: lines.map((line) => ({
          ...line,
          id: purchase.lines.find((existing) => existing.itemId === line.itemId)?.id ?? uid('pl'),
          qtyReceived: 0,
          receivedUnitCostCents: null,
        })), updatedAt: nowISO() };
        const beforeText = `${purchase.lines.length} itens · ${money(purchaseTotalCents(purchase))}`;
        const afterText = `${updated.lines.length} itens · ${money(purchaseTotalCents(updated))}`;
        setState((previous) => ({ ...previous,
          purchases: previous.purchases.map((entry) => entry.id === purchaseId ? updated : entry),
          audit: [auditEntry(state, 'purchase.update', 'purchase', purchase.code,
            beforeText, afterText, 'Rascunho de compra editado'), ...previous.audit],
        }));
        notify(`Rascunho ${purchase.code} atualizado.`);
        return true;
      },

      requestPurchase: (purchaseId: string, expectedVersion: number) => {
        if (!require('purchases.manage')) return false;
        if (APP_MODE === 'production') {
          return setApiPurchaseStatus(purchaseId, 'request', expectedVersion).then(async (result) => {
            const updated = mapPurchase(result);
            setState((previous) => ({ ...previous,
              purchases: previous.restaurant.id !== updated.restaurantId ? previous.purchases
                : upsertVersionedRecord(previous.purchases, updated),
            }));
            await refreshPurchaseInsights();
            await refreshAuditAfterServerMutation('Pedido enviado ao fornecedor.');
            return true;
          }).catch(async (error: unknown) => {
            if (isApiConflict(error)) await refreshAfterConflict('compra', purchaseId);
            else notify(error instanceof Error ? error.message : 'Falha ao solicitar compra.', 'error');
            return false;
          });
        }
        const purchase = state.purchases.find((p) => p.id === purchaseId);
        if (!purchase) return false;
        setState({
          ...state,
          purchases: state.purchases.map((p) =>
            p.id === purchaseId ? { ...p, status: 'requested' as PurchaseStatus } : p,
          ),
        });
        notify(`Pedido ${purchase.code} enviado ao fornecedor.`);
        return true;
      },

      cancelPurchase: (purchaseId: string, expectedVersion: number) => {
        if (!require('purchases.manage')) return false;
        if (APP_MODE === 'production') {
          return setApiPurchaseStatus(purchaseId, 'cancel', expectedVersion).then(async (result) => {
            const updated = mapPurchase(result);
            setState((previous) => ({ ...previous,
              purchases: previous.restaurant.id !== updated.restaurantId ? previous.purchases
                : upsertVersionedRecord(previous.purchases, updated),
            }));
            await refreshPurchaseInsights();
            await refreshAuditAfterServerMutation('Pedido cancelado.');
            return true;
          }).catch(async (error: unknown) => {
            if (isApiConflict(error)) await refreshAfterConflict('compra', purchaseId);
            else notify(error instanceof Error ? error.message : 'Falha ao cancelar compra.', 'error');
            return false;
          });
        }
        const purchase = state.purchases.find((p) => p.id === purchaseId);
        if (!purchase) return false;
        if (purchase.status === 'received') {
          notify('Pedido já recebido não pode ser cancelado.', 'error');
          return false;
        }
        setState({
          ...state,
          purchases: state.purchases.map((p) =>
            p.id === purchaseId ? { ...p, status: 'cancelled' as PurchaseStatus } : p,
          ),
          audit: [
            auditEntry(
              state,
              'purchase.cancel',
              'purchase',
              purchase.code,
              purchase.status,
              'cancelled',
              'Cancelamento de pedido de compra',
            ),
            ...state.audit,
          ],
        });
        notify(`Pedido ${purchase.code} cancelado.`);
        return true;
      },

      receivePurchase: (purchaseId: string, receipts: ReceiveLineInput[]) => {
        if (!require('purchases.receive')) return false;
        const purchase = state.purchases.find((p) => p.id === purchaseId);
        if (!purchase) return false;
        if (APP_MODE === 'production') {
          const tenantId = state.restaurant.id;
          const generation = sessionGenerationRef.current;
          return receiveApiPurchase(purchase, receipts).then(async (result) => {
            await applyPurchaseStockMutation(result,
              `Recebimento do pedido ${purchase.code} registrado.`, tenantId, generation);
            return true;
          }).catch(async (error: unknown) => {
            if (isApiConflict(error)) await refreshAfterConflict('rascunho da compra', purchaseId);
            else notify(error instanceof Error ? error.message : 'Falha ao registrar recebimento.', 'error');
            return false;
          });
        }
        if (purchase.status === 'received' || purchase.status === 'cancelled') {
          notify('Este pedido não está disponível para recebimento.', 'error');
          return false;
        }
        if (purchase.status === 'draft') {
          notify('Envie o pedido ao fornecedor antes de registrar o recebimento.', 'error');
          return false;
        }

        const incompatibleLine = purchase.lines.find((line) => {
          const item = state.items.find((entry) => entry.id === line.itemId);
          return !item || quantityFactorToBase(line.unit ?? item.unit, item.unit, item.conversions) == null;
        });
        if (incompatibleLine) {
          notify('A unidade de compra não possui conversão válida para o estoque deste insumo.', 'error');
          return false;
        }

        const invalid = receipts.find((receipt) => {
          const line = purchase.lines.find((l) => l.id === receipt.lineId);
          if (!line) return true;
          return receipt.qtyReceived > line.qtyOrdered + 0.0001 || receipt.qtyReceived < 0;
        });
        if (invalid) {
          notify('Quantidade recebida maior que a solicitada.', 'error');
          return false;
        }

        const at = nowISO();
        let items = state.items;
        let pricePoints = state.pricePoints;
        let supplierItems = state.supplierItems;
        const newMovements: Movement[] = [];
        const newAudit: AuditEntry[] = [];
        let totalReceived = 0;

        const updatedLines = purchase.lines.map((line) => {
          const input = receipts.find((r) => r.lineId === line.id);
          if (!input) return line;
          const targetQty = Math.max(0, input.qtyReceived);
          if (targetQty > line.qtyOrdered + 0.0001) {
            notify('Quantidade recebida maior que a solicitada.', 'error');
            return line;
          }
          const delta = Math.round((targetQty - line.qtyReceived) * 1000) / 1000;
          const unitCost = receiptUnitCostCents(input.unitCostCents, line.expectedUnitCostCents);
          if (delta <= 0) return line;
          const item = items.find((i) => i.id === line.itemId);
          if (!item) return line;
          const factor = quantityFactorToBase(line.unit ?? item.unit, item.unit, item.conversions)!;
          const stock = receivedStockValues(item.currentQty, item.costCents, delta, unitCost, factor);
          const baseDelta = stock.receivedQuantity;
          const baseUnitCost = Math.round(unitCost / factor);
          const nextQty = stock.quantity;
          const nextCost = stock.unitCostCents;
          totalReceived += Math.round(delta * unitCost);
          items = items.map((i) =>
            i.id === item.id ? { ...i, currentQty: nextQty, costCents: nextCost, updatedAt: at } : i,
          );
          newMovements.push({
            id: uid('mv'),
            restaurantId: state.restaurant.id,
            itemId: item.id,
            type: 'PURCHASE',
            direction: 'in',
            qty: baseDelta,
            unit: item.unit,
            unitCostCents: baseUnitCost,
            occurredAt: at,
            reason: `Recebimento ${purchase.code}`,
            origin: purchase.code,
            userId: state.currentUserId,
            balanceAfter: nextQty,
            supplierId: purchase.supplierId,
          });
          pricePoints = [
            ...pricePoints,
            {
              id: uid('pp'),
              restaurantId: state.restaurant.id,
              itemId: item.id,
              supplierId: purchase.supplierId,
              unitCostCents: baseUnitCost,
              at,
              source: 'purchase',
            },
          ];
          supplierItems = supplierItems.map((si) =>
            si.supplierId === purchase.supplierId && si.itemId === item.id
              ? { ...si, lastPriceCents: baseUnitCost, lastPurchaseAt: at }
              : si,
          );
          if (nextCost !== item.costCents) {
            newAudit.push(
              auditEntry(
                state,
                'cost.change',
                'item',
                item.name,
                (item.costCents > 0 ? money(item.costCents) : 'Custo não cadastrado') + `/${item.unit}`,
                money(nextCost) + `/${item.unit}`,
                `Preço atualizado no recebimento ${purchase.code}`,
              ),
            );
          }
          return {
            ...line,
            qtyReceived: targetQty,
            receivedUnitCostCents: unitCost,
          };
        });

        const allReceived = updatedLines.every((l) => l.qtyReceived >= l.qtyOrdered - 0.0001);
        const anyReceived = updatedLines.some((l) => l.qtyReceived > 0);
        const status: PurchaseStatus = allReceived ? 'received' : anyReceived ? 'partial' : purchase.status;

        let nextState: AppState = {
          ...state,
          items,
          pricePoints,
          supplierItems,
          movements: [...state.movements, ...newMovements],
          purchases: state.purchases.map((p) =>
            p.id === purchaseId
              ? { ...p, lines: updatedLines, status, receivedAt: at, receivedBy: state.currentUserId }
              : p,
          ),
          audit: [
            auditEntry(
              state,
              'purchase.receive',
              'purchase',
              purchase.code,
              purchase.lines
                .map((l) => `${state.items.find((i) => i.id === l.itemId)?.name ?? ''}: ${fmtQty(l.qtyReceived)}`)
                .join(' · '),
              updatedLines
                .map((l) => `${state.items.find((i) => i.id === l.itemId)?.name ?? ''}: ${fmtQty(l.qtyReceived)}`)
                .join(' · '),
              `Recebimento de ${money(totalReceived)}`,
            ),
            ...newAudit,
            ...state.audit,
          ],
        };

        const touched = new Set(updatedLines.map((l) => l.itemId));
        const snapshots = state.recipes
          .filter((recipe) => recipe.ingredients.some((i) => touched.has(i.itemId)))
          .map((recipe) => ({
            id: uid('rs'),
            restaurantId: state.restaurant.id,
            recipeId: recipe.id,
            costCents: recipeCostPerPortionCents(nextState, recipe),
            yieldPortions: recipe.yieldPortions, batchCostCents: recipeCostCents(nextState, recipe),
            salePriceCents: recipe.salePriceCents,
            at,
            trigger: `Recebimento ${purchase.code}`,
          }));
        nextState = {
          ...nextState,
          recipeSnapshots: [...snapshots, ...nextState.recipeSnapshots],
        };

        setState(nextState);
        notify(
          `Recebimento confirmado: ${money(totalReceived)} em ${purchase.code} (${status === 'received' ? 'pedido completo' : 'parcial'}).`,
        );
        return true;
      },

      reversePurchaseReceipt: (purchaseId: string, receiptId: string, reason: string) => {
        if (!require('purchases.manage')) return false;
        const purchase = state.purchases.find((entry) => entry.id === purchaseId);
        if (!purchase || APP_MODE !== 'production') return false;
        const tenantId = state.restaurant.id;
        const generation = sessionGenerationRef.current;
        return reverseApiPurchaseReceipt(purchaseId, receiptId, reason).then(async (result) => {
          await applyPurchaseStockMutation(result,
            `Estorno do recebimento de ${purchase.code} registrado.`, tenantId, generation);
          return true;
        }).catch(async (error: unknown) => {
          if (isApiConflict(error)) await refreshAfterConflict('compra', purchaseId);
          else notify(error instanceof Error ? error.message : 'Falha ao estornar recebimento.', 'error');
          return false;
        });
      },

      addRecipeIngredient: (recipeId: string, itemId: string, qty: number, unit: Unit) => {
        if (!require('recipes.manage')) return false;
        const recipe = state.recipes.find((r) => r.id === recipeId);
        if (!recipe) return false;
        if (!itemId) {
          notify('Selecione o insumo.', 'error');
          return false;
        }
        if (qty <= 0) {
          notify('Informe uma quantidade maior que zero.', 'error');
          return false;
        }
        if (recipe.ingredients.some((i) => i.itemId === itemId)) {
          notify('Esse insumo já está na ficha técnica.', 'error');
          return false;
        }
        if (APP_MODE === 'production') {
          return persistRecipe({ ...recipe, ingredients: [...recipe.ingredients, { itemId, qty, unit }],
            updatedAt: nowISO() }, recipe.version);
        }
        const at = nowISO();
        const nextState: AppState = {
          ...state,
          recipes: state.recipes.map((r) =>
            r.id === recipeId
              ? { ...r, ingredients: [...r.ingredients, { itemId, qty, unit }], updatedAt: at }
              : r,
          ),
        };
        const updated = nextState.recipes.find((r) => r.id === recipeId)!;
        setState({
          ...nextState,
          recipeSnapshots: [
            {
              id: uid('rs'),
              restaurantId: state.restaurant.id,
              recipeId,
              costCents: recipeCostPerPortionCents(nextState, updated),
              yieldPortions: updated.yieldPortions, batchCostCents: recipeCostCents(nextState, updated),
              salePriceCents: updated.salePriceCents,
              at,
              trigger: 'Ficha atualizada',
            },
            ...nextState.recipeSnapshots,
          ],
          audit: [
            auditEntry(
              state,
              'recipe.update',
              'recipe',
              recipe.name,
              null,
              `${state.items.find((i) => i.id === itemId)?.name ?? itemId} · ${fmtQty(qty, unit)}`,
              'Ingrediente adicionado à ficha',
            ),
            ...state.audit,
          ],
        });
        notify('Ingrediente adicionado à ficha técnica.');
        return true;
      },

      updateRecipeIngredient: (recipeId: string, itemId: string, qty: number) => {
        if (!require('recipes.manage')) return false;
        if (qty <= 0) {
          notify('Informe uma quantidade maior que zero.', 'error');
          return false;
        }
        const currentRecipe = state.recipes.find((r) => r.id === recipeId);
        if (!currentRecipe) return false;
        if (APP_MODE === 'production') {
          return persistRecipe({ ...currentRecipe,
            ingredients: currentRecipe.ingredients.map((line) => line.itemId === itemId ? { ...line, qty } : line),
            updatedAt: nowISO() }, currentRecipe.version);
        }
        const at = nowISO();
        const nextState: AppState = {
          ...state,
          recipes: state.recipes.map((r) =>
            r.id === recipeId
              ? {
                  ...r,
                  ingredients: r.ingredients.map((i) => (i.itemId === itemId ? { ...i, qty } : i)),
                  updatedAt: at,
                }
              : r,
          ),
        };
        const recipe = nextState.recipes.find((r) => r.id === recipeId)!;
        setState({
          ...nextState,
          recipeSnapshots: [
            {
              id: uid('rs'),
              restaurantId: state.restaurant.id,
              recipeId,
              costCents: recipeCostPerPortionCents(nextState, recipe),
              yieldPortions: recipe.yieldPortions, batchCostCents: recipeCostCents(nextState, recipe),
              salePriceCents: recipe.salePriceCents,
              at,
              trigger: 'Ficha atualizada',
            },
            ...nextState.recipeSnapshots,
          ],
          audit: [
            auditEntry(
              state,
              'recipe.update',
              'recipe',
              recipe.name,
              null,
              `${state.items.find((i) => i.id === itemId)?.name ?? itemId} · ${fmtQty(qty)}`,
              'Quantidade de ingrediente alterada',
            ),
            ...state.audit,
          ],
        });
        notify('Quantidade atualizada na ficha.');
        return true;
      },

      removeRecipeIngredient: (recipeId: string, itemId: string) => {
        if (!require('recipes.manage')) return;
        const currentRecipe = state.recipes.find((r) => r.id === recipeId);
        if (!currentRecipe) return;
        if (APP_MODE === 'production') {
          const ingredients = currentRecipe.ingredients.filter((line) => line.itemId !== itemId);
          if (!ingredients.length) {
            notify('A ficha precisa ter ao menos um insumo.', 'error');
            return Promise.resolve(false);
          }
          return persistRecipe({ ...currentRecipe, ingredients, updatedAt: nowISO() }, currentRecipe.version);
        }
        const at = nowISO();
        const recipe = state.recipes.find((r) => r.id === recipeId);
        if (!recipe) return;
        const nextState: AppState = {
          ...state,
          recipes: state.recipes.map((r) =>
            r.id === recipeId
              ? { ...r, ingredients: r.ingredients.filter((i) => i.itemId !== itemId), updatedAt: at }
              : r,
          ),
        };
        const updated = nextState.recipes.find((r) => r.id === recipeId)!;
        setState({
          ...nextState,
          recipeSnapshots: [
            {
              id: uid('rs'),
              restaurantId: state.restaurant.id,
              recipeId,
              costCents: recipeCostPerPortionCents(nextState, updated),
              yieldPortions: updated.yieldPortions, batchCostCents: recipeCostCents(nextState, updated),
              salePriceCents: updated.salePriceCents,
              at,
              trigger: 'Ficha atualizada',
            },
            ...nextState.recipeSnapshots,
          ],
          audit: [
            auditEntry(
              state,
              'recipe.update',
              'recipe',
              recipe.name,
              state.items.find((i) => i.id === itemId)?.name ?? itemId,
              null,
              'Ingrediente removido da ficha',
            ),
            ...state.audit,
          ],
        });
        notify('Ingrediente removido da ficha.');
      },

      updateRecipePrice: (recipeId: string, salePriceCents: Cents) => {
        if (!require('recipes.manage')) return false;
        if (salePriceCents <= 0) {
          notify('Informe um preço de venda válido.', 'error');
          return false;
        }
        const recipe = state.recipes.find((r) => r.id === recipeId);
        if (!recipe) return false;
        if (APP_MODE === 'production') {
          return persistRecipe({ ...recipe, salePriceCents, updatedAt: nowISO() }, recipe.version);
        }
        const at = nowISO();
        const nextState: AppState = {
          ...state,
          recipes: state.recipes.map((r) =>
            r.id === recipeId ? { ...r, salePriceCents, updatedAt: at } : r,
          ),
        };
        const updated = nextState.recipes.find((r) => r.id === recipeId)!;
        setState({
          ...nextState,
          recipeSnapshots: [
            {
              id: uid('rs'),
              restaurantId: state.restaurant.id,
              recipeId,
              costCents: recipeCostPerPortionCents(nextState, updated),
              yieldPortions: updated.yieldPortions, batchCostCents: recipeCostCents(nextState, updated),
              salePriceCents,
              at,
              trigger: 'Preço de venda alterado',
            },
            ...nextState.recipeSnapshots,
          ],
          audit: [
            auditEntry(
              state,
              'recipe.update',
              'recipe',
              recipe.name,
              money(recipe.salePriceCents),
              money(salePriceCents),
              'Alteração de preço de venda',
            ),
            ...state.audit,
          ],
        });
        notify('Preço de venda atualizado.');
        return true;
      },

      updateRecipeYield: (recipeId: string, yieldPortions: number) => {
        if (!require('recipes.manage')) return false;
        if (!Number.isInteger(yieldPortions) || yieldPortions < 1 || yieldPortions > 10000) {
          notify('Informe um rendimento entre 1 e 10.000 porções.', 'error');
          return false;
        }
        const recipe = state.recipes.find((r) => r.id === recipeId);
        if (!recipe) return false;
        if ((recipe.yieldPortions || 1) === yieldPortions) return true;
        const at = nowISO();
        const updatedRecipe = { ...recipe, yieldPortions, updatedAt: at };
        if (APP_MODE === 'production') return persistRecipe(updatedRecipe, recipe.version);
        const nextState: AppState = {
          ...state,
          recipes: state.recipes.map((entry) => entry.id === recipeId ? updatedRecipe : entry),
        };
        setState({
          ...nextState,
          recipeSnapshots: [{ id: uid('rs'), restaurantId: state.restaurant.id, recipeId,
            costCents: recipeCostPerPortionCents(nextState, updatedRecipe),
            yieldPortions: updatedRecipe.yieldPortions, batchCostCents: recipeCostCents(nextState, updatedRecipe),
            salePriceCents: recipe.salePriceCents, at, trigger: 'Rendimento atualizado' },
          ...nextState.recipeSnapshots],
          audit: [auditEntry(state, 'recipe.update', 'recipe', recipe.name,
            `${recipe.yieldPortions || 1} porção(ões)`, `${yieldPortions} porção(ões)`,
            'Rendimento da ficha atualizado'), ...state.audit],
        });
        notify('Rendimento da ficha atualizado.');
        return true;
      },

      setRecipeActive: (recipeId: string, active: boolean) => {
        if (!require('recipes.manage')) return false;
        const recipe = state.recipes.find((entry) => entry.id === recipeId);
        if (!recipe) return false;
        if ((recipe.active !== false) === active) return true;
        if (APP_MODE === 'production') {
          const tenantId = state.restaurant.id;
          const generation = sessionGenerationRef.current;
          return setApiRecipeActive(recipeId, active, recipe.version).then(async (saved) => {
            await applySavedRecipe(saved, active ? 'Ficha técnica reativada.' : 'Ficha técnica desativada.',
              false, tenantId, generation);
            return true;
          }).catch((error: unknown) => {
            if (isApiConflict(error)) {
              return refreshAfterConflict('ficha técnica').then(() => false);
            }
            notify(error instanceof Error ? error.message : 'Falha ao atualizar o status da ficha.', 'error');
            return false;
          });
        }
        const updated = { ...recipe, active, version: recipe.version + 1, updatedAt: nowISO() };
        setState((previous) => ({ ...previous,
          recipes: previous.recipes.map((entry) => entry.id === recipeId ? updated : entry),
          audit: [auditEntry(state, 'recipe.update', 'recipe', recipe.name,
            recipe.active === false ? 'inativa' : 'ativa', active ? 'ativa' : 'inativa',
            active ? 'Ficha técnica reativada' : 'Ficha técnica desativada'), ...previous.audit],
        }));
        notify(active ? 'Ficha técnica reativada.' : 'Ficha técnica desativada.');
        return true;
      },

      simulateOrderDelivered: () => {
        if (!requireDemo('overview.view')) return;
        const mix = [
          { recipeId: 'rc-xburger', qty: 2 },
          { recipeId: 'rc-batata', qty: 1 },
          { recipeId: 'rc-coca', qty: 2 },
        ];
        const seq = state.events.length + 1;
        const event = {
          id: `evt-sim-${seq}-${Date.now()}`,
          type: 'ORDER_DELIVERED' as const,
          restaurantId: state.restaurant.id,
          orderId: `PD-${9000 + seq}`,
          occurredAt: nowISO(),
          lines: mix,
          processedAt: null,
        };
        const outcome = applyOrderDelivered(state, event);
        setState(outcome.state);
        if (outcome.status === 'processed') {
          notify(
            `Pedido ${event.orderId} entregue: ${outcome.consumption
              .slice(0, 3)
              .map((c) => `${fmtQty(c.qty, c.unit as Unit)} ${c.name.toLowerCase()}`)
              .join(' · ')}${outcome.consumption.length > 3 ? '…' : ''}`,
          );
        }
      },

      replayLastEvent: () => {
        const last = state.events.find((e) => e.type === 'ORDER_DELIVERED');
        if (!last) {
          notify('Nenhum evento para reprocessar.', 'error');
          return;
        }
        const outcome = applyOrderDelivered(state, { ...last, id: last.id });
        if (outcome.status === 'duplicate') {
          notify(
            `Evento ${last.id} já processado. Nenhuma baixa duplicada foi gerada.`,
            'error',
          );
        }
      },
      loadMoreAudit: async () => {
        if (APP_MODE !== 'production' || !auditPage.hasMore || !auditPage.cursor || auditLoadingRef.current) return;
        const tenant = auditPage.tenant;
        auditLoadingRef.current = true;
        setAuditPage((previous) => ({ ...previous, loading: true }));
        try {
          const page = await fetchApiAuditPage(auditPage.cursor);
          setState((previous) => {
            if (previous.restaurant.id !== tenant) return previous;
            const merged = mergeAuditEntries(previous.audit, page.items);
            return { ...previous, audit: merged };
          });
          setAuditPage((previous) => previous.tenant === tenant
            ? { ...previous, cursor: page.nextCursor, hasMore: page.hasMore, loading: false }
            : previous);
        } catch (error) {
          setAuditPage((previous) => ({ ...previous, loading: false }));
          notify(error instanceof Error ? error.message : 'Não foi possível carregar a auditoria anterior.', 'error');
        } finally {
          auditLoadingRef.current = false;
        }
      },
    };
  }, [state, currentUser?.role, notify, syncFromApi, refreshCountFromApi, auditPage, clearLocalSession]);

  const value: AppContextValue = {
    state,
    mode: APP_MODE,
    ready,
    startupError,
    auditHasMore: auditPage.hasMore,
    auditLoading: auditPage.loading,
    toast,
    can,
    notify,
    actions,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp deve ser usado dentro de AppProvider');
  return context;
}

export function useCurrentUser() {
  const { state } = useApp();
  return state.users.find((u) => u.id === state.currentUserId) ?? state.users[0]
    ?? { id: '', restaurantId: '', name: 'Usuário DACOT', role: 'operator' as const, initials: 'DC' };
}
