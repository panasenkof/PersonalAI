/**
 * Passwordless, portable encrypted SQLCipher backup.
 *
 * A fresh 256-bit recovery code is the only secret needed to decrypt an
 * exported file. Never export plaintext JSON/SQLite or the device key.
 * SQLCipher's ATTACH KEY + sqlcipher_export reencrypts the source in the
 * native library under the independent recovery code. Restore is atomic and
 * refuses to overwrite existing local memory.
 */
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type * as SQLite from "expo-sqlite";

import { LOCAL_MEMORY_SCHEMA_VERSION, withLocalMemoryDatabase } from "./storage";
import { withUnlockedTransaction } from "./transaction";
import { reindexAll } from "./search-index";

const CODE_PATTERN = /^[a-f0-9]{64}$/;
/** The records themselves, present in every version (v1–v3). */
const TEMPORAL_TABLES = [
  "memory_temporal_claims", "memory_temporal_evidence",
  "memory_temporal_proposals", "memory_temporal_decisions",
] as const;
const BACKUP_TABLES = [
  "memory_collections", "memory_entities", "memory_observations",
  "memory_relations", "memory_revisions",
] as const;
/** v3 user data; chunks, the search index and vectors are rebuilt instead. */
const V3_TABLES = {
  memory_aliases: "entity_id,alias,normalized",
  memory_index_terms: "entity_id,terms,source,created_at",
} as const;
const USER_SEARCH_TABLES = Object.keys(V3_TABLES) as Array<keyof typeof V3_TABLES>;
const ENTITY_COLUMNS = "id,collection_id,domain,schema_version,title,payload_json,record_status,sensitivity," +
  "source_kind,source_ref,valid_from,valid_until,created_at,updated_at,record_version";
export const RESTORABLE_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
const LEGACY_MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;
const MANIFEST_FORMAT_VERSION = 8;
const MANIFEST_TABLE = 'persai_backup_manifest' as const;
const LEGACY_MAX_RESTORABLE_ENTITIES = 100000;
const TEMP_STORAGE_RESERVE_BYTES = 64 * 1024 * 1024;

type BackupCounts = { entities: number; collections: number; observations: number;
  attachments: number; attachment_parts: number; receipts: number; chats: number };
type TemporalCounts = { temporal_claims: number; temporal_evidence: number;
  temporal_proposals: number; temporal_decisions: number };
type RelationCounts = { relation_links: number; relation_evidence: number };
type ReviewCounts = { review_actions: number };
type ProposalCounts = { review_proposals: number };
type ProfileSelfCounts = {profile_self_binding:number};
const profileSelfCountsQuery=(prefix:""|"pia_export."|"pia_import.")=>
  "SELECT (SELECT count(*) FROM "+prefix+"memory_profile_self) AS profile_self_binding";
const validProfileSelfCounts=(v:ProfileSelfCounts)=>Number.isSafeInteger(v.profile_self_binding)&&
  v.profile_self_binding>=0&&v.profile_self_binding<=1;
type BackupManifest = BackupCounts & Partial<TemporalCounts> & Partial<RelationCounts> & Partial<ReviewCounts> & Partial<ProposalCounts> & Partial<ProfileSelfCounts> &
  { format_version: number; schema_version: number };
const COUNT_TABLES = {
  entities: "memory_entities", collections: "memory_collections",
  observations: "memory_observations", attachments: "memory_attachments",
  attachment_parts: "memory_attachment_parts",
  receipts: "memory_received_shares", chats: "direct_conversations",
} as const;
const COUNT_KEYS = Object.keys(COUNT_TABLES) as Array<keyof BackupCounts>;
const TEMPORAL_COUNT_TABLES = {
  temporal_claims: "memory_temporal_claims", temporal_evidence: "memory_temporal_evidence",
  temporal_proposals: "memory_temporal_proposals", temporal_decisions: "memory_temporal_decisions",
} as const;
const TEMPORAL_COUNT_KEYS = Object.keys(TEMPORAL_COUNT_TABLES) as Array<keyof TemporalCounts>;
const RELATION_COUNT_TABLES = {
  relation_links: "memory_relations", relation_evidence: "memory_relation_evidence",
} as const;
const RELATION_COUNT_KEYS = Object.keys(RELATION_COUNT_TABLES) as Array<keyof RelationCounts>;
const reviewCountsQuery=(prefix:""|"pia_import."|"pia_export.")=>
  "SELECT (SELECT count(*) FROM "+prefix+"memory_review_actions) AS review_actions";
const validReviewCounts=(v:ReviewCounts)=>Number.isSafeInteger(v.review_actions)&&v.review_actions>=0;
const proposalCountsQuery=(prefix:""|"pia_export."|"pia_import.")=>
  "SELECT (SELECT count(*) FROM "+prefix+"memory_review_proposals) AS review_proposals";
const validProposalCounts=(v:ProposalCounts)=>Number.isSafeInteger(v.review_proposals)&&v.review_proposals>=0;
function relationCountsQuery(prefix: "" | "pia_import." | "pia_export."): string {
  return "SELECT " + RELATION_COUNT_KEYS.map(k =>
    "(SELECT count(*) FROM " + prefix + RELATION_COUNT_TABLES[k] + ") AS " + k).join(", ");
}
function validRelationCounts(counts: RelationCounts): boolean {
  return RELATION_COUNT_KEYS.every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0);
}
function relationCountValues(counts: RelationCounts): number[] {
  return RELATION_COUNT_KEYS.map(k => counts[k]);
}

function temporalCountsQuery(prefix: "" | "pia_import." | "pia_export."): string {
  return "SELECT " + TEMPORAL_COUNT_KEYS.map(k =>
    "(SELECT count(*) FROM " + prefix + TEMPORAL_COUNT_TABLES[k] + ") AS " + k).join(", ");
}
function validTemporalCounts(counts: TemporalCounts): boolean {
  return TEMPORAL_COUNT_KEYS.every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0);
}
function temporalCountValues(counts: TemporalCounts): number[] {
  return TEMPORAL_COUNT_KEYS.map(k => counts[k]);
}
function backupCountsQuery(prefix: "" | "pia_import." | "pia_export."): string {
  // These identifiers are constants, never interpolated user input.
  return "SELECT " + COUNT_KEYS.map(k =>
    "(SELECT count(*) FROM " + prefix + COUNT_TABLES[k] + ") AS " + k).join(", ");
}
function validBackupCounts(counts: BackupCounts): boolean {
  return COUNT_KEYS.every(k => Number.isSafeInteger(counts[k]) && counts[k] >= 0);
}
function backupCountValues(counts: BackupCounts): number[] {
  return COUNT_KEYS.map(k => counts[k]);
}


/**
 * Conservative admission guard for the legacy single-file format. Free space
 * may change during an operation; SQLite rollback and cleanup remain required.
 */
async function requireTemporarySpace(estimatedBytes: number, multiplier: number): Promise<void> {
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes <= 0) {
    throw new Error("backup_preflight_unavailable");
  }
  let freeBytes: number;
  try {
    freeBytes = await FileSystem.getFreeDiskStorageAsync();
  } catch {
    throw new Error("backup_storage_unavailable");
  }
  if (!Number.isSafeInteger(freeBytes) || freeBytes < 0) {
    throw new Error("backup_storage_unavailable");
  }
  if (freeBytes < Math.ceil(estimatedBytes * multiplier) + TEMP_STORAGE_RESERVE_BYTES) {
    throw new Error("backup_insufficient_space");
  }
}

/** Refuse to export a backup which exceeds the format's restore contract. */
async function preflightExport(db: SQLite.SQLiteDatabase): Promise<void> {
  const count = await db.getFirstAsync<{ n: number }>("SELECT count(*) AS n FROM memory_entities");
  if (!count || !Number.isSafeInteger(count.n) || count.n < 0) {
    throw new Error("backup_preflight_unavailable");
  }
  // Current exports are format-verified; the 100k cap applies to old incoming files only.
  const pages = await db.getFirstAsync<{ page_count: number }>("PRAGMA page_count");
  const pageSize = await db.getFirstAsync<{ page_size: number }>("PRAGMA page_size");
  if (!pages || !pageSize || !Number.isSafeInteger(pages.page_count) ||
      !Number.isSafeInteger(pageSize.page_size) || pages.page_count <= 0 || pageSize.page_size <= 0) {
    throw new Error("backup_preflight_unavailable");
  }
  const estimatedBytes = pages.page_count * pageSize.page_size;
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes <= 0) {
    throw new Error("backup_preflight_unavailable");
  }
  // Export may have encryption overhead. Its actual size is rechecked after writing.
  await requireTemporarySpace(estimatedBytes, 1.25);
}

function checkedRecoveryCode(value: string): string {
  const code = value.trim().toLowerCase();
  if (!CODE_PATTERN.test(code)) throw new Error("invalid_recovery_code");
  return code;
}

export function createRecoveryCode(): string {
  return Array.from(Crypto.getRandomBytes(32), byte => byte.toString(16).padStart(2, "0")).join("");
}

function temporaryPath(): string {
  if (!FileSystem.cacheDirectory) throw new Error("backup_cache_unavailable");
  return FileSystem.cacheDirectory + "pia-encrypted-" + Crypto.randomUUID() + ".db";
}

async function forgetTemporaryFile(path: string): Promise<void> {
  await Promise.all([
    path, path + "-wal", path + "-shm", path + "-journal",
  ].map(uri => FileSystem.deleteAsync(uri, { idempotent: true })));
}

async function detach(db: SQLite.SQLiteDatabase, alias: "pia_export" | "pia_import"): Promise<void> {
  await db.execAsync("DETACH DATABASE " + alias);
}

function nativeSqlitePath(fileUri: string): string {
  // Expo FileSystem returns file:///... URIs, but Expo SQLite opens native
  // databases with POSIX filesystem paths. SQLCipher ATTACH must receive
  // the actual path, not rely on SQLite having URI-filename support enabled.
  if (!fileUri.startsWith("file:///")) throw new Error("invalid_private_backup_path");
  const path = decodeURIComponent(fileUri.slice("file://".length));
  if (!path.startsWith("/") || path.includes("\\0")) {
    throw new Error("invalid_private_backup_path");
  }
  return path;
}

async function attach(db: SQLite.SQLiteDatabase, alias: "pia_export" | "pia_import", fileUri: string, code: string) {
  // Values are bound to the native statement; never concatenate a user path
  // or recovery code into SQL. Identifiers are fixed literals.
  await db.runAsync("ATTACH DATABASE ? AS " + alias + " KEY ?", [nativeSqlitePath(fileUri), code]);
}

export async function shareEncryptedBackup(profileId: string, recoveryCode: string): Promise<void> {
  const code = checkedRecoveryCode(recoveryCode);
  if (!await Sharing.isAvailableAsync()) throw new Error("backup_sharing_unavailable");
  const path = temporaryPath();
  let attached = false;
  try {
    await withLocalMemoryDatabase(profileId, async db => {
      try {
        await preflightExport(db);
        await attach(db, "pia_export", path, code);
        attached = true;
        // sqlcipher_export copies *all* memory, provenance, relations,
        // revisions, names and the encrypted index without passing plaintext to JS.
        await db.getFirstAsync("SELECT sqlcipher_export('pia_export')");
        await db.execAsync(`PRAGMA pia_export.user_version = ${LOCAL_MEMORY_SCHEMA_VERSION}`);
        // The manifest lives INSIDE SQLCipher ciphertext. No plaintext sidecar.
        await db.execAsync("CREATE TABLE pia_export.persai_backup_manifest (" +
          "format_version INTEGER PRIMARY KEY CHECK(format_version=8), schema_version INTEGER NOT NULL," +
          "entities INTEGER NOT NULL, collections INTEGER NOT NULL, observations INTEGER NOT NULL," +
          "attachments INTEGER NOT NULL, attachment_parts INTEGER NOT NULL," +
          "receipts INTEGER NOT NULL, chats INTEGER NOT NULL," +
          "temporal_claims INTEGER NOT NULL, temporal_evidence INTEGER NOT NULL," +
          "temporal_proposals INTEGER NOT NULL, temporal_decisions INTEGER NOT NULL," +
          "relation_links INTEGER NOT NULL, relation_evidence INTEGER NOT NULL," +
          "review_actions INTEGER NOT NULL,review_proposals INTEGER NOT NULL,"+
          "profile_self_binding INTEGER NOT NULL CHECK(profile_self_binding BETWEEN 0 AND 1))");
        const counts = await db.getFirstAsync<BackupCounts>(backupCountsQuery("pia_export."));
        if (!counts || !validBackupCounts(counts)) throw new Error("backup_manifest_unavailable");
        const temporalCounts = await db.getFirstAsync<TemporalCounts>(temporalCountsQuery("pia_export."));
        if (!temporalCounts || !validTemporalCounts(temporalCounts)) throw new Error("backup_manifest_unavailable");
        const relationCounts = await db.getFirstAsync<RelationCounts>(relationCountsQuery("pia_export."));
        if (!relationCounts || !validRelationCounts(relationCounts)) throw new Error("backup_manifest_unavailable");
        const reviewCounts = await db.getFirstAsync<ReviewCounts>(reviewCountsQuery("pia_export."));
        if (!reviewCounts || !validReviewCounts(reviewCounts)) throw new Error("backup_manifest_unavailable");
        const proposalCounts=await db.getFirstAsync<ProposalCounts>(proposalCountsQuery("pia_export."));
        if(!proposalCounts||!validProposalCounts(proposalCounts))throw new Error("backup_manifest_unavailable");
        const selfCounts=await db.getFirstAsync<ProfileSelfCounts>(profileSelfCountsQuery("pia_export."));
        if(!selfCounts||!validProfileSelfCounts(selfCounts))throw new Error("backup_manifest_unavailable");
        await db.runAsync(
          "INSERT INTO pia_export.persai_backup_manifest " +
            "(format_version,schema_version,entities,collections,observations,attachments,attachment_parts,receipts,chats," +
            "temporal_claims,temporal_evidence,temporal_proposals,temporal_decisions," +
            "relation_links,relation_evidence,review_actions,review_proposals,profile_self_binding) " +
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          [MANIFEST_FORMAT_VERSION, LOCAL_MEMORY_SCHEMA_VERSION, ...backupCountValues(counts),
            ...temporalCountValues(temporalCounts), ...relationCountValues(relationCounts), reviewCounts.review_actions,proposalCounts.review_proposals,selfCounts.profile_self_binding],
        );
        const cipherIntegrity = await db.getFirstAsync<{ integrity_check: string }>(
          "PRAGMA pia_export.integrity_check",
        );
        if (cipherIntegrity?.integrity_check !== "ok") throw new Error("backup_integrity_check_failed");
        const check = await db.getFirstAsync<{ n: number }>(
          "SELECT count(*) AS n FROM pia_export.memory_collections",
        );
        if (!check || check.n < 0) throw new Error("backup_integrity_check_failed");
      } finally {
        if (attached) {
          attached = false;
          await detach(db, "pia_export");
        }
      }
    });
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists || info.isDirectory || !info.size) throw new Error("backup_file_missing");
    if (!Number.isSafeInteger(info.size)) throw new Error("invalid_backup_size");
    // The shared file is SQLCipher ciphertext; code must be stored
    // separately and never included in the name or exported file.
    await Sharing.shareAsync(path, {
      mimeType: "application/octet-stream",
      dialogTitle: "Сохранить зашифрованную резервную копию PersAI",
    });
  } finally {
    await forgetTemporaryFile(path);
  }
}

export type BackupRestoreStats = {
  collections: number; entities: number; observations: number;
};

export async function restoreEncryptedBackup(
  profileId: string, sourceUri: string, recoveryCode: string,
): Promise<BackupRestoreStats> {
  const code = checkedRecoveryCode(recoveryCode);
  if (!sourceUri || !/^(content|file):\/\//.test(sourceUri)) throw new Error("invalid_backup_uri");
  const path = temporaryPath();
  try {
    // Inspect content:// providers before filling private cache.
    const sourceInfo = await FileSystem.getInfoAsync(sourceUri);
    if (!sourceInfo.exists || sourceInfo.isDirectory || !Number.isSafeInteger(sourceInfo.size) ||
        sourceInfo.size <= 0) {
      throw new Error("invalid_backup_size");
    }
    // Source copy plus destination pages, WAL and regenerated search index.
    await requireTemporarySpace(sourceInfo.size, 3);
    await FileSystem.copyAsync({ from: sourceUri, to: path });
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists || info.isDirectory || !Number.isSafeInteger(info.size) || !info.size) {
      throw new Error("invalid_backup_size");
    }
    // A malicious/buggy content provider may truncate the stream during copy.
    // Never treat a partial cache file as a valid archive.
    if (info.size !== sourceInfo.size) throw new Error("backup_source_size_mismatch");
    return await withLocalMemoryDatabase(profileId, async db => {
      let attached = false;
      try {
        await attach(db, "pia_import", path, code);
        attached = true;
        // Wrong key throws from sqlite_master lookup, before any target write.
        const schema = await db.getAllAsync<{ name: string }>(
          "SELECT name FROM pia_import.sqlite_master WHERE type = 'table'",
        );
        const available = new Set(schema.map(row => row.name));
        if (!BACKUP_TABLES.every(table => available.has(table))) {
          throw new Error("incompatible_backup_schema");
        }
        const version = await db.getFirstAsync<{ user_version: number }>("PRAGMA pia_import.user_version");
        // v2 added chats, v3 record types, names and index words. Every older
        // backup restores into the current schema; the search index is rebuilt.
        if (!version || !RESTORABLE_VERSIONS.includes(version.user_version) || version.user_version > LOCAL_MEMORY_SCHEMA_VERSION) {
          throw new Error("incompatible_backup_version");
        }
        // Names and manually entered search words are user data since v3,
        // not disposable search projections. A missing table is a corrupt
        // backup; never silently import records without their metadata.
        if (version.user_version >= 3 &&
            !USER_SEARCH_TABLES.every(table => available.has(table))) {
          throw new Error("incompatible_backup_schema");
        }
        // A v7 archive must carry the user-owned Android Share receipts.
        if (version.user_version >= 7 && !available.has("memory_received_shares")) {
          throw new Error("incompatible_backup_schema");
        }
        // V9 extraction evidence is first-class USER DATA, not a derived index.
        // A broken/partial archive must not silently drop a transcript and
        // its exact source location, even if base manifest counts still match.
        if (version.user_version >= 9 && (!available.has("memory_extractions") ||
             !available.has("memory_extraction_segments"))) {
          throw new Error("incompatible_backup_schema");
        }
        if (version.user_version >= 11 && (!available.has(MANIFEST_TABLE) ||
            !TEMPORAL_TABLES.every(table => available.has(table)))) {
          throw new Error("incompatible_backup_schema");
        }
        if (version.user_version >= 12 && !available.has("memory_relation_evidence")) {
          throw new Error("incompatible_backup_schema");
        }
        if (version.user_version >= 13 && !available.has("memory_review_actions")) {
          throw new Error("incompatible_backup_schema");
        }
        if(version.user_version>=14&&!available.has("memory_review_proposals"))
          throw new Error("incompatible_backup_schema");
        if(version.user_version>=17&&!available.has("memory_profile_self"))
          throw new Error("incompatible_backup_schema");
        // Validate the *source* before any destination writes. A forged
        // SQLCipher file with the right table names can still have corruption.
        const integrity = await db.getFirstAsync<{ integrity_check: string }>(
          "PRAGMA pia_import.integrity_check",
        );
        if (integrity?.integrity_check !== "ok") throw new Error("invalid_backup_integrity");
        const badReference = await db.getFirstAsync("PRAGMA pia_import.foreign_key_check");
        if (badReference !== null) throw new Error("invalid_backup_references");
        const incoming = await db.getFirstAsync<{ n: number }>(
          "SELECT count(*) AS n FROM pia_import.memory_entities",
        );
        if (!incoming || !Number.isSafeInteger(incoming.n) || incoming.n < 0) {
          throw new Error("invalid_backup_records");
        }
        let verifiedCounts: BackupCounts | null = null;
        let verifiedTemporal: TemporalCounts | null = null;
        let verifiedRelations: RelationCounts | null = null;
        let verifiedReview: ReviewCounts | null = null;
        let verifiedProposal: ProposalCounts | null = null;
        let verifiedSelf: ProfileSelfCounts | null = null;
        if (available.has(MANIFEST_TABLE)) {
          const manifest = await db.getFirstAsync<BackupManifest>(
            "SELECT * FROM pia_import.persai_backup_manifest",
          );
          const manifestRows = await db.getFirstAsync<{ n: number }>(
            "SELECT count(*) AS n FROM pia_import.persai_backup_manifest",
          );
          if (manifestRows?.n !== 1 || !manifest ||
              manifest.schema_version !== version.user_version || !validBackupCounts(manifest) ||
              manifest.format_version !== (version.user_version >= 17 ? 8 : version.user_version >= 16 ? 7 : version.user_version >= 15 ? 6 : version.user_version >= 14 ? 5 : version.user_version >= 13 ? 4 : version.user_version >= 12 ? 3 : version.user_version >= 11 ? 2 : 1)) {
            throw new Error("backup_manifest_invalid");
          }
          const actual = await db.getFirstAsync<BackupCounts>(backupCountsQuery("pia_import."));
          if (!actual || !validBackupCounts(actual) ||
              backupCountValues(manifest).some((n, i) => n !== backupCountValues(actual)[i])) {
            throw new Error("backup_manifest_mismatch");
          }
          verifiedCounts = actual;
          if (version.user_version >= 11) {
            const actualTemporal = await db.getFirstAsync<TemporalCounts>(temporalCountsQuery("pia_import."));
            if (!actualTemporal || !validTemporalCounts(actualTemporal) ||
                !TEMPORAL_COUNT_KEYS.every(k => manifest[k] === actualTemporal[k])) {
              throw new Error("backup_manifest_mismatch");
            }
            verifiedTemporal = actualTemporal;
          }
          if (version.user_version >= 12) {
            const actualRelations = await db.getFirstAsync<RelationCounts>(relationCountsQuery("pia_import."));
            if (!actualRelations || !validRelationCounts(actualRelations) ||
                !RELATION_COUNT_KEYS.every(k => manifest[k] === actualRelations[k])) {
              throw new Error("backup_manifest_mismatch");
            }
            verifiedRelations = actualRelations;
          }
          if(version.user_version>=13){
            const actualReview=await db.getFirstAsync<ReviewCounts>(reviewCountsQuery("pia_import."));
            if(!actualReview||!validReviewCounts(actualReview)||manifest.review_actions!==actualReview.review_actions)
              throw new Error("backup_manifest_mismatch");
            verifiedReview=actualReview;
          }
          if(version.user_version>=14){
            const actualProposals=await db.getFirstAsync<ProposalCounts>(proposalCountsQuery("pia_import."));
            if(!actualProposals||!validProposalCounts(actualProposals)||
               manifest.review_proposals!==actualProposals.review_proposals)
              throw new Error("backup_manifest_mismatch");
            verifiedProposal=actualProposals;
          }
          if(version.user_version>=17){
            const actualSelf=await db.getFirstAsync<ProfileSelfCounts>(profileSelfCountsQuery("pia_import."));
            if(!actualSelf||!validProfileSelfCounts(actualSelf)||
               manifest.profile_self_binding!==actualSelf.profile_self_binding)
              throw new Error("backup_manifest_mismatch");
            verifiedSelf=actualSelf;
          }
        } else if (incoming.n > LEGACY_MAX_RESTORABLE_ENTITIES ||
                   info.size > LEGACY_MAX_BACKUP_BYTES) {
          throw new Error("backup_legacy_limit_without_manifest");
        }
        // A current profile may already contain chats even when its memory
        // collections are empty. Silently ignoring colliding chat IDs would
        // lose backed-up conversation content; refuse before any destination write.
        if (available.has("direct_conversations")) {
          const duplicates = await db.getFirstAsync<{ n: number }>(
            "SELECT count(*) AS n FROM pia_import.direct_conversations incoming " +
            "JOIN main.direct_conversations current ON current.id=incoming.id",
          );
          if (!duplicates || !Number.isSafeInteger(duplicates.n)) throw new Error("backup_chat_preflight_unavailable");
          if (duplicates.n > 0) throw new Error("backup_chat_conflict");
        }
        // Roll back *all* copied records if any table, FK or FTS operation
        // fails. Never replace a profile containing existing memory.
        // ATTACH and the SQLCipher key are scoped to this unlocked connection.
        // Expo's exclusiveTransaction opens a DIFFERENT, still-locked DB.
        await withUnlockedTransaction(db, async tx => {
          const oldChats = verifiedCounts ? await tx.getFirstAsync<{ n: number }>(
            "SELECT count(*) AS n FROM direct_conversations") : null;
          const existing = await tx.getFirstAsync<{ n: number }>(
            "SELECT count(*) AS n FROM memory_collections",
          );
          if (existing?.n !== 0) throw new Error("restore_requires_empty_memory");
          const entityColumns = await tx.getAllAsync<{ name: string }>("PRAGMA pia_import.table_info(memory_entities)");
          const typed = entityColumns.some(c => c.name === "kind");
          for (const table of BACKUP_TABLES) {
            // Named columns: v3 added «kind», and the type check rejects unknown values.
            const sql = table === "memory_entities"
              ? `INSERT INTO memory_entities(${ENTITY_COLUMNS}${typed ? ",kind" : ""}) SELECT ${ENTITY_COLUMNS}${typed ? ",kind" : ""} FROM pia_import.memory_entities`
              : `INSERT INTO ${table} SELECT * FROM pia_import.${table}`;
            // table is a constant, never user-controlled.
            await tx.execAsync(sql);
          }
          if (!typed) await tx.execAsync("UPDATE memory_entities SET kind='person' WHERE collection_id IN (SELECT id FROM memory_collections WHERE slug='people')");
          if(version.user_version>=17){
            // Profile identity is user-owned ciphertext metadata, not a rebuilt alias.
            // Import after its person FK exists; a malformed binding aborts all.
            await tx.execAsync("INSERT INTO memory_profile_self(slot,person_id,binding_version,actor_kind,updated_at) "+
              "SELECT slot,person_id,binding_version,actor_kind,updated_at FROM pia_import.memory_profile_self");
            const actual=await tx.getFirstAsync<ProfileSelfCounts>(profileSelfCountsQuery(""));
            if(!actual||!validProfileSelfCounts(actual)||
               actual.profile_self_binding!==verifiedSelf?.profile_self_binding)
              throw new Error("backup_profile_self_count_mismatch");
          }
          for (const [table, columns] of Object.entries(V3_TABLES)) {
            // Old v1/v2 archives did not have these tables. From v3 onward
            // both are mandatory, already checked before touching the target.
            if (!available.has(table)) continue;
            const sourceRows = await tx.getFirstAsync<{ n: number }>(
              `SELECT count(*) AS n FROM pia_import.${table}`);
            if (!sourceRows || !Number.isSafeInteger(sourceRows.n) || sourceRows.n < 0)
              throw new Error("backup_user_metadata_count_unavailable");
            const copyColumns = table === "memory_index_terms" && version.user_version >= 6
              ? columns + ",source_record_version,source_collection_name" : columns;
            await tx.execAsync(`INSERT INTO ${table}(${copyColumns}) SELECT ${copyColumns} FROM pia_import.${table}`);
            const importedRows = await tx.getFirstAsync<{ n: number }>(
              `SELECT count(*) AS n FROM ${table}`);
            if (!importedRows || importedRows.n !== sourceRows.n)
              throw new Error("backup_user_metadata_count_mismatch");
          }
          if (version.user_version >= 4) {
            for (const table of ["memory_attachments", "memory_attachment_parts"] as const) {
              if (!available.has(table)) throw new Error("incompatible_backup_schema");
              await tx.execAsync(`INSERT INTO ${table} SELECT * FROM pia_import.${table}`);
            }
          }
          if (version.user_version >= 9) {
            // Parents/parts were copied above. Preserve all attempts and
            // location records exactly; the source original is immutable.
            await tx.execAsync("INSERT INTO memory_extractions SELECT * FROM pia_import.memory_extractions");
            await tx.execAsync("INSERT INTO memory_extraction_segments SELECT * FROM pia_import.memory_extraction_segments");
            for (const table of ["memory_extractions", "memory_extraction_segments"] as const) {
              const expected = await tx.getFirstAsync<{ n:number }>(
                "SELECT count(*) AS n FROM pia_import." + table);
              const actual = await tx.getFirstAsync<{ n:number }>(
                "SELECT count(*) AS n FROM " + table);
              if (!expected || !actual || expected.n!==actual.n) {
                throw new Error("backup_extraction_count_mismatch");
              }
            }
          }
          if (version.user_version >= 11) {
            // Claims, their evidence, review proposals and decision history
            // are user-owned. Restore in FK order, never rebuild from LLM.
            for (const table of TEMPORAL_TABLES) {
              await tx.execAsync("INSERT INTO " + table + " SELECT * FROM pia_import." + table);
              const expected = await tx.getFirstAsync<{ n: number }>(
                "SELECT count(*) AS n FROM pia_import." + table);
              const actual = await tx.getFirstAsync<{ n: number }>(
                "SELECT count(*) AS n FROM " + table);
              if (!expected || !actual || expected.n !== actual.n) {
                throw new Error("backup_temporal_count_mismatch");
              }
            }
          }
          if (version.user_version >= 12) {
            // The relation itself is already restored from BACKUP_TABLES;
            // import its user-owned, versioned witnesses after those FK parents.
            if(version.user_version>=13) {
              await tx.execAsync("INSERT INTO memory_relation_evidence SELECT * FROM pia_import.memory_relation_evidence");
            } else {
              // v12 ciphertext predates decision_version: default remains 1.
              await tx.execAsync("INSERT INTO memory_relation_evidence " +
                "(id,relation_id,evidence_entity_id,evidence_record_version,source_record_version," +
                "target_record_version,quote,origin,actor_kind,state,created_at) " +
                "SELECT id,relation_id,evidence_entity_id,evidence_record_version,source_record_version," +
                "target_record_version,quote,origin,actor_kind,state,created_at FROM pia_import.memory_relation_evidence");
            }
            const expected = await tx.getFirstAsync<{ n: number }>(
              "SELECT count(*) AS n FROM pia_import.memory_relation_evidence");
            const actual = await tx.getFirstAsync<{ n: number }>(
              "SELECT count(*) AS n FROM memory_relation_evidence");
            if (!expected || !actual || expected.n !== actual.n) {
              throw new Error("backup_relation_count_mismatch");
            }
          }
          if(version.user_version>=14){
            // Restore source-bound proposals BEFORE their v15 journal references.
            await tx.execAsync("INSERT INTO memory_review_proposals SELECT * FROM pia_import.memory_review_proposals");
            const expected=await tx.getFirstAsync<{n:number}>(
              "SELECT count(*) AS n FROM pia_import.memory_review_proposals");
            const actual=await tx.getFirstAsync<{n:number}>(
              "SELECT count(*) AS n FROM memory_review_proposals");
            if(!expected||!actual||expected.n!==actual.n)
              throw new Error("backup_review_proposal_count_mismatch");
          }
          if(version.user_version>=13){
            if(version.user_version>=16){
              await tx.execAsync("INSERT INTO memory_review_actions SELECT * FROM pia_import.memory_review_actions");
            }else{
              // v13/v14 immutable history had no review_proposal_id. The new
              // column defaults NULL; exact IDs and undo references survive.
              await tx.execAsync(
                "INSERT INTO memory_review_actions "+
                "(id,target_kind,relation_evidence_id,temporal_proposal_id,action,"+
                "expected_version,before_state,after_state,undoes_id,actor_kind,created_at) "+
                "SELECT id,target_kind,relation_evidence_id,temporal_proposal_id,action,"+
                "expected_version,before_state,after_state,undoes_id,actor_kind,created_at "+
                "FROM pia_import.memory_review_actions "+
                "ORDER BY CASE WHEN undoes_id IS NULL THEN 0 ELSE 1 END,created_at,id");
            }
            // v15 accept actions predate the witness-version column.
            // Their confirmed writer always created a new witness at v1.
            if(version.user_version===15){
              await tx.execAsync(
                "UPDATE memory_review_actions SET witness_decision_version=1 "+
                "WHERE action='accept' AND target_kind='relation' "+
                "AND review_proposal_id IS NOT NULL AND relation_evidence_id IS NOT NULL "+
                "AND witness_decision_version IS NULL");
            }
            const expected=await tx.getFirstAsync<{n:number}>(
              "SELECT count(*) AS n FROM pia_import.memory_review_actions");
            const actual=await tx.getFirstAsync<{n:number}>(
              "SELECT count(*) AS n FROM memory_review_actions");
            if(!expected||!actual||expected.n!==actual.n)
              throw new Error("backup_review_count_mismatch");
          }
          // Keep imported Android Share deduplication fingerprints: a source
          // is never re-imported merely because it was restored on another phone.
          // The earlier v1-v6 deployed formats may omit this optional table.
          if (available.has("memory_received_shares")) {
            await tx.execAsync(`INSERT INTO memory_received_shares(fingerprint,entity_id)
              SELECT fingerprint,entity_id FROM pia_import.memory_received_shares`);
          }
          // Hygienic keep/pin/defer are user decisions, NEVER a rebuildable index.
          // v1–v6 backups legitimately have no such preferences.
          if (version.user_version >= 7) {
            if (!available.has("memory_cleanup_preferences")) throw new Error("incompatible_backup_schema");
            await tx.execAsync(`INSERT INTO memory_cleanup_preferences(entity_id,guard,skip_until,version,updated_at)
              SELECT entity_id,guard,skip_until,version,updated_at FROM pia_import.memory_cleanup_preferences`);
          }
          // Chunks and the search index are derived: rebuilt here from the
          // restored records, so a backup can never carry a mismatched index.
          await reindexAll(tx);
          // Older backups have no chats. Import newer ones without replacing
          // any existing local conversation (including its pending proposals).
          if (available.has("direct_conversations")) await tx.execAsync(
            `INSERT INTO direct_conversations(id,title,snapshot_json,created_at,updated_at)
             SELECT id,title,snapshot_json,created_at,updated_at FROM pia_import.direct_conversations`,
          );
          if (verifiedCounts) {
            // Catch missing rows/partial imports BEFORE COMMIT. Existing unrelated
            // chats are allowed, but imported IDs must not collide (preflight).
            const actual = await tx.getFirstAsync<BackupCounts>(backupCountsQuery(""));
            if (!actual || !validBackupCounts(actual) || !oldChats ||
                backupCountValues(verifiedCounts).some((n, i) =>
                  n + (COUNT_KEYS[i] === "chats" ? oldChats.n : 0) !== backupCountValues(actual)[i])) {
              throw new Error("backup_restore_count_mismatch");
            }
          }
          if (verifiedTemporal) {
            const actual = await tx.getFirstAsync<TemporalCounts>(temporalCountsQuery(""));
            if (!actual || !validTemporalCounts(actual) ||
                TEMPORAL_COUNT_KEYS.some(k => actual[k] !== verifiedTemporal![k])) {
              throw new Error("backup_temporal_count_mismatch");
            }
          }
          if (verifiedRelations) {
            const actual = await tx.getFirstAsync<RelationCounts>(relationCountsQuery(""));
            if (!actual || !validRelationCounts(actual) ||
                RELATION_COUNT_KEYS.some(k => actual[k] !== verifiedRelations![k])) {
              throw new Error("backup_relation_count_mismatch");
            }
          }
          if(verifiedReview){
            const actual=await tx.getFirstAsync<ReviewCounts>(reviewCountsQuery(""));
            if(!actual||!validReviewCounts(actual)||actual.review_actions!==verifiedReview.review_actions)
              throw new Error("backup_review_count_mismatch");
          }
          if(verifiedSelf){
            const actual=await tx.getFirstAsync<ProfileSelfCounts>(profileSelfCountsQuery(""));
            if(!actual||!validProfileSelfCounts(actual)||
               actual.profile_self_binding!==verifiedSelf.profile_self_binding)
              throw new Error("backup_profile_self_count_mismatch");
          }
          if(verifiedProposal){
            const actual=await tx.getFirstAsync<ProposalCounts>(proposalCountsQuery(""));
            if(!actual||!validProposalCounts(actual)||
                actual.review_proposals!==verifiedProposal.review_proposals)
              throw new Error("backup_review_proposal_count_mismatch");
          }
          const violation = await tx.getFirstAsync("PRAGMA foreign_key_check");
          if (violation !== null) throw new Error("invalid_backup_references");
        });
        return {
          collections: (await db.getFirstAsync<{ n: number }>(
            "SELECT count(*) AS n FROM memory_collections",
          ))?.n ?? 0,
          entities: incoming.n,
          observations: (await db.getFirstAsync<{ n: number }>(
            "SELECT count(*) AS n FROM memory_observations",
          ))?.n ?? 0,
        };
      } finally {
        if (attached) await detach(db, "pia_import");
      }
    });
  } finally {
    // A cancelled/partial file-manager copy still needs to be cleaned up.
    await forgetTemporaryFile(path);
  }
}
