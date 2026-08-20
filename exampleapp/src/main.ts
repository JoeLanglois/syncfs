import m from "mithril";
import { HttpTransport, SyncKv } from "@synckv/client";
import { createApp } from "./app.js";
import { TodoRepository } from "./todo-repository.js";
import "./style.css";

// By default the browser contacts port 8787 on the same host serving Vite. This
// works for localhost and for a machine addressed by its Tailscale hostname.
const syncServerUrl = (import.meta.env.VITE_SYNC_SERVER_URL as string | undefined)
  ?.replace(/\/$/, "") ?? `http://${location.hostname}:8787`;

// A stable database name preserves the offline replica across page reloads. The
// transport synchronizes it independently with the Deno server.
const store = new SyncKv({
  dbName: "synckv-todomvc",
  transport: new HttpTransport({ baseUrl: syncServerUrl }),
  onError: (error) => console.error("Background synchronization failed", error),
});
const repository = new TodoRepository(store);
const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing #app mount point");

m.mount(root, createApp(repository, syncServerUrl));

// Release the IndexedDB handle and background resources on full-page navigation.
window.addEventListener("pagehide", () => void store.close(), { once: true });
