/** Web Crypto conveniences with fallbacks for trusted HTTP origins such as a tailnet. */
export function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function sha256(data: ArrayBuffer): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
    return hex(hash);
  }
  return hex(sha256Fallback(new Uint8Array(data)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

// Small standards-based fallback for browsers that withhold SubtleCrypto from
// non-HTTPS origins. Payloads are already buffered because Blob.arrayBuffer() is
// required by the native digest path too.
function sha256Fallback(input: Uint8Array): Uint8Array {
  const constants = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength); padded.set(input); padded[input.length] = 0x80;
  const view = new DataView(padded.buffer); view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000)); view.setUint32(paddedLength - 4, bitLength >>> 0);
  const state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const words = new Uint32Array(64);
  const rotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15]!, y = words[index - 2]!;
      const s0 = rotate(x,7)^rotate(x,18)^(x>>>3), s1 = rotate(y,17)^rotate(y,19)^(y>>>10);
      words[index] = (words[index-16]! + s0 + words[index-7]! + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = state;
    for (let index = 0; index < 64; index++) {
      const s1=rotate(e!,6)^rotate(e!,11)^rotate(e!,25), choice=(e!&f!)^(~e!&g!);
      const first=(h!+s1+choice+constants[index]!+words[index]!)>>>0;
      const s0=rotate(a!,2)^rotate(a!,13)^rotate(a!,22), majority=(a!&b!)^(a!&c!)^(b!&c!);
      const second=(s0+majority)>>>0;
      h=g;g=f;f=e;e=(d!+first)>>>0;d=c;c=b;b=a;a=(first+second)>>>0;
    }
    state[0]=(state[0]!+a!)>>>0;state[1]=(state[1]!+b!)>>>0;state[2]=(state[2]!+c!)>>>0;state[3]=(state[3]!+d!)>>>0;
    state[4]=(state[4]!+e!)>>>0;state[5]=(state[5]!+f!)>>>0;state[6]=(state[6]!+g!)>>>0;state[7]=(state[7]!+h!)>>>0;
  }
  const output=new Uint8Array(32), outputView=new DataView(output.buffer);
  for(let index=0;index<state.length;index++)outputView.setUint32(index*4,state[index]!);
  return output;
}
