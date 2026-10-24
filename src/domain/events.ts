import { convertQty } from './format';
import type { AppState, Movement, OrderEvent } from './types';

export interface ConsumptionLine {
  itemId: string;
  name: string;
  unit: string;
  qty: number;
}

export interface DeliveryOutcome {
  state: AppState;
  status: 'processed' | 'duplicate';
  consumption: ConsumptionLine[];
  costCents: number;
}

/**
 * Consome estoque a partir de um ORDER_DELIVERED, usando a ficha técnica
 * vigente. Idempotente por event.id: o mesmo evento nunca baixa duas vezes.
 * Somente ORDER_DELIVERED gera consumo; eventos de criação/atualização não
 * devem alterar saldo (o consumo ocorre na entrega).
 */
export function applyOrderDelivered(state: AppState, event: OrderEvent): DeliveryOutcome {
  if (event.type !== 'ORDER_DELIVERED') {
    return { state, status: 'duplicate', consumption: [], costCents: 0 };
  }

  if (state.processedEventIds.includes(event.id)) {
    return { state, status: 'duplicate', consumption: [], costCents: 0 };
  }

  const totals = new Map<string, number>();
  for (const line of event.lines) {
    const recipe = state.recipes.find((r) => r.id === line.recipeId);
    if (!recipe) continue;
    for (const ingredient of recipe.ingredients) {
      const item = state.items.find((i) => i.id === ingredient.itemId);
      if (!item) continue;
      const perUnit = convertQty(ingredient.qty, ingredient.unit, item.unit);
      totals.set(item.id, (totals.get(item.id) ?? 0) + perUnit * line.qty);
    }
  }

  const consumption: ConsumptionLine[] = [];
  let costCents = 0;
  const newMovements: Movement[] = [];
  const items = state.items.map((item) => {
    const used = totals.get(item.id);
    if (!used) return item;
    const qty = Math.round(used * 1000) / 1000;
    const next = Math.round((item.currentQty - qty) * 1000) / 1000;
    consumption.push({ itemId: item.id, name: item.name, unit: item.unit, qty });
    costCents += Math.round(qty * item.costCents);
    newMovements.push({
      id: `mv-${event.id}-${item.id}`,
      restaurantId: state.restaurant.id,
      itemId: item.id,
      type: 'CONSUMPTION',
      direction: 'out',
      qty,
      unit: item.unit,
      unitCostCents: item.costCents,
      occurredAt: event.occurredAt,
      reason: `Consumo por vendas · Pedido ${event.orderId}`,
      origin: `ORDER_DELIVERED · ${event.orderId}`,
      userId: 'u-sistema',
      balanceAfter: next,
    });
    return { ...item, currentQty: next, updatedAt: event.occurredAt };
  });

  const processedAt = new Date().toISOString();
  const processedEvent: OrderEvent = {
    ...event,
    processedAt,
    consumption: consumption.map((c) => ({ itemId: c.itemId, qty: c.qty })),
  };

  return {
    state: {
      ...state,
      items,
      movements: [...state.movements, ...newMovements],
      events: [processedEvent, ...state.events.filter((e) => e.id !== event.id)].slice(0, 40),
      processedEventIds: [...state.processedEventIds, event.id].slice(-400),
    },
    status: 'processed',
    consumption,
    costCents,
  };
}

/** Converte as linhas da ficha em consumo esperado, sem alterar o estoque. */
export function expectedConsumption(state: AppState, recipeId: string, quantity: number) {
  const recipe = state.recipes.find((r) => r.id === recipeId);
  if (!recipe) return [];
  return recipe.ingredients.flatMap((ingredient) => {
    const item = state.items.find((i) => i.id === ingredient.itemId);
    if (!item) return [];
    return [
      {
        item,
        qty: convertQty(ingredient.qty, ingredient.unit, item.unit) * quantity,
      },
    ];
  });
}
