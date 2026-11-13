import { parseStockQty } from './format';
import type { CountSession } from './types';

export function countWithDraftValues(
  count: CountSession,
  texts: Record<string, string>,
): { count: CountSession; invalidItemIds: string[] } {
  const invalidItemIds: string[] = [];
  const draft: CountSession = {
    ...count,
    lines: count.lines.map((line) => {
      const raw = texts[line.itemId] ?? (line.countedQty == null ? '' : String(line.countedQty));
      if (!raw.trim()) return { ...line, countedQty: null };
      const value = parseStockQty(raw);
      if (value == null) invalidItemIds.push(line.itemId);
      return { ...line, countedQty: value };
    }),
  };
  return { count: draft, invalidItemIds };
}
