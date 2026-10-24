import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ClipboardCheck, ClipboardList, Plus, Search } from 'lucide-react';
import { useApp } from '../state/AppStore';
import {
  belowMinItems,
  countDivergences,
  countFinancialCents,
} from '../domain/selectors';
import { dateTime, money, qty as fmtQty } from '../domain/format';
import type { CountStatus } from '../domain/types';
import { Drawer, EmptyState, Field, PageHeader, Panel } from '../components/ui';

const COUNT_STATUS: Record<CountStatus, { label: string; className: string }> = {
  open: { label: 'Em andamento', className: 'text-copper' },
  review: { label: 'Em revisão', className: 'text-warn' },
  approved: { label: 'Aprovada', className: 'text-ok' },
};

export function CountsPage() {
  const { state, actions, can } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [drawerOpen, setDrawerOpen] = useState(params.get('nova') === '1');
  const [scope, setScope] = useState<'all' | 'low' | 'category'>('all');
  const [category, setCategory] = useState('Carnes');
  const [search, setSearch] = useState('');
  const [deselected, setDeselected] = useState<Set<string>>(new Set());

  const counts = [...state.counts].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );
  const openCounts = counts.filter((count) => count.status === 'open');
  const low = belowMinItems(state);

  const candidates = useMemo(() => {
    let list = state.items;
    if (scope === 'low') list = low;
    if (scope === 'category') list = list.filter((item) => item.category === category);
    if (search.trim()) {
      const term = search.trim().toLowerCase();
      list = list.filter((item) => item.name.toLowerCase().includes(term));
    }
    return [...list].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  }, [state.items, low, scope, category, search]);

  const selected = candidates.filter((item) => !deselected.has(item.id));

  const resetScope = (nextScope: 'all' | 'low' | 'category') => {
    setScope(nextScope);
    setDeselected(new Set());
  };

  useEffect(() => {
    if (params.get('nova') === '1') {
      setDrawerOpen(true);
      params.delete('nova');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const startCount = () => {
    const id = actions.createCount(selected.map((item) => item.id));
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

      <div className="grid grid-cols-2 gap-px border border-line bg-line md:grid-cols-4">
        <div className="bg-panel px-4 py-3.5">
          <div className="eyebrow">Contagens aprovadas</div>
          <div className="mt-1.5 num text-[18px] text-cream">
            {counts.filter((c) => c.status === 'approved').length}
          </div>
        </div>
        <div className="bg-panel px-4 py-3.5">
          <div className="eyebrow">Itens abaixo do mínimo</div>
          <div className="mt-1.5 num text-[18px] text-copper">{low.length}</div>
        </div>
        <div className="bg-panel px-4 py-3.5">
          <div className="eyebrow">Divergência aprovada</div>
          <div className="mt-1.5 num text-[18px] text-cream">
            {money(
              counts
                .filter((c) => c.status === 'approved')
                .reduce((sum, c) => sum + Math.abs(countFinancialCents(state, c)), 0),
            )}
          </div>
        </div>
        <div className="bg-panel px-4 py-3.5">
          <div className="eyebrow">Última contagem</div>
          <div className="mt-1.5 num text-[18px] text-cream">
            {counts[0]?.code ?? '—'}
          </div>
        </div>
      </div>

      <Panel
        className="mt-5"
        title="Histórico de contagens"
        subtitle="Aprovações geram ajustes no estoque, nunca apagam o saldo anterior."
        flush
        bodyClassName=""
      >
        {counts.length === 0 ? (
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
            <table className="table min-w-[760px]">
              <thead>
                <tr>
                  <th>Contagem</th>
                  <th>Situação</th>
                  <th className="text-right">Itens conferidos</th>
                  <th className="text-right">Divergências</th>
                  <th className="text-right">Impacto financeiro</th>
                  <th>Iniciada</th>
                  <th>Responsável</th>
                  <th>Aprovação</th>
                </tr>
              </thead>
              <tbody>
                {counts.map((count) => {
                  const checked = count.lines.filter((l) => l.countedQty != null).length;
                  const financial = countFinancialCents(state, count);
                  const creator = state.users.find((u) => u.id === count.createdBy);
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
                          financial < 0 ? 'text-danger' : 'text-cream'
                        }`}
                      >
                        {count.status === 'approved' ? money(financial) : '—'}
                      </td>
                      <td className="whitespace-nowrap text-[11px] text-dim">
                        {dateTime(count.startedAt)}
                      </td>
                      <td className="text-[11px] text-muted">{creator?.name ?? '—'}</td>
                      <td className="whitespace-nowrap text-[11px] text-dim">
                        {count.approvedAt ? dateTime(count.approvedAt) : 'pendente'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
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
            <span className="mr-auto text-[11px] text-dim">{selected.length} itens selecionados</span>
            <button type="button" className="btn btn-ghost" onClick={() => setDrawerOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={startCount}
              disabled={selected.length === 0}
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
                {Array.from(new Set(state.items.map((item) => item.category))).map((cat) => (
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
              onClick={() =>
                setDeselected(
                  selected.length === candidates.length
                    ? new Set(candidates.map((i) => i.id))
                    : new Set(),
                )
              }
            >
              {selected.length === candidates.length ? 'Limpar' : 'Selecionar todos'}
            </button>
          </div>

          <div className="max-h-[46vh] overflow-y-auto border border-line">
            {candidates.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11.5px] text-dim">
                Nenhum insumo para este filtro.
              </div>
            ) : (
              candidates.map((item) => {
                const isSelected = !deselected.has(item.id);
                return (
                  <label
                    key={item.id}
                    className="flex cursor-pointer items-center gap-3 border-b border-line/70 px-3 py-2.5 last:border-b-0 hover:bg-raised/50"
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {
                        setDeselected((prev) => {
                          const next = new Set(prev);
                          if (next.has(item.id)) next.delete(item.id);
                          else next.add(item.id);
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
          <p className="text-[10.5px] leading-relaxed text-dim">
            Itens não selecionados mantêm o estoque atual. A contagem sempre compara o saldo
            esperado com o contado, sem apagar o histórico.
          </p>
        </div>
      </Drawer>
    </div>
  );
}
