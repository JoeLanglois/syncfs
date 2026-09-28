# Blob storage and synchronization

SyncKv stores files as blobs rather than encoding bytes in JSON. A key is either a
JSON value or a blob; replacing one kind with the other uses the same optimistic
ETag rules as every other write.

## Client API

```ts
await kv.sync("receipts/", { blobs: "on-demand" })
await kv.setBlob("receipts/123.pdf", file, {
  filename: "receipt.pdf",
  contentType: "application/pdf",
})

const info = await kv.getBlobInfo("receipts/123.pdf")
const fileAgain = await kv.getBlob("receipts/123.pdf")
await kv.evictBlob("receipts/123.pdf")
```

`setBlob` also exists on the transaction context. Mixed JSON/blob transactions are
atomic at the metadata level: immutable content is uploaded first, then all key
changes commit together.

`get()` rejects blob keys with `ValueTypeError`; `getBlob()` similarly rejects JSON
keys. `fetchBlob()` always downloads directly and never changes the local cache.
Because payloads are deduplicated by hash, evicting one key also makes identical
payloads unavailable locally through any alias until one is downloaded again.

## Strategies

JSON values remain normal offline replicas under every strategy. The option controls
only blob payload bytes:

- `metadata` (default): synchronize manifests but not payloads. `getBlob()` downloads
  explicitly without caching.
- `on-demand`: manifests synchronize; `getBlob()` downloads once and caches by hash.
- `offline`: `synchronize()` eagerly downloads every matching payload and fails if
  that cannot be completed.

For overlapping prefixes, the strongest matching strategy wins: `offline`, then
`on-demand`, then `metadata`. A changed content hash invalidates stale cached bytes.
An `offline` synchronization can fail with an IndexedDB quota error; SyncKv never
silently weakens the requested guarantee.

## Integrity and deduplication

Payloads are addressed by SHA-256 of their raw bytes. Metadata records contain the
hash, size, media type, and optional filename. The key's ETag hashes that manifest,
so metadata-only changes still participate in conflict detection. Identical content
is uploaded and stored once within an adapter.

The browser currently hashes a complete `Blob` with Web Crypto before queueing it.
The server limits uploads to `MAX_BLOB_BYTES` (100 MiB by default). Chunked and
resumable multi-gigabyte uploads are intentionally outside the first protocol.

Content may be uploaded before a transaction later conflicts. Such bytes are safe
but temporarily unreferenced. Automated age-based server garbage collection and
HTTP range requests are future operational enhancements; backups should currently
include both metadata and content storage.
