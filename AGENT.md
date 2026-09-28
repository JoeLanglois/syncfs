# Local-First Key-Value Store — API & Sync Strategy

Build a simple local-first key-value library with a Go sync server and TypeScript
browser/Electron client.

## Core model

Clients explicitly synchronize string prefixes they need offline:

```ts
kv.sync("notes/")
kv.sync("finances/2026/")
```

Only matching keys are replicated to IndexedDB. Everything else remains remote-only
and can be read explicitly with `kv.fetch(key)`.

## Client API

```ts
kv.sync(prefix)
kv.unsync(prefix)
kv.get(key)
kv.set(key, value)
kv.delete(key)
kv.transaction(tx => {
  tx.set(key, value)
  tx.delete(key)
})
kv.keys(prefix)
kv.fetch(key)
kv.watch(prefix, callback)
```

Covered operations are local-first, atomic, immediately observable, and never wait
for the server. Sync runs independently in the background.

## Synchronization

The server stores keyed JSON values or blob manifests. JSON ETags hash the serialized
value; blob payloads are content-addressed separately by SHA-256. A prefix listing
returns keys, kinds, ETags, and blob metadata. The client compares those with
IndexedDB, downloads changed JSON values, applies the selected blob strategy, and
removes local keys missing remotely.

Writes use `If-Match`; creates use `If-None-Match: *`. Blob synchronization defaults
to metadata-only, with on-demand caching and eager offline strategies. Multi-key transactions commit
atomically in IndexedDB, queue as one unit, and apply in one storage transaction.
Persistent idempotency keys make retries safe. Conflicts must never silently
overwrite remote changes.

## Live sync

SSE is only a prefix-scoped invalidation signal. It is batched, excludes the writing
client, and is not required for correctness. Startup, browser `online` events, and
periodic fallback perform normal ETag-based synchronization.

## Principle

> A client explicitly chooses which key prefixes form its offline replica. Covered
> keys behave like a local key-value store and synchronize automatically.
