import { Link } from 'react-router-dom';
import { LockKeyhole, FileQuestion } from 'lucide-react';
import { ROLE_LABEL } from '../domain/permissions';
import { useApp, useCurrentUser } from '../state/AppStore';
import { Panel } from '../components/ui';

export function ForbiddenPage() {
  const { state, can } = useApp();
  const user = useCurrentUser();
  const fallback = can('overview.view')
    ? { to: '/', label: 'Ir para Visão Geral' }
    : can('stock.view')
      ? { to: '/estoque', label: 'Ir para Estoque' }
      : null;

  return (
    <div className="mx-auto max-w-xl py-10">
      <div className="mb-4 flex items-center gap-2.5">
        <span className="h-px w-5 bg-copper" />
        <span className="eyebrow">Acesso restrito</span>
      </div>
      <Panel bodyClassName="px-6 py-8">
        <span className="mb-5 grid h-11 w-11 place-items-center border border-line text-copper">
          <LockKeyhole size={18} />
        </span>
        <h1 className="text-[22px] font-medium tracking-[-0.02em] text-cream">
          Seu perfil não tem acesso a esta área
        </h1>
        <p className="mt-2.5 max-w-md text-[12.5px] leading-relaxed text-muted">
          Você está autenticado como{' '}
          <span className="text-cream">{user.name}</span> ·{' '}
          <span className="text-cream">{ROLE_LABEL[user.role]}</span>. As permissões do perfil{' '}
          {ROLE_LABEL[user.role].toLowerCase()} não incluem esta tela ou ação.
        </p>
        <div className="mt-5 border border-line bg-[#0b0b0a] px-3 py-2.5 text-[11px] leading-relaxed text-dim">
          Em produção, o acesso é validado pelo backend com o vínculo do usuário ao restaurante.{' '}
          {state.restaurant.name} · perfil demonstrativo.
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          {fallback ? (
            <Link to={fallback.to} className="btn btn-primary">
              {fallback.label}
            </Link>
          ) : null}
          <span className="text-[10.5px] text-dim">
            Troque o perfil no topo da tela para simular outro nível de acesso.
          </span>
        </div>
      </Panel>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-xl py-10">
      <Panel bodyClassName="px-6 py-10 text-center">
        <span className="mx-auto mb-5 grid h-11 w-11 place-items-center border border-line text-dim">
          <FileQuestion size={18} />
        </span>
        <h1 className="text-[20px] font-medium text-cream">Página não encontrada</h1>
        <p className="mx-auto mt-2 max-w-sm text-[12px] leading-relaxed text-muted">
          O endereço acessado não existe neste módulo.
        </p>
        <Link to="/" className="btn btn-ghost mt-5">
          Voltar para Visão Geral
        </Link>
      </Panel>
    </div>
  );
}
