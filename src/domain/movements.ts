import type { InventoryItem } from './types';

export type ManualMovementInput = {
  kind: 'in' | 'out' | 'adjust';
  qty: number;
  reason: string;
  currentQty: number;
};

export function isStockSnapshotCurrent(
  incomingVersion: number | undefined,
  currentVersion: number | undefined,
  incomingAt?: string,
  currentAt?: string,
): boolean {
  if (incomingVersion != null && currentVersion != null) return incomingVersion >= currentVersion;
  if (incomingAt && currentAt) {
    const incomingTime = Date.parse(incomingAt);
    const currentTime = Date.parse(currentAt);
    if (Number.isFinite(incomingTime) && Number.isFinite(currentTime)) return incomingTime >= currentTime;
  }
  return true;
}

export function reconcileInventoryItem(current: InventoryItem | undefined,
  incoming: InventoryItem): InventoryItem {
  if (!current) return incoming;
  const catalogIsNewer = (incoming.version ?? 0) > (current.version ?? 0);
  const stockIsCurrent = isStockSnapshotCurrent(incoming.stockVersion, current.stockVersion,
    incoming.updatedAt, current.updatedAt);
  const merged = catalogIsNewer ? { ...current, ...incoming } : { ...current };
  if (stockIsCurrent) {
    merged.currentQty = incoming.currentQty;
    merged.stockVersion = incoming.stockVersion ?? current.stockVersion;
  } else {
    merged.currentQty = current.currentQty;
    merged.stockVersion = current.stockVersion;
  }
  const incomingTime = Date.parse(incoming.updatedAt);
  const currentTime = Date.parse(current.updatedAt);
  if (Number.isFinite(incomingTime) && (!Number.isFinite(currentTime) || incomingTime > currentTime)) {
    merged.updatedAt = incoming.updatedAt;
  } else if (current.updatedAt) merged.updatedAt = current.updatedAt;
  merged.version = Math.max(incoming.version ?? 0, current.version ?? 0) || undefined;
  return merged;
}

export function manualMovementPayload(input: ManualMovementInput) {
  const delta = input.kind === 'adjust'
    ? input.qty - input.currentQty
    : input.kind === 'out' ? -input.qty : input.qty;
  return {
    kind: delta < 0 ? 'adjustment_out' as const : 'adjustment_in' as const,
    quantity: Math.abs(delta),
    reason: input.reason.trim(),
    unit_cost_cents: null,
    ...(input.kind === 'adjust' ? { expected_balance: input.currentQty } : {}),
  };
}

export function isOpeningBalanceMovement(kind: string, reference?: string | null, reason?: string): boolean {
  return reference === 'INITIAL'
    || (!reference && kind === 'purchase' && reason?.trim().toLowerCase() === 'initial balance');
}

export function countMovementCode(kind: string, reason: string): string | null {
  if (kind !== 'count_in' && kind !== 'count_out') return null;
  return reason.trim().match(/^(?:physical count|contagem física)\s+(.+)$/i)?.[1]?.trim() || null;
}
