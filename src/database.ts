import type {
  PendingOperation,
  PendingTransaction,
  TransactionOperation,
  TransactionResult,
  ValueRecord,
  WatchEvent,
} from "./types.js";

const VALUES = "kv-values";
const PREFIXES = "kv-prefixes";
const TRANSACTIONS = "kv-transactions";

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** All local values and pending server transactions cross this IndexedDB boundary. */
export class LocalDatabase {
  readonly ready: Promise<IDBDatabase>;

  constructor(factory: IDBFactory, name: string) {
    this.ready = new Promise((resolve, reject) => {
      const opening = factory.open(name, 3);
      opening.onupgradeneeded = () => {
        const db = opening.result;
        if (!db.objectStoreNames.contains(VALUES)) db.createObjectStore(VALUES, { keyPath: "key" });
        if (!db.objectStoreNames.contains(PREFIXES)) db.createObjectStore(PREFIXES, { keyPath: "prefix" });
        if (!db.objectStoreNames.contains(TRANSACTIONS)) {
          db.createObjectStore(TRANSACTIONS, { keyPath: "id", autoIncrement: true });
        }
      };
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
  }

  async prefixes(): Promise<Array<{ prefix: string; etag?: string }>> {
    const db = await this.ready;
    const tx = db.transaction(PREFIXES, "readonly");
    const result = await request<Array<{ prefix: string; etag?: string }>>(tx.objectStore(PREFIXES).getAll());
    await completed(tx);
    return result;
  }

  async putPrefix(prefix: string, etag?: string): Promise<void> {
    const db = await this.ready;
    const tx = db.transaction(PREFIXES, "readwrite");
    tx.objectStore(PREFIXES).put({ prefix, ...(etag === undefined ? {} : { etag }) });
    await completed(tx);
  }

  async removePrefix(prefix: string, remaining: readonly string[]): Promise<void> {
    const db = await this.ready;
    const tx = db.transaction([PREFIXES, VALUES, TRANSACTIONS], "readwrite");
    tx.objectStore(PREFIXES).delete(prefix);
    const covered = (key: string) => remaining.some((candidate) => key.startsWith(candidate));
    for (const value of await request<ValueRecord[]>(tx.objectStore(VALUES).getAll())) {
      if (!covered(value.key)) tx.objectStore(VALUES).delete(value.key);
    }
    for (const pending of await request<PendingTransaction[]>(tx.objectStore(TRANSACTIONS).getAll())) {
      if (pending.operations.every((operation) => !covered(operation.key)) && pending.id !== undefined) {
        tx.objectStore(TRANSACTIONS).delete(pending.id);
      }
    }
    await completed(tx);
  }

  async value(key: string): Promise<ValueRecord | undefined> {
    const db = await this.ready;
    const tx = db.transaction(VALUES, "readonly");
    const value = await request<ValueRecord | undefined>(tx.objectStore(VALUES).get(key));
    await completed(tx);
    return value;
  }

  async values(): Promise<ValueRecord[]> {
    const db = await this.ready;
    const tx = db.transaction(VALUES, "readonly");
    const values = await request<ValueRecord[]>(tx.objectStore(VALUES).getAll());
    await completed(tx);
    return values;
  }

  /** Apply all operations and enqueue their remote counterpart in one IDB commit. */
  async apply(operations: readonly TransactionOperation[]): Promise<{ transactionId: string; events: WatchEvent[] }> {
    const db = await this.ready;
    const tx = db.transaction([VALUES, TRANSACTIONS], "readwrite");
    const values = tx.objectStore(VALUES);
    const transactionId = crypto.randomUUID();
    const pending: PendingOperation[] = [];
    const events: WatchEvent[] = [];

    for (const operation of operations) {
      const current = await request<ValueRecord | undefined>(values.get(operation.key));
      if (operation.type === "set") {
        values.put({ key: operation.key, value: operation.value, ...(current?.etag ? { etag: current.etag } : {}) });
        pending.push({ type: "set", key: operation.key, value: operation.value, ...(current?.etag ? { baseEtag: current.etag } : {}) });
        events.push({ type: "set", key: operation.key, transactionId });
      } else if (current) {
        values.delete(operation.key);
        pending.push({ type: "delete", key: operation.key, ...(current.etag ? { baseEtag: current.etag } : {}) });
        events.push({ type: "delete", key: operation.key, transactionId });
      }
    }
    if (pending.length > 0) tx.objectStore(TRANSACTIONS).add({ transactionId, operations: pending });
    await completed(tx);
    return { transactionId, events };
  }

  async transactions(): Promise<PendingTransaction[]> {
    const db = await this.ready;
    const tx = db.transaction(TRANSACTIONS, "readonly");
    const values = await request<PendingTransaction[]>(tx.objectStore(TRANSACTIONS).getAll());
    await completed(tx);
    return values;
  }

  async acceptTransaction(pending: PendingTransaction, result: TransactionResult): Promise<void> {
    if (pending.id === undefined) return;
    const db = await this.ready;
    const tx = db.transaction([VALUES, TRANSACTIONS], "readwrite");
    const queue = tx.objectStore(TRANSACTIONS);
    const values = tx.objectStore(VALUES);
    queue.delete(pending.id);

    for (const [key, etag] of Object.entries(result.etags)) {
      if (etag !== null) {
        const current = await request<ValueRecord | undefined>(values.get(key));
        if (current) values.put({ ...current, etag });
      }
    }
    // Transactions are pushed in order. Rebase later optimistic operations onto
    // all ETags produced by this transaction before sending them.
    for (const later of await request<PendingTransaction[]>(queue.getAll())) {
      const operations = later.operations.map((operation): PendingOperation => {
        const etag = result.etags[operation.key];
        if (etag === undefined) return operation;
        if (etag === null) {
          const { baseEtag: _removed, ...withoutBase } = operation;
          return withoutBase;
        }
        return { ...operation, baseEtag: etag };
      });
      queue.put({ ...later, operations });
    }
    await completed(tx);
  }

  async putRemote(record: ValueRecord): Promise<void> {
    const db = await this.ready;
    const tx = db.transaction(VALUES, "readwrite");
    tx.objectStore(VALUES).put(record);
    await completed(tx);
  }
  async deleteRemote(key: string): Promise<void> {
    const db = await this.ready;
    const tx = db.transaction(VALUES, "readwrite");
    tx.objectStore(VALUES).delete(key);
    await completed(tx);
  }
  async close(): Promise<void> { (await this.ready).close(); }
}
