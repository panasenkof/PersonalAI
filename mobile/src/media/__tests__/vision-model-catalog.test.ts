import { getVisionModel, parseVendorModelMetadata, VISION_MODELS } from "../vision-model-catalog";

const model = VISION_MODELS[0];
const rev = "a".repeat(40);
const sha = "b".repeat(64);
const entry = { type: "file", path: model.filename, lfs: { oid: sha, size: 388000000 } };

describe("vision model catalogue #83.2", () => {
  test("no text-only models and no deceptive accuracy label", () => {
    expect(VISION_MODELS).toHaveLength(3);
    expect(new Set(VISION_MODELS.map(m => m.id)).size).toBe(3);
    expect(VISION_MODELS.every(m => m.modalities.includes("image"))).toBe(true);
    expect(getVisionModel("missing")).toBeUndefined();
  });
  test("download is pinned to immutable revision and official file", () => {
    expect(parseVendorModelMetadata(model, rev, [entry])).toEqual({
      revision: rev, sha256: sha, bytes: 388000000,
      url: "https://huggingface.co/" + model.repo + "/resolve/" + rev + "/" + model.filename,
    });
  });
  test("fail closed for absent LFS digest, incorrect revision, oversized and wrong filename", () => {
    expect(() => parseVendorModelMetadata(model, "main", [entry])).toThrow("revision_invalid");
    expect(() => parseVendorModelMetadata(model, rev, [{ ...entry, path: "other.litertlm" }])).toThrow("model_missing");
    expect(() => parseVendorModelMetadata(model, rev, [{ ...entry, lfs: { size: 388000000 } }])).toThrow("vendor_hash");
    expect(() => parseVendorModelMetadata(model, rev, [{ ...entry, lfs: { oid: sha, size: 2_000_000_000 } }])).toThrow("vendor_size");
  });
});
