import { Link, useParams } from 'react-router-dom';
import { ArrowRight, Info, Truck } from 'lucide-react';
import { useApp } from '../state/AppStore';
import {
  purchaseTotalCents,
  supplierItemCount,
  supplierLastPurchase,
  supplierRecentValue,
} from '../domain/selectors';
import { date, money, qty as fmtQty, shortDate } from '../domain/format';
import {
  BackLink,
  EmptyState,
  PageHeader,
  Panel,
  PurchaseStatusTag,
} from '../components/ui';

export function SupplierDetailPage() {
  const { id } = useParams();
  const { state, can } = useApp();
  const supplier = state.suppliers.find((s) => s.id === id);

  if (!supplier) {
    return (
      <div>
        <BackLink to="/fornecedores">Fornecedores</BackLink>
        <Panel>
          <EmptyState
            icon={<Info size={18} />}
            title="Fornecedor não encontrado"
            description="O cadastro pode ter sido removido ou o endereço está incorreto."
            action={
              <Link to="/fornecedores" className="btn btn-ghost">
                Voltar para fornecedores
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }

  const supplied = state.supplierItems.filter((si) => si.supplierId === supplier.id);
  const purchases = state.purchases
    .filter((purchase) => purchase.supplierId === supplier.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const last = supplierLastPurchase(state, supplier.id);
  const recent = supplierRecentValue(state, supplier.id);

  const rows = supplied
    .map((si) => {
      const item = state.items.find((i) => i.id === si.itemId);
      if (!item) return null;
      const points = state.pricePoints
        .filter((p) => p.itemId === item.id && p.supplierId === supplier.id)
        .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      const previous = points.length >= 2 ? points[points.length - 2] : null;
      const latest = points[points.length - 1] ?? null;
      const variation =
        previous && latest && previous.unitCostCents > 0
          ? (latest.unitCostCents - previous.unitCostCents) / previous.unitCostCents
          : 0;
      return { si, item, variation, latest };
    })
    .filter((row): row is NonNullable<typeof row> => row != null)
    .sort((a, b) => a.item.name.localeCompare(b.item.name, 'pt-BR'));

  return (
    <div>
      <BackLink to="/fornecedores">Fornecedores</BackLink>

      <PageHeader
        eyebrow="Fornecedores / Cadastro"
        title={supplier.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span>{supplier.contact}</span>
            <span className="text-dim">·</span>
            <span className="num">{supplier.phone}</span>
            <span className="text-dim">·</span>
            <span>WhatsApp {supplier.whatsapp}</span>
          </span>
        }
        actions={
          can('purchases.manage') ? (
            <Link to="/compras?novo=1" className="btn btn-ghost">
              <Truck size={14} />
              Novo pedido
            </Link>
          ) : null
        }
      />

      <section className="panel mb-5 grid grid-cols-2 gap-px overflow-hidden bg-line md:grid-cols-4">
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Itens fornecidos</div>
          <div className="mt-2 num text-[20px] text-cream">{supplierItemCount(state, supplier.id)}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">insumos vinculados</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Comprado (90 dias)</div>
          <div className="mt-2 num text-[20px] text-cream">{money(recent)}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">{purchases.length} pedidos registrados</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Última entrega</div>
          <div className="mt-2 text-[15px] text-cream">
            {last?.receivedAt ? date(last.receivedAt) : 'sem entrega'}
          </div>
          <div className="mt-1.5 text-[10.5px] text-dim">{last?.code ?? '—'}</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Prazo médio</div>
          <div className="mt-2 num text-[20px] text-cream">{supplier.avgLeadTimeDays} dias</div>
          <div className="mt-1.5 text-[10.5px] text-dim">
            pedido mínimo {money(supplier.minOrderCents)}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex flex-col gap-5">
          <Panel
            title="Itens fornecidos"
            subtitle="Último preço registrado e variação desde a compra anterior."
            flush
            bodyClassName=""
          >
            {rows.length === 0 ? (
              <EmptyState
                icon={<Truck size={18} />}
                title="Nenhum item vinculado a este fornecedor"
                description="Vincule insumos pelo cadastro do item ou pelo recebimento de uma compra para registrar preços."
                action={
                  <Link to="/estoque" className="btn btn-ghost">
                    Ver estoque
                  </Link>
                }
              />
            ) : (
              <div className="scroll-x">
                <table className="table min-w-[680px]">
                  <thead>
                    <tr>
                      <th>Insumo</th>
                      <th className="text-right">Último preço</th>
                      <th className="text-right">Variação</th>
                      <th className="text-right">Prazo</th>
                      <th className="text-right">Mínimo</th>
                      <th>Última compra</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ si, item, variation, latest }) => (
                      <tr key={si.id} className="row-link">
                        <td>
                          <Link to={`/estoque/${item.id}`} className="block">
                            <div className="text-[12.5px] text-cream">{item.name}</div>
                            <div className="mt-0.5 text-[10px] uppercase tracking-[0.06em] text-dim">
                              {item.category} · estoque {fmtQty(item.currentQty, item.unit)}
                            </div>
                          </Link>
                        </td>
                        <td className="text-right num text-[12px] text-cream">
                          {money(latest?.unitCostCents ?? si.lastPriceCents)}
                          <span className="ml-0.5 text-[10px] text-dim">/{item.unit}</span>
                        </td>
                        <td
                          className={`text-right num text-[11px] ${
                            variation > 0 ? 'text-copper' : variation < 0 ? 'text-ok' : 'text-dim'
                          }`}
                        >
                          {variation === 0
                            ? '—'
                            : `${variation > 0 ? '+' : ''}${(variation * 100).toFixed(1)}%`}
                        </td>
                        <td className="text-right text-[11.5px] text-muted">{si.leadTimeDays} dias</td>
                        <td className="text-right num text-[11px] text-muted">
                          {money(si.minOrderCents)}
                        </td>
                        <td className="whitespace-nowrap font-mono text-[10.5px] text-dim">
                          {si.lastPurchaseAt ? shortDate(si.lastPurchaseAt) : '—'}
                        </td>
                        <td className="w-8">
                          <ArrowRight size={13} className="text-dim" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel
            title="Histórico de compras"
            subtitle="Pedidos deste fornecedor, do mais recente ao mais antigo."
            flush
            bodyClassName=""
          >
            {purchases.length === 0 ? (
              <EmptyState
                icon={<Truck size={18} />}
                title="Nenhuma compra registrada"
                description="Crie um pedido de compra para começar o histórico deste fornecedor."
                action={
                  can('purchases.manage') ? (
                    <Link to="/compras?novo=1" className="btn btn-ghost">
                      Novo pedido
                    </Link>
                  ) : null
                }
              />
            ) : (
              <div className="scroll-x">
                <table className="table min-w-[620px]">
                  <thead>
                    <tr>
                      <th>Pedido</th>
                      <th>Data</th>
                      <th>Situação</th>
                      <th className="text-right">Itens</th>
                      <th className="text-right">Total</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {purchases.map((purchase) => (
                      <tr key={purchase.id} className="row-link">
                        <td>
                          <Link
                            to={`/compras/${purchase.id}`}
                            className="num text-[12px] text-cream"
                          >
                            {purchase.code}
                          </Link>
                        </td>
                        <td className="whitespace-nowrap font-mono text-[10.5px] text-dim">
                          {shortDate(purchase.createdAt)}
                        </td>
                        <td>
                          <PurchaseStatusTag status={purchase.status} />
                        </td>
                        <td className="text-right num text-[11px] text-muted">
                          {purchase.lines.length}
                        </td>
                        <td className="text-right num text-[12px] text-cream">
                          {money(purchaseTotalCents(purchase))}
                        </td>
                        <td className="w-8">
                          <ArrowRight size={13} className="text-dim" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>

        <div className="flex flex-col gap-5">
          <Panel title="Dados do fornecedor">
            <div className="space-y-3 text-[11.5px]">
              <div>
                <div className="eyebrow mb-1">Contato</div>
                <div className="text-muted">{supplier.contact || '—'}</div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="eyebrow mb-1">Telefone</div>
                  <div className="num text-muted">{supplier.phone || '—'}</div>
                </div>
                <div>
                  <div className="eyebrow mb-1">WhatsApp</div>
                  <div className="num text-muted">{supplier.whatsapp || '—'}</div>
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
              <div className="border-t border-line pt-3">
                <div className="eyebrow mb-1">Observações</div>
                <p className="leading-relaxed text-muted">{supplier.notes || 'Sem observações.'}</p>
              </div>
            </div>
          </Panel>

          <Panel title="Leitura de preço" subtitle="O que os números dizem.">
            {rows.length === 0 ? (
              <p className="text-[11.5px] leading-relaxed text-dim">
                Sem preços registrados para analisar.
              </p>
            ) : (
              <div className="space-y-3 text-[11.5px] leading-relaxed text-muted">
                <p>
                  <span className="text-cream">
                    {rows.filter((row) => row.variation > 0.05).length} de {rows.length} itens
                  </span>{' '}
                  subiram mais de 5% desde a compra anterior.
                </p>
                <p>
                  Maior alta:{' '}
                  <span className="text-cream">
                    {[...rows].sort((a, b) => b.variation - a.variation)[0]?.item.name ?? '—'}
                  </span>{' '}
                  ({(([...rows].sort((a, b) => b.variation - a.variation)[0]?.variation ?? 0) * 100).toFixed(1)}
                  %).
                </p>
                <div className="border-t border-line pt-3 text-[10.5px] text-dim">
                  A variação compara os dois últimos preços registrados neste fornecedor.
                </div>
              </div>
            )}
          </Panel>

          <div className="border-l border-line-strong bg-raised/40 px-3 py-2.5 text-[10.5px] leading-relaxed text-dim">
            Preços são atualizados apenas por recebimentos confirmados. Histórico de compras não pode
            ser sobrescrito.
          </div>
        </div>
      </div>
    </div>
  );
}
