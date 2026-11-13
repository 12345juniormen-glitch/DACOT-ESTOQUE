export function ingredientIdsKey(ids: readonly string[]): string {
  return [...new Set(ids.filter(Boolean))].sort().join('\u0000');
}
