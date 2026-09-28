# SyncKv Admin

A desktop-style Mithril administration console for browsing and editing SyncKv data.
It uses the browser client itself, so synchronized searches receive the same SSE and
cross-tab updates as any other client.

## Development

From this directory:

```sh
npm install
npm run dev
```

Start the Go server separately from `server/` with `go run ./cmd/synckv`. Vite listens
on <http://localhost:5173> and connects to SyncKv at port 8787 on the same hostname.
The production bundle uses the server's own origin. Set `VITE_SYNCKV_SERVER_URL` to
override either default.

## Features

- Live prefix and case-insensitive full-text key search with synchronized results
- Mithril history routes for shareable prefix searches and selected keys
- Creating and deleting keys within the active prefix
- JSON editing, syntax highlighting, auto-closing brackets, and smart indentation powered by CodeMirror 6
- Optimistic conflict-safe saves through `@synckv/client`
- Automatic updates through the server's SSE invalidations
- Persistent favorite prefixes
- Persistent light and dark themes
- `Ctrl/Cmd+S` save shortcut
