import type {
  BlobManifest, BlobSyncStrategy, PendingOperation, PendingTransaction, TransactionOperation,
  TransactionResult, ValueRecord, WatchEvent,
} from "./types.js";

const VALUES = "kv-values";
const PREFIXES = "kv-prefixes";
const TRANSACTIONS = "kv-transactions";
const BLOBS = "kv-blob-content";

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); });
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")); });
}
export async function blobSHA256(value: Blob): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", await value.arrayBuffer()));
  return [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function manifest(value: Blob, options?: { filename?: string; contentType?: string }): Promise<BlobManifest> {
  return { sha256: await blobSHA256(value), size: value.size, contentType: options?.contentType ?? value.type ?? "application/octet-stream", ...(options?.filename ? { filename: options.filename } : {}) };
}

/** IndexedDB adapter. Blob payloads are deduplicated by their content hash. */
export class LocalDatabase {
  readonly ready: Promise<IDBDatabase>;
  constructor(factory: IDBFactory, name: string) {
    this.ready = new Promise((resolve, reject) => {
      const opening = factory.open(name, 4);
      opening.onupgradeneeded = () => {
        const db = opening.result;
        if (!db.objectStoreNames.contains(VALUES)) db.createObjectStore(VALUES, { keyPath: "key" });
        if (!db.objectStoreNames.contains(PREFIXES)) db.createObjectStore(PREFIXES, { keyPath: "prefix" });
        if (!db.objectStoreNames.contains(TRANSACTIONS)) db.createObjectStore(TRANSACTIONS, { keyPath: "id", autoIncrement: true });
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: "sha256" });
      };
      opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error);
    });
  }
  async prefixes(): Promise<Array<{ prefix: string; etag?: string; blobs?: BlobSyncStrategy }>> {
    const db = await this.ready; const tx = db.transaction(PREFIXES, "readonly");
    const result = await request<Array<{ prefix: string; etag?: string; blobs?: BlobSyncStrategy }>>(tx.objectStore(PREFIXES).getAll()); await completed(tx); return result;
  }
  async putPrefix(prefix: string, etag?: string, blobs: BlobSyncStrategy = "metadata"): Promise<void> {
    const db = await this.ready; const tx = db.transaction(PREFIXES, "readwrite"); tx.objectStore(PREFIXES).put({ prefix, blobs, ...(etag === undefined ? {} : { etag }) }); await completed(tx);
  }
  async removePrefix(prefix: string, remaining: readonly string[]): Promise<void> {
    const db = await this.ready; const tx = db.transaction([PREFIXES, VALUES, TRANSACTIONS, BLOBS], "readwrite"); tx.objectStore(PREFIXES).delete(prefix);
    const covered = (key: string) => remaining.some((candidate) => key.startsWith(candidate));
    const removedHashes = new Set<string>(); const retainedHashes = new Set<string>();
    for (const value of await request<ValueRecord[]>(tx.objectStore(VALUES).getAll())) {
      if (!covered(value.key)) { tx.objectStore(VALUES).delete(value.key); if(value.kind==="blob")removedHashes.add(value.blob.sha256) }
      else if(value.kind==="blob")retainedHashes.add(value.blob.sha256);
    }
    for (const pending of await request<PendingTransaction[]>(tx.objectStore(TRANSACTIONS).getAll())) {
      if (pending.operations.every((operation) => !covered(operation.key)) && pending.id !== undefined) tx.objectStore(TRANSACTIONS).delete(pending.id);
      else for(const operation of pending.operations)if(operation.type==="setBlob")retainedHashes.add(operation.blob.sha256);
    }
    for(const hash of removedHashes)if(!retainedHashes.has(hash))tx.objectStore(BLOBS).delete(hash);
    await completed(tx);
  }
  async value(key: string): Promise<ValueRecord | undefined> { const db=await this.ready;const tx=db.transaction(VALUES,"readonly");const value=await request<ValueRecord|undefined>(tx.objectStore(VALUES).get(key));await completed(tx);return value }
  async values(): Promise<ValueRecord[]> { const db=await this.ready;const tx=db.transaction(VALUES,"readonly");const values=await request<ValueRecord[]>(tx.objectStore(VALUES).getAll());await completed(tx);return values }
  async blob(sha256: string): Promise<Blob | undefined> { const db=await this.ready;const tx=db.transaction(BLOBS,"readonly");const row=await request<{sha256:string;value:Blob}|undefined>(tx.objectStore(BLOBS).get(sha256));await completed(tx);return row?.value }
  async putBlob(sha256: string, value: Blob): Promise<void> { const db=await this.ready;const tx=db.transaction(BLOBS,"readwrite");tx.objectStore(BLOBS).put({sha256,value});await completed(tx) }
  async deleteBlob(sha256: string): Promise<void> { const db=await this.ready;const tx=db.transaction(BLOBS,"readwrite");tx.objectStore(BLOBS).delete(sha256);await completed(tx) }

  async apply(operations: readonly TransactionOperation[]): Promise<{ transactionId: string; events: WatchEvent[] }> {
    const prepared = await Promise.all(operations.map(async (operation) => operation.type === "setBlob" ? { operation, blob: await manifest(operation.value, operation.options) } : { operation }));
    const db = await this.ready; const tx = db.transaction([VALUES, TRANSACTIONS, BLOBS], "readwrite"); const values=tx.objectStore(VALUES);const transactionId=crypto.randomUUID();const pending:PendingOperation[]=[];const events:WatchEvent[]=[];
    for (const item of prepared) {
      const operation=item.operation;const current=await request<ValueRecord|undefined>(values.get(operation.key));const base=current?.etag?{baseEtag:current.etag}:{};
      if(operation.type==="set"){values.put({key:operation.key,kind:"json",value:operation.value,...(current?.etag?{etag:current.etag}:{})});pending.push({type:"set",key:operation.key,value:operation.value,...base});events.push({type:"set",key:operation.key,transactionId})}
      else if(operation.type==="setBlob"){const blob=item.blob!;tx.objectStore(BLOBS).put({sha256:blob.sha256,value:operation.value});values.put({key:operation.key,kind:"blob",blob,...(current?.etag?{etag:current.etag}:{})});pending.push({type:"setBlob",key:operation.key,blob,...base});events.push({type:"set",key:operation.key,transactionId})}
      else if(current){values.delete(operation.key);pending.push({type:"delete",key:operation.key,...base});events.push({type:"delete",key:operation.key,transactionId})}
    }
    if(pending.length>0)tx.objectStore(TRANSACTIONS).add({transactionId,operations:pending});await completed(tx);return{transactionId,events};
  }
  async transactions(): Promise<PendingTransaction[]> {const db=await this.ready;const tx=db.transaction(TRANSACTIONS,"readonly");const values=await request<PendingTransaction[]>(tx.objectStore(TRANSACTIONS).getAll());await completed(tx);return values}
  async acceptTransaction(pending: PendingTransaction,result:TransactionResult):Promise<void>{if(pending.id===undefined)return;const db=await this.ready;const tx=db.transaction([VALUES,TRANSACTIONS],"readwrite");const queue=tx.objectStore(TRANSACTIONS);const values=tx.objectStore(VALUES);queue.delete(pending.id);for(const[key,etag]of Object.entries(result.etags)){if(etag!==null){const current=await request<ValueRecord|undefined>(values.get(key));if(current)values.put({...current,etag})}}for(const later of await request<PendingTransaction[]>(queue.getAll())){const operations=later.operations.map((operation):PendingOperation=>{const etag=result.etags[operation.key];if(etag===undefined)return operation;if(etag===null){const{baseEtag:_removed,...withoutBase}=operation;return withoutBase}return{...operation,baseEtag:etag}});queue.put({...later,operations})}await completed(tx)}
  async putRemote(record: ValueRecord):Promise<void>{const db=await this.ready;const tx=db.transaction(VALUES,"readwrite");tx.objectStore(VALUES).put(record);await completed(tx)}
  async deleteRemote(key:string):Promise<void>{const db=await this.ready;const tx=db.transaction(VALUES,"readwrite");tx.objectStore(VALUES).delete(key);await completed(tx)}
  async close():Promise<void>{(await this.ready).close()}
}
