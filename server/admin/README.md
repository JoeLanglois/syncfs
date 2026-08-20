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

Start the Deno server separately from `server/` with `deno task dev`. Vite listens on
<http://localhost:5173> and connects to SyncKv at port 8787 on the same hostname.
Set `VITE_SYNCKV_SERVER_URL` to use another server.

## Features

- Prefix-based key search with live synchronized results
- Creating and deleting keys within the active prefix
- JSON editing and syntax highlighting powered by CodeMirror 6
- Optimistic conflict-safe saves through `@synckv/client`
- Automatic updates through the server's SSE invalidations
- Persistent favorite prefixes
- Persistent light and dark themes
- `Ctrl/Cmd+S` save shortcut
