import assert from "node:assert/strict";
import { createApp, type App } from "./app.ts";

function valueRequest(app: App, method: string, key: string, options: { value?: unknown; match?: string; none?: boolean; id?: string } = {}) {
  const headers = new Headers();
  if (options.value !== undefined) headers.set("content-type", "application/json");
  if (options.match) headers.set("if-match", options.match);
  if (options.none) headers.set("if-none-match", "*");
  if (options.id) headers.set("idempotency-key", options.id);
  return app.fetch(new Request(`http://test/v1/values?key=${encodeURIComponent(key)}`, {
    method, headers, ...(options.value === undefined ? {} : { body: JSON.stringify({ value: options.value }) }),
  }));
}

Deno.test("values use content hashes and optimistic conditions", async () => {
  const app = createApp(":memory:");
  try {
    assert.equal((await valueRequest(app, "PUT", "todo/a", { value: 1, id: "m0" })).status, 428);
    const created = await valueRequest(app, "PUT", "todo/a", { value: { n: 1 }, none: true, id: "m1" });
    const first = await created.json() as { etag: string };
    assert.equal(first.etag.length, 64);
    const retry = await valueRequest(app, "PUT", "todo/a", { value: { n: 1 }, none: true, id: "m1" });
    assert.deepEqual(await retry.json(), first);
    assert.equal((await valueRequest(app, "PUT", "todo/a", { value: 2, match: "stale", id: "m2" })).status, 412);
    const read = await valueRequest(app, "GET", "todo/a");
    assert.deepEqual((await read.json()).value, { n: 1 });
    assert.equal(read.headers.get("etag"), `"${first.etag}"`);
  } finally { app.close(); }
});

Deno.test("prefix listings support ETags, bulk reads, and deletes", async () => {
  const app = createApp(":memory:");
  try {
    await valueRequest(app, "PUT", "todo/a", { value: 1, none: true, id: "a" });
    await valueRequest(app, "PUT", "todo/b", { value: 2, none: true, id: "b" });
    await valueRequest(app, "PUT", "other/c", { value: 3, none: true, id: "c" });
    const listing = await app.fetch(new Request("http://test/v1/keys?prefix=todo%2F"));
    const etag = listing.headers.get("etag")!;
    assert.deepEqual((await listing.json()).entries.map((entry: { key: string }) => entry.key), ["todo/a", "todo/b"]);
    const unchanged = await app.fetch(new Request("http://test/v1/keys?prefix=todo%2F", { headers: { "if-none-match": etag } }));
    assert.equal(unchanged.status, 304);
    const bulk = await app.fetch(new Request("http://test/v1/values/read", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys: ["todo/a", "todo/b"] }),
    }));
    assert.deepEqual((await bulk.json()).map((item: { value: unknown }) => item.value), [1, 2]);
    const current = await valueRequest(app, "GET", "todo/a");
    const currentEtag = (await current.json()).etag;
    assert.equal((await valueRequest(app, "DELETE", "todo/a", { match: currentEtag, id: "delete" })).status, 200);
  } finally { app.close(); }
});

Deno.test("transactions are all-or-nothing and idempotent", async () => {
  const app = createApp(":memory:");
  try {
    const a = await (await valueRequest(app, "PUT", "account/a", { value: 10, none: true, id: "a" })).json();
    const b = await (await valueRequest(app, "PUT", "account/b", { value: 20, none: true, id: "b" })).json();
    const send = (id: string, operations: unknown[]) => app.fetch(new Request("http://test/v1/transactions", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": id },
      body: JSON.stringify({ operations }),
    }));

    const conflict = await send("tx-conflict", [
      { type: "set", key: "account/a", value: 9, baseEtag: a.etag },
      { type: "set", key: "account/b", value: 21, baseEtag: "stale" },
    ]);
    assert.equal(conflict.status, 412);
    assert.equal((await (await valueRequest(app, "GET", "account/a")).json()).value, 10);
    assert.equal((await (await valueRequest(app, "GET", "account/b")).json()).value, 20);

    const committed = await send("tx-success", [
      { type: "set", key: "account/a", value: 9, baseEtag: a.etag },
      { type: "set", key: "account/b", value: 21, baseEtag: b.etag },
    ]);
    assert.equal(committed.status, 200);
    const result = await committed.json();
    assert.equal(Object.keys(result.etags).length, 2);
    assert.deepEqual(await (await send("tx-success", [
      { type: "set", key: "account/a", value: 9, baseEtag: a.etag },
      { type: "set", key: "account/b", value: 21, baseEtag: b.etag },
    ])).json(), result);
  } finally { app.close(); }
});

Deno.test("serves the built admin panel below /admin/", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.mkdir(`${directory}/assets`);
  await Deno.writeTextFile(`${directory}/index.html`, '<script src="/admin/assets/app.js"></script>');
  await Deno.writeTextFile(`${directory}/assets/app.js`, "console.log('admin')");
  const app = createApp(":memory:", new URL(`file://${directory}/`));
  try {
    const redirect = await app.fetch(new Request("http://test/admin", { redirect: "manual" }));
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get("location"), "/admin/");

    const index = await app.fetch(new Request("http://test/admin/"));
    assert.equal(index.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(await index.text(), /admin\/assets\/app\.js/);

    const deepLink = await app.fetch(new Request("http://test/admin/key/dividends%2Fcompanies%2Facme"));
    assert.equal(deepLink.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(await deepLink.text(), /admin\/assets\/app\.js/);

    const asset = await app.fetch(new Request("http://test/admin/assets/app.js"));
    assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    assert.equal(await asset.text(), "console.log('admin')");
  } finally {
    app.close();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("SQLite values survive reopening", async () => {
  const directory = await Deno.makeTempDir();
  const filename = `${directory}/kv.sqlite`;
  try {
    const first = createApp(filename);
    await valueRequest(first, "PUT", "persistent", { value: true, none: true, id: "p" });
    first.close();
    const second = createApp(filename);
    assert.deepEqual((await (await valueRequest(second, "GET", "persistent")).json()).value, true);
    second.close();
  } finally { await Deno.remove(directory, { recursive: true }); }
});
