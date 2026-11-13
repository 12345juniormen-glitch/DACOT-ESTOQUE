import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, TrendingDown } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { useEnsureIngredients } from '../hooks/useEnsureIngredients';
import { fetchApiIngredient, fetchApiInventoryPage, fetchApiLoss, fetchApiLossMonthPage,
  fetchApiOperationalInsights, type ApiOperationalInsights } from '../lib/api';
import {
  lossesMonthCents,
  itemCostKnown,
  itemMovementValueCents,
  lossesWithoutCost,
  lossesThisMonth,
  lossesWeekCents,
  topLossItem,
  topLossReason,
} from '../domain/selectors';
import { date, money, parseStockQty, qty as fmtQty, time } from '../domain/format';
import { LOSS_REASONS, type LossReason } from '../domain/types';
import { Drawer, EmptyState, Field, PageHeader, Panel } from '../components/ui';

export function LossesPage() {
  const { state, actions, can, mode, ready, notify } = useApp();
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [itemId, setItemId] = useState(params.get('item') ?? '');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState<LossReason>('Vencimento');
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState<'all' | LossReason>('all');
  const [ingredientSearch, setIngredientSearch] = useState('');
  const [ingredientOptions, setIngredientOptions] = useState(state.items.filter((item) => item.active !== false));
  const [ingredientOptionsLoading, setIngredientOptionsLoading] = useState(false);
  const [ingredientOptionsError, setIngredientOptionsError] = useState<string | null>(null);
  const [lossRefresh, setLossRefresh] = useState(0);
  const [lossPage, setLossPage] = useState<{ tenantId: string | null; filter: 'all' | LossReason; losses: typeof state.losses;
    total: number; hasMore: boolean; loading: boolean; error: string | null }>(
      { tenantId: null, filter: 'all', losses: [], total: 0, hasMore: false, loading: false, error: null });
  const [operationalInsights, setOperationalInsights] = useState<ApiOperationalInsights | null>(null);
  const [insightsTenantId, setInsightsTenantId] = useState<string | null>(null);
  const [insightsLoadingTenantId, setInsightsLoadingTenantId] = useState<string | null>(null);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [focusedApiLoss, setFocusedApiLoss] = useState<typeof state.losses[number] | null>(null);

  useEffect(() => {
    if (mode !== 'production' || !ready || !state.restaurant.id) return;
    let current = true;
    setLossPage({ tenantId: state.restaurant.id, filter, losses: [], total: 0, hasMore: false, loading: true, error: null });
    void fetchApiLossMonthPage(filter, 0).then((page) => {
      if (current) setLossPage({ tenantId: state.restaurant.id, filter, ...page, loading: false, error: null });
    }).catch((error: unknown) => {
      if (current) setLossPage({ tenantId: state.restaurant.id, filter, losses: [], total: 0, hasMore: false, loading: false,
        error: error instanceof Error ? error.message : 'Não foi possível carregar as perdas.' });
    });
    return () => { current = false; };
  }, [mode, ready, state.restaurant.id, filter, lossRefresh]);

  useEffect(() => {
    if (mode !== 'production' || !ready || !state.restaurant.id) {
      setOperationalInsights(null);
      setInsightsError(null);
      setInsightsTenantId(null);
      setInsightsLoadingTenantId(null);
      return;
    }
    let current = true;
    setOperationalInsights(null);
    setInsightsTenantId(null);
    setInsightsLoadingTenantId(state.restaurant.id);
    setInsightsError(null);
    void fetchApiOperationalInsights().then((result) => {
      if (current) { setOperationalInsights(result); setInsightsTenantId(state.restaurant.id);
        setInsightsLoadingTenantId(null); }
    }).catch((error: unknown) => {
      if (current) { setInsightsError(error instanceof Error
        ? error.message : 'Não foi possível carregar o resumo financeiro das perdas.');
        setInsightsLoadingTenantId(null); }
    });
    return () => { current = false; };
  }, [mode, ready, state.restaurant.id, lossRefresh]);

  const requestedFocus = params.get('focus');
  useEffect(() => {
    if (mode !== 'production' || !ready || !requestedFocus) {
      setFocusedApiLoss(null);
      return;
    }
    let current = true;
    setFocusedApiLoss(null);
    void fetchApiLoss(requestedFocus).then((loss) => {
      if (current) setFocusedApiLoss(loss);
    }).catch((error: unknown) => {
      if (current) notify(error instanceof Error ? error.message : 'Registro de perda não encontrado.', 'error');
    });
    return () => { current = false; };
  }, [mode, ready, requestedFocus, state.restaurant.id, notify]);

  const focusedLoss = mode === 'production'
    ? (focusedApiLoss?.restaurantId === state.restaurant.id ? focusedApiLoss : null)
      ?? lossPage.losses.find((loss) => loss.id === requestedFocus && loss.restaurantId === state.restaurant.id) ?? null
    : state.losses.find((loss) => loss.id === requestedFocus) ?? null;
  const lossesForHydration = mode === 'production'
    ? [...(lossPage.tenantId === state.restaurant.id ? lossPage.losses : []),
      ...(focusedLoss ? [focusedLoss] : [])] : state.losses;
  const ingredientHydration = useEnsureIngredients(lossesForHydration.map((loss) => loss.itemId));

  useEffect(() => {
    const preselected = params.get('item');
    if (preselected) {
      setItemId(preselected);
      setOpen(true);
      params.delete('item');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  useEffect(() => {
    if (!open) return;
    if (mode !== 'production') {
      setIngredientOptions(state.items.filter((item) => item.active !== false));
      setIngredientOptionsError(null);
      return;
    }
    if (!ready || !state.restaurant.id) return;
    let current = true;
    const timer = window.setTimeout(() => {
      setIngredientOptionsLoading(true);
      setIngredientOptionsError(null);
      void fetchApiInventoryPage({ search: ingredientSearch, category: null, status: null, sort: 'name' },
        0, 50, true).then((page) => {
          if (current) {
            actionsRef.current.cacheIngredients(page.items);
            setIngredientOptions(page.items);
          }
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
  }, [open, mode, ready, state.restaurant.id, ingredientSearch]);

  useEffect(() => {
    if (mode !== 'production' || !ready || !itemId
        || state.items.some((item) => item.id === itemId)) return;
    let current = true;
    void fetchApiIngredient(itemId).then((item) => {
      if (current) actions.cacheIngredients([item]);
    }).catch((error: unknown) => {
      if (current) notify(error instanceof Error ? error.message : 'Insumo selecionado não encontrado.', 'error');
    });
    return () => { current = false; };
  }, [mode, ready, itemId, state.restaurant.id, state.items, notify]);

  const monthLosses = useMemo(() => {
    if (mode === 'production') {
      return lossPage.tenantId === state.restaurant.id && lossPage.filter === filter ? lossPage.losses : [];
    }
    const list = [...lossesThisMonth(state)].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
    return filter === 'all' ? list : list.filter((loss) => loss.reason === filter);
  }, [mode, state, filter, lossPage]);
  const visibleLosses = focusedLoss ? [focusedLoss] : monthLosses;
  const hasCurrentLossPage = mode === 'production' && lossPage.tenantId === state.restaurant.id
    && lossPage.filter === filter;
  const currentInsights = mode === 'production' && insightsTenantId === state.restaurant.id
    ? operationalInsights : null;
  const insightsPending = mode === 'production' && !currentInsights
    && insightsLoadingTenantId === state.restaurant.id;

  useEffect(() => {
    if (!focusedLoss) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`loss-record-${focusedLoss.id}`)?.scrollIntoView({ block: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedLoss?.id]);

  const totals = {
    month: mode === 'production' ? currentInsights?.losses.value_cents ?? 0 : lossesMonthCents(state),
    week: mode === 'production' ? currentInsights?.losses.week_value_cents ?? 0 : lossesWeekCents(state),
    reason: mode === 'production'
      ? currentInsights?.losses.top_month_reason
        ? { reason: currentInsights.losses.top_month_reason.reason as LossReason,
            valueCents: currentInsights.losses.top_month_reason.value_cents } : null
      : topLossReason(state),
    item: mode === 'production'
      ? currentInsights?.losses.top_item
        ? { item: { name: currentInsights.losses.top_item.ingredient_name },
            valueCents: currentInsights.losses.top_item.value_cents } : null
      : topLossItem(state),
  };
  const monthlyLossCount = mode === 'production'
    ? currentInsights?.losses.count ?? 0 : lossesThisMonth(state).length;
  const monthlyPricedLossCount = mode === 'production'
    ? currentInsights?.losses.priced_count ?? 0
    : lossesThisMonth(state).length - lossesWithoutCost(lossesThisMonth(state));
  const monthlyUnpricedLossCount = mode === 'production'
    ? currentInsights?.losses.unpriced_count ?? 0
    : lossesWithoutCost(lossesThisMonth(state));
  const reasonTotals = mode === 'production'
    ? (currentInsights?.losses.reason_totals ?? []).filter((row) => row.value_cents > 0)
        .map((row) => ({ reason: row.reason, value: row.value_cents }))
    : LOSS_REASONS.map((lossReason) => ({
        reason: lossReason,
        value: lossesThisMonth(state).filter((loss) => loss.reason === lossReason)
          .reduce((sum, loss) => sum + (loss.valueCents ?? 0), 0),
      })).filter((row) => row.value > 0).sort((a, b) => b.value - a.value);
  const maxReason = Math.max(1, ...reasonTotals.map((row) => row.value));

  const loadMoreLosses = async () => {
    if (mode !== 'production' || lossPage.loading || !lossPage.hasMore || !hasCurrentLossPage) return;
    setLossPage((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const next = await fetchApiLossMonthPage(filter, lossPage.losses.length);
      setLossPage((previous) => previous.tenantId === state.restaurant.id && previous.filter === filter ? ({ ...previous,
        losses: [...previous.losses, ...next.losses], total: next.total,
        hasMore: next.hasMore, loading: false, error: null }) : previous);
    } catch (error) {
      setLossPage((previous) => previous.tenantId === state.restaurant.id ? ({ ...previous, loading: false,
        error: error instanceof Error ? error.message : 'Não foi possível carregar mais perdas.' }) : previous);
    }
  };

  if (ingredientHydration.loading) {
    return <div><PageHeader eyebrow="04 / Perdas" title="Perdas" description="Consultando os insumos relacionados aos registros." /><Panel><div className="px-5 py-8 text-center text-[12px] text-dim" role="status">Carregando insumos das perdas…</div></Panel></div>;
  }
  if (ingredientHydration.error) {
    return <div><PageHeader eyebrow="04 / Perdas" title="Perdas" description="Não foi possível consultar os insumos relacionados." /><Panel><EmptyState icon={<TrendingDown size={18} />}
      title="Falha ao carregar insumos" description={ingredientHydration.error}
      action={<button type="button" className="btn btn-ghost" onClick={ingredientHydration.retry}>Tentar novamente</button>} /></Panel></div>;
  }

  const selectedItem = state.items.find((i) => i.id === itemId)
    ?? ingredientOptions.find((i) => i.id === itemId);
  const selectableIngredients = mode === 'production' && selectedItem
    && !ingredientOptions.some((item) => item.id === selectedItem.id)
    ? [selectedItem, ...ingredientOptions] : ingredientOptions;
  const parsedQuantity = parseStockQty(quantity);
  const lossQuantity = parsedQuantity ?? 0;
  const quantityExceedsStock = selectedItem != null && parsedQuantity != null
    && parsedQuantity > selectedItem.currentQty + 0.0001;
  const estimated = selectedItem && lossQuantity > 0 && !quantityExceedsStock
    ? itemMovementValueCents(selectedItem, lossQuantity) : null;
  const lossInputValid = selectedItem != null && selectedItem.active !== false
    && parsedQuantity != null && lossQuantity > 0 && !quantityExceedsStock;

  const submit = async () => {
    const ok = await actions.registerLoss({
      itemId,
      qty: lossQuantity,
      reason,
      note,
    });
    if (ok) {
      setOpen(false);
      setQuantity('');
      setNote('');
      setReason('Vencimento');
      if (mode === 'production') setLossRefresh((value) => value + 1);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="07 / Perdas"
        title="Perdas"
        description="Acompanhe o impacto das perdas e registre a causa para reduzir recorrências."
        actions={
          can('losses.manage') ? (
            <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
              <Plus size={14} />
              Registrar perda
            </button>
          ) : null
        }
      />

      {mode === 'production' && insightsError ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-line bg-panel px-4 py-3 text-[11px] text-muted">
          <span>{insightsError}</span>
          <button type="button" className="btn btn-ghost" onClick={() => setLossRefresh((value) => value + 1)}>
            Atualizar resumo
          </button>
        </div>
      ) : null}

      <section className="panel mb-5 grid grid-cols-2 gap-px overflow-hidden bg-line md:grid-cols-3">
        <div className="bg-panel px-4 py-4 md:col-span-1">
          <div className="eyebrow">Perdas precificadas no mês</div>
          <div className="mt-2 num text-[21px] text-copper">
            {mode === 'production' && !currentInsights ? '—' : money(totals.month)}
          </div>
          <div className="mt-1.5 text-[10.5px] text-dim">
            {mode === 'production' && !currentInsights ? insightsPending ? 'Carregando resumo…' : 'Resumo indisponível'
              : `${monthlyPricedLossCount} precificadas${monthlyUnpricedLossCount ? ` · ${monthlyUnpricedLossCount} sem custo` : ''}`}
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Perdas precificadas · 7 dias</div>
          <div className="mt-2 num text-[21px] text-cream">
            {mode === 'production' && !currentInsights ? '—' : money(totals.week)}
          </div>
          <div className="mt-1.5 text-[10.5px] text-dim">perdas registradas na semana</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Principal motivo precificado</div>
          <div className="mt-2 text-[15px] text-cream">
            {totals.reason?.reason ?? (mode === 'production' && !currentInsights ? '—' : '—')}
          </div>
          <div className="mt-1.5 num text-[10.5px] text-dim">
            {totals.reason ? money(totals.reason.valueCents) : mode === 'production' && !currentInsights
              ? insightsPending ? 'Carregando resumo…' : 'Resumo indisponível'
              : monthlyLossCount ? 'sem custo conhecido' : 'sem registros'}
          </div>
        </div>
        <div className="col-span-2 bg-panel px-4 py-2.5 md:col-span-3">
          <details>
            <summary className="cursor-pointer text-[10.5px] text-dim hover:text-muted">Mais resumo</summary>
            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-muted">
              <span>Maior perda precificada: {totals.item?.item.name ?? '—'} · {totals.item ? money(totals.item.valueCents) : mode === 'production' && !currentInsights
                ? insightsPending ? 'Carregando resumo…' : 'Resumo indisponível'
                : monthlyLossCount ? 'sem custo conhecido' : 'sem registros'}</span>
            </div>
          </details>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <Panel
          title="Registros de perda"
          subtitle="Ordenados do mais recente para o mais antigo."
          flush
          bodyClassName=""
          actions={
            <select
              className="select h-7 w-[168px] text-[11px]"
              value={filter}
              onChange={(event) => setFilter(event.target.value as 'all' | LossReason)}
              aria-label="Filtrar por motivo"
            >
              <option value="all">Todos os motivos</option>
              {LOSS_REASONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          }
        >
          {focusedLoss ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-raised px-4 py-2.5">
              <span className="text-[11px] text-muted">Registro localizado no histórico.</span>
              <button
                type="button"
                className="inline-flex min-h-9 items-center gap-1.5 text-[11px] text-copper hover:text-copper-hi"
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete('focus');
                  setParams(next, { replace: true });
                }}
              >
                <ArrowLeft size={13} />
                Ver todas as perdas
              </button>
            </div>
          ) : null}

          {mode === 'production' && (!hasCurrentLossPage || lossPage.loading)
            && visibleLosses.length === 0 ? (
            <div role="status" aria-live="polite" className="px-4 py-10 text-center text-[12px] text-dim">
              Carregando perdas do mês…
            </div>
          ) : mode === 'production' && hasCurrentLossPage && lossPage.error && visibleLosses.length === 0 ? (
            <div role="alert" className="px-4 py-8 text-center">
              <p className="text-[12px] text-muted">{lossPage.error}</p>
              <button type="button" className="btn btn-ghost mt-3"
                onClick={() => setLossRefresh((value) => value + 1)}>Tentar novamente</button>
            </div>
          ) : visibleLosses.length === 0 ? (
            <EmptyState
              icon={<TrendingDown size={18} />}
              title={mode === 'production' && !currentInsights ? 'Resumo de perdas indisponível'
                : monthlyLossCount === 0 ? 'Nenhuma perda registrada neste mês' : 'Nenhum registro neste filtro'}
              description={
                mode === 'production' && !currentInsights
                  ? 'Não foi possível confirmar os totais do mês. Tente atualizar a consulta.'
                  : monthlyLossCount === 0
                  ? 'Registre quebras, vencimentos e sobras para entender o impacto financeiro real da operação.'
                  : 'Altere o filtro de motivo para ver outros registros do mês.'
              }
              action={
                can('losses.manage') && currentInsights && monthlyLossCount === 0 ? (
                  <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
                    Registrar primeira perda
                  </button>
                ) : null
              }
            />
          ) : (
            <>
              <div className="scroll-x hidden md:block">
                <table className="table min-w-[540px]">
                  <thead>
                    <tr>
                      <th>Insumo</th>
                      <th className="text-right">Quantidade</th>
                      <th>Motivo</th>
                      <th className="text-right">Valor perdido</th>
                      <th>Registro</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleLosses.map((loss) => {
                      const item = state.items.find((i) => i.id === loss.itemId);
                      const user = state.users.find((u) => u.id === loss.userId);
                      return (
                        <tr key={loss.id} id={`loss-record-${loss.id}`} className={focusedLoss?.id === loss.id ? 'bg-copper/10' : undefined}>
                          <td className="text-[12.5px] text-cream">{item?.name ?? '—'}<div className="mt-0.5 font-mono text-[10px] text-dim">{date(loss.at)}</div></td>
                          <td className="text-right num text-[12px] text-cream">
                            {item ? fmtQty(loss.qty, item.unit) : loss.qty}
                          </td>
                          <td className="text-[11.5px] text-muted">{loss.reason}</td>
                          <td className="text-right num text-[12.5px] text-copper">
                            {loss.valueCents == null ? '—' : money(loss.valueCents)}
                          </td>
                          <td className="text-[11px] text-muted">
                            <details>
                              <summary className="cursor-pointer text-muted hover:text-cream">Detalhes</summary>
                              <div className="mt-1 min-w-[160px] text-[10px] leading-relaxed text-dim">{time(loss.at)} · {user?.name ?? '—'}{loss.note ? <div>{loss.note}</div> : null}</div>
                            </details>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="divide-y divide-line md:hidden">
                {visibleLosses.map((loss) => {
                  const item = state.items.find((i) => i.id === loss.itemId);
                  const user = state.users.find((u) => u.id === loss.userId);
                  return (
                    <div
                      key={loss.id}
                      id={`loss-record-${loss.id}`}
                      className={`px-4 py-3 ${focusedLoss?.id === loss.id ? 'bg-copper/10' : ''}`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-[13px] text-cream">{item?.name ?? '—'}</div>
                          <div className="mt-0.5 text-[10.5px] text-dim">{date(loss.at)} · {loss.reason}</div>
                        </div>
                        <div className="text-right">
                          <div className="num text-[13px] text-copper">{loss.valueCents == null ? '—' : money(loss.valueCents)}</div>
                          <div className="num text-[10.5px] text-dim">
                            {item ? fmtQty(loss.qty, item.unit) : loss.qty}
                          </div>
                        </div>
                      </div>
                      <details className="mt-1.5 text-[10.5px] text-dim">
                        <summary className="cursor-pointer">Responsável e observação</summary>
                        <div className="mt-1">{time(loss.at)} · {user?.name ?? '—'}{loss.note ? <p className="mt-1 leading-relaxed">{loss.note}</p> : null}</div>
                      </details>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center justify-between border-t border-line px-4 py-3">
                <span className="text-[11px] text-dim">
                  {focusedLoss ? '1 registro localizado' : `${mode === 'production' ? lossPage.total : monthLosses.length} registros no filtro`}
                </span>
                <span className="num text-[13px] text-cream">
                  {money(visibleLosses.reduce((sum, loss) => sum + (loss.valueCents ?? 0), 0))}
                  {lossesWithoutCost(visibleLosses) ? ` · ${lossesWithoutCost(visibleLosses)} sem custo` : ''}
                </span>
              </div>
              {mode === 'production' && hasCurrentLossPage && !focusedLoss && lossPage.hasMore ? (
                <div className="flex justify-center border-t border-line px-4 py-3">
                  <button type="button" className="btn btn-ghost" onClick={() => { void loadMoreLosses(); }}
                    disabled={lossPage.loading}>
                    {lossPage.loading ? 'Carregando…' : 'Carregar mais perdas'}
                  </button>
                </div>
              ) : null}
            </>
          )}
        </Panel>

        <Panel title="Motivos no mês" subtitle="Impacto financeiro por causa." flush bodyClassName="">
          {reasonTotals.length === 0 ? (
            <div className="px-4 py-4 text-[11px] leading-relaxed text-dim">
              {lossesThisMonth(state).length ? 'Há perdas sem custo cadastrado; complete o custo do insumo para calcular o impacto financeiro.' : 'Sem perdas registradas neste mês.'}
            </div>
          ) : (
            <div className="divide-y divide-line">
              {reasonTotals.map((row) => (
                <div key={row.reason} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2 text-[11.5px]">
                    <span className="text-muted">{row.reason}</span>
                    <span className="num text-[11px] text-cream">{money(row.value)}</span>
                  </div>
                  <div className="mt-1.5 h-[2px] w-full bg-line">
                    <div
                      className="h-full bg-copper/70"
                      style={{ width: `${(row.value / maxReason) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="border-t border-line px-4 py-3 text-[10px] leading-relaxed text-dim">
            Perdas geram saída e entram na auditoria. Valores usam o custo cadastrado no registro; perdas sem custo ficam como não precificadas.
          </div>
        </Panel>
      </div>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Perdas"
        title="Registrar perda"
        description="A perda reduz o estoque imediatamente. O impacto financeiro depende de haver custo cadastrado."
        footer={
          <>
            <span className="mr-auto text-[11px] text-dim">
              Impacto <span className="num text-copper">{estimated == null ? '—' : money(estimated)}</span>
            </span>
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={submit}
              disabled={!lossInputValid}
            >
              Registrar perda
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Insumo" htmlFor="loss-item">
            {mode === 'production' ? (
              <input
                className="input mb-2 h-9"
                value={ingredientSearch}
                onChange={(event) => setIngredientSearch(event.target.value)}
                placeholder="Buscar insumo ativo"
                aria-label="Buscar insumo ativo"
              />
            ) : null}
            <select
              id="loss-item"
              className="select"
              value={itemId}
              onChange={(event) => {
                const next = event.target.value;
                setItemId(next);
                const selected = selectableIngredients.find((item) => item.id === next);
                if (selected) actions.cacheIngredients([selected]);
              }}
            >
              <option value="">Selecionar insumo</option>
              {selectableIngredients.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {itemCostKnown(item) ? `${money(item.costCents)}/${item.unit}` : 'custo não cadastrado'}
                </option>
              ))}
            </select>
            {mode === 'production' && ingredientOptionsLoading ? (
              <p role="status" className="mt-1 text-[10.5px] text-dim">Buscando insumos…</p>
            ) : null}
            {mode === 'production' && ingredientOptionsError ? (
              <p role="alert" className="mt-1 text-[10.5px] text-danger">{ingredientOptionsError}</p>
            ) : null}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Quantidade"
              htmlFor="loss-qty"
              hint={selectedItem ? `Disponível: ${fmtQty(selectedItem.currentQty, selectedItem.unit)}` : undefined}
            >
              <div className="relative">
                <input
                  id="loss-qty"
                  className="input num pr-9"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  placeholder="0"
                  aria-invalid={quantity.trim().length > 0 && (parsedQuantity == null || quantityExceedsStock)}
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-dim">
                  {selectedItem?.unit ?? 'un'}
                </span>
              </div>
              {quantityExceedsStock ? <p role="alert" className="mt-1 text-[10.5px] text-danger">
                A quantidade excede o saldo disponível.
              </p> : null}
              {quantity.trim() && parsedQuantity == null ? <p role="alert" className="mt-1 text-[10.5px] text-danger">
                Informe uma quantidade válida, com até 3 casas decimais.
              </p> : null}
            </Field>
            <Field label="Motivo" htmlFor="loss-reason">
              <select
                id="loss-reason"
                className="select"
                value={reason}
                onChange={(event) => setReason(event.target.value as LossReason)}
              >
                {LOSS_REASONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Observação" htmlFor="loss-note">
            <textarea
              id="loss-note"
              className="textarea min-h-[80px]"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="O que aconteceu? Isso ajuda a atacar a causa depois."
            />
          </Field>
          <div className="flex items-center justify-between border border-line bg-[#0b0b0a] px-3 py-2.5">
            <span className="text-[10.5px] text-dim">Valor estimado perdido</span>
            <span className="num text-[14px] text-copper">{estimated == null ? 'não calculável' : money(estimated)}</span>
          </div>
        </div>
      </Drawer>
    </div>
  );
}
