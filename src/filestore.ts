/**
 * Photos, videos and files of the chats, on this phone only (IndexedDB). A sent file is kept so the
 * other phones can fetch it from here; a received one is written piece by piece while it arrives,
 * so a 2 GB video never has to fit in memory and a broken transfer goes on where it stopped.
 * Everything goes with its message: when the chat's time is up, it is deleted, or the person removed.
 *
 * Keys: "<channel>/<message>" for a whole file, "<channel>/<message>#<n>" for pieces still arriving.
 */

const DB = 'hush-files';
const STORE = 'files';

let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      opening = null;
      reject(req.error);
    };
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then((d) => new Promise<T | undefined>((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const fileKey = (channel: string, msg: string) => `${channel}/${msg}`;

export async function putFile(key: string, blob: Blob): Promise<void> {
  await run('readwrite', (s) => s.put(blob, key));
}

export async function getFile(key: string): Promise<Blob | null> {
  return ((await run<unknown>('readonly', (s) => s.get(key))) as Blob | undefined) ?? null;
}

/** Pieces of a file still arriving, in order. */
export async function getPieces(key: string): Promise<Blob[]> {
  const range = IDBKeyRange.bound(`${key}#`, `${key}#￿`);
  const [keys, values] = await Promise.all([
    run<IDBValidKey[]>('readonly', (s) => s.getAllKeys(range)),
    run<unknown[]>('readonly', (s) => s.getAll(range)),
  ]);
  const pieces = (keys ?? []).map((k, i) => ({ n: Number(String(k).split('#')[1]), blob: (values ?? [])[i] as Blob }));
  pieces.sort((a, b) => a.n - b.n);
  // Only an unbroken run from the start counts.
  const out: Blob[] = [];
  for (const [i, p] of pieces.entries()) {
    if (p.n !== i) break;
    out.push(p.blob);
  }
  return out;
}

export async function putPiece(key: string, n: number, blob: Blob): Promise<void> {
  await run('readwrite', (s) => s.put(blob, `${key}#${String(n).padStart(6, '0')}`));
}

/** The pieces become one file. */
export async function finishPieces(key: string): Promise<Blob> {
  const pieces = await getPieces(key);
  const whole = new Blob(pieces);
  await putFile(key, whole);
  await deleteRange(IDBKeyRange.bound(`${key}#`, `${key}#￿`));
  return whole;
}

export async function deleteFile(key: string): Promise<void> {
  await deleteRange(IDBKeyRange.bound(key, `${key}#￿`));
}

/** Everything of one chat. */
export async function deleteChannel(channel: string): Promise<void> {
  await deleteRange(IDBKeyRange.bound(`${channel}/`, `${channel}/￿`));
}

/** Keeps only these messages' files in one chat; the rest has expired or was deleted. */
export async function sweep(channel: string, keep: Set<string>): Promise<void> {
  const keys = (await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys(IDBKeyRange.bound(`${channel}/`, `${channel}/￿`)))) ?? [];
  const gone = new Set(keys.map(String).map((k) => k.slice(channel.length + 1).split('#')[0]).filter((id) => !keep.has(id)));
  for (const id of gone) await deleteFile(fileKey(channel, id));
}

async function deleteRange(range: IDBKeyRange): Promise<void> {
  await run('readwrite', (s) => s.delete(range));
}

/** Ask the browser not to clear these when space runs low (granted quietly, or not at all). */
export function keepStored(): void {
  void navigator.storage?.persist?.().catch(() => undefined);
}
