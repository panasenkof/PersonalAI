/** Pure parts of semantic search (п. 13): vectors of chunks, stored as
 * float32 BLOBs in `memory_vectors`, compared by cosine similarity. */
import { contentHash } from "./search-index";

/** paraphrase-multilingual-MiniLM-L12-v2: 384 dimensions, unit length. */
export const VECTOR_MODEL = "paraphrase-multilingual-minilm-l12-v2";
export const VECTOR_DIM = 384;

/**
 * Stable encrypted-DB namespace for a particular embedding space, not a UI
 * model name. Bump this contract whenever native weights, tokenizer, runtime
 * semantics or embeddingText preprocessing change. The Android and iOS weight
 * variants are intentionally distinct: restored backups must re-embed locally,
 * not compare vectors produced by different backends.
 *
 * This is a versioned MANIFEST ID, not a cryptographic checksum of downloaded
 * weights. Native artifact verification remains a separate acceptance gate.
 * Legacy rows under plain VECTOR_MODEL are left intact but are never read
 * by the active vector runner (lexical search works during reindex).
 */
export const VECTOR_SPACE_REVISION = "rnet-0.10.5|tokenizer-bundled-v1|title-text-trim-2000-v1";
export function vectorSpaceKey(platform: "android" | "ios"): string {
  const weights = platform === "ios" ? "coreml-fp16" : "xnnpack-8da4w";
  return [VECTOR_MODEL, "space-v1", weights, VECTOR_SPACE_REVISION, "dim-" + VECTOR_DIM].join("|");
}
export function isCurrentVectorSpace(value: string): boolean {
  return value === vectorSpaceKey("android") || value === vectorSpaceKey("ios");
}
/** Below this similarity a chunk is not «about» the question. MiniLM puts
 * unrelated Russian sentences around 0.1–0.35 and paraphrases above 0.5;
 * the value is checked on the phone with the question set (п. 13). */
export const MIN_SIMILARITY = 0.45;

/** What is embedded for a chunk: its record's title gives the context. */
export const embeddingText = (title: string | null, text: string): string =>
  [String(title || "").trim(), text.trim()].filter(Boolean).join("\n").slice(0, 2000);
/** A vector is current while its chunk text and record title are unchanged. */
export const embeddingHash = (title: string | null, text: string): string => contentHash(embeddingText(title, text));

export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}
export function fromBlob(blob: unknown): Float32Array | null {
  const bytes = blob instanceof Uint8Array ? blob : blob instanceof ArrayBuffer ? new Uint8Array(blob) : null;
  if (!bytes || bytes.byteLength % 4) return null;
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** Cosine similarity; works for unnormalised vectors too. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Reciprocal rank fusion: a record high in either list ranks high overall,
 * and one found by both ranks highest. k = 60 is the usual constant. */
export function fuseRanks(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) list.forEach((id, rank) => scores.set(id, (scores.get(id) || 0) + 1 / (k + rank + 1)));
  return scores;
}
