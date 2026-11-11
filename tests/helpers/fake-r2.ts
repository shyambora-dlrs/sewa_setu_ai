/**
 * Minimal in-memory R2Bucket fake for tests: get/put (with onlyIf etag
 * conditions)/list(prefix, delimiter). Only the surface used by the app is implemented.
 */
export class FakeR2Bucket {
  readonly store = new Map<string, { body: Uint8Array; etag: string }>();
  readonly reads: string[] = [];
  private counter = 0;

  async get(key: string) {
    this.reads.push(key);
    const e = this.store.get(key);
    if (!e) return null;
    const bytes = e.body;
    return {
      etag: e.etag,
      key,
      text: async () => new TextDecoder().decode(bytes),
      json: async () => JSON.parse(new TextDecoder().decode(bytes)),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }

  async put(key: string, value: string | ArrayBuffer, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
    const existing = this.store.get(key);
    const cond = opts?.onlyIf;
    if (cond?.etagMatches && existing?.etag !== cond.etagMatches) return null;
    if (cond?.etagDoesNotMatch) {
      if (cond.etagDoesNotMatch === "*" ? !!existing : existing?.etag === cond.etagDoesNotMatch) return null;
    }
    const body = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
    const etag = `etag-${++this.counter}`;
    this.store.set(key, { body, etag });
    return { key, etag };
  }

  async list(opts: { prefix?: string; delimiter?: string }) {
    const prefix = opts.prefix ?? "";
    const delimited = new Set<string>();
    const objects: { key: string }[] = [];
    for (const key of this.store.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const i = opts.delimiter ? rest.indexOf(opts.delimiter) : -1;
      if (i >= 0) delimited.add(prefix + rest.slice(0, i + 1));
      else objects.push({ key });
    }
    return { objects, delimitedPrefixes: [...delimited], truncated: false };
  }

  asBucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}
