/**
 * Workers AI embedding adapter (optional, phase 9).
 *
 * Embeds the *question* at request time with the multilingual `@cf/baai/bge-m3`
 * model. Document vectors are generated offline during ingestion, never here.
 */
import type { EmbeddingProvider } from "../../packages/domain/ports";
import type { AppEnv } from "../env";

export class WorkersAiEmbeddings implements EmbeddingProvider {
  constructor(
    private readonly ai: NonNullable<AppEnv["AI"]>,
    readonly model: string,
  ) {}

  async embed(text: string): Promise<number[]> {
    const out = (await this.ai.run(this.model, { text: [text] })) as { data?: number[][] };
    const vector = out?.data?.[0];
    if (!Array.isArray(vector) || vector.length === 0) throw new Error("Workers AI returned no embedding");
    return vector;
  }
}
