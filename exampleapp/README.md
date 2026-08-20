# SyncKv TodoMVC example

A Vite + Mithril + TypeScript example using `@synckv/client`. It supports multiple
todo lists, TodoMVC filtering/editing/completion, keeps an offline IndexedDB replica,
and synchronizes that replica with the Deno server.

Every record is an independent key:

```text
todo/lists/<list-id>
todo/items/<todo-id>
```

Todo values contain their parent `listId`. Keeping each record independent lets the
server hash, version, and reconcile it separately.

## Run

Install the app dependencies:

```sh
cd exampleapp
npm install
```

Start the Deno server in one terminal:

```sh
npm run server
```

Then start Vite in another terminal:

```sh
npm run dev
```

Open the URL printed by Vite. By default the app connects to port `8787` on the
same hostname, which works both on localhost and through a Tailscale hostname.
Override it when needed:

```sh
VITE_SYNC_SERVER_URL=http://my-sync-server:8787 npm run dev
```

The local replica survives reloads under the `synckv-todomvc` IndexedDB database.
The server database defaults to `server/data/synckv.sqlite`. Clear both if you want
to completely reset the example.

## Verify and package

```sh
npm test
npm run build
npm run preview
```

The `predev` and `prebuild` scripts build the parent client library first. The app
uses the local package through `"@synckv/client": "file:.."`.
