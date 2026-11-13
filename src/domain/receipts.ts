import { parseStockQty } from './format';

export interface PendingReceiptLine {
  line_id: string;
  quantity_received: number;
  unit_cost_cents: number;
}

export function receiptQuantityDelta(raw: string, remaining: number): { quantity: number; invalid: boolean } {
  if (!raw.trim()) return { quantity: 0, invalid: false };
  const entered = parseStockQty(raw);
  if (entered === null || !Number.isFinite(remaining) || remaining < 0
      || entered > remaining + 1e-9) {
    return { quantity: 0, invalid: true };
  }
  return { quantity: entered, invalid: false };
}

export function receiptOperationScope(purchaseId: string): string {
  return `receipt-${purchaseId}`;
}

export function receiptOperationFingerprint(lines: PendingReceiptLine[]): string {
  return JSON.stringify({ lines });
}

export function normalizePendingReceiptFingerprint(payload: string): string | null {
  const lines = parsePendingReceiptLines(payload);
  return lines ? receiptOperationFingerprint(lines) : null;
}

export interface ReceiptSummaryLine {
  line_id: string;
  quantity_received: number;
  unit_cost_cents: number;
}

export interface ReceiptSummaryRecord {
  lines: ReceiptSummaryLine[];
  reversed_at?: string | null;
}

export function summarizePurchaseReceipts(receipts: ReceiptSummaryRecord[]): Record<string, {
  quantity: number;
  totalCents: number;
}> {
  const totals: Record<string, { quantity: number; totalCents: number }> = {};
  for (const receipt of receipts) {
    if (receipt.reversed_at) continue;
    for (const line of receipt.lines) {
      if (!line.line_id || !Number.isFinite(line.quantity_received) || line.quantity_received <= 0
          || !Number.isSafeInteger(line.unit_cost_cents) || line.unit_cost_cents < 0) continue;
      const current = totals[line.line_id] ?? { quantity: 0, totalCents: 0 };
      current.quantity += line.quantity_received;
      current.totalCents += Math.round(line.quantity_received * line.unit_cost_cents);
      totals[line.line_id] = current;
    }
  }
  return totals;
}

export function receiptHistoryMatchesPurchase(
  receipts: ReceiptSummaryRecord[],
  lines: { id: string; qtyReceived: number }[],
  precision = 0.001,
): boolean {
  const summary = summarizePurchaseReceipts(receipts);
  return lines.every((line) => Math.abs((summary[line.id]?.quantity ?? 0) - line.qtyReceived) <= precision);
}

export function parsePendingReceiptLines(payload: string): PendingReceiptLine[] | null {
  try {
    const value = JSON.parse(payload) as { lines?: unknown };
    if (!Array.isArray(value.lines)) return null;
    const lines = value.lines as Partial<PendingReceiptLine>[];
    if (lines.some((line) => typeof line.line_id !== 'string' || !line.line_id
      || typeof line.quantity_received !== 'number' || !Number.isFinite(line.quantity_received)
      || line.quantity_received <= 0 || !Number.isSafeInteger(line.unit_cost_cents)
      || (line.unit_cost_cents as number) < 0)) return null;
    return lines as PendingReceiptLine[];
  } catch {
    return null;
  }
}
