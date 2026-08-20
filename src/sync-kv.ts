import { LocalDatabase } from "./database.js";
import type {
  RemoteValue,
  TransactionContext,
  TransactionOperation,
  StoreValue,
  SyncKvOptions,
  SyncTransport,
  WatchCallback,
  WatchEvent,
} from "./types.js";

export class NotSubscribedError extends Error {
  constructor(readonly key: string) {
    super(`Key is not covered by a synchronized prefix: ${key}`);
    this.name = "NotSubscribedError";
  }
}

export class KeyNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Key does not exist locally: ${key}`);
    this.name = "KeyNotFoundError";
  }
}

/** An explicit-prefix, local-first key-value store. */
export class SyncKv {
  private readonly database: LocalDatabase;
  private readonly transport: SyncTransport | undefined;
  private readonly reportError: (error: unknown) => void;
  private readonly instanceId = crypto.randomUUID();
  private readonly broadcast: BroadcastChannel | undefined;
  private readonly watchers = new Map<number, { prefix: string; callback: WatchCallback }>();
  private watcherId = 0;
  private prefixes: string[] = [];
  private readonly persistedPrefixes = new Set<string>();
  private readonly requestedPrefixes = new Set<string>();
  private stopListening: (() => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private synchronization: Promise<void> | undefined;
  private syncRequested = false;
  private pullRequested = false;
  private closed = false;
  private readonly onlineListener = (): void => {
    // `online` is a hint rather than proof that the server is reachable. Normal
    // synchronization still handles a failed request and leaves its queue intact.
    this.queueSync();
  };
  private listeningForOnline = false;
  readonly ready: Promise<void>;

  constructor(options: SyncKvOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is unavailable");
    const dbName = options.dbName ?? "synckv";
    this.database = new LocalDatabase(factory, dbName);
    this.transport = options.transport;
    this.reportError = options.onError ?? ((error) => console.error("SyncKv background error", error));
    this.broadcast = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(`synckv:${dbName}`);
    if (this.broadcast) {
      this.broadcast.onmessage = (message: MessageEvent<{ source: string; event: WatchEvent }>) => {
        if (message.data.source !== this.instanceId) this.emit(message.data.event, false);
      };
    }
    if (typeof globalThis.addEventListener === "function") {
      globalThis.addEventListener("online", this.onlineListener);
      this.listeningForOnline = true;
    }
    this.ready = this.initialize(options.syncIntervalMs ?? 30_000);
  }

  private async initialize(interval: number): Promise<void> {
    const stored = await this.database.prefixes();
    for (const item of stored) this.persistedPrefixes.add(item.prefix);
    this.prefixes = [...new Set([...stored.map((item) => item.prefix), ...this.requestedPrefixes])].sort();
    this.refreshListener(stored.map((item) => item.prefix));
    if (this.transport && interval > 0) this.timer = setInterval(() => this.queueSync(), interval);
    if (this.transport && stored.length > 0) this.queueSync();
  }

  /** Persist a replicated prefix and start synchronization without waiting for network. */
  async sync(prefix: string): Promise<void> {
    const normalized = validPrefix(prefix);
    this.requestedPrefixes.add(normalized);
    if (!this.prefixes.includes(normalized)) this.prefixes = [...this.prefixes, normalized].sort();
    await this.ready;
    const existed = this.persistedPrefixes.has(normalized);
    // Do not overwrite a persisted listing ETag when an app repeats sync(prefix)
    // during startup; that ETag enables the server's inexpensive HTTP 304 response.
    if (!existed) await this.database.putPrefix(normalized);
    this.persistedPrefixes.add(normalized);
    if (!existed) {
      this.refreshListener();
      this.queueSync(normalized);
    }
  }

  async unsync(prefix: string): Promise<void> {
    await this.ready;
    const normalized = validPrefix(prefix);
    const remaining = this.prefixes.filter((item) => item !== normalized);
    if (remaining.length === this.prefixes.length) return;
    await this.database.removePrefix(normalized, remaining);
    this.persistedPrefixes.delete(normalized);
    this.requestedPrefixes.delete(normalized);
    this.prefixes = remaining;
    this.refreshListener();
  }

  async get<T = StoreValue>(key: string): Promise<T> {
    await this.ready;
    const normalized = validKey(key);
    this.assertSubscribed(normalized);
    const record = await this.database.value(normalized);
    if (!record) throw new KeyNotFoundError(normalized);
    return record.value as T;
  }

  async set(key: string, value: StoreValue): Promise<void> {
    await this.ready;
    const normalized = validKey(key);
    this.assertSubscribed(normalized);
    await this.transaction((tx) => tx.set(normalized, value));
  }

  async delete(key: string): Promise<void> {
    await this.ready;
    const normalized = validKey(key);
    this.assertSubscribed(normalized);
    await this.transaction((tx) => tx.delete(normalized));
  }

  /**
   * Commit several local changes atomically and queue one all-or-nothing server
   * transaction. Watchers run only after the IndexedDB commit has completed.
   */
  async transaction(callback: (tx: TransactionContext) => void | Promise<void>): Promise<void> {
    await this.ready;
    if (typeof callback !== "function") throw new TypeError("transaction requires a callback");
    const operations: TransactionOperation[] = [];
    const keys = new Set<string>();
    let active = true;
    const stage = (operation: TransactionOperation): void => {
      if (!active) throw new Error("Transaction callback has already completed");
      const key = validKey(operation.key);
      this.assertSubscribed(key);
      if (keys.has(key)) throw new TypeError(`Transaction already contains key: ${key}`);
      keys.add(key);
      operations.push(operation.type === "set"
        ? { type: "set", key, value: operation.value }
        : { type: "delete", key });
    };
    const context: TransactionContext = {
      set: (key, value) => stage({ type: "set", key, value }),
      delete: (key) => stage({ type: "delete", key }),
    };
    try {
      await callback(context);
    } finally {
      // Prevent a retained context from mutating an already committed transaction.
      active = false;
    }
    const committed = await this.database.apply(operations);
    for (const event of committed.events) this.emit(event);
    if (committed.events.length > 0) this.queueSync(undefined, false);
  }

  /** Return sorted local keys beginning with prefix. */
  async keys(prefix = ""): Promise<string[]> {
    await this.ready;
    const normalized = validPrefix(prefix);
    this.assertSubscribedPrefix(normalized);
    return (await this.database.values()).map((record) => record.key).filter((key) => key.startsWith(normalized)).sort();
  }

  async fetch<T = StoreValue>(key: string, signal?: AbortSignal): Promise<T> {
    await this.ready;
    if (!this.transport) throw new Error("fetch requires a SyncTransport");
    return this.transport.fetch(validKey(key), signal) as Promise<T>;
  }

  /** List a remote-only prefix without subscribing to or caching its values. */
  async fetchKeys(prefix: string, signal?: AbortSignal): Promise<string[]> {
    await this.ready;
    if (!this.transport) throw new Error("fetchKeys requires a SyncTransport");
    const listing = await this.transport.list(validPrefix(prefix), undefined, signal);
    return listing.entries.map((entry) => entry.key).sort();
  }

  /** Bulk-read a remote-only prefix without changing the local replica. */
  async fetchAll<T = StoreValue>(prefix: string, signal?: AbortSignal): Promise<Array<RemoteValue<T>>> {
    await this.ready;
    if (!this.transport) throw new Error("fetchAll requires a SyncTransport");
    const listing = await this.transport.list(validPrefix(prefix), undefined, signal);
    const keys = listing.entries.map((entry) => entry.key);
    const values = this.transport.getMany
      ? await this.transport.getMany(keys, signal)
      : await Promise.all(keys.map(async (key) => ({ key, ...await this.transport!.get(key, signal) })));
    return values.map((item) => ({ ...item, value: item.value as T }));
  }

  watch(prefix: string, callback: WatchCallback): () => void {
    const id = ++this.watcherId;
    this.watchers.set(id, { prefix: validPrefix(prefix), callback });
    return () => this.watchers.delete(id);
  }

  async synchronize(): Promise<void> {
    await this.ready;
    if (!this.transport) return;
    // Explicit synchronization means both flushing local mutations and reconciling
    // remote state. Background local writes use the cheaper push-only path.
    this.syncRequested = true;
    this.pullRequested = true;
    return this.startSynchronization();
  }

  async close(): Promise<void> {
    await this.ready;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.stopListening?.();
    if (this.listeningForOnline && typeof globalThis.removeEventListener === "function") {
      globalThis.removeEventListener("online", this.onlineListener);
      this.listeningForOnline = false;
    }
    this.broadcast?.close();
    await this.synchronization;
    await this.database.close();
  }

  private async runSynchronizations(): Promise<void> {
    try {
      while (this.syncRequested) {
        this.syncRequested = false;
        const shouldPull = this.pullRequested;
        this.pullRequested = false;
        await this.synchronizeNow(shouldPull);
      }
    } finally {
      this.synchronization = undefined;
    }
  }

  private async synchronizeNow(shouldPull: boolean): Promise<void> {
    const transport = this.transport;
    if (!transport) return;

    while (true) {
      const pending = (await this.database.transactions())[0];
      if (!pending) break;
      // Transactions remain strictly ordered because a later transaction can depend
      // on several ETags produced by the preceding one.
      const result = await transport.transact(pending);
      await this.database.acceptTransaction(pending, result);
    }

    if (shouldPull) {
      const pending = await this.database.transactions();
      for (const prefix of this.prefixes) await this.pullPrefix(prefix, pending.flatMap((item) => item.operations));
    }
  }

  private async pullPrefix(prefix: string, pending: readonly { key: string }[]): Promise<void> {
    const transport = this.transport!;
    const saved = (await this.database.prefixes()).find((item) => item.prefix === prefix);
    const listing = await transport.list(prefix, saved?.etag);
    if (listing.notModified) return;

    const remoteKeys = new Set(listing.entries.map((entry) => entry.key));
    const downloads: string[] = [];
    for (const entry of listing.entries) {
      if (!entry.key.startsWith(prefix)) throw new Error(`Server returned key outside prefix: ${entry.key}`);
      if (pending.some((mutation) => mutation.key === entry.key)) continue;
      const local = await this.database.value(entry.key);
      if (local?.etag !== entry.etag) downloads.push(entry.key);
    }

    for (let offset = 0; offset < downloads.length; offset += 500) {
      const keys = downloads.slice(offset, offset + 500);
      const values = transport.getMany
        ? await transport.getMany(keys)
        : await Promise.all(keys.map(async (key) => ({ key, ...await transport.get(key) })));
      const byKey = new Map(values.map((value) => [value.key, value]));
      for (const key of keys) {
        const value = byKey.get(key);
        if (!value) throw new Error(`Batch response omitted ${key}`);
        await this.database.putRemote(value);
        this.emit({ type: "remote", key });
      }
    }

    for (const local of await this.database.values()) {
      if (!local.key.startsWith(prefix) || remoteKeys.has(local.key)) continue;
      if (pending.some((mutation) => mutation.key === local.key)) continue;
      await this.database.deleteRemote(local.key);
      this.emit({ type: "remote", key: local.key });
    }
    await this.database.putPrefix(prefix, listing.etag);
  }

  private assertSubscribed(key: string): void {
    if (!this.prefixes.some((prefix) => key.startsWith(prefix))) throw new NotSubscribedError(key);
  }

  private assertSubscribedPrefix(prefix: string): void {
    if (!this.prefixes.some((subscribed) => prefix.startsWith(subscribed) || subscribed.startsWith(prefix))) {
      throw new NotSubscribedError(prefix);
    }
  }

  private emit(event: WatchEvent, broadcast = true): void {
    if (broadcast) this.broadcast?.postMessage({ source: this.instanceId, event });
    for (const watcher of this.watchers.values()) {
      if (!event.key.startsWith(watcher.prefix)) continue;
      try { watcher.callback(event); } catch (error) { this.reportError(error); }
    }
  }

  private queueSync(keyOrPrefix?: string, shouldPull = true): void {
    if (!this.transport || this.closed) return;
    if (keyOrPrefix && !this.prefixes.some((prefix) => keyOrPrefix.startsWith(prefix) || prefix.startsWith(keyOrPrefix))) return;
    this.syncRequested = true;
    if (shouldPull) this.pullRequested = true;
    void this.startSynchronization().catch(this.reportError);
  }

  private startSynchronization(): Promise<void> {
    this.synchronization ??= this.runSynchronizations();
    return this.synchronization;
  }

  private refreshListener(prefixes: readonly string[] = this.prefixes): void {
    this.stopListening?.();
    this.stopListening = undefined;
    if (!this.transport?.listen || prefixes.length === 0 || this.closed) return;
    this.stopListening = this.transport.listen(prefixes, (value) => this.queueSync(value), this.reportError);
  }
}

function validKey(key: string): string {
  if (typeof key !== "string" || key.length === 0) throw new TypeError("A non-empty string key is required");
  return key;
}

function validPrefix(prefix: string): string {
  if (typeof prefix !== "string") throw new TypeError("Prefix must be a string");
  return prefix;
}
