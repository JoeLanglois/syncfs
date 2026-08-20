# SyncKv Deno server

A small unauthenticated sync server intended for a trusted Tailscale network. It
stores key/value pairs, SHA-256 value ETags, idempotency records, and an SSE replay
log in SQLite.

## Admin panel

The Mithril + Vite console in `admin/` searches keys, edits JSON values, and updates
automatically from SSE invalidations. A production server serves its built bundle at
`/admin/` on the same origin as the API.

Build the client, admin bundle, and type-check the server together:

```sh
cd server
deno task build
```

For frontend development, use `npm run admin:dev` from the repository root. Vite
connects to the separately running Deno API and provides HMR.

## Run

```sh
cd server
deno task start -- --hostname 127.0.0.1 --port 8787 --db ./data/synckv.sqlite
```

Environment alternatives are `HOST`, `PORT`, `DATABASE_PATH`, and `CORS_ORIGIN`.
After `deno task build`, open <http://localhost:8787/admin/> for the admin panel.

## Protocol

- `GET /health`
- `GET /v1/keys?prefix=todo/`
- `GET|PUT|DELETE /v1/values?key=todo/items/123`
- `POST /v1/values/read`
- `POST /v1/transactions`
- `GET /v1/events?prefix=todo/&clientId=...`

Prefix listings support `If-None-Match` and return `304` when their sorted key/ETag
hash is unchanged. SSE only invalidates a prefix; clients always confirm state using
the listing endpoint.

## Verify

```sh
deno task check
deno task test
```

Root `npm test` also launches the real server and exercises the public TypeScript API
over HTTP.

## Docker

```sh
docker build -f server/Dockerfile -t synckv-server .
docker run --rm -p 8787:8787 -v synckv-data:/data synckv-server
```

This server has one shared namespace and no authentication. It should not be exposed
to an untrusted network.
