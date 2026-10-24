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
  divergenceCents,
  itemStatus,
  lossesThisMonth,
  lossesMonthCents,
  purchasesMonthCents,
  purchasesThisMonth,
  recommendedPurchases,
  recentMovements,
  risingCostItems,
  stockValueCents,
} from '../domain/selectors';
import { MOVEMENT_LABEL } from '../domain/types';
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
    <div className="bg-panel px-4 py-4">
      <div className="text-[9.5px] font-medium uppercase tracking-[0.13em] text-dim">{label}</div>
      <div className={`mt-2.5 num text-[21px] leading-none ${accent ? 'text-copper' : 'text-cream'}`}>
        {value}
      </div>
      <div className="mt-2 text-[10.5px] leading-snug text-muted">{sub}</div>
    </div>
  );
}

export function OverviewPage() {
  const { state, actions, can } = useApp();
  const user = useCurrentUser();

  const stockValue = stockValueCents(state);
  const purchases = purchasesThisMonth(state);
  const purchasesValue = purchasesMonthCents(state);
  const losses = lossesThisMonth(state);
  const lossesValue = lossesMonthCents(state);
  const low = belowMinItems(state);
  const critical = low.filter((item) => ['critical', 'empty'].includes(itemStatus(item)));
  const divergence = divergenceCents(state);
  const rising = risingCostItems(state);
  const alerts = attentionItems(state);
  const recommendations = recommendedPurchases(state);
  const movements = recentMovements(state, 7);
  const lastEvent = state.events[0];
  const eventsToday = state.events.filter(
    (event) => new Date(event.occurredAt).toDateString() === new Date(NOW_ISO).toDateString(),
  ).length;

  return (
    <div>
      <PageHeader
        eyebrow="01 / Visão Geral"
        title="Visão geral"
        description={`O que exige decisão no ${state.restaurant.name} hoje, ${date(NOW_ISO)}. Valores calculados a partir do estoque e das movimentações registradas.`}
        meta={
          <span className="text-[11px] text-dim">
            Operador: <span className="text-muted">{user.name}</span> · {state.items.length} insumos
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

      <section className="panel mb-5 grid grid-cols-2 gap-px overflow-hidden bg-line md:grid-cols-3 xl:grid-cols-6">
        <MetricCell
          label="Valor em estoque"
          value={money(stockValue)}
          sub={`${state.items.length} insumos · custo atual`}
        />
        <MetricCell
          label="Compras no mês"
          value={money(purchasesValue)}
          sub={`${purchases.length} pedidos não cancelados`}
        />
        <MetricCell
          label="Perdas no mês"
          value={money(lossesValue)}
          sub={`${losses.length} registros · ${money(lossesValue / Math.max(losses.length, 1))} em média`}
        />
        <MetricCell
          label="Abaixo do mínimo"
          value={`${low.length} itens`}
          sub={`${critical.length} em nível crítico ou zerado`}
          accent
        />
        <MetricCell
          label="Divergências"
          value={money(divergence)}
          sub="diferença financeira em contagens aprovadas"
        />
        <MetricCell
          label="Custos em alta"
          value={`${rising.length} itens`}
          sub={rising[0] ? `${rising[0].item.name} +${(rising[0].variation * 100).toFixed(1)}%` : 'sem aumentos relevantes'}
          accent={rising.length > 0}
        />
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel
          title="O que precisa da sua atenção"
          subtitle="Priorizado por impacto financeiro e risco de ruptura."
          bodyClassName=""
          flush
          actions={
            <span className="font-mono text-[10px] text-dim">
              {alerts.length} {alerts.length === 1 ? 'sinal' : 'sinais'}
            </span>
          }
        >
          {alerts.length === 0 ? (
            <EmptyState
              icon={<Boxes size={18} />}
              title="Nenhum ponto crítico agora"
              description="Estoque, custos e contagens estão dentro do esperado. Registre movimentações para manter o painel atualizado."
            />
          ) : (
            <div>
              {alerts.slice(0, 6).map((alert) => (
                <Link
                  key={alert.id}
                  to={alert.href}
                  className="group flex items-start gap-3 border-b border-line/70 px-4 py-3.5 transition-colors hover:bg-raised/50 sm:px-5"
                >
                  <span
                    className={`mt-1 h-8 w-[2px] shrink-0 ${
                      alert.severity === 'high' ? 'bg-copper' : 'bg-line-strong'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-[9.5px] font-medium uppercase tracking-[0.12em] text-copper">
                        {alert.tag}
                      </span>
                      <span className="text-[9px] text-dim">·</span>
                      <span className="text-[10px] uppercase tracking-[0.1em] text-dim">
                        {alert.severity === 'high' ? 'Prioridade alta' : 'Acompanhar'}
                      </span>
                    </div>
                    <div className="mt-1.5 text-[13.5px] font-medium leading-snug text-cream">
                      {alert.title}
                    </div>
                    <p className="mt-1 max-w-2xl text-[11.5px] leading-relaxed text-muted">
                      {alert.detail}
                    </p>
                  </div>
                  <div className="hidden shrink-0 text-right sm:block">
                    {alert.valueCents != null ? (
                      <>
                        <div className="num text-[13px] text-cream">{money(alert.valueCents)}</div>
                        <div className="mt-0.5 text-[9.5px] uppercase tracking-[0.08em] text-dim">
                          {alert.valueLabel}
                        </div>
                      </>
                    ) : null}
                  </div>
                  <ArrowRight
                    size={13}
                    className="mt-1 shrink-0 text-dim transition-transform group-hover:translate-x-0.5 group-hover:text-copper"
                  />
                </Link>
              ))}
            </div>
          )}
        </Panel>

        <div className="flex flex-col gap-5">
          <Panel
            title="Compras recomendadas"
            subtitle="Consumo recente, prazo e estoque de segurança."
            flush
            bodyClassName=""
            actions={
              <Link to="/estoque" className="text-[11px] text-dim hover:text-cream">
                Estoque
              </Link>
            }
          >
            {recommendations.length === 0 ? (
              <EmptyState
                icon={<ShoppingCart size={18} />}
                title="Nenhuma compra necessária"
                description="O estoque cobre o consumo previsto. Novas recomendações aparecem conforme o consumo avança."
              />
            ) : (
              <div>
                {recommendations.slice(0, 5).map((rec) => (
                  <Link
                    key={rec.item.id}
                    to={`/estoque/${rec.item.id}`}
                    className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-3 transition-colors last:border-b-0 hover:bg-raised/50"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[12.5px] text-cream">{rec.item.name}</div>
                      <div className="mt-0.5 text-[10.5px] text-dim">
                        {fmtQty(rec.avgDaily)} {rec.item.unit}/dia · acaba em{' '}
                        {Math.max(1, Math.round(rec.daysRemaining))} dias
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="num text-[12.5px] text-copper">
                        {fmtQty(rec.recommendedQty, rec.item.unit)}
                      </div>
                      <div className="mt-0.5 text-[10px] text-dim">{money(rec.estimatedCostCents)}</div>
                    </div>
                  </Link>
                ))}
                <div className="border-t border-line px-4 py-3 text-[10.5px] leading-relaxed text-dim">
                  Cálculo: consumo médio diário × dias de cobertura + estoque de segurança − estoque
                  atual. Sem previsão estatística.
                </div>
              </div>
            )}
          </Panel>

          <Panel
            title="DACOT Pedidos"
            subtitle="Integração ativa por eventos"
            flush
            bodyClassName=""
            actions={<span className="status status-normal text-[11px]">Conectado</span>}
          >
            <div className="grid grid-cols-2 gap-px border-b border-line bg-line">
              <div className="bg-panel px-4 py-3">
                <div className="text-[9.5px] uppercase tracking-[0.1em] text-dim">Eventos hoje</div>
                <div className="mt-1.5 num text-[16px] text-cream">{eventsToday}</div>
                <div className="text-[10px] text-dim">ORDER_DELIVERED</div>
              </div>
              <div className="bg-panel px-4 py-3">
                <div className="text-[9.5px] uppercase tracking-[0.1em] text-dim">Último evento</div>
                <div className="mt-1.5 font-mono text-[11px] text-cream">{lastEvent?.orderId ?? '—'}</div>
                <div className="text-[10px] text-dim">
                  {lastEvent ? time(lastEvent.occurredAt) : 'sem eventos'}
                </div>
              </div>
            </div>
            <div className="px-4 py-3.5">
              <p className="text-[11px] leading-relaxed text-muted">
                Pedido entregue → ficha técnica → consumo. Cada evento é processado uma única vez
                pelo ID.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {can('overview.view') ? (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={actions.simulateOrderDelivered}
                  >
                    <Zap size={12} />
                    Simular entrega
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  onClick={actions.replayLastEvent}
                  title="Reprocessar o último evento para verificar idempotência"
                >
                  <RefreshCcw size={12} />
                  Reprocessar
                </button>
              </div>
              <p className="mt-2 text-[9.5px] leading-relaxed text-dim">
                Ambiente de demonstração. O reprocessamento não gera baixa duplicada.
              </p>
            </div>
          </Panel>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Panel
          title="Últimas movimentações"
          subtitle="Entradas, saídas, ajustes e perdas registradas."
          flush
          bodyClassName=""
          actions={
            <Link to="/estoque" className="text-[11px] text-dim hover:text-cream">
              Ver estoque
            </Link>
          }
        >
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
        </Panel>

        <Panel title="Onde olhar primeiro" subtitle="Leitura rápida do mês" flush bodyClassName="">
          <div className="divide-y divide-line">
            <div className="flex items-start gap-3 px-4 py-3.5">
              <TrendingUp size={15} className="mt-0.5 shrink-0 text-copper" />
              <div className="text-[11.5px] leading-relaxed text-muted">
                <span className="text-cream">{rising.length} insumos</span> subiram de preço nos
                últimos 120 dias. O maior impacto é{' '}
                <span className="text-cream">{rising[0]?.item.name ?? '—'}</span>
                {rising[0] ? ` (${(rising[0].variation * 100).toFixed(1)}%)` : ''}.
              </div>
            </div>
            <div className="flex items-start gap-3 px-4 py-3.5">
              <TrendingDown size={15} className="mt-0.5 shrink-0 text-danger" />
              <div className="text-[11.5px] leading-relaxed text-muted">
                <span className="text-cream">{money(lossesValue)}</span> em perdas no mês,{' '}
                {lossesValue > 0
                  ? `${((lossesValue / Math.max(purchasesValue, 1)) * 100).toFixed(1)}% do valor comprado`
                  : 'sem registros'}
                .
              </div>
            </div>
            <div className="flex items-start gap-3 px-4 py-3.5">
              <ClipboardList size={15} className="mt-0.5 shrink-0 text-muted" />
              <div className="text-[11.5px] leading-relaxed text-muted">
                A última contagem aprovada gerou{' '}
                <span className="text-cream">{money(divergence)}</span> de divergência entre
                esperado e contado.
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
        </Panel>
      </div>

      <p className="mt-4 text-[10px] text-dim">
        Dados de demonstração · {state.restaurant.name} · atualizado em {date(NOW_ISO)} às{' '}
        {time(NOW_ISO)}. Todos os valores em reais, calculados sobre custo atual.
      </p>
    </div>
  );
}
