import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, Plus, TrendingDown } from 'lucide-react';
import { useApp } from '../state/AppStore';
import {
  lossesMonthCents,
  lossesThisMonth,
  lossesWeekCents,
  topLossItem,
  topLossReason,
} from '../domain/selectors';
import { date, money, parseQty, qty as fmtQty, time } from '../domain/format';
import { LOSS_REASONS, type LossReason } from '../domain/types';
import { Drawer, EmptyState, Field, PageHeader, Panel } from '../components/ui';

export function LossesPage() {
  const { state, actions, can } = useApp();
  const [params, setParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  const [itemId, setItemId] = useState(params.get('item') ?? '');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState<LossReason>('Vencimento');
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState<'all' | LossReason>('all');

  useEffect(() => {
    const preselected = params.get('item');
    if (preselected) {
      setItemId(preselected);
      setOpen(true);
      params.delete('item');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const monthLosses = useMemo(() => {
    const list = [...lossesThisMonth(state)].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
    return filter === 'all' ? list : list.filter((loss) => loss.reason === filter);
  }, [state, filter]);
  const focusedLoss = state.losses.find((loss) => loss.id === params.get('focus'));
  const visibleLosses = focusedLoss ? [focusedLoss] : monthLosses;

  useEffect(() => {
    if (!focusedLoss) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(`loss-record-${focusedLoss.id}`)?.scrollIntoView({ block: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedLoss?.id]);

  const totals = {
    month: lossesMonthCents(state),
    week: lossesWeekCents(state),
    reason: topLossReason(state),
    item: topLossItem(state),
  };

  const selectedItem = state.items.find((i) => i.id === itemId);
  const estimated = selectedItem
    ? Math.round((parseQty(quantity) || 0) * selectedItem.costCents)
    : 0;

  const submit = () => {
    const ok = actions.registerLoss({
      itemId,
      qty: parseQty(quantity),
      reason,
      note,
    });
    if (ok) {
      setOpen(false);
      setQuantity('');
      setNote('');
      setReason('Vencimento');
    }
  };

  const reasonTotals = LOSS_REASONS.map((lossReason) => ({
    reason: lossReason,
    value: lossesThisMonth(state)
      .filter((loss) => loss.reason === lossReason)
      .reduce((sum, loss) => sum + loss.valueCents, 0),
  }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value);
  const maxReason = reasonTotals[0]?.value ?? 1;

  return (
    <div>
      <PageHeader
        eyebrow="07 / Perdas"
        title="Perdas"
        description="Onde o dinheiro está sendo perdido. Cada registro gera saída de estoque com motivo, valor e responsável."
        actions={
          can('losses.manage') ? (
            <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
              <Plus size={14} />
              Registrar perda
            </button>
          ) : null
        }
      />

      <section className="panel mb-5 grid grid-cols-2 gap-px overflow-hidden bg-line md:grid-cols-4">
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Perdas no mês</div>
          <div className="mt-2 num text-[21px] text-copper">{money(totals.month)}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">
            {lossesThisMonth(state).length} registros
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Últimos 7 dias</div>
          <div className="mt-2 num text-[21px] text-cream">{money(totals.week)}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">perdas registradas na semana</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Principal motivo</div>
          <div className="mt-2 text-[15px] text-cream">{totals.reason?.reason ?? '—'}</div>
          <div className="mt-1.5 num text-[10.5px] text-dim">
            {totals.reason ? money(totals.reason.valueCents) : 'sem registros'}
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Item com maior perda</div>
          <div className="mt-2 truncate text-[15px] text-cream">{totals.item?.item.name ?? '—'}</div>
          <div className="mt-1.5 num text-[10.5px] text-dim">
            {totals.item ? money(totals.item.valueCents) : 'sem registros'}
          </div>
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
              <span className="text-[11px] text-muted">
                Registro localizado{!monthLosses.some((loss) => loss.id === focusedLoss.id) ? ' · fora do mês atual' : ''}.
              </span>
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

          {visibleLosses.length === 0 ? (
            <EmptyState
              icon={<TrendingDown size={18} />}
              title={state.losses.length === 0 ? 'Nenhuma perda registrada' : 'Nenhum registro neste filtro'}
              description={
                state.losses.length === 0
                  ? 'Registre quebras, vencimentos e sobras para entender o impacto financeiro real da operação.'
                  : 'Altere o filtro de motivo para ver outros registros do mês.'
              }
              action={
                can('losses.manage') && state.losses.length === 0 ? (
                  <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
                    Registrar primeira perda
                  </button>
                ) : null
              }
            />
          ) : (
            <>
              <div className="scroll-x hidden md:block">
                <table className="table min-w-[780px]">
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Insumo</th>
                      <th className="text-right">Quantidade</th>
                      <th>Motivo</th>
                      <th className="text-right">Valor perdido</th>
                      <th>Responsável</th>
                      <th>Observação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleLosses.map((loss) => {
                      const item = state.items.find((i) => i.id === loss.itemId);
                      const user = state.users.find((u) => u.id === loss.userId);
                      return (
                        <tr key={loss.id} id={`loss-record-${loss.id}`} className={focusedLoss?.id === loss.id ? 'bg-copper/10' : undefined}>
                          <td className="whitespace-nowrap font-mono text-[10.5px] text-dim">
                            {date(loss.at)} · {time(loss.at)}
                          </td>
                          <td className="text-[12.5px] text-cream">{item?.name ?? '—'}</td>
                          <td className="text-right num text-[12px] text-cream">
                            {item ? fmtQty(loss.qty, item.unit) : loss.qty}
                          </td>
                          <td className="text-[11.5px] text-muted">{loss.reason}</td>
                          <td className="text-right num text-[12.5px] text-copper">
                            {money(loss.valueCents)}
                          </td>
                          <td className="text-[11px] text-muted">{user?.name ?? '—'}</td>
                          <td className="max-w-[220px] truncate text-[10.5px] text-dim">
                            {loss.note || '—'}
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
                          <div className="mt-0.5 text-[10.5px] text-dim">
                            {date(loss.at)} · {loss.reason} · {user?.name.split(' ')[0]}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="num text-[13px] text-copper">{money(loss.valueCents)}</div>
                          <div className="num text-[10.5px] text-dim">
                            {item ? fmtQty(loss.qty, item.unit) : loss.qty}
                          </div>
                        </div>
                      </div>
                      {loss.note ? (
                        <p className="mt-1.5 text-[10.5px] leading-relaxed text-dim">{loss.note}</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center justify-between border-t border-line px-4 py-3">
                <span className="text-[11px] text-dim">
                  {focusedLoss ? '1 registro localizado' : `${monthLosses.length} registros no filtro`}
                </span>
                <span className="num text-[13px] text-cream">
                  {money(visibleLosses.reduce((sum, loss) => sum + loss.valueCents, 0))}
                </span>
              </div>
            </>
          )}
        </Panel>

        <Panel title="Motivos no mês" subtitle="Impacto financeiro por causa." flush bodyClassName="">
          {reasonTotals.length === 0 ? (
            <div className="px-4 py-4 text-[11px] leading-relaxed text-dim">
              Sem perdas registradas neste mês.
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
            Perdas geram saída de estoque e entram na auditoria. O valor usa o custo atual do insumo.
          </div>
        </Panel>
      </div>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Perdas"
        title="Registrar perda"
        description="A perda reduz o estoque imediatamente e fica registrada com valor e responsável."
        footer={
          <>
            <span className="mr-auto text-[11px] text-dim">
              Impacto <span className="num text-copper">{money(estimated)}</span>
            </span>
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={submit}
              disabled={!itemId || !quantity}
            >
              Registrar perda
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Insumo" htmlFor="loss-item">
            <select
              id="loss-item"
              className="select"
              value={itemId}
              onChange={(event) => setItemId(event.target.value)}
            >
              <option value="">Selecionar insumo</option>
              {state.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {money(item.costCents)}/{item.unit}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Quantidade"
              htmlFor="loss-qty"
              hint={selectedItem ? `Em estoque: ${fmtQty(selectedItem.currentQty, selectedItem.unit)}` : undefined}
            >
              <div className="relative">
                <input
                  id="loss-qty"
                  className="input num pr-9"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  placeholder="0"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-dim">
                  {selectedItem?.unit ?? 'un'}
                </span>
              </div>
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
            <span className="num text-[14px] text-copper">{money(estimated)}</span>
          </div>
        </div>
      </Drawer>
    </div>
  );
}
