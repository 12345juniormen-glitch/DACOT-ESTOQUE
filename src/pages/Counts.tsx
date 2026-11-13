import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ClipboardCheck, ClipboardList, Plus, Search } from 'lucide-react';
import { useApp } from '../state/AppStore';
import {
  belowMinItems,
  countDivergences,
  countFinancialDivergenceCents,
  countFinancialCents,
} from '../domain/selectors';
import { dateTime, money, qty as fmtQty } from '../domain/format';
import type { CountStatus } from '../domain/types';
import { Drawer, EmptyState, Field, PageHeader, Panel } from '../components/ui';
import { fetchApiCountCandidates, fetchApiCountInsights, fetchApiCountPage,
  type ApiCountInsights } from '../lib/api';

const COUNT_STATUS: Record<CountStatus, { label: string; className: string }> = {
  open: { label: 'Em andamento', className: 'text-copper' },
  review: { label: 'Em revisão', className: 'text-warn' },
  approved: { label: 'Aprovada', className: 'text-ok' },
};

export function CountsPage() {
  const { state, actions, can, mode, ready, notify } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [drawerOpen, setDrawerOpen] = useState(params.get('nova') === '1');
  const [scope, setScope] = useState<'all' | 'low' | 'category'>('all');
  const [category, setCategory] = useState('Carnes');
  const [search, setSearch] = useState('');
  const [deselected, setDeselected] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState<'all' | 'custom'>('all');
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [remoteCandidates, setRemoteCandidates] = useState<typeof state.items>([]);
  const [remoteTotal, setRemoteTotal] = useState(0);
  const [remoteSelectedCount, setRemoteSelectedCount] = useState(0);
  const [remoteCategories, setRemoteCategories] = useState<string[]>([]);
  const [remoteHasMore, setRemoteHasMore] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const requestGeneration = useRef(0);
  const [countRefresh, setCountRefresh] = useState(0);
  const [countPage, setCountPage] = useState<{ tenantId: string | null; counts: typeof state.counts;
    hasMore: boolean; loading: boolean; error: string | null }>(
      { tenantId: null, counts: [], hasMore: false, loading: false, error: null });
  const [countInsights, setCountInsights] = useState<ApiCountInsights | null>(null);
  const [insightsTenantId, setInsightsTenantId] = useState<string | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== 'production' || !ready || !state.restaurant.id) return;
    let current = true;
    const tenantId = state.restaurant.id;
    setCountPage({ tenantId, counts: [], hasMore: false, loading: true, error: null });
    setCountInsights(null);
    setInsightsTenantId(null);
    setInsightsError(null);
    void fetchApiCountPage(0).then((page) => {
      if (!current) return;
      setCountPage({ tenantId, counts: page.counts, hasMore: page.hasMore, loading: false, error: null });
    }).catch((error: unknown) => {
      if (current) setCountPage({ tenantId, counts: [], hasMore: false, loading: false,
        error: error instanceof Error ? error.message : 'Não foi possível carregar as contagens.' });
    });
    void fetchApiCountInsights().then((insights) => {
      if (!current) return;
      setCountInsights(insights);
      setInsightsTenantId(tenantId);
    }).catch((error: unknown) => {
      if (current) setInsightsError(error instanceof Error
        ? error.message : 'Não foi possível carregar o resumo das contagens.');
    });
    return () => { current = false; };
  }, [mode, ready, state.restaurant.id, countRefresh]);

  const counts = mode === 'production'
    ? countPage.tenantId === state.restaurant.id ? countPage.counts : []
    : [...state.counts].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  const currentInsights = mode === 'production' && insightsTenantId === state.restaurant.id
    ? countInsights : null;
  const openCounts = mode === 'production'
    ? currentInsights?.latest_open ? [currentInsights.latest_open] : []
    : counts.filter((count) => count.status === 'open');
  const pendingCounts = counts.filter((count) => count.status !== 'approved');
  const approvedCounts = counts.filter((count) => count.status === 'approved');
  const statusCounts = currentInsights?.status_counts;
  const totalCount = statusCounts
    ? Object.values(statusCounts).reduce((sum, count) => sum + (count ?? 0), 0) : counts.length;
  const pendingCount = statusCounts ? (statusCounts.open ?? 0) + (statusCounts.review ?? 0) : pendingCounts.length;
  const approvedCount = statusCounts ? statusCounts.approved ?? 0 : approvedCounts.length;
  const unknownImpactCount = currentInsights?.unknown_financial_count
    ?? approvedCounts.filter((count) => countFinancialDivergenceCents(state, count) == null).length;
  const knownImpact = currentInsights?.divergence_cents
    ?? approvedCounts.reduce((sum, count) => sum + (countFinancialDivergenceCents(state, count) ?? 0), 0);
  const low = belowMinItems(state);

  const localCandidates = useMemo(() => {
    let list = state.items;
    if (scope === 'low') list = low;
    if (scope === 'category') list = list.filter((item) => item.category === category);
    if (search.trim()) {
      const term = search.trim().toLowerCase();
      list = list.filter((item) => item.name.toLowerCase().includes(term));
    }
    return [...list].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }, [state.items, low, scope, category, search]);

  const includeIds = [...included].sort();
  const excludeIds = [...deselected].sort();
  const includeKey = includeIds.join('\u0000');
  const excludeKey = excludeIds.join('\u0000');
  const selection = { scope, category: scope === 'category' ? category : null, search: search.trim() };

  useEffect(() => {
    if (!drawerOpen || mode !== 'production' || !ready || !state.restaurant.id) return;
    const generation = ++requestGeneration.current;
    let current = true;
    setRemoteCandidates([]);
    setRemoteTotal(0);
    setRemoteSelectedCount(0);
    setRemoteHasMore(false);
    setRemoteLoading(true);
    setRemoteError(null);
    const timer = window.setTimeout(() => {
      void fetchApiCountCandidates({ selection, selectionMode, includeIds, excludeIds, offset: 0 })
        .then((page) => {
          if (!current || generation !== requestGeneration.current) return;
          setRemoteCandidates(page.items);
          setRemoteTotal(page.total);
          setRemoteSelectedCount(page.selectedCount);
          setRemoteCategories(page.categories);
          setRemoteHasMore(page.items.length < page.total);
          actions.cacheIngredients(page.items);
        }).catch((error: unknown) => {
          if (!current || generation !== requestGeneration.current) return;
          setRemoteError(error instanceof Error ? error.message : 'Não foi possível carregar os itens da contagem.');
        }).finally(() => {
          if (current && generation === requestGeneration.current) setRemoteLoading(false);
        });
    }, search.trim() ? 250 : 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [drawerOpen, mode, ready, state.restaurant.id, scope, category, search,
    selectionMode, includeKey, excludeKey]);

  const candidates = mode === 'production' ? remoteCandidates : localCandidates;
  const selected = mode === 'production'
    ? remoteCandidates.filter((item) => selectionMode === 'all' ? !deselected.has(item.id) : included.has(item.id))
    : localCandidates.filter((item) => !deselected.has(item.id));
  const candidateTotal = mode === 'production' ? remoteTotal : localCandidates.length;
  const selectedCount = mode === 'production' ? remoteSelectedCount : selected.length;

  const resetScope = (nextScope: 'all' | 'low' | 'category') => {
    setScope(nextScope);
    setSelectionMode('all');
    setIncluded(new Set());
    setDeselected(new Set());
  };

  const loadMoreCandidates = async () => {
    if (remoteLoading || !remoteHasMore || mode !== 'production') return;
    const generation = requestGeneration.current;
    setRemoteLoading(true);
    setRemoteError(null);
    try {
      const page = await fetchApiCountCandidates({ selection, selectionMode, includeIds, excludeIds,
        offset: remoteCandidates.length });
      if (generation !== requestGeneration.current) return;
      setRemoteCandidates((previous) => [...previous, ...page.items]);
      setRemoteTotal(page.total);
      setRemoteSelectedCount(page.selectedCount);
      setRemoteCategories(page.categories);
      setRemoteHasMore(remoteCandidates.length + page.items.length < page.total);
      actions.cacheIngredients(page.items);
    } catch (error) {
      if (generation === requestGeneration.current) setRemoteError(error instanceof Error
        ? error.message : 'Não foi possível carregar mais itens da contagem.');
    } finally {
      if (generation === requestGeneration.current) setRemoteLoading(false);
    }
  };

  const loadMoreCounts = async () => {
    if (mode !== 'production' || countPage.loading || !countPage.hasMore
        || countPage.tenantId !== state.restaurant.id) return;
    const tenantId = state.restaurant.id;
    setCountPage((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const page = await fetchApiCountPage(countPage.counts.length);
      setCountPage((previous) => previous.tenantId === tenantId ? ({ ...previous,
        counts: [...previous.counts, ...page.counts], hasMore: page.hasMore, loading: false, error: null,
      }) : previous);
    } catch (error) {
      setCountPage((previous) => previous.tenantId === tenantId ? ({ ...previous, loading: false,
        error: error instanceof Error ? error.message : 'Não foi possível carregar mais contagens.' }) : previous);
    }
  };

  useEffect(() => {
    if (params.get('nova') === '1') {
      setDrawerOpen(true);
      params.delete('nova');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const startCount = async () => {
    if (mode === 'production') {
      if (selectedCount > 500) {
        return;
      }
      const selectionRequest = { ...selection,
        ...(selectionMode === 'all' ? { exclude_ids: excludeIds } : { include_ids: includeIds }) };
      const id = await actions.createCount([], selectionRequest);
      if (id) {
        setDrawerOpen(false);
        navigate(`/contagem/${id}`);
      }
      return;
    }
    const id = await actions.createCount(selected.map((item) => item.id));
    if (id) {
      setDrawerOpen(false);
      navigate(`/contagem/${id}`);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="03 / Contagem"
        title="Contagem de estoque"
        description="Compare o estoque esperado com o encontrado no físico. Cada divergência precisa de aprovação antes de gerar ajuste."
        actions={
          can('count.perform') ? (
            <button type="button" className="btn btn-primary" onClick={() => setDrawerOpen(true)}>
              <Plus size={14} />
              Nova contagem
            </button>
          ) : null
        }
      />

      {mode === 'production' && insightsError ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-line bg-panel px-4 py-3 text-[11px] text-muted">
          <span>{insightsError}</span>
          <button type="button" className="btn btn-ghost" onClick={() => setCountRefresh((value) => value + 1)}>
            Atualizar resumo
          </button>
        </div>
      ) : null}

      {openCounts.length > 0 ? (
        <Panel className="mb-5" bodyClassName="px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center border border-copper/40 text-copper">
                <ClipboardList size={16} />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-cream">{openCounts[0].code}</span>
                  <span className="text-[10px] uppercase tracking-[0.1em] text-copper">
                    em andamento
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-muted">
                  {openCounts[0].lines.filter((l) => l.countedQty != null).length} de{' '}
                  {openCounts[0].lines.length} itens conferidos · iniciada em{' '}
                  {dateTime(openCounts[0].startedAt)}
                </div>
              </div>
            </div>
            <Link to={`/contagem/${openCounts[0].id}`} className="btn btn-ghost">
              Continuar contagem
            </Link>
          </div>
        </Panel>
      ) : null}

      <section className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 border-y border-line px-1 py-3 text-[11px] text-muted">
        <span><span className="num text-cream">{mode === 'production' && !currentInsights ? '—' : pendingCount}</span> pendentes</span>
        <span><span className="num text-cream">{mode === 'production' && !currentInsights ? '—' : approvedCount}</span> aprovadas</span>
        <span><span className="num text-cream">{mode === 'production' && !currentInsights ? '—' : money(knownImpact)}</span> divergência precificada{currentInsights && unknownImpactCount ? ` · ${unknownImpactCount} sem custo completo` : ''}</span>
        <span className="text-dim">{counts[0] ? `Última: ${counts[0].code}` : 'Sem contagens'}</span>
        <span className="text-dim">{low.length} insumos abaixo do mínimo</span>
      </section>

      <Panel
        title="Histórico de contagens"
        subtitle="Abra uma contagem para conferir itens, responsáveis e ajustes registrados."
        flush
        bodyClassName=""
      >
        {mode === 'production' && countPage.tenantId === state.restaurant.id
          && countPage.loading && counts.length === 0 ? (
          <div role="status" aria-live="polite" className="px-4 py-10 text-center text-[12px] text-dim">
            Carregando histórico de contagens…
          </div>
        ) : mode === 'production' && countPage.tenantId === state.restaurant.id
          && countPage.error && counts.length === 0 ? (
          <div role="alert" className="px-4 py-8 text-center">
            <p className="text-[12px] text-muted">{countPage.error}</p>
            <button type="button" className="btn btn-ghost mt-3" onClick={() => setCountRefresh((value) => value + 1)}>
              Tentar novamente
            </button>
          </div>
        ) : totalCount === 0 && mode === 'production' && !currentInsights ? (
          <div role={insightsError ? 'alert' : 'status'} className="px-4 py-10 text-center text-[12px] text-dim">
            {insightsError ? 'Resumo indisponível. Tente atualizar a consulta.' : 'Consultando o resumo de contagens…'}
          </div>
        ) : counts.length === 0 ? (
          <EmptyState
            icon={<ClipboardCheck size={18} />}
            title="Nenhuma contagem registrada"
            description="Comece contando os itens mais críticos. O sistema compara esperado e contado e calcula o impacto financeiro."
            action={
              can('count.perform') ? (
                <button type="button" className="btn btn-primary" onClick={() => setDrawerOpen(true)}>
                  Iniciar primeira contagem
                </button>
              ) : null
            }
          />
        ) : (
          <div className="scroll-x">
            <table className="table min-w-[520px]">
              <thead>
                <tr>
                  <th>Contagem</th>
                  <th>Estado</th>
                  <th className="text-right">Conferidos</th>
                  <th className="text-right">Divergências</th>
                  <th className="text-right">Impacto</th>
                </tr>
              </thead>
              <tbody>
                {counts.map((count) => {
                  const checked = count.lines.filter((l) => l.countedQty != null).length;
                  const financial = countFinancialCents(state, count);
                  const status = COUNT_STATUS[count.status];
                  return (
                    <tr key={count.id} className="row-link">
                      <td>
                        <Link to={`/contagem/${count.id}`} className="block text-[12.5px] text-cream">
                          {count.code}
                        </Link>
                      </td>
                      <td>
                        <span className={`text-[11.5px] ${status.className}`}>· {status.label}</span>
                      </td>
                      <td className="text-right num text-[11.5px] text-muted">
                        {checked}/{count.lines.length}
                      </td>
                      <td className="text-right num text-[11.5px] text-muted">
                        {count.status === 'approved' ? countDivergences(count) : '—'}
                      </td>
                      <td
                        className={`text-right num text-[11.5px] ${
                          financial != null && financial < 0 ? 'text-danger' : 'text-cream'
                        }`}
                      >
                        {count.status === 'approved' ? financial == null ? '—' : money(financial) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {mode === 'production' && countPage.tenantId === state.restaurant.id && countPage.error
          && counts.length > 0 ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
            <span className="text-[11px] text-muted">{countPage.error}</span>
            <button type="button" className="btn btn-ghost" onClick={() => { void loadMoreCounts(); }}>Tentar novamente</button>
          </div>
        ) : null}
        {mode === 'production' && countPage.tenantId === state.restaurant.id && countPage.hasMore ? (
          <div className="flex justify-center border-t border-line px-4 py-3">
            <button type="button" className="btn btn-ghost" onClick={() => { void loadMoreCounts(); }}
              disabled={countPage.loading}>
              {countPage.loading ? 'Carregando…' : 'Carregar mais contagens'}
            </button>
          </div>
        ) : null}
      </Panel>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        eyebrow="Contagem"
        title="Iniciar nova contagem"
        description="O estoque esperado é congelado no momento da abertura. A contagem pode continuar no celular."
        width="max-w-[560px]"
        footer={
          <>
            <span className="mr-auto text-[11px] text-dim">{selectedCount} itens selecionados</span>
            <button type="button" className="btn btn-ghost" onClick={() => setDrawerOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={startCount}
              disabled={selectedCount === 0 || selectedCount > 500 || remoteLoading}
            >
              Iniciar contagem
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-px border border-line bg-line">
            {(
              [
                ['all', 'Todos os insumos'],
                ['low', 'Abaixo do mínimo'],
                ['category', 'Por categoria'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => resetScope(value)}
                className={`px-2 py-2.5 text-[11px] leading-tight transition-colors ${
                  scope === value ? 'bg-raised text-cream' : 'bg-panel text-dim hover:text-muted'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {scope === 'category' ? (
            <Field label="Categoria">
              <select
                className="select"
                value={category}
                onChange={(event) => {
                  setCategory(event.target.value);
                  setDeselected(new Set());
                }}
              >
                {(mode === 'production' ? remoteCategories : Array.from(new Set(state.items.map((item) => item.category)))).map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search
                size={13}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim"
              />
              <input
                className="input h-8 pl-8 text-[12px]"
                placeholder="Buscar insumo"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => {
                if (mode === 'production') {
                  if (selectionMode === 'all') {
                    setSelectionMode('custom');
                    setIncluded(new Set());
                    setDeselected(new Set());
                  } else {
                    setSelectionMode('all');
                    setIncluded(new Set());
                    setDeselected(new Set());
                  }
                  return;
                }
                setDeselected(selected.length === localCandidates.length
                  ? new Set(localCandidates.map((item) => item.id)) : new Set());
              }}
            >
              {mode === 'production'
                ? selectionMode === 'all' ? 'Limpar seleção' : 'Selecionar todos'
                : selectedCount === candidateTotal && candidateTotal > 0 ? 'Limpar' : 'Selecionar todos'}
            </button>
          </div>

          <div className="max-h-[46vh] overflow-y-auto border border-line">
            {remoteError ? <p role="alert" className="px-3 py-3 text-[11px] text-danger">{remoteError}</p> : null}
            {mode === 'production' && remoteLoading && candidates.length === 0 ? (
              <p role="status" className="px-3 py-6 text-center text-[11.5px] text-dim">Carregando itens da contagem…</p>
            ) : candidates.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11.5px] text-dim">
                Nenhum insumo para este filtro.
              </div>
            ) : (
              candidates.map((item) => {
                const isSelected = mode === 'production'
                  ? selectionMode === 'all' ? !deselected.has(item.id) : included.has(item.id)
                  : !deselected.has(item.id);
                return (
                  <label
                    key={item.id}
                    className="flex cursor-pointer items-center gap-3 border-b border-line/70 px-3 py-2.5 last:border-b-0 hover:bg-raised/50"
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {
                        if (mode === 'production') {
                          actions.cacheIngredients([item]);
                          if (selectionMode === 'all') {
                            if (!deselected.has(item.id) && deselected.size >= 500) {
                              notify('Limite de 500 itens excluídos. Limpe a seleção e marque apenas os itens desejados.', 'error');
                              return;
                            }
                            setDeselected((previous) => {
                              const next = new Set(previous);
                              if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                              return next;
                            });
                          } else {
                            if (!included.has(item.id) && included.size >= 500) {
                              notify('Uma contagem aceita até 500 itens selecionados.', 'error');
                              return;
                            }
                            setIncluded((previous) => {
                              const next = new Set(previous);
                              if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                              return next;
                            });
                          }
                          return;
                        }
                        setDeselected((previous) => {
                          const next = new Set(previous);
                          if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                          return next;
                        });
                      }}
                      className="h-3.5 w-3.5 shrink-0 accent-[#c37b45]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-cream">{item.name}</span>
                      <span className="block text-[10px] uppercase tracking-[0.06em] text-dim">
                        {item.category} · {fmtQty(item.currentQty, item.unit)}
                      </span>
                    </span>
                  </label>
                );
              })
            )}
          </div>
          {mode === 'production' ? <div className="flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-dim">
            <span>{candidates.length} exibidos de {candidateTotal} itens no filtro</span>
            {remoteHasMore ? <button type="button" className="text-copper hover:text-copper-hi"
              onClick={() => void loadMoreCandidates()} disabled={remoteLoading}>Carregar mais</button> : null}
          </div> : null}
          {selectedCount > 500 ? <p role="alert" className="text-[10.5px] text-warn">
            Uma contagem aceita até 500 insumos. Refine o filtro ou selecione menos itens.
          </p> : null}
          <p className="text-[10.5px] leading-relaxed text-dim">
            Itens não selecionados mantêm o estoque atual. A contagem sempre compara o saldo
            esperado com o contado, sem apagar o histórico.
          </p>
        </div>
      </Drawer>
    </div>
  );
}
