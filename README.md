# @synckv/client

A browser/Electron local-first key-value store. Applications explicitly synchronize
key prefixes; covered values live in IndexedDB and normal operations never wait for
the network.

```ts
import { SyncKv, HttpTransport } from "@synckv/client";

const kv = new SyncKv({
  transport: new HttpTransport({ baseUrl: "http://localhost:8787" }),
});

await kv.sync("notes/");
await kv.set("notes/today", { text: "hello" });

// Blob metadata is synchronized by default without downloading payloads.
await kv.sync("receipts/", { blobs: "on-demand" });
await kv.setBlob("receipts/lunch.pdf", pdfBlob, { filename: "lunch.pdf" });
const receipt = await kv.getBlob("receipts/lunch.pdf"); // downloaded and cached
await kv.transaction((tx) => {
  tx.set("notes/a", { text: "A" });
  tx.delete("notes/old");
});
console.log(await kv.get("notes/today"));
console.log(await kv.keys("notes/"));

const stop = kv.watch("notes/", event => console.log(event));
const archived = await kv.fetch("archive/old"); // intentionally remote-only
```

## API

- `sync(prefix, { blobs })` adds an offline prefix and schedules synchronization. JSON is always offline; `blobs` is `metadata` (default), `on-demand`, or `offline`.
- `unsync(prefix)` removes values not covered by another synchronized prefix.
- `get`, `set`, `delete`, and `keys` are local-only and require coverage.
- `setBlob`, `getBlob`, and `getBlobInfo` store files separately from JSON values.
- `fetchBlob` downloads without caching; `evictBlob` removes a cached payload while retaining metadata.
- `transaction(tx => { ... })` stages a multi-key commit that is atomic locally and remotely.
- `fetch(key)` always reads one key directly from the server.
- `fetchKeys(prefix)` and `fetchAll(prefix)` query remote-only prefixes without caching.
- `watch(prefix, callback)` observes committed local, cross-tab, and remote changes.
- `synchronize()` explicitly waits for pending synchronization.
- Browser/Electron `online` events automatically retry queued work and reconcile prefixes.
- `close()` releases IndexedDB, timers, BroadcastChannel, and SSE resources.

Values may be anything supported by IndexedDB structured clone. The default HTTP
transport uses JSON, so provide a custom `SyncTransport` for another wire format.
See [Blob storage and synchronization](docs/blobs.md) for payload strategies,
integrity, limits, and transaction behavior.

## Protocol

- `GET /v1/keys?prefix=...` returns every matching key and its value ETag.
- `GET /v1/values?key=...` returns `{ value, etag }`.
- `POST /v1/values/read` bulk-reads changed values.
- `PUT /v1/values?key=...` sets one value.
- `DELETE /v1/values?key=...` deletes one value.
- `POST /v1/transactions` atomically checks and applies a local transaction.
- `PUT /v1/blob-content/{sha256}` uploads immutable, content-addressed bytes.
- `GET|HEAD /v1/blobs?key=...` downloads a keyed blob.
- `GET /v1/events?prefix=...&clientId=...` provides disposable SSE invalidations.

JSON ETags are SHA-256 hashes of serialized values. Blob payloads use their raw-byte SHA-256 hash while the keyed resource has a separate manifest ETag. Prefix listings have their own hash
and support `If-None-Match`/`304`. Mutations use optimistic conditions and persistent
idempotency keys; conflicts never silently overwrite local or remote data. A remote
transaction is all-or-nothing, while its optimistic local state remains for explicit
conflict resolution if the server rejects it.

## Go server

The server is in [`server/`](server/) and supports interchangeable SQLite, local-file,
and in-memory storage. See its README for local and Docker instructions.

## Tailnet deployment

[`deploy/`](deploy/) contains a pyinfra deployment compatible with the conventions in
`~/projects/vps`. It installs a non-root loopback-only systemd service, publishes it
privately with Tailscale Serve HTTPS, adds no public Caddy route, and registers a
consistent Restic backup hook.

## TodoMVC example

The [`exampleapp/`](exampleapp/) Vite + Mithril application stores each list and todo
under an independent key and synchronizes the `todo/` prefix.

## Development

```sh
npm install
npm test
npm run build
```
