import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Ban, Info, PackageCheck, Send, Truck } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { purchaseTotalCents } from '../domain/selectors';
import { dateTime, money, qty as fmtQty, shortDate } from '../domain/format';
import { PURCHASE_STATUS_LABEL } from '../domain/types';
import {
  BackLink,
  Dialog,
  EmptyState,
  PageHeader,
  Panel,
  PurchaseStatusTag,
  ToneNote,
} from '../components/ui';

export function PurchaseDetailPage() {
  const { id } = useParams();
  const { state, actions, can } = useApp();
  const purchase = state.purchases.find((p) => p.id === id);
  const [cancelOpen, setCancelOpen] = useState(false);

  if (!purchase) {
    return (
      <div>
        <BackLink to="/compras">Compras</BackLink>
        <Panel>
          <EmptyState
            icon={<Info size={18} />}
            title="Pedido não encontrado"
            description="O pedido pode ter sido removido ou o endereço está incorreto."
            action={
              <Link to="/compras" className="btn btn-ghost">
                Voltar para compras
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }

  const supplier = state.suppliers.find((s) => s.id === purchase.supplierId);
  const expectedTotal = purchaseTotalCents(purchase, 'expected');
  const receivedTotal = purchase.lines.reduce((sum, line) => {
    if (line.qtyReceived <= 0) return sum;
    return (
      sum +
      Math.round(
        line.qtyReceived * (line.receivedUnitCostCents ?? line.expectedUnitCostCents),
      )
    );
  }, 0);
  const pending = purchase.lines.filter((line) => line.qtyReceived < line.qtyOrdered - 0.001);
  const receivedBy = state.users.find((u) => u.id === purchase.receivedBy);
  const canReceive = ['requested', 'partial'].includes(purchase.status);
  const relatedAudit = state.audit
    .filter(
      (entry) =>
        entry.entityLabel === purchase.code ||
        entry.reason.includes(purchase.code),
    )
    .slice(0, 5);

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
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => actions.requestPurchase(purchase.id)}
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
          <div className="mt-2 num text-[20px] text-cream">{money(receivedTotal)}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">preço real informado</div>
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
                    <th className="text-right">Preço real</th>
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
                    const real = line.receivedUnitCostCents ?? line.expectedUnitCostCents;
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
                            {item.category} · {item.unit}
                          </div>
                        </td>
                        <td className="text-right num text-[12px] text-muted">
                          {fmtQty(line.qtyOrdered, item.unit)}
                        </td>
                        <td className="text-right num text-[12px] text-cream">
                          {line.qtyReceived > 0 ? fmtQty(line.qtyReceived, item.unit) : '—'}
                        </td>
                        <td className="text-right num text-[11.5px] text-muted">
                          {money(line.expectedUnitCostCents)}
                        </td>
                        <td className="text-right num text-[11.5px] text-cream">
                          {line.receivedUnitCostCents != null ? money(real) : '—'}
                        </td>
                        <td className="text-right num text-[12px] text-cream">
                          {money(Math.round((line.qtyReceived > 0 ? line.qtyReceived : 0) * real))}
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
                const real = line.receivedUnitCostCents ?? line.expectedUnitCostCents;
                return (
                  <div key={line.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <Link to={`/estoque/${item.id}`} className="text-[13px] text-cream">
                          {item.name}
                        </Link>
                        <div className="mt-0.5 text-[10px] uppercase tracking-[0.06em] text-dim">
                          solicitado {fmtQty(line.qtyOrdered, item.unit)}
                        </div>
                      </div>
                      <span className={`text-[11px] ${fully ? 'text-ok' : line.qtyReceived > 0 ? 'text-copper' : 'text-dim'}`}>
                        · {fully ? 'Recebido' : line.qtyReceived > 0 ? 'Parcial' : 'Pendente'}
                      </span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px]">
                      <span className="text-muted">
                        recebido {fmtQty(line.qtyReceived, item.unit)} · {money(real)}/{item.unit}
                      </span>
                      <span className="num text-cream">
                        {money(Math.round(line.qtyReceived * real))}
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

          <Panel title="Recebimento" subtitle="Registro do que foi conferido na entrega.">
            {purchase.receivedAt ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-4 text-[11.5px]">
                  <div>
                    <div className="eyebrow mb-1">Recebido em</div>
                    <div className="text-muted">{dateTime(purchase.receivedAt)}</div>
                  </div>
                  <div>
                    <div className="eyebrow mb-1">Conferido por</div>
                    <div className="text-muted">{receivedBy?.name ?? '—'}</div>
                  </div>
                </div>
                {purchase.status === 'partial' ? (
                  <ToneNote tone="warn">
                    Recebimento parcial. {pending.length} {pending.length === 1 ? 'item segue' : 'itens seguem'} pendente
                    {pending.length === 1 ? '' : 's'} e podem ser recebidos em uma nova entrega.
                  </ToneNote>
                ) : null}
                <p className="text-[11px] leading-relaxed text-dim">
                  O recebimento gerou entrada no estoque, atualizou o custo atual dos insumos e
                  registrou preço no histórico do fornecedor.
                </p>
              </div>
            ) : (
              <div className="text-[12px] leading-relaxed text-muted">
                Nenhum recebimento registrado.{' '}
                {canReceive
                  ? 'Use “Receber pedido” para conferir quantidades e preços reais.'
                  : 'Envie o pedido ao fornecedor para liberar o recebimento.'}
              </div>
            )}
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
              onClick={() => {
                const ok = actions.cancelPurchase(purchase.id);
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
    </div>
  );
}
