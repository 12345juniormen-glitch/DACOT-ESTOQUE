import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, ClipboardCheck, Info, Lock } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { countDivergences, countFinancialCents } from '../domain/selectors';
import { dateTime, decimalRaw, money, parseQty, qty as fmtQty } from '../domain/format';
import type { CountSession } from '../domain/types';
import { BackLink, Dialog, EmptyState, PageHeader, Panel, ToneNote } from '../components/ui';

function CountStatusTag({ count }: { count: CountSession }) {
  if (count.status === 'approved') {
    return <span className="status status-normal">Aprovada</span>;
  }
  return <span className="status status-attention">Em andamento</span>;
}

export function CountSessionPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state, actions, can, notify } = useApp();
  const count = state.counts.find((c) => c.id === id);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [texts, setTexts] = useState<Record<string, string>>(() => {
    if (!count) return {};
    return Object.fromEntries(
      count.lines.map((line) => [line.itemId, line.countedQty == null ? '' : decimalRaw(line.countedQty)]),
    );
  });

  const totals = useMemo(() => {
    if (!count) return { checked: 0, divergences: 0, financial: 0, adjustments: 0 };
    const checked = count.lines.filter((line) => line.countedQty != null).length;
    return {
      checked,
      divergences: countDivergences(count),
      financial: countFinancialCents(state, count),
      adjustments: count.lines.filter(
        (line) => line.countedQty != null && Math.abs(line.countedQty - line.expectedQty) > 0.001,
      ).length,
    };
  }, [count, state]);

  if (!count) {
    return (
      <div>
        <BackLink to="/contagem">Contagem</BackLink>
        <Panel>
          <EmptyState
            icon={<Info size={18} />}
            title="Contagem não encontrada"
            description="A contagem pode ter sido removida ou o endereço está incorreto."
            action={
              <Link to="/contagem" className="btn btn-ghost">
                Voltar para contagens
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }

  const approved = count.status === 'approved';
  const expectedTotal = count.lines.reduce((sum, line) => {
    const item = state.items.find((i) => i.id === line.itemId);
    return sum + (item ? line.expectedQty * item.costCents : 0);
  }, 0);
  const countedTotal = count.lines.reduce((sum, line) => {
    const item = state.items.find((i) => i.id === line.itemId);
    if (!item || line.countedQty == null) return sum;
    return sum + line.countedQty * item.costCents;
  }, 0);
  const creator = state.users.find((u) => u.id === count.createdBy);
  const approver = state.users.find((u) => u.id === count.approvedBy);
  const progress = Math.round((totals.checked / count.lines.length) * 100);

  const setLine = (itemId: string, raw: string) => {
    setTexts((prev) => ({ ...prev, [itemId]: raw }));
    if (raw.trim() === '') {
      actions.setCountQty(count.id, itemId, null);
      return;
    }
    const value = Math.max(0, parseQty(raw));
    actions.setCountQty(count.id, itemId, value);
  };

  const fillExpected = () => {
    count.lines.forEach((line) => {
      if (line.countedQty == null) {
        actions.setCountQty(count.id, line.itemId, line.expectedQty);
        setTexts((prev) => ({ ...prev, [line.itemId]: decimalRaw(line.expectedQty) }));
      }
    });
    notify('Itens sem contagem foram preenchidos com o esperado.');
  };

  const approve = () => {
    const ok = actions.approveCount(count.id);
    if (ok) navigate('/contagem');
  };

  return (
    <div className="pb-2">
      <BackLink to="/contagem">Contagens</BackLink>

      <PageHeader
        eyebrow={`Contagem / ${count.code}`}
        title={approved ? `Contagem ${count.code}` : 'Contagem em andamento'}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <CountStatusTag count={count} />
            <span className="text-dim">·</span>
            <span>{count.lines.length} itens</span>
            <span className="text-dim">·</span>
            <span>aberta em {dateTime(count.startedAt)}</span>
            <span className="text-dim">·</span>
            <span>{creator?.name ?? '—'}</span>
          </span>
        }
        actions={
          approved ? (
            <Link to="/contagem" className="btn btn-ghost">
              Voltar ao histórico
            </Link>
          ) : can('count.approve') ? (
            <button type="button" className="btn btn-primary" onClick={() => setConfirmOpen(true)}>
              <Check size={14} />
              Finalizar contagem
            </button>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] text-dim">
              <Lock size={12} /> Aprovação restrita ao gerente
            </span>
          )
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-px border border-line bg-line md:grid-cols-4">
        <div className="bg-panel px-4 py-3.5">
          <div className="eyebrow">Itens conferidos</div>
          <div className="mt-1.5 num text-[18px] text-cream">
            {totals.checked}
            <span className="text-[11px] text-dim"> / {count.lines.length}</span>
          </div>
        </div>
        <div className="bg-panel px-4 py-3.5">
          <div className="eyebrow">Divergências</div>
          <div className={`mt-1.5 num text-[18px] ${totals.divergences ? 'text-copper' : 'text-cream'}`}>
            {totals.divergences}
          </div>
        </div>
        <div className="bg-panel px-4 py-3.5">
          <div className="eyebrow">Impacto financeiro</div>
          <div className={`mt-1.5 num text-[18px] ${totals.financial < 0 ? 'text-danger' : 'text-cream'}`}>
            {money(totals.financial)}
          </div>
        </div>
        <div className="bg-panel px-4 py-3.5">
          <div className="eyebrow">Valor contado</div>
          <div className="mt-1.5 num text-[18px] text-cream">{money(countedTotal)}</div>
          <div className="mt-1 text-[10px] text-dim">esperado {money(expectedTotal)}</div>
        </div>
      </div>

      {!approved ? (
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between text-[10.5px] text-dim">
            <span>Progresso da conferência</span>
            <span className="num">{progress}%</span>
          </div>
          <div className="h-[3px] w-full bg-line">
            <div className="h-full bg-copper transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      ) : (
        <ToneNote>
          Contagem aprovada em {dateTime(count.approvedAt ?? count.startedAt)} por{' '}
          {approver?.name ?? '—'}. Os ajustes foram registrados nas movimentações de cada insumo.
        </ToneNote>
      )}

      <Panel
        className={approved ? 'mt-4' : ''}
        title="Conferência por item"
        subtitle={
          approved
            ? 'Registro final da contagem aprovada.'
            : 'Informe a quantidade encontrada no físico. O impacto usa o custo atual do insumo.'
        }
        flush
        bodyClassName=""
        actions={
          !approved ? (
            <button type="button" className="btn btn-quiet btn-sm" onClick={fillExpected}>
              Preencher restantes
            </button>
          ) : null
        }
      >
        <div className="scroll-x hidden md:block">
          <table className="table min-w-[720px]">
            <thead>
              <tr>
                <th>Insumo</th>
                <th className="text-right">Esperado</th>
                <th className="w-[180px] text-right">Contado</th>
                <th className="text-right">Diferença</th>
                <th className="text-right">Impacto</th>
                <th className="w-[110px]" />
              </tr>
            </thead>
            <tbody>
              {count.lines.map((line) => {
                const item = state.items.find((i) => i.id === line.itemId);
                if (!item) return null;
                const diff =
                  line.countedQty == null ? null : line.countedQty - line.expectedQty;
                const impact = diff == null ? null : Math.round(diff * item.costCents);
                return (
                  <tr key={line.itemId}>
                    <td>
                      <Link
                        to={`/estoque/${item.id}`}
                        className="text-[12.5px] text-cream hover:text-copper"
                      >
                        {item.name}
                      </Link>
                      <div className="mt-0.5 text-[10px] uppercase tracking-[0.06em] text-dim">
                        {item.category} · {item.unit}
                      </div>
                    </td>
                    <td className="text-right num text-[12px] text-muted">
                      {fmtQty(line.expectedQty, item.unit)}
                    </td>
                    <td className="text-right">
                      {approved ? (
                        <span className="num text-[12.5px] text-cream">
                          {line.countedQty == null ? '—' : fmtQty(line.countedQty, item.unit)}
                        </span>
                      ) : (
                        <div className="relative ml-auto w-[150px]">
                          <input
                            className="input num h-8 pr-8 text-right text-[12.5px]"
                            inputMode="decimal"
                            value={texts[line.itemId] ?? ''}
                            onChange={(event) => setLine(line.itemId, event.target.value)}
                            placeholder="0"
                            aria-label={`Quantidade contada de ${item.name}`}
                          />
                          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-dim">
                            {item.unit}
                          </span>
                        </div>
                      )}
                    </td>
                    <td
                      className={`text-right num text-[12px] ${
                        diff == null ? 'text-dim' : diff < -0.001 ? 'text-danger' : diff > 0.001 ? 'text-copper' : 'text-muted'
                      }`}
                    >
                      {diff == null
                        ? '—'
                        : `${diff > 0 ? '+' : diff < 0 ? '−' : ''}${fmtQty(Math.abs(diff), item.unit)}`}
                    </td>
                    <td className="text-right num text-[12px] text-muted">
                      {impact == null ? '—' : money(impact)}
                    </td>
                    <td className="text-right">
                      {!approved ? (
                        <button
                          type="button"
                          className="text-[10.5px] text-dim hover:text-copper"
                          onClick={() => setLine(line.itemId, decimalRaw(line.expectedQty))}
                        >
                          Igual ao esperado
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="divide-y divide-line md:hidden">
          {count.lines.map((line) => {
            const item = state.items.find((i) => i.id === line.itemId);
            if (!item) return null;
            const diff = line.countedQty == null ? null : line.countedQty - line.expectedQty;
            return (
              <div key={line.itemId} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <Link to={`/estoque/${item.id}`} className="text-[13px] text-cream">
                      {item.name}
                    </Link>
                    <div className="mt-0.5 text-[10px] uppercase tracking-[0.06em] text-dim">
                      esperado {fmtQty(line.expectedQty, item.unit)}
                    </div>
                  </div>
                  {diff != null && Math.abs(diff) > 0.001 ? (
                    <span className={`num text-[11px] ${diff < 0 ? 'text-danger' : 'text-copper'}`}>
                      {diff > 0 ? '+' : '−'}
                      {fmtQty(Math.abs(diff), item.unit)}
                    </span>
                  ) : diff != null ? (
                    <span className="text-[10px] text-ok">confere</span>
                  ) : null}
                </div>
                {approved ? (
                  <div className="mt-2 num text-[16px] text-cream">
                    {line.countedQty == null ? '—' : fmtQty(line.countedQty, item.unit)}
                  </div>
                ) : (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="relative flex-1">
                      <input
                        className="input num h-11 pr-9 text-[16px]"
                        inputMode="decimal"
                        value={texts[line.itemId] ?? ''}
                        onChange={(event) => setLine(line.itemId, event.target.value)}
                        placeholder="Quantidade encontrada"
                        aria-label={`Quantidade contada de ${item.name}`}
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[11px] text-dim">
                        {item.unit}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setLine(line.itemId, decimalRaw(line.expectedQty))}
                      className="btn btn-ghost btn-touch shrink-0 px-2.5"
                      title="Usar o esperado"
                    >
                      =
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Panel>

      {!approved ? (
        <div className="sticky bottom-0 z-20 mt-4 flex flex-wrap items-center justify-between gap-3 border border-line bg-panel px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[10.5px] text-dim">
            <span>
              conferidos <span className="num text-muted">{totals.checked}/{count.lines.length}</span>
            </span>
            <span>
              divergências <span className="num text-muted">{totals.divergences}</span>
            </span>
            <span>
              impacto <span className={`num ${totals.financial < 0 ? 'text-danger' : 'text-muted'}`}>{money(totals.financial)}</span>
            </span>
          </div>
          {can('count.approve') ? (
            <button
              type="button"
              className="btn btn-primary btn-touch w-full sm:w-auto"
              onClick={() => setConfirmOpen(true)}
            >
              <ClipboardCheck size={14} />
              Finalizar contagem
            </button>
          ) : (
            <span className="text-[11px] text-dim">
              Contagem salva · aguardando aprovação de um gerente
            </span>
          )}
        </div>
      ) : null}

      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Finalizar e aprovar contagem"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmOpen(false)}>
              Continuar contando
            </button>
            <button type="button" className="btn btn-primary" onClick={approve}>
              Aprovar contagem
            </button>
          </>
        }
      >
        <p>
          Serão gerados <strong className="font-medium text-cream">{totals.adjustments} ajustes</strong>{' '}
          de estoque, com impacto financeiro de{' '}
          <strong className="font-medium text-cream">{money(totals.financial)}</strong>.
        </p>
        <p className="mt-2">
          Cada ajuste mantém o saldo anterior no histórico e registra seu usuário, data e motivo.
          Esta ação não pode ser desfeita.
        </p>
        {totals.checked < count.lines.length ? (
          <p className="mt-3 border-l border-copper px-3 py-2 text-[11.5px] text-copper">
            Ainda há {count.lines.length - totals.checked} itens sem contagem. Preencha todos para
            aprovar.
          </p>
        ) : null}
      </Dialog>
    </div>
  );
}
