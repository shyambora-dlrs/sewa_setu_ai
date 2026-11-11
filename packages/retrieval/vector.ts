/**
 * Vector helpers for the optional semantic stage.
 *
 * Document vectors are stored L2-normalised and quantised to int8 (x*127) then
 * base64-encoded, cutting a 1024-dim vector from ~8 KB of JSON floats to ~1.4 KB.
 * Cosine similarity of normalised vectors is just a dot product.
 */

export function decodeInt8Base64(b64: string): Int8Array {
  const bin = atob(b64);
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24; // reinterpret byte as signed
  return out;
}

export function l2Normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

/** Cosine similarity between a normalised float query and an int8-quantised doc vector. */
export function cosineInt8(query: number[], doc: Int8Array): number {
  const n = Math.min(query.length, doc.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += query[i]! * doc[i]!;
  return dot / 127;
}

/** Quantises a normalised float vector (used by tests and the Python-compatible format). */
export function encodeInt8Base64(v: number[]): string {
  const bytes = new Uint8Array(v.length);
  v.forEach((x, i) => (bytes[i] = Math.max(-127, Math.min(127, Math.round(x * 127))) & 0xff));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
