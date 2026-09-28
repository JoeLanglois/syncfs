import "fake-indexeddb/auto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConflictError, HttpTransport, KeyNotFoundError, NotSubscribedError, SyncKv } from "../src/index.js";

let server: ChildProcessWithoutNullStreams;
let temporaryDirectory: string;
let baseUrl: string;
const clients: SyncKv[] = [];

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "synckv-server-"));
  server = spawn("go", ["run", "./cmd/synckv", "--hostname", "127.0.0.1", "--port", "0", "--db", join(temporaryDirectory, "test.sqlite")], { cwd: join(new URL("..", import.meta.url).pathname, "server") });
  baseUrl = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error(output)), 60_000);
    server.stdout.on("data", (chunk: Buffer) => {
      output += chunk;
      for (const line of output.split("\n")) try {
        const message = JSON.parse(line) as { event?: string; port?: number };
        if (message.event === "listening" && message.port) {
          clearTimeout(timeout);
          resolve(`http://127.0.0.1:${message.port}`);
        }
      } catch { /* startup text */ }
    });
    server.stderr.on("data", (chunk: Buffer) => { output += chunk; });
  });
});

afterAll(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  server.kill("SIGTERM");
  await new Promise<void>((resolve) => server.once("exit", () => resolve()));
  await rm(temporaryDirectory, { recursive: true, force: true });
});

function client(id = crypto.randomUUID()): SyncKv {
  const store = new SyncKv({
    dbName: `integration-${crypto.randomUUID()}`,
    syncIntervalMs: 0,
    transport: new HttpTransport({ baseUrl, clientId: id }),
    onError: () => undefined,
  });
  clients.push(store);
  return store;
}

describe("SyncKv against the Go server", () => {
  it("covers prefixes, values, keys, fetch, watch, delete, and unsync", async () => {
    const first = client("first");
    await first.sync("integration/data/");
    const localEvents: string[] = [];
    first.watch("integration/data/", (event) => localEvents.push(event.type));
    await first.transaction((tx) => {
      tx.set("integration/data/a", { from: "first" });
      tx.set("integration/data/nested", 2);
    });
    await first.synchronize();
    expect(await first.keys("integration/data/")).toEqual(["integration/data/a", "integration/data/nested"]);

    const second = client("second");
    const remoteEvents: string[] = [];
    second.watch("integration/data/", (event) => remoteEvents.push(event.type));
    await second.sync("integration/data/");
    await second.synchronize();
    expect(await second.get("integration/data/a")).toEqual({ from: "first" });
    expect(await second.fetch("integration/data/nested")).toBe(2);
    expect(remoteEvents).toContain("remote");

    await first.delete("integration/data/nested");
    await first.synchronize();
    await second.synchronize();
    await expect(second.get("integration/data/nested")).rejects.toBeInstanceOf(KeyNotFoundError);
    expect(localEvents).toEqual(expect.arrayContaining(["set", "delete"]));
    await second.unsync("integration/data/");
    await expect(second.get("integration/data/a")).rejects.toBeInstanceOf(NotSubscribedError);
  });

  it("preserves local and server values on conflict", async () => {
    const seed = client();
    await seed.sync("integration/conflict/");
    await seed.set("integration/conflict/value", "initial");
    await seed.synchronize();
    const left = client();
    const right = client();
    await Promise.all([left.sync("integration/conflict/"), right.sync("integration/conflict/")]);
    await Promise.all([left.synchronize(), right.synchronize()]);
    await left.set("integration/conflict/value", "left");
    await left.synchronize();
    await right.set("integration/conflict/value", "right");
    await expect(right.synchronize()).rejects.toBeInstanceOf(ConflictError);
    expect(await right.get("integration/conflict/value")).toBe("right");
    expect(await right.fetch("integration/conflict/value")).toBe("left");
  });

  it("stores blobs and honors metadata, on-demand, and offline strategies", async () => {
    const writer = client("blob-writer");
    await writer.sync("integration/blobs/");
    await writer.setBlob("integration/blobs/receipt", new Blob(["binary receipt"], { type: "application/pdf" }), { filename: "receipt.pdf" });
    expect((await writer.getBlobInfo("integration/blobs/receipt")).availableLocally).toBe(true);
    await writer.synchronize();
    expect((await writer.getBlobInfo("integration/blobs/receipt")).availableLocally).toBe(false);
    expect(await (await writer.getBlob("integration/blobs/receipt")).text()).toBe("binary receipt");
    expect((await writer.getBlobInfo("integration/blobs/receipt")).availableLocally).toBe(false);

    const cached = client("blob-cached");
    await cached.sync("integration/blobs/", { blobs: "on-demand" });
    await cached.synchronize();
    expect((await cached.getBlobInfo("integration/blobs/receipt")).availableLocally).toBe(false);
    expect(await (await cached.getBlob("integration/blobs/receipt")).text()).toBe("binary receipt");
    expect((await cached.getBlobInfo("integration/blobs/receipt")).availableLocally).toBe(true);

    const offline = client("blob-offline");
    await offline.sync("integration/blobs/", { blobs: "offline" });
    await offline.synchronize();
    expect((await offline.getBlobInfo("integration/blobs/receipt")).availableLocally).toBe(true);
    await offline.evictBlob("integration/blobs/receipt");
    await offline.synchronize(); // A 304 listing must not weaken the offline guarantee.
    expect((await offline.getBlobInfo("integration/blobs/receipt")).availableLocally).toBe(true);
  });

  it("emits prefix-scoped SSE invalidations", async () => {
    const abort = new AbortController();
    const response = await fetch(`${baseUrl}/v1/events?prefix=integration%2Fsse%2F&clientId=observer`, { signal: abort.signal });
    const reader = response.body!.getReader();
    const writer = client("writer");
    await writer.sync("integration/sse/");
    await writer.set("integration/sse/key", true);
    await writer.synchronize();
    let text = "";
    while (!text.includes("data: integration/sse/")) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain("event: invalidate");
    abort.abort();
  });
});
