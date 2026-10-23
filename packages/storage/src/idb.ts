// 최소 IndexedDB promise 래퍼. 트랜잭션 안에서는 IDB 요청 외의 await 를 하지 않는다(04 §3-4).
export function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('transaction error'));
    tx.onabort = () => reject(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
  });
}

export const STORES = ['projects', 'revisions', 'snapshots', 'assets', 'journals', 'outbox', 'leases', 'blobs', 'meta'] as const;
export type StoreName = (typeof STORES)[number];

export function openDb(name: string, factory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(name, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of STORES) {
        if (db.objectStoreNames.contains(s)) continue;
        const keyPath = { projects: 'projectId', revisions: 'id', snapshots: 'hash', assets: 'hash', journals: 'id', outbox: 'id', leases: 'projectId', blobs: 'path', meta: 'key' }[s];
        const os = db.createObjectStore(s, { keyPath });
        if (s === 'revisions' || s === 'journals' || s === 'outbox') os.createIndex('projectId', 'projectId');
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('IDB_BLOCKED'));
  });
}
