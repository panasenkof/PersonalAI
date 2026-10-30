/** PersAI #83.2: vetted LiteRT-LM files; only models with a vision encoder.
 * These are alternative packaging/encoders of the same EmbeddingGemma 2 family,
 * NOT an evidence-based ranking of visual accuracy. The active image model has
 * its own versioned vector namespace, never the existing MiniLM text space.
 */
export type VisionModelId = "eg2-vision-440" | "eg2-vision-440-mt6991" | "eg2-omni-740";
export type VisionModelOption = Readonly<{
  id: VisionModelId;
  title: string;
  description: string;
  repo: string;
  filename: string;
  approxMB: number;
  optimizedFor?: string;
  modalities: readonly ("text" | "image" | "audio")[];
}>;
export const VISION_MODELS: readonly VisionModelOption[] = [
  {
    id: "eg2-vision-440", title: "EmbeddingGemma 2 · Фото",
    description: "Рекомендуется · текст и фотографии, уже проверена на Vivo X200 Pro",
    repo: "litert-community/embeddinggemma-2-text-vision-440m-litert-lm",
    filename: "embeddinggemma-2-text-vision-440m.litertlm",
    approxMB: 388, modalities: ["text", "image"],
  },
  {
    id: "eg2-vision-440-mt6991", title: "EmbeddingGemma 2 · MediaTek",
    description: "Вариант для Dimensity 9400 (MT6991). Больший файл не означает большую точность.",
    repo: "litert-community/embeddinggemma-2-text-vision-440m-litert-lm",
    filename: "embeddinggemma-2-text-vision-440m_MediaTek_MT6991.litertlm",
    approxMB: 798, optimizedFor: "MediaTek MT6991", modalities: ["text", "image"],
  },
  {
    id: "eg2-omni-740", title: "EmbeddingGemma 2 · Полная",
    description: "Текст, фото и аудио. Аудиопоиск — отдельный будущий этап, не более точный фотопоиск.",
    repo: "litert-community/embeddinggemma-2-740m-litert-lm",
    filename: "embeddinggemma-2-740m.litertlm",
    approxMB: 485, modalities: ["text", "image", "audio"],
  },
] as const;
export const getVisionModel = (id: string) => VISION_MODELS.find(m => m.id === id);
export const SHA256_HEX = /^[a-f0-9]{64}$/;
export const REVISION_HEX = /^[a-f0-9]{40}$/;
export type TrustedFileMetadata = { revision: string; sha256: string; bytes: number; url: string };

/** Require vendor-published LFS SHA-256 + immutable commit, never /resolve/main.
 * Model file bytes are verified locally before becoming selectable.
 */
export function parseVendorModelMetadata(option: VisionModelOption, revision: unknown, tree: unknown): TrustedFileMetadata {
  if (typeof revision !== "string" || !REVISION_HEX.test(revision)) throw new Error("revision_invalid");
  if (!Array.isArray(tree)) throw new Error("vendor_manifest_invalid");
  const entry = tree.find((x): x is Record<string, unknown> =>
    !!x && typeof x === "object" && !Array.isArray(x) && (x as {path?: unknown}).path === option.filename);
  if (!entry || entry.type !== "file") throw new Error("model_missing_from_vendor");
  const lfs = entry.lfs as { oid?: unknown; size?: unknown } | undefined;
  // Hugging Face tree API returns LFS oid as SHA-256 for its object bytes.
  if (!lfs || typeof lfs.oid !== "string" || !SHA256_HEX.test(lfs.oid)) throw new Error("vendor_hash_unavailable");
  if (typeof lfs.size !== "number" || !Number.isSafeInteger(lfs.size) || lfs.size < 50 * 1024 * 1024 || lfs.size > 1_500_000_000)
    throw new Error("vendor_size_invalid");
  const url = "https://huggingface.co/" + option.repo + "/resolve/" + revision + "/" + option.filename;
  return { revision, sha256: lfs.oid, bytes: lfs.size, url };
}
