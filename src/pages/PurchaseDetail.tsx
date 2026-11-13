import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Ban, Info, PackageCheck, Pencil, Send, Truck } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { useEnsureIngredients } from '../hooks/useEnsureIngredients';
import { purchaseTotalCents } from '../domain/selectors';
import { receiptHistoryMatchesPurchase, summarizePurchaseReceipts } from '../domain/receipts';
import { dateTime, money, qty as fmtQty, shortDate } from '../domain/format';
import { PURCHASE_STATUS_LABEL } from '../domain/types';
import { fetchApiPurchase, fetchApiSupplier, listApiPurchaseReceipts, type PurchaseReceiptRecord } from '../lib/api';
import {
  BackLink,
  Dialog,
  EmptyState,
  PageHeader,
  Panel,
  PurchaseStatusTag,
} from '../components/ui';

export function PurchaseDetailPage() {
  const { id } = useParams();
  const { state, actions, can, mode, notify, auditHasMore, auditLoading } = useApp();
  const purchase = state.purchases.find((p) => p.id === id);
  const ingredientHydration = useEnsureIngredients(purchase?.lines.map((line) => line.itemId) ?? []);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [purchaseLookup, setPurchaseLookup] = useState<{ id: string | undefined; loading: boolean }>({
    id: undefined, loading: false,
  });
  const [receipts, setReceipts] = useState<PurchaseReceiptRecord[]>([]);
  const [receiptsLoading, setReceiptsLoading] = useState(false);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [reversalReceiptId, setReversalReceiptId] = useState<string | null>(null);
  const [reversalReason, setReversalReason] = useState('');
  const [showAllAudit, setShowAllAudit] = useState(false);

  useEffect(() => {
    if (mode !== 'production' || !id || purchase) return;
    let active = true;
    setPurchaseLookup({ id, loading: true });
    void fetchApiPurchase(id).then((loaded) => { if (active) actions.cachePurchase(loaded); })
      .catch(() => { /* Empty-state handles missing or inaccessible purchase. */ })
      .finally(() => { if (active) setPurchaseLookup({ id, loading: false }); });
    return () => { active = false; };
  }, [mode, id, purchase, actions]);

  useEffect(() => {
    if (mode !== 'production' || !purchase?.supplierId
        || state.suppliers.some((supplier) => supplier.id === purchase.supplierId)) return;
    let active = true;
    void fetchApiSupplier(purchase.supplierId).then((supplier) => {
      if (active) actions.cacheSupplier(supplier);
    }).catch(() => { /* The purchase remains available if its supplier was archived. */ });
    return () => { active = false; };
  }, [mode, purchase?.supplierId, state.suppliers, actions]);

  useEffect(() => {
    let active = true;
    if (mode !== 'production' || !id) return () => { active = false; };
    setReceipts([]);
    setReceiptsLoading(true);
    setReceiptError(null);
    listApiPurchaseReceipts(id).then((result) => {
      if (active) setReceipts(result);
    }).catch((error: unknown) => {
      if (active) setReceiptError(error instanceof Error ? error.message : 'Falha ao consultar recebimentos.');
    }).finally(() => {
      if (active) setReceiptsLoading(false);
    });
    return () => { active = false; };
  }, [mode, id, purchase?.version]);

  if (!purchase) {
    return (
      <div>
        <BackLink to="/compras">Compras</BackLink>
        <Panel>
          {mode === 'production' && (purchaseLookup.id !== id || purchaseLookup.loading)
            ? <div className="p-5 text-sm text-dim" role="status">Carregando pedido…</div> : null}
          {mode === 'production' && purchaseLookup.id === id && !purchaseLookup.loading ? <EmptyState
            icon={<Info size={18} />}
            title="Pedido não encontrado"
            description="O pedido pode ter sido removido ou o endereço está incorreto."
            action={<Link to="/compras" className="btn btn-ghost">Voltar para compras</Link>}
          /> : null}
          {mode !== 'production' ? <EmptyState
            icon={<Info size={18} />}
            title="Pedido não encontrado"
            description="O pedido pode ter sido removido ou o endereço está incorreto."
            action={<Link to="/compras" className="btn btn-ghost">Voltar para compras</Link>}
          /> : null}
        </Panel>
      </div>
    );
  }

  if (ingredientHydration.loading) {
    return <div><BackLink to="/compras">Compras</BackLink><Panel><div className="px-5 py-8 text-center text-[12px] text-dim" role="status">Carregando os insumos do pedido…</div></Panel></div>;
  }
  if (ingredientHydration.error) {
    return <div><BackLink to="/compras">Compras</BackLink><Panel><EmptyState icon={<Info size={18} />}
      title="Não foi possível carregar os insumos" description={ingredientHydration.error}
      action={<button type="button" className="btn btn-ghost" onClick={ingredientHydration.retry}>Tentar novamente</button>} /></Panel></div>;
  }

  const supplier = state.suppliers.find((s) => s.id === purchase.supplierId);
  const expectedTotal = purchaseTotalCents(purchase, 'expected');
  const receiptSummary = summarizePurchaseReceipts(receipts);
  const receiptHistoryMatches = receiptHistoryMatchesPurchase(receipts, purchase.lines);
  const receiptHistoryAvailable = mode === 'production' && receipts.length > 0 && receiptHistoryMatches;
  const receiptHistoryMissing = mode === 'production' && !receiptsLoading && !receiptError
    && !receiptHistoryMatches && purchase.lines.some((line) => line.qtyReceived > 0);
  const receivedTotal = receiptHistoryAvailable
    ? Object.values(receiptSummary).reduce((sum, line) => sum + line.totalCents, 0)
    : purchase.lines.reduce((sum, line) => line.qtyReceived <= 0 ? sum : sum
      + Math.round(line.qtyReceived * (line.receivedUnitCostCents ?? line.expectedUnitCostCents)), 0);
  const pending = purchase.lines.filter((line) => line.qtyReceived < line.qtyOrdered - 0.001);
  const receivedBy = state.users.find((u) => u.id === purchase.receivedBy);
  const canReceive = ['requested', 'partial'].includes(purchase.status);
  const relatedAuditEntries = state.audit.filter(
      (entry) =>
        entry.entityLabel === purchase.code ||
        entry.reason.includes(purchase.code),
    );
  const relatedAudit = showAllAudit ? relatedAuditEntries : relatedAuditEntries.slice(0, 5);

  return (
    <div>
      <BackLink to="/compras">Compras</BackLink>

      <PageHeader
        eyebrow={`Compras / ${purchase.code}`}
        title={supplier?.name ?? 'Pedido de compra'}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <PurchaseStatusTag status={purchase.status} />
            <span className="text-dim">·</span>
            <span>{purchase.lines.length} itens</span>
            <span className="text-dim">·</span>
            <span>criado em {dateTime(purchase.createdAt)}</span>
            {purchase.receivedAt ? (
              <>
                <span className="text-dim">·</span>
                <span>recebido em {dateTime(purchase.receivedAt)}</span>
              </>
            ) : null}
          </span>
        }
        actions={
          <>
            {purchase.status === 'draft' && can('purchases.manage') ? (
              <Link to={`/compras?editar=${encodeURIComponent(purchase.id)}`} className="btn btn-ghost">
                <Pencil size={13} />
                Editar rascunho
              </Link>
            ) : null}
            {purchase.status === 'draft' && can('purchases.manage') ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => actions.requestPurchase(purchase.id, purchase.version ?? 1)}
              >
                <Send size={13} />
                Enviar ao fornecedor
              </button>
            ) : null}
            {['draft', 'requested'].includes(purchase.status) && can('purchases.manage') ? (
              <button type="button" className="btn btn-danger" onClick={() => setCancelOpen(true)}>
                <Ban size={13} />
                Cancelar
              </button>
            ) : null}
            {canReceive && can('purchases.receive') ? (
              <Link to={`/compras/${purchase.id}/receber`} className="btn btn-primary">
                <PackageCheck size={14} />
                Receber pedido
              </Link>
            ) : null}
          </>
        }
      />

      <section className="panel mb-5 grid grid-cols-2 gap-px overflow-hidden bg-line md:grid-cols-4">
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Total do pedido</div>
          <div className="mt-2 num text-[20px] text-cream">{money(expectedTotal)}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">preço esperado</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Valor recebido</div>
          <div className="mt-2 num text-[20px] text-cream">
            {mode === 'production' && (receiptError || receiptHistoryMissing) ? '—' : receiptsLoading ? '…' : money(receivedTotal)}
          </div>
          <div className="mt-1.5 text-[10.5px] text-dim">
            {receiptHistoryAvailable ? 'soma dos recebimentos válidos'
              : receiptHistoryMissing ? 'detalhes de entrega indisponíveis'
                : 'preço real informado'}
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Itens pendentes</div>
          <div className={`mt-2 num text-[20px] ${pending.length ? 'text-copper' : 'text-cream'}`}>
            {pending.length}
          </div>
          <div className="mt-1.5 text-[10.5px] text-dim">
            {pending.length ? 'saldo a receber' : 'pedido completo'}
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Previsão de entrega</div>
          <div className="mt-2 text-[15px] text-cream">
            {purchase.expectedDeliveryAt ? dateTime(purchase.expectedDeliveryAt).split(' ')[0] : 'não definida'}
          </div>
          <div className="mt-1.5 text-[10.5px] text-dim">
            {supplier ? `prazo médio ${supplier.avgLeadTimeDays} dias` : 'sem fornecedor'}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-5">
          <Panel
            title="Itens do pedido"
            subtitle="Quantidade solicitada, recebida e preço praticado."
            flush
            bodyClassName=""
          >
            <div className="scroll-x hidden md:block">
              <table className="table min-w-[760px]">
                <thead>
                  <tr>
                    <th>Insumo</th>
                    <th className="text-right">Solicitado</th>
                    <th className="text-right">Recebido</th>
                    <th className="text-right">Preço esperado</th>
                    <th className="text-right">Preço médio</th>
                    <th className="text-right">Subtotal</th>
                    <th>Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {purchase.lines.map((line) => {
                    const item = state.items.find((i) => i.id === line.itemId);
                    if (!item) return null;
                    const fully = line.qtyReceived >= line.qtyOrdered - 0.001;
                    const partial = line.qtyReceived > 0 && !fully;
                    const received = receiptSummary[line.id];
                    const real = received && received.quantity > 0
                      ? Math.round(received.totalCents / received.quantity)
                      : mode === 'production' ? null
                        : line.receivedUnitCostCents ?? line.expectedUnitCostCents;
                    const subtotal = receiptHistoryAvailable
                      ? received?.totalCents ?? 0
                      : mode === 'production' ? (line.qtyReceived === 0 ? 0 : null)
                        : Math.round(Math.max(0, line.qtyReceived) * real!);
                    const unit = line.unit ?? item.unit;
                    return (
                      <tr key={line.id}>
                        <td>
                          <Link
                            to={`/estoque/${item.id}`}
                            className="text-[12.5px] text-cream hover:text-copper"
                          >
                            {item.name}
                          </Link>
                          <div className="mt-0.5 text-[10px] uppercase tracking-[0.06em] text-dim">
                            {item.category} · base {item.unit} · compra {unit}
                          </div>
                        </td>
                        <td className="text-right num text-[12px] text-muted">
                          {fmtQty(line.qtyOrdered, unit)}
                        </td>
                        <td className="text-right num text-[12px] text-cream">
                          {line.qtyReceived > 0 ? fmtQty(line.qtyReceived, unit) : '—'}
                        </td>
                        <td className="text-right num text-[11.5px] text-muted">
                          {money(line.expectedUnitCostCents)}/{unit}
                        </td>
                        <td className="text-right num text-[11.5px] text-cream">
                          {line.qtyReceived > 0 && real != null ? `${money(real)}/${unit}` : '—'}
                        </td>
                        <td className="text-right num text-[12px] text-cream">
                          {subtotal == null ? '—' : money(subtotal)}
                        </td>
                        <td>
                          <span
                            className={`text-[11.5px] ${
                              fully ? 'text-ok' : partial ? 'text-copper' : 'text-dim'
                            }`}
                          >
                            · {fully ? 'Recebido' : partial ? 'Parcial' : 'Pendente'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="divide-y divide-line md:hidden">
              {purchase.lines.map((line) => {
                const item = state.items.find((i) => i.id === line.itemId);
                if (!item) return null;
                const fully = line.qtyReceived >= line.qtyOrdered - 0.001;
                const received = receiptSummary[line.id];
                const real = received && received.quantity > 0
                  ? Math.round(received.totalCents / received.quantity)
                  : mode === 'production' ? null
                    : line.receivedUnitCostCents ?? line.expectedUnitCostCents;
                const subtotal = receiptHistoryAvailable
                  ? received?.totalCents ?? 0
                  : mode === 'production' ? (line.qtyReceived === 0 ? 0 : null)
                    : Math.round(Math.max(0, line.qtyReceived) * real!);
                const unit = line.unit ?? item.unit;
                return (
                  <div key={line.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <Link to={`/estoque/${item.id}`} className="text-[13px] text-cream">
                          {item.name}
                        </Link>
                        <div className="mt-0.5 text-[10px] uppercase tracking-[0.06em] text-dim">
                          solicitado {fmtQty(line.qtyOrdered, unit)} {unit}
                        </div>
                      </div>
                      <span className={`text-[11px] ${fully ? 'text-ok' : line.qtyReceived > 0 ? 'text-copper' : 'text-dim'}`}>
                        · {fully ? 'Recebido' : line.qtyReceived > 0 ? 'Parcial' : 'Pendente'}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px]">
                      <span className="text-muted">
                        recebido {fmtQty(line.qtyReceived, unit)} · {real == null ? '—' : `${money(real)}/${unit}`}
                      </span>
                      <span className="num text-cream">
                        {subtotal == null ? '—' : money(subtotal)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex items-center justify-between border-t border-line px-4 py-3">
              <span className="text-[11px] text-dim">Total do pedido</span>
              <span className="num text-[15px] text-cream">{money(expectedTotal)}</span>
            </div>
          </Panel>

          <Panel title="Recebimento" subtitle="Registros de conferência e entradas associadas ao estoque.">
            {mode === 'production' ? (
              <div className="space-y-3">
                {receiptsLoading ? <p className="text-[11.5px] text-dim">Carregando recebimentos…</p> : null}
                {receiptError ? <p role="alert" className="text-[11.5px] text-danger">{receiptError}</p> : null}
                {!receiptsLoading && !receiptError && receipts.length === 0 ? (
                  <p className="text-[11.5px] text-muted">Nenhum recebimento registrado.</p>
                ) : null}
                {receipts.map((receipt) => (
                  <div key={receipt.id} className="border border-line bg-raised/30 px-3 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-[11.5px] text-cream">{dateTime(receipt.received_at)}</div>
                        <div className="mt-0.5 text-[10.5px] text-dim">
                          {receipt.lines.length} linha(s) · conferido por {state.users.find((user) => user.id === receipt.actor_id)?.name ?? receipt.actor_id}
                        </div>
                      </div>
                      {receipt.reversed_at ? (
                        <span className="status status-ghost">Estornado</span>
                      ) : can('purchases.manage') ? (
                        <button type="button" className="btn btn-ghost h-7 px-2 text-[10.5px]"
                          onClick={() => { setReversalReceiptId(receipt.id); setReversalReason(''); }}>
                          Estornar recebimento
                        </button>
                      ) : null}
                    </div>
                    <ul className="mt-2 space-y-1 border-t border-line pt-2">
                      {receipt.lines.map((line) => {
                        const purchaseLine = purchase.lines.find((entry) => entry.id === line.line_id);
                        const item = state.items.find((entry) => entry.id === purchaseLine?.itemId);
                        const unit = purchaseLine?.unit ?? item?.unit;
                        return <li key={line.line_id} className="flex justify-between gap-3 text-[10.5px]">
                          <span className="text-muted">{item?.name ?? 'Insumo'} · {fmtQty(line.quantity_received, unit)}</span>
                          <span className="num text-dim">{money(line.unit_cost_cents)}/{unit ?? 'un'}</span>
                        </li>;
                      })}
                    </ul>
                    {receipt.reversed_at ? <p className="mt-2 text-[10.5px] text-dim">
                      Estornado em {dateTime(receipt.reversed_at)} · {receipt.reversal_reason}
                    </p> : null}
                  </div>
                ))}
              </div>
            ) : purchase.receivedAt ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-4 text-[11.5px]">
                  <div><div className="eyebrow mb-1">Recebido em</div><div className="text-muted">{dateTime(purchase.receivedAt)}</div></div>
                  <div><div className="eyebrow mb-1">Conferido por</div><div className="text-muted">{receivedBy?.name ?? '—'}</div></div>
                </div>
                <p className="text-[11px] leading-relaxed text-dim">O recebimento gerou entrada no estoque e atualizou o custo dos insumos.</p>
              </div>
            ) : <div className="text-[12px] leading-relaxed text-muted">Nenhum recebimento registrado.{' '}
              {canReceive ? 'Use “Receber pedido” para conferir quantidades e preços reais.' : 'Envie o pedido ao fornecedor para liberar o recebimento.'}</div>}
          </Panel>
        </div>

        <div className="flex flex-col gap-5">
          <Panel
            title="Fornecedor"
            bodyClassName="px-4 py-4"
            actions={
              supplier ? (
                <Link to={`/fornecedores/${supplier.id}`} className="text-[11px] text-copper">
                  Abrir
                </Link>
              ) : null
            }
          >
            {supplier ? (
              <div className="space-y-3 text-[11.5px]">
                <div>
                  <div className="text-[13px] text-cream">{supplier.name}</div>
                  <div className="mt-0.5 text-[10.5px] text-dim">{supplier.contact}</div>
                </div>
                <div className="grid grid-cols-2 gap-3 border-t border-line pt-3">
                  <div>
                    <div className="eyebrow mb-1">Telefone</div>
                    <div className="num text-[11px] text-muted">{supplier.phone}</div>
                  </div>
                  <div>
                    <div className="eyebrow mb-1">WhatsApp</div>
                    <div className="num text-[11px] text-muted">{supplier.whatsapp}</div>
                  </div>
                  <div>
                    <div className="eyebrow mb-1">Prazo médio</div>
                    <div className="text-muted">{supplier.avgLeadTimeDays} dias</div>
                  </div>
                  <div>
                    <div className="eyebrow mb-1">Pedido mínimo</div>
                    <div className="num text-muted">{money(supplier.minOrderCents)}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-[12px] text-dim">Fornecedor não encontrado.</div>
            )}
          </Panel>

          <Panel title="Dados do pedido">
            <div className="space-y-3 text-[11.5px]">
              <div className="flex justify-between gap-3">
                <span className="text-dim">Pedido</span>
                <span className="num text-cream">{purchase.code}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-dim">Situação</span>
                <span className="text-muted">{PURCHASE_STATUS_LABEL[purchase.status]}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-dim">Criado</span>
                <span className="text-muted">{shortDate(purchase.createdAt)}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-dim">Previsão</span>
                <span className="text-muted">
                  {purchase.expectedDeliveryAt ? shortDate(purchase.expectedDeliveryAt) : '—'}
                </span>
              </div>
              {purchase.note ? (
                <div className="border-t border-line pt-3">
                  <div className="eyebrow mb-1">Observações</div>
                  <p className="leading-relaxed text-muted">{purchase.note}</p>
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel title="Auditoria" subtitle="Eventos relacionados a este pedido." flush bodyClassName="">
            {relatedAudit.length === 0 ? (
              <div className="px-4 py-4 text-[11px] leading-relaxed text-dim">
                Sem eventos de auditoria registrados para este pedido.
              </div>
            ) : (
              <div className="divide-y divide-line">
                {relatedAudit.map((entry) => {
                  const author = state.users.find((u) => u.id === entry.userId);
                  return (
                    <div key={entry.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-cream">{author?.name ?? 'Sistema'}</span>
                        <span className="font-mono text-[9.5px] text-dim">
                          {shortDate(entry.at)}
                        </span>
                      </div>
                      <div className="mt-1 text-[10.5px] leading-relaxed text-muted">
                        {entry.reason}
                      </div>
                      {entry.before || entry.after ? (
                        <div className="mt-0.5 text-[9.5px] text-dim">
                          {entry.before} {entry.before ? '→' : ''} {entry.after}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
            {mode === 'production' && auditHasMore ? (
              <div className="border-t border-line px-4 py-2.5">
                <button type="button" className="text-[10px] text-copper hover:text-copper-hi disabled:opacity-50"
                  onClick={() => { setShowAllAudit(true); void actions.loadMoreAudit(); }} disabled={auditLoading}>
                  {auditLoading ? 'Carregando…' : 'Carregar auditoria anterior'}
                </button>
              </div>
            ) : null}
          </Panel>

          <div className="flex items-center gap-2 text-[10px] text-dim">
            <Truck size={13} className="text-dim" />
            Preços reais atualizam o custo atual do insumo e o histórico de preços.
          </div>
        </div>
      </div>

      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title="Cancelar pedido de compra"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setCancelOpen(false)}>
              Manter pedido
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                const ok = await actions.cancelPurchase(purchase.id, purchase.version ?? 1);
                if (ok) setCancelOpen(false);
              }}
            >
              Cancelar pedido
            </button>
          </>
        }
      >
        O pedido <span className="num text-cream">{purchase.code}</span> será marcado como cancelado.
        Nenhuma entrada de estoque será gerada. A ação fica registrada na auditoria.
      </Dialog>
      <Dialog
        open={reversalReceiptId !== null}
        onClose={() => setReversalReceiptId(null)}
        title="Estornar recebimento"
        footer={<>
          <button type="button" className="btn btn-ghost" onClick={() => setReversalReceiptId(null)}>Voltar</button>
          <button type="button" className="btn btn-danger" disabled={reversalReason.trim().length < 3}
            onClick={async () => {
              if (!reversalReceiptId) return;
              const ok = await actions.reversePurchaseReceipt(purchase.id, reversalReceiptId, reversalReason.trim());
              if (!ok) return;
              setReversalReceiptId(null);
              setReceiptsLoading(true);
              try {
                setReceipts(await listApiPurchaseReceipts(purchase.id));
                setReceiptError(null);
              } catch (error) {
                const detail = error instanceof Error ? error.message : 'Falha ao atualizar recebimentos.';
                setReceiptError(detail);
                notify(`Estorno registrado, mas o histórico não atualizou (${detail}).`, 'error');
              } finally {
                setReceiptsLoading(false);
              }
            }}>Confirmar estorno</button>
        </>}
      >
        <p>O sistema registrará uma saída compensatória e preservará o recebimento original na auditoria. O estorno só será concluído se houver saldo disponível suficiente.</p>
        <label className="label mt-4" htmlFor="receipt-reversal-reason">Motivo obrigatório</label>
        <textarea id="receipt-reversal-reason" className="textarea min-h-[76px]" maxLength={300}
          value={reversalReason} onChange={(event) => setReversalReason(event.target.value)}
          placeholder="Ex.: quantidade lançada incorretamente" />
      </Dialog>
    </div>
  );
}
