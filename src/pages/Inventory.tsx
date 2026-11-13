import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, ChevronRight, ClipboardList, Plus, Search } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { CATEGORIES, STATUS_LABEL, UNIT_LABEL, type ItemStatus, type Unit } from '../domain/types';
import { compareReplenishmentPriority, itemCostKnown, itemStatus, itemValueCents, itemsWithoutCost, stockValueCents } from '../domain/selectors';
import { money, parseOptionalNonNegativeMoney, parseQty, qty as fmtQty } from '../domain/format';
import { Drawer, EmptyState, Field, PageHeader, Panel, StatusTag } from '../components/ui';
import { ConversionEditor, parseConversionDrafts, type ConversionDraft } from '../components/ConversionEditor';
import { valueForTenant } from '../domain/tenant-snapshot';
import { fetchApiInventoryInsights, fetchApiInventoryPage, fetchApiSupplierPage,
  fetchApiSuppliersByIds, type ApiInventoryInsights } from '../lib/api';

const STATUS_ORDER: ItemStatus[] = ['normal', 'near_minimum', 'attention', 'critical', 'empty'];
const PAGE_SIZE = 50;

type SortKey = 'name' | 'value' | 'qty' | 'updated' | 'cost' | 'priority';

export function InventoryPage() {
  const { state, actions, can, mode, ready, notify } = useApp();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState<'all' | ItemStatus | 'needs-attention'>('all');
  const [sort, setSort] = useState<SortKey>('name');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [remoteItems, setRemoteItems] = useState<typeof state.items>([]);
  const [remoteHasMore, setRemoteHasMore] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteLoadingMore, setRemoteLoadingMore] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [remoteInsightsState, setRemoteInsightsState] = useState<{
    tenantId: string; value: ApiInventoryInsights | null; error: boolean;
  }>({ tenantId: '', value: null, error: false });
  const [remoteFilteredTotal, setRemoteFilteredTotal] = useState<number | null>(null);
  const [remoteFilteredSummary, setRemoteFilteredSummary] = useState<{
    known_stock_value_cents: number; without_cost: number;
  } | null>(null);
  const [insightRetry, setInsightRetry] = useState(0);
  const [clientVisibleCount, setClientVisibleCount] = useState(PAGE_SIZE);
  const [queryRetry, setQueryRetry] = useState(0);
  const requestGeneration = useRef(0);
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    if (mode !== 'production' || !ready || !state.restaurant.id) {
      setRemoteInsightsState({ tenantId: '', value: null, error: false });
      return;
    }
    let current = true;
    const tenantId = state.restaurant.id;
    void fetchApiInventoryInsights().then((value) => {
      if (current) setRemoteInsightsState({ tenantId, value, error: false });
    }).catch(() => {
      if (current) setRemoteInsightsState({ tenantId, value: null, error: true });
    });
    return () => { current = false; };
  }, [mode, ready, state.restaurant.id, insightRetry]);

  const remoteInsights = valueForTenant(remoteInsightsState.tenantId
    ? { tenantId: remoteInsightsState.tenantId, value: remoteInsightsState.value } : null,
  state.restaurant.id);
  const insightsFailed = mode === 'production'
    && remoteInsightsState.tenantId === state.restaurant.id && remoteInsightsState.error;
  const insightsLoading = mode === 'production' && ready && !!state.restaurant.id
    && !remoteInsights && !insightsFailed;

  const [name, setName] = useState('');
  const [newCategory, setNewCategory] = useState<(typeof CATEGORIES)[number]>('Carnes');
  const [unit, setUnit] = useState<Unit>('kg');
  const [minQty, setMinQty] = useState('0');
  const [cost, setCost] = useState('');
  const [initialQty, setInitialQty] = useState('0');
  const [supplierId, setSupplierId] = useState('');
  const [supplierOptions, setSupplierOptions] = useState(state.suppliers);
  const [supplierOptionsHasMore, setSupplierOptionsHasMore] = useState(false);
  const [supplierOptionsLoadingMore, setSupplierOptionsLoadingMore] = useState(false);
  const [conversions, setConversions] = useState<ConversionDraft[]>([]);
  const parsedConversions = parseConversionDrafts(conversions);

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

  const counts = useMemo(() => {
    const base = { all: state.items.length, normal: 0, near_minimum: 0, attention: 0, critical: 0, empty: 0 };
    for (const item of state.items) base[itemStatus(item)] += 1;
    return base;
  }, [state.items]);
  const inventoryCounts = mode === 'production' && remoteInsights ? {
    all: remoteInsights.total,
    normal: remoteInsights.normal,
    near_minimum: remoteInsights.near_minimum,
    attention: remoteInsights.attention,
    critical: remoteInsights.critical,
    empty: remoteInsights.empty,
  } : mode === 'production' ? {
    all: null, normal: null, near_minimum: null, attention: null, critical: null, empty: null,
  } : counts;
  const inventoryTotal = mode === 'production' ? remoteInsights?.total ?? null : state.items.length;
  const inventoryValue = mode === 'production'
    ? remoteInsights?.known_stock_value_cents ?? null
    : stockValueCents(state);
  const inventoryWithoutCost = mode === 'production'
    ? remoteInsights?.without_cost ?? null
    : itemsWithoutCost(state).length;
  const attentionCount = inventoryCounts.all != null && inventoryCounts.normal != null
    ? inventoryCounts.all - inventoryCounts.normal : null;

  const filtered = useMemo(() => {
    if (mode === 'production') return [];
    const term = search.trim().toLowerCase();
    const list = state.items.filter((item) => {
      if (category !== 'all' && item.category !== category) return false;
      if (status === 'needs-attention' && itemStatus(item) === 'normal') return false;
      if (status !== 'all' && status !== 'needs-attention' && itemStatus(item) !== status) return false;
      if (!term) return true;
      const supplier = state.suppliers.find((s) => s.id === item.primarySupplierId);
      return (
        item.name.toLowerCase().includes(term) ||
        item.category.toLowerCase().includes(term) ||
        (supplier?.name.toLowerCase().includes(term) ?? false)
      );
    });
    return list.sort((a, b) => {
      switch (sort) {
        case 'priority':
          return compareReplenishmentPriority(a, b);
        case 'value':
          return itemValueCents(b) - itemValueCents(a);
        case 'qty':
          return a.currentQty - b.currentQty;
        case 'updated':
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        case 'cost':
          return b.costCents - a.costCents;
        default:
          return a.name.localeCompare(b.name, 'pt-BR');
      }
    });
  }, [mode, state.items, state.suppliers, search, category, status, sort]);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    setRemoteItems([]);
    setRemoteHasMore(false);
    setRemoteFilteredTotal(null);
    setRemoteFilteredSummary(null);
    setRemoteError(null);
    setRemoteLoadingMore(false);
    setClientVisibleCount(PAGE_SIZE);
    if (mode !== 'production' || !ready || !state.restaurant.id) {
      setRemoteLoading(false);
      return;
    }

    let cancelled = false;
    setRemoteLoading(true);
    const query = {
      search,
      category: category === 'all' ? null : category,
      status: status === 'all' ? null : status,
      sort: sort === 'qty' ? 'quantity_asc' as const
        : sort === 'updated' ? 'updated_desc' as const
          : sort === 'cost' ? 'cost_desc' as const
            : sort === 'value' ? 'value_desc' as const
              : sort,
    };
    const timerId = window.setTimeout(() => {
      void fetchApiInventoryPage(query, 0, PAGE_SIZE, false, true)
        .then((page) => {
          if (cancelled || generation !== requestGeneration.current) return;
          setRemoteItems(page.items);
          actionsRef.current.cacheIngredients(page.items);
          void fetchApiSuppliersByIds(page.items.map((item) => item.primarySupplierId ?? ''))
            .then((suppliers) => actionsRef.current.cacheSuppliers(suppliers)).catch(() => undefined);
          setRemoteHasMore(page.hasMore);
          setRemoteFilteredTotal(page.total ?? page.items.length);
          setRemoteFilteredSummary(page.summary ?? null);
        })
        .catch((error: unknown) => {
          if (cancelled || generation !== requestGeneration.current) return;
          setRemoteError(error instanceof Error ? error.message : 'Não foi possível carregar o estoque.');
        })
        .finally(() => {
          if (!cancelled && generation === requestGeneration.current) setRemoteLoading(false);
        });
    }, search.trim() ? 250 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [mode, ready, state.restaurant.id, search, category, status, sort, queryRetry]);

  const visibleItems = mode === 'production' ? remoteItems : filtered.slice(0, clientVisibleCount);
  const hasMoreItems = mode === 'production' ? remoteHasMore : visibleItems.length < filtered.length;
  const filteredTotal = mode === 'production' ? remoteFilteredTotal ?? remoteItems.length : filtered.length;
  const filteredValue = mode === 'production' ? remoteFilteredSummary?.known_stock_value_cents
    : filtered.filter(itemCostKnown).reduce((sum, item) => sum + itemValueCents(item), 0);
  const filteredWithoutCost = mode === 'production' ? remoteFilteredSummary?.without_cost
    : filtered.filter((item) => !itemCostKnown(item)).length;
  const loadMore = async () => {
    if (mode !== 'production') {
      setClientVisibleCount((current) => current + PAGE_SIZE);
      return;
    }
    if (remoteLoading || remoteLoadingMore || !remoteHasMore) return;
    const generation = requestGeneration.current;
    setRemoteLoadingMore(true);
    setRemoteError(null);
    const query = {
      search,
      category: category === 'all' ? null : category,
      status: status === 'all' ? null : status,
      sort: sort === 'qty' ? 'quantity_asc' as const
        : sort === 'updated' ? 'updated_desc' as const
          : sort === 'cost' ? 'cost_desc' as const
            : sort === 'value' ? 'value_desc' as const
              : sort,
    };
    try {
      const page = await fetchApiInventoryPage(query, remoteItems.length, PAGE_SIZE);
      if (generation !== requestGeneration.current) return;
      actionsRef.current.cacheIngredients(page.items);
      void fetchApiSuppliersByIds(page.items.map((item) => item.primarySupplierId ?? ''))
        .then((suppliers) => actionsRef.current.cacheSuppliers(suppliers)).catch(() => undefined);
      setRemoteItems((previous) => {
        const known = new Set(previous.map((item) => item.id));
        return [...previous, ...page.items.filter((item) => !known.has(item.id))];
      });
      setRemoteHasMore(page.hasMore);
    } catch (error) {
      if (generation === requestGeneration.current) {
        setRemoteError(error instanceof Error ? error.message : 'Não foi possível carregar mais insumos.');
      }
    } finally {
      if (generation === requestGeneration.current) setRemoteLoadingMore(false);
    }
  };

  const resetForm = () => {
    setName('');
    setNewCategory('Carnes');
    setUnit('kg');
    setMinQty('0');
    setCost('');
    setInitialQty('0');
    setSupplierId('');
    setConversions([]);
  };

  const submit = async () => {
    const conversionMap = parseConversionDrafts(conversions);
    if (!conversionMap) return;
    const parsedCost = parseOptionalNonNegativeMoney(cost);
    if (!parsedCost) {
      notify('Informe um custo válido, igual ou maior que zero.', 'error');
      return;
    }
    const id = await actions.createItem({
      name,
      category: newCategory,
      unit,
      minQty: parseQty(minQty),
      costCents: parsedCost.cents,
      costKnown: parsedCost.known,
      initialQty: parseQty(initialQty),
      supplierId: supplierId || null,
      conversions: conversionMap,
    });
    if (id) {
      setDrawerOpen(false);
      resetForm();
      setInsightRetry((value) => value + 1);
      setQueryRetry((value) => value + 1);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="02 / Estoque"
        title="Estoque"
        description="Todos os insumos, saldo atual, custo e situação. Cada alteração passa por uma movimentação registrada."
        meta={
          <>
            <span className="text-[11px] text-muted">
              <span className="num text-cream">{inventoryTotal ?? (insightsLoading ? '…' : '—')}</span> insumos
            </span>
            <span className="text-[11px] text-dim">·</span>
            <span className="text-[11px] text-muted">
              Valor conhecido <span className="num text-cream">{inventoryValue == null
                ? insightsLoading ? '…' : '—' : money(inventoryValue)}</span>
            </span>
            {inventoryWithoutCost != null && inventoryWithoutCost > 0
              ? <><span className="text-[11px] text-dim">·</span><span className="text-[11px] text-warn">{inventoryWithoutCost} sem custo</span></> : null}
            {insightsFailed ? <button type="button" className="text-[10px] text-copper hover:text-cream"
              onClick={() => setInsightRetry((value) => value + 1)}>Atualizar indicadores</button> : null}
            <span className="text-[11px] text-dim">·</span>
            <span className="text-[11px] text-muted">
              <span className="num text-copper">{attentionCount ?? (insightsLoading ? '…' : '—')}</span> exigem atenção
            </span>
          </>
        }
        actions={
          <>
            <Link to="/contagem?nova=1" className="btn btn-ghost">
              <ClipboardList size={14} />
              Contagem
            </Link>
            {can('stock.create') ? (
              <button type="button" className="btn btn-primary" onClick={() => setDrawerOpen(true)}>
                <Plus size={14} />
                Novo insumo
              </button>
            ) : null}
          </>
        }
      />

      <Panel flush bodyClassName="">
        <div className="flex flex-col gap-3 border-b border-line px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative w-full lg:max-w-[300px]">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"
            />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar insumo, categoria ou fornecedor"
              className="input h-8 pl-8 text-[12px]"
              aria-label="Buscar insumo"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="select h-8 w-[154px] text-[11.5px]"
              aria-label="Filtrar por categoria"
            >
              <option value="all">Todas as categorias</option>
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {cat}
                </option>
              ))}
            </select>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as SortKey)}
              className="select h-8 w-[174px] text-[11.5px]"
              aria-label="Ordenar"
            >
              <option value="name">Nome (A–Z)</option>
              <option value="priority">Prioridade de reposição</option>
              <option value="value">Maior valor em estoque</option>
              <option value="qty">Menor saldo</option>
              <option value="cost">Maior custo unitário</option>
              <option value="updated">Atualização recente</option>
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
          <button
            type="button"
            onClick={() => setStatus('all')}
            className={`filter-tab ${status === 'all' ? 'filter-tab-active' : ''}`}
          >
            Todos <span className="font-mono text-[10px] text-dim">{inventoryCounts.all ?? (insightsLoading ? '…' : '—')}</span>
          </button>
          <button type="button" onClick={() => setStatus('needs-attention')} className={`filter-tab ${status === 'needs-attention' ? 'filter-tab-active' : ''}`}>
            Atenção <span className="font-mono text-[10px] text-dim">{attentionCount ?? (insightsLoading ? '…' : '—')}</span>
          </button>
          <details className="relative">
            <summary className="filter-tab cursor-pointer">Filtrar estado</summary>
            <div className="absolute left-0 top-full z-10 mt-1 min-w-[180px] border border-line bg-panel p-1">
              {STATUS_ORDER.map((key) => (
                <button key={key} type="button" onClick={() => setStatus(key)} className={`flex w-full items-center justify-between px-2.5 py-2 text-left text-[11px] ${status === key ? 'bg-raised text-cream' : 'text-muted hover:bg-raised'}`}>
                  {STATUS_LABEL[key]} <span className="font-mono text-[10px] text-dim">{inventoryCounts[key] ?? (insightsLoading ? '…' : '—')}</span>
                </button>
              ))}
            </div>
          </details>
        </div>

        {mode === 'production' && remoteLoading && remoteItems.length === 0 ? (
          <div className="px-4 py-10 text-center text-[12px] text-dim" role="status">Carregando insumos…</div>
        ) : mode === 'production' && remoteError && remoteItems.length === 0 ? (
          <EmptyState
            icon={<Boxes size={18} />}
            title="Não foi possível carregar o estoque"
            description={remoteError}
            action={<button type="button" className="btn btn-ghost" onClick={() => setQueryRetry((value) => value + 1)}>Tentar novamente</button>}
          />
        ) : visibleItems.length === 0 ? (
          <EmptyState
            icon={<Boxes size={18} />}
            title={mode === 'production'
              ? remoteFilteredTotal === 0 && !search.trim() && category === 'all' && status === 'all'
                ? 'Ainda não há insumos cadastrados' : 'Nenhum insumo encontrado'
              : inventoryTotal === 0 ? 'Ainda não há insumos cadastrados' : 'Nenhum insumo encontrado'}
            description={
              mode === 'production'
                ? remoteFilteredTotal === 0 && !search.trim() && category === 'all' && status === 'all'
                  ? 'Cadastre o primeiro insumo para acompanhar saldo, custo e consumo.'
                  : 'Ajuste a busca ou limpe os filtros para ver outros itens do estoque.'
                : inventoryTotal === 0
                ? 'Cadastre o primeiro insumo para acompanhar saldo, custo e consumo.'
                : 'Ajuste a busca ou limpe os filtros para ver outros itens do estoque.'
            }
            action={
              (mode === 'production'
                ? remoteFilteredTotal === 0 && !search.trim() && category === 'all' && status === 'all'
                : inventoryTotal === 0) && can('stock.create') ? (
                <button type="button" className="btn btn-primary" onClick={() => setDrawerOpen(true)}>
                  <Plus size={14} />
                  Cadastrar insumo
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setSearch('');
                    setCategory('all');
                    setStatus('all');
                  }}
                >
                  Limpar filtros
                </button>
              )
            }
          />
        ) : (
          <>
            {remoteError ? <div className="border-b border-warn/30 bg-warn/5 px-4 py-2 text-[11px] text-warn" role="status">{remoteError}</div> : null}
            <div className="scroll-x hidden md:block">
              <table className="table min-w-[520px]">
                <thead>
                  <tr>
                    <th>Insumo</th>
                    <th className="text-right">Saldo atual</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((item) => {
                    return (
                      <tr key={item.id} className="row-link">
                        <td>
                          <Link to={`/estoque/${item.id}`} className="block">
                            <div className="text-[13px] text-cream">{item.name}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[10.5px] text-dim">
                              {item.category}
                              {itemStatus(item) === 'near_minimum' ? <span className="text-copper">· Próximo do mínimo ({fmtQty(item.minQty, item.unit)})</span> : null}
                              {itemStatus(item) === 'attention' ? <span className="text-warn">· Abaixo do mínimo ({fmtQty(item.minQty, item.unit)})</span> : null}
                              {itemStatus(item) === 'critical' ? <span className="text-danger">· Crítico · mín. {fmtQty(item.minQty, item.unit)}</span> : null}
                              {itemStatus(item) === 'empty' ? <span className="text-danger">· Sem estoque · mín. {fmtQty(item.minQty, item.unit)}</span> : null}
                            </div>
                          </Link>
                        </td>
                        <td className="text-right">
                          <span className="num text-[13px] text-cream">
                            {fmtQty(item.currentQty, item.unit)}
                          </span>
                        </td>
                        <td className="w-8 text-right">
                          <ChevronRight size={13} className="inline text-dim" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-line md:hidden">
              {visibleItems.map((item) => (
                <Link
                  key={item.id}
                  to={`/estoque/${item.id}`}
                  className="block px-4 py-3.5 transition-colors active:bg-raised/60"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[13.5px] text-cream">{item.name}</div>
                      <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-dim">
                        {item.category}{itemStatus(item) !== 'normal' ? ` · mín. ${fmtQty(item.minQty, item.unit)}` : ''}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="num text-[15px] text-cream">
                        {fmtQty(item.currentQty, item.unit)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-1 min-h-4">{itemStatus(item) !== 'normal' ? <StatusTag status={itemStatus(item)} /> : null}</div>
                </Link>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[10.5px] text-dim">
              <span>
                {visibleItems.length} exibidos de {filteredTotal} filtrados · {inventoryTotal} no estoque
              </span>
              <span className="num">
                Valor conhecido: {mode === 'production' && filteredValue == null
                  ? remoteLoading ? '…' : '—' : money(filteredValue ?? 0)}
                {(filteredWithoutCost ?? 0) > 0 ? ` · ${filteredWithoutCost} sem custo` : ''}
              </span>
              {hasMoreItems ? <button type="button" className="btn btn-ghost h-7 px-2 text-[10px]" onClick={() => void loadMore()} disabled={remoteLoadingMore || remoteLoading}>
                {remoteLoadingMore ? 'Carregando…' : 'Carregar mais'}
              </button> : null}
            </div>
          </>
        )}
      </Panel>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        eyebrow="Estoque"
        title="Novo insumo"
        description="O saldo inicial entra como movimentação, mantendo o histórico desde o primeiro dia."
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setDrawerOpen(false)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" onClick={submit} disabled={!name.trim() || parsedConversions === null}>
              Cadastrar insumo
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Nome do insumo" htmlFor="item-name">
            <input
              id="item-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ex.: Queijo provolone"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Categoria" htmlFor="item-category">
              <select
                id="item-category"
                className="select"
                value={newCategory}
                onChange={(event) =>
                  setNewCategory(event.target.value as (typeof CATEGORIES)[number])
                }
              >
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Unidade" htmlFor="item-unit">
              <select
                id="item-unit"
                className="select"
                value={unit}
                onChange={(event) => setUnit(event.target.value as Unit)}
              >
                {Object.entries(UNIT_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <ConversionEditor baseUnit={unit} value={conversions} onChange={setConversions} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Estoque mínimo" htmlFor="item-min" hint="Abaixo deste saldo o item entra em atenção.">
              <input
                id="item-min"
                className="input num"
                inputMode="decimal"
                value={minQty}
                onChange={(event) => setMinQty(event.target.value)}
                placeholder="0"
              />
            </Field>
            <Field label={`Custo por ${unit}`} htmlFor="item-cost" hint="Em reais.">
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[11px] text-dim">
                  R$
                </span>
                <input
                  id="item-cost"
                  className="input num pl-8"
                  inputMode="decimal"
                  value={cost}
                  onChange={(event) => setCost(event.target.value)}
                  placeholder="0,00"
                />
              </div>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Saldo inicial" htmlFor="item-qty" hint="Opcional. Gera entrada manual.">
              <input
                id="item-qty"
                className="input num"
                inputMode="decimal"
                value={initialQty}
                onChange={(event) => setInitialQty(event.target.value)}
                placeholder="0"
              />
            </Field>
            <Field label="Fornecedor principal" htmlFor="item-supplier" hint="Opcional.">
              <select
                id="item-supplier"
                className="select"
                value={supplierId}
                onChange={(event) => {
                  const nextId = event.target.value;
                  setSupplierId(nextId);
                  const selected = supplierOptions.find((supplier) => supplier.id === nextId);
                  if (selected) actions.cacheSupplier(selected);
                }}
              >
                <option value="">Sem fornecedor</option>
                {supplierOptions.filter((supplier) => supplier.active !== false).map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </Field>
            {mode === 'production' && supplierOptionsHasMore ? <button type="button"
              className="text-left text-[10.5px] text-copper hover:text-cream" disabled={supplierOptionsLoadingMore}
              onClick={loadMoreSuppliers}>{supplierOptionsLoadingMore ? 'Carregando fornecedores…' : 'Carregar mais fornecedores'}</button> : null}
          </div>
          <div className="border border-line bg-[#0b0b0a] px-3 py-2.5 text-[11px] leading-relaxed text-dim">
            O estoque não é um número editável: alterações futuras geram movimentações com motivo,
            usuário e data.
          </div>
        </div>
      </Drawer>
    </div>
  );
}
