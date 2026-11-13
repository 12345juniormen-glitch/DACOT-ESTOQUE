import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { purchaseTotalCents } from '../domain/selectors';
import { suggestedPurchaseUnitCostCents } from '../domain/purchase-suggestions';
import { date, money, moneyInput, parseOptionalNonNegativeMoney, parseQty, quantityFactorToBase, qty as fmtQty, shortDate } from '../domain/format';
import {
  PURCHASE_STATUS_LABEL,
  type Purchase, type PurchaseStatus, type Supplier, type Unit,
} from '../domain/types';
import { fetchApiIngredient, fetchApiInventoryPage, fetchApiPurchase, fetchApiPurchasePage, fetchApiSupplierPage,
  fetchApiSuppliersByIds } from '../lib/api';
import {
  Drawer,
  EmptyState,
  Field,
  PageHeader,
  Panel,
  PurchaseStatusTag,
} from '../components/ui';

const STATUS_TABS: ('all' | PurchaseStatus)[] = [
  'all',
  'draft',
  'requested',
  'partial',
  'received',
  'cancelled',
];

const conversionFactor = (item: { unit: Unit; conversions?: Record<string, number> }, unit: Unit) =>
  quantityFactorToBase(unit, item.unit, item.conversions);

function purchaseUnits(item: { unit: Unit; conversions?: Record<string, number> }): Unit[] {
  const candidates: Unit[] = item.unit === 'kg' ? ['kg', 'g'] : item.unit === 'g' ? ['g', 'kg']
    : item.unit === 'L' ? ['L', 'ml'] : item.unit === 'ml' ? ['ml', 'L'] : ['un'];
  const custom = Object.keys(item.conversions ?? {}) as Unit[];
  return [...new Set([...candidates, ...custom])]
    .filter((unit) => conversionFactor(item, unit) != null);
}

export function PurchasesPage() {
  const { state, actions, can, notify, mode } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<'all' | PurchaseStatus>('all');
  const [purchaseListRefresh, setPurchaseListRefresh] = useState(0);
  const [serverPage, setServerPage] = useState<{
    filter: 'all' | PurchaseStatus; purchases: Purchase[]; loading: boolean;
    hasMore: boolean; error: string | null;
  }>({ filter: 'all', purchases: [], loading: false, hasMore: false, error: null });
  const [drawerOpen, setDrawerOpen] = useState(params.get('novo') === '1');
  const [editingPurchaseId, setEditingPurchaseId] = useState<string | null>(null);
  const purchaseFetchRef = useRef<string | null>(null);
  const prefillFetchRef = useRef<string | null>(null);
  const [prefillReadyKey, setPrefillReadyKey] = useState<string | null>(null);
  const [supplierOptions, setSupplierOptions] = useState(state.suppliers);
  const [supplierOptionsHasMore, setSupplierOptionsHasMore] = useState(false);
  const [supplierOptionsLoadingMore, setSupplierOptionsLoadingMore] = useState(false);
  const [supplierNames, setSupplierNames] = useState<Record<string, Supplier>>({});
  const [ingredientOptions, setIngredientOptions] = useState(state.items);
  const [ingredientSearch, setIngredientSearch] = useState('');
  const [ingredientOptionsLoading, setIngredientOptionsLoading] = useState(false);
  const [ingredientOptionsError, setIngredientOptionsError] = useState<string | null>(null);

  const [supplierId, setSupplierId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [note, setNote] = useState('');
  const [itemId, setItemId] = useState('');
  const [lineUnit, setLineUnit] = useState<Unit>('un');
  const [qtyText, setQtyText] = useState('');
  const [priceText, setPriceText] = useState('');
  const [lines, setLines] = useState<
    { itemId: string; unit: Unit; qtyOrdered: number; expectedUnitCostCents: number }[]
  >([]);

  useEffect(() => {
    if (mode !== 'production') return;
    let current = true;
    setServerPage({ filter, purchases: [], loading: true, hasMore: false, error: null });
    void (async () => {
      const page = await fetchApiPurchasePage(filter, 0);
      const suppliers = await fetchApiSuppliersByIds(page.purchases.map((purchase) => purchase.supplierId));
      if (current) setServerPage({ filter, purchases: page.purchases, loading: false,
        hasMore: page.hasMore, error: null });
      if (current) setSupplierNames((previous) => ({ ...previous,
        ...Object.fromEntries(suppliers.map((supplier) => [supplier.id, supplier])) }));
    })().catch((error: unknown) => {
      if (current) setServerPage({ filter, purchases: [], loading: false, hasMore: false,
        error: error instanceof Error ? error.message : 'Não foi possível carregar os pedidos.' });
    });
    return () => { current = false; };
  }, [filter, mode, purchaseListRefresh, state.purchases]);

  useEffect(() => {
    if (!drawerOpen || mode !== 'production') return;
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
  }, [drawerOpen, mode, notify]);

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
    if (!drawerOpen) return;
    if (mode !== 'production') {
      setIngredientOptions(state.items.filter((item) => item.active !== false));
      setIngredientOptionsError(null);
      return;
    }
    let current = true;
    const timer = window.setTimeout(() => {
      setIngredientOptionsLoading(true);
      setIngredientOptionsError(null);
      void fetchApiInventoryPage({ search: ingredientSearch, category: null, status: null, sort: 'name' },
        0, 50, true).then((page) => {
          if (current) setIngredientOptions(page.items);
        }).catch((error: unknown) => {
          if (current) setIngredientOptionsError(error instanceof Error
            ? error.message : 'Não foi possível buscar insumos.');
        }).finally(() => {
          if (current) setIngredientOptionsLoading(false);
        });
    }, ingredientSearch.trim() ? 250 : 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [drawerOpen, mode, ingredientSearch, state.restaurant.id]);

  useEffect(() => {
    const editId = params.get('editar');
    if (mode !== 'production' || !editId || state.purchases.some((purchase) => purchase.id === editId)
        || purchaseFetchRef.current === editId) return;
    purchaseFetchRef.current = editId;
    void fetchApiPurchase(editId).then((purchase) => actions.cachePurchase(purchase))
      .catch((error: unknown) => {
        notify(error instanceof Error ? error.message : 'Rascunho não encontrado.', 'error');
        const nextParams = new URLSearchParams(params);
        nextParams.delete('editar');
        setParams(nextParams, { replace: true });
      })
      .finally(() => { purchaseFetchRef.current = null; });
  }, [mode, params, setParams, state.purchases, actions, notify]);

  useEffect(() => {
    const itemParam = params.get('item');
    const prefillKey = itemParam ? `${state.restaurant.id}:${itemParam}` : null;
    if (mode !== 'production' || params.get('novo') !== '1' || !itemParam
        || prefillReadyKey === prefillKey || prefillFetchRef.current === prefillKey) return;
    prefillFetchRef.current = prefillKey;
    let current = true;
    void (async () => {
      try {
        const item = state.items.find((entry) => entry.id === itemParam) ?? await fetchApiIngredient(itemParam);
        if (item.restaurantId !== state.restaurant.id) throw new Error('O insumo não pertence ao restaurante ativo.');
        if (item.active === false) throw new Error('O insumo recomendado está inativo.');
        const supplierIds = [...new Set([params.get('supplier'), item.primarySupplierId]
          .filter((value): value is string => !!value))];
        let suppliers: Supplier[] = [];
        if (supplierIds.length) {
          try {
            suppliers = await fetchApiSuppliersByIds(supplierIds);
            if (suppliers.some((supplier) => supplier.restaurantId !== state.restaurant.id)) {
              throw new Error('A API retornou um fornecedor de outro restaurante.');
            }
          } catch (error) {
            suppliers = [];
            if (current) notify(error instanceof Error
              ? `O insumo foi carregado, mas o fornecedor não (${error.message}).`
              : 'O insumo foi carregado, mas o fornecedor não. Selecione-o novamente.', 'error');
          }
        }
        if (!current) return;
        actions.cacheIngredients([item]);
        actions.cacheSuppliers(suppliers);
        setPrefillReadyKey(prefillKey);
      } catch (error) {
        if (!current) return;
        notify(error instanceof Error ? error.message : 'Não foi possível carregar o insumo recomendado.', 'error');
        const nextParams = new URLSearchParams(params);
        ['item', 'qty', 'supplier'].forEach((key) => nextParams.delete(key));
        setParams(nextParams, { replace: true });
      } finally {
        if (prefillFetchRef.current === prefillKey) prefillFetchRef.current = null;
      }
    })();
    return () => { current = false; };
  }, [mode, params, setParams, state.items, state.restaurant.id, actions, notify, prefillReadyKey]);

  const counts = useMemo(() => {
    if (mode === 'production' && state.purchaseStatusCounts) {
      const values = state.purchaseStatusCounts;
      return { all: Object.values(values).reduce((sum, count) => sum + (count ?? 0), 0),
        draft: values.draft ?? 0, requested: values.requested ?? 0, partial: values.partial ?? 0,
        received: values.received ?? 0, cancelled: values.cancelled ?? 0 };
    }
    const base: Record<'all' | PurchaseStatus, number> = {
      all: state.purchases.length,
      draft: 0,
      requested: 0,
      partial: 0,
      received: 0,
      cancelled: 0,
    };
    for (const purchase of state.purchases) base[purchase.status] += 1;
    return base;
  }, [state.purchases, state.purchaseStatusCounts, mode]);
  const hasAnyPurchases = counts.all > 0;

  const purchases = useMemo(() => {
    if (mode === 'production') {
      return serverPage.filter === filter ? serverPage.purchases : [];
    }
    const list =
      filter === 'all'
        ? state.purchases
        : state.purchases.filter((purchase) => purchase.status === filter);
    return [...list].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [state.purchases, filter, mode, serverPage]);

  const pinnedIngredientIds = new Set([itemId, ...lines.map((line) => line.itemId)].filter(Boolean));
  const pinnedIngredients = state.items.filter((item) => pinnedIngredientIds.has(item.id));
  const selectableIngredients = mode === 'production'
    ? [...pinnedIngredients, ...ingredientOptions.filter((item) => !pinnedIngredientIds.has(item.id))]
    : ingredientOptions;

  const loadMorePurchases = async () => {
    if (mode !== 'production' || serverPage.filter !== filter || serverPage.loading || !serverPage.hasMore) return;
    setServerPage((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const page = await fetchApiPurchasePage(filter, serverPage.purchases.length);
      const suppliers = await fetchApiSuppliersByIds(page.purchases.map((purchase) => purchase.supplierId));
      setSupplierNames((previous) => ({ ...previous,
        ...Object.fromEntries(suppliers.map((supplier) => [supplier.id, supplier])) }));
      setServerPage((previous) => previous.filter === filter ? ({
        ...previous, purchases: [...previous.purchases, ...page.purchases],
        loading: false, hasMore: page.hasMore, error: null,
      }) : previous);
    } catch (error) {
      setServerPage((previous) => previous.filter === filter ? ({
        ...previous, loading: false,
        error: error instanceof Error ? error.message : 'Não foi possível carregar mais pedidos.',
      }) : previous);
    }
  };

  useEffect(() => {
    const editId = params.get('editar');
    const prefillItemId = params.get('item');
    const requestedPrefillKey = prefillItemId ? `${state.restaurant.id}:${prefillItemId}` : null;
    if (editId && mode === 'production' && !state.purchases.some((purchase) => purchase.id === editId)
        && purchaseFetchRef.current === editId) return;
    if (!editId && mode === 'production' && params.get('novo') === '1' && prefillItemId
        && prefillReadyKey !== requestedPrefillKey) return;
    if (editId) {
      const purchase = state.purchases.find((entry) => entry.id === editId);
      if (purchase?.status === 'draft') {
        setEditingPurchaseId(purchase.id);
        setDrawerOpen(true);
        setSupplierId(purchase.supplierId);
        setExpectedDate(purchase.expectedDeliveryAt?.slice(0, 10) ?? '');
        setNote(purchase.note);
        setItemId(''); setQtyText(''); setPriceText('');
        setLines(purchase.lines.map((line) => ({
          itemId: line.itemId,
          unit: line.unit ?? state.items.find((item) => item.id === line.itemId)?.unit ?? 'un',
          qtyOrdered: line.qtyOrdered,
          expectedUnitCostCents: line.expectedUnitCostCents,
        })));
      } else {
        notify(purchase ? 'Somente rascunhos podem ser editados.' : 'Rascunho não encontrado.', 'error');
      }
    } else if (params.get('novo') === '1') {
      setEditingPurchaseId(null);
      setDrawerOpen(true);
      const requestedItem = state.items.find((item) => item.id === params.get('item') && item.active !== false);
      const requestedQty = parseQty(params.get('qty') ?? '');
      if (requestedItem && requestedQty > 0) {
        const requestedSupplierId = params.get('supplier');
        const activeSupplier = state.suppliers.find(
          (supplier) => supplier.id === requestedSupplierId && supplier.active !== false,
        );
        const primarySupplier = state.suppliers.find(
          (supplier) => supplier.id === requestedItem.primarySupplierId && supplier.active !== false,
        );
        const nextSupplierId = activeSupplier?.id ?? primarySupplier?.id ?? '';
        setSupplierId(nextSupplierId);
        setItemId(requestedItem.id);
        setLineUnit(requestedItem.unit);
        setQtyText(String(requestedQty));
        const suggestion = suggestedPrice(requestedItem.id, nextSupplierId, requestedItem.unit, requestedItem);
        setPriceText(suggestion == null ? '' : moneyInput(suggestion));
        if (suggestion != null) {
          setLines([{
            itemId: requestedItem.id,
            unit: requestedItem.unit,
            qtyOrdered: requestedQty,
            expectedUnitCostCents: suggestion,
          }]);
        } else {
          setLines([]);
        }
      }
    }
    if (editId || params.get('novo') === '1') {
      const nextParams = new URLSearchParams(params);
      ['novo', 'editar', 'item', 'qty', 'supplier'].forEach((key) => nextParams.delete(key));
      setParams(nextParams, { replace: true });
    }
  }, [params, setParams, mode, prefillReadyKey, state.restaurant.id, state.items, state.suppliers, state.supplierItems, state.purchases, notify]);

  const totalDraft = lines.reduce(
    (sum, line) => sum + Math.round(line.qtyOrdered * line.expectedUnitCostCents),
    0,
  );

  const suggestedPrice = (nextItemId: string, nextSupplierId: string, unit?: Unit,
    candidateItem?: (typeof state.items)[number]) => {
    const item = candidateItem ?? state.items.find((i) => i.id === nextItemId);
    return suggestedPurchaseUnitCostCents({ restaurantId: state.restaurant.id, item,
      supplierId: nextSupplierId, supplierItems: state.supplierItems, unit: unit ?? item?.unit ?? 'un' });
  };

  const applyPriceSuggestion = (nextItemId: string, nextSupplierId: string, unit: Unit,
    candidateItem?: (typeof state.items)[number]) => {
    const suggestion = suggestedPrice(nextItemId, nextSupplierId, unit, candidateItem);
    setPriceText(suggestion == null ? '' : moneyInput(suggestion));
  };

  const resetForm = () => {
    setEditingPurchaseId(null);
    setSupplierId('');
    setExpectedDate('');
    setNote('');
    setItemId('');
    setLineUnit('un');
    setQtyText('');
    setPriceText('');
    setLines([]);
  };

  const addLine = () => {
    if (!itemId || parseQty(qtyText) <= 0) return;
    if (lines.some((line) => line.itemId === itemId)) return;
    const suggestion = suggestedPrice(itemId, supplierId, lineUnit);
    const parsedPrice = parseOptionalNonNegativeMoney(priceText);
    if (parsedPrice == null) {
      notify('Informe um preço estimado válido, igual ou maior que zero.', 'error');
      return;
    }
    if (!parsedPrice.known && suggestion == null) {
      notify('Informe o preço estimado; use zero somente se o preço confirmado for R$ 0,00.', 'error');
      return;
    }
    const expectedPrice = parsedPrice.known ? parsedPrice.cents : suggestion!;
    setLines((prev) => [
      ...prev,
      {
        itemId,
        unit: lineUnit,
        qtyOrdered: parseQty(qtyText),
        expectedUnitCostCents: expectedPrice,
      },
    ]);
    setItemId('');
    setQtyText('');
    setPriceText('');
  };

  const submit = async () => {
    const input = {
      supplierId,
      expectedDeliveryAt: expectedDate ? `${expectedDate}T12:00:00-03:00` : null,
      note,
      lines,
    };
    if (editingPurchaseId) {
      const ok = await actions.updatePurchase(editingPurchaseId, input);
      if (!ok) return;
      setDrawerOpen(false);
      resetForm();
      navigate(`/compras/${editingPurchaseId}`);
      return;
    }
    const id = await actions.createPurchase(input);
    if (id) {
      setDrawerOpen(false);
      resetForm();
      navigate(`/compras/${id}`);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="04 / Compras"
        title="Compras"
        description="Acompanhe entregas pendentes e confirme o que chegou."
        actions={
          can('purchases.manage') ? (
            <button type="button" className="btn btn-primary" onClick={() => { resetForm(); setDrawerOpen(true); }}>
              <Plus size={14} />
              Novo pedido
            </button>
          ) : null
        }
      />

      <Panel flush bodyClassName="">
        <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
          {STATUS_TABS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`filter-tab ${filter === key ? 'filter-tab-active' : ''}`}
            >
              {key === 'all' ? 'Todos' : PURCHASE_STATUS_LABEL[key]}
              <span className="font-mono text-[10px] text-dim">{counts[key]}</span>
            </button>
          ))}
        </div>

        {mode === 'production' && (serverPage.filter !== filter || serverPage.loading)
          && purchases.length === 0 ? (
          <div role="status" aria-live="polite" className="px-4 py-10 text-center text-[12px] text-dim">
            Carregando pedidos…
          </div>
        ) : mode === 'production' && serverPage.filter === filter && serverPage.error
          && purchases.length === 0 ? (
          <div role="alert" className="px-4 py-8 text-center">
            <p className="text-[12px] text-muted">{serverPage.error}</p>
            <button type="button" className="btn btn-ghost mt-3"
              onClick={() => setPurchaseListRefresh((value) => value + 1)}>
              Tentar novamente
            </button>
          </div>
        ) : purchases.length === 0 ? (
          <EmptyState
            icon={<ShoppingCart size={18} />}
            title={!hasAnyPurchases ? 'Nenhum pedido de compra ainda' : 'Nenhum pedido neste status'}
            description={
              !hasAnyPurchases
                ? 'Crie o primeiro pedido para acompanhar entrega, preço real e entrada no estoque.'
                : 'Altere o filtro para ver pedidos em outros estágios.'
            }
            action={
              can('purchases.manage') && !hasAnyPurchases ? (
                <button type="button" className="btn btn-primary" onClick={() => { resetForm(); setDrawerOpen(true); }}>
                  Criar primeiro pedido
                </button>
              ) : null
            }
          />
        ) : (
          <>
            <div className="scroll-x hidden md:block">
              <table className="table min-w-[620px]">
                <thead>
                  <tr>
                    <th>Pedido</th>
                    <th>Fornecedor</th>
                    <th>Situação</th>
                    <th className="text-right">Total</th>
                    <th>Previsão</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {purchases.map((purchase) => {
                    const supplier = supplierNames[purchase.supplierId]
                      ?? state.suppliers.find((s) => s.id === purchase.supplierId);
                    return (
                      <tr key={purchase.id} className="row-link">
                        <td>
                          <Link to={`/compras/${purchase.id}`} className="block">
                            <div className="num text-[12.5px] text-cream">{purchase.code}</div>
                            <div className="mt-0.5 text-[10.5px] text-dim">
                              {purchase.note ? purchase.note.slice(0, 34) : 'sem observações'}
                            </div>
                          </Link>
                        </td>
                        <td className="text-[12px] text-muted">{supplier?.name ?? '—'}</td>
                        <td>
                          <PurchaseStatusTag status={purchase.status} />
                        </td>
                        <td className="text-right num text-[12.5px] text-cream">
                          {money(purchaseTotalCents(purchase))}
                        </td>
                        <td className="whitespace-nowrap font-mono text-[10.5px] text-muted">
                          {purchase.expectedDeliveryAt ? date(purchase.expectedDeliveryAt) : '—'}
                        </td>
                        <td className="w-8">
                          <ArrowRight size={13} className="text-dim" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-line md:hidden">
              {purchases.map((purchase) => {
                const supplier = supplierNames[purchase.supplierId]
                  ?? state.suppliers.find((s) => s.id === purchase.supplierId);
                return (
                  <Link
                    key={purchase.id}
                    to={`/compras/${purchase.id}`}
                    className="block px-4 py-3.5 active:bg-raised/60"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="num text-[12.5px] text-cream">{purchase.code}</div>
                        <div className="mt-0.5 truncate text-[11px] text-muted">
                          {supplier?.name ?? '—'}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="num text-[13px] text-cream">
                          {money(purchaseTotalCents(purchase))}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <PurchaseStatusTag status={purchase.status} />
                      <span className="font-mono text-[10px] text-dim">
                        {purchase.expectedDeliveryAt ? `Prev. ${shortDate(purchase.expectedDeliveryAt)}` : `${purchase.lines.length} itens`}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
            {mode === 'production' && serverPage.error ? (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
                <span className="text-[11px] text-muted">{serverPage.error}</span>
                <button type="button" className="btn btn-ghost" onClick={loadMorePurchases}>
                  Tentar novamente
                </button>
              </div>
            ) : null}
            {mode === 'production' && (serverPage.hasMore || serverPage.loading)
              && serverPage.filter === filter ? (
              <div className="flex justify-center border-t border-line px-4 py-3">
                <button type="button" className="btn btn-ghost"
                  onClick={() => { void loadMorePurchases(); }} disabled={serverPage.loading}>
                  {serverPage.loading ? 'Carregando…' : 'Carregar mais pedidos'}
                </button>
              </div>
            ) : null}
          </>
        )}
      </Panel>

      <p className="mt-3 text-[10.5px] text-dim">
        {counts.received} pedidos recebidos · {counts.requested + counts.partial} aguardando entrega ·
        valores pelo preço esperado.
      </p>

      <Drawer
        open={drawerOpen}
        onClose={() => { setDrawerOpen(false); resetForm(); }}
        eyebrow="Compras"
        title={editingPurchaseId ? 'Editar rascunho de compra' : 'Novo pedido de compra'}
        description={editingPurchaseId ? 'Revise fornecedor, previsão, quantidades e preços antes de solicitar.' : 'O pedido nasce como rascunho. O fornecedor pode ser escolhido ao enviar.'}
        width="max-w-[580px]"
        footer={
          <>
            <span className="mr-auto text-[11px] text-dim">
              Total <span className="num text-cream">{money(totalDraft)}</span>
            </span>
            <button type="button" className="btn btn-ghost" onClick={() => { setDrawerOpen(false); resetForm(); }}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={submit}
              disabled={!supplierId || lines.length === 0}
            >
              {editingPurchaseId ? 'Salvar alterações' : 'Criar rascunho'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fornecedor" htmlFor="purchase-supplier">
              <select
                id="purchase-supplier"
                className="select"
                value={supplierId}
                onChange={(event) => {
                  const nextSupplierId = event.target.value;
                  setSupplierId(nextSupplierId);
                  const selected = supplierOptions.find((supplier) => supplier.id === nextSupplierId);
                  if (selected) actions.cacheSupplier(selected);
                  if (itemId) applyPriceSuggestion(itemId, nextSupplierId, lineUnit);
                }}
              >
                <option value="">Selecionar</option>
                {supplierOptions.filter((supplier) => supplier.active !== false).map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Previsão de entrega" htmlFor="purchase-date">
              <input
                id="purchase-date"
                type="date"
                className="input num"
                value={expectedDate}
                onChange={(event) => setExpectedDate(event.target.value)}
              />
            </Field>
          </div>
          {mode === 'production' && supplierOptionsHasMore ? <button type="button"
            className="text-left text-[10.5px] text-copper hover:text-cream" disabled={supplierOptionsLoadingMore}
            onClick={loadMoreSuppliers}>{supplierOptionsLoadingMore ? 'Carregando fornecedores…' : 'Carregar mais fornecedores'}</button> : null}

          <div className="border-t border-line pt-4">
            <div className="eyebrow mb-3">Itens do pedido</div>
            {mode === 'production' ? (
              <input
                className="input mb-2 h-9 w-full sm:max-w-[360px]"
                value={ingredientSearch}
                onChange={(event) => setIngredientSearch(event.target.value)}
                placeholder="Buscar insumo ativo"
                aria-label="Buscar insumo ativo"
              />
            ) : null}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_76px_62px_102px_auto]">
              <select
                className="select h-9"
                value={itemId}
                onChange={(event) => {
                  const next = event.target.value;
                  setItemId(next);
                  if (next) {
                    const selected = selectableIngredients.find((item) => item.id === next);
                    if (selected) {
                      actions.cacheIngredients([selected]);
                      const unit = purchaseUnits(selected)[0] ?? selected.unit;
                      setLineUnit(unit);
                      applyPriceSuggestion(next, supplierId, unit, selected);
                    }
                  } else setPriceText('');
                }}
                aria-label="Insumo"
              >
                <option value="">Selecionar insumo</option>
                {selectableIngredients.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <select
                className="select h-9"
                value={lineUnit}
                onChange={(event) => {
                  const unit = event.target.value as Unit;
                  setLineUnit(unit);
                  if (itemId) applyPriceSuggestion(itemId, supplierId, unit);
                }}
                aria-label="Unidade de compra"
                disabled={!itemId}
              >
                {(selectableIngredients.find((item) => item.id === itemId)
                  ? purchaseUnits(selectableIngredients.find((item) => item.id === itemId)!) : ['un' as Unit])
                  .map((unit) => <option key={unit} value={unit}>{unit}</option>)}
              </select>
              <input
                className="input num"
                placeholder="Qtd."
                inputMode="decimal"
                value={qtyText}
                onChange={(event) => setQtyText(event.target.value)}
                aria-label="Quantidade"
              />
              <input
                className="input num"
                placeholder={`Preço/${lineUnit}`}
                inputMode="decimal"
                value={priceText}
                onChange={(event) => setPriceText(event.target.value)}
                aria-label="Preço unitário"
              />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={addLine}
                disabled={!itemId || !qtyText}
              >
                <Plus size={13} />
                <span className="sm:hidden">Adicionar</span>
              </button>
            </div>
            {mode === 'production' && ingredientOptionsLoading ? (
              <p role="status" className="mt-2 text-[10.5px] text-dim">Buscando insumos…</p>
            ) : null}
            {mode === 'production' && ingredientOptionsError ? (
              <p role="alert" className="mt-2 text-[10.5px] text-danger">{ingredientOptionsError}</p>
            ) : null}
            {itemId && !priceText.trim() && suggestedPrice(itemId, supplierId, lineUnit) == null ? (
              <p className="mt-2 text-[10.5px] text-warn">
                Sem preço de referência. Informe uma estimativa antes de adicionar; zero só quando confirmado.
              </p>
            ) : null}
            <p className="mt-2 text-[10px] leading-relaxed text-dim">
              Quantidade e preço são informados na unidade de compra; o recebimento converte o saldo para a unidade-base do estoque.
            </p>
          </div>

          {lines.length > 0 ? (
            <div className="border border-line">
              {lines.map((line) => {
                const item = selectableIngredients.find((i) => i.id === line.itemId)
                  ?? state.items.find((i) => i.id === line.itemId);
                if (!item) return null;
                return (
                  <div
                    key={line.itemId}
                    className="flex items-center justify-between gap-3 border-b border-line/70 px-3 py-2.5 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[12px] text-cream">{item.name}</div>
                      <div className="num mt-0.5 text-[10.5px] text-dim">
                        {fmtQty(line.qtyOrdered, line.unit ?? item.unit)} {line.unit ?? item.unit} × {money(line.expectedUnitCostCents)}/{line.unit ?? item.unit}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="num text-[12px] text-cream">
                        {money(Math.round(line.qtyOrdered * line.expectedUnitCostCents))}
                      </span>
                      <button
                        type="button"
                        className="text-dim hover:text-danger"
                        onClick={() =>
                          setLines((prev) => prev.filter((l) => l.itemId !== line.itemId))
                        }
                        aria-label={`Remover ${item.name}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="border border-dashed border-line px-3 py-5 text-center text-[11.5px] text-dim">
              Adicione insumos para montar o pedido.
            </div>
          )}

          <Field label="Observações" htmlFor="purchase-note">
            <textarea
              id="purchase-note"
              className="textarea min-h-[70px]"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Instruções de entrega, condições combinadas, saldo pendente…"
            />
          </Field>

          <div className="border border-line bg-[#0b0b0a] px-3 py-2.5 text-[10.5px] leading-relaxed text-dim">
            O valor só entra no estoque quando o recebimento for confirmado. O custo do insumo é
            atualizado pelo preço real da nota.
          </div>
        </div>
      </Drawer>
    </div>
  );
}
