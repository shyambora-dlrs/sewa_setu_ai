/**
 * Release management helpers used by the admin panel and monitoring:
 * list releases with their ingestion reports, and roll back `current.json`.
 *
 * Rollback only *moves the pointer* to another immutable release that already
 * exists and passed validation - no data is copied or deleted.
 */
import { AppError, NotFoundError, ValidationError } from "../../packages/domain/errors";
import { R2_KEYS, } from "../../packages/shared/constants";
import { CurrentPointer, Manifest } from "../../packages/shared/schemas";

const RELEASE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9TZ._-]{5,80}$/;

export interface ReleaseListing {
  release_id: string;
  active: boolean;
  generated_at: string | null;
  service_count: number | null;
  chunk_count: number | null;
  validation_status: string | null;
  report: unknown | null;
}

export class R2ReleaseAdmin {
  constructor(private readonly bucket: R2Bucket, private readonly now: () => Date = () => new Date()) {}

  async currentPointer(): Promise<{ pointer: CurrentPointer; etag: string } | null> {
    const obj = await this.bucket.get(R2_KEYS.current);
    if (!obj) return null;
    return { pointer: CurrentPointer.parse(JSON.parse(await obj.text())), etag: obj.etag };
  }

  /** Newest-first list of releases with extraction reports (ingestion logs). */
  async listReleases(limit = 10): Promise<ReleaseListing[]> {
    const listed = await this.bucket.list({ prefix: "releases/", delimiter: "/" });
    // Release ids start with a UTC timestamp, so lexical order == chronological order.
    const ids = listed.delimitedPrefixes.map((p) => p.slice("releases/".length, -1)).sort().reverse().slice(0, limit);
    const active = (await this.currentPointer())?.pointer.release_id;
    return Promise.all(
      ids.map(async (id): Promise<ReleaseListing> => {
        const prefix = R2_KEYS.releasePrefix(id);
        const [m, r] = await Promise.all([this.bucket.get(`${prefix}manifest.json`), this.bucket.get(`${prefix}reports/extraction-report.json`)]);
        const manifest = m ? Manifest.safeParse(JSON.parse(await m.text())) : null;
        return {
          release_id: id,
          active: id === active,
          generated_at: manifest?.success ? manifest.data.generated_at : null,
          service_count: manifest?.success ? manifest.data.service_count : null,
          chunk_count: manifest?.success ? manifest.data.chunk_count : null,
          validation_status: manifest?.success ? manifest.data.validation_status : null,
          report: r ? JSON.parse(await r.text()) : null,
        };
      }),
    );
  }

  /** Points `current.json` at an existing, validated release (rollback or roll-forward). */
  async activate(releaseId: string): Promise<CurrentPointer> {
    if (!RELEASE_ID_RE.test(releaseId)) throw new ValidationError("Invalid release id.");
    const manifestObj = await this.bucket.get(`${R2_KEYS.releasePrefix(releaseId)}manifest.json`);
    if (!manifestObj) throw new NotFoundError(`Release '${releaseId}' does not exist.`);
    const manifest = Manifest.parse(JSON.parse(await manifestObj.text()));
    if (manifest.validation_status !== "passed") throw new ValidationError("Refusing to activate a release that failed validation.");

    const cur = await this.currentPointer();
    const previous = [cur?.pointer.release_id, ...(cur?.pointer.previous_release_ids ?? [])]
      .filter((x): x is string => !!x && x !== releaseId)
      .slice(0, 5);
    const next: CurrentPointer = {
      release_id: releaseId,
      published_at: this.now().toISOString(),
      schema_version: manifest.schema_version,
      previous_release_ids: previous,
    };
    const put = await this.bucket.put(R2_KEYS.current, JSON.stringify(next), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: cur ? { etagMatches: cur.etag } : { etagDoesNotMatch: "*" },
    });
    if (!put) throw new AppError("internal_error", "The active release changed while rolling back; please retry.");
    return next;
  }
}
