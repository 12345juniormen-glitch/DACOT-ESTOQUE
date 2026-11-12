import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider, useApp } from './state/AppStore';
import type { Permission } from './domain/permissions';
import { AppShell } from './components/Layout';
import { OverviewPage } from './pages/Overview';
import { InventoryPage } from './pages/Inventory';
import { ItemDetailPage } from './pages/ItemDetail';
import { CountsPage } from './pages/Counts';
import { CountSessionPage } from './pages/CountSession';
import { PurchasesPage } from './pages/Purchases';
import { PurchaseDetailPage } from './pages/PurchaseDetail';
import { ReceivePurchasePage } from './pages/ReceivePurchase';
import { SuppliersPage } from './pages/Suppliers';
import { SupplierDetailPage } from './pages/SupplierDetail';
import { RecipesPage } from './pages/Recipes';
import { RecipeDetailPage } from './pages/RecipeDetail';
import { LossesPage } from './pages/Losses';
import { ForbiddenPage, NotFoundPage } from './pages/System';

function Gate({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useApp();
  if (!can(permission)) return <ForbiddenPage />;
  return <>{children}</>;
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
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          </Routes>
        </RuntimeGate>
      </BrowserRouter>
    </AppProvider>
  );
}
