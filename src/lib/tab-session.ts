export interface TabSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TabSessionChannel {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(value: unknown): void;
  close(): void;
}

const STORAGE_KEY = 'dacot.tab-session-id';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function acquireTabSessionId(
  storage: TabSessionStorage,
  makeId: () => string,
  createChannel: ((name: string) => TabSessionChannel | null) | null,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)),
  allowStoredIdReuseWithoutChannel = true,
): Promise<{ id: string; channel: TabSessionChannel | null }> {
  const storedId = storage.getItem(STORAGE_KEY);
  const hadStoredId = !!storedId && UUID_PATTERN.test(storedId);
  let id = storedId;
  if (!id || !UUID_PATTERN.test(id)) id = makeId();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!createChannel) {
      if (hadStoredId && !allowStoredIdReuseWithoutChannel) id = makeId();
      storage.setItem(STORAGE_KEY, id);
      return { id, channel: null };
    }

    const channel = createChannel(`dacot.tab-session.${id}`);
    if (!channel) {
      if (hadStoredId && !allowStoredIdReuseWithoutChannel) id = makeId();
      storage.setItem(STORAGE_KEY, id);
      return { id, channel: null };
    }

    const nonce = makeId();
    let occupied = false;
    channel.onmessage = ({ data }) => {
      if (!data || typeof data !== 'object') return;
      const message = data as { type?: unknown; nonce?: unknown };
      if (message.type === 'claim' && typeof message.nonce === 'string' && message.nonce !== nonce) {
        channel.postMessage({ type: 'occupied', nonce: message.nonce });
      } else if (message.type === 'occupied' && message.nonce === nonce) {
        occupied = true;
      }
    };
    channel.postMessage({ type: 'claim', nonce });
    await wait(80);
    if (!occupied) {
      storage.setItem(STORAGE_KEY, id);
      return { id, channel };
    }

    channel.close();
    id = makeId();
  }

  storage.setItem(STORAGE_KEY, id);
  return { id, channel: null };
}
