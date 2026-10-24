import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowRight,
  BookOpen,
  ClipboardList,
  Info,
  MoveDownRight,
  MoveUpRight,
  Plus,
  Truck,
} from 'lucide-react';
import { useApp } from '../state/AppStore';
import {
  itemMovements,
  itemStatus,
  itemValueCents,
  priceVariation,
  primaryOffer,
  recipesUsingItem,
  recommendedPurchases,
  supplierOffers,
} from '../domain/selectors';
import {
  date,
  money,
  qty as fmtQty,
  shortDate,
  time,
} from '../domain/format';
import { MOVEMENT_LABEL } from '../domain/types';
import {
  BackLink,
  Dialog,
  Drawer,
  EmptyState,
  Field,
  Money,
  PageHeader,
  Panel,
  StatusTag,
  ToneNote,
} from '../components/ui';
import { PriceChart } from '../components/charts';

export function ItemDetailPage() {
  const { id } = useParams();
  const { state, actions, can } = useApp();
  const item = state.items.find((i) => i.id === id);
  const [movementOpen, setMovementOpen] = useState(false);
  const [kind, setKind] = useState<'in' | 'out' | 'adjust'>('in');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [confirmAdjust, setConfirmAdjust] = useState(false);

  if (!item) {
    return (
      <div>
        <BackLink to="/estoque">Estoque</BackLink>
        <Panel>
          <EmptyState
            icon={<Info size={18} />}
            title="Insumo não encontrado"
            description="O item pode ter sido removido ou o endereço está incorreto."
            action={
              <Link to="/estoque" className="btn btn-ghost">
                Voltar ao estoque
              </Link>
            }
          />
        </Panel>
      </div>
    );
  }

  const status = itemStatus(item);
  const movements = itemMovements(state, item.id);
  const offers = supplierOffers(state, item.id);
  const primary = primaryOffer(state, item);
  const variation = priceVariation(state, item);
  const usedIn = recipesUsingItem(state, item.id);
  const recommendation = recommendedPurchases(state).find((r) => r.item.id === item.id);
  const points = useMemo(
    () =>
      state.pricePoints
        .filter((p) => p.itemId === item.id)
        .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()),
    [state.pricePoints, item.id],
  );
  const latestPoints = points.slice(-6);
  const lastPurchase = state.purchases
    .filter(
      (p) =>
        p.status !== 'cancelled' &&
        p.receivedAt &&
        p.lines.some((l) => l.itemId === item.id && l.qtyReceived > 0),
    )
    .sort((a, b) => new Date(b.receivedAt ?? '').getTime() - new Date(a.receivedAt ?? '').getTime())[0];
  const lastPurchaseLine = lastPurchase?.lines.find((l) => l.itemId === item.id);
  const itemAudit = state.audit
    .filter((entry) => entry.entityLabel.includes(item.name))
    .slice(0, 5);
  const visibleMovements = showAll ? movements : movements.slice(0, 12);
  const cheapest = offers[0];
  const mostExpensive = offers[offers.length - 1];

  const typedQty = Math.round((Number(quantity.replace(',', '.')) || 0) * 1000) / 1000;
  const adjustPreview =
    kind === 'adjust'
      ? typedQty
      : Math.round((item.currentQty + (kind === 'in' ? typedQty : -typedQty)) * 1000) / 1000;

  const submitMovement = () => {
    if (kind === 'adjust') {
      setConfirmAdjust(true);
      return;
    }
    const ok = actions.recordMovement({
      itemId: item.id,
      kind,
      qty: Math.round((Number(quantity.replace(',', '.')) || 0) * 1000) / 1000,
      reason,
    });
    if (ok) {
      setMovementOpen(false);
      setQuantity('');
      setReason('');
    }
  };

  return (
    <div>
      <BackLink to="/estoque">Estoque</BackLink>

      <PageHeader
        eyebrow={`Estoque / ${item.category}`}
        title={item.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <StatusTag status={status} />
            <span className="text-dim">·</span>
            <span>Unidade de controle: {item.unit}</span>
            <span className="text-dim">·</span>
            <span>Fornecedor principal: {primary?.supplier.name ?? 'não definido'}</span>
          </span>
        }
        actions={
          <>
            {can('losses.manage') ? (
              <Link to={`/perdas?item=${item.id}`} className="btn btn-ghost">
                Registrar perda
              </Link>
            ) : null}
            {can('stock.adjust') ? (
              <button type="button" className="btn btn-primary" onClick={() => setMovementOpen(true)}>
                <Plus size={14} />
                Registrar movimentação
              </button>
            ) : null}
          </>
        }
      />

      <section className="panel mb-5 grid grid-cols-2 gap-px overflow-hidden bg-line md:grid-cols-3 xl:grid-cols-6">
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Estoque atual</div>
          <div className={`mt-2 num text-[21px] leading-none ${status === 'normal' ? 'text-cream' : 'text-copper'}`}>
            {fmtQty(item.currentQty, item.unit)}
          </div>
          <div className="mt-2 text-[10.5px] text-muted">
            {recommendation
              ? `acaba em ${Math.max(1, Math.round(recommendation.daysRemaining))} dias`
              : 'sem risco de ruptura'}
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Estoque mínimo</div>
          <div className="mt-2 num text-[21px] leading-none text-cream">
            {fmtQty(item.minQty, item.unit)}
          </div>
          <div className="mt-2 text-[10.5px] text-muted">
            {item.currentQty < item.minQty
              ? `${fmtQty(item.minQty - item.currentQty, item.unit)} abaixo do mínimo`
              : `${fmtQty(item.currentQty - item.minQty, item.unit)} acima do mínimo`}
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Custo atual</div>
          <div className="mt-2 num text-[21px] leading-none text-cream">
            {money(item.costCents)}
            <span className="ml-1 text-[11px] text-dim">/{item.unit}</span>
          </div>
          <div className="mt-2 text-[10.5px] text-muted">
            {variation
              ? `${variation.variation >= 0 ? '+' : ''}${(variation.variation * 100).toFixed(1)}% em 120 dias`
              : 'sem histórico suficiente'}
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Valor em estoque</div>
          <div className="mt-2 num text-[21px] leading-none text-cream">
            {money(itemValueCents(item))}
          </div>
          <div className="mt-2 text-[10.5px] text-muted">custo atual × saldo</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Fornecedor atual</div>
          <div className="mt-2 truncate text-[13px] text-cream">{primary?.supplier.name ?? '—'}</div>
          <div className="mt-2 text-[10.5px] text-muted">
            {primary ? `prazo médio ${primary.leadTimeDays} dias` : 'cadastre um fornecedor'}
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Última compra</div>
          <div className="mt-2 num text-[15px] leading-none text-cream">
            {lastPurchaseLine
              ? money(lastPurchaseLine.receivedUnitCostCents ?? lastPurchaseLine.expectedUnitCostCents)
              : '—'}
          </div>
          <div className="mt-2 text-[10.5px] text-muted">
            {lastPurchase && lastPurchaseLine
              ? `${lastPurchase.code} · ${shortDate(lastPurchase.receivedAt ?? lastPurchase.createdAt)}`
              : 'sem compras registradas'}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-5">
          <Panel
            title="Histórico de preço"
            subtitle="Preços registrados nas compras e no histórico do fornecedor."
            actions={
              variation ? (
                <span className={`num text-[11.5px] ${variation.variation > 0 ? 'text-copper' : 'text-dim'}`}>
                  {variation.variation >= 0 ? '+' : ''}
                  {(variation.variation * 100).toFixed(1)}% · 120 dias
                </span>
              ) : null
            }
          >
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="eyebrow">Preço mais recente</div>
                <div className="mt-1.5 num text-[19px] text-cream">
                  {money(offers[0]?.lastPriceCents ?? item.costCents)}
                  <span className="ml-1 text-[11px] text-dim">/{item.unit}</span>
                </div>
              </div>
              {cheapest && mostExpensive && cheapest.supplierId !== mostExpensive.supplierId ? (
                <div className="text-[10.5px] leading-relaxed text-dim">
                  Menor preço registrado: <span className="text-muted">{cheapest.supplier.name}</span>
                  <br />
                  Diferença para o maior: {' '}
                  <span className="num text-muted">
                    {money(mostExpensive.lastPriceCents - cheapest.lastPriceCents)}/{item.unit}
                  </span>
                </div>
              ) : null}
            </div>
            <PriceChart points={points} />

            <div className="mt-4 scroll-x">
              <table className="table min-w-[560px]">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Origem</th>
                    <th>Fornecedor</th>
                    <th className="text-right">Preço</th>
                    <th className="text-right">Variação</th>
                  </tr>
                </thead>
                <tbody>
                  {[...latestPoints].reverse().map((point, index, array) => {
                    const previous = array[index + 1];
                    const delta = previous
                      ? (point.unitCostCents - previous.unitCostCents) / previous.unitCostCents
                      : 0;
                    const supplier = state.suppliers.find((s) => s.id === point.supplierId);
                    return (
                      <tr key={point.id}>
                        <td className="whitespace-nowrap font-mono text-[11px] text-dim">
                          {date(point.at)}
                        </td>
                        <td className="text-[11.5px] text-muted">
                          {point.source === 'purchase' ? 'Recebimento de compra' : 'Histórico do fornecedor'}
                        </td>
                        <td className="text-[11.5px] text-muted">{supplier?.name ?? '—'}</td>
                        <td className="text-right num text-[12px] text-cream">
                          {money(point.unitCostCents)}
                        </td>
                        <td
                          className={`text-right num text-[11px] ${
                            delta > 0 ? 'text-copper' : delta < 0 ? 'text-ok' : 'text-dim'
                          }`}
                        >
                          {previous ? `${delta > 0 ? '+' : ''}${(delta * 100).toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel
            title="Comparativo de fornecedores"
            subtitle="Preço registrado, prazo e pedido mínimo por fornecedor."
            flush
            bodyClassName=""
          >
            {offers.length === 0 ? (
              <EmptyState
                icon={<Truck size={18} />}
                title="Nenhum fornecedor vinculado"
                description="Vincule fornecedores ao insumo para comparar preços e prazos na hora de comprar."
                action={
                  can('suppliers.manage') ? (
                    <Link to="/fornecedores" className="btn btn-ghost">
                      Ver fornecedores
                    </Link>
                  ) : null
                }
              />
            ) : (
              <div className="scroll-x">
                <table className="table min-w-[640px]">
                  <thead>
                    <tr>
                      <th>Fornecedor</th>
                      <th className="text-right">Último preço</th>
                      <th className="text-right">Prazo</th>
                      <th className="text-right">Pedido mínimo</th>
                      <th>Última compra</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {offers.map((offer, index) => (
                      <tr key={offer.id} className="row-link">
                        <td>
                          <Link to={`/fornecedores/${offer.supplierId}`} className="block">
                            <span className="text-[12.5px] text-cream">{offer.supplier.name}</span>
                            {index === 0 ? (
                              <span className="ml-2 text-[9.5px] uppercase tracking-[0.08em] text-copper">
                                menor preço registrado
                              </span>
                            ) : null}
                          </Link>
                        </td>
                        <td className="text-right num text-[12.5px] text-cream">
                          {money(offer.lastPriceCents)}
                          <span className="ml-0.5 text-[10px] text-dim">/{item.unit}</span>
                        </td>
                        <td className="text-right num text-[11.5px] text-muted">
                          {offer.leadTimeDays} dias
                        </td>
                        <td className="text-right num text-[11.5px] text-muted">
                          {money(offer.minOrderCents)}
                        </td>
                        <td className="text-[11px] text-dim">
                          {offer.lastPurchaseAt ? date(offer.lastPurchaseAt) : 'sem registro'}
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
            <div className="border-t border-line px-4 py-2.5 text-[10.5px] text-dim">
              O menor preço registrado não considera prazo e pedido mínimo. Compare os três antes de
              decidir.
            </div>
          </Panel>

          <Panel
            title="Movimentações"
            subtitle="Todo saldo tem origem, motivo, usuário e data."
            flush
            bodyClassName=""
            actions={
              can('stock.adjust') ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setMovementOpen(true)}
                >
                  <Plus size={12} />
                  Movimentar
                </button>
              ) : null
            }
          >
            <div className="scroll-x">
              <table className="table min-w-[780px]">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Tipo</th>
                    <th className="text-right">Quantidade</th>
                    <th>Motivo</th>
                    <th>Origem</th>
                    <th>Usuário</th>
                    <th className="text-right">Saldo após</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleMovements.map((movement) => {
                    const author = state.users.find((u) => u.id === movement.userId);
                    return (
                      <tr key={movement.id}>
                        <td className="whitespace-nowrap font-mono text-[10.5px] text-dim">
                          {shortDate(movement.occurredAt)} · {time(movement.occurredAt)}
                        </td>
                        <td>
                          <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted">
                            {movement.direction === 'in' ? (
                              <MoveUpRight size={12} className="text-ok" />
                            ) : (
                              <MoveDownRight size={12} className="text-dim" />
                            )}
                            {MOVEMENT_LABEL[movement.type]}
                          </span>
                        </td>
                        <td
                          className={`text-right num text-[12px] ${
                            movement.direction === 'in' ? 'text-ok' : 'text-cream'
                          }`}
                        >
                          {movement.direction === 'in' ? '+' : '−'}
                          {fmtQty(movement.qty, movement.unit)}
                        </td>
                        <td className="max-w-[220px] text-[11.5px] text-muted">{movement.reason}</td>
                        <td className="max-w-[180px] truncate text-[10.5px] text-dim">
                          {movement.origin}
                        </td>
                        <td className="text-[11px] text-dim">
                          {author?.name ?? (movement.userId === 'u-sistema' ? 'DACOT Pedidos' : '—')}
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
            {movements.length > 12 ? (
              <div className="border-t border-line px-4 py-2.5">
                <button
                  type="button"
                  className="text-[11px] text-dim hover:text-cream"
                  onClick={() => setShowAll((prev) => !prev)}
                >
                  {showAll ? 'Mostrar menos' : `Mostrar todas as ${movements.length} movimentações`}
                </button>
              </div>
            ) : null}
          </Panel>

          <Panel
            title="Fichas técnicas que usam este insumo"
            subtitle="O custo do prato é recalculado com o custo atual deste item."
            flush
            bodyClassName=""
          >
            {usedIn.length === 0 ? (
              <EmptyState
                icon={<BookOpen size={18} />}
                title="Nenhuma ficha usa este insumo"
                description="Vincule o insumo a uma ficha técnica para calcular o custo dos pratos vendidos."
                action={
                  can('recipes.view') ? (
                    <Link to="/fichas" className="btn btn-ghost">
                      Ver fichas técnicas
                    </Link>
                  ) : null
                }
              />
            ) : (
              <div className="divide-y divide-line">
                {usedIn.map((recipe) => {
                  const ingredient = recipe.ingredients.find((i) => i.itemId === item.id);
                  return (
                    <Link
                      key={recipe.id}
                      to={`/fichas/${recipe.id}`}
                      className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-raised/50"
                    >
                      <div>
                        <div className="text-[12.5px] text-cream">{recipe.name}</div>
                        <div className="mt-0.5 text-[10.5px] text-dim">
                          {ingredient
                            ? `${fmtQty(ingredient.qty, ingredient.unit)} por porção`
                            : '—'}
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <div className="num text-[11.5px] text-muted">
                            {money(recipe.salePriceCents)}
                          </div>
                          <div className="text-[9.5px] uppercase tracking-[0.08em] text-dim">
                            venda
                          </div>
                        </div>
                        <ArrowRight size={13} className="text-dim" />
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </Panel>
        </div>

        <div className="flex flex-col gap-5">
          <Panel
            title="Decisão de compra"
            subtitle="Cálculo transparente com consumo recente."
          >
            {recommendation ? (
              <>
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <span className="text-[11px] text-muted">Quantidade sugerida</span>
                  <span className="num text-[20px] text-copper">
                    {fmtQty(recommendation.recommendedQty, item.unit)}
                  </span>
                </div>
                <div className="divide-y divide-line border-y border-line text-[11.5px]">
                  <div className="flex items-center justify-between py-2">
                    <span className="text-muted">Consumo médio</span>
                    <span className="num text-cream">
                      {fmtQty(recommendation.avgDaily)} {item.unit}/dia
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span className="text-muted">Dias até reposição</span>
                    <span className="num text-cream">{recommendation.coverageDays} dias</span>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span className="text-muted">Estoque de segurança</span>
                    <span className="num text-cream">
                      {fmtQty(recommendation.safetyQty, item.unit)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span className="text-muted">Estoque atual</span>
                    <span className="num text-cream">− {fmtQty(item.currentQty, item.unit)}</span>
                  </div>
                  <div className="flex items-center justify-between py-2">
                    <span className="text-muted">Custo estimado</span>
                    <span className="num text-cream">{money(recommendation.estimatedCostCents)}</span>
                  </div>
                </div>
                <p className="mt-2.5 font-mono text-[9.5px] leading-relaxed text-dim">
                  {recommendation.formula}
                </p>
                <p className="mt-2 text-[10.5px] text-dim">
                  Próxima compra em {Math.max(1, Math.round(recommendation.daysRemaining))} dias · prazo
                  do fornecedor {recommendation.leadTimeDays} dias.
                </p>
                {can('purchases.manage') ? (
                  <Link to="/compras?novo=1" className="btn btn-ghost mt-3 w-full">
                    <ClipboardList size={13} />
                    Planejar pedido de compra
                  </Link>
                ) : null}
              </>
            ) : (
              <>
                <p className="text-[12px] leading-relaxed text-muted">
                  O estoque atual cobre o consumo previsto. Não há reposição recomendada hoje.
                </p>
                <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                  <span className="text-[11px] text-dim">Cobertura estimada</span>
                  <span className="num text-[13px] text-cream">
                    {item.currentQty <= 0 ? 'sem saldo' : 'estável'}
                  </span>
                </div>
              </>
            )}
          </Panel>

          <Panel title="Últimos preços por fornecedor" flush bodyClassName="">
            <div className="divide-y divide-line">
              {offers.slice(0, 3).map((offer) => (
                <div key={offer.id} className="flex items-center justify-between px-4 py-3">
                  <div className="min-w-0">
                    <div className="truncate text-[11.5px] text-muted">{offer.supplier.name}</div>
                    <div className="mt-0.5 text-[10px] text-dim">
                      prazo {offer.leadTimeDays}d · última compra{' '}
                      {offer.lastPurchaseAt ? shortDate(offer.lastPurchaseAt) : '—'}
                    </div>
                  </div>
                  <span className="num ml-3 shrink-0 text-[12px] text-cream">
                    {money(offer.lastPriceCents)}
                  </span>
                </div>
              ))}
            </div>
            {primary ? (
              <div className="border-t border-line px-4 py-2.5">
                <Link
                  to={`/fornecedores/${primary.supplierId}`}
                  className="flex items-center justify-between text-[11px] text-copper hover:text-copper-hi"
                >
                  Abrir fornecedor atual
                  <ArrowRight size={12} />
                </Link>
              </div>
            ) : null}
          </Panel>

          <Panel title="Auditoria do insumo" subtitle="Alterações que afetam saldo ou custo." flush bodyClassName="">
            {itemAudit.length === 0 ? (
              <div className="px-4 py-4 text-[11px] leading-relaxed text-dim">
                Nenhum evento de auditoria registrado para este insumo. Ajustes, perdas e
                recebimentos aparecem aqui.
              </div>
            ) : (
              <div className="divide-y divide-line">
                {itemAudit.map((entry) => {
                  const author = state.users.find((u) => u.id === entry.userId);
                  return (
                    <div key={entry.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-cream">{author?.name ?? 'Sistema'}</span>
                        <span className="font-mono text-[9.5px] text-dim">
                          {shortDate(entry.at)} {time(entry.at)}
                        </span>
                      </div>
                      <div className="mt-1 text-[10.5px] leading-relaxed text-muted">
                        {entry.before ? `${entry.before} → ` : ''}
                        <span className="text-muted">{entry.after}</span>
                      </div>
                      <div className="mt-0.5 text-[9.5px] text-dim">{entry.reason}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          <ToneNote>
            <span className="text-muted">Estoque teórico × real.</span> O saldo deste insumo considera
            apenas movimentações registradas. A contagem física é comparada a ele e gera ajustes
            auditáveis.
          </ToneNote>
        </div>
      </div>

      <Drawer
        open={movementOpen}
        onClose={() => setMovementOpen(false)}
        eyebrow={item.name}
        title="Registrar movimentação"
        description="A alteração entra no histórico com o saldo resultante."
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setMovementOpen(false)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" onClick={submitMovement}>
              Confirmar movimentação
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-px border border-line bg-line">
            {(
              [
                ['in', 'Entrada'],
                ['out', 'Saída'],
                ['adjust', 'Ajuste'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setKind(value)}
                className={`px-2 py-2.5 text-[11.5px] transition-colors ${
                  kind === value ? 'bg-raised text-cream' : 'bg-panel text-dim hover:text-muted'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field
              label={kind === 'adjust' ? 'Saldo contado' : 'Quantidade'}
              htmlFor="mov-qty"
              hint={
                kind === 'adjust'
                  ? `Saldo atual: ${fmtQty(item.currentQty, item.unit)}`
                  : `Disponível: ${fmtQty(item.currentQty, item.unit)}`
              }
            >
              <div className="relative">
                <input
                  id="mov-qty"
                  className="input num pr-10"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  placeholder="0"
                />
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[11px] text-dim">
                  {item.unit}
                </span>
              </div>
            </Field>
            <Field label="Resultado" hint="Saldo após a movimentação">
              <div className="flex h-9 items-center justify-between border border-line bg-[#0b0b0a] px-2.5">
                <span className={`num text-[13px] ${adjustPreview < 0 ? 'text-danger' : 'text-cream'}`}>
                  {fmtQty(adjustPreview, item.unit)}
                </span>
                {kind !== 'adjust' && Number(quantity.replace(',', '.')) > 0 ? (
                  <Money
                    cents={Math.round(Number(quantity.replace(',', '.')) * item.costCents)}
                    className="text-[10.5px] text-dim"
                  />
                ) : null}
              </div>
            </Field>
          </div>

          <Field label="Motivo" htmlFor="mov-reason" hint="Obrigatório para auditoria.">
            <input
              id="mov-reason"
              className="input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={
                kind === 'in'
                  ? 'Ex.: compra avulsa, devolução'
                  : kind === 'out'
                    ? 'Ex.: uso interno, transferência'
                    : 'Ex.: contagem física, correção de cadastro'
              }
            />
          </Field>

          <div className="border border-line bg-[#0b0b0a] px-3 py-2.5 text-[10.5px] leading-relaxed text-dim">
            <span className="text-muted">{item.name}</span> · {kind === 'in' ? 'entrada' : kind === 'out' ? 'saída' : 'ajuste de inventário'}.
            O saldo anterior é preservado como histórico; nada é sobrescrito.
          </div>
        </div>
      </Drawer>

      <Dialog
        open={confirmAdjust}
        onClose={() => setConfirmAdjust(false)}
        title="Confirmar ajuste de inventário"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmAdjust(false)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                const ok = actions.recordMovement({
                  itemId: item.id,
                  kind: 'adjust',
                  qty: Math.round((Number(quantity.replace(',', '.')) || 0) * 1000) / 1000,
                  reason,
                });
                if (ok) {
                  setConfirmAdjust(false);
                  setMovementOpen(false);
                  setQuantity('');
                  setReason('');
                }
              }}
            >
              Ajustar estoque
            </button>
          </>
        }
      >
        O saldo de <span className="text-cream">{item.name}</span> passará de{' '}
        <span className="num text-cream">{fmtQty(item.currentQty, item.unit)}</span> para{' '}
        <span className="num text-cream">{fmtQty(adjustPreview, item.unit)}</span>. Um ajuste de
        inventário será registrado com seu usuário e o motivo informado.
      </Dialog>
    </div>
  );
}
