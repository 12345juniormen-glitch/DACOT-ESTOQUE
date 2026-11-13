import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowRight,
  BookOpen,
  ClipboardList,
  Info,
  MoveDownRight,
  MoveUpRight,
  Plus,
  RotateCcw,
  Truck,
} from 'lucide-react';
import { useApp } from '../state/AppStore';
import { fetchApiIngredient, fetchApiIngredientMovementPage, fetchApiPurchase,
  fetchApiIngredientPriceHistory, fetchApiRecipesUsingIngredient, fetchApiSupplierPage } from '../lib/api';
import {
  itemStatus,
  itemCostKnown,
  itemMovementValueCents,
  itemValueCents,
  latestItemPurchaseReceipt,
  priceVariation,
  primaryOffer,
  recipesUsingItem,
  recommendedPurchases,
  supplierOfferHasPrice,
  supplierOffers,
} from '../domain/selectors';
import {
  date,
  money,
  qty as fmtQty,
  shortDate,
  time,
} from '../domain/format';
import { CATEGORIES, MOVEMENT_LABEL, type Movement, type PricePoint, type Unit } from '../domain/types';
import { moneyInput, parseStockQty, parseOptionalNonNegativeMoney, parseQty } from '../domain/format';
import {
  BackLink,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  Money,
  PageHeader,
  Panel,
  StatusTag,
  ToneNote,
} from '../components/ui';
import { PriceChart } from '../components/charts';
import { ConversionEditor, conversionDrafts, parseConversionDrafts, type ConversionDraft } from '../components/ConversionEditor';

export function ItemDetailPage() {
  const { id } = useParams();
  const { state, actions, can, mode, ready, auditHasMore, auditLoading, notify } = useApp();
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const item = state.items.find((i) => i.id === id);
  const [movementOpen, setMovementOpen] = useState(false);
  const [kind, setKind] = useState<'in' | 'out' | 'adjust'>('in');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [showAllAudit, setShowAllAudit] = useState(false);
  const [confirmAdjust, setConfirmAdjust] = useState(false);
  const [reversalTarget, setReversalTarget] = useState<string | null>(null);
  const [reversalReason, setReversalReason] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState<(typeof CATEGORIES)[number]>('Outros');
  const [editMinQty, setEditMinQty] = useState('');
  const [editCost, setEditCost] = useState('');
  const [editSupplier, setEditSupplier] = useState('');
  const [editInternalCode, setEditInternalCode] = useState('');
  const [editBarcode, setEditBarcode] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [editConversions, setEditConversions] = useState<ConversionDraft[]>([]);
  const [movementPage, setMovementPage] = useState<{ itemId: string | null; movements: Movement[];
    hasMore: boolean; loading: boolean; error: string | null }>(
      { itemId: null, movements: [], hasMore: false, loading: false, error: null });
  const [movementRetry, setMovementRetry] = useState(0);
  const [priceHistory, setPriceHistory] = useState<{ itemId: string; restaurantId: string;
    points: PricePoint[]; summary: { first_cost_cents: number; last_cost_cents: number; count: number } | null;
    loading: boolean; error: string | null } | null>(null);
  const [supplierOptions, setSupplierOptions] = useState(state.suppliers);
  const [supplierOptionsHasMore, setSupplierOptionsHasMore] = useState(false);
  const [supplierOptionsLoadingMore, setSupplierOptionsLoadingMore] = useState(false);
  const [ingredientLoadError, setIngredientLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== 'production' || !ready || !id || item) {
      setIngredientLoadError(null);
      return;
    }
    let current = true;
    setIngredientLoadError(null);
    void fetchApiIngredient(id).then((ingredient) => {
      if (current) actions.cacheIngredients([ingredient]);
    }).catch((error: unknown) => {
      if (!current) return;
      setIngredientLoadError(error instanceof Error ? error.message : 'Não foi possível carregar o insumo.');
    });
    return () => { current = false; };
  }, [actions, id, item, mode, ready, state.restaurant.id]);
  useEffect(() => {
    if (mode !== 'production' || !item?.id) return;
    let current = true;
    void fetchApiRecipesUsingIngredient(item.id).then((recipes) => {
      if (current) actionsRef.current.cacheRecipes(recipes);
    }).catch((error: unknown) => {
      if (current) notify(error instanceof Error
        ? `Não foi possível carregar as fichas deste insumo (${error.message}).`
        : 'Não foi possível carregar as fichas deste insumo.', 'error');
    });
    return () => { current = false; };
  }, [item?.id, mode, state.restaurant.id, notify]);
  useEffect(() => {
    if (!editOpen || mode !== 'production') return;
    let active = true;
    void fetchApiSupplierPage('', 0, 50, false).then((page) => {
      if (active) {
        setSupplierOptions(page.suppliers);
        setSupplierOptionsHasMore(page.hasMore);
      }
    }).catch((error: unknown) => {
      if (active) notify(error instanceof Error ? error.message : 'Não foi possível carregar fornecedores.', 'error');
    });
    return () => { active = false; };
  }, [editOpen, mode, notify]);

  const loadMoreSuppliers = async () => {
    if (supplierOptionsLoadingMore || !supplierOptionsHasMore) return;
    setSupplierOptionsLoadingMore(true);
    try {
      const page = await fetchApiSupplierPage('', supplierOptions.length, 50, false);
      setSupplierOptions((previous) => [...previous,
        ...page.suppliers.filter((supplier) => !previous.some((entry) => entry.id === supplier.id))]);
      setSupplierOptionsHasMore(page.hasMore);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Não foi possível carregar mais fornecedores.', 'error');
    } finally {
      setSupplierOptionsLoadingMore(false);
    }
  };
  useEffect(() => {
    if (mode !== 'production' || !item?.id) {
      setMovementPage({ itemId: null, movements: [], hasMore: false, loading: false, error: null });
      return;
    }
    let current = true;
    setShowAll(false);
    const ingredientId = item.id;
    setMovementPage({ itemId: ingredientId, movements: [], hasMore: false, loading: true, error: null });
    void fetchApiIngredientMovementPage(ingredientId, 0).then((page) => {
      if (current) setMovementPage({ itemId: ingredientId, movements: page.movements,
        hasMore: page.hasMore, loading: false, error: null });
    }).catch((error: unknown) => {
      if (!current) return;
      const detail = error instanceof Error ? error.message : 'falha de conexão';
      setMovementPage({ itemId: ingredientId, movements: [], hasMore: false, loading: false, error: detail });
    });
    return () => { current = false; };
  }, [item?.id, mode, movementRetry]);
  useEffect(() => {
    if (mode !== 'production' || !ready || !item?.id || !state.restaurant.id) {
      setPriceHistory(null);
      return;
    }
    let current = true;
    const itemId = item.id;
    const restaurantId = state.restaurant.id;
    setPriceHistory({ itemId, restaurantId, points: [], summary: null, loading: true, error: null });
    void fetchApiIngredientPriceHistory(itemId).then((result) => {
      if (!current) return;
      if (result.points.some((point) => point.itemId !== itemId || point.restaurantId !== restaurantId)) {
        throw new Error('A API retornou preços fora do insumo ou restaurante ativo.');
      }
      setPriceHistory({ itemId, restaurantId, points: result.points, summary: result.summary,
        loading: false, error: null });
    }).catch((error: unknown) => {
      if (!current) return;
      setPriceHistory({ itemId, restaurantId, points: [], summary: null, loading: false,
        error: error instanceof Error ? error.message : 'Não foi possível carregar o histórico de preços.' });
    });
    return () => { current = false; };
  }, [item?.id, mode, ready, state.restaurant.id]);

  const loadMoreMovements = async () => {
    if (!item || movementPage.itemId !== item.id || movementPage.loading || !movementPage.hasMore) return;
    const ingredientId = item.id;
    setMovementPage((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const page = await fetchApiIngredientMovementPage(ingredientId, movementPage.movements.length);
      setMovementPage((previous) => previous.itemId !== ingredientId ? previous : ({
        ...previous,
        movements: [...previous.movements,
          ...page.movements.filter((movement) => !previous.movements.some((entry) => entry.id === movement.id))],
        hasMore: page.hasMore, loading: false, error: null,
      }));
    } catch (error) {
      setMovementPage((previous) => previous.itemId !== ingredientId ? previous : ({
        ...previous, loading: false,
        error: error instanceof Error ? error.message : 'Não foi possível carregar mais movimentações.',
      }));
    }
  };
  useEffect(() => {
    if (mode !== 'production' || !item?.id) return;
    const latestReceipt = state.movements.filter((movement) => movement.type === 'PURCHASE'
      && movement.itemId === item.id && movement.restaurantId === state.restaurant.id
      && movement.origin && !state.purchases.some((purchase) => purchase.id === movement.origin))
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())[0];
    if (!latestReceipt) return;
    let current = true;
    void fetchApiPurchase(latestReceipt.origin).then((purchase) => {
      if (current) actions.cachePurchase(purchase);
    }).catch(() => { /* The movement remains available even if the historical order was removed. */ });
    return () => { current = false; };
  }, [mode, item?.id, state.movements, state.purchases, state.restaurant.id, actions]);
  const points = useMemo(() => item
    ? (mode === 'production'
      ? priceHistory?.itemId === item.id && priceHistory.restaurantId === state.restaurant.id
        ? [...priceHistory.points]
        : []
      : state.pricePoints.filter((p) => p.itemId === item.id && p.unitCostCents > 0))
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    : [], [mode, priceHistory, state.pricePoints, state.restaurant.id, item?.id]);
  if (!item) {
    const loading = mode === 'production' && ready && !ingredientLoadError;
    return (
      <div>
        <BackLink to="/estoque">Estoque</BackLink>
        <Panel>
          <EmptyState
            icon={<Info size={18} />}
            title={loading ? 'Carregando insumo' : ingredientLoadError ? 'Não foi possível carregar o insumo' : 'Insumo não encontrado'}
            description={loading ? 'Consultando os dados persistidos deste insumo.'
              : ingredientLoadError ?? 'O item pode ter sido removido ou o endereço está incorreto.'}
            action={
              <Link to="/estoque" className="btn btn-ghost">
                Voltar ao estoque
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }

  const status = itemStatus(item);
  const movementById = new Map((movementPage.itemId === item.id ? movementPage.movements : [])
    .filter((movement) => movement.itemId === item.id)
    .map((movement) => [movement.id, movement]));
  state.movements.filter((movement) => movement.itemId === item.id)
    .forEach((movement) => movementById.set(movement.id, movement));
  const movements = [...movementById.values()]
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());
  const offers = supplierOffers(state, item.id);
  const pricedOffers = offers.filter(supplierOfferHasPrice);
  const primary = primaryOffer(state, item);
  const currentPriceHistory = priceHistory?.itemId === item.id
    && priceHistory.restaurantId === state.restaurant.id ? priceHistory : null;
  const variation = mode === 'production'
    ? currentPriceHistory?.summary && currentPriceHistory.summary.count >= 2
      ? { item, firstCents: currentPriceHistory.summary.first_cost_cents,
        lastCents: currentPriceHistory.summary.last_cost_cents,
        variation: currentPriceHistory.summary.first_cost_cents === 0 ? 0
          : (currentPriceHistory.summary.last_cost_cents - currentPriceHistory.summary.first_cost_cents)
            / currentPriceHistory.summary.first_cost_cents,
        points: currentPriceHistory.summary.count }
      : null
    : priceVariation(state, item);
  const usedIn = recipesUsingItem(state, item.id);
  const recommendation = recommendedPurchases(state).find((r) => r.item.id === item.id);
  const latestPoints = points.slice(-6);
  const lastPurchaseReceipt = latestItemPurchaseReceipt(state, item.id);
  const itemAuditEntries = state.audit.filter((entry) => entry.entityLabel.includes(item.name));
  const itemAudit = showAllAudit ? itemAuditEntries : itemAuditEntries.slice(0, 5);
  const visibleMovements = showAll ? movements : movements.slice(0, 12);
  const cheapest = pricedOffers[0];
  const mostExpensive = pricedOffers[pricedOffers.length - 1];

  const parsedMovementQty = parseStockQty(quantity);
  const typedQty = parsedMovementQty ?? 0;
  const movementEstimate = typedQty > 0 ? itemMovementValueCents(item, typedQty) : null;
  const validMovementDraft = parsedMovementQty != null && (parsedMovementQty === 0 || typedQty > 0)
    && reason.trim().length > 0 && (kind === 'adjust'
    ? typedQty >= 0 && Math.abs(typedQty - item.currentQty) >= 0.0001
    : typedQty > 0 && (kind !== 'out' || typedQty <= item.currentQty + 0.0001));
  const adjustPreview =
    kind === 'adjust'
      ? typedQty
      : Math.round((item.currentQty + (kind === 'in' ? typedQty : -typedQty)) * 1000) / 1000;

  const submitMovement = async () => {
    if (kind === 'adjust') {
      setConfirmAdjust(true);
      return;
    }
    const ok = await actions.recordMovement({
      itemId: item.id,
      kind,
      qty: Math.round((Number(quantity.replace(',', '.')) || 0) * 1000) / 1000,
      reason,
    });
    if (ok) {
      setMovementOpen(false);
      setQuantity('');
      setReason('');
    }
  };

  const openEdit = () => {
    setEditName(item.name);
    setEditCategory(item.category);
    setEditMinQty(String(item.minQty).replace('.', ','));
    setEditCost(itemCostKnown(item) ? moneyInput(item.costCents) : '');
    setEditSupplier(item.primarySupplierId ?? '');
    setEditInternalCode(item.internalCode ?? '');
    setEditBarcode(item.barcode ?? '');
    setEditNotes(item.notes ?? '');
    setEditActive(item.active !== false);
    setEditConversions(conversionDrafts(item.conversions));
    setEditOpen(true);
  };

  const saveEdit = async () => {
    const conversionMap = parseConversionDrafts(editConversions);
    if (!conversionMap) return;
    const parsedCost = parseOptionalNonNegativeMoney(editCost);
    if (!parsedCost) {
      notify('Informe um custo válido, igual ou maior que zero.', 'error');
      return;
    }
    const ok = await actions.updateItem(item.id, {
      name: editName.trim(),
      category: editCategory,
      minQty: parseQty(editMinQty),
      costCents: parsedCost.cents,
      costKnown: parsedCost.known,
      supplierId: editSupplier || null,
      internalCode: editInternalCode.trim() || null,
      barcode: editBarcode.trim() || null,
      notes: editNotes.trim(),
      active: editActive,
      conversions: conversionMap,
    });
    if (ok) setEditOpen(false);
  };

  return (
    <div>
      <BackLink to="/estoque">Estoque</BackLink>

      <PageHeader
        eyebrow={`Estoque / ${item.category}`}
        title={item.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <StatusTag status={status} />
            <span className="text-dim">·</span>
            <span>Unidade de controle: {item.unit}</span>
            <span className="text-dim">·</span>
            <span>Fornecedor principal: {primary?.supplier.name ?? 'não definido'}</span>
          </span>
        }
        actions={
          <>
            {can('stock.create') ? (
              <button type="button" className="btn btn-ghost" onClick={openEdit}>
                Editar cadastro
              </button>
            ) : null}
            {can('losses.manage') ? (
              <Link to={`/perdas?item=${item.id}`} className="btn btn-ghost">
                Registrar perda
              </Link>
            ) : null}
            {can('stock.adjust') ? (
              <button type="button" className="btn btn-primary" onClick={() => setMovementOpen(true)}>
                <Plus size={14} />
                Registrar movimentação
              </button>
            ) : null}
          </>
        }
      />

      <section className="panel mb-5 grid grid-cols-2 gap-px overflow-hidden bg-line md:grid-cols-3 xl:grid-cols-6">
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Estoque atual</div>
          <div className={`mt-2 num text-[21px] leading-none ${status === 'normal' ? 'text-cream' : 'text-copper'}`}>
            {fmtQty(item.currentQty, item.unit)}
          </div>
          <div className="mt-2 text-[10.5px] text-muted">
            {recommendation?.basis === 'minimum'
              ? 'abaixo do mínimo'
              : recommendation
                ? `acaba em ${Math.max(1, Math.round(recommendation.daysRemaining))} dias`
                : 'sem risco de ruptura'}
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Estoque mínimo</div>
          <div className="mt-2 num text-[21px] leading-none text-cream">
            {fmtQty(item.minQty, item.unit)}
          </div>
          <div className="mt-2 text-[10.5px] text-muted">
            {item.currentQty < item.minQty
              ? `${fmtQty(item.minQty - item.currentQty, item.unit)} abaixo do mínimo`
              : `${fmtQty(item.currentQty - item.minQty, item.unit)} acima do mínimo`}
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Custo atual</div>
          <div className="mt-2 num text-[21px] leading-none text-cream">
            {itemCostKnown(item) ? `${money(item.costCents)}/${item.unit}` : 'Não cadastrado'}
          </div>
          <div className="mt-2 text-[10.5px] text-muted">
            {variation
              ? `${variation.variation >= 0 ? '+' : ''}${(variation.variation * 100).toFixed(1)}% em 120 dias`
              : mode === 'production' && priceHistory?.itemId === item.id
                ? priceHistory.loading ? 'carregando histórico…'
                  : priceHistory.error ? 'histórico indisponível' : 'sem histórico suficiente'
                : 'sem histórico suficiente'}
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Valor conhecido em estoque</div>
          <div className="mt-2 num text-[21px] leading-none text-cream">
            {itemCostKnown(item) ? money(itemValueCents(item)) : '—'}
          </div>
          <div className="mt-2 text-[10.5px] text-muted">{itemCostKnown(item) ? 'custo atual × saldo' : 'cadastre o custo para calcular'}</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Fornecedor atual</div>
          <div className="mt-2 truncate text-[13px] text-cream">{primary?.supplier.name ?? '—'}</div>
          <div className="mt-2 text-[10.5px] text-muted">
            {primary ? `prazo médio ${primary.leadTimeDays} dias` : 'cadastre um fornecedor'}
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Última compra</div>
          <div className="mt-2 num text-[15px] leading-none text-cream">
            {lastPurchaseReceipt
              ? `${lastPurchaseReceipt.unitCostCents == null ? '—' : money(lastPurchaseReceipt.unitCostCents)}/${lastPurchaseReceipt.unit}`
              : '—'}
          </div>
          <div className="mt-2 text-[10.5px] text-muted">
            {lastPurchaseReceipt
              ? `${lastPurchaseReceipt.purchase.code} · ${shortDate(lastPurchaseReceipt.receivedAt)}`
              : 'sem compras registradas'}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-5">
          <Panel
            title="Histórico de preço"
            subtitle="Preços registrados nas compras e no histórico do fornecedor."
            actions={
              variation ? (
                <span className={`num text-[11.5px] ${variation.variation > 0 ? 'text-copper' : 'text-dim'}`}>
                  {variation.variation >= 0 ? '+' : ''}
                  {(variation.variation * 100).toFixed(1)}% · 120 dias
                </span>
              ) : null
            }
          >
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="eyebrow">Preço mais recente</div>
                <div className="mt-1.5 num text-[19px] text-cream">
                  {offers[0] && supplierOfferHasPrice(offers[0])
                    ? money(offers[0].lastPriceCents) : itemCostKnown(item) ? money(item.costCents) : '—'}
                  <span className="ml-1 text-[11px] text-dim">/{item.unit}</span>
                </div>
              </div>
              {cheapest && mostExpensive && cheapest.supplierId !== mostExpensive.supplierId ? (
                <div className="text-[10.5px] leading-relaxed text-dim">
                  Menor preço registrado: <span className="text-muted">{cheapest.supplier.name}</span>
                  <br />
                  Diferença para o maior: {' '}
                  <span className="num text-muted">
                    {money(mostExpensive.lastPriceCents - cheapest.lastPriceCents)}/{item.unit}
                  </span>
                </div>
              ) : null}
            </div>
            <PriceChart points={points} />
            {mode === 'production' && priceHistory?.itemId === item.id && priceHistory.error ? (
              <p role="status" className="mt-3 text-[10.5px] text-warn">
                Não foi possível confirmar o histórico de preços: {priceHistory.error}
              </p>
            ) : null}

            <div className="mt-4 scroll-x">
              <table className="table min-w-[560px]">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Origem</th>
                    <th>Fornecedor</th>
                    <th className="text-right">Preço</th>
                    <th className="text-right">Variação</th>
                  </tr>
                </thead>
                <tbody>
                  {[...latestPoints].reverse().map((point, index, array) => {
                    const previous = array[index + 1];
                    const delta = previous
                      ? (point.unitCostCents - previous.unitCostCents) / previous.unitCostCents
                      : 0;
                    const supplier = state.suppliers.find((s) => s.id === point.supplierId);
                    return (
                      <tr key={point.id}>
                        <td className="whitespace-nowrap font-mono text-[11px] text-dim">
                          {date(point.at)}
                        </td>
                        <td className="text-[11.5px] text-muted">
                          {point.source === 'purchase' ? 'Recebimento de compra' : 'Histórico do fornecedor'}
                        </td>
                        <td className="text-[11.5px] text-muted">{supplier?.name ?? '—'}</td>
                        <td className="text-right num text-[12px] text-cream">
                          {money(point.unitCostCents)}
                        </td>
                        <td
                          className={`text-right num text-[11px] ${
                            delta > 0 ? 'text-copper' : delta < 0 ? 'text-ok' : 'text-dim'
                          }`}
                        >
                          {previous ? `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel
            title="Comparativo de fornecedores"
            subtitle="Preço registrado, prazo e pedido mínimo por fornecedor."
            flush
            bodyClassName=""
          >
            {offers.length === 0 ? (
              <EmptyState
                icon={<Truck size={18} />}
                title="Nenhum fornecedor vinculado"
                description="Vincule fornecedores ao insumo para comparar preços e prazos na hora de comprar."
                action={
                  can('suppliers.manage') ? (
                    <Link to="/fornecedores" className="btn btn-ghost">
                      Ver fornecedores
                    </Link>
                  ) : null
                }
              />
            ) : (
              <div className="scroll-x">
                <table className="table min-w-[640px]">
                  <thead>
                    <tr>
                      <th>Fornecedor</th>
                      <th className="text-right">Último preço</th>
                      <th className="text-right">Prazo</th>
                      <th className="text-right">Pedido mínimo</th>
                      <th>Última compra</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {offers.map((offer, index) => (
                      <tr key={offer.id} className="row-link">
                        <td>
                          <Link to={`/fornecedores/${offer.supplierId}`} className="block">
                            <span className="text-[12.5px] text-cream">{offer.supplier.name}</span>
                            {index === 0 ? (
                              <span className="ml-2 text-[9.5px] uppercase tracking-[0.08em] text-copper">
                                menor preço registrado
                              </span>
                            ) : null}
                          </Link>
                        </td>
                        <td className="text-right num text-[12.5px] text-cream">
                          {supplierOfferHasPrice(offer) ? money(offer.lastPriceCents) : '—'}
                          <span className="ml-0.5 text-[10px] text-dim">/{item.unit}</span>
                        </td>
                        <td className="text-right num text-[11.5px] text-muted">
                          {offer.leadTimeDays} dias
                        </td>
                        <td className="text-right num text-[11.5px] text-muted">
                          {money(offer.minOrderCents)}
                        </td>
                        <td className="text-[11px] text-dim">
                          {offer.lastPurchaseAt ? date(offer.lastPurchaseAt) : 'sem registro'}
                        </td>
                        <td className="w-8">
                          <ArrowRight size={13} className="text-dim" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="border-t border-line px-4 py-2.5 text-[10.5px] text-dim">
              O menor preço registrado não considera prazo e pedido mínimo. Compare os três antes de
              decidir.
            </div>
          </Panel>

          <Panel
            title="Movimentações"
            subtitle="Todo saldo tem origem, motivo, usuário e data."
            flush
            bodyClassName=""
            actions={
              can('stock.adjust') ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setMovementOpen(true)}
                >
                  <Plus size={12} />
                  Movimentar
                </button>
              ) : null
            }
          >
            {movementPage.error && movementPage.itemId === item.id ? <div className="px-4 py-2 text-[11px] text-warn">
              Histórico incompleto: {movementPage.error}.
              <button type="button" className="ml-1 underline" onClick={() => setMovementRetry((value) => value + 1)}>Tentar novamente</button>
            </div> : null}
            {movementPage.loading && movementPage.itemId === item.id && movements.length === 0 ? <div role="status" className="px-4 py-3 text-[11px] text-dim">Carregando movimentações…</div> : null}
            <div className="scroll-x">
              <table className="table min-w-[780px]">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Tipo</th>
                    <th className="text-right">Quantidade</th>
                    <th>Motivo</th>
                    <th>Origem</th>
                    <th>Usuário</th>
                    <th className="text-right">Saldo após</th>
                    <th className="w-[58px]" />
                  </tr>
                </thead>
                <tbody>
                  {visibleMovements.map((movement) => {
                    const author = state.users.find((u) => u.id === movement.userId);
                    return (
                      <tr key={movement.id}>
                        <td className="whitespace-nowrap font-mono text-[10.5px] text-dim">
                          {shortDate(movement.occurredAt)} · {time(movement.occurredAt)}
                        </td>
                        <td>
                          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted">
                            {movement.direction === 'in' ? (
                              <MoveUpRight size={12} className="text-ok" />
                            ) : (
                              <MoveDownRight size={12} className="text-dim" />
                            )}
                            {MOVEMENT_LABEL[movement.type]}
                          </span>
                        </td>
                        <td
                          className={`text-right num text-[12px] ${
                            movement.direction === 'in' ? 'text-ok' : 'text-cream'
                          }`}
                        >
                          {movement.direction === 'in' ? '+' : '−'}
                          {fmtQty(movement.qty, movement.unit)}
                        </td>
                        <td className="max-w-[220px] text-[11.5px] text-muted">{movement.reason}</td>
                        <td className="max-w-[180px] truncate text-[10.5px] text-dim">
                          {movement.origin}
                        </td>
                        <td className="text-[11px] text-dim">
                          {author?.name ?? (movement.userId === 'u-sistema' ? 'DACOT Pedidos' : '—')}
                        </td>
                        <td className="text-right num text-[11.5px] text-muted">
                          {fmtQty(movement.balanceAfter, movement.unit)}
                        </td>
                        <td className="text-right">
                          {can('stock.adjust') && movement.canReverse && !movement.reversedByMovementId ? (
                            <button type="button" className="text-dim hover:text-copper"
                              aria-label={`Estornar ${MOVEMENT_LABEL[movement.type]}`}
                              title="Estornar movimentação"
                              onClick={() => { setReversalTarget(movement.id); setReversalReason(''); }}>
                              <RotateCcw size={13} />
                            </button>
                          ) : movement.reversedByMovementId ? (
                            <span className="text-[10px] text-dim" title="Possui estorno compensatório">Estornada</span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {movements.length > 12 || (mode === 'production' && movementPage.itemId === item.id && movementPage.hasMore) ? (
              <div className="border-t border-line px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {movements.length > 12 ? <button type="button" className="text-[11px] text-dim hover:text-cream"
                    onClick={() => setShowAll((previous) => !previous)}>
                    {showAll ? 'Mostrar menos' : mode === 'production'
                      ? 'Mostrar movimentações carregadas' : `Mostrar todas as ${movements.length} movimentações`}
                  </button> : null}
                  {mode === 'production' && movementPage.itemId === item.id && movementPage.hasMore && showAll ? (
                    <button type="button" className="text-[11px] text-copper hover:text-cream"
                      disabled={movementPage.loading} onClick={loadMoreMovements}>
                      {movementPage.loading ? 'Carregando…' : 'Carregar movimentações mais antigas'}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </Panel>

          <Panel
            title="Fichas técnicas que usam este insumo"
            subtitle="O custo do prato é recalculado com o custo atual deste item."
            flush
            bodyClassName=""
          >
            {usedIn.length === 0 ? (
              <EmptyState
                icon={<BookOpen size={18} />}
                title="Nenhuma ficha usa este insumo"
                description="Vincule o insumo a uma ficha técnica para calcular o custo dos pratos vendidos."
                action={
                  can('recipes.view') ? (
                    <Link to="/fichas" className="btn btn-ghost">
                      Ver fichas técnicas
                    </Link>
                  ) : null
                }
              />
            ) : (
              <div className="divide-y divide-line">
                {usedIn.map((recipe) => {
                  const ingredient = recipe.ingredients.find((i) => i.itemId === item.id);
                  return (
                    <Link
                      key={recipe.id}
                      to={`/fichas/${recipe.id}`}
                      className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-raised/50"
                    >
                      <div>
                        <div className="text-[12.5px] text-cream">{recipe.name}</div>
                        <div className="mt-0.5 text-[10.5px] text-dim">
                          {ingredient
                            ? `${fmtQty(ingredient.qty, ingredient.unit)} por porção`
                            : '—'}
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <div className="num text-[11.5px] text-muted">
                            {money(recipe.salePriceCents)}
                          </div>
                          <div className="text-[9.5px] uppercase tracking-[0.08em] text-dim">
                            venda
                          </div>
                        </div>
                        <ArrowRight size={13} className="text-dim" />
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
            {mode === 'production' && auditHasMore ? (
              <div className="border-t border-line px-4 py-2.5">
                <button type="button" className="text-[10px] text-copper hover:text-copper-hi disabled:opacity-50"
                  onClick={() => { setShowAllAudit(true); void actions.loadMoreAudit(); }} disabled={auditLoading}>
                  {auditLoading ? 'Carregando…' : 'Carregar auditoria anterior'}
                </button>
              </div>
            ) : null}
          </Panel>
        </div>

        <div className="flex flex-col gap-5">
          <Panel
            title="Decisão de compra"
            subtitle={recommendation?.basis === 'minimum' ? 'Reposição para recompor o estoque mínimo.' : 'Cálculo transparente com consumo recente.'}
          >
            {recommendation ? (
              <>
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <span className="text-[11px] text-muted">Quantidade sugerida</span>
                  <span className="num text-[20px] text-copper">
                    {fmtQty(recommendation.recommendedQty, item.unit)}
                  </span>
                </div>
                <div className="divide-y divide-line border-y border-line text-[11.5px]">
                  <div className="flex items-center justify-between py-2">
                    <span className="text-muted">{recommendation.basis === 'minimum' ? 'Estoque mínimo' : 'Consumo médio'}</span>
                    <span className="num text-cream">
                      {recommendation.basis === 'minimum'
                        ? `${fmtQty(item.minQty)} ${item.unit}`
                        : `${fmtQty(recommendation.avgDaily)} ${item.unit}/dia`}
                    </span>
                  </div>
                  {recommendation.basis === 'consumption' ? <div className="flex items-center justify-between py-2">
                    <span className="text-muted">Horizonte base do cálculo</span>
                    <span className="num text-cream">{recommendation.coverageDays} dias</span>
                  </div> : null}
                  {recommendation.basis === 'consumption' ? <div className="flex items-center justify-between py-2">
                    <span className="text-muted">Estoque de segurança</span>
                    <span className="num text-cream">
                      {fmtQty(recommendation.safetyQty, item.unit)}
                    </span>
                  </div> : null}
                  <div className="flex items-center justify-between py-2">
                    <span className="text-muted">Estoque atual</span>
                    <span className="num text-cream">− {fmtQty(item.currentQty, item.unit)}</span>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span className="text-muted">Custo estimado</span>
                    <span className="num text-cream">{recommendation.estimatedCostCents == null ? '—' : money(recommendation.estimatedCostCents)}</span>
                  </div>
                </div>
                <p className="mt-2.5 font-mono text-[9.5px] leading-relaxed text-dim">
                  {recommendation.formula}
                </p>
                <p className="mt-2 text-[10.5px] text-dim">
                  {recommendation.basis === 'minimum'
                    ? 'Quantidade calculada para recompor o estoque mínimo; não representa previsão de consumo.'
                    : `${recommendation.item.currentQty <= 0 ? 'Sem saldo disponível' : `Saldo atual cobre cerca de ${recommendation.daysRemaining < 1 ? 'menos de 1 dia' : `${Math.round(recommendation.daysRemaining)} dias`} ao consumo médio`}. Prazo do fornecedor: ${recommendation.leadTimeDays} dias.`}
                </p>
                {can('purchases.manage') ? (
                  <Link to={`/compras?${new URLSearchParams({ novo: '1', item: item.id, qty: String(recommendation.recommendedQty), ...(primary?.supplierId ? { supplier: primary.supplierId } : {}) }).toString()}`} className="btn btn-ghost mt-3 w-full">
                    <ClipboardList size={13} />
                    Planejar pedido de compra
                  </Link>
                ) : null}
              </>
            ) : (
              <>
                <p className="text-[12px] leading-relaxed text-muted">
                  Não há reposição recomendada pelos critérios atuais. Com histórico registrado, o cálculo considera consumo recente.
                </p>
                <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                  <span className="text-[11px] text-dim">Situação do mínimo</span>
                  <span className="num text-[13px] text-cream">
                    {item.currentQty < item.minQty ? 'abaixo' : 'atendido'}
                  </span>
                </div>
              </>
            )}
          </Panel>

          <Panel title="Últimos preços por fornecedor" flush bodyClassName="">
            <div className="divide-y divide-line">
              {offers.slice(0, 3).map((offer) => (
                <div key={offer.id} className="flex items-center justify-between px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-[11.5px] text-muted">{offer.supplier.name}</div>
                    <div className="mt-0.5 text-[10px] text-dim">
                      prazo {offer.leadTimeDays}d · última compra{' '}
                      {offer.lastPurchaseAt ? shortDate(offer.lastPurchaseAt) : '—'}
                    </div>
                  </div>
                  <span className="num ml-3 shrink-0 text-[12px] text-cream">
                    {money(offer.lastPriceCents)}
                  </span>
                </div>
              ))}
            </div>
            {primary ? (
              <div className="border-t border-line px-4 py-2.5">
                <Link
                  to={`/fornecedores/${primary.supplierId}`}
                  className="flex items-center justify-between text-[11px] text-copper hover:text-copper-hi"
                >
                  Abrir fornecedor atual
                  <ArrowRight size={12} />
                </Link>
              </div>
            ) : null}
          </Panel>

          <Panel title="Auditoria do insumo" subtitle="Alterações que afetam saldo ou custo." flush bodyClassName="">
            {itemAudit.length === 0 ? (
              <div className="px-4 py-4 text-[11px] leading-relaxed text-dim">
                Nenhum evento de auditoria registrado para este insumo. Ajustes, perdas e
                recebimentos aparecem aqui.
              </div>
            ) : (
              <div className="divide-y divide-line">
                {itemAudit.map((entry) => {
                  const author = state.users.find((u) => u.id === entry.userId);
                  return (
                    <div key={entry.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-cream">{author?.name ?? 'Sistema'}</span>
                        <span className="font-mono text-[9.5px] text-dim">
                          {shortDate(entry.at)} {time(entry.at)}
                        </span>
                      </div>
                      <div className="mt-1 text-[10.5px] leading-relaxed text-muted">
                        {entry.before ? `${entry.before} → ` : ''}
                        <span className="text-muted">{entry.after}</span>
                      </div>
                      <div className="mt-0.5 text-[9.5px] text-dim">{entry.reason}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          <ToneNote>
            <span className="text-muted">Estoque teórico × real.</span> O saldo deste insumo considera
            apenas movimentações registradas. A contagem física é comparada a ele e gera ajustes
            auditáveis.
          </ToneNote>
        </div>
      </div>

      <Drawer
        open={movementOpen}
        onClose={() => setMovementOpen(false)}
        eyebrow={item.name}
        title="Registrar movimentação"
        description="A alteração entra no histórico com o saldo resultante."
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setMovementOpen(false)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" onClick={submitMovement} disabled={!validMovementDraft}>
              Confirmar movimentação
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-px border border-line bg-line">
            {(
              [
                ['in', 'Entrada'],
                ['out', 'Saída'],
                ['adjust', 'Ajuste'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setKind(value)}
                className={`px-2 py-2.5 text-[11.5px] transition-colors ${
                  kind === value ? 'bg-raised text-cream' : 'bg-panel text-dim hover:text-muted'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label={kind === 'adjust' ? 'Saldo contado' : 'Quantidade'}
              htmlFor="mov-qty"
              hint={
                kind === 'adjust'
                  ? `Saldo atual: ${fmtQty(item.currentQty, item.unit)}`
                  : `Disponível: ${fmtQty(item.currentQty, item.unit)}`
              }
            >
              <div className="relative">
                <input
                  id="mov-qty"
                  className="input num pr-10"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  placeholder="0"
                  aria-invalid={quantity.trim().length > 0 && parsedMovementQty == null}
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[11px] text-dim">
                  {item.unit}
                </span>
              </div>
              {quantity.trim().length > 0 && parsedMovementQty == null ? <p role="alert" className="mt-1 text-[10.5px] text-danger">Informe uma quantidade válida, positiva e com até 3 casas decimais.</p> : null}
              {kind === 'out' && typedQty > item.currentQty + 0.0001 ? <p role="alert" className="mt-1 text-[10.5px] text-danger">A saída excede o saldo disponível.</p> : null}
            </Field>
            <Field label="Resultado" hint="Saldo após a movimentação">
              <div className="flex h-9 items-center justify-between border border-line bg-[#0b0b0a] px-2.5">
                <span className={`num text-[13px] ${adjustPreview < 0 ? 'text-danger' : 'text-cream'}`}>
                  {fmtQty(adjustPreview, item.unit)}
                </span>
                {kind !== 'adjust' && typedQty > 0
                  ? movementEstimate == null
                    ? <span className="text-[10px] text-warn">Custo não cadastrado</span>
                    : <Money cents={movementEstimate} className="text-[10.5px] text-dim" />
                  : null}
              </div>
            </Field>
          </div>

          <Field label="Motivo" htmlFor="mov-reason" hint="Obrigatório para auditoria.">
            <input
              id="mov-reason"
              className="input"
              required
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={
                kind === 'in'
                  ? 'Ex.: compra avulsa, devolução'
                  : kind === 'out'
                    ? 'Ex.: uso interno, transferência'
                    : 'Ex.: contagem física, correção de cadastro'
              }
            />
          </Field>

          <div className="border border-line bg-[#0b0b0a] px-3 py-2.5 text-[10.5px] leading-relaxed text-dim">
            <span className="text-muted">{item.name}</span> · {kind === 'in' ? 'entrada' : kind === 'out' ? 'saída' : 'ajuste de inventário'}.
            O saldo anterior é preservado como histórico; nada é sobrescrito.
          </div>
        </div>
      </Drawer>

      <Drawer
        open={editOpen}
        onClose={() => setEditOpen(false)}
        eyebrow="Estoque / Cadastro"
        title="Editar insumo"
        description="Atualize os dados operacionais e mantenha o histórico de estoque preservado."
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setEditOpen(false)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" onClick={saveEdit} disabled={!editName.trim() || parseConversionDrafts(editConversions) === null}>
              Salvar alterações
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Nome do insumo" htmlFor="edit-item-name">
            <input id="edit-item-name" className="input" value={editName} onChange={(e) => setEditName(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Categoria" htmlFor="edit-item-category">
              <select id="edit-item-category" className="input" value={editCategory} onChange={(e) => setEditCategory(e.target.value as (typeof CATEGORIES)[number])}>
                {CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}
              </select>
            </Field>
            <Field label={`Estoque mínimo (${item.unit})`} htmlFor="edit-item-min">
              <input id="edit-item-min" className="input num" inputMode="decimal" value={editMinQty} onChange={(e) => setEditMinQty(e.target.value)} />
            </Field>
          </div>
          <ConversionEditor baseUnit={item.unit as Unit} value={editConversions} onChange={setEditConversions} />
          <div className="grid grid-cols-2 gap-3">
            <Field label={`Custo atual / ${item.unit}`} htmlFor="edit-item-cost">
              <input id="edit-item-cost" className="input num" inputMode="decimal" value={editCost} onChange={(e) => setEditCost(e.target.value)} />
            </Field>
            <Field label="Fornecedor principal" htmlFor="edit-item-supplier">
              <select id="edit-item-supplier" className="input" value={editSupplier} onChange={(e) => {
                const nextId = e.target.value;
                setEditSupplier(nextId);
                const selected = supplierOptions.find((supplier) => supplier.id === nextId);
                if (selected) actions.cacheSupplier(selected);
              }}>
                <option value="">Não definido</option>
                {supplierOptions.filter((supplier) => supplier.active !== false).map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                ))}
              </select>
            </Field>
          </div>
          {mode === 'production' && supplierOptionsHasMore ? <button type="button"
            className="text-left text-[10.5px] text-copper hover:text-cream" disabled={supplierOptionsLoadingMore}
            onClick={loadMoreSuppliers}>{supplierOptionsLoadingMore ? 'Carregando fornecedores…' : 'Carregar mais fornecedores'}</button> : null}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Código interno" htmlFor="edit-item-code">
              <input id="edit-item-code" className="input" value={editInternalCode} onChange={(e) => setEditInternalCode(e.target.value)} />
            </Field>
            <Field label="Código de barras" htmlFor="edit-item-barcode">
              <input id="edit-item-barcode" className="input" value={editBarcode} onChange={(e) => setEditBarcode(e.target.value)} />
            </Field>
          </div>
          <Field label="Observações" htmlFor="edit-item-notes">
            <textarea id="edit-item-notes" className="input min-h-20 resize-y" value={editNotes} onChange={(e) => setEditNotes(e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 border border-line bg-[#0b0b0a] px-3 py-2.5 text-[12px] text-muted">
            <input type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} />
            Insumo ativo
          </label>
        </div>
      </Drawer>

      <Dialog
        open={reversalTarget !== null}
        onClose={() => setReversalTarget(null)}
        title="Estornar movimentação"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setReversalTarget(null)}>Cancelar</button>
            <button type="button" className="btn btn-primary" disabled={reversalReason.trim().length < 3}
              onClick={async () => {
                if (!reversalTarget) return;
                const ok = await actions.reverseMovement(reversalTarget, reversalReason);
                if (ok) { setReversalTarget(null); setReversalReason(''); }
              }}>
              Confirmar estorno
            </button>
          </>
        }
      >
        <p className="mb-3 text-[12px] leading-relaxed text-muted">
          O sistema criará uma movimentação compensatória e manterá o lançamento original no histórico.
          A operação depende do saldo atual disponível.
        </p>
        <Field label="Motivo do estorno" htmlFor="movement-reversal-reason">
          <textarea id="movement-reversal-reason" className="input min-h-20 resize-y" maxLength={300}
            value={reversalReason} onChange={(event) => setReversalReason(event.target.value)} />
        </Field>
      </Dialog>

      <Dialog
        open={confirmAdjust}
        onClose={() => setConfirmAdjust(false)}
        title="Confirmar ajuste de inventário"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmAdjust(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!validMovementDraft}
              onClick={async () => {
                const ok = await actions.recordMovement({
                  itemId: item.id,
                  kind: 'adjust',
                  qty: Math.round((Number(quantity.replace(',', '.')) || 0) * 1000) / 1000,
                  reason,
                });
                if (ok) {
                  setConfirmAdjust(false);
                  setMovementOpen(false);
                  setQuantity('');
                  setReason('');
                }
              }}
            >
              Ajustar estoque
            </button>
          </>
        }
      >
        O saldo de <span className="text-cream">{item.name}</span> passará de{' '}
        <span className="num text-cream">{fmtQty(item.currentQty, item.unit)}</span> para{' '}
        <span className="num text-cream">{fmtQty(adjustPreview, item.unit)}</span>. Um ajuste de
        inventário será registrado com seu usuário e o motivo informado.
      </Dialog>
    </div>
  );
}
