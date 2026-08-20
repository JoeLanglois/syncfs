/** Values use IndexedDB structured clone locally and JSON in the default transport. */
export type StoreValue = unknown;

export interface ValueRecord {
  key: string;
  value: StoreValue;
  etag?: string;
}

export type TransactionOperation =
  | { type: "set"; key: string; value: StoreValue }
  | { type: "delete"; key: string };

/** Stages operations; nothing becomes visible until the callback completes. */
export interface TransactionContext {
  set(key: string, value: StoreValue): void;
  delete(key: string): void;
}

export type PendingOperation =
  | { type: "set"; key: string; value: StoreValue; baseEtag?: string }
  | { type: "delete"; key: string; baseEtag?: string };

export interface PendingTransaction {
  id?: number;
  transactionId: string;
  operations: PendingOperation[];
}

export interface TransactionResult {
  /** A null ETag means the operation deleted that key. */
  etags: Record<string, string | null>;
}

export interface KeyMetadata { key: string; etag: string }
export interface RemoteValue<T = StoreValue> { key: string; value: T; etag: string }
export interface KeyListing {
  entries: KeyMetadata[];
  etag?: string;
  notModified?: boolean;
}

export interface SyncTransport {
  list(prefix: string, knownEtag?: string, signal?: AbortSignal): Promise<KeyListing>;
  get(key: string, signal?: AbortSignal): Promise<{ value: StoreValue; etag: string }>;
  getMany?(keys: readonly string[], signal?: AbortSignal): Promise<Array<RemoteValue>>;
  fetch(key: string, signal?: AbortSignal): Promise<StoreValue>;
  transact(transaction: PendingTransaction, signal?: AbortSignal): Promise<TransactionResult>;
  listen?(
    prefixes: readonly string[],
    invalidate: (keyOrPrefix: string) => void,
    error: (error: unknown) => void,
  ): () => void;
}

export type WatchEventType = "set" | "delete" | "remote";
export interface WatchEvent {
  type: WatchEventType;
  key: string;
  /** Present when several events became visible in one atomic local commit. */
  transactionId?: string;
}
export type WatchCallback = (event: WatchEvent) => void;

export interface SyncKvOptions {
  dbName?: string;
  transport?: SyncTransport;
  syncIntervalMs?: number;
  onError?: (error: unknown) => void;
  indexedDB?: IDBFactory;
}
