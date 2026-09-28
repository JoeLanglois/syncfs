# SyncKv Go server

A small unauthenticated sync server intended for a trusted network. The implementation
uses a functional domain core behind storage ports and HTTP/storage adapters:

- `internal/core`: pure validation, hashing, and atomic state transitions
- `internal/port`: the storage boundary
- `internal/storage`: SQLite, local-file, and in-memory adapters
- `internal/httpapi`: HTTP, SSE, CORS, and admin-panel adapter
- `cmd/synckv`: configuration, lifecycle, and dependency wiring

## Run

```sh
cd server
go run ./cmd/synckv --hostname 127.0.0.1 --port 8787 --storage sqlite --db ./data/synckv.sqlite
```

Storage is selected with `--storage sqlite|files|memory` (or `STORAGE_BACKEND`).
SQLite uses `--db`/`DATABASE_PATH`; local files use `--files`/`FILE_STORAGE_PATH`.
Memory storage has no persistence and is useful for tests. Existing databases from
the former server use the same SQLite schema.

Other environment options are `HOST`, `PORT`, `CORS_ORIGIN`, and `ADMIN_ROOT`.
The built admin bundle is served below `/admin/`.

## Protocol

- `GET /health`
- `GET /v1/keys?prefix=todo/`
- `GET|PUT|DELETE /v1/values?key=todo/items/123`
- `POST /v1/values/read`
- `POST /v1/transactions`
- `GET /v1/events?prefix=todo/&clientId=...`

## Build and verify

```sh
# Build the admin panel first when it has changed.
npm --prefix admin ci
npm --prefix admin run build

go test ./...
go build ./cmd/synckv
```

Root `npm test` also starts the Go server and exercises the public TypeScript client
over HTTP.

## Docker

```sh
docker build -f server/Dockerfile -t synckv-server .
docker run --rm -p 8787:8787 -v synckv-data:/data synckv-server
```

This server has one shared namespace and no authentication. Do not expose it to an
untrusted network.
