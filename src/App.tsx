import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider, useApp } from './state/AppStore';
import { DACOT_HUB_MODULES_URL } from './lib/api';
import type { Permission } from './domain/permissions';
import { AppShell } from './components/Layout';
import { ForbiddenPage, NotFoundPage } from './pages/System';

const OverviewPage = lazy(() => import('./pages/Overview').then((module) => ({ default: module.OverviewPage })));
const InventoryPage = lazy(() => import('./pages/Inventory').then((module) => ({ default: module.InventoryPage })));
const ItemDetailPage = lazy(() => import('./pages/ItemDetail').then((module) => ({ default: module.ItemDetailPage })));
const CountsPage = lazy(() => import('./pages/Counts').then((module) => ({ default: module.CountsPage })));
const CountSessionPage = lazy(() => import('./pages/CountSession').then((module) => ({ default: module.CountSessionPage })));
const PurchasesPage = lazy(() => import('./pages/Purchases').then((module) => ({ default: module.PurchasesPage })));
const PurchaseDetailPage = lazy(() => import('./pages/PurchaseDetail').then((module) => ({ default: module.PurchaseDetailPage })));
const ReceivePurchasePage = lazy(() => import('./pages/ReceivePurchase').then((module) => ({ default: module.ReceivePurchasePage })));
const SuppliersPage = lazy(() => import('./pages/Suppliers').then((module) => ({ default: module.SuppliersPage })));
const SupplierDetailPage = lazy(() => import('./pages/SupplierDetail').then((module) => ({ default: module.SupplierDetailPage })));
const RecipesPage = lazy(() => import('./pages/Recipes').then((module) => ({ default: module.RecipesPage })));
const RecipeDetailPage = lazy(() => import('./pages/RecipeDetail').then((module) => ({ default: module.RecipeDetailPage })));
const LossesPage = lazy(() => import('./pages/Losses').then((module) => ({ default: module.LossesPage })));
const OrdersIntegrationPage = lazy(() => import('./pages/OrdersIntegration').then((module) => ({ default: module.OrdersIntegrationPage })));

function Gate({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useApp();
  if (!can(permission)) return <ForbiddenPage />;
  return (
    <Suspense fallback={<div className="grid min-h-[50vh] place-items-center bg-base px-6 text-sm text-muted">Abrindo página…</div>}>
      {children}
    </Suspense>
  );
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
  }, [pathname]);
  return null;
}

function RuntimeGate({ children }: { children: ReactNode }) {
  const { mode, ready, startupError } = useApp();
  if (mode === 'production' && !ready) {
    return <main className="grid min-h-screen place-items-center bg-base px-6 text-sm text-muted">Conectando ao DACOT Estoque…</main>;
  }
  if (mode === 'production' && startupError) {
    return (
      <main className="grid min-h-screen place-items-center bg-base px-6 text-center">
        <div className="max-w-md">
          <h1 className="text-lg font-semibold text-cream">Não foi possível abrir o Estoque</h1>
          <p className="mt-2 text-sm text-muted">{startupError}</p>
          <p className="mt-3 text-xs leading-relaxed text-dim">
            O acesso ao Estoque começa no portal do DACOT-HUB. Entre com sua conta e abra o módulo por lá.
          </p>
          <a className="btn btn-ghost mt-4" href={DACOT_HUB_MODULES_URL}>
            Entrar pelo DACOT-HUB
          </a>
          <button type="button" className="btn btn-primary mt-5" onClick={() => window.location.reload()}>
            Tentar novamente
          </button>
        </div>
      </main>
    );
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <RuntimeGate>
          <ScrollToTop />
          <Routes>
          <Route element={<AppShell />}>
            <Route
              index
              element={
                <Gate permission="overview.view">
                  <OverviewPage />
                </Gate>
              }
            />
            <Route
              path="estoque"
              element={
                <Gate permission="stock.view">
                  <InventoryPage />
                </Gate>
              }
            />
            <Route
              path="estoque/:id"
              element={
                <Gate permission="stock.view">
                  <ItemDetailPage />
                </Gate>
              }
            />
            <Route
              path="contagem"
              element={
                <Gate permission="count.view">
                  <CountsPage />
                </Gate>
              }
            />
            <Route
              path="contagem/:id"
              element={
                <Gate permission="count.view">
                  <CountSessionPage />
                </Gate>
              }
            />
            <Route
              path="compras"
              element={
                <Gate permission="purchases.view">
                  <PurchasesPage />
                </Gate>
              }
            />
            <Route
              path="compras/:id"
              element={
                <Gate permission="purchases.view">
                  <PurchaseDetailPage />
                </Gate>
              }
            />
            <Route
              path="compras/:id/receber"
              element={
                <Gate permission="purchases.receive">
                  <ReceivePurchasePage />
                </Gate>
              }
            />
            <Route
              path="fornecedores"
              element={
                <Gate permission="suppliers.view">
                  <SuppliersPage />
                </Gate>
              }
            />
            <Route
              path="fornecedores/:id"
              element={
                <Gate permission="suppliers.view">
                  <SupplierDetailPage />
                </Gate>
              }
            />
            <Route
              path="fichas"
              element={
                <Gate permission="recipes.view">
                  <RecipesPage />
                </Gate>
              }
            />
            <Route
              path="fichas/:id"
              element={
                <Gate permission="recipes.view">
                  <RecipeDetailPage />
                </Gate>
              }
            />
            <Route
              path="perdas"
              element={
                <Gate permission="losses.view">
                  <LossesPage />
                </Gate>
              }
            />
            <Route
              path="integracao-pedidos"
              element={
                <Gate permission="recipes.view">
                  <OrdersIntegrationPage />
                </Gate>
              }
            />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          </Routes>
        </RuntimeGate>
      </BrowserRouter>
    </AppProvider>
  );
}
