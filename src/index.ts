/** Public package surface for the local-first key-value client. */
export { SyncKv, BlobUnavailableError, KeyNotFoundError, NotSubscribedError, ValueTypeError } from "./sync-kv.js";
export { HttpTransport, ConflictError } from "./http-transport.js";
export type {
  BlobInfo,
  BlobManifest,
  BlobSyncStrategy,
  BlobWriteOptions,
  HttpTransportOptions,
  KeyListing,
  KeyMetadata,
  PendingOperation,
  PendingTransaction,
  RemoteValue,
  StoreValue,
  SyncKvOptions,
  SyncOptions,
  SyncTransport,
  TransactionContext,
  TransactionOperation,
  TransactionResult,
  WatchCallback,
  WatchEvent,
  WatchEventType,
} from "./public-types.js";
