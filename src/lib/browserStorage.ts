import { Project, StudioPreset, DefaultStudioPreferences, SavedFishVoice, SavedFontAsset, RenderJob, FilmstripFrame } from '../types/studio';

export const DB_NAME = 'recap_studio_local_db';
export const CURRENT_SCHEMA_VERSION = 5;

export const REQUIRED_STORES: Record<string, { keyPath: string }> = {
  projects: { keyPath: 'id' },
  filmstrips: { keyPath: 'id' },
  presets: { keyPath: 'id' },
  settings: { keyPath: 'key' },
  blobs: { keyPath: 'key' },
  jobs: { keyPath: 'id' },
  saved_fish_voices: { keyPath: 'id' },
  fonts: { keyPath: 'id' },
  waveforms: { keyPath: 'id' },
};

let cachedDb: IDBDatabase | null = null;
let pendingOpenPromise: Promise<IDBDatabase> | null = null;

function performOpen(targetVersion?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not supported or not available in this browser context.'));
      return;
    }

    const versionToOpen = targetVersion || CURRENT_SCHEMA_VERSION;
    const request = indexedDB.open(DB_NAME, versionToOpen);

    request.onblocked = () => {
      console.warn(
        `[IndexedDB] Database upgrade to version ${versionToOpen} is blocked by an unclosed connection. Please close other open tabs of this application.`
      );
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      const oldVersion = event.oldVersion;
      const newVersion = event.newVersion;
      console.info(
        `[IndexedDB] Upgrading database "${db.name}" schema from version ${oldVersion} to ${newVersion}...`
      );

      for (const [storeName, config] of Object.entries(REQUIRED_STORES)) {
        if (!db.objectStoreNames.contains(storeName)) {
          console.info(
            `[IndexedDB] Creating missing object store "${storeName}" with keyPath "${config.keyPath}"`
          );
          db.createObjectStore(storeName, { keyPath: config.keyPath });
        }
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      db.onversionchange = () => {
        console.warn(
          `[IndexedDB] Database version change requested by another connection. Closing active connection to allow upgrade.`
        );
        db.close();
        if (cachedDb === db) {
          cachedDb = null;
        }
      };

      db.onclose = () => {
        if (cachedDb === db) {
          cachedDb = null;
        }
      };

      db.onerror = (e) => {
        console.error('[IndexedDB] Database connection error:', (e.target as any)?.error);
      };

      resolve(db);
    };

    request.onerror = () => {
      console.error(
        `[IndexedDB Error] Failed to open database "${DB_NAME}" at version ${versionToOpen}:`,
        request.error
      );
      reject(request.error || new Error(`Failed to open IndexedDB "${DB_NAME}"`));
    };
  });
}

export async function openIndexedDB(): Promise<IDBDatabase> {
  // If we have an existing open connection, check if all required stores exist
  if (cachedDb) {
    const missing = Object.keys(REQUIRED_STORES).filter((s) => !cachedDb!.objectStoreNames.contains(s));
    if (missing.length === 0) {
      return cachedDb;
    }
    console.warn(
      `[IndexedDB] Active connection is missing stores [${missing.join(', ')}]. Closing to trigger automatic upgrade...`
    );
    cachedDb.close();
    cachedDb = null;
  }

  // Prevent multiple parallel conflicting openings
  if (pendingOpenPromise) {
    return pendingOpenPromise;
  }

  pendingOpenPromise = (async () => {
    try {
      let db = await performOpen();
      const missing = Object.keys(REQUIRED_STORES).filter((s) => !db.objectStoreNames.contains(s));
      if (missing.length > 0) {
        console.warn(
          `[IndexedDB] Database "${db.name}" (version ${db.version}) is missing stores [${missing.join(
            ', '
          )}]. Upgrading to version ${db.version + 1}...`
        );
        db.close();
        db = await performOpen(db.version + 1);
      }
      cachedDb = db;
      return db;
    } finally {
      pendingOpenPromise = null;
    }
  })();

  return pendingOpenPromise;
}

export async function getEnsureStoreDb(storeName: string): Promise<IDBDatabase> {
  let db = await openIndexedDB();
  if (!db.objectStoreNames.contains(storeName)) {
    console.error(
      `[IndexedDB Error] Object store "${storeName}" was NOT found in database "${db.name}" (version ${db.version})! ` +
      `Available stores: [${Array.from(db.objectStoreNames).join(', ')}]. Initiating immediate schema upgrade...`
    );

    if (cachedDb) {
      cachedDb.close();
      cachedDb = null;
    }

    if (!REQUIRED_STORES[storeName]) {
      REQUIRED_STORES[storeName] = { keyPath: 'id' };
    }

    db = await performOpen(db.version + 1);
    cachedDb = db;

    if (!db.objectStoreNames.contains(storeName)) {
      const err = new Error(
        `Failed to execute 'transaction' on 'IDBDatabase': Object store "${storeName}" was not found in database "${db.name}" (version ${db.version}). Available stores: [${Array.from(
          db.objectStoreNames
        ).join(', ')}]`
      );
      console.error(err);
      throw err;
    }
  }
  return db;
}

export async function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await getEnsureStoreDb(storeName);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(key);
      req.onerror = () => {
        console.error(`[IndexedDB Error] idbGet failed on store "${storeName}" for key "${key}":`, req.error);
        reject(req.error);
      };
      req.onsuccess = () => {
        const res = req.result;
        if (!res) return resolve(undefined);
        if (typeof res === 'object' && res !== null && 'value' in res && Object.keys(res).length <= 3) {
          return resolve(res.value as T);
        }
        return resolve(res as T);
      };
    } catch (err) {
      console.error(
        `[IndexedDB Error] Failed to create readonly transaction on store "${storeName}" (DB version ${db.version}):`,
        err
      );
      reject(err);
    }
  });
}

export async function idbSet<T>(storeName: string, key: string, value: T): Promise<void> {
  const db = await getEnsureStoreDb(storeName);
  return new Promise((resolve, reject) => {
    try {
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
      req.onerror = () => {
        console.error(`[IndexedDB Error] idbSet failed on store "${storeName}" for key "${key}":`, req.error);
        reject(req.error);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.error(`[IndexedDB Error] Transaction error on store "${storeName}":`, tx.error);
        reject(tx.error);
      };
    } catch (err) {
      console.error(
        `[IndexedDB Error] Failed to create readwrite transaction on store "${storeName}" (DB version ${db.version}):`,
        err
      );
      reject(err);
    }
  });
}

export async function idbDelete(storeName: string, key: string): Promise<void> {
  const db = await getEnsureStoreDb(storeName);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.delete(key);
      req.onerror = () => {
        console.error(`[IndexedDB Error] idbDelete failed on store "${storeName}" for key "${key}":`, req.error);
        reject(req.error);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.error(`[IndexedDB Error] Transaction error on store "${storeName}":`, tx.error);
        reject(tx.error);
      };
    } catch (err) {
      console.error(
        `[IndexedDB Error] Failed to create readwrite transaction on store "${storeName}" (DB version ${db.version}):`,
        err
      );
      reject(err);
    }
  });
}

export async function idbList<T>(storeName: string): Promise<T[]> {
  const db = await getEnsureStoreDb(storeName);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onerror = () => {
        console.error(`[IndexedDB Error] idbList failed on store "${storeName}":`, req.error);
        reject(req.error);
      };
      req.onsuccess = () => {
        const results = req.result || [];
        resolve(
          results.map((r: any) =>
            r && typeof r === 'object' && 'value' in r && Object.keys(r).length <= 3 ? r.value : r
          )
        );
      };
    } catch (err) {
      console.error(
        `[IndexedDB Error] Failed to create readonly transaction on store "${storeName}" (DB version ${db.version}):`,
        err
      );
      reject(err);
    }
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
