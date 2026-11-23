import type { LocalBackupMeta } from '../utils/backupSync';

export interface StoredLocalMediaBackup extends LocalBackupMeta {
  blob: Blob;
  savedAt: number;
}

const DB_NAME = 'bigbz_local_vault_v1';
const DB_VERSION = 1;
const STORE_NAME = 'media_backups';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openBackupDb(): Promise<IDBDatabase | null> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  if (dbPromise) return dbPromise;

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          const store = database.createObjectStore(STORE_NAME, { keyPath: 'mediaId' });
          store.createIndex('by_owner', 'ownerId', { unique: false });
          store.createIndex('by_album', 'albumId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return dbPromise;
}

/**
 * Persists an uploaded photo or video Blob into the browser's IndexedDB vault so
 * if the preview server drops local disk binaries across restarts, the app can
 * play immediately from local cache and automatically re-sync back to the server.
 */
export async function saveMediaToLocalBackup(
  record: Omit<StoredLocalMediaBackup, 'savedAt'>
): Promise<boolean> {
  const database = await openBackupDb();
  if (!database) return false;

  return new Promise<boolean>((resolve) => {
    try {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const entry: StoredLocalMediaBackup = {
        ...record,
        savedAt: Date.now(),
      };
      store.put(entry);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

export async function getLocalMediaBackup(
  mediaId: string
): Promise<StoredLocalMediaBackup | null> {
  if (!mediaId) return null;
  const database = await openBackupDb();
  if (!database) return null;

  return new Promise<StoredLocalMediaBackup | null>((resolve) => {
    try {
      const tx = database.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(mediaId);
      req.onsuccess = () => resolve((req.result as StoredLocalMediaBackup | undefined) || null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function listLocalMediaBackupsForOwner(
  ownerId: string
): Promise<StoredLocalMediaBackup[]> {
  if (!ownerId) return [];
  const database = await openBackupDb();
  if (!database) return [];

  return new Promise<StoredLocalMediaBackup[]>((resolve) => {
    try {
      const tx = database.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('by_owner');
      const req = index.getAll(ownerId);
      req.onsuccess = () =>
        resolve(Array.isArray(req.result) ? (req.result as StoredLocalMediaBackup[]) : []);
      req.onerror = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

export async function updateLocalMediaBackupMeta(
  mediaId: string,
  patch: Partial<Pick<LocalBackupMeta, 'title' | 'caption' | 'cameraMeta' | 'tags' | 'albumId'>>
): Promise<void> {
  const existing = await getLocalMediaBackup(mediaId);
  if (!existing) return;
  await saveMediaToLocalBackup({
    ...existing,
    ...patch,
  });
}

export async function deleteLocalMediaBackup(mediaId: string): Promise<void> {
  if (!mediaId) return;
  const database = await openBackupDb();
  if (!database) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(mediaId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function deleteLocalMediaBackupsByAlbum(albumId: string): Promise<void> {
  if (!albumId) return;
  const database = await openBackupDb();
  if (!database) return;

  await new Promise<void>((resolve) => {
    try {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('by_album');
      const req = index.getAllKeys(albumId);
      req.onsuccess = () => {
        const keys = Array.isArray(req.result) ? req.result : [];
        for (const key of keys) {
          store.delete(key);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}
