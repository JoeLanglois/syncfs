# Deno Key-Value Sync Server

## Model

The server has one trusted-network namespace. Each SQLite row contains:

- string `key`
- JSON `value`
- SHA-256 `etag` of the serialized value
- update timestamp

Additional tables retain idempotency responses and SSE change cursors.

## Synchronization protocol

`GET /v1/keys?prefix=finances/` returns every matching `{key, etag}` plus a hash of
the sorted listing. The listing supports `If-None-Match` and `304`.

Clients compare metadata locally, use `POST /v1/values/read` to retrieve changed
values, and delete local keys absent from the server listing. Sets and deletes use
optimistic ETag preconditions. Multi-key operation batches are checked and applied
atomically in one SQLite transaction.

SSE connections specify repeated `prefix` parameters. Events are batched by prefix,
exclude the writing client, and carry no values. Durable replay and periodic listing
checks make SSE optional for correctness.

## Persistence

Every queued client transaction uses one SQLite transaction:

1. Return a prior response when its idempotency key is known.
2. Check `If-Match` or `If-None-Match`.
3. Hash and store the value, or delete the key.
4. Store the idempotent response.
5. Append a change event.
6. Commit, then notify active SSE listeners.

The implementation is intentionally one Deno process with synchronous `node:sqlite`,
appropriate for a personal workload behind Tailscale.
