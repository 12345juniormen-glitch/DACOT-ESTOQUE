import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Check, ClipboardCheck, Info, Lock } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { countWithDraftValues } from '../domain/counts';
import { countDivergences, countFinancialCents, itemCostKnown } from '../domain/selectors';
import { dateTime, decimalRaw, money, parseStockQty, qty as fmtQty, roundCentsFromMilliUnits } from '../domain/format';
import type { CountSession } from '../domain/types';
import { BackLink, Dialog, EmptyState, PageHeader, Panel, ToneNote } from '../components/ui';
import { useEnsureIngredients } from '../hooks/useEnsureIngredients';
import { fetchApiCount } from '../lib/api';

function CountStatusTag({ count }: { count: CountSession }) {
  if (count.status === 'approved') {
    return <span className="status status-normal">Aprovada</span>;
  }
  return <span className="status status-attention">Em andamento</span>;
}

export function CountSessionPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state, actions, can, notify, mode, ready } = useApp();
  const count = state.counts.find((c) => c.id === id);
  const ingredientHydration = useEnsureIngredients(count?.lines.map((line) => line.itemId) ?? []);
  const [countLoading, setCountLoading] = useState(false);
  const [countError, setCountError] = useState<string | null>(null);
  const [countRetry, setCountRetry] = useState(0);
  const countRequestRef = useRef<string | null>(null);
  const dirtyCountLinesRef = useRef(new Map<string, number>());
  const cacheCountRef = useRef(actions.cacheCount);

  useEffect(() => { cacheCountRef.current = actions.cacheCount; }, [actions]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [writeWarning, setWriteWarning] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string>>(() => {
    if (!count) return {};
    return Object.fromEntries(
      count.lines.map((line) => [line.itemId, line.countedQty == null ? '' : decimalRaw(line.countedQty)]),
    );
  });

  useEffect(() => {
    if (!count) return;
    setTexts((previous) => {
      const next = { ...previous };
      count.lines.forEach((line) => {
        if (!dirtyCountLinesRef.current.has(line.itemId)) {
          next[line.itemId] = line.countedQty == null ? '' : decimalRaw(line.countedQty);
        }
      });
      return next;
    });
  }, [count?.id, count?.version, count?.lines]);

  useEffect(() => {
    if (mode !== 'production' || !ready || !id || count) {
      if (count) setCountError(null);
      return;
    }
    const requestKey = `${state.restaurant.id}:${id}:${countRetry}`;
    if (countRequestRef.current === requestKey) return;
    countRequestRef.current = requestKey;
    let current = true;
    setCountLoading(true);
    setCountError(null);
    void fetchApiCount(id).then((loaded) => {
      if (current) cacheCountRef.current(loaded);
    }).catch((error: unknown) => {
      if (current) setCountError(error instanceof Error ? error.message : 'Contagem não encontrada.');
    }).finally(() => {
      if (current) setCountLoading(false);
    });
    return () => { current = false; };
  }, [mode, ready, id, count, state.restaurant.id, countRetry]);

  const initializedCountRef = useRef<string | null>(null);
  useEffect(() => {
    if (!count || initializedCountRef.current === count.id) return;
    initializedCountRef.current = count.id;
    setTexts(Object.fromEntries(count.lines.map((line) => [line.itemId,
      line.countedQty == null ? '' : decimalRaw(line.countedQty)])));
  }, [count]);

  const totals = useMemo(() => {
    if (!count) return { checked: 0, divergences: 0, financial: 0, adjustments: 0 };
    const checked = count.lines.filter((line) => line.countedQty != null).length;
    return {
      checked,
      divergences: countDivergences(count),
      financial: countFinancialCents(state, count),
      adjustments: count.lines.filter(
        (line) => line.countedQty != null
          && Math.round((line.countedQty - line.expectedQty) * 1000) !== 0,
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
            title={countLoading || (mode === 'production' && !ready) ? 'Carregando contagem' : 'Contagem não encontrada'}
            description={countLoading || (mode === 'production' && !ready)
              ? 'Consultando a sessão persistida.'
              : countError ?? 'A contagem pode ter sido removida ou o endereço está incorreto.'}
            action={
              countError && mode === 'production'
                ? <button type="button" className="btn btn-ghost" onClick={() => setCountRetry((value) => value + 1)}>Tentar novamente</button>
                : <Link to="/contagem" className="btn btn-ghost">Voltar para contagens</Link>
            }
          />
        </Panel>
      </div>
    );
  }

  if (ingredientHydration.loading) {
    return <div><BackLink to="/contagem">Contagens</BackLink><Panel><div className="px-5 py-8 text-center text-[12px] text-dim" role="status">Carregando os insumos desta contagem…</div></Panel></div>;
  }
  if (ingredientHydration.error) {
    return <div><BackLink to="/contagem">Contagens</BackLink><Panel><EmptyState icon={<Info size={18} />}
      title="Não foi possível carregar os insumos" description={ingredientHydration.error}
      action={<button type="button" className="btn btn-ghost" onClick={ingredientHydration.retry}>Tentar novamente</button>} /></Panel></div>;
  }

  const approved = count.status === 'approved';
  const stockChangedSinceCount = !approved && count.lines.some((line) => {
    const current = state.items.find((item) => item.id === line.itemId)?.currentQty;
    return current != null && Math.round((current - line.expectedQty) * 1000) !== 0;
  });
  const hasFrozenValuation = approved && count.lines.some((line) => line.valuationComplete !== undefined);
  const valuationComplete = hasFrozenValuation
    ? count.lines.every((line) => line.valuationComplete === true)
    : count.lines.every((line) => {
      const item = state.items.find((entry) => entry.id === line.itemId);
      return item != null && itemCostKnown(item);
    });
  const expectedTotal = hasFrozenValuation
    ? count.lines.reduce((sum, line) => sum + (line.expectedValueCents ?? 0), 0)
    : count.lines.reduce((sum, line) => {
      const item = state.items.find((i) => i.id === line.itemId);
      return sum + (item ? line.expectedQty * item.costCents : 0);
    }, 0);
  const countedTotal = hasFrozenValuation
    ? count.lines.reduce((sum, line) => sum + (line.countedValueCents ?? 0), 0)
    : count.lines.reduce((sum, line) => {
      const item = state.items.find((i) => i.id === line.itemId);
      if (!item || line.countedQty == null) return sum;
      return sum + line.countedQty * item.costCents;
    }, 0);
  const creator = state.users.find((u) => u.id === count.createdBy);
  const approver = state.users.find((u) => u.id === count.approvedBy);
  const progress = Math.round((totals.checked / count.lines.length) * 100);
  const { count: draftCount, invalidItemIds: invalidDraftItems } = countWithDraftValues(count, texts);
  const approvalTotals = {
    checked: draftCount.lines.filter((line) => line.countedQty != null).length,
    divergences: countDivergences(draftCount),
    financial: countFinancialCents(state, draftCount),
    adjustments: draftCount.lines.filter((line) => line.countedQty != null
      && Math.round((line.countedQty - line.expectedQty) * 1000) !== 0).length,
  };

  const setLine = (itemId: string, raw: string) => {
    dirtyCountLinesRef.current.set(itemId, (dirtyCountLinesRef.current.get(itemId) ?? 0) + 1);
    setTexts((prev) => ({ ...prev, [itemId]: raw }));
  };

  const clearSavedDraft = (itemId: string, revision: number | undefined) => {
    if (revision != null && dirtyCountLinesRef.current.get(itemId) === revision) {
      dirtyCountLinesRef.current.delete(itemId);
    }
  };

  const saveLine = async (itemId: string, raw: string) => {
    const draftRevision = dirtyCountLinesRef.current.get(itemId);
    if (raw.trim() === '') {
      const saved = await actions.setCountQty(count.id, itemId, null);
      if (saved) clearSavedDraft(itemId, draftRevision);
      setWriteWarning(saved ? null : 'A quantidade não foi confirmada no servidor. O valor digitado foi mantido; confira antes de continuar.');
      return;
    }
    const value = parseStockQty(raw);
    if (value == null) {
      notify('Informe uma quantidade válida, maior ou igual a zero.', 'error');
      return;
    }
    const saved = await actions.setCountQty(count.id, itemId, value);
    if (saved) clearSavedDraft(itemId, draftRevision);
    setWriteWarning(saved ? null : 'A quantidade não foi confirmada no servidor. O valor digitado foi mantido; confira antes de continuar.');
  };

  const fillExpected = async () => {
    count.lines.forEach((line) => {
      if (line.countedQty == null) {
        dirtyCountLinesRef.current.set(line.itemId,
          (dirtyCountLinesRef.current.get(line.itemId) ?? 0) + 1);
        setTexts((prev) => ({ ...prev, [line.itemId]: decimalRaw(line.expectedQty) }));
      }
    });
    let saved = true;
    for (const line of count.lines) {
      if (line.countedQty == null) {
        const draftRevision = dirtyCountLinesRef.current.get(line.itemId);
        const lineSaved = await actions.setCountQty(count.id, line.itemId, line.expectedQty);
        saved = lineSaved && saved;
        if (lineSaved) clearSavedDraft(line.itemId, draftRevision);
        if (!lineSaved) setWriteWarning('Não foi possível salvar todos os valores. Confira os itens antes de aprovar.');
      }
    }
    if (saved) notify('Itens sem contagem foram preenchidos com o esperado.');
  };

  const approve = async () => {
    if (stockChangedSinceCount) {
      setWriteWarning('O saldo mudou depois da abertura desta contagem. Ela não pode ser aprovada; inicie uma nova contagem para os saldos atuais.');
      setConfirmOpen(false);
      return;
    }
    if (invalidDraftItems.length) {
      notify('Corrija todas as quantidades inválidas antes de aprovar.', 'error');
      return;
    }
    if (approvalTotals.checked < count.lines.length) {
      notify('Preencha todos os itens antes de aprovar a contagem.', 'error');
      return;
    }
    for (const line of count.lines) {
      const raw = texts[line.itemId] ?? (line.countedQty == null ? '' : decimalRaw(line.countedQty));
      const value = raw.trim() === '' ? null : parseStockQty(raw);
      if (raw.trim() !== '' && value == null) {
        notify(`Informe uma quantidade válida para ${state.items.find((item) => item.id === line.itemId)?.name ?? 'o insumo'}.`, 'error');
        return;
      }
      if (value !== line.countedQty) {
        const draftRevision = dirtyCountLinesRef.current.get(line.itemId);
        const saved = await actions.setCountQty(count.id, line.itemId, value);
        if (!saved) {
          setWriteWarning('Não foi possível salvar todos os valores. Os campos digitados foram mantidos; confira o estado atualizado antes de continuar.');
          setConfirmOpen(false);
          return;
        }
        clearSavedDraft(line.itemId, draftRevision);
      } else {
        clearSavedDraft(line.itemId, dirtyCountLinesRef.current.get(line.itemId));
      }
    }
    const ok = await actions.approveCount(count.id);
    if (ok) navigate('/contagem');
    else {
      setWriteWarning('A contagem não foi aprovada. Os valores digitados foram mantidos; revise o saldo e a sessão antes de tentar novamente.');
      setConfirmOpen(false);
    }
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
            <button type="button" className="btn btn-primary" disabled={stockChangedSinceCount} onClick={() => setConfirmOpen(true)}>
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

      {writeWarning || stockChangedSinceCount ? <ToneNote tone="warn">
        {stockChangedSinceCount
          ? `O estoque de um ou mais itens mudou depois que ${count.code} foi aberta. A aprovação está bloqueada; confira os saldos e inicie uma nova contagem.`
          : writeWarning}
        {' '}Os valores digitados nesta tela continuam visíveis.
      </ToneNote> : null}
      {!approved && mode === 'production' && stockChangedSinceCount ? <div className="mt-3">
        <Link to="/contagem" className="btn btn-ghost">Voltar e iniciar uma nova contagem</Link>
      </div> : null}

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
          <div className={`mt-1.5 num text-[18px] ${totals.financial != null && totals.financial < 0 ? 'text-danger' : 'text-cream'}`}>
            {totals.financial == null ? '—' : money(totals.financial)}
          </div>
        </div>
        <div className="bg-panel px-4 py-3.5">
          <div className="eyebrow">Valor contado</div>
          <div className="mt-1.5 num text-[18px] text-cream">{valuationComplete ? money(countedTotal) : '—'}</div>
          <div className="mt-1 text-[10px] text-dim">esperado {valuationComplete ? money(expectedTotal) : 'custo não cadastrado'}</div>
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
            : 'Informe a quantidade encontrada no físico. O impacto só é calculado para insumos com custo cadastrado.'
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
                const rawCount = texts[line.itemId] ?? '';
                const invalidCount = rawCount.trim().length > 0 && parseStockQty(rawCount) == null;
                const diff =
                  line.countedQty == null ? null : line.countedQty - line.expectedQty;
                const deltaMilli = diff == null ? null : Math.round(diff * 1000);
                const impact = approved && line.financialImpactComplete !== undefined
                  ? line.financialImpactComplete ? line.financialImpactCents ?? 0 : null
                  : diff == null ? null
                    : deltaMilli === 0 ? 0
                      : itemCostKnown(item) ? roundCentsFromMilliUnits(diff, item.costCents) : null;
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
                            className={`input num h-8 pr-8 text-right text-[12.5px] ${invalidCount ? 'border-danger' : ''}`}
                            inputMode="decimal"
                            value={texts[line.itemId] ?? ''}
                            onChange={(event) => setLine(line.itemId, event.target.value)}
                            onBlur={(event) => { void saveLine(line.itemId, event.target.value); }}
                            placeholder="0"
                            aria-label={`Quantidade contada de ${item.name}`}
                            aria-invalid={invalidCount}
                          />
                          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-dim">
                            {item.unit}
                          </span>
                        </div>
                      )}
                      {!approved && invalidCount ? <div className="mt-1 text-right text-[10px] text-danger">Use até 3 casas decimais.</div> : null}
                    </td>
                    <td
                      className={`text-right num text-[12px] ${
                        deltaMilli == null ? 'text-dim' : deltaMilli < 0 ? 'text-danger' : deltaMilli > 0 ? 'text-copper' : 'text-muted'
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
                          onClick={() => {
                            const expected = decimalRaw(line.expectedQty);
                            setLine(line.itemId, expected);
                            void saveLine(line.itemId, expected);
                          }}
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
            const rawCount = texts[line.itemId] ?? '';
            const invalidCount = rawCount.trim().length > 0 && parseStockQty(rawCount) == null;
            const diff = line.countedQty == null ? null : line.countedQty - line.expectedQty;
            const deltaMilli = diff == null ? null : Math.round(diff * 1000);
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
                  {diff != null && deltaMilli !== 0 ? (
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
                  <>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="relative flex-1">
                        <input
                          className={`input num h-11 pr-9 text-[16px] ${invalidCount ? 'border-danger' : ''}`}
                          inputMode="decimal"
                          value={texts[line.itemId] ?? ''}
                          onChange={(event) => setLine(line.itemId, event.target.value)}
                          onBlur={(event) => { void saveLine(line.itemId, event.target.value); }}
                          placeholder="Quantidade encontrada"
                          aria-label={`Quantidade contada de ${item.name}`}
                          aria-invalid={invalidCount}
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[11px] text-dim">
                          {item.unit}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const expected = decimalRaw(line.expectedQty);
                          setLine(line.itemId, expected);
                          void saveLine(line.itemId, expected);
                        }}
                        className="btn btn-ghost btn-touch shrink-0 px-2.5"
                        title="Usar o esperado"
                      >
                        =
                      </button>
                    </div>
                    {invalidCount ? <p className="mt-1 text-[10px] text-danger">Use até 3 casas decimais.</p> : null}
                  </>
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
              impacto <span className={`num ${totals.financial != null && totals.financial < 0 ? 'text-danger' : 'text-muted'}`}>{totals.financial == null ? '—' : money(totals.financial)}</span>
            </span>
          </div>
          {can('count.approve') ? (
            <button
              type="button"
              className="btn btn-primary btn-touch w-full sm:w-auto"
              disabled={stockChangedSinceCount}
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
            <button type="button" className="btn btn-primary"
              disabled={stockChangedSinceCount || invalidDraftItems.length > 0 || approvalTotals.checked < count.lines.length}
              onClick={approve}>
              Aprovar contagem
            </button>
          </>
        }
      >
        <p>
          Serão gerados <strong className="font-medium text-cream">{approvalTotals.adjustments} ajustes</strong>{' '}
          de estoque, com impacto financeiro de{' '}
          <strong className="font-medium text-cream">{approvalTotals.financial == null ? 'não calculável — há item sem custo cadastrado' : money(approvalTotals.financial)}</strong>.
        </p>
        <p className="mt-2">
          Cada ajuste mantém o saldo anterior no histórico e registra seu usuário, data e motivo.
          Esta ação não pode ser desfeita.
        </p>
        {approvalTotals.checked < count.lines.length ? (
          <p className="mt-3 border-l border-copper px-3 py-2 text-[11.5px] text-copper">
            Ainda há {count.lines.length - approvalTotals.checked} itens sem contagem. Preencha todos para
            aprovar.
          </p>
        ) : null}
        {invalidDraftItems.length ? <p className="mt-3 border-l border-danger px-3 py-2 text-[11.5px] text-danger">
          Há {invalidDraftItems.length} quantidade(s) inválida(s). Corrija antes de aprovar.
        </p> : null}
      </Dialog>
    </div>
  );
}
