import type {
  BlobManifest,
  KeyListing,
  PendingTransaction,
  StoreValue,
  SyncTransport,
  TransactionResult,
} from "./types.js";

export class ConflictError extends Error {
  constructor(readonly key: string, message = `Remote value changed: ${key}`) {
    super(message);
    this.name = "ConflictError";
  }
}

export interface HttpTransportOptions {
  baseUrl: string;
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  fetch?: typeof globalThis.fetch;
  eventSource?: typeof EventSource;
  clientId?: string;
}

/** JSON implementation of the small key-value sync protocol. */
export class HttpTransport implements SyncTransport {
  private readonly request: typeof globalThis.fetch;
  private readonly clientId: string;

  constructor(private readonly options: HttpTransportOptions) {
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.clientId = options.clientId ?? crypto.randomUUID();
  }

  private url(resource: string, parameter: string, value: string): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}/v1/${resource}?${parameter}=${encodeURIComponent(value)}`;
  }

  private async headers(extra?: HeadersInit): Promise<Headers> {
    const configured = typeof this.options.headers === "function" ? await this.options.headers() : this.options.headers;
    const result = new Headers(configured);
    if (extra) new Headers(extra).forEach((value, key) => result.set(key, value));
    return result;
  }

  private async json<T>(response: Response, key: string): Promise<T> {
    if (response.status === 409 || response.status === 412) throw new ConflictError(key);
    if (!response.ok) throw new Error(`Sync HTTP ${response.status} for ${key}`);
    return response.json() as Promise<T>;
  }

  async list(prefix: string, knownEtag?: string, signal?: AbortSignal): Promise<KeyListing> {
    const headers = await this.headers();
    if (knownEtag !== undefined) headers.set("if-none-match", `"${knownEtag}"`);
    const response = await this.request(this.url("keys", "prefix", prefix), {
      headers,
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 304) return { entries: [], ...(knownEtag ? { etag: knownEtag } : {}), notModified: true };
    return this.json(response, prefix);
  }

  async get(key: string, signal?: AbortSignal): Promise<{ value: StoreValue; etag: string }> {
    const response = await this.request(this.url("values", "key", key), {
      headers: await this.headers(),
      ...(signal === undefined ? {} : { signal }),
    });
    return this.json(response, key);
  }

  async getMany(keys: readonly string[], signal?: AbortSignal): Promise<Array<{ key: string; value: StoreValue; etag: string }>> {
    const response = await this.request(`${this.options.baseUrl.replace(/\/$/, "")}/v1/values/read`, {
      method: "POST",
      headers: await this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ keys }),
      ...(signal === undefined ? {} : { signal }),
    });
    return this.json(response, "batch read");
  }

  async fetch(key: string, signal?: AbortSignal): Promise<StoreValue> {
    return (await this.get(key, signal)).value;
  }

  async putBlob(manifest: BlobManifest, value: Blob, signal?: AbortSignal): Promise<void> {
    const response = await this.request(`${this.options.baseUrl.replace(/\/$/, "")}/v1/blob-content/${manifest.sha256}`, {
      method: "PUT", headers: await this.headers({ "content-type": manifest.contentType }), body: value,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw new Error(`Blob upload HTTP ${response.status}`);
  }

  async getBlob(key: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.request(this.url("blobs", "key", key), { headers: await this.headers(), ...(signal === undefined ? {} : { signal }) });
    if (!response.ok) throw new Error(`Blob download HTTP ${response.status} for ${key}`);
    return response.blob();
  }

  async transact(transaction: PendingTransaction, signal?: AbortSignal): Promise<TransactionResult> {
    const headers = await this.headers({
      "content-type": "application/json",
      "idempotency-key": transaction.transactionId,
      "x-synckv-client-id": this.clientId,
    });
    const response = await this.request(`${this.options.baseUrl.replace(/\/$/, "")}/v1/transactions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operations: transaction.operations }),
      ...(signal === undefined ? {} : { signal }),
    });
    return this.json(response, `transaction ${transaction.transactionId}`);
  }

  listen(prefixes: readonly string[], invalidate: (keyOrPrefix: string) => void, error: (error: unknown) => void): () => void {
    const EventSourceConstructor = this.options.eventSource ?? globalThis.EventSource;
    if (!EventSourceConstructor) return () => undefined;
    const prefixQuery = prefixes.map((prefix) => `prefix=${encodeURIComponent(prefix)}`).join("&");
    const source = new EventSourceConstructor(
      `${this.options.baseUrl.replace(/\/$/, "")}/v1/events?${prefixQuery}&clientId=${encodeURIComponent(this.clientId)}`,
    );
    source.addEventListener("invalidate", (event) => invalidate((event as MessageEvent<string>).data));
    source.onerror = error;
    return () => source.close();
  }
}
