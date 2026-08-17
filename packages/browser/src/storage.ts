export const STORAGE_SCHEMA_VERSION = 1;
const STORE = "state";
const RECORD_KEY = "connection";

export type StoredBrowserConnection = {
  schemaVersion: 1;
  issuer: string;
  resource: string;
  origin: string;
  browserClientId: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  jkt: string;
  refreshToken?: string;
  connectionId?: string;
  subject?: string;
  refreshExpiresAt?: string;
  pending?: {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresAt: string;
    intervalSeconds: number;
    nextPollAt?: string;
  };
};

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class BrowserConnectionStore {
  constructor(private readonly databaseName: string) {}

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, STORAGE_SCHEMA_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
  }

  async read(): Promise<unknown> {
    const database = await this.open();
    try {
      return await requestResult(
        database.transaction(STORE, "readonly").objectStore(STORE).get(RECORD_KEY),
      );
    } finally {
      database.close();
    }
  }

  async write(record: StoredBrowserConnection): Promise<void> {
    const database = await this.open();
    try {
      const transaction = database.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).put(record, RECORD_KEY);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async clear(): Promise<void> {
    const database = await this.open();
    try {
      const transaction = database.transaction(STORE, "readwrite");
      transaction.objectStore(STORE).delete(RECORD_KEY);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }
}
