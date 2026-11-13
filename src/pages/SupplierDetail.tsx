import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowRight, Info, Truck } from 'lucide-react';
import { useApp } from '../state/AppStore';
import { useEnsureIngredients } from '../hooks/useEnsureIngredients';
import {
  purchaseTotalCents,
  supplierItemCount,
  supplierLastPurchase,
  supplierReceiptInsight,
  supplierRecentValue,
} from '../domain/selectors';
import type { Purchase, Supplier } from '../domain/types';
import { fetchApiInventoryPage, fetchApiPurchasePage, fetchApiSupplier } from '../lib/api';
import { date, money, moneyInput, parseMoney, parseQty, qty as fmtQty, shortDate } from '../domain/format';
import {
  BackLink,
  Drawer,
  EmptyState,
  Field,
  PageHeader,
  Panel,
  PurchaseStatusTag,
} from '../components/ui';

export function SupplierDetailPage() {
  const { id } = useParams();
  const { state, actions, can, mode } = useApp();
  const [purchaseRows, setPurchaseRows] = useState<Purchase[]>([]);
  const [purchaseHasMore, setPurchaseHasMore] = useState(false);
  const [purchaseLoading, setPurchaseLoading] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);
  const [primarySupplierItems, setPrimarySupplierItems] = useState<typeof state.items>([]);
  const [primaryItemsLoading, setPrimaryItemsLoading] = useState(false);
  const [primaryItemsError, setPrimaryItemsError] = useState<string | null>(null);
  const [resolvedSupplier, setResolvedSupplier] = useState<Supplier | null>(null);
  const [supplierLookup, setSupplierLookup] = useState<{ id: string | undefined; loading: boolean }>({
    id: undefined, loading: false,
  });
  const supplierRequestRef = useRef<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [notes, setNotes] = useState('');
  const [leadTime, setLeadTime] = useState('');
  const [minimum, setMinimum] = useState('');
  const [active, setActive] = useState(true);
  const supplier = state.suppliers.find((s) => s.id === id) ?? resolvedSupplier;
  const supplied = state.supplierItems.filter((si) => si.supplierId === id);
  const ingredientHydration = useEnsureIngredients(supplied.map((offer) => offer.itemId));

  useEffect(() => {
    if (mode !== 'production' || !id || supplierRequestRef.current === id) return;
    supplierRequestRef.current = id;
    let active = true;
    setResolvedSupplier(null);
    setSupplierLookup({ id, loading: true });
    void fetchApiSupplier(id).then((loaded) => {
      if (active) { setResolvedSupplier(loaded); actions.cacheSupplier(loaded); }
    }).catch(() => { /* The not-found state is shown after lookup completes. */ })
      .finally(() => { if (active) setSupplierLookup({ id, loading: false }); });
    return () => { active = false; };
  }, [mode, id, actions]);

  useEffect(() => {
    if (mode !== 'production' || !id) return;
    let active = true;
    setPurchaseRows([]); setPurchaseLoading(true); setPurchaseError(null);
    void fetchApiPurchasePage('all', 0, 50, id).then((page) => {
      if (active) { setPurchaseRows(page.purchases); setPurchaseHasMore(page.hasMore); }
    }).catch((error: unknown) => {
      if (active) setPurchaseError(error instanceof Error ? error.message : 'Não foi possível carregar o histórico.');
    }).finally(() => { if (active) setPurchaseLoading(false); });
    return () => { active = false; };
  }, [mode, id]);

  useEffect(() => {
    if (mode !== 'production' || !id) return;
    let active = true;
    setPrimarySupplierItems([]);
    setPrimaryItemsLoading(true);
    setPrimaryItemsError(null);
    void (async () => {
      const items: typeof state.items = [];
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const page = await fetchApiInventoryPage({ search: '', category: null, status: null,
          sort: 'name', supplierId: id }, offset, 100);
        items.push(...page.items);
        hasMore = page.hasMore;
        offset += page.items.length;
      }
      if (active) {
        setPrimarySupplierItems(items);
      }
    })().catch((error: unknown) => {
      if (active) setPrimaryItemsError(error instanceof Error
        ? error.message : 'Não foi possível carregar os insumos vinculados.');
    }).finally(() => { if (active) setPrimaryItemsLoading(false); });
    return () => { active = false; };
  }, [mode, id]);

  if (!supplier) {
    const lookupPending = mode === 'production'
      && (supplierLookup.id !== id || supplierLookup.loading);
    return (
      <div>
        <BackLink to="/fornecedores">Fornecedores</BackLink>
        <Panel>
          {lookupPending ? <div className="p-5 text-sm text-dim" role="status">Carregando fornecedor…</div> : null}
          {!lookupPending ? <EmptyState
            icon={<Info size={18} />}
            title="Fornecedor não encontrado"
            description="O cadastro pode ter sido removido ou o endereço está incorreto."
            action={
              <Link to="/fornecedores" className="btn btn-ghost">
                Voltar para fornecedores
              </Link>
            }
          /> : null}
        </Panel>
      </div>
    );
  }

  if (ingredientHydration.loading) {
    return <div><BackLink to="/fornecedores">Fornecedores</BackLink><Panel><div className="px-5 py-8 text-center text-[12px] text-dim" role="status">Carregando insumos deste fornecedor…</div></Panel></div>;
  }
  if (ingredientHydration.error) {
    return <div><BackLink to="/fornecedores">Fornecedores</BackLink><Panel><EmptyState icon={<Info size={18} />}
      title="Não foi possível carregar os insumos" description={ingredientHydration.error}
      action={<button type="button" className="btn btn-ghost" onClick={ingredientHydration.retry}>Tentar novamente</button>} /></Panel></div>;
  }

  const purchases = mode === 'production' ? purchaseRows : state.purchases
    .filter((purchase) => purchase.supplierId === supplier.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const last = supplierLastPurchase(state, supplier.id);
  const receipt = supplierReceiptInsight(state, supplier.id);
  const recent = supplierRecentValue(state, supplier.id);

  const openEdit = () => {
    setName(supplier.name);
    setContact(supplier.contact);
    setPhone(supplier.phone);
    setWhatsapp(supplier.whatsapp);
    setNotes(supplier.notes);
    setLeadTime(String(supplier.avgLeadTimeDays));
    setMinimum(moneyInput(supplier.minOrderCents));
    setActive(supplier.active !== false);
    setEditOpen(true);
  };

  const save = async () => {
    const saved = await actions.updateSupplier(supplier.id, {
      name: name.trim(), contact: contact.trim(), phone: phone.trim(), whatsapp: whatsapp.trim(),
      notes: notes.trim(), avgLeadTimeDays: Math.max(0, Math.round(parseQty(leadTime))),
      minOrderCents: parseMoney(minimum), active,
    });
    if (saved) setEditOpen(false);
  };

  const suppliedByItem = new Map(supplied.map((offer) => [offer.itemId, offer]));
  for (const item of primarySupplierItems) {
    if (!suppliedByItem.has(item.id)) suppliedByItem.set(item.id, {
      id: `primary:${supplier.id}:${item.id}`, restaurantId: item.restaurantId,
      supplierId: supplier.id, itemId: item.id, lastPriceCents: 0,
      lastPurchaseAt: null, leadTimeDays: supplier.avgLeadTimeDays,
      minOrderCents: supplier.minOrderCents,
    });
  }
  const rows = [...suppliedByItem.values()]
    .map((si) => {
      const item = state.items.find((i) => i.id === si.itemId)
        ?? primarySupplierItems.find((i) => i.id === si.itemId);
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
          <>
            {can('suppliers.manage') ? <button type="button" className="btn btn-ghost" onClick={openEdit}>Editar cadastro</button> : null}
            {can('purchases.manage') && supplier.active !== false ? (
              <Link to="/compras?novo=1" className="btn btn-ghost">
                <Truck size={14} />
                Novo pedido
              </Link>
            ) : null}
          </>
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
          <div className="mt-1.5 text-[10.5px] text-dim">{state.supplierPurchaseInsights?.[supplier.id]?.orderCount ?? purchases.length} pedidos registrados</div>
        </div>
        <div className="bg-panel px-4 py-4">
          <div className="eyebrow">Última entrega</div>
          <div className="mt-2 text-[15px] text-cream">
            {receipt?.receivedAt ? date(receipt.receivedAt) : 'sem entrega'}
          </div>
          <div className="mt-1.5 text-[10.5px] text-dim">{receipt?.purchaseCode ?? last?.purchase.code ?? '—'}</div>
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
            {primaryItemsLoading ? <div className="p-5 text-sm text-dim" role="status">Carregando itens vinculados…</div> : null}
            {primaryItemsError ? <div className="p-5 text-sm text-copper">{primaryItemsError}</div> : null}
            {!primaryItemsLoading && rows.length === 0 ? (
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
            ) : rows.length > 0 ? (
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
                          {latest ? money(latest.unitCostCents) : si.lastPurchaseAt ? money(si.lastPriceCents) : '—'}
                          {latest || si.lastPurchaseAt ? <span className="ml-0.5 text-[10px] text-dim">/{item.unit}</span> : null}
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
            ) : null}
          </Panel>

          <Panel
            title="Histórico de compras"
            subtitle="Pedidos deste fornecedor, do mais recente ao mais antigo."
            flush
            bodyClassName=""
          >
            {purchaseLoading && purchases.length === 0 ? <div className="p-5 text-sm text-dim">Carregando histórico…</div> : null}
            {purchaseError ? <div className="p-5 text-sm text-copper">{purchaseError}</div> : null}
            {!purchaseLoading && !purchaseError && purchases.length === 0 ? (
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
            {purchaseHasMore ? <div className="border-t border-line p-3 text-center"><button type="button" className="btn btn-ghost" disabled={purchaseLoading} onClick={() => {
              setPurchaseLoading(true); setPurchaseError(null);
              void fetchApiPurchasePage('all', purchaseRows.length, 50, supplier.id).then((page) => {
                setPurchaseRows((previous) => [...previous, ...page.purchases]); setPurchaseHasMore(page.hasMore);
              }).catch((error: unknown) => setPurchaseError(error instanceof Error ? error.message : 'Não foi possível carregar o histórico.'))
                .finally(() => setPurchaseLoading(false));
            }}>{purchaseLoading ? 'Carregando…' : 'Carregar mais compras'}</button></div> : null}
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
      <Drawer
        open={editOpen}
        onClose={() => setEditOpen(false)}
        eyebrow="Fornecedores / Cadastro"
        title="Editar fornecedor"
        description="Desativar preserva o histórico de compras e impede novos pedidos."
        footer={<>
          <button type="button" className="btn btn-ghost" onClick={() => setEditOpen(false)}>Cancelar</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={!name.trim()}>Salvar alterações</button>
        </>}
      >
        <div className="space-y-4">
          <Field label="Nome" htmlFor="edit-supplier-name"><input id="edit-supplier-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Contato" htmlFor="edit-supplier-contact"><input id="edit-supplier-contact" className="input" value={contact} onChange={(e) => setContact(e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Telefone" htmlFor="edit-supplier-phone"><input id="edit-supplier-phone" className="input" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
            <Field label="WhatsApp" htmlFor="edit-supplier-whatsapp"><input id="edit-supplier-whatsapp" className="input" value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Prazo médio (dias)" htmlFor="edit-supplier-lead"><input id="edit-supplier-lead" className="input num" inputMode="numeric" value={leadTime} onChange={(e) => setLeadTime(e.target.value)} /></Field>
            <Field label="Pedido mínimo" htmlFor="edit-supplier-min"><input id="edit-supplier-min" className="input num" inputMode="decimal" value={minimum} onChange={(e) => setMinimum(e.target.value)} /></Field>
          </div>
          <Field label="Observações" htmlFor="edit-supplier-notes"><textarea id="edit-supplier-notes" className="input min-h-20 resize-y" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          <label className="flex items-center gap-2 border border-line bg-[#0b0b0a] px-3 py-2.5 text-[12px] text-muted">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Fornecedor ativo
          </label>
        </div>
      </Drawer>
    </div>
  );
}
