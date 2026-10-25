import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  BookOpen,
  Boxes,
  CheckCircle2,
  ClipboardList,
  LayoutDashboard,
  Menu,
  ShoppingCart,
  TrendingDown,
  Truck,
  X,
} from 'lucide-react';
import { ROLE_LABEL, type Permission } from '../domain/permissions';
import { monthLabel } from '../domain/format';
import { NOW } from '../domain/clock';
import { belowMinItems } from '../domain/selectors';
import { useApp, useCurrentUser } from '../state/AppStore';

const NAV = [
  {
    section: 'Operação',
    items: [
      { to: '/', label: 'Visão Geral', icon: LayoutDashboard, end: true, permission: 'overview.view' },
      { to: '/estoque', label: 'Estoque', icon: Boxes, permission: 'stock.view' },
      { to: '/contagem', label: 'Contagem', icon: ClipboardList, permission: 'count.view' },
      { to: '/compras', label: 'Compras', icon: ShoppingCart, permission: 'purchases.view' },
      { to: '/perdas', label: 'Perdas', icon: TrendingDown, permission: 'losses.view' },
    ],
  },
  {
    section: 'Cadastros',
    items: [
      { to: '/fornecedores', label: 'Fornecedores', icon: Truck, permission: 'suppliers.view' },
      { to: '/fichas', label: 'Fichas Técnicas', icon: BookOpen, permission: 'recipes.view' },
    ],
  },
] as const satisfies {
  section: string;
  items: { to: string; label: string; icon: typeof Boxes; permission: Permission; end?: boolean }[];
}[];

function Brand() {
  return (
    <div className="px-5 pt-5 pb-4">
      <div className="flex items-center gap-2.5">
        <img
          src="/favicon.png"
          alt=""
          aria-hidden="true"
          className="h-7 w-7 shrink-0 object-contain object-center"
        />
        <div>
          <div className="text-[15px] font-semibold leading-none tracking-[0.24em] text-cream">
            DACOT
          </div>
          <div className="mt-1.5 text-[9.5px] uppercase leading-none tracking-[0.14em] text-dim">
            Estoque &amp; Compras
          </div>
        </div>
      </div>
    </div>
  );
}

function TenantBlock() {
  const { state } = useApp();
  return (
    <div className="mx-4 mb-4 border border-line bg-[#0b0b0a] px-3 py-2.5">
      <div className="text-[9.5px] uppercase tracking-[0.14em] text-dim">Restaurante</div>
      <div className="mt-1 truncate text-[12.5px] font-medium text-cream">{state.restaurant.name}</div>
      <div className="mt-0.5 text-[10.5px] text-dim">{state.restaurant.city}</div>
    </div>
  );
}

function NavContent({ onNavigate }: { onNavigate?: () => void }) {
  const { can, state } = useApp();
  const alertCount = belowMinItems(state).length;

  return (
    <div className="flex h-full flex-col">
      <Brand />
      <TenantBlock />
      <nav className="flex-1 overflow-y-auto pb-4">
        {NAV.map((group) => {
          const items = group.items.filter((item) => can(item.permission));
          if (items.length === 0) return null;
          return (
            <div key={group.section} className="mb-5">
              <div className="eyebrow px-5 pb-2">{group.section}</div>
              <div>
                {items.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={'end' in item ? item.end : false}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      `nav-link ${isActive ? 'nav-link-active' : ''}`
                    }
                  >
                    <item.icon size={15} strokeWidth={1.6} />
                    <span className="flex-1">{item.label}</span>
                    {item.to === '/estoque' && alertCount > 0 ? (
                      <span className="font-mono text-[10px] text-copper">{alertCount}</span>
                    ) : null}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}

        <div className="mt-2 border-t border-line/70 pt-4">
          <div className="eyebrow px-5 pb-2">Integrações</div>
          <div className="space-y-2.5 px-5">
            <div className="flex items-start gap-2.5">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 bg-ok" />
              <div className="min-w-0">
                <div className="text-[12px] text-muted">DACOT Pedidos</div>
                <div className="mt-0.5 text-[10.5px] leading-relaxed text-dim">
                  Consumo por ORDER_DELIVERED
                </div>
              </div>
            </div>
            <div className="flex items-start gap-2.5">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 border border-line-strong" />
              <div className="min-w-0">
                <div className="text-[12px] text-dim">Análise &amp; Decisão</div>
                <div className="mt-0.5 text-[10.5px] leading-relaxed text-dim/80">
                  Estrutura preparada
                </div>
              </div>
            </div>
          </div>
        </div>
      </nav>
      <SidebarUser />
    </div>
  );
}

function SidebarUser() {
  const user = useCurrentUser();
  return (
    <div className="border-t border-line px-4 py-3.5">
      <div className="flex items-center gap-2.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center border border-line bg-raised font-mono text-[10px] text-copper">
          {user.initials}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[11.5px] text-cream">{user.name}</div>
          <div className="text-[10px] text-dim">{ROLE_LABEL[user.role]}</div>
        </div>
      </div>
    </div>
  );
}

function RoleSwitcher() {
  const { state, actions } = useApp();
  return (
    <label className="flex items-center gap-2">
      <span className="hidden text-[10px] uppercase tracking-[0.12em] text-dim xl:inline">
        Perfil
      </span>
      <select
        value={state.currentUserId}
        onChange={(event) => actions.setCurrentUserId(event.target.value)}
        className="select h-7 w-[176px] border-line bg-[#0b0b0a] px-2 py-0 text-[11px] text-muted hover:text-cream"
        aria-label="Trocar perfil de acesso (demonstração)"
      >
        {state.users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.name.split(' ')[0]} · {ROLE_LABEL[user.role]}
          </option>
        ))}
      </select>
    </label>
  );
}

function TopBar({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { state } = useApp();
  const user = useCurrentUser();
  return (
    <div className="sticky top-0 z-30 flex h-12 items-center justify-between border-b border-line bg-base px-4 sm:px-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="btn btn-quiet -ml-2 h-8 w-8 p-0 lg:hidden"
          onClick={onOpenMenu}
          aria-label="Abrir menu"
        >
          <Menu size={17} strokeWidth={1.7} />
        </button>
        <div className="flex items-center gap-2 text-[11.5px]">
          <span className="hidden text-dim sm:inline">Módulo 02</span>
          <span className="hidden h-3 w-px bg-line sm:inline-block" />
          <span className="hidden text-muted sm:inline">Estoque &amp; Compras</span>
          <span className="text-[11px] uppercase tracking-[0.16em] text-muted sm:hidden">
            DACOT
          </span>
        </div>
      </div>
      <div className="flex items-center gap-3 sm:gap-4">
        <span className="hidden font-mono text-[10px] uppercase tracking-[0.08em] text-dim xl:inline">
          {monthLabel(NOW)} · {state.restaurant.name}
        </span>
        <RoleSwitcher />
        <span
          className="grid h-7 w-7 place-items-center border border-line bg-raised font-mono text-[10px] text-copper"
          title={`${user.name} · ${ROLE_LABEL[user.role]}`}
        >
          {user.initials}
        </span>
      </div>
    </div>
  );
}

function Toast() {
  const { toast } = useApp();
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 sm:left-auto sm:right-6 sm:translate-x-0">
      <div
        className={`toast-enter flex items-start gap-2.5 border bg-raised px-4 py-3 shadow-[0_10px_30px_rgba(0,0,0,0.5)] ${
          toast.tone === 'error' ? 'border-danger/40' : 'border-line-strong'
        }`}
        role="status"
      >
        {toast.tone === 'error' ? (
          <X size={14} className="mt-0.5 shrink-0 text-danger" />
        ) : (
          <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-ok" />
        )}
        <p className="text-[12px] leading-relaxed text-cream">{toast.message}</p>
      </div>
    </div>
  );
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-base">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[240px] border-r border-line bg-[#0c0c0b] lg:block">
        <NavContent />
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Fechar menu"
            className="absolute inset-0 bg-black/75 anim-fade"
            onClick={() => setMobileOpen(false)}
          />
          <div className="relative h-full w-[272px] border-r border-line bg-[#0c0c0b] anim-slide">
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="absolute right-3 top-3 z-10 p-1.5 text-dim hover:text-cream"
              aria-label="Fechar menu"
            >
              <X size={17} />
            </button>
            <NavContent onNavigate={() => setMobileOpen(false)} />
          </div>
        </div>
      ) : null}

      <div className="lg:pl-[240px]">
        <TopBar onOpenMenu={() => setMobileOpen(true)} />
        <main className="mx-auto w-full max-w-[1460px] px-4 py-5 sm:px-6 sm:py-7 xl:px-8">
          <Outlet />
        </main>
        <footer className="mx-auto flex w-full max-w-[1460px] flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-5 text-[10.5px] text-dim sm:px-6 xl:px-8">
          <span>DACOT · Plataforma operacional para restaurantes</span>
          <span className="font-mono">Estoque &amp; Compras · v1.0 · dados de demonstração</span>
        </footer>
      </div>
      <Toast />
    </div>
  );
}
