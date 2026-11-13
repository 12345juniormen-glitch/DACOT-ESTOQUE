export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

export interface OperationReservation {
  key: string;
  storageKey: string;
  payload: string;
}

export function tenantOperationScope(tenantId: string | null, scope: string): string {
  if (!tenantId) throw new Error('A sessão do restaurante ainda não foi carregada.');
  return `${tenantId}:${scope}`;
}

export function reserveOperationKey(
  storage: StorageLike,
  scope: string,
  fingerprint: string,
  makeKey: () => string,
  retryPayload = fingerprint,
): OperationReservation {
  const storageKey = `dacot.idempotency.${scope}`;
  const stored = storage.getItem(storageKey);
  if (stored) {
    try {
      const previous = JSON.parse(stored) as { fingerprint?: string; key?: string };
      if (typeof previous.key === 'string' && previous.key && previous.fingerprint === fingerprint) {
        const previousWithPayload = previous as typeof previous & { payload?: unknown };
        return { key: previous.key, storageKey,
          payload: typeof previousWithPayload.payload === 'string' ? previousWithPayload.payload : retryPayload };
      }
      if (typeof previous.key === 'string' && previous.key) {
        throw new Error('Há uma operação anterior sem confirmação. Reenvie os mesmos dados para confirmar o resultado antes de iniciar outra.');
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Há uma operação anterior')) throw error;
      // Replace malformed retry metadata; it cannot identify a committed operation.
    }
  }
  const operation = { key: makeKey(), storageKey };
  storage.setItem(storageKey, JSON.stringify({ fingerprint, key: operation.key, payload: retryPayload }));
  return { ...operation, payload: retryPayload };
}

export function pendingOperationPayload(storage: StorageLike, scope: string): string | null {
  try {
    const entry = JSON.parse(storage.getItem(`dacot.idempotency.${scope}`) ?? 'null') as { payload?: unknown } | null;
    return typeof entry?.payload === 'string' ? entry.payload : null;
  } catch {
    return null;
  }
}

export function storedOperationScopes(storage: StorageLike, scopePrefix: string): string[] {
  if (typeof storage.length !== 'number' || typeof storage.key !== 'function') return [];
  const keyPrefix = `dacot.idempotency.${scopePrefix}`;
  const scopes: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(keyPrefix)) scopes.push(key.slice('dacot.idempotency.'.length));
  }
  return scopes;
}

export function migrateOperationReservation(
  storage: StorageLike,
  previousScopes: string[],
  currentScope: string,
  normalizeFingerprint: (payload: string) => string | null,
): boolean {
  const currentKey = `dacot.idempotency.${currentScope}`;
  if (storage.getItem(currentKey)) return false;
  for (const scope of previousScopes) {
    if (scope === currentScope) continue;
    const previousKey = `dacot.idempotency.${scope}`;
    const raw = storage.getItem(previousKey);
    if (!raw) continue;
    try {
      const previous = JSON.parse(raw) as { key?: unknown; payload?: unknown };
      if (typeof previous.key !== 'string' || !previous.key || typeof previous.payload !== 'string') continue;
      const fingerprint = normalizeFingerprint(previous.payload);
      if (!fingerprint) continue;
      storage.setItem(currentKey, JSON.stringify({
        key: previous.key, fingerprint, payload: previous.payload,
      }));
      storage.removeItem(previousKey);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function clearOperationReservation(storage: StorageLike, operation: OperationReservation): void {
  try {
    const stored = JSON.parse(storage.getItem(operation.storageKey) ?? 'null') as { key?: string } | null;
    if (stored?.key === operation.key) storage.removeItem(operation.storageKey);
  } catch {
    storage.removeItem(operation.storageKey);
  }
}

export function isDefinitiveHttpRejection(error: unknown): boolean {
  if (!(error instanceof Error) || !('status' in error)) return false;
  const status = (error as Error & { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500
    && ![408, 425, 429].includes(status);
}
