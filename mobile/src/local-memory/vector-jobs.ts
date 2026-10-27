/**
 * №66.3: bounded, crash-recoverable vector work in the same SQLCipher database.
 * No network/telemetry and no user text in the job table. The original note,
 * attachment and manually entered text remain the source of truth.
 */
import type * as SQLite from "expo-sqlite";
import * as Crypto from "expo-crypto";
import { withUnlockedTransaction } from "./transaction";
import { VECTOR_DIM, embeddingHash, embeddingText, isCurrentVectorSpace, toBlob } from "./vectors";

type SQL = Pick<SQLite.SQLiteDatabase, "execAsync" | "runAsync" | "getFirstAsync" | "getAllAsync">;
type Row = Record<string, unknown>;
export type ClaimedVectorJob = {
  chunkId: string; text: string; hash: string; token: string; generation: number;
};
export type CompletedVectorJob = { job: ClaimedVectorJob; vector: Float32Array };
const PAGE = 128;
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 5;
const iso = (ms: number) => new Date(ms).toISOString();
const now = () => Date.now();

/** All updates happen inside the source-edit transaction that called indexEntity.
 * A second update invalidates a running lease via generation, never by time alone.
 */
export async function markEntityVectorsDirty(db: Pick<SQLite.SQLiteDatabase, "runAsync">, entityId: string, timestamp: string): Promise<void> {
  await db.runAsync(
    `INSERT INTO memory_vector_jobs(chunk_id,model,generation,state,attempts,lease_token,lease_until,available_at,updated_at)
     SELECT c.id,m.model,1,'pending',0,NULL,NULL,NULL,?
       FROM memory_chunks c CROSS JOIN memory_vector_models m
      WHERE c.entity_id=? AND m.active=1
     ON CONFLICT(chunk_id,model) DO UPDATE SET
       generation=memory_vector_jobs.generation+1,state='pending',attempts=0,
       lease_token=NULL,lease_until=NULL,available_at=NULL,updated_at=excluded.updated_at`,
    [timestamp, entityId],
  );
}

export class DurableVectorJobs {
  constructor(private readonly db: SQL) {}

  /** One active embedding space per profile/device. Old spaces stay as harmless
   * derived rows; never silently treat their embeddings as current.
   */
  private async register(tx: SQL, model: string, timestamp: string): Promise<void> {
    const exists = await tx.getFirstAsync<{ active: number }>("SELECT active FROM memory_vector_models WHERE model=?", [model]);
    if (exists?.active === 1) return;
    await tx.runAsync("UPDATE memory_vector_models SET active=0 WHERE active=1");
    await tx.runAsync(
      "INSERT INTO memory_vector_models(model,active,scan_cursor,scan_complete,created_at) VALUES (?,1,'',0,?) ON CONFLICT(model) DO UPDATE SET active=1,scan_cursor='',scan_complete=0",
      [model, timestamp],
    );
  }

  /** Bootstrap a previous installation / restored encrypted archive using
   * keyset pages. New edits are queued immediately by indexEntity, even while
   * the scan is still in progress. Never read all chunks into JavaScript.
   */
  private async scan(tx: SQL, model: string, timestamp: string): Promise<boolean> {
    const record = await tx.getFirstAsync<{ scan_cursor: string; scan_complete: number }>(
      "SELECT scan_cursor,scan_complete FROM memory_vector_models WHERE model=?", [model]);
    if (record?.scan_complete === 1) return false;
    const cursor = record?.scan_cursor ?? "";
    const rows = await tx.getAllAsync<Row>(
      `SELECT c.id,c.text,e.title,v.content_hash AS vhash,v.dim AS vdim,length(v.vector) AS vbytes
       FROM memory_chunks c JOIN memory_entities e ON e.id=c.entity_id
       LEFT JOIN memory_vectors v ON v.chunk_id=c.id AND v.model=?
       WHERE c.id>? AND e.record_status='active' AND e.domain='notes'
       ORDER BY c.id LIMIT ?`, [model, cursor, PAGE]);
    for (const row of rows) {
      const text = embeddingText(typeof row.title === "string" ? row.title : null, String(row.text));
      if (!text) continue;
      const expected = embeddingHash(typeof row.title === "string" ? row.title : null, String(row.text));
      if (row.vhash === expected && Number(row.vdim) > 0 &&
          Number(row.vbytes) === Number(row.vdim) * 4 &&
          (!isCurrentVectorSpace(model) || Number(row.vdim) === VECTOR_DIM)) continue;
      await tx.runAsync(
        `INSERT OR IGNORE INTO memory_vector_jobs
          (chunk_id,model,generation,state,attempts,lease_token,lease_until,available_at,updated_at)
         VALUES (?,?,1,'pending',0,NULL,NULL,NULL,?)`, [String(row.id), model, timestamp]);
    }
    const last = rows.at(-1);
    await tx.runAsync(
      "UPDATE memory_vector_models SET scan_cursor=?, scan_complete=? WHERE model=?",
      [last ? String(last.id) : cursor, rows.length < PAGE ? 1 : 0, model],
    );
    return rows.length > 0;
  }

  /** Claim a tiny batch atomically. Expired leases return after kill/restart;
   * active leases are never stolen. Failed tasks stay visible for repair.
   */
  async claim(model: string, limit = 4): Promise<ClaimedVectorJob[]> {
    if (!model || model.length > 512) throw new Error("invalid_vector_space");
    const cap = Math.min(16, Math.max(1, Math.trunc(limit) || 4));
    const result: ClaimedVectorJob[] = [];
    await withUnlockedTransaction(this.db, async tx => {
      const timestamp = iso(now());
      await this.register(tx, model, timestamp);
      await this.scan(tx, model, timestamp);
      const candidates = await tx.getAllAsync<Row>(
        `SELECT j.chunk_id,j.generation,c.text,e.title,v.content_hash AS vhash,
                v.dim AS vdim,length(v.vector) AS vbytes
         FROM memory_vector_jobs j
         JOIN memory_chunks c ON c.id=j.chunk_id
         JOIN memory_entities e ON e.id=c.entity_id
         LEFT JOIN memory_vectors v ON v.chunk_id=c.id AND v.model=j.model
         WHERE j.model=? AND e.domain='notes' AND e.record_status='active'
           AND ((j.state='pending' AND (j.available_at IS NULL OR j.available_at<=?))
             OR (j.state='leased' AND j.lease_until<=?))
         ORDER BY j.updated_at,j.chunk_id LIMIT ?`, [model, timestamp, timestamp, cap]);
      for (const row of candidates) {
        const title = typeof row.title === "string" ? row.title : null;
        const source = String(row.text);
        const text = embeddingText(title, source);
        const hash = embeddingHash(title, source);
        if (!text || (row.vhash === hash && Number(row.vdim) > 0 &&
            Number(row.vbytes) === Number(row.vdim) * 4 &&
            (!isCurrentVectorSpace(model) || Number(row.vdim) === VECTOR_DIM))) {
          await tx.runAsync("DELETE FROM memory_vector_jobs WHERE chunk_id=? AND model=? AND generation=?",
            [String(row.chunk_id), model, Number(row.generation)]);
          continue;
        }
        const token = Crypto.randomUUID();
        const updated = await tx.runAsync(
          `UPDATE memory_vector_jobs SET state='leased',lease_token=?,lease_until=?,available_at=NULL,updated_at=?
           WHERE chunk_id=? AND model=? AND generation=?`,
          [token, iso(now() + LEASE_MS), timestamp, String(row.chunk_id), model, Number(row.generation)]);
        if (updated.changes === 1) result.push({
          chunkId: String(row.chunk_id), text, hash, token, generation: Number(row.generation),
        });
      }
    });
    return result;
  }

  /** CAS guards both the job generation AND the underlying source/title. */
  async complete(model: string, items: CompletedVectorJob[]): Promise<number> {
    let saved = 0;
    await withUnlockedTransaction(this.db, async tx => {
      for (const { job, vector } of items) {
        const owner = await tx.getFirstAsync<Row>(
          "SELECT state,lease_token,generation FROM memory_vector_jobs WHERE chunk_id=? AND model=?",
          [job.chunkId, model]);
        if (owner?.state !== "leased" || owner.lease_token !== job.token ||
            Number(owner.generation) !== job.generation) continue;
        const chunk = await tx.getFirstAsync<Row>(
          `SELECT c.text,e.title,e.record_status,e.domain FROM memory_chunks c
           JOIN memory_entities e ON e.id=c.entity_id WHERE c.id=?`, [job.chunkId]);
        if (chunk?.record_status !== "active" || chunk?.domain !== "notes" ||
            embeddingHash(typeof chunk?.title === "string" ? chunk.title : null, String(chunk?.text ?? "")) !== job.hash) {
          await tx.runAsync(
            `UPDATE memory_vector_jobs SET state='pending',lease_token=NULL,lease_until=NULL,available_at=NULL,
             attempts=0,generation=generation+1 WHERE chunk_id=? AND model=? AND lease_token=?`,
            [job.chunkId, model, job.token]);
          continue;
        }
        if (!vector.length || !vector.every(Number.isFinite) ||
            (isCurrentVectorSpace(model) && vector.length !== VECTOR_DIM)) continue;
        await tx.runAsync(
          "INSERT OR REPLACE INTO memory_vectors(chunk_id,model,dim,vector,content_hash) VALUES (?,?,?,?,?)",
          [job.chunkId, model, vector.length, toBlob(vector), job.hash]);
        await tx.runAsync("DELETE FROM memory_vector_jobs WHERE chunk_id=? AND model=? AND lease_token=? AND generation=?",
          [job.chunkId, model, job.token, job.generation]);
        saved++;
      }
    });
    return saved;
  }

  /** A failed native call is bounded/backed off, not retried in a hot loop. */
  async fail(model: string, jobs: ClaimedVectorJob[]): Promise<void> {
    await withUnlockedTransaction(this.db, async tx => {
      for (const job of jobs) {
        const row = await tx.getFirstAsync<{ attempts: number }>(
          "SELECT attempts FROM memory_vector_jobs WHERE chunk_id=? AND model=? AND generation=? AND lease_token=? AND state='leased'",
          [job.chunkId, model, job.generation, job.token]);
        if (!row) continue;
        const attempts = Number(row.attempts) + 1;
        await tx.runAsync(
          `UPDATE memory_vector_jobs SET attempts=?,state=?,lease_token=NULL,lease_until=NULL,
             available_at=?,updated_at=? WHERE chunk_id=? AND model=? AND generation=? AND lease_token=?`,
          [attempts, attempts >= MAX_ATTEMPTS ? "failed" : "pending",
            attempts >= MAX_ATTEMPTS ? null : iso(now() + Math.min(900000, 10_000 * 2 ** (attempts - 1))),
            iso(now()), job.chunkId, model, job.generation, job.token]);
      }
    });
  }

  /** Graceful cancellation releases leases promptly; a killed process uses
   * lease expiry instead. Never discard a source because indexing was aborted.
   */
  async release(model: string, jobs: ClaimedVectorJob[]): Promise<void> {
    await withUnlockedTransaction(this.db, async tx => {
      for (const job of jobs) await tx.runAsync(
        `UPDATE memory_vector_jobs SET state='pending',lease_token=NULL,lease_until=NULL,available_at=NULL
         WHERE chunk_id=? AND model=? AND generation=? AND lease_token=?`,
        [job.chunkId, model, job.generation, job.token]);
    });
  }

  /** Empty work can mean a bootstrap page, future retry, or fully indexed data.
   * Never schedule retries for permanently failed jobs without user action.
   */
  async nextWakeMs(model: string): Promise<number | null> {
    const row = await this.db.getFirstAsync<Row>(
      `SELECT m.scan_complete,
         MIN(CASE WHEN e.record_status='active' AND e.domain='notes'
                    AND j.state='pending' THEN j.available_at
                  WHEN e.record_status='active' AND e.domain='notes'
                    AND j.state='leased' THEN j.lease_until END) AS next_time,
         SUM(CASE WHEN e.record_status='active' AND e.domain='notes'
                    AND j.state='pending' AND j.available_at IS NULL THEN 1 ELSE 0 END) AS ready
       FROM memory_vector_models m
       LEFT JOIN memory_vector_jobs j ON j.model=m.model
       LEFT JOIN memory_chunks c ON c.id=j.chunk_id
       LEFT JOIN memory_entities e ON e.id=c.entity_id
       WHERE m.model=? GROUP BY m.model`, [model]);
    if (!row || Number(row.scan_complete) !== 1 || Number(row.ready) > 0) return 0;
    return row.next_time ? Math.max(0, Date.parse(String(row.next_time)) - now()) : null;
  }
}
