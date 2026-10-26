import type { CollectionRecord, EntityRecord } from "./types";

/** Shared by request admission and the transaction that accepts its answer. */
export function enrichable(entity: EntityRecord, collection: CollectionRecord | undefined): boolean {
  return Boolean(collection) && collection!.sensitivity === "standard" && collection!.slug !== "documents" &&
    entity.record_status === "active" && entity.domain === "notes" &&
    (entity.sensitivity === "standard" || entity.sensitivity === "inherit");
}

/** Aliases t/e/c refer to terms, entity, collection. NULL legacy versions are pending. */
export const CURRENT_MODEL_TERMS = "(t.source_record_version=e.record_version AND t.source_collection_name=c.name)";

export type EnrichmentSnapshot = {
  entityId: string; recordVersion: number;
  collectionId: string; collectionName: string; collectionSlug: string;
  sensitivity: EntityRecord["sensitivity"];
};
