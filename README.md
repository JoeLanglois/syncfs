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

- `sync(prefix)` adds an offline prefix and schedules synchronization.
- `unsync(prefix)` removes values not covered by another synchronized prefix.
- `get`, `set`, `delete`, and `keys` are local-only and require coverage.
- `transaction(tx => { ... })` stages a multi-key commit that is atomic locally and remotely.
- `fetch(key)` always reads one key directly from the server.
- `fetchKeys(prefix)` and `fetchAll(prefix)` query remote-only prefixes without caching.
- `watch(prefix, callback)` observes committed local, cross-tab, and remote changes.
- `synchronize()` explicitly waits for pending synchronization.
- `close()` releases IndexedDB, timers, BroadcastChannel, and SSE resources.

Values may be anything supported by IndexedDB structured clone. The default HTTP
transport uses JSON, so provide a custom `SyncTransport` for another wire format.

## Protocol

- `GET /v1/keys?prefix=...` returns every matching key and its value ETag.
- `GET /v1/values?key=...` returns `{ value, etag }`.
- `POST /v1/values/read` bulk-reads changed values.
- `PUT /v1/values?key=...` sets one value.
- `DELETE /v1/values?key=...` deletes one value.
- `POST /v1/transactions` atomically checks and applies a local transaction.
- `GET /v1/events?prefix=...&clientId=...` provides disposable SSE invalidations.

ETags are SHA-256 hashes of serialized values. Prefix listings have their own hash
and support `If-None-Match`/`304`. Mutations use optimistic conditions and persistent
idempotency keys; conflicts never silently overwrite local or remote data. A remote
transaction is all-or-nothing, while its optimistic local state remains for explicit
conflict resolution if the server rejects it.

## Deno server

The SQLite-backed server is in [`server/`](server/). See its README for local and
Docker instructions.

## TodoMVC example

The [`exampleapp/`](exampleapp/) Vite + Mithril application stores each list and todo
under an independent key and synchronizes the `todo/` prefix.

## Development

```sh
npm install
npm test
npm run build
```
