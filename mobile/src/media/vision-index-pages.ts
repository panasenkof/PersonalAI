/**
 * #83.2 — bounded, explicit, app-unlocked photo-index pass.
 *
 * NO second durable job queue. Every page discovers work directly from
 * memory_attachments + memory_attachment_vectors in the ONE SQLCipher DB.
 * Restart from cursor="" after app/process restart: unchanged completed
 * vectors are skipped; changed/missing ones re-enter the pass.
 *
 * Foreground-only API: call explicitly from a future gated UI or acceptance
 * harness. Do not run at startup, under AppLock or in the background.
 */
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from "../local-memory/storage";
import { fingerprintExtractionSource } from "../local-memory/extractions";
import { indexSavedPhoto83 } from "./vision-index-attachment";
import { readyNativeVisionModel83 } from "./vision-native-model";

export type PhotoIndexPageOptions = {
  afterId?: string;
  limit?: number;
  collectionId?: string;
  signal?: AbortSignal;
};
export type PhotoIndexPageResult = {
  modelSpace: string | null;
  nextCursor: string;
  hasMore: boolean;
  examined: number;
  alreadyCurrent: number;
  indexed: number;
  sourceChanged: number;
  failed: number;
  halted: "none" | "model_not_installed" | "model_changed" | "failed";
};

const ID = /^[a-zA-Z0-9-]{1,128}$/;
let pageRunning = false;
function guard(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("vision_index_cancelled");
  if (!localMemorySessionUnlocked()) throw new Error("application_locked");
}

/** Maximum 4 full-sized originals per explicit invocation. Do not build a
 * 5000-item JS queue, hold a SQLCipher transaction during native inference,
 * or call the model runner until original ACL and source checks succeed.
 */
export async function indexPhotoPage83(
  profile: string,
  options: PhotoIndexPageOptions = {},
): Promise<PhotoIndexPageResult> {
  if (!profile || profile.length > 160 ||
      (options.afterId != null && options.afterId !== "" && !ID.test(options.afterId)) ||
      (options.collectionId != null && !ID.test(options.collectionId)) ||
      (options.limit != null && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 4))) {
    throw new Error("vision_invalid_index_page");
  }
  if (pageRunning) throw new Error("vision_index_page_busy");
  guard(options.signal);
  pageRunning = true;
  const result: PhotoIndexPageResult = {
    modelSpace: null, nextCursor: options.afterId ?? "",
    hasMore: false, examined: 0, alreadyCurrent: 0, indexed: 0,
    sourceChanged: 0, failed: 0, halted: "none",
  };
  try {
    const model = await readyNativeVisionModel83();
    guard(options.signal);
    if (!model) return { ...result, halted: "model_not_installed" };
    result.modelSpace = model.modelSpace;
    const size = options.limit ?? 2;

    // Snapshot a tiny page of IDs + source metadata. No raw bytes or user
    // content returned, no new scan_cursor table or duplicate job queue.
    const rows = await withLocalMemoryDatabase(profile, db => db.getAllAsync<{
      attachmentId: string;
      indexedVersion: string | null;
    }>(
      `SELECT a.id AS attachmentId, v.source_version AS indexedVersion
         FROM memory_attachments a
         JOIN memory_entities e ON e.id=a.entity_id
         JOIN memory_collections c ON c.id=e.collection_id
         LEFT JOIN memory_attachment_vectors v
           ON v.attachment_id=a.id AND v.model=?
        WHERE a.id>? AND e.record_status='active' AND e.domain='notes'
          AND e.sensitivity IN ('standard','inherit') AND c.sensitivity='standard'
          AND a.mime IN ('image/jpeg','image/png','image/webp')
          ${options.collectionId ? "AND e.collection_id=?" : ""}
        ORDER BY a.id LIMIT ?`,
      options.collectionId
        ? [model.modelSpace, result.nextCursor, options.collectionId, size + 1]
        : [model.modelSpace, result.nextCursor, size + 1],
    ));
    result.hasMore = rows.length > size;

    for (const row of rows.slice(0, size)) {
      guard(options.signal);
      // Advance the in-memory cursor only after this row is handled. Failed
      // source stays retryable from the previous cursor; no hot retry loop.
      try {
        if (row.indexedVersion) {
          const current = await withLocalMemoryDatabase(profile, db =>
            fingerprintExtractionSource(db, row.attachmentId));
          guard(options.signal);
          if (row.indexedVersion === current) {
            result.examined++;
            result.alreadyCurrent++;
            result.nextCursor = row.attachmentId;
            continue;
          }
        }
        // A user may change the selected model while an index page is open.
        // Never present vectors from mixed model namespaces as one page.
        const stillSelected = await readyNativeVisionModel83();
        guard(options.signal);
        if (stillSelected?.modelSpace !== model.modelSpace) {
          result.halted = "model_changed";
          break;
        }
        const indexed = await indexSavedPhoto83(profile, row.attachmentId, options.signal);
        guard(options.signal);
        if (indexed.indexed && indexed.modelSpace !== model.modelSpace) {
          result.halted = "model_changed";
          break;
        }
        if (indexed.indexed) {
          result.indexed++;
        } else if (indexed.reason === "source_changed" ||
                   indexed.reason === "unsupported_format") {
          result.sourceChanged++;
        } else {
          // Model selection/download could change during the pass.
          result.halted = "model_not_installed";
          break;
        }
        result.examined++;
        result.nextCursor = row.attachmentId;
      } catch (error) {
        // AppLock and cancellation are security boundaries, not ordinary
        // per-photo failures. Never resume while the memory is locked.
        guard(options.signal);
        result.failed++;
        result.halted = "failed";
        break;
      }
    }
    return result;
  } finally {
    pageRunning = false;
  }
}
