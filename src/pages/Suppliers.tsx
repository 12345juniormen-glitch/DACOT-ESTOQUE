import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Plus, Search, Truck } from 'lucide-react';
import { useApp } from '../state/AppStore';
import {
  supplierItemCount,
  supplierReceiptInsight,
  supplierRecentValue,
} from '../domain/selectors';
import { money, parseMoney, parseQty, shortDate } from '../domain/format';
import { Drawer, EmptyState, Field, PageHeader, Panel } from '../components/ui';
import { fetchApiSupplierPage } from '../lib/api';

export function SuppliersPage() {
  const { state, actions, can, mode, notify } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [phone, setPhone] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [leadTime, setLeadTime] = useState('2');
  const [minOrder, setMinOrder] = useState('');
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [retryVersion, setRetryVersion] = useState(0);
  const [serverSuppliers, setServerSuppliers] = useState<{
    query: string; suppliers: typeof state.suppliers; loading: boolean; hasMore: boolean; error: string | null;
  }>({ query: '', suppliers: [], loading: false, hasMore: false, error: null });

  useEffect(() => {
    if (mode !== 'production') return;
    let current = true;
    const normalizedQuery = search.trim();
    setServerSuppliers({ query: normalizedQuery, suppliers: [], loading: true, hasMore: false, error: null });
    void fetchApiSupplierPage(normalizedQuery, 0).then((page) => {
      if (current) setServerSuppliers({ query: normalizedQuery, suppliers: page.suppliers,
        loading: false, hasMore: page.hasMore, error: null });
    }).catch((error: unknown) => {
      if (current) setServerSuppliers({ query: normalizedQuery, suppliers: [], loading: false,
        hasMore: false, error: error instanceof Error ? error.message : 'Não foi possível carregar fornecedores.' });
    });
    return () => { current = false; };
  }, [mode, search, state.suppliers.length, retryVersion]);

  const suppliers = mode === 'production'
    ? serverSuppliers.query === search.trim() ? serverSuppliers.suppliers : []
    : state.suppliers;
  const supplierLoading = mode === 'production' && serverSuppliers.query !== search.trim()
    ? true : serverSuppliers.loading;

  const submit = async () => {
    const id = await actions.createSupplier({
      name,
      contact,
      phone,
      whatsapp,
      avgLeadTimeDays: Math.max(0, Math.round(parseQty(leadTime))),
      minOrderCents: parseMoney(minOrder),
      notes,
    });
    if (id) {
      setOpen(false);
      setName('');
      setContact('');
      setPhone('');
      setWhatsapp('');
      setLeadTime('2');
      setMinOrder('');
      setNotes('');
      navigate(`/fornecedores/${id}`);
    }
  };

  return (
    <div>
      <PageHeader
        eyebrow="05 / Fornecedores"
        title="Fornecedores"
        description="Preços, prazos e compras ficam no cadastro de cada fornecedor."
        actions={
          can('suppliers.manage') ? (
            <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
              <Plus size={14} />
              Novo fornecedor
            </button>
          ) : null
        }
      />

      <Panel
        title="Cadastro de fornecedores"
        subtitle={`${suppliers.length}${serverSuppliers.hasMore && mode === 'production' ? '+' : ''} fornecedores exibidos · abra um cadastro para contatos, prazos e histórico`}
        flush
        bodyClassName=""
      >
        <div className="border-b border-line p-3">
          <label className="relative block">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim" />
            <input className="input pl-9" value={search} onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar pelo início do nome" aria-label="Buscar fornecedores pelo nome" />
          </label>
        </div>
        {supplierLoading && suppliers.length === 0 ? <div className="p-5 text-sm text-dim">Carregando fornecedores…</div> : null}
        {serverSuppliers.error && mode === 'production' && serverSuppliers.query === search.trim() ? <div className="p-5 text-sm text-copper">
          {serverSuppliers.error}<button type="button" className="ml-2 underline" onClick={() => setRetryVersion((version) => version + 1)}>Tentar novamente</button>
        </div> : null}
        {!supplierLoading && !serverSuppliers.error && suppliers.length === 0 ? (
          <EmptyState
            icon={<Truck size={18} />}
            title={search.trim() ? 'Nenhum fornecedor encontrado' : 'Ainda não há fornecedores cadastrados'}
            description={search.trim() ? 'Tente outro início de nome.' : 'Cadastre seu primeiro fornecedor para começar a registrar preços, prazos e compras.'}
            action={
              can('suppliers.manage') ? (
                <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
                  Adicionar fornecedor
                </button>
              ) : null
            }
          />
        ) : suppliers.length > 0 ? (
          <>
            <div className="scroll-x hidden md:block">
              <table className="table min-w-[520px]">
                <thead>
                  <tr>
                    <th>Fornecedor</th>
                    <th className="text-right">Comprado (90d)</th>
                    <th className="text-right">Itens</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {suppliers.map((supplier) => {
                    return (
                      <tr key={supplier.id} className="row-link">
                        <td>
                          <Link to={`/fornecedores/${supplier.id}`} className="block">
                            <div className="text-[13px] text-cream">{supplier.name}</div>
                          </Link>
                        </td>
                        <td className="text-right num text-[12px] text-cream">{money(supplierRecentValue(state, supplier.id))}</td>
                        <td className="text-right num text-[11.5px] text-muted">
                          {supplierItemCount(state, supplier.id)}
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
              {suppliers.map((supplier) => {
                const receipt = supplierReceiptInsight(state, supplier.id);
                return (
                  <Link
                    key={supplier.id}
                    to={`/fornecedores/${supplier.id}`}
                    className="block px-4 py-3.5 active:bg-raised/60"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[13.5px] text-cream">{supplier.name}</div>
                        <div className="mt-0.5 text-[10.5px] text-dim">{supplierItemCount(state, supplier.id)} itens · prazo médio {supplier.avgLeadTimeDays} dias</div>
                      </div>
                      <ArrowRight size={13} className="mt-0.5 shrink-0 text-dim" />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[10.5px] text-dim"><span>{receipt?.receivedAt ? `Última compra ${shortDate(receipt.receivedAt)}` : 'Sem compra recebida'}</span><span className="num text-muted">{money(supplierRecentValue(state, supplier.id))} em 90 dias</span></div>
                  </Link>
                );
              })}
            </div>
            {mode === 'production' && serverSuppliers.hasMore ? <div className="border-t border-line p-3 text-center">
              <button type="button" className="btn btn-ghost" disabled={supplierLoading} onClick={() => {
                setServerSuppliers((previous) => ({ ...previous, loading: true, error: null }));
                void fetchApiSupplierPage(search.trim(), suppliers.length).then((page) => {
                  setServerSuppliers((previous) => previous.query === search.trim() ? ({
                    ...previous, suppliers: [...previous.suppliers, ...page.suppliers],
                    loading: false, hasMore: page.hasMore, error: null,
                  }) : previous);
                }).catch((error: unknown) => {
                  const message = error instanceof Error ? error.message : 'Não foi possível carregar mais fornecedores.';
                  setServerSuppliers((previous) => ({ ...previous, loading: false, error: message }));
                  notify(message, 'error');
                });
              }}>{supplierLoading ? 'Carregando…' : 'Carregar mais fornecedores'}</button>
            </div> : null}
          </>
        ) : null}
      </Panel>

      <p className="mt-3 text-[10.5px] leading-relaxed text-dim">
        Contatos, pedido mínimo, itens e histórico de preços continuam disponíveis ao abrir cada fornecedor.
      </p>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Fornecedores"
        title="Novo fornecedor"
        description="Depois de cadastrar, vincule insumos na ficha de cada item ou no recebimento."
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setOpen(false)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" onClick={submit}>
              Cadastrar fornecedor
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Nome" htmlFor="sup-name">
            <input
              id="sup-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Ex.: Distribuidora Litoral"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Contato" htmlFor="sup-contact">
              <input
                id="sup-contact"
                className="input"
                value={contact}
                onChange={(event) => setContact(event.target.value)}
                placeholder="Pessoa responsável"
              />
            </Field>
            <Field label="Telefone" htmlFor="sup-phone">
              <input
                id="sup-phone"
                className="input num"
                value={phone}
                onChange={(event) => setPhone(event.target.value)}
                placeholder="(00) 0000-0000"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="WhatsApp" htmlFor="sup-wa">
              <input
                id="sup-wa"
                className="input num"
                value={whatsapp}
                onChange={(event) => setWhatsapp(event.target.value)}
                placeholder="(00) 00000-0000"
              />
            </Field>
            <Field label="Prazo médio (dias)" htmlFor="sup-lead">
              <input
                id="sup-lead"
                className="input num"
                inputMode="numeric"
                value={leadTime}
                onChange={(event) => setLeadTime(event.target.value)}
              />
            </Field>
          </div>
          <Field label="Pedido mínimo" htmlFor="sup-min" hint="Valor mínimo aceito pelo fornecedor.">
            <div className="relative">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 font-mono text-[11px] text-dim">
                R$
              </span>
              <input
                id="sup-min"
                className="input num pl-8"
                inputMode="decimal"
                value={minOrder}
                onChange={(event) => setMinOrder(event.target.value)}
                placeholder="0,00"
              />
            </div>
          </Field>
          <Field label="Observações" htmlFor="sup-notes">
            <textarea
              id="sup-notes"
              className="textarea min-h-[80px]"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Dias de entrega, condições de pagamento, contatos alternativos…"
            />
          </Field>
        </div>
      </Drawer>
    </div>
  );
}
