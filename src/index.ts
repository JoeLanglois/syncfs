/** Public package surface for the local-first key-value client. */
export { SyncKv, KeyNotFoundError, NotSubscribedError } from "./sync-kv.js";
export { HttpTransport, ConflictError } from "./http-transport.js";
export type {
  HttpTransportOptions,
  KeyListing,
  KeyMetadata,
  PendingOperation,
  PendingTransaction,
  RemoteValue,
  StoreValue,
  SyncKvOptions,
  SyncTransport,
  TransactionContext,
  TransactionOperation,
  TransactionResult,
  WatchCallback,
  WatchEvent,
  WatchEventType,
} from "./public-types.js";
