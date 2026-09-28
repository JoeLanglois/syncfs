import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId, sha256 } from "../src/crypto.js";

afterEach(() => vi.unstubAllGlobals());

describe("insecure-origin crypto fallbacks", () => {
  it("creates UUID-shaped IDs without randomUUID", () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => { bytes.fill(0xab); return bytes; } });
    expect(randomId()).toBe("abababab-abab-4bab-abab-abababababab");
  });

  it("hashes blobs without SubtleCrypto", async () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes });
    const bytes = new TextEncoder().encode("abc");
    expect(await sha256(bytes.buffer)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
