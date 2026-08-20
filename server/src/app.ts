import { Store, type Conditions, type TransactionOperation } from "./store.ts";
import { HttpError } from "./errors.ts";

type Sender = (id: number, prefix: string) => void;
interface Listener {
  prefixes: string[];
  clientId?: string;
  send: Sender;
  pending: Map<string, number>;
  timer?: ReturnType<typeof setTimeout>;
}

/** Batches bursts into one invalidation per synchronized prefix. */
class EventHub {
  private readonly listeners = new Set<Listener>();

  add(prefixes: string[], send: Sender, clientId?: string): () => void {
    const listener: Listener = { prefixes, send, pending: new Map(), ...(clientId ? { clientId } : {}) };
    this.listeners.add(listener);
    return () => {
      if (listener.timer) clearTimeout(listener.timer);
      this.listeners.delete(listener);
    };
  }

  publish(id: number, key: string, origin?: string): void {
    for (const listener of this.listeners) {
      if (origin && listener.clientId === origin) continue;
      const prefix = matchingPrefix(listener.prefixes, key);
      if (prefix === undefined) continue;
      listener.pending.set(prefix, Math.max(id, listener.pending.get(prefix) ?? 0));
      listener.timer ??= setTimeout(() => {
        listener.timer = undefined;
        const pending = [...listener.pending].sort((a, b) => a[1] - b[1]);
        listener.pending.clear();
        for (const [value, eventId] of pending) listener.send(eventId, value);
      }, 50);
    }
  }
}

export interface App { fetch(request: Request): Promise<Response>; close(): void }

export function createApp(
  databasePath: string,
  adminRoot = new URL("../admin/dist/", import.meta.url),
): App {
  const store = new Store(databasePath);
  const events = new EventHub();

  async function handle(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    try {
      const url = new URL(request.url);
      if (url.pathname === "/admin") {
        return new Response(null, { status: 308, headers: { location: "/admin/" } });
      }
      if (url.pathname.startsWith("/admin/") && (request.method === "GET" || request.method === "HEAD")) {
        return await adminAsset(url.pathname, request.method === "HEAD", adminRoot);
      }
      if (url.pathname === "/health" && request.method === "GET") return json({ ok: true });
      if (url.pathname === "/v1/events" && request.method === "GET") return eventStream(request, url, store, events);

      if (url.pathname === "/v1/keys" && request.method === "GET") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const listing = store.list(prefix);
        if (parseEtag(request.headers.get("if-none-match")) === listing.etag) {
          return cors(new Response(null, { status: 304, headers: { etag: quote(listing.etag) } }));
        }
        return json(listing, 200, { etag: quote(listing.etag) });
      }
      if (url.pathname === "/v1/values/read" && request.method === "POST") {
        const body = await readObject(request);
        if (!Array.isArray(body.keys) || body.keys.length > 1000) throw new HttpError(400, "Invalid keys batch");
        const keys = body.keys.map((key) => requiredString(key, "key"));
        return json(store.getMany(keys));
      }
      if (url.pathname === "/v1/transactions" && request.method === "POST") {
        const body = await readObject(request);
        if (!Array.isArray(body.operations) || body.operations.length > 500) {
          throw new HttpError(400, "Invalid transaction operations");
        }
        const operations = body.operations.map((raw: unknown): TransactionOperation => {
          if (!raw || typeof raw !== "object") throw new HttpError(400, "Invalid operation");
          const operation = raw as Record<string, unknown>;
          const key = requiredString(operation.key, "key");
          const base = typeof operation.baseEtag === "string" ? { baseEtag: operation.baseEtag } : {};
          if (operation.type === "set" && "value" in operation) {
            return { type: "set", key, value: operation.value, ...base };
          }
          if (operation.type === "delete") return { type: "delete", key, ...base };
          throw new HttpError(400, "Unknown transaction operation");
        });
        if (new Set(operations.map((operation) => operation.key)).size !== operations.length) {
          throw new HttpError(400, "A transaction may operate on each key only once");
        }
        const id = requiredString(request.headers.get("idempotency-key"), "Idempotency-Key");
        const origin = request.headers.get("x-synckv-client-id") ?? undefined;
        const previous = store.latestChangeId();
        const result = store.transaction(operations, id, origin);
        publishChanges(store, events, previous);
        return json(result.body, result.status);
      }

      if (url.pathname === "/v1/mutations" && request.method === "POST") {
        const body = await readObject(request);
        if (!Array.isArray(body.mutations) || body.mutations.length > 500) throw new HttpError(400, "Invalid mutation batch");
        const origin = request.headers.get("x-synckv-client-id") ?? undefined;
        const previous = store.latestChangeId();
        const results = body.mutations.map((raw: unknown) => applyWireMutation(store, raw, origin));
        publishChanges(store, events, previous);
        return json(results);
      }

      if (url.pathname !== "/v1/values") throw new HttpError(404, "Route not found");
      const key = requiredString(url.searchParams.get("key"), "key");
      if (request.method === "GET") {
        const result = store.get(key);
        return json(result, 200, { etag: quote(result.etag) });
      }

      const idempotencyKey = requiredString(request.headers.get("idempotency-key"), "Idempotency-Key");
      const conditions = conditionsFromHeaders(request.headers);
      const origin = request.headers.get("x-synckv-client-id") ?? undefined;
      const previous = store.latestChangeId();
      let result;
      if (request.method === "PUT") {
        const body = await readObject(request);
        if (!("value" in body)) throw new HttpError(400, "Body must contain value");
        result = store.set(key, body.value, conditions, idempotencyKey, origin);
      } else if (request.method === "DELETE") {
        result = store.delete(key, conditions, idempotencyKey, origin);
      } else throw new HttpError(405, "Method not allowed");
      publishChanges(store, events, previous);
      return json(result.body, result.status);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: "Internal server error" }, 500);
    }
  }

  return { fetch: handle, close: () => store.close() };
}

/** Serve the Vite output without adding a second production web server. */
async function adminAsset(pathname: string, head: boolean, root: URL): Promise<Response> {
  let relative: string;
  try {
    relative = decodeURIComponent(pathname.slice("/admin/".length)) || "index.html";
  } catch {
    throw new HttpError(400, "Invalid admin asset path");
  }
  // URL resolution makes traversal checks straightforward and works regardless of
  // where the repository or container is installed.
  const normalizedRoot = root.href.endsWith("/") ? root : new URL(`${root.href}/`);
  const file = new URL(relative, normalizedRoot);
  if (!file.href.startsWith(normalizedRoot.href) || relative.includes("\\")) {
    throw new HttpError(404, "Admin asset not found");
  }

  try {
    const body = await Deno.readFile(file);
    const headers = new Headers({
      "content-type": contentType(relative),
      "x-content-type-options": "nosniff",
      // Vite fingerprints production assets; the HTML entry point must continue
      // checking for a newly built asset name.
      "cache-control": relative === "index.html"
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    });
    return new Response(head ? null : body, { headers });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      // Mithril uses history routing below /admin. Non-asset paths need the Vite
      // entry point so direct links and browser refreshes can bootstrap the router.
      if (relative !== "index.html" && !relative.startsWith("assets/")) {
        return adminAsset("/admin/", head, normalizedRoot);
      }
      throw new HttpError(404, "Admin asset not found");
    }
    throw error;
  }
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return {
    css: "text/css; charset=utf-8",
    html: "text/html; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    map: "application/json; charset=utf-8",
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
    woff2: "font/woff2",
  }[extension] ?? "application/octet-stream";
}

function applyWireMutation(store: Store, raw: unknown, origin?: string): unknown {
  try {
    if (!raw || typeof raw !== "object") throw new HttpError(400, "Invalid mutation");
    const mutation = raw as Record<string, unknown>;
    const key = requiredString(mutation.key, "key");
    const id = requiredString(mutation.mutationId, "mutationId");
    const conditions: Conditions = typeof mutation.baseEtag === "string"
      ? { ifMatch: mutation.baseEtag }
      : { ifNoneMatch: "*" };
    const stored = mutation.type === "set"
      ? store.set(key, mutation.value, conditions, id, origin)
      : mutation.type === "delete"
      ? store.delete(key, conditions, id, origin)
      : (() => { throw new HttpError(400, "Unknown mutation type"); })();
    return { ok: true, result: stored.body };
  } catch (error) {
    if (error instanceof HttpError) {
      const key = raw && typeof raw === "object" && "key" in raw ? String(raw.key) : "";
      return { ok: false, status: error.status, key, message: error.message };
    }
    throw error;
  }
}

function eventStream(request: Request, url: URL, store: Store, hub: EventHub): Response {
  const prefixes = url.searchParams.getAll("prefix");
  if (prefixes.length === 0) throw new HttpError(400, "At least one prefix is required");
  const clientId = url.searchParams.get("clientId") ?? undefined;
  const supplied = request.headers.get("last-event-id");
  const lastId = supplied === null ? store.latestChangeId() : Number(supplied);
  if (!Number.isSafeInteger(lastId) || lastId < 0) throw new HttpError(400, "Invalid Last-Event-ID");
  const encoder = new TextEncoder();
  let remove: () => void = () => undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send: Sender = (id, prefix) => controller.enqueue(
        encoder.encode(`id: ${id}\nevent: invalidate\ndata: ${prefix}\n\n`),
      );
      const replay = new Map<string, number>();
      for (const change of store.changesAfter(lastId)) {
        if (clientId && change.originClientId === clientId) continue;
        const prefix = matchingPrefix(prefixes, change.key);
        if (prefix !== undefined) replay.set(prefix, Math.max(change.id, replay.get(prefix) ?? 0));
      }
      for (const [prefix, id] of [...replay].sort((a, b) => a[1] - b[1])) send(id, prefix);
      remove = hub.add(prefixes, send, clientId);
      keepAlive = setInterval(() => {
        try { controller.enqueue(encoder.encode(": keep-alive\n\n")); } catch { /* disconnected */ }
      }, 20_000);
    },
    cancel() {
      remove();
      if (keepAlive) clearInterval(keepAlive);
    },
  });
  return cors(new Response(stream, { headers: {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  } }));
}

function publishChanges(store: Store, events: EventHub, after: number): void {
  for (const change of store.changesAfter(after)) events.publish(change.id, change.key, change.originClientId);
}
function matchingPrefix(prefixes: string[], key: string): string | undefined {
  return prefixes.filter((prefix) => key.startsWith(prefix)).sort((a, b) => a.length - b.length)[0];
}
function conditionsFromHeaders(headers: Headers): Conditions {
  const match = parseEtag(headers.get("if-match"));
  const none = headers.get("if-none-match") ?? undefined;
  return { ...(match ? { ifMatch: match } : {}), ...(none ? { ifNoneMatch: none } : {}) };
}
function parseEtag(value: string | null): string | undefined {
  return value?.replace(/^W\//, "").replace(/^"|"$/g, "");
}
function quote(value: string): string { return `"${value}"`; }
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new HttpError(400, `${name} is required`);
  return value;
}
async function readObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, "Body must be a JSON object"); }
}
function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return cors(new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json",
    ...Object.fromEntries(new Headers(headers)),
  } }));
}
function cors(response: Response): Response {
  response.headers.set("access-control-allow-origin", Deno.env.get("CORS_ORIGIN") ?? "*");
  response.headers.set("access-control-allow-methods", "GET, PUT, DELETE, POST, OPTIONS");
  response.headers.set("access-control-allow-headers", "Content-Type, If-Match, If-None-Match, Idempotency-Key, Last-Event-ID, X-SyncKv-Client-Id");
  response.headers.set("access-control-expose-headers", "ETag");
  return response;
}
