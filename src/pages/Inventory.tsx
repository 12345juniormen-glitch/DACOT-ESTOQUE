import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, ChevronRight, ClipboardList, Plus, Search } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { CATEGORIES, STATUS_LABEL, UNIT_LABEL, type ItemStatus, type Unit } from '../domain/types';
import { itemStatus, itemValueCents, stockValueCents } from '../domain/selectors';
import { money, parseMoney, parseQty, qty as fmtQty, shortDate } from '../domain/format';
import { Drawer, EmptyState, Field, PageHeader, Panel, StatusTag } from '../components/ui';

const STATUS_ORDER: ItemStatus[] = ['normal', 'attention', 'critical', 'empty'];

type SortKey = 'name' | 'value' | 'qty' | 'updated' | 'cost';

export function InventoryPage() {
  const { state, actions, can } = useApp();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState<'all' | ItemStatus>('all');
  const [sort, setSort] = useState<SortKey>('name');
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [name, setName] = useState('');
  const [newCategory, setNewCategory] = useState<(typeof CATEGORIES)[number]>('Carnes');
  const [unit, setUnit] = useState<Unit>('kg');
  const [minQty, setMinQty] = useState('0');
  const [cost, setCost] = useState('');
  const [initialQty, setInitialQty] = useState('0');
  const [supplierId, setSupplierId] = useState('');

  const counts = useMemo(() => {
    const base = { all: state.items.length, normal: 0, attention: 0, critical: 0, empty: 0 };
    for (const item of state.items) base[itemStatus(item)] += 1;
    return base;
  }, [state.items]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const list = state.items.filter((item) => {
      if (category !== 'all' && item.category !== category) return false;
      if (status !== 'all' && itemStatus(item) !== status) return false;
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
  }, [state.items, state.suppliers, search, category, status, sort]);

  const resetForm = () => {
    setName('');
    setNewCategory('Carnes');
    setUnit('kg');
    setMinQty('0');
    setCost('');
    setInitialQty('0');
    setSupplierId('');
  };

  const submit = () => {
    const id = actions.createItem({
      name,
      category: newCategory,
      unit,
      minQty: parseQty(minQty),
      costCents: parseMoney(cost),
      initialQty: parseQty(initialQty),
      supplierId: supplierId || null,
    });
    if (id) {
      setDrawerOpen(false);
      resetForm();
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
              <span className="num text-cream">{state.items.length}</span> insumos
            </span>
            <span className="text-[11px] text-dim">·</span>
            <span className="text-[11px] text-muted">
              Valor total <span className="num text-cream">{money(stockValueCents(state))}</span>
            </span>
            <span className="text-[11px] text-dim">·</span>
            <span className="text-[11px] text-muted">
              <span className="num text-copper">{counts.all - counts.normal}</span> exigem atenção
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
            Todos <span className="font-mono text-[10px] text-dim">{counts.all}</span>
          </button>
          {STATUS_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setStatus(key)}
              className={`filter-tab ${status === key ? 'filter-tab-active' : ''}`}
            >
              {STATUS_LABEL[key]} <span className="font-mono text-[10px] text-dim">{counts[key]}</span>
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={<Boxes size={18} />}
            title={state.items.length === 0 ? 'Ainda não há insumos cadastrados' : 'Nenhum insumo encontrado'}
            description={
              state.items.length === 0
                ? 'Cadastre o primeiro insumo para acompanhar saldo, custo e consumo.'
                : 'Ajuste a busca ou limpe os filtros para ver outros itens do estoque.'
            }
            action={
              state.items.length === 0 && can('stock.create') ? (
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
            <div className="scroll-x hidden md:block">
              <table className="table min-w-[920px]">
                <thead>
                  <tr>
                    <th>Insumo</th>
                    <th>Situação</th>
                    <th className="text-right">Estoque atual</th>
                    <th className="text-right">Mínimo</th>
                    <th className="text-right">Custo unit.</th>
                    <th className="text-right">Valor</th>
                    <th>Fornecedor</th>
                    <th className="text-right">Atualizado</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => {
                    const supplier = state.suppliers.find((s) => s.id === item.primarySupplierId);
                    return (
                      <tr key={item.id} className="row-link">
                        <td>
                          <Link to={`/estoque/${item.id}`} className="block">
                            <div className="text-[13px] text-cream">{item.name}</div>
                            <div className="mt-0.5 text-[10.5px] uppercase tracking-[0.06em] text-dim">
                              {item.category}
                            </div>
                          </Link>
                        </td>
                        <td>
                          <StatusTag status={itemStatus(item)} />
                        </td>
                        <td className="text-right">
                          <span className="num text-[13px] text-cream">
                            {fmtQty(item.currentQty, item.unit)}
                          </span>
                        </td>
                        <td className="text-right num text-[11.5px] text-dim">
                          {fmtQty(item.minQty, item.unit)}
                        </td>
                        <td className="text-right num text-[11.5px] text-muted">
                          {money(item.costCents)}/{item.unit}
                        </td>
                        <td className="text-right num text-[12.5px] text-cream">
                          {money(itemValueCents(item))}
                        </td>
                        <td className="text-[11.5px] text-muted">{supplier?.name ?? '—'}</td>
                        <td className="text-right whitespace-nowrap font-mono text-[10.5px] text-dim">
                          {shortDate(item.updatedAt)}
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
              {filtered.map((item) => (
                <Link
                  key={item.id}
                  to={`/estoque/${item.id}`}
                  className="block px-4 py-3.5 transition-colors active:bg-raised/60"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-[13.5px] text-cream">{item.name}</div>
                      <div className="mt-0.5 text-[10px] uppercase tracking-[0.08em] text-dim">
                        {item.category} · mínimo {fmtQty(item.minQty, item.unit)}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="num text-[15px] text-cream">
                        {fmtQty(item.currentQty, item.unit)}
                      </div>
                      <div className="num mt-0.5 text-[10.5px] text-dim">
                        {money(itemValueCents(item))}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <StatusTag status={itemStatus(item)} />
                    <span className="num text-[10.5px] text-dim">
                      {money(item.costCents)}/{item.unit}
                    </span>
                  </div>
                </Link>
              ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[10.5px] text-dim">
              <span>
                {filtered.length} de {state.items.length} insumos
              </span>
              <span className="num">
                {money(filtered.reduce((sum, item) => sum + itemValueCents(item), 0))} no filtro atual
              </span>
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
            <button type="button" className="btn btn-primary" onClick={submit}>
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
                onChange={(event) => setSupplierId(event.target.value)}
              >
                <option value="">Sem fornecedor</option>
                {state.suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </Field>
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
