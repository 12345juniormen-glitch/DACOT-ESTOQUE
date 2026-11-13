export function valueForTenant<T>(
  snapshot: { tenantId: string; value: T } | null,
  tenantId: string,
): T | null {
  return snapshot?.tenantId === tenantId ? snapshot.value : null;
}
