import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { applyOrderDelivered } from '../domain/events';
import { money, qty as fmtQty } from '../domain/format';
import { createDemoState } from '../domain/demo';
import { can as roleCan, type Permission } from '../domain/permissions';
import { recipeCostCents } from '../domain/selectors';
import type {
  AppState,
  AuditAction,
  AuditEntry,
  Cents,
  InventoryItem,
  ItemCategory,
  LossReason,
  Movement,
  Purchase,
  PurchaseStatus,
  Supplier,
  Unit,
} from '../domain/types';

interface ToastState {
  message: string;
  tone: 'ok' | 'error';
}

export interface NewItemInput {
  name: string;
  category: ItemCategory;
  unit: Unit;
  minQty: number;
  costCents: Cents;
  initialQty: number;
  supplierId: string | null;
}

export interface ReceiveLineInput {
  lineId: string;
  qtyReceived: number;
  unitCostCents: Cents;
}

export interface NewPurchaseInput {
  supplierId: string;
  expectedDeliveryAt: string | null;
  note: string;
  lines: { itemId: string; qtyOrdered: number; expectedUnitCostCents: Cents }[];
}

interface AppContextValue {
  state: AppState;
  toast: ToastState | null;
  can: (permission: Permission) => boolean;
  notify: (message: string, tone?: 'ok' | 'error') => void;
  actions: {
    setCurrentUserId: (id: string) => void;
    resetDemo: () => void;
    createItem: (input: NewItemInput) => string | null;
    recordMovement: (input: {
      itemId: string;
      kind: 'in' | 'out' | 'adjust';
      qty: number;
      reason: string;
    }) => boolean;
    registerLoss: (input: {
      itemId: string;
      qty: number;
      reason: LossReason;
      note: string;
    }) => boolean;
    createSupplier: (input: Omit<Supplier, 'id' | 'restaurantId' | 'createdAt'>) => string | null;
    createCount: (itemIds: string[]) => string | null;
    setCountQty: (countId: string, itemId: string, countedQty: number | null) => void;
    approveCount: (countId: string) => boolean;
    createPurchase: (input: NewPurchaseInput) => string | null;
    requestPurchase: (purchaseId: string) => boolean;
    cancelPurchase: (purchaseId: string) => boolean;
    receivePurchase: (purchaseId: string, receipts: ReceiveLineInput[]) => boolean;
    addRecipeIngredient: (recipeId: string, itemId: string, qty: number, unit: Unit) => boolean;
    updateRecipeIngredient: (recipeId: string, itemId: string, qty: number) => boolean;
    removeRecipeIngredient: (recipeId: string, itemId: string) => void;
    updateRecipePrice: (recipeId: string, salePriceCents: Cents) => boolean;
    simulateOrderDelivered: () => void;
    replayLastEvent: () => void;
  };
}

const AppContext = createContext<AppContextValue | null>(null);

const nowISO = () => new Date().toISOString();
const uid = (prefix: string) =>
  `${prefix}-${globalThis.crypto?.randomUUID?.()?.slice(0, 8) ?? Math.random().toString(36).slice(2, 10)}`;

function nextCode(existing: string[], prefix: string, base: number): string {
  const numbers = existing
    .map((code) => Number(code.replace(/\D/g, '')))
    .filter((n) => Number.isFinite(n));
  const next = Math.max(base, ...numbers) + 1;
  return `${prefix}-${String(next).padStart(4, '0')}`;
}

function auditEntry(
  state: AppState,
  action: AuditAction,
  entity: string,
  entityLabel: string,
  before: string | null,
  after: string | null,
  reason: string,
): AuditEntry {
  return {
    id: uid('au'),
    restaurantId: state.restaurant.id,
    userId: state.currentUserId,
    action,
    entity,
    entityLabel,
    before,
    after,
    reason,
    at: nowISO(),
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppState>(() => createDemoState());
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const notify = useCallback((message: string, tone: 'ok' | 'error' = 'ok') => {
    setToast({ message, tone });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 4200);
  }, []);

  const currentUser = state.users.find((u) => u.id === state.currentUserId) ?? state.users[0];
  const can = useCallback(
    (permission: Permission) => roleCan(currentUser.role, permission),
    [currentUser.role],
  );

  const actions = useMemo(() => {
    const require = (permission: Permission) => {
      if (!roleCan(currentUser.role, permission)) {
        notify('Seu perfil não tem permissão para esta ação.', 'error');
        return false;
      }
      return true;
    };

    return {
      setCurrentUserId: (id: string) => setState((prev) => ({ ...prev, currentUserId: id })),

      resetDemo: () => {
        setState(createDemoState());
        notify('Dados de demonstração restaurados.');
      },

      createItem: (input: NewItemInput) => {
        if (!require('stock.create')) return null;
        const name = input.name.trim();
        if (!name) {
          notify('Informe o nome do insumo.', 'error');
          return null;
        }
        if (state.items.some((i) => i.name.toLowerCase() === name.toLowerCase())) {
          notify('Já existe um insumo com esse nome.', 'error');
          return null;
        }
        const at = nowISO();
        const id = uid('it');
        const item: InventoryItem = {
          id,
          restaurantId: state.restaurant.id,
          name,
          category: input.category,
          unit: input.unit,
          currentQty: input.initialQty,
          minQty: input.minQty,
          costCents: input.costCents,
          primarySupplierId: input.supplierId,
          updatedAt: at,
        };
        const movements =
          input.initialQty > 0
            ? [
                ...state.movements,
                {
                  id: uid('mv'),
                  restaurantId: state.restaurant.id,
                  itemId: id,
                  type: 'MANUAL_IN' as const,
                  direction: 'in' as const,
                  qty: input.initialQty,
                  unit: input.unit,
                  unitCostCents: input.costCents,
                  occurredAt: at,
                  reason: 'Saldo inicial de cadastro',
                  origin: 'Cadastro de insumo',
                  userId: state.currentUserId,
                  balanceAfter: input.initialQty,
                },
              ]
            : state.movements;
        setState({
          ...state,
          items: [...state.items, item],
          movements,
          supplierItems: input.supplierId
            ? [
                ...state.supplierItems,
                {
                  id: uid('si'),
                  restaurantId: state.restaurant.id,
                  supplierId: input.supplierId,
                  itemId: id,
                  lastPriceCents: input.costCents,
                  lastPurchaseAt: null,
                  leadTimeDays:
                    state.suppliers.find((s) => s.id === input.supplierId)?.avgLeadTimeDays ?? 2,
                  minOrderCents:
                    state.suppliers.find((s) => s.id === input.supplierId)?.minOrderCents ?? 0,
                },
              ]
            : state.supplierItems,
          audit: [
            auditEntry(
              state,
              'stock.adjust',
              'item',
              name,
              null,
              `${fmtQty(input.initialQty, input.unit)} · ${money(input.costCents)}/${input.unit}`,
              'Cadastro de insumo',
            ),
            ...state.audit,
          ],
        });
        notify(`${name} cadastrado no estoque.`);
        return id;
      },

      recordMovement: (input: {
        itemId: string;
        kind: 'in' | 'out' | 'adjust';
        qty: number;
        reason: string;
      }) => {
        if (!require('stock.adjust')) return false;
        const item = state.items.find((i) => i.id === input.itemId);
        if (!item) return false;
        if (!Number.isFinite(input.qty) || input.qty < 0) {
          notify('Informe uma quantidade válida.', 'error');
          return false;
        }
        if (!input.reason.trim()) {
          notify('Descreva o motivo da movimentação.', 'error');
          return false;
        }

        let delta: number;
        let type: Movement['type'];
        if (input.kind === 'adjust') {
          delta = input.qty - item.currentQty;
          type = 'ADJUSTMENT';
          if (Math.abs(delta) < 0.0001) {
            notify('O saldo informado é igual ao estoque atual.', 'error');
            return false;
          }
        } else {
          if (input.qty <= 0) {
            notify('Informe uma quantidade maior que zero.', 'error');
            return false;
          }
          if (input.kind === 'out' && input.qty > item.currentQty + 0.0001) {
            notify('A saída é maior que o estoque disponível.', 'error');
            return false;
          }
          delta = input.kind === 'in' ? input.qty : -input.qty;
          type = input.kind === 'in' ? 'MANUAL_IN' : 'MANUAL_OUT';
        }

        const nextQty = Math.round((item.currentQty + delta) * 1000) / 1000;
        const at = nowISO();
        const movement: Movement = {
          id: uid('mv'),
          restaurantId: state.restaurant.id,
          itemId: item.id,
          type,
          direction: delta > 0 ? 'in' : 'out',
          qty: Math.abs(delta),
          unit: item.unit,
          unitCostCents: item.costCents,
          occurredAt: at,
          reason: input.reason.trim(),
          origin:
            input.kind === 'adjust' ? 'Ajuste manual de saldo' : 'Movimentação manual',
          userId: state.currentUserId,
          balanceAfter: nextQty,
        };

        setState({
          ...state,
          items: state.items.map((i) =>
            i.id === item.id ? { ...i, currentQty: nextQty, updatedAt: at } : i,
          ),
          movements: [...state.movements, movement],
          audit: [
            auditEntry(
              state,
              'stock.adjust',
              'item',
              item.name,
              fmtQty(item.currentQty, item.unit),
              fmtQty(nextQty, item.unit),
              input.reason.trim(),
            ),
            ...state.audit,
          ],
        });
        notify(
          `Estoque de ${item.name} ajustado para ${fmtQty(nextQty, item.unit)}.`,
        );
        return true;
      },

      registerLoss: (input: {
        itemId: string;
        qty: number;
        reason: LossReason;
        note: string;
      }) => {
        if (!require('losses.manage')) return false;
        const item = state.items.find((i) => i.id === input.itemId);
        if (!item) return false;
        if (!Number.isFinite(input.qty) || input.qty <= 0) {
          notify('Informe uma quantidade válida para a perda.', 'error');
          return false;
        }
        if (input.qty > item.currentQty + 0.0001) {
          notify('A perda é maior que o estoque disponível.', 'error');
          return false;
        }
        const at = nowISO();
        const valueCents = Math.round(input.qty * item.costCents);
        const nextQty = Math.round((item.currentQty - input.qty) * 1000) / 1000;
        const lossId = uid('ls');
        setState({
          ...state,
          items: state.items.map((i) =>
            i.id === item.id ? { ...i, currentQty: nextQty, updatedAt: at } : i,
          ),
          losses: [
            {
              id: lossId,
              restaurantId: state.restaurant.id,
              itemId: item.id,
              qty: input.qty,
              reason: input.reason,
              note: input.note.trim(),
              valueCents,
              at,
              userId: state.currentUserId,
            },
            ...state.losses,
          ],
          movements: [
            ...state.movements,
            {
              id: uid('mv'),
              restaurantId: state.restaurant.id,
              itemId: item.id,
              type: 'LOSS',
              direction: 'out',
              qty: input.qty,
              unit: item.unit,
              unitCostCents: item.costCents,
              occurredAt: at,
              reason: input.reason,
              origin: 'Registro de perda',
              userId: state.currentUserId,
              balanceAfter: nextQty,
            },
          ],
          audit: [
            auditEntry(
              state,
              'loss.register',
              'loss',
              `${item.name} · ${fmtQty(input.qty, item.unit)}`,
              null,
              money(valueCents),
              input.reason,
            ),
            ...state.audit,
          ],
        });
        notify(`Perda de ${item.name} registrada: ${money(valueCents)}.`);
        return true;
      },

      createSupplier: (input: Omit<Supplier, 'id' | 'restaurantId' | 'createdAt'>) => {
        if (!require('suppliers.manage')) return null;
        if (!input.name.trim()) {
          notify('Informe o nome do fornecedor.', 'error');
          return null;
        }
        const id = uid('sup');
        const supplier: Supplier = {
          ...input,
          id,
          restaurantId: state.restaurant.id,
          createdAt: nowISO(),
        };
        setState({
          ...state,
          suppliers: [...state.suppliers, supplier],
          audit: [
            auditEntry(state, 'supplier.create', 'supplier', supplier.name, null, null, 'Cadastro de fornecedor'),
            ...state.audit,
          ],
        });
        notify(`${supplier.name} cadastrado.`);
        return id;
      },

      createCount: (itemIds: string[]) => {
        if (!require('count.perform')) return null;
        if (itemIds.length === 0) {
          notify('Selecione ao menos um item para contar.', 'error');
          return null;
        }
        const code = nextCode(
          state.counts.map((c) => c.code),
          'CT',
          42,
        );
        const id = uid('ct');
        const at = nowISO();
        setState({
          ...state,
          counts: [
            {
              id,
              restaurantId: state.restaurant.id,
              code,
              status: 'open',
              startedAt: at,
              approvedAt: null,
              createdBy: state.currentUserId,
              approvedBy: null,
              lines: itemIds.map((itemId) => {
                const item = state.items.find((i) => i.id === itemId);
                return {
                  itemId,
                  expectedQty: item?.currentQty ?? 0,
                  countedQty: null,
                };
              }),
            },
            ...state.counts,
          ],
        });
        return id;
      },

      setCountQty: (countId: string, itemId: string, countedQty: number | null) => {
        setState((prev) => ({
          ...prev,
          counts: prev.counts.map((count) =>
            count.id === countId
              ? {
                  ...count,
                  lines: count.lines.map((line) =>
                    line.itemId === itemId ? { ...line, countedQty } : line,
                  ),
                }
              : count,
          ),
        }));
      },

      approveCount: (countId: string) => {
        if (!require('count.approve')) return false;
        const count = state.counts.find((c) => c.id === countId);
        if (!count) return false;
        const missing = count.lines.filter((l) => l.countedQty == null);
        if (missing.length > 0) {
          notify(`Ainda há ${missing.length} itens sem contagem.`, 'error');
          return false;
        }
        const at = nowISO();
        const movements: Movement[] = [];
        let items = state.items;
        let totalDiff = 0;
        for (const line of count.lines) {
          const item = items.find((i) => i.id === line.itemId);
          if (!item || line.countedQty == null) continue;
          const delta = line.countedQty - line.expectedQty;
          if (Math.abs(delta) < 0.0001) continue;
          totalDiff += Math.round(delta * item.costCents);
          const nextQty = Math.round(line.countedQty * 1000) / 1000;
          items = items.map((i) =>
            i.id === item.id ? { ...i, currentQty: nextQty, updatedAt: at } : i,
          );
          movements.push({
            id: uid('mv'),
            restaurantId: state.restaurant.id,
            itemId: item.id,
            type: 'ADJUSTMENT',
            direction: delta > 0 ? 'in' : 'out',
            qty: Math.abs(delta),
            unit: item.unit,
            unitCostCents: item.costCents,
            occurredAt: at,
            reason: `Contagem física ${count.code}`,
            origin: count.code,
            userId: state.currentUserId,
            balanceAfter: nextQty,
          });
        }

        setState({
          ...state,
          items,
          movements: [...state.movements, ...movements],
          counts: state.counts.map((c) =>
            c.id === countId
              ? {
                  ...c,
                  status: 'approved',
                  approvedAt: at,
                  approvedBy: state.currentUserId,
                }
              : c,
          ),
          audit: [
            auditEntry(
              state,
              'count.approve',
              'count',
              count.code,
              `${count.lines.length} itens esperados`,
              `${movements.length} ajustes gerados`,
              `Contagem aprovada · impacto de ${money(totalDiff)}`,
            ),
            ...state.audit,
          ],
        });
        notify(
          `Contagem ${count.code} aprovada: ${movements.length} ajustes gerados (${money(totalDiff)}).`,
        );
        return true;
      },

      createPurchase: (input: NewPurchaseInput) => {
        if (!require('purchases.manage')) return null;
        if (!input.supplierId) {
          notify('Selecione o fornecedor.', 'error');
          return null;
        }
        if (!input.lines.length) {
          notify('Inclua ao menos um item no pedido.', 'error');
          return null;
        }
        if (input.lines.some((l) => l.qtyOrdered <= 0)) {
          notify('Todas as quantidades devem ser maiores que zero.', 'error');
          return null;
        }
        const code = nextCode(
          state.purchases.map((p) => p.code),
          'PC',
          1047,
        );
        const id = uid('pu');
        const purchase: Purchase = {
          id,
          restaurantId: state.restaurant.id,
          code,
          supplierId: input.supplierId,
          status: 'draft',
          createdAt: nowISO(),
          expectedDeliveryAt: input.expectedDeliveryAt,
          receivedAt: null,
          receivedBy: null,
          note: input.note.trim(),
          lines: input.lines.map((line) => ({
            id: uid('pl'),
            itemId: line.itemId,
            qtyOrdered: line.qtyOrdered,
            qtyReceived: 0,
            expectedUnitCostCents: line.expectedUnitCostCents,
            receivedUnitCostCents: null,
          })),
        };
        setState({
          ...state,
          purchases: [purchase, ...state.purchases],
          audit: [
            auditEntry(
              state,
              'purchase.create',
              'purchase',
              code,
              null,
              input.lines
                .map((l) => `${state.items.find((i) => i.id === l.itemId)?.name ?? l.itemId} ${fmtQty(l.qtyOrdered)}`)
                .join(' · '),
              'Pedido de compra criado',
            ),
            ...state.audit,
          ],
        });
        notify(`Pedido ${code} criado como rascunho.`);
        return id;
      },

      requestPurchase: (purchaseId: string) => {
        if (!require('purchases.manage')) return false;
        const purchase = state.purchases.find((p) => p.id === purchaseId);
        if (!purchase) return false;
        setState({
          ...state,
          purchases: state.purchases.map((p) =>
            p.id === purchaseId ? { ...p, status: 'requested' as PurchaseStatus } : p,
          ),
        });
        notify(`Pedido ${purchase.code} enviado ao fornecedor.`);
        return true;
      },

      cancelPurchase: (purchaseId: string) => {
        if (!require('purchases.manage')) return false;
        const purchase = state.purchases.find((p) => p.id === purchaseId);
        if (!purchase) return false;
        if (purchase.status === 'received') {
          notify('Pedido já recebido não pode ser cancelado.', 'error');
          return false;
        }
        setState({
          ...state,
          purchases: state.purchases.map((p) =>
            p.id === purchaseId ? { ...p, status: 'cancelled' as PurchaseStatus } : p,
          ),
          audit: [
            auditEntry(
              state,
              'purchase.cancel',
              'purchase',
              purchase.code,
              purchase.status,
              'cancelled',
              'Cancelamento de pedido de compra',
            ),
            ...state.audit,
          ],
        });
        notify(`Pedido ${purchase.code} cancelado.`);
        return true;
      },

      receivePurchase: (purchaseId: string, receipts: ReceiveLineInput[]) => {
        if (!require('purchases.receive')) return false;
        const purchase = state.purchases.find((p) => p.id === purchaseId);
        if (!purchase) return false;
        if (purchase.status === 'received' || purchase.status === 'cancelled') {
          notify('Este pedido não está disponível para recebimento.', 'error');
          return false;
        }
        if (purchase.status === 'draft') {
          notify('Envie o pedido ao fornecedor antes de registrar o recebimento.', 'error');
          return false;
        }

        const invalid = receipts.find((receipt) => {
          const line = purchase.lines.find((l) => l.id === receipt.lineId);
          if (!line) return true;
          return receipt.qtyReceived > line.qtyOrdered + 0.0001 || receipt.qtyReceived < 0;
        });
        if (invalid) {
          notify('Quantidade recebida maior que a solicitada.', 'error');
          return false;
        }

        const at = nowISO();
        let items = state.items;
        let pricePoints = state.pricePoints;
        let supplierItems = state.supplierItems;
        const newMovements: Movement[] = [];
        const newAudit: AuditEntry[] = [];
        let totalReceived = 0;

        const updatedLines = purchase.lines.map((line) => {
          const input = receipts.find((r) => r.lineId === line.id);
          if (!input) return line;
          const targetQty = Math.max(0, input.qtyReceived);
          if (targetQty > line.qtyOrdered + 0.0001) {
            notify('Quantidade recebida maior que a solicitada.', 'error');
            return line;
          }
          const delta = Math.round((targetQty - line.qtyReceived) * 1000) / 1000;
          const unitCost = input.unitCostCents > 0 ? input.unitCostCents : line.expectedUnitCostCents;
          if (delta <= 0) {
            return { ...line, receivedUnitCostCents: unitCost };
          }
          const item = items.find((i) => i.id === line.itemId);
          if (!item) return line;
          const nextQty = Math.round((item.currentQty + delta) * 1000) / 1000;
          totalReceived += Math.round(delta * unitCost);
          items = items.map((i) =>
            i.id === item.id ? { ...i, currentQty: nextQty, costCents: unitCost, updatedAt: at } : i,
          );
          newMovements.push({
            id: uid('mv'),
            restaurantId: state.restaurant.id,
            itemId: item.id,
            type: 'PURCHASE',
            direction: 'in',
            qty: delta,
            unit: item.unit,
            unitCostCents: unitCost,
            occurredAt: at,
            reason: `Recebimento ${purchase.code}`,
            origin: purchase.code,
            userId: state.currentUserId,
            balanceAfter: nextQty,
          });
          pricePoints = [
            ...pricePoints,
            {
              id: uid('pp'),
              restaurantId: state.restaurant.id,
              itemId: item.id,
              supplierId: purchase.supplierId,
              unitCostCents: unitCost,
              at,
              source: 'purchase',
            },
          ];
          supplierItems = supplierItems.map((si) =>
            si.supplierId === purchase.supplierId && si.itemId === item.id
              ? { ...si, lastPriceCents: unitCost, lastPurchaseAt: at }
              : si,
          );
          if (unitCost !== item.costCents) {
            newAudit.push(
              auditEntry(
                state,
                'cost.change',
                'item',
                item.name,
                money(item.costCents) + `/${item.unit}`,
                money(unitCost) + `/${item.unit}`,
                `Preço atualizado no recebimento ${purchase.code}`,
              ),
            );
          }
          return {
            ...line,
            qtyReceived: targetQty,
            receivedUnitCostCents: unitCost,
          };
        });

        const allReceived = updatedLines.every((l) => l.qtyReceived >= l.qtyOrdered - 0.0001);
        const anyReceived = updatedLines.some((l) => l.qtyReceived > 0);
        const status: PurchaseStatus = allReceived ? 'received' : anyReceived ? 'partial' : purchase.status;

        let nextState: AppState = {
          ...state,
          items,
          pricePoints,
          supplierItems,
          movements: [...state.movements, ...newMovements],
          purchases: state.purchases.map((p) =>
            p.id === purchaseId
              ? { ...p, lines: updatedLines, status, receivedAt: at, receivedBy: state.currentUserId }
              : p,
          ),
          audit: [
            auditEntry(
              state,
              'purchase.receive',
              'purchase',
              purchase.code,
              purchase.lines
                .map((l) => `${state.items.find((i) => i.id === l.itemId)?.name ?? ''}: ${fmtQty(l.qtyReceived)}`)
                .join(' · '),
              updatedLines
                .map((l) => `${state.items.find((i) => i.id === l.itemId)?.name ?? ''}: ${fmtQty(l.qtyReceived)}`)
                .join(' · '),
              `Recebimento de ${money(totalReceived)}`,
            ),
            ...newAudit,
            ...state.audit,
          ],
        };

        const touched = new Set(updatedLines.map((l) => l.itemId));
        const snapshots = state.recipes
          .filter((recipe) => recipe.ingredients.some((i) => touched.has(i.itemId)))
          .map((recipe) => ({
            id: uid('rs'),
            restaurantId: state.restaurant.id,
            recipeId: recipe.id,
            costCents: Math.round(recipeCostCents(nextState, recipe)),
            salePriceCents: recipe.salePriceCents,
            at,
            trigger: `Recebimento ${purchase.code}`,
          }));
        nextState = {
          ...nextState,
          recipeSnapshots: [...snapshots, ...nextState.recipeSnapshots],
        };

        setState(nextState);
        notify(
          `Recebimento confirmado: ${money(totalReceived)} em ${purchase.code} (${status === 'received' ? 'pedido completo' : 'parcial'}).`,
        );
        return true;
      },

      addRecipeIngredient: (recipeId: string, itemId: string, qty: number, unit: Unit) => {
        if (!require('recipes.manage')) return false;
        const recipe = state.recipes.find((r) => r.id === recipeId);
        if (!recipe) return false;
        if (!itemId) {
          notify('Selecione o insumo.', 'error');
          return false;
        }
        if (qty <= 0) {
          notify('Informe uma quantidade maior que zero.', 'error');
          return false;
        }
        if (recipe.ingredients.some((i) => i.itemId === itemId)) {
          notify('Esse insumo já está na ficha técnica.', 'error');
          return false;
        }
        const at = nowISO();
        const nextState: AppState = {
          ...state,
          recipes: state.recipes.map((r) =>
            r.id === recipeId
              ? { ...r, ingredients: [...r.ingredients, { itemId, qty, unit }], updatedAt: at }
              : r,
          ),
        };
        const updated = nextState.recipes.find((r) => r.id === recipeId)!;
        setState({
          ...nextState,
          recipeSnapshots: [
            {
              id: uid('rs'),
              restaurantId: state.restaurant.id,
              recipeId,
              costCents: Math.round(recipeCostCents(nextState, updated)),
              salePriceCents: updated.salePriceCents,
              at,
              trigger: 'Ficha atualizada',
            },
            ...nextState.recipeSnapshots,
          ],
          audit: [
            auditEntry(
              state,
              'recipe.update',
              'recipe',
              recipe.name,
              null,
              `${state.items.find((i) => i.id === itemId)?.name ?? itemId} · ${fmtQty(qty, unit)}`,
              'Ingrediente adicionado à ficha',
            ),
            ...state.audit,
          ],
        });
        notify('Ingrediente adicionado à ficha técnica.');
        return true;
      },

      updateRecipeIngredient: (recipeId: string, itemId: string, qty: number) => {
        if (!require('recipes.manage')) return false;
        if (qty <= 0) {
          notify('Informe uma quantidade maior que zero.', 'error');
          return false;
        }
        const at = nowISO();
        const nextState: AppState = {
          ...state,
          recipes: state.recipes.map((r) =>
            r.id === recipeId
              ? {
                  ...r,
                  ingredients: r.ingredients.map((i) => (i.itemId === itemId ? { ...i, qty } : i)),
                  updatedAt: at,
                }
              : r,
          ),
        };
        const recipe = nextState.recipes.find((r) => r.id === recipeId)!;
        setState({
          ...nextState,
          recipeSnapshots: [
            {
              id: uid('rs'),
              restaurantId: state.restaurant.id,
              recipeId,
              costCents: Math.round(recipeCostCents(nextState, recipe)),
              salePriceCents: recipe.salePriceCents,
              at,
              trigger: 'Ficha atualizada',
            },
            ...nextState.recipeSnapshots,
          ],
          audit: [
            auditEntry(
              state,
              'recipe.update',
              'recipe',
              recipe.name,
              null,
              `${state.items.find((i) => i.id === itemId)?.name ?? itemId} · ${fmtQty(qty)}`,
              'Quantidade de ingrediente alterada',
            ),
            ...state.audit,
          ],
        });
        notify('Quantidade atualizada na ficha.');
        return true;
      },

      removeRecipeIngredient: (recipeId: string, itemId: string) => {
        if (!require('recipes.manage')) return;
        const at = nowISO();
        const recipe = state.recipes.find((r) => r.id === recipeId);
        if (!recipe) return;
        const nextState: AppState = {
          ...state,
          recipes: state.recipes.map((r) =>
            r.id === recipeId
              ? { ...r, ingredients: r.ingredients.filter((i) => i.itemId !== itemId), updatedAt: at }
              : r,
          ),
        };
        const updated = nextState.recipes.find((r) => r.id === recipeId)!;
        setState({
          ...nextState,
          recipeSnapshots: [
            {
              id: uid('rs'),
              restaurantId: state.restaurant.id,
              recipeId,
              costCents: Math.round(recipeCostCents(nextState, updated)),
              salePriceCents: updated.salePriceCents,
              at,
              trigger: 'Ficha atualizada',
            },
            ...nextState.recipeSnapshots,
          ],
          audit: [
            auditEntry(
              state,
              'recipe.update',
              'recipe',
              recipe.name,
              state.items.find((i) => i.id === itemId)?.name ?? itemId,
              null,
              'Ingrediente removido da ficha',
            ),
            ...state.audit,
          ],
        });
        notify('Ingrediente removido da ficha.');
      },

      updateRecipePrice: (recipeId: string, salePriceCents: Cents) => {
        if (!require('recipes.manage')) return false;
        if (salePriceCents <= 0) {
          notify('Informe um preço de venda válido.', 'error');
          return false;
        }
        const recipe = state.recipes.find((r) => r.id === recipeId);
        if (!recipe) return false;
        const at = nowISO();
        const nextState: AppState = {
          ...state,
          recipes: state.recipes.map((r) =>
            r.id === recipeId ? { ...r, salePriceCents, updatedAt: at } : r,
          ),
        };
        const updated = nextState.recipes.find((r) => r.id === recipeId)!;
        setState({
          ...nextState,
          recipeSnapshots: [
            {
              id: uid('rs'),
              restaurantId: state.restaurant.id,
              recipeId,
              costCents: Math.round(recipeCostCents(nextState, updated)),
              salePriceCents,
              at,
              trigger: 'Preço de venda alterado',
            },
            ...nextState.recipeSnapshots,
          ],
          audit: [
            auditEntry(
              state,
              'recipe.update',
              'recipe',
              recipe.name,
              money(recipe.salePriceCents),
              money(salePriceCents),
              'Alteração de preço de venda',
            ),
            ...state.audit,
          ],
        });
        notify('Preço de venda atualizado.');
        return true;
      },

      simulateOrderDelivered: () => {
        if (!require('overview.view')) return;
        const mix = [
          { recipeId: 'rc-xburger', qty: 2 },
          { recipeId: 'rc-batata', qty: 1 },
          { recipeId: 'rc-coca', qty: 2 },
        ];
        const seq = state.events.length + 1;
        const event = {
          id: `evt-sim-${seq}-${Date.now()}`,
          type: 'ORDER_DELIVERED' as const,
          restaurantId: state.restaurant.id,
          orderId: `PD-${9000 + seq}`,
          occurredAt: nowISO(),
          lines: mix,
          processedAt: null,
        };
        const outcome = applyOrderDelivered(state, event);
        setState(outcome.state);
        if (outcome.status === 'processed') {
          notify(
            `Pedido ${event.orderId} entregue: ${outcome.consumption
              .slice(0, 3)
              .map((c) => `${fmtQty(c.qty, c.unit as Unit)} ${c.name.toLowerCase()}`)
              .join(' · ')}${outcome.consumption.length > 3 ? '…' : ''}`,
          );
        }
      },

      replayLastEvent: () => {
        const last = state.events.find((e) => e.type === 'ORDER_DELIVERED');
        if (!last) {
          notify('Nenhum evento para reprocessar.', 'error');
          return;
        }
        const outcome = applyOrderDelivered(state, { ...last, id: last.id });
        if (outcome.status === 'duplicate') {
          notify(
            `Evento ${last.id} já processado. Nenhuma baixa duplicada foi gerada.`,
            'error',
          );
        }
      },
    };
  }, [state, currentUser.role, notify]);

  const value: AppContextValue = {
    state,
    toast,
    can,
    notify,
    actions,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp deve ser usado dentro de AppProvider');
  return context;
}

export function useCurrentUser() {
  const { state } = useApp();
  return state.users.find((u) => u.id === state.currentUserId) ?? state.users[0];
}
