import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Check, CircleAlert, Link2, RefreshCw, Unplug } from 'lucide-react';
import { PageHeader, Panel } from '../components/ui';
import { useApp, useCurrentUser } from '../state/AppStore';
import { apiRequest } from '../lib/api';

type IntegrationEvent = {
  event_id: string;
  order_id: string;
  order_revision: number;
  status: string;
  reason?: string;
  processed_at?: string;
};
type ProductLink = {
  product_id: string;
  product_name: string;
  last_seen?: string;
  recipe_exists: boolean;
  recipe_active: boolean;
  consumption_enabled: boolean;
  recipe_version: number | null;
};
type IntegrationOverview = {
  active: boolean;
  enabled_at: string | null;
  processed_count: number;
  pending_count: number;
  events: IntegrationEvent[];
  exceptions: IntegrationEvent[];
};

const statusLabel: Record<string, string> = {
  processed: 'Processado', blocked: 'Aguardando correção', needs_action: 'Decisão do gestor',
  resolved: 'Resolvido', ignored_stale: 'Revisão antiga ignorada',
};

export function OrdersIntegrationPage() {
  const { mode } = useApp();
  const user = useCurrentUser();
  const canManage = user.role === 'admin' || user.role === 'manager';
  const [overview, setOverview] = useState<IntegrationOverview | null>(null);
  const [catalog, setCatalog] = useState<ProductLink[]>([]);
  const [loading, setLoading] = useState(mode === 'production');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolution, setResolution] = useState<{ eventId: string; reason: string } | null>(null);

  const load = useCallback(async () => {
    if (mode !== 'production') return;
    setError(null);
    const [nextOverview, nextCatalog] = await Promise.all([
      apiRequest<IntegrationOverview>('/integrations/orders'),
      apiRequest<ProductLink[]>('/integrations/orders/catalog'),
    ]);
    setOverview(nextOverview);
    setCatalog(nextCatalog);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'production') return;
    let current = true;
    setLoading(true);
    void load().catch((cause: unknown) => {
      if (current) setError(cause instanceof Error ? cause.message : 'Não foi possível carregar a integração.');
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [load, mode]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await action();
      await load();
      setResolution(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível concluir a ação.');
    } finally { setBusy(null); }
  };

  const toggleIntegration = () => {
    if (!overview || !canManage) return;
    const active = !overview.active;
    const accepted = window.confirm(active
      ? 'Ativar o consumo automático a partir de agora? Vendas anteriores não serão reprocessadas.'
      : 'Desativar novas baixas automáticas? O histórico e as pendências serão preservados.');
    if (!accepted) return;
    void run('activation', () => apiRequest('/integrations/orders/activation', {
      method: 'PUT', body: JSON.stringify({ active }),
    }));
  };

  if (mode !== 'production') {
    return <div>
      <PageHeader eyebrow="Integração" title="DACOT Pedidos" description="A integração real só aparece conectada no ambiente de produção. Nenhum pedido ou consumo fictício é exibido nesta tela." />
      <Panel title="Modo demonstração">
        <div className="flex items-start gap-3 text-[12px] leading-relaxed text-muted">
          <Unplug size={16} className="mt-0.5 shrink-0 text-dim" />
          O modo de demonstração não envia eventos e não altera saldos.
        </div>
      </Panel>
    </div>;
  }

  return <div>
    <PageHeader eyebrow="Integração" title="DACOT Pedidos"
      description="Vendas confirmadas para preparo usam as fichas técnicas do Estoque para registrar consumo. O atendimento continua no Pedidos, mesmo quando o Estoque estiver indisponível."
      actions={<button type="button" className="btn btn-ghost" onClick={() => void load()} disabled={loading || !!busy}><RefreshCw size={13} />Atualizar</button>} />

    {error ? <div role="alert" className="mb-4 border border-danger/30 bg-danger/5 px-4 py-3 text-[12px] text-danger">{error}</div> : null}
    {loading && !overview ? <p role="status" className="py-8 text-center text-[12px] text-dim">Carregando a integração…</p> : null}

    {overview ? <>
      <Panel title="Estado da integração" subtitle="Ativação por restaurante, desligada por padrão. A ativação define o início; vendas anteriores não entram automaticamente.">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className={`h-2 w-2 ${overview.active ? 'bg-ok' : 'border border-line-strong'}`} />
            <div>
              <div className="text-[13px] font-medium text-cream">{overview.active ? 'Ativa' : 'Desativada'}</div>
              <div className="mt-1 text-[10.5px] text-dim">{overview.enabled_at ? `Desde ${new Date(overview.enabled_at).toLocaleString('pt-BR')}` : 'Ainda não ativada neste restaurante'}</div>
            </div>
          </div>
          {canManage ? <button type="button" className={overview.active ? 'btn btn-ghost' : 'btn btn-primary'}
            onClick={toggleIntegration} disabled={!!busy}>
            {overview.active ? <><Unplug size={13} />Desativar</> : <><Link2 size={13} />Ativar integração</>}
          </button> : <span className="text-[10.5px] text-dim">Apenas gestores podem alterar a ativação.</span>}
        </div>
      </Panel>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Panel title="Pedidos processados"><div className="num text-2xl text-cream">{overview.processed_count}</div></Panel>
        <Panel title="Pendências"><div className={`num text-2xl ${overview.pending_count ? 'text-copper' : 'text-cream'}`}>{overview.pending_count}</div></Panel>
      </div>

      <Panel className="mt-4" title="Produtos e fichas técnicas"
        subtitle="O vínculo usa o ID estável do produto no Pedidos. Nome e observações não determinam ingredientes.">
        {catalog.length ? <div className="divide-y divide-line">
          {catalog.map((product) => <div key={product.product_id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <div className="text-[12.5px] text-cream">{product.product_name}</div>
              <div className="mt-1 font-mono text-[10px] text-dim">{product.product_id}</div>
            </div>
            {!product.recipe_exists
              ? <Link className="btn btn-ghost" to={`/fichas?productId=${encodeURIComponent(product.product_id)}&productName=${encodeURIComponent(product.product_name)}`}>Criar ficha <ArrowRight size={13} /></Link>
              : <Link className={`text-[10.5px] ${product.consumption_enabled ? 'text-ok' : 'text-copper'}`}
                  to={`/fichas/${encodeURIComponent(product.product_id)}`}>
                  {product.consumption_enabled ? 'Consumo habilitado' : product.recipe_active ? 'Validar composição' : 'Reativar ficha'} · v{product.recipe_version}
                </Link>}
          </div>)}
        </div> : <p className="text-[11.5px] text-dim">Os produtos aparecerão aqui depois que o Pedidos enviar eventos.</p>}
      </Panel>

      <Panel className="mt-4" title="Pendências que precisam de ação"
        subtitle="As baixas compostas são atômicas: falta de ficha ou de saldo não deixa uma parte do pedido descontada.">
        {overview.exceptions.length ? <div className="divide-y divide-line">
          {overview.exceptions.map((item) => <div key={item.event_id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[12px] text-cream">
                  <CircleAlert size={13} className="text-copper" />Pedido {item.order_id}
                  <span className="text-[10px] text-dim">r{item.order_revision} · {statusLabel[item.status] ?? item.status}</span>
                </div>
                {item.reason ? <p className="mt-1.5 max-w-3xl text-[11px] leading-relaxed text-muted">{item.reason}</p> : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {item.status === 'blocked' && canManage ? <button type="button" className="btn btn-ghost" disabled={!!busy}
                  onClick={() => void run(item.event_id, () => apiRequest(`/integrations/orders/events/${encodeURIComponent(item.event_id)}/retry`, { method: 'POST' }))}>
                  <RefreshCw size={12} />Reprocessar
                </button> : null}
                {item.status === 'needs_action' && canManage ? <button type="button" className="btn btn-ghost" onClick={() => setResolution({ eventId: item.event_id, reason: '' })}>
                  <Check size={12} />Manter consumo
                </button> : null}
              </div>
            </div>
            {resolution?.eventId === item.event_id ? <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(event) => {
              event.preventDefault();
              if (resolution.reason.trim().length < 5) return;
              void run(item.event_id, () => apiRequest(`/integrations/orders/exceptions/${encodeURIComponent(item.event_id)}/resolve`, {
                method: 'POST', body: JSON.stringify({ decision: 'keep_consumed', reason: resolution.reason }),
              }));
            }}>
              <label className="min-w-[240px] flex-1 text-[10px] uppercase tracking-[0.1em] text-dim">Justificativa do gestor
                <input className="input mt-1 h-9" minLength={5} maxLength={300} value={resolution.reason}
                  onChange={(event) => setResolution({ ...resolution, reason: event.target.value })} required />
              </label>
              <button className="btn btn-primary" type="submit" disabled={!!busy || resolution.reason.trim().length < 5}>Confirmar</button>
              <button className="btn btn-ghost" type="button" onClick={() => setResolution(null)}>Cancelar</button>
            </form> : null}
          </div>)}
        </div> : <p className="text-[11.5px] text-dim">Nenhuma pendência no momento.</p>}
      </Panel>

      <Panel className="mt-4" title="Atividade recente">
        {overview.events.length ? <div className="divide-y divide-line">
          {overview.events.slice(0, 12).map((item) => <div key={item.event_id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 first:pt-0 last:pb-0">
            <span className="text-[11.5px] text-muted">Pedido {item.order_id} <span className="text-dim">· revisão {item.order_revision}</span></span>
            <span className="text-[10.5px] text-dim">{statusLabel[item.status] ?? item.status}</span>
          </div>)}
        </div> : <p className="text-[11.5px] text-dim">A atividade aparecerá depois da primeira sincronização.</p>}
      </Panel>
    </> : null}
  </div>;
}
