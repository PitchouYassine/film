const DB_NAME = 'recap_studio_local_db';
const DB_VERSION = 1;

export function openIndexedDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('presets')) {
        db.createObjectStore('presets', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('jobs')) {
        db.createObjectStore('jobs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('filmstrips')) {
        db.createObjectStore('filmstrips', { keyPath: 'id' });
      }
    };
  });
}

export async function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openIndexedDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const res = req.result;
      if (!res) return resolve(undefined);
      if (typeof res === 'object' && res !== null && 'value' in res && Object.keys(res).length <= 3) {
        return resolve(res.value as T);
      }
      return resolve(res as T);
    };
  });
}

export async function idbSet<T>(storeName: string, key: string, value: T): Promise<void> {
  const db = await openIndexedDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);

    // Provide both id and key so this record works on stores configured with keyPath 'id' or 'key'
    let record: any;
    if (value && typeof value === 'object' && !(value instanceof Blob)) {
      record = { ...(value as any) };
      if (!('id' in record)) record.id = key;
      if (!('key' in record)) record.key = key;
    } else {
      record = { key, id: key, value };
    }

    const req = store.put(record);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}

export async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await openIndexedDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}

export async function idbList<T>(storeName: string): Promise<T[]> {
  const db = await openIndexedDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const results = req.result || [];
      resolve(
        results.map((r: any) =>
          r && typeof r === 'object' && 'value' in r && Object.keys(r).length <= 3 ? r.value : r
        )
      );
    };
  });
}

// Blob asset storage for local media
const blobUrls = new Map<string, string>();

export async function storeBlobAsset(key: string, blob: Blob): Promise<string> {
  await idbSet('blobs', key, blob);
  if (blobUrls.has(key)) {
    URL.revokeObjectURL(blobUrls.get(key)!);
  }
  const url = URL.createObjectURL(blob);
  blobUrls.set(key, url);
  return url;
}

export async function getBlobAssetUrl(key: string): Promise<string | null> {
  if (blobUrls.has(key)) return blobUrls.get(key)!;
  const blob = await idbGet<Blob>('blobs', key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  blobUrls.set(key, url);
  return url;
}
