import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Info, Lock, PackageCheck } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { useEnsureIngredients } from '../hooks/useEnsureIngredients';
import { fetchApiPurchase, fetchApiSupplier, listApiPurchaseReceipts, pendingApiReceiptPayload,
  type PurchaseReceiptRecord } from '../lib/api';
import { purchaseTotalCents } from '../domain/selectors';
import { parsePendingReceiptLines, receiptHistoryMatchesPurchase, receiptQuantityDelta,
  summarizePurchaseReceipts } from '../domain/receipts';
import { money, moneyInput, parseMoneyInput, qty as fmtQty } from '../domain/format';
import {
  BackLink,
  EmptyState,
  Field,
  PageHeader,
  Panel,
  PurchaseStatusTag,
  ToneNote,
} from '../components/ui';

export function ReceivePurchasePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { state, actions, can, mode } = useApp();
  const purchase = state.purchases.find((p) => p.id === id);
  const ingredientHydration = useEnsureIngredients(purchase?.lines.map((line) => line.itemId) ?? []);
  const [confirming, setConfirming] = useState(false);
  const [receiptHistory, setReceiptHistory] = useState<PurchaseReceiptRecord[]>([]);
  const [receiptHistoryLoading, setReceiptHistoryLoading] = useState(mode === 'production');
  const [receiptHistoryError, setReceiptHistoryError] = useState<string | null>(null);
  const [receiptHistoryRetry, setReceiptHistoryRetry] = useState(0);
  const [purchaseLookup, setPurchaseLookup] = useState<{ id: string | undefined; loading: boolean }>({
    id: undefined, loading: false,
  });

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
    if (mode !== 'production' || !id || !purchase) return;
    let active = true;
    setReceiptHistoryLoading(true);
    setReceiptHistoryError(null);
    listApiPurchaseReceipts(id).then((records) => {
      if (active) setReceiptHistory(records);
    }).catch((error: unknown) => {
      if (active) setReceiptHistoryError(error instanceof Error ? error.message : 'Falha ao consultar preços recebidos.');
    }).finally(() => {
      if (active) setReceiptHistoryLoading(false);
    });
    return () => { active = false; };
  }, [mode, id, purchase?.version, receiptHistoryRetry]);

  useEffect(() => {
    if (mode !== 'production' || !purchase?.supplierId
        || state.suppliers.some((supplier) => supplier.id === purchase.supplierId)) return;
    let active = true;
    void fetchApiSupplier(purchase.supplierId).then((supplier) => {
      if (active) actions.cacheSupplier(supplier);
    }).catch(() => { /* The order can still be received if the supplier record is unavailable. */ });
    return () => { active = false; };
  }, [mode, purchase?.supplierId, state.suppliers, actions]);

  const initial = useMemo(() => {
    if (!purchase) return { qty: {} as Record<string, string>, price: {} as Record<string, string> };
    const qty = Object.fromEntries(
        purchase.lines.map((line) => [
          line.id,
          line.qtyReceived >= line.qtyOrdered - 0.001
            ? '0'
            : String(Math.round((line.qtyOrdered - line.qtyReceived) * 1000) / 1000).replace('.', ','),
        ]),
      ) as Record<string, string>;
    const price = Object.fromEntries(
        purchase.lines.map((line) => [
          line.id,
          '',
        ]),
      ) as Record<string, string>;
    const pending = pendingApiReceiptPayload(purchase);
    if (pending) {
      const pendingLines = parsePendingReceiptLines(pending);
      if (pendingLines) {
        for (const line of purchase.lines) qty[line.id] = '0';
        for (const receiptLine of pendingLines) {
          if (!Object.hasOwn(qty, receiptLine.line_id)) continue;
          qty[receiptLine.line_id] = String(receiptLine.quantity_received).replace('.', ',');
          price[receiptLine.line_id] = moneyInput(receiptLine.unit_cost_cents);
        }
      }
    }
    return { qty, price };
  }, [purchase?.id, purchase?.version, purchase?.updatedAt]);

  const [qtyTexts, setQtyTexts] = useState<Record<string, string>>(initial.qty);
  const [priceTexts, setPriceTexts] = useState<Record<string, string>>(initial.price);

  useEffect(() => {
    setQtyTexts(initial.qty);
    setPriceTexts(initial.price);
  }, [initial]);

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
            description="Não foi possível localizar este pedido para recebimento."
            action={<Link to="/compras" className="btn btn-ghost">Voltar para compras</Link>}
          /> : null}
          {mode !== 'production' ? <EmptyState
            icon={<Info size={18} />}
            title="Pedido não encontrado"
            description="Não foi possível localizar este pedido para recebimento."
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
  const expectedTotal = purchaseTotalCents(purchase);
  const receiptSummary = summarizePurchaseReceipts(receiptHistory);
  const receiptHistoryMatches = receiptHistoryMatchesPurchase(receiptHistory, purchase.lines);
  const hasPriorReceipts = purchase.lines.some((line) => line.qtyReceived > 0);
  const rows = purchase.lines.map((line) => {
    const item = state.items.find((i) => i.id === line.itemId);
    const remaining = Math.max(0, line.qtyOrdered - line.qtyReceived);
    const quantity = receiptQuantityDelta(qtyTexts[line.id] ?? '0', remaining);
    const delta = quantity.quantity;
    const parsedPrice = parseMoneyInput(priceTexts[line.id] ?? '');
    const price = parsedPrice ?? line.expectedUnitCostCents;
    const newTotal = line.qtyReceived + delta;
    const priceDelta = line.expectedUnitCostCents
      ? (price - line.expectedUnitCostCents) / line.expectedUnitCostCents
      : 0;
    const invalidPrice = delta > 0 && (parsedPrice === null || parsedPrice < 0);
    const priorReceiptTotal = mode === 'production'
      ? (receiptHistoryMatches ? receiptSummary[line.id]?.totalCents ?? 0 : null)
      : line.qtyReceived > 0
        ? Math.round(line.qtyReceived * (line.receivedUnitCostCents ?? line.expectedUnitCostCents)) : 0;
    return { line, item, remaining, delta, price, priceDelta,
      invalidQuantity: quantity.invalid, newTotal, invalidPrice, priorReceiptTotal };
  });

  const deliveryTotal = rows.reduce((sum, row) => sum + Math.round(row.delta * row.price), 0);
  const finalTotal = rows.every((row) => row.priorReceiptTotal !== null)
    ? rows.reduce((sum, row) => sum + (row.priorReceiptTotal ?? 0) + Math.round(row.delta * row.price), 0)
    : null;
  const priceImpact = rows.reduce((sum, row) => {
    if (row.delta <= 0) return sum;
    return sum + Math.round(row.delta * (row.price - row.line.expectedUnitCostCents));
  }, 0);
  const touched = rows.filter((row) => row.delta > 0).length;
  const invalidPriceCount = rows.filter((row) => row.invalidPrice).length;
  const invalidQuantityCount = rows.filter((row) => row.invalidQuantity).length;
  const completeCount = rows.filter((row) => row.newTotal >= row.line.qtyOrdered - 0.001).length;

  const submit = async () => {
    if (!can('purchases.receive')) return;
    if (rows.some((row) => row.invalidPrice || row.invalidQuantity)) return;
    setConfirming(true);
    try {
      const ok = await actions.receivePurchase(
        purchase.id,
        purchase.lines.map((line) => ({
          lineId: line.id,
          qtyReceived: rows.find((row) => row.line.id === line.id)?.newTotal ?? line.qtyReceived,
          unitCostCents: parseMoneyInput(priceTexts[line.id] ?? '') ?? line.expectedUnitCostCents,
        })),
      );
      if (ok) navigate(`/compras/${purchase.id}`);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div>
      <BackLink to={`/compras/${purchase.id}`}>Pedido {purchase.code}</BackLink>

      <PageHeader
        eyebrow={`Recebimento / ${purchase.code}`}
        title="Conferir recebimento"
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <PurchaseStatusTag status={purchase.status} />
            <span className="text-dim">·</span>
            <span>{supplier?.name ?? '—'}</span>
            <span className="text-dim">·</span>
            <span>total pedido {money(expectedTotal)}</span>
          </span>
        }
        actions={
          can('purchases.receive') ? (
            <button
              type="button"
              className="btn btn-primary btn-touch"
              onClick={submit}
              disabled={confirming || touched === 0 || invalidPriceCount > 0 || invalidQuantityCount > 0}
            >
              <PackageCheck size={15} />
              Confirmar recebimento
            </button>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] text-dim">
              <Lock size={12} /> Recebimento restrito
            </span>
          )
        }
      />

      <section className="panel mb-5 grid grid-cols-2 gap-px overflow-hidden bg-line md:grid-cols-4">
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Total desta entrega</div>
          <div className="mt-2 num text-[20px] text-cream">{money(deliveryTotal)}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">quantidade agora × preço real</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Total conferido</div>
          <div className="mt-2 num text-[20px] text-cream">{finalTotal === null ? '—' : money(finalTotal)}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">
            {completeCount} de {rows.length} itens completos
          </div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Impacto de preço</div>
          <div className={`mt-2 num text-[20px] ${priceImpact > 0 ? 'text-copper' : 'text-cream'}`}>
            {money(priceImpact)}
          </div>
          <div className="mt-1.5 text-[10.5px] text-dim">diferença vs. preço esperado</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Itens recebidos agora</div>
          <div className="mt-2 num text-[20px] text-cream">{touched}</div>
          <div className="mt-1.5 text-[10.5px] text-dim">recebimento parcial permitido</div>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Panel
          title="Conferência da entrega"
          subtitle="Informe o que chegou e o preço real da nota. Deixe zero no que não chegou."
          flush
          bodyClassName=""
        >
          <div className="scroll-x hidden md:block">
            <table className="table min-w-[860px]">
              <thead>
                <tr>
                  <th>Insumo</th>
                  <th className="text-right">Solicitado</th>
                  <th className="text-right">Já recebido</th>
                  <th className="text-right">Receber agora</th>
                  <th className="text-right">Preço esperado</th>
                  <th className="text-right">Preço real</th>
                  <th className="text-right">Subtotal</th>
                </tr>
              </thead>
              <tbody>
        {rows.map(({ line, item, remaining, delta, price, priceDelta, invalidPrice,
          invalidQuantity, priorReceiptTotal }) => {
                  if (!item) return null;
                  const unit = line.unit ?? item.unit;
                  return (
                    <tr key={line.id}>
                      <td>
                        <div className="text-[12.5px] text-cream">{item.name}</div>
                        <div className="mt-0.5 text-[10px] uppercase tracking-[0.06em] text-dim">
                          {item.category} · compra em {unit} · estoque em {item.unit}
                        </div>
                      </td>
                      <td className="text-right num text-[11.5px] text-muted">
                        {fmtQty(line.qtyOrdered, unit)}
                      </td>
                      <td className="text-right num text-[11.5px] text-muted">
                        {line.qtyReceived > 0 ? fmtQty(line.qtyReceived, unit) : '—'}
                      </td>
                      <td className="text-right">
                        <div className="relative ml-auto w-[112px]">
                          <input
                            className={`input num h-8 pr-8 text-right text-[12.5px] ${invalidQuantity ? 'border-danger' : ''}`}
                            inputMode="decimal"
                            value={qtyTexts[line.id] ?? ''}
                            onChange={(event) =>
                              setQtyTexts((prev) => ({ ...prev, [line.id]: event.target.value }))
                            }
                            disabled={remaining <= 0}
                            aria-label={`Quantidade recebida de ${item.name}`}
                            aria-invalid={invalidQuantity}
                          />
                          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[9.5px] text-dim">
                            {unit}
                          </span>
                        </div>
                        <div className="mt-1 text-[9.5px] text-dim">
                          {remaining > 0 ? `pendente ${fmtQty(remaining, unit)}` : 'completo'}
                        </div>
                        {invalidQuantity ? <div className="mt-1 text-[9.5px] text-danger">
                          Informe até {fmtQty(remaining, unit)} e use no máximo 3 casas decimais
                        </div> : null}
                      </td>
                      <td className="text-right num text-[11.5px] text-muted">
                        {money(line.expectedUnitCostCents)}/{unit}
                      </td>
                      <td className="text-right">
                        <div className="relative ml-auto w-[106px]">
                          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 font-mono text-[9.5px] text-dim">
                            R$
                          </span>
                          <input
                            className={`input num h-8 pl-7 text-right text-[12px] ${invalidPrice ? 'border-copper' : ''}`}
                            inputMode="decimal"
                            value={priceTexts[line.id] ?? ''}
                            onChange={(event) =>
                              setPriceTexts((prev) => ({ ...prev, [line.id]: event.target.value }))
                            }
                            aria-label={`Preço real de ${item.name}`}
                            aria-invalid={invalidPrice}
                          />
                        </div>
                        {invalidPrice ? <div className="mt-1 text-[9.5px] text-copper">Informe um preço válido</div> : null}
                        {!invalidPrice && Math.abs(priceDelta) > 0.0001 ? (
                          <div
                            className={`mt-1 num text-[9.5px] ${
                              priceDelta > 0 ? 'text-copper' : 'text-ok'
                            }`}
                          >
                            {priceDelta > 0 ? '+' : ''}
                            {(priceDelta * 100).toFixed(1)}%
                          </div>
                        ) : null}
                      </td>
                      <td className="text-right num text-[12px] text-cream">
                        {priorReceiptTotal === null ? '—' : money(priorReceiptTotal + Math.round(delta * price))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="divide-y divide-line md:hidden">
            {rows.map(({ line, item, remaining, delta, price, priceDelta, invalidPrice,
              invalidQuantity, priorReceiptTotal }) => {
              if (!item) return null;
              const unit = line.unit ?? item.unit;
              return (
                <div key={line.id} className="px-4 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-[13px] text-cream">{item.name}</div>
                      <div className="mt-0.5 text-[10px] uppercase tracking-[0.06em] text-dim">
                        solicitado {fmtQty(line.qtyOrdered, unit)} {unit} · recebido{' '}
                        {fmtQty(line.qtyReceived, unit)} {unit}
                      </div>
                    </div>
                    <span className="num text-[12px] text-cream">{priorReceiptTotal === null ? '—'
                      : money(priorReceiptTotal + Math.round(delta * price))}</span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-2 gap-2">
                    <div>
                      <div className="mb-1 text-[9.5px] uppercase tracking-[0.08em] text-dim">
                        Receber agora
                      </div>
                      <div className="relative">
                        <input
                          className={`input num h-11 pr-8 text-[16px] ${invalidQuantity ? 'border-danger' : ''}`}
                          inputMode="decimal"
                          value={qtyTexts[line.id] ?? ''}
                          onChange={(event) =>
                            setQtyTexts((prev) => ({ ...prev, [line.id]: event.target.value }))
                          }
                          disabled={remaining <= 0}
                          aria-label={`Quantidade recebida de ${item.name}`}
                          aria-invalid={invalidQuantity}
                        />
                        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-dim">
                          {unit}
                        </span>
                      </div>
                    </div>
                    <div>
                      <div className="mb-1 text-[9.5px] uppercase tracking-[0.08em] text-dim">
                        Preço real
                      </div>
                      <div className="relative">
                        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-dim">
                          R$
                        </span>
                        <input
                          className={`input num h-11 pl-8 text-[14px] ${invalidPrice ? 'border-copper' : ''}`}
                          inputMode="decimal"
                          value={priceTexts[line.id] ?? ''}
                          onChange={(event) =>
                            setPriceTexts((prev) => ({ ...prev, [line.id]: event.target.value }))
                          }
                          aria-label={`Preço real de ${item.name}`}
                          aria-invalid={invalidPrice}
                        />
                      </div>
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[10px] text-dim">
                    <span>
                      esperado {money(line.expectedUnitCostCents)}/{unit} ·{' '}
                      {remaining > 0 ? `pendente ${fmtQty(remaining, unit)}` : 'completo'}
                    </span>
                    {invalidPrice ? <span className="text-copper">Informe um preço válido</span> : null}
                    {invalidQuantity ? <span className="text-danger">Até {fmtQty(remaining, unit)} · máximo 3 casas decimais</span> : null}
                    {!invalidPrice && Math.abs(priceDelta) > 0.0001 ? (
                      <span className={priceDelta > 0 ? 'text-copper' : 'text-ok'}>
                        {priceDelta > 0 ? '+' : ''}
                        {(priceDelta * 100).toFixed(1)}%
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="border-t border-line px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-dim">Total conferido do pedido</span>
              <span className="num text-[15px] text-cream">{finalTotal === null ? '—' : money(finalTotal)}</span>
            </div>
            {receiptHistoryError ? <div className="mt-2 flex items-center justify-between gap-2 text-[10.5px] text-copper" role="alert"><span>Não foi possível consultar o histórico; o total consolidado fica indisponível.</span><button type="button" className="underline underline-offset-2" onClick={() => setReceiptHistoryRetry((value) => value + 1)}>Tentar novamente</button></div> : null}
            {!receiptHistoryLoading && !receiptHistoryError && hasPriorReceipts && !receiptHistoryMatches ? <div className="mt-2 text-[10.5px] text-copper" role="alert">O histórico de preços não confere com as quantidades já recebidas; o total consolidado fica indisponível.</div> : null}
            {invalidQuantityCount > 0 ? <div className="mt-2 text-[10.5px] text-danger">Corrija as quantidades destacadas: máximo do saldo pendente e 3 casas decimais.</div> : null}
            {invalidPriceCount > 0 ? <div className="mt-2 text-[10.5px] text-copper">Informe o preço real para cada item recebido antes de confirmar.</div> : null}
          </div>
        </Panel>

        <div className="flex flex-col gap-5">
          <Panel title="Efeito no estoque">
            <ul className="space-y-2.5 text-[11.5px] leading-relaxed text-muted">
              <li>· Entrada registrada para cada item conferido.</li>
              <li>· Custo atual atualizado pelo preço real informado.</li>
              <li>· Preço e fornecedor gravados no histórico do insumo.</li>
              <li>· Snapshot do custo das fichas técnicas afetadas.</li>
              <li>· Movimentação auditável com seu usuário e data.</li>
            </ul>
            <div className="mt-4 border-t border-line pt-3">
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-dim">Diferença de quantidade</span>
                <span className="num text-muted">
                  {rows.reduce((sum, row) => sum + row.delta, 0) > 0
                    ? `${rows.filter((r) => r.delta > 0).length} itens`
                    : '—'}
                </span>
              </div>
            </div>
          </Panel>

          {purchase.status === 'partial' ? (
            <ToneNote tone="warn">
              Este pedido já teve recebimento parcial. O saldo anterior foi preservado e o novo
              recebimento é somado ao que já entrou no estoque.
            </ToneNote>
          ) : (
            <ToneNote>
              Receber menos do que o solicitado é permitido. O pedido fica como parcialmente
              recebido até a conclusão do saldo.
            </ToneNote>
          )}

          <div className="flex flex-col gap-2">
            <Field label="Pedido" hint={`Fornecedor: ${supplier?.name ?? '—'}`}>
              <div className="flex h-9 items-center justify-between border border-line bg-[#0b0b0a] px-2.5">
                <span className="num text-[12px] text-cream">{purchase.code}</span>
                <Link
                  to={`/compras/${purchase.id}`}
                  className="flex items-center gap-1 text-[10.5px] text-dim hover:text-cream"
                >
                  <ArrowLeft size={11} /> detalhe
                </Link>
              </div>
            </Field>
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 z-20 mt-4 flex flex-wrap items-center justify-between gap-3 border border-line bg-panel px-4 py-3">
        <div className="text-[10.5px] text-dim">
          <span className="text-muted">{touched}</span> itens com quantidade · impacto de preço{' '}
          <span className={`num ${priceImpact > 0 ? 'text-copper' : 'text-muted'}`}>
            {money(priceImpact)}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-primary btn-touch w-full sm:w-auto"
          onClick={submit}
          disabled={confirming || touched === 0 || invalidPriceCount > 0 || invalidQuantityCount > 0 || !can('purchases.receive')}
        >
          <PackageCheck size={15} />
          Confirmar recebimento
        </button>
      </div>
    </div>
  );
}
