import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  KeyNotFoundError,
  NotSubscribedError,
  SyncKv,
  type KeyListing,
  type PendingTransaction,
  type SyncTransport,
  type WatchEvent,
} from "../src/index.js";

class MemoryTransport implements SyncTransport {
  values = new Map<string, { value: unknown; etag: string }>();
  revision = 0;
  listCalls = 0;
  invalidation?: (value: string) => void;
  async list(prefix: string, known?: string): Promise<KeyListing> {
    this.listCalls++;
    const entries = [...this.values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, etag: value.etag }));
    const etag = `${this.revision}:${prefix}`;
    return known === etag ? { entries: [], etag, notModified: true } : { entries, etag };
  }
  async get(key: string): Promise<{ value: unknown; etag: string }> { return structuredClone(this.values.get(key)!); }
  async fetch(key: string): Promise<unknown> { return (await this.get(key)).value; }
  async transact(transaction: PendingTransaction): Promise<{ etags: Record<string, string | null> }> {
    // Validate the complete transaction before changing any remote value.
    for (const operation of transaction.operations) {
      const current = this.values.get(operation.key);
      if (operation.baseEtag !== undefined && current?.etag !== operation.baseEtag) {
        throw new ConflictError(operation.key);
      }
    }
    const etags: Record<string, string | null> = {};
    for (const operation of transaction.operations) {
      this.revision++;
      if (operation.type === "delete") {
        this.values.delete(operation.key);
        etags[operation.key] = null;
      } else {
        const etag = `e${this.revision}`;
        this.values.set(operation.key, { value: structuredClone(operation.value), etag });
        etags[operation.key] = etag;
      }
    }
    return { etags };
  }
  listen(_prefixes: readonly string[], invalidate: (value: string) => void): () => void {
    this.invalidation = invalidate;
    return () => { this.invalidation = undefined; };
  }
}

const stores: SyncKv[] = [];
function create(options: ConstructorParameters<typeof SyncKv>[0] = {}): SyncKv {
  const store = new SyncKv({ dbName: `test-${crypto.randomUUID()}`, syncIntervalMs: 0, ...options });
  stores.push(store);
  return store;
}
afterEach(async () => Promise.all(stores.splice(0).map((store) => store.close())));

describe("local key-value API", () => {
  it("sets, gets, lists, watches, and deletes subscribed keys", async () => {
    const store = create();
    const subscribing = store.sync("todo/");
    const events: WatchEvent[] = [];
    store.watch("todo/", (event) => events.push(event));
    await store.set("todo/a", { done: false });
    await subscribing;
    await store.set("todo/nested/b", 2);
    expect(await store.get("todo/a")).toEqual({ done: false });
    expect(await store.keys("todo/")).toEqual(["todo/a", "todo/nested/b"]);
    await store.delete("todo/a");
    await expect(store.get("todo/a")).rejects.toBeInstanceOf(KeyNotFoundError);
    expect(events.map((event) => event.type)).toEqual(["set", "set", "delete"]);
  });

  it("commits multi-key transactions atomically before notifying watchers", async () => {
    const store = create();
    await store.sync("accounts.");
    const events: WatchEvent[] = [];
    store.watch("accounts.", (event) => events.push(event));

    await store.transaction((tx) => {
      tx.set("accounts.source", 90);
      tx.set("accounts.destination", 110);
    });

    expect(await store.get("accounts.source")).toBe(90);
    expect(await store.get("accounts.destination")).toBe(110);
    expect(events).toHaveLength(2);
    expect(events[0]?.transactionId).toBe(events[1]?.transactionId);
    await expect(store.transaction((tx) => {
      tx.set("accounts.source", 1);
      tx.delete("accounts.source");
    })).rejects.toBeInstanceOf(TypeError);
    expect(await store.get("accounts.source")).toBe(90);

    await store.transaction(async (tx) => {
      await Promise.resolve();
      tx.set("accounts.async", true);
    });
    expect(await store.get("accounts.async")).toBe(true);
    await expect(store.transaction((tx) => {
      tx.set("accounts.aborted", true);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    await expect(store.get("accounts.aborted")).rejects.toBeInstanceOf(KeyNotFoundError);
  });

  it("rejects uncovered keys and retains overlapping prefixes", async () => {
    const store = create();
    await store.sync("todo/");
    await store.sync("todo/important/");
    await store.set("todo/general", 1);
    await store.set("todo/important/keep", 2);
    await expect(store.set("other/key", 3)).rejects.toBeInstanceOf(NotSubscribedError);
    await store.unsync("todo/");
    expect(await store.get("todo/important/keep")).toBe(2);
    await expect(store.get("todo/general")).rejects.toBeInstanceOf(NotSubscribedError);
  });

  it("notifies another tab after its IndexedDB commit", async () => {
    const dbName = `tabs-${crypto.randomUUID()}`;
    const first = new SyncKv({ dbName, syncIntervalMs: 0 });
    const second = new SyncKv({ dbName, syncIntervalMs: 0 });
    stores.push(first, second);
    await Promise.all([first.sync("shared/"), second.sync("shared/")]);
    const observed = vi.fn();
    second.watch("shared/", observed);
    await first.set("shared/key", "value");
    await vi.waitFor(() => expect(observed).toHaveBeenCalled());
    expect(await second.get("shared/key")).toBe("value");
  });
});

describe("synchronization", () => {
  it("uploads a local mutation without unnecessarily pulling its prefix", async () => {
    const transport = new MemoryTransport();
    const store = create({ transport });
    await store.sync("todo/");
    await store.synchronize();
    const priorListings = transport.listCalls;

    await store.set("todo/local", "client");
    await vi.waitFor(() => expect(transport.values.get("todo/local")?.value).toBe("client"));
    expect(transport.listCalls).toBe(priorListings);
  });

  it("pushes local values and pulls remote values and deletions", async () => {
    const transport = new MemoryTransport();
    transport.values.set("todo/remote", { value: "server", etag: "e0" });
    const store = create({ transport });
    await store.sync("todo/");
    await store.set("todo/local", "client");
    await store.synchronize();
    expect(transport.values.get("todo/local")?.value).toBe("client");
    expect(await store.get("todo/remote")).toBe("server");
    transport.values.delete("todo/remote");
    transport.revision++;
    await store.synchronize();
    await expect(store.get("todo/remote")).rejects.toBeInstanceOf(KeyNotFoundError);
  });

  it("queries remote-only prefixes without adding them to the replica", async () => {
    const transport = new MemoryTransport();
    transport.values.set("companies.acme", { value: { name: "Acme" }, etag: "e1" });
    transport.values.set("companies.globex", { value: { name: "Globex" }, etag: "e2" });
    const store = create({ transport });

    expect(await store.fetchKeys("companies.")).toEqual(["companies.acme", "companies.globex"]);
    expect((await store.fetchAll<{ name: string }>("companies.")).map((item) => item.value.name))
      .toEqual(["Acme", "Globex"]);
    await expect(store.keys("companies.")).rejects.toBeInstanceOf(NotSubscribedError);
  });

  it("fetches outside prefixes and preserves conflicts", async () => {
    const transport = new MemoryTransport();
    transport.values.set("remote/key", { value: "remote", etag: "e1" });
    transport.values.set("todo/a", { value: "initial", etag: "e1" });
    const store = create({ transport, onError: () => undefined });
    expect(await store.fetch("remote/key")).toBe("remote");
    await store.sync("todo/");
    await store.synchronize();
    await store.set("todo/a", "local");
    transport.values.set("todo/a", { value: "other", etag: "e2" });
    await expect(store.synchronize()).rejects.toBeInstanceOf(ConflictError);
    expect(await store.get("todo/a")).toBe("local");
    expect(await store.fetch("todo/a")).toBe("other");
  });
});
