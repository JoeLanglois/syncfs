/** Values use IndexedDB structured clone locally and JSON in the default transport. */
export type StoreValue = unknown;
export type BlobSyncStrategy = "metadata" | "on-demand" | "offline";
export interface SyncOptions { blobs?: BlobSyncStrategy }

export interface BlobManifest {
  sha256: string;
  size: number;
  contentType: string;
  filename?: string;
}
export interface BlobInfo extends BlobManifest {
  key: string;
  etag?: string;
  availableLocally: boolean;
}
export interface BlobWriteOptions { filename?: string; contentType?: string }

export type ValueRecord =
  | { key: string; kind?: "json"; value: StoreValue; etag?: string }
  | { key: string; kind: "blob"; blob: BlobManifest; etag?: string };

export type TransactionOperation =
  | { type: "set"; key: string; value: StoreValue }
  | { type: "setBlob"; key: string; value: Blob; options?: BlobWriteOptions }
  | { type: "delete"; key: string };

/** Stages operations; nothing becomes visible until the callback completes. */
export interface TransactionContext {
  set(key: string, value: StoreValue): void;
  setBlob(key: string, value: Blob, options?: BlobWriteOptions): void;
  delete(key: string): void;
}

export type PendingOperation =
  | { type: "set"; key: string; value: StoreValue; baseEtag?: string }
  | { type: "setBlob"; key: string; blob: BlobManifest; baseEtag?: string }
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

export interface KeyMetadata { key: string; etag: string; kind?: "json" | "blob"; blob?: BlobManifest }
export interface RemoteValue<T = StoreValue> { key: string; value: T; etag: string }
export interface KeyListing { entries: KeyMetadata[]; etag?: string; notModified?: boolean }

export interface SyncTransport {
  list(prefix: string, knownEtag?: string, signal?: AbortSignal): Promise<KeyListing>;
  get(key: string, signal?: AbortSignal): Promise<{ value: StoreValue; etag: string }>;
  getMany?(keys: readonly string[], signal?: AbortSignal): Promise<Array<RemoteValue>>;
  fetch(key: string, signal?: AbortSignal): Promise<StoreValue>;
  putBlob?(manifest: BlobManifest, value: Blob, signal?: AbortSignal): Promise<void>;
  getBlob?(key: string, signal?: AbortSignal): Promise<Blob>;
  transact(transaction: PendingTransaction, signal?: AbortSignal): Promise<TransactionResult>;
  listen?(prefixes: readonly string[], invalidate: (keyOrPrefix: string) => void, error: (error: unknown) => void): () => void;
}

export type WatchEventType = "set" | "delete" | "remote";
export interface WatchEvent { type: WatchEventType; key: string; transactionId?: string }
export type WatchCallback = (event: WatchEvent) => void;

export interface SyncKvOptions {
  dbName?: string;
  transport?: SyncTransport;
  syncIntervalMs?: number;
  onError?: (error: unknown) => void;
  indexedDB?: IDBFactory;
}
