import { describe, expect, it, vi } from "vitest";
import { ConflictError, HttpTransport } from "../src/index.js";

const response = (body: unknown, init: ResponseInit = {}) => new Response(
  body === undefined ? undefined : JSON.stringify(body),
  { headers: { "content-type": "application/json" }, ...init },
);

describe("HttpTransport", () => {
  it("lists conditionally, reads values, and batch reads", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ entries: [{ key: "todo/a", etag: "e1" }], etag: "tree" }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(response({ value: 1, etag: "e1" }))
      .mockResolvedValueOnce(response([{ key: "todo/a", value: 1, etag: "e1" }]));
    const transport = new HttpTransport({ baseUrl: "https://example.test", fetch: request });
    expect((await transport.list("todo/")).entries).toHaveLength(1);
    expect(await transport.list("todo/", "tree")).toEqual({ entries: [], etag: "tree", notModified: true });
    expect(await transport.get("todo/a")).toEqual({ value: 1, etag: "e1" });
    expect(await transport.getMany(["todo/a"])).toHaveLength(1);
    expect(new Headers(request.mock.calls[1]?.[1]?.headers).get("if-none-match")).toBe('"tree"');
  });

  it("sends an idempotent transaction and maps conflicts", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ etags: { "todo/a": "e2" } }))
      .mockResolvedValueOnce(response({ error: "conflict" }, { status: 412 }));
    const transport = new HttpTransport({ baseUrl: "https://example.test", fetch: request, clientId: "client" });
    expect(await transport.transact({
      transactionId: "t1",
      operations: [{ type: "set", key: "todo/a", value: 2, baseEtag: "e1" }],
    })).toEqual({ etags: { "todo/a": "e2" } });
    const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
    expect(headers.get("idempotency-key")).toBe("t1");
    expect(headers.get("x-synckv-client-id")).toBe("client");
    await expect(transport.get("missing")).rejects.toBeInstanceOf(ConflictError);
  });

  it("opens a prefix-scoped SSE stream", () => {
    let instance: FakeEventSource | undefined;
    class FakeEventSource {
      onerror: ((event: Event) => void) | null = null;
      listener?: (event: Event) => void;
      closed = false;
      constructor(readonly url: string) { instance = this; }
      addEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
        if (typeof listener === "function") this.listener = listener;
      }
      close(): void { this.closed = true; }
    }
    const transport = new HttpTransport({
      baseUrl: "https://example.test",
      clientId: "c1",
      eventSource: FakeEventSource as unknown as typeof EventSource,
    });
    const invalidated = vi.fn();
    const stop = transport.listen(["todo/"], invalidated, vi.fn());
    instance?.listener?.(new MessageEvent("invalidate", { data: "todo/" }));
    expect(invalidated).toHaveBeenCalledWith("todo/");
    expect(instance?.url).toContain("prefix=todo%2F");
    stop();
    expect(instance?.closed).toBe(true);
  });
});
