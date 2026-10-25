import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { purchaseTotalCents } from '../domain/selectors';
import { date, money, moneyInput, parseMoney, parseQty, qty as fmtQty, shortDate } from '../domain/format';
import {
  PURCHASE_STATUS_LABEL,
  type PurchaseStatus,
} from '../domain/types';
import {
  Drawer,
  EmptyState,
  Field,
  PageHeader,
  Panel,
  PurchaseStatusTag,
} from '../components/ui';

const STATUS_TABS: ('all' | PurchaseStatus)[] = [
  'all',
  'draft',
  'requested',
  'partial',
  'received',
  'cancelled',
];

export function PurchasesPage() {
  const { state, actions, can } = useApp();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<'all' | PurchaseStatus>('all');
  const [drawerOpen, setDrawerOpen] = useState(params.get('novo') === '1');

  const [supplierId, setSupplierId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [note, setNote] = useState('');
  const [itemId, setItemId] = useState('');
  const [qtyText, setQtyText] = useState('');
  const [priceText, setPriceText] = useState('');
  const [lines, setLines] = useState<
    { itemId: string; qtyOrdered: number; expectedUnitCostCents: number }[]
  >([]);

  const counts = useMemo(() => {
    const base: Record<'all' | PurchaseStatus, number> = {
      all: state.purchases.length,
      draft: 0,
      requested: 0,
      partial: 0,
      received: 0,
      cancelled: 0,
    };
    for (const purchase of state.purchases) base[purchase.status] += 1;
    return base;
  }, [state.purchases]);

  const purchases = useMemo(() => {
    const list =
      filter === 'all'
        ? state.purchases
        : state.purchases.filter((purchase) => purchase.status === filter);
    return [...list].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [state.purchases, filter]);

  useEffect(() => {
    if (params.get('novo') === '1') {
      setDrawerOpen(true);
      params.delete('novo');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const totalDraft = lines.reduce(
    (sum, line) => sum + Math.round(line.qtyOrdered * line.expectedUnitCostCents),
    0,
  );

  const suggestedPrice = (nextItemId: string, nextSupplierId: string) => {
    const offer = state.supplierItems.find(
      (si) => si.itemId === nextItemId && si.supplierId === nextSupplierId,
    );
    const item = state.items.find((i) => i.id === nextItemId);
    return offer?.lastPriceCents ?? item?.costCents ?? 0;
  };

  const resetForm = () => {
    setSupplierId('');
    setExpectedDate('');
    setNote('');
    setItemId('');
    setQtyText('');
    setPriceText('');
    setLines([]);
  };

  const addLine = () => {
    if (!itemId || parseQty(qtyText) <= 0) return;
    if (lines.some((line) => line.itemId === itemId)) return;
    setLines((prev) => [
      ...prev,
      {
        itemId,
        qtyOrdered: parseQty(qtyText),
        expectedUnitCostCents: parseMoney(priceText) || suggestedPrice(itemId, supplierId),
      },
    ]);
    setItemId('');
    setQtyText('');
    setPriceText('');
  };

  const create = () => {
    const id = actions.createPurchase({
      supplierId,
      expectedDeliveryAt: expectedDate ? `${expectedDate}T12:00:00-03:00` : null,
      note,
      lines,
    });
    if (id) {
      setDrawerOpen(false);
      resetForm();
      navigate(`/compras/${id}`);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="04 / Compras"
        title="Compras"
        description="Acompanhe entregas pendentes e confirme o que chegou."
        actions={
          can('purchases.manage') ? (
            <button type="button" className="btn btn-primary" onClick={() => setDrawerOpen(true)}>
              <Plus size={14} />
              Novo pedido
            </button>
          ) : null
        }
      />

      <Panel flush bodyClassName="">
        <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
          {STATUS_TABS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={`filter-tab ${filter === key ? 'filter-tab-active' : ''}`}
            >
              {key === 'all' ? 'Todos' : PURCHASE_STATUS_LABEL[key]}
              <span className="font-mono text-[10px] text-dim">{counts[key]}</span>
            </button>
          ))}
        </div>

        {purchases.length === 0 ? (
          <EmptyState
            icon={<ShoppingCart size={18} />}
            title={state.purchases.length === 0 ? 'Nenhum pedido de compra ainda' : 'Nenhum pedido neste status'}
            description={
              state.purchases.length === 0
                ? 'Crie o primeiro pedido para acompanhar entrega, preço real e entrada no estoque.'
                : 'Altere o filtro para ver pedidos em outros estágios.'
            }
            action={
              can('purchases.manage') && state.purchases.length === 0 ? (
                <button type="button" className="btn btn-primary" onClick={() => setDrawerOpen(true)}>
                  Criar primeiro pedido
                </button>
              ) : null
            }
          />
        ) : (
          <>
            <div className="scroll-x hidden md:block">
              <table className="table min-w-[620px]">
                <thead>
                  <tr>
                    <th>Pedido</th>
                    <th>Fornecedor</th>
                    <th>Situação</th>
                    <th className="text-right">Total</th>
                    <th>Previsão</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {purchases.map((purchase) => {
                    const supplier = state.suppliers.find((s) => s.id === purchase.supplierId);
                    return (
                      <tr key={purchase.id} className="row-link">
                        <td>
                          <Link to={`/compras/${purchase.id}`} className="block">
                            <div className="num text-[12.5px] text-cream">{purchase.code}</div>
                            <div className="mt-0.5 text-[10.5px] text-dim">
                              {purchase.note ? purchase.note.slice(0, 34) : 'sem observações'}
                            </div>
                          </Link>
                        </td>
                        <td className="text-[12px] text-muted">{supplier?.name ?? '—'}</td>
                        <td>
                          <PurchaseStatusTag status={purchase.status} />
                        </td>
                        <td className="text-right num text-[12.5px] text-cream">
                          {money(purchaseTotalCents(purchase))}
                        </td>
                        <td className="whitespace-nowrap font-mono text-[10.5px] text-muted">
                          {purchase.expectedDeliveryAt ? date(purchase.expectedDeliveryAt) : '—'}
                        </td>
                        <td className="w-8">
                          <ArrowRight size={13} className="text-dim" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-line md:hidden">
              {purchases.map((purchase) => {
                const supplier = state.suppliers.find((s) => s.id === purchase.supplierId);
                return (
                  <Link
                    key={purchase.id}
                    to={`/compras/${purchase.id}`}
                    className="block px-4 py-3.5 active:bg-raised/60"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="num text-[12.5px] text-cream">{purchase.code}</div>
                        <div className="mt-0.5 truncate text-[11px] text-muted">
                          {supplier?.name ?? '—'}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="num text-[13px] text-cream">
                          {money(purchaseTotalCents(purchase))}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <PurchaseStatusTag status={purchase.status} />
                      <span className="font-mono text-[10px] text-dim">
                        {purchase.expectedDeliveryAt ? `Prev. ${shortDate(purchase.expectedDeliveryAt)}` : `${purchase.lines.length} itens`}
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </>
        )}
      </Panel>

      <p className="mt-3 text-[10.5px] text-dim">
        {counts.received} pedidos recebidos · {counts.requested + counts.partial} aguardando entrega ·
        valores pelo preço esperado.
      </p>

      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        eyebrow="Compras"
        title="Novo pedido de compra"
        description="O pedido nasce como rascunho. O fornecedor pode ser escolhido ao enviar."
        width="max-w-[580px]"
        footer={
          <>
            <span className="mr-auto text-[11px] text-dim">
              Total <span className="num text-cream">{money(totalDraft)}</span>
            </span>
            <button type="button" className="btn btn-ghost" onClick={() => setDrawerOpen(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={create}
              disabled={!supplierId || lines.length === 0}
            >
              Criar rascunho
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fornecedor" htmlFor="purchase-supplier">
              <select
                id="purchase-supplier"
                className="select"
                value={supplierId}
                onChange={(event) => setSupplierId(event.target.value)}
              >
                <option value="">Selecionar</option>
                {state.suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Previsão de entrega" htmlFor="purchase-date">
              <input
                id="purchase-date"
                type="date"
                className="input num"
                value={expectedDate}
                onChange={(event) => setExpectedDate(event.target.value)}
              />
            </Field>
          </div>

          <div className="border-t border-line pt-4">
            <div className="eyebrow mb-3">Itens do pedido</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_86px_102px_auto]">
              <select
                className="select h-9"
                value={itemId}
                onChange={(event) => {
                  const next = event.target.value;
                  setItemId(next);
                  if (next) setPriceText(moneyInput(suggestedPrice(next, supplierId)));
                }}
                aria-label="Insumo"
              >
                <option value="">Selecionar insumo</option>
                {state.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <input
                className="input num"
                placeholder="Qtd."
                inputMode="decimal"
                value={qtyText}
                onChange={(event) => setQtyText(event.target.value)}
                aria-label="Quantidade"
              />
              <input
                className="input num"
                placeholder="Preço un."
                inputMode="decimal"
                value={priceText}
                onChange={(event) => setPriceText(event.target.value)}
                aria-label="Preço unitário"
              />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={addLine}
                disabled={!itemId || !qtyText}
              >
                <Plus size={13} />
                <span className="sm:hidden">Adicionar</span>
              </button>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-dim">
              Preço sugerido pelo último preço do fornecedor para o insumo. Você pode ajustar antes
              de criar o pedido.
            </p>
          </div>

          {lines.length > 0 ? (
            <div className="border border-line">
              {lines.map((line) => {
                const item = state.items.find((i) => i.id === line.itemId);
                if (!item) return null;
                return (
                  <div
                    key={line.itemId}
                    className="flex items-center justify-between gap-3 border-b border-line/70 px-3 py-2.5 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[12px] text-cream">{item.name}</div>
                      <div className="num mt-0.5 text-[10.5px] text-dim">
                        {fmtQty(line.qtyOrdered, item.unit)} × {money(line.expectedUnitCostCents)}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="num text-[12px] text-cream">
                        {money(Math.round(line.qtyOrdered * line.expectedUnitCostCents))}
                      </span>
                      <button
                        type="button"
                        className="text-dim hover:text-danger"
                        onClick={() =>
                          setLines((prev) => prev.filter((l) => l.itemId !== line.itemId))
                        }
                        aria-label={`Remover ${item.name}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="border border-dashed border-line px-3 py-5 text-center text-[11.5px] text-dim">
              Adicione insumos para montar o pedido.
            </div>
          )}

          <Field label="Observações" htmlFor="purchase-note">
            <textarea
              id="purchase-note"
              className="textarea min-h-[70px]"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Instruções de entrega, condições combinadas, saldo pendente…"
            />
          </Field>

          <div className="border border-line bg-[#0b0b0a] px-3 py-2.5 text-[10.5px] leading-relaxed text-dim">
            O valor só entra no estoque quando o recebimento for confirmado. O custo do insumo é
            atualizado pelo preço real da nota.
          </div>
        </div>
      </Drawer>
    </div>
  );
}
