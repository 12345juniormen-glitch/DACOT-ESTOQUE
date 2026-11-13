export interface VersionedRecord {
  id: string;
  version?: number;
}

/** Keep a newer cached record when an older API response arrives later. */
export function preferVersionedRecord<T extends VersionedRecord>(
  current: T | undefined,
  incoming: T,
): T {
  if (!current) return incoming;
  if (current.version != null && incoming.version == null) return current;
  if (current.version != null && incoming.version != null && incoming.version < current.version) return current;
  return incoming;
}

export function upsertVersionedRecord<T extends VersionedRecord>(records: T[], incoming: T): T[] {
  const current = records.find((record) => record.id === incoming.id);
  const latest = preferVersionedRecord(current, incoming);
  return current
    ? records.map((record) => record.id === incoming.id ? latest : record)
    : [latest, ...records];
}

export function mergeVersionedRecords<T extends VersionedRecord>(current: T[], incoming: T[]): T[] {
  const byId = new Map(current.map((record) => [record.id, record]));
  const incomingOrder: string[] = [];
  for (const record of incoming) {
    if (!byId.has(record.id) || !incomingOrder.includes(record.id)) incomingOrder.push(record.id);
    byId.set(record.id, preferVersionedRecord(byId.get(record.id), record));
  }
  const incomingIds = new Set(incomingOrder);
  return [...incomingOrder.map((id) => byId.get(id)!),
    ...current.filter((record) => !incomingIds.has(record.id)).map((record) => byId.get(record.id)!)];
}
