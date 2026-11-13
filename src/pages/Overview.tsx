import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Boxes,
  ClipboardList,
  RefreshCcw,
  ShoppingCart,
  TrendingDown,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { useApp, useCurrentUser } from '../state/AppStore';
import { NOW_ISO } from '../domain/clock';
import { date, money, qty as fmtQty, time } from '../domain/format';
import {
  attentionItems,
  belowMinItems,
  comparePricedLossesToReceivedGoods,
  countsWithUnknownFinancialImpact,
  consumptionCoverageLabel,
  divergenceCents,
  itemStatus,
  lossesThisMonth,
  lossesMonthCents,
  lossesWithoutCost,
  lossAlertSeverity,
  itemsWithoutCost,
  purchasesMonthCents,
  purchasesMonthCount,
  recommendedPurchases,
  receivedGoodsThisMonth,
  recentMovements,
  risingCostItems,
  referenceDate,
  stockValueCents,
} from '../domain/selectors';
import { MOVEMENT_LABEL, type RecommendedPurchase } from '../domain/types';
import { fetchApiInventoryInsights, fetchApiOperationalInsights,
  fetchApiPriceRiseInsights, fetchApiReplenishmentRecommendations,
  type ApiInventoryInsights, type ApiOperationalInsights, type ApiPriceRiseInsights } from '../lib/api';
import { PageHeader, Panel, EmptyState } from '../components/ui';

function MetricCell({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-panel px-4 py-3">
      <div className="text-[9.5px] font-medium uppercase tracking-[0.13em] text-dim">{label}</div>
      <div className={`mt-1.5 num text-[16px] leading-none ${accent ? 'text-copper' : 'text-cream'}`}>
        {value}
      </div>
      <div className="mt-1 text-[10px] leading-snug text-dim">{sub}</div>
    </div>
  );
}

function compactAlertTitle(tag: string, title: string) {
  if (tag === 'Sem estoque') return title.replace(' está sem estoque.', ' acabou');
  if (tag === 'Custo em alta') return title.replace(' aumentou ', ' +').replace(' nas últimas compras.', '');
  return title;
}

function compactAlertDetail(tag: string, detail: string, recommendation?: RecommendedPurchase) {
  if (tag === 'Custo em alta') return detail.split('. O consumo atual')[0].replace('Passou de ', '').replace(' para ', ' → ').replace(' por ', '/');
  if (tag === 'Sem estoque' && recommendation) return `Comprar ${fmtQty(recommendation.recommendedQty, recommendation.item.unit)}`;
  if (tag === 'Sem estoque') return 'Reposição necessária';
  if (tag === 'Reposição') return detail.replace(/Consumo médio de .*? Compra sugerida de /, 'Comprar ').replace(/ para cobrir .*$/, '');
  if (tag === 'Divergência') return detail.split('. Diferença financeira')[0];
  if (tag === 'Perdas') return detail.split('. ')[0];
  return detail;
}

export function OverviewPage() {
  const { state, actions, can, mode, ready } = useApp();
  const [showAllAlerts, setShowAllAlerts] = useState(false);
  const [showIntegrationDetails, setShowIntegrationDetails] = useState(false);
  const [inventoryInsights, setInventoryInsights] = useState<ApiInventoryInsights | null>(null);
  const [operationalInsights, setOperationalInsights] = useState<ApiOperationalInsights | null>(null);
  const [priceRiseInsights, setPriceRiseInsights] = useState<ApiPriceRiseInsights | null>(null);
  const [remoteRecommendations, setRemoteRecommendations] = useState<RecommendedPurchase[] | null>(null);
  const [dashboardErrors, setDashboardErrors] = useState({ inventory: false, operational: false,
    priceRise: false, recommendations: false });
  const [dashboardRetry, setDashboardRetry] = useState(0);
  const [dashboardTenantId, setDashboardTenantId] = useState('');
  const user = useCurrentUser();

  useEffect(() => {
    const refreshDashboard = () => setDashboardRetry((value) => value + 1);
    window.addEventListener('dacot:dashboard-refresh', refreshDashboard);
    return () => window.removeEventListener('dacot:dashboard-refresh', refreshDashboard);
  }, []);

  useEffect(() => {
    setDashboardTenantId(mode === 'production' && ready ? state.restaurant.id : '');
  }, [mode, ready, state.restaurant.id]);

  useEffect(() => {
    if (mode !== 'production' || !ready || !state.restaurant.id) {
      setInventoryInsights(null);
      setDashboardErrors((current) => ({ ...current, inventory: false }));
      return;
    }
    let current = true;
    setInventoryInsights(null);
    setDashboardErrors((errors) => ({ ...errors, inventory: false }));
    void fetchApiInventoryInsights().then((insights) => {
      if (current) setInventoryInsights(insights);
    }).catch(() => {
      if (current) {
        setInventoryInsights(null);
        setDashboardErrors((errors) => ({ ...errors, inventory: true }));
      }
    });
    return () => { current = false; };
  }, [mode, ready, state.restaurant.id, dashboardRetry]);

  useEffect(() => {
    if (mode !== 'production' || !ready || !state.restaurant.id) {
      setPriceRiseInsights(null);
      setDashboardErrors((current) => ({ ...current, priceRise: false }));
      return;
    }
    let current = true;
    setPriceRiseInsights(null);
    setDashboardErrors((errors) => ({ ...errors, priceRise: false }));
    void fetchApiPriceRiseInsights().then((insights) => {
      if (current) setPriceRiseInsights(insights);
    }).catch(() => {
      if (current) {
        setPriceRiseInsights(null);
        setDashboardErrors((errors) => ({ ...errors, priceRise: true }));
      }
    });
    return () => { current = false; };
  }, [mode, ready, state.restaurant.id, dashboardRetry]);

  useEffect(() => {
    if (mode !== 'production' || !ready || !state.restaurant.id) {
      setRemoteRecommendations(null);
      setDashboardErrors((current) => ({ ...current, recommendations: false }));
      return;
    }
    let current = true;
    setRemoteRecommendations(null);
    setDashboardErrors((errors) => ({ ...errors, recommendations: false }));
    void fetchApiReplenishmentRecommendations().then((result) => {
      if (current) setRemoteRecommendations(result.items);
    }).catch(() => {
      if (current) {
        setRemoteRecommendations(null);
        setDashboardErrors((errors) => ({ ...errors, recommendations: true }));
      }
    });
    return () => { current = false; };
  }, [mode, ready, state.restaurant.id, dashboardRetry]);

  useEffect(() => {
    if (mode !== 'production' || !ready || !state.restaurant.id) {
      setOperationalInsights(null);
      setDashboardErrors((current) => ({ ...current, operational: false }));
      return;
    }
    let current = true;
    setOperationalInsights(null);
    setDashboardErrors((errors) => ({ ...errors, operational: false }));
    void fetchApiOperationalInsights().then((insights) => {
      if (current) setOperationalInsights(insights);
    }).catch(() => {
      if (current) {
        setOperationalInsights(null);
        setDashboardErrors((errors) => ({ ...errors, operational: true }));
      }
    });
    return () => { current = false; };
  }, [mode, ready, state.restaurant.id, dashboardRetry]);

  const isProduction = mode === 'production';
  const currentDashboardTenant = !isProduction || dashboardTenantId === state.restaurant.id;
  const serverInventoryInsights = currentDashboardTenant ? inventoryInsights : null;
  const serverOperationalInsights = currentDashboardTenant ? operationalInsights : null;
  const serverPriceRiseInsights = currentDashboardTenant ? priceRiseInsights : null;
  const serverRecommendations = currentDashboardTenant ? remoteRecommendations : null;
  const stockValue = isProduction ? serverInventoryInsights?.known_stock_value_cents ?? null : stockValueCents(state);
  const missingCostItems = isProduction ? serverInventoryInsights?.without_cost ?? null : itemsWithoutCost(state).length;
  const activeItemCount = isProduction ? serverInventoryInsights?.active_total ?? null
    : state.items.filter((item) => item.active !== false).length;
  const purchasesCount = isProduction ? state.purchaseMonthInsight?.orderCount ?? null : purchasesMonthCount(state);
  const purchasesValue = isProduction ? state.purchaseMonthInsight?.expectedTotalCents ?? null : purchasesMonthCents(state);
  const losses = isProduction ? [] : lossesThisMonth(state);
  const lossesValue = isProduction ? serverOperationalInsights?.losses.value_cents ?? null : lossesMonthCents(state);
  const lossesCount = isProduction ? serverOperationalInsights?.losses.count ?? null : losses.length;
  const pricedLossCount = isProduction ? serverOperationalInsights?.losses.priced_count ?? null
    : losses.length - lossesWithoutCost(losses);
  const unpricedLossCount = isProduction ? serverOperationalInsights?.losses.unpriced_count ?? null
    : lossesWithoutCost(losses);
  const receivedGoods = isProduction ? state.purchaseMonthInsight ? {
    valueCents: state.purchaseMonthInsight.receivedTotalCents,
    unpricedCount: state.purchaseMonthInsight.receivedUnpricedCount,
  } : null : receivedGoodsThisMonth(state);
  const lossReceiptComparison = comparePricedLossesToReceivedGoods(lossesValue, lossesCount,
    pricedLossCount, receivedGoods?.valueCents ?? null, receivedGoods?.unpricedCount ?? null);
  const low = belowMinItems(state);
  const criticalCount = isProduction ? serverInventoryInsights
    ? serverInventoryInsights.active_critical + serverInventoryInsights.active_empty : null
    : low.filter((item) => ['critical', 'empty'].includes(itemStatus(item))).length;
  const lowCount = isProduction ? serverInventoryInsights
    ? criticalCount! + serverInventoryInsights.active_attention : null : low.length;
  const divergence = isProduction ? serverOperationalInsights?.counts.divergence_cents ?? null : divergenceCents(state);
  const unknownFinancialCounts = isProduction ? serverOperationalInsights?.counts.unknown_financial_count ?? null
    : countsWithUnknownFinancialImpact(state);
  const rising = isProduction ? [] : risingCostItems(state);
  const topRise = isProduction ? serverPriceRiseInsights?.top ?? null : rising[0] ?? null;
  const risingCount = isProduction ? serverPriceRiseInsights?.count ?? null : rising.length;
  const recommendations = isProduction ? serverRecommendations ?? [] : recommendedPurchases(state);
  const dashboardComplete = !isProduction || (!!inventoryInsights && !!operationalInsights
    && !!priceRiseInsights && remoteRecommendations !== null && currentDashboardTenant);
  const dashboardFailed = currentDashboardTenant && Object.values(dashboardErrors).some(Boolean);
  const alerts = isProduction ? [] : attentionItems(state);
  if (isProduction && dashboardComplete && serverRecommendations !== null) {
    for (let index = alerts.length - 1; index >= 0; index -= 1) {
      if (['Sem estoque', 'Reposição', 'Compra recomendada'].includes(alerts[index].tag)) {
        alerts.splice(index, 1);
      }
    }
    for (const recommendation of serverRecommendations.slice(0, 3)) {
      const status = recommendation.stockStatus ?? 'attention';
      const isEmpty = status === 'empty';
      alerts.push({
        id: `${isEmpty ? 'empty' : 'minimum'}-${recommendation.item.id}`,
        severity: status === 'attention' ? 'medium' : 'high',
        tag: isEmpty ? 'Sem estoque' : 'Reposição',
        title: isEmpty ? `${recommendation.item.name} está sem estoque.`
          : `${recommendation.item.name} está abaixo do estoque mínimo.`,
        detail: `Comprar ${fmtQty(recommendation.recommendedQty)} ${recommendation.item.unit} para recompor o mínimo de ${fmtQty(recommendation.item.minQty)} ${recommendation.item.unit}.`,
        valueCents: recommendation.estimatedCostCents, valueLabel: 'reposição estimada',
        href: `/estoque/${recommendation.item.id}`, actionLabel: 'Ver insumo',
      });
    }
  }
  if (isProduction && dashboardComplete && serverPriceRiseInsights) {
    const previousRiseIndex = alerts.findIndex((alert) => alert.tag === 'Custo em alta');
    if (previousRiseIndex >= 0) alerts.splice(previousRiseIndex, 1);
    if (topRise) {
      alerts.splice(previousRiseIndex >= 0 ? previousRiseIndex : alerts.length, 0, {
        id: `rise-${topRise.item.id}`, severity: 'high', tag: 'Custo em alta',
        title: `${topRise.item.name} aumentou ${(topRise.variation * 100).toFixed(1)}% nas últimas compras.`,
        detail: `Passou de ${money(topRise.firstCents)} para ${money(topRise.lastCents)} por ${topRise.item.unit}. Impacto mensal depende do registro de consumo.`,
        valueCents: null, valueLabel: null, href: `/estoque/${topRise.item.id}`,
        actionLabel: 'Ver histórico',
      });
    }
  }
  if (isProduction && dashboardComplete && serverOperationalInsights) {
    const previousCountIndex = alerts.findIndex((alert) => alert.tag === 'Divergência');
    if (previousCountIndex >= 0) alerts.splice(previousCountIndex, 1);
    const latestCount = serverOperationalInsights.counts.last_divergence;
    if (latestCount) {
      const difference = latestCount.difference_milli;
      const quantity = `${fmtQty(Math.abs(difference) / 1000)} ${latestCount.unit}`;
      alerts.splice(previousCountIndex >= 0 ? previousCountIndex : alerts.length, 0, {
        id: `count-${latestCount.id}`, severity: 'high', tag: 'Divergência',
        title: `Contagem encontrou ${difference > 0 ? '+' : '−'}${quantity} de ${latestCount.ingredient_name.toLowerCase()}.`,
        detail: `${latestCount.code} aprovada em ${date(latestCount.approved_at)}. ${latestCount.impact_complete
          ? `Divergência financeira bruta de ${money(latestCount.divergence_cents ?? latestCount.impact_cents ?? 0)} na contagem.`
          : 'Impacto financeiro não calculável: há insumo sem custo cadastrado.'}`,
        valueCents: latestCount.impact_complete
          ? latestCount.divergence_cents ?? latestCount.impact_cents : null,
        valueLabel: latestCount.impact_complete ? 'divergência bruta' : null,
        href: '/contagem', actionLabel: 'Revisar contagem',
      });
    }
  }
  if (isProduction && dashboardComplete && serverOperationalInsights) {
    const previousLossIndex = alerts.findIndex((alert) => alert.tag === 'Perdas');
    if (previousLossIndex >= 0) alerts.splice(previousLossIndex, 1);
    const weekLosses = serverOperationalInsights.losses.week_value_cents;
    if (weekLosses > 0) {
      const topReason = serverOperationalInsights.losses.top_month_reason;
      alerts.splice(previousLossIndex >= 0 ? previousLossIndex : alerts.length, 0, {
        id: 'losses-week', severity: lossAlertSeverity(weekLosses), tag: 'Perdas',
        title: `Você perdeu ${money(weekLosses)} em desperdícios nos últimos 7 dias.`,
        detail: topReason ? `${topReason.reason} é o motivo com maior impacto no mês.`
          : 'Registre o motivo de cada perda para identificar a origem.',
        valueCents: weekLosses, valueLabel: 'últimos 7 dias', href: '/perdas',
        actionLabel: 'Ver perdas',
      });
    }
  }
  const movements = recentMovements(state, 7);
  const lastEvent = state.events[0];
  const reference = referenceDate(state);
  const eventsToday = state.events.filter(
    (event) => new Date(event.occurredAt).toDateString() === reference.toDateString(),
  ).length;

  return (
    <div>
      <PageHeader
        eyebrow="01 / Visão Geral"
        title="Visão geral"
        description={`O que exige decisão no ${state.restaurant.name} hoje.`}
        meta={
          <span className="text-[11px] text-dim">
            Operador: <span className="text-muted">{user.name}</span> · {activeItemCount ?? '—'} insumos
            ativos
          </span>
        }
        actions={
          <>
            <Link to="/contagem?nova=1" className="btn btn-ghost">
              <ClipboardList size={14} />
              Nova contagem
            </Link>
            {can('purchases.manage') ? (
              <Link to="/compras?novo=1" className="btn btn-primary">
                <ShoppingCart size={14} />
                Novo pedido
              </Link>
            ) : null}
          </>
        }
      />

      <section className="panel mb-5 grid grid-cols-2 gap-px overflow-hidden bg-line md:grid-cols-3">
        <MetricCell
          label="Valor conhecido em estoque"
          value={stockValue == null ? '—' : money(stockValue)}
          sub={isProduction ? serverInventoryInsights
            ? `${serverInventoryInsights.total - (missingCostItems ?? 0)} precificados${missingCostItems ? ` · ${missingCostItems} sem custo` : ''}`
            : dashboardFailed && dashboardErrors.inventory ? 'Resumo indisponível' : 'Carregando resumo…'
            : `${state.items.length - (missingCostItems ?? 0)} precificados${missingCostItems ? ` · ${missingCostItems} sem custo` : ''}`}
        />
        <MetricCell
          label="Total previsto em pedidos"
          value={purchasesValue == null ? '—' : money(purchasesValue)}
          sub={purchasesCount == null ? 'Resumo indisponível' : `${purchasesCount} não cancelados · inclui rascunhos`}
        />
        <MetricCell
          label="Perdas precificadas no mês"
          value={lossesValue == null ? '—' : money(lossesValue)}
          sub={isProduction ? serverOperationalInsights
            ? `${pricedLossCount ?? 0} precificadas${unpricedLossCount ? ` · ${unpricedLossCount} sem custo` : ''}`
            : dashboardFailed && dashboardErrors.operational ? 'Resumo indisponível' : 'Carregando resumo…'
            : `${pricedLossCount ?? 0} precificadas${unpricedLossCount ? ` · ${unpricedLossCount} sem custo` : ''}`}
        />
        <MetricCell
          label="Abaixo do mínimo"
          value={lowCount == null ? '—' : `${lowCount} itens`}
          sub={criticalCount == null ? isProduction
            ? dashboardFailed && dashboardErrors.inventory ? 'Resumo indisponível' : 'Carregando resumo…'
            : 'Sem itens críticos' : `${criticalCount} em nível crítico ou zerado`}
          accent
        />
        <MetricCell
          label="Divergências"
          value={divergence == null ? '—' : money(divergence)}
          sub={isProduction ? serverOperationalInsights
            ? `diferença precificada${unknownFinancialCounts ? ` · ${unknownFinancialCounts} contagem(ns) sem custo completo` : ''}`
            : dashboardFailed && dashboardErrors.operational ? 'Resumo indisponível' : 'Carregando resumo…'
            : `diferença precificada${unknownFinancialCounts ? ` · ${unknownFinancialCounts} contagem(ns) sem custo completo` : ''}`}
        />
        <MetricCell
          label="Custos em alta"
          value={risingCount == null ? '—' : `${risingCount} itens`}
          sub={isProduction && !serverPriceRiseInsights
            ? dashboardFailed && dashboardErrors.priceRise ? 'Resumo indisponível' : 'Carregando resumo…'
            : topRise ? `${topRise.item.name} +${(topRise.variation * 100).toFixed(1)}%` : 'sem aumentos relevantes'}
          accent={risingCount != null && risingCount > 0}
        />
      </section>

      {isProduction && dashboardFailed ? (
        <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 border border-warn/30 bg-panel px-4 py-3">
          <span className="text-[11px] text-muted">Um ou mais indicadores do dashboard não puderam ser confirmados. Os totais e alertas afetados foram ocultados.</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDashboardRetry((value) => value + 1)}>
            Tentar novamente
          </button>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel
          title="O que precisa da sua atenção"
          subtitle="Ações ordenadas por risco e impacto."
          bodyClassName=""
          flush
          actions={
            <span className="font-mono text-[10px] text-dim">
              {alerts.length} {alerts.length === 1 ? 'ação' : 'ações'}
            </span>
          }
        >
          {alerts.length === 0 ? (
            <EmptyState
              icon={<Boxes size={18} />}
              title={isProduction && !dashboardComplete
                ? dashboardFailed ? 'Resumo de alertas indisponível' : 'Carregando indicadores'
                : 'Nenhum ponto crítico agora'}
              description={isProduction && !dashboardComplete
                ? 'Os alertas só aparecem quando os indicadores necessários forem confirmados pelo servidor.'
                : 'Estoque, custos e contagens estão dentro do esperado. Registre movimentações para manter o painel atualizado.'}
            />
          ) : (
            <div>
              {(showAllAlerts ? alerts : alerts.slice(0, 5)).map((alert) => {
                const recommendation = recommendations.find((rec) => alert.id.endsWith(rec.item.id));
                return (
                <Link
                  key={alert.id}
                  to={alert.href}
                  className="group flex items-start gap-3 border-b border-line/70 px-4 py-3 transition-colors hover:bg-raised/50 sm:px-5"
                >
                  <span
                    className={`mt-1 h-8 w-[2px] shrink-0 ${
                      alert.severity === 'high' ? 'bg-danger' : 'bg-warn'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium leading-snug text-cream">
                      {compactAlertTitle(alert.tag, alert.title)}
                    </div>
                    <p className="mt-0.5 max-w-2xl text-[11px] leading-relaxed text-muted">
                      {compactAlertDetail(alert.tag, alert.detail, recommendation)}{alert.valueCents != null ? <> · <span className="num text-cream">{money(alert.valueCents)}</span></> : null}
                    </p>
                  </div>
                  <span className="hidden text-[10.5px] text-copper sm:inline">{alert.actionLabel}</span>
                  <ArrowRight
                    size={13}
                    className="mt-1 shrink-0 text-dim transition-transform group-hover:translate-x-0.5 group-hover:text-copper"
                  />
                </Link>
                );
              })}
              {alerts.length > 5 ? (
                <button type="button" className="w-full px-4 py-2.5 text-left text-[11px] text-muted hover:text-cream" onClick={() => setShowAllAlerts((value) => !value)}>
                  {showAllAlerts ? 'Mostrar menos' : `Ver todas as ${alerts.length} ações`}
                </button>
              ) : null}
            </div>
          )}
        </Panel>

        <div className="flex flex-col gap-5">
          <Panel
            title="Compras recomendadas"
            subtitle="Quantidade e valor para reposição."
            flush
            bodyClassName=""
            actions={
              <Link to="/estoque" className="text-[11px] text-dim hover:text-cream">
                Estoque
              </Link>
            }
          >
            {isProduction && serverRecommendations === null ? (
              <EmptyState icon={<ShoppingCart size={18} />}
                title={dashboardFailed && dashboardErrors.recommendations ? 'Recomendações indisponíveis' : 'Carregando recomendações'}
                description={dashboardFailed && dashboardErrors.recommendations
                  ? 'Não foi possível confirmar os itens abaixo do mínimo. Tente atualizar os indicadores.'
                  : 'Consultando saldos e mínimos registrados no servidor.'} />
            ) : recommendations.length === 0 ? (
              <EmptyState
                icon={<ShoppingCart size={18} />}
                title="Nenhuma compra necessária"
                description="Nenhum item abaixo do mínimo. Recomendações por consumo dependem de histórico operacional registrado."
              />
            ) : (
              <div>
                {recommendations.slice(0, 5).map((rec) => {
                  const supplier = state.suppliers.find(
                    (candidate) => candidate.id === rec.item.primarySupplierId && candidate.active !== false,
                  );
                  const query = new URLSearchParams({
                    novo: '1', item: rec.item.id, qty: String(rec.recommendedQty),
                    ...(supplier ? { supplier: supplier.id } : {}),
                  });
                  return (
                    <div key={rec.item.id} className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-3 last:border-b-0">
                      <Link to={`/estoque/${rec.item.id}`} className="min-w-0 hover:text-cream">
                        <div className="truncate text-[12.5px] text-cream">{rec.item.name}</div>
                        <div className="mt-0.5 text-[10.5px] text-dim">
                          {rec.basis === 'minimum'
                            ? 'Abaixo do estoque mínimo'
                            : consumptionCoverageLabel(rec.item.currentQty, rec.daysRemaining)}
                        </div>
                      </Link>
                      <div className="flex shrink-0 items-center gap-3">
                        <div className="text-right">
                          <div className="num text-[12.5px] text-copper">{fmtQty(rec.recommendedQty, rec.item.unit)}</div>
                          <div className="mt-0.5 text-[10px] text-dim">{rec.estimatedCostCents == null ? 'custo não cadastrado' : money(rec.estimatedCostCents)}</div>
                        </div>
                        {can('purchases.manage') ? (
                          <Link to={`/compras?${query.toString()}`} className="btn btn-ghost btn-sm">Criar pedido</Link>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                <details className="border-t border-line px-4 py-2.5 text-[10.5px] text-dim">
                  <summary className="cursor-pointer">Como calculamos</summary>
                  <p className="mt-2 leading-relaxed">{isProduction
                    ? 'Em produção, a quantidade recompõe o mínimo configurado. O consumo de vendas ainda não está conectado; prazo de entrega e estoque de segurança não entram neste cálculo.'
                    : 'Itens abaixo do mínimo recebem quantidade para recompor o limite configurado. Com histórico de consumo demonstrativo, a quantidade considera consumo médio, prazo de entrega e estoque de segurança; não é uma previsão estatística.'}</p>
                </details>
              </div>
            )}
          </Panel>

          <Panel
            title="DACOT Pedidos"
            flush
            bodyClassName=""
            actions={<span className="status status-normal text-[11px]">{mode === 'demo' ? 'Demonstração' : 'Não integrado'}</span>}
          >
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-[11.5px] text-muted">{mode === 'demo'
                ? `${eventsToday} pedidos processados hoje`
                : 'Vendas ainda não conectadas'}</span>
              <button type="button" className="text-[10.5px] text-dim hover:text-cream" onClick={() => setShowIntegrationDetails((value) => !value)} aria-expanded={showIntegrationDetails}>
                {showIntegrationDetails ? 'Ocultar detalhes' : 'Detalhes'}
              </button>
            </div>
            {showIntegrationDetails ? <div className="border-t border-line px-4 py-3">
              <p className="text-[11px] leading-relaxed text-muted">Pedido entregue → ficha técnica → consumo. Cada evento é processado uma única vez pelo ID.</p>
              <div className="mt-2 text-[10px] text-dim">Último evento: <span className="font-mono text-muted">{lastEvent?.orderId ?? 'sem eventos'}</span>{lastEvent ? ` · ${time(lastEvent.occurredAt)}` : ''}</div>
              <p className="mt-1 text-[10px] text-dim">{mode === 'demo' ? 'Ambiente demonstrativo · processamento local' : 'Integração de consumo com DACOT Pedidos ainda não habilitada'}</p>
              {mode === 'demo' ? <div className="mt-3 flex flex-wrap gap-2">
                {can('overview.view') ? <button type="button" className="btn btn-ghost btn-sm" onClick={actions.simulateOrderDelivered}><Zap size={12} />Simular entrega</button> : null}
                <button type="button" className="btn btn-quiet btn-sm" onClick={actions.replayLastEvent} title="Reprocessar o último evento para verificar idempotência"><RefreshCcw size={12} />Reprocessar</button>
              </div> : null}
            </div> : null}
          </Panel>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel title="Histórico recente" flush bodyClassName="">
          <details>
            <summary className="cursor-pointer px-4 py-3 text-[11px] text-muted hover:text-cream">Ver últimas movimentações</summary>
          <div className="scroll-x">
            <table className="table min-w-[620px]">
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Insumo</th>
                  <th>Movimento</th>
                  <th className="text-right">Quantidade</th>
                  <th>Origem</th>
                  <th className="text-right">Saldo</th>
                </tr>
              </thead>
              <tbody>
                {movements.map((movement) => {
                  const item = state.items.find((i) => i.id === movement.itemId);
                  const user = state.users.find((u) => u.id === movement.userId);
                  return (
                    <tr key={movement.id}>
                      <td className="whitespace-nowrap font-mono text-[11px] text-dim">
                        {date(movement.occurredAt)} {time(movement.occurredAt)}
                      </td>
                      <td>
                        <Link
                          to={`/estoque/${movement.itemId}`}
                          className="text-[12.5px] text-cream hover:text-copper"
                        >
                          {item?.name ?? '—'}
                        </Link>
                      </td>
                      <td className="text-[11.5px] text-muted">
                        {MOVEMENT_LABEL[movement.type]}
                      </td>
                      <td
                        className={`text-right num text-[12px] ${
                          movement.direction === 'in' ? 'text-ok' : 'text-cream'
                        }`}
                      >
                        {movement.direction === 'in' ? '+' : '−'}
                        {fmtQty(movement.qty, movement.unit)}
                      </td>
                      <td className="max-w-[180px] truncate text-[11px] text-dim">
                        {movement.origin} · {user?.name.split(' ')[0] ?? 'sistema'}
                      </td>
                      <td className="text-right num text-[11.5px] text-muted">
                        {fmtQty(movement.balanceAfter, movement.unit)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </details>
        </Panel>

        <Panel title="Resumo financeiro" flush bodyClassName="">
          <details>
            <summary className="cursor-pointer px-4 py-3 text-[11px] text-muted hover:text-cream">Ver custos, perdas e divergências</summary>
          <div className="divide-y divide-line">
            <div className="flex items-start gap-3 px-4 py-3.5">
              <TrendingUp size={15} className="mt-0.5 shrink-0 text-copper" />
              <div className="text-[11.5px] leading-relaxed text-muted">
                {risingCount == null ? 'Indicador de alta de custos indisponível.' : <>
                  <span className="text-cream">{risingCount} insumos</span> subiram de preço nos
                  últimos 120 dias. A maior alta percentual é{' '}
                  <span className="text-cream">{topRise?.item.name ?? '—'}</span>
                  {topRise ? ` (${(topRise.variation * 100).toFixed(1)}%)` : ''}.
                </>}
              </div>
            </div>
            <div className="flex items-start gap-3 px-4 py-3.5">
              <TrendingDown size={15} className="mt-0.5 shrink-0 text-danger" />
              <div className="text-[11.5px] leading-relaxed text-muted">
                <span className="text-cream">{lossesValue == null ? '—' : money(lossesValue)}</span> em perdas no mês,{' '}
                {lossReceiptComparison.status === 'percentage'
                  ? `perdas precificadas equivalem a ${lossReceiptComparison.percentage.toFixed(1)}% do valor de mercadorias recebidas no mês`
                  : lossReceiptComparison.status === 'no-receipts' ? 'sem entradas precificadas no mês'
                    : lossReceiptComparison.status === 'unpriced-receipts' ? 'há recebimentos sem custo cadastrado'
                      : lossReceiptComparison.status === 'unpriced-losses' ? 'há perdas sem custo cadastrado'
                        : lossReceiptComparison.status === 'no-losses' ? 'sem perdas precificadas'
                        : 'comparativo indisponível'}
                .
              </div>
            </div>
            <div className="flex items-start gap-3 px-4 py-3.5">
              <ClipboardList size={15} className="mt-0.5 shrink-0 text-muted" />
              <div className="text-[11.5px] leading-relaxed text-muted">
                {divergence == null ? 'Resumo de divergências indisponível.' : <>As contagens aprovadas neste mês geraram{' '}
                  <span className="text-cream">{money(divergence)}</span> de divergência entre esperado e contado.</>}
              </div>
            </div>
          </div>
          <div className="border-t border-line px-4 py-3">
            <Link
              to="/contagem?nova=1"
              className="flex items-center justify-between text-[11.5px] text-copper hover:text-copper-hi"
            >
              Iniciar nova contagem
              <ArrowRight size={13} />
            </Link>
          </div>
          </details>
        </Panel>
      </div>

      <p className="mt-4 text-[10px] text-dim">
        {mode === 'demo' ? 'Dados de demonstração' : 'Dados persistidos na API'} · {state.restaurant.name}
        {mode === 'demo' ? <> · atualizado em {date(NOW_ISO)} às {time(NOW_ISO)}</> : null}. Valores em reais: estoque usa custo atual; perdas e contagens usam o valor registrado na operação; pedidos mostram valor previsto.
      </p>
    </div>
  );
}
