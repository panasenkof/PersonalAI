/**
 * SQLCipher PRAGMA key unlocks one native SQLite connection. Expo SDK 54
 * withExclusiveTransactionAsync() silently opens a NEW connection, without
 * inheriting its PRAGMA key or attached backup schemas. Never use that API
 * with PersonalAI's encrypted local database.
 *
 * Execute BEGIN IMMEDIATE on the *same* opened connection and serialize
 * transactions with a per-connection FIFO. The profile lock also protects
 * long-running export/import against account switches.
 */
type UnlockedDatabase = { execAsync(sql: string): Promise<void> };
const fifo = new WeakMap<object, Promise<void>>();

export async function withUnlockedTransaction<T extends UnlockedDatabase>(
  db: T, action: (db: T) => Promise<void>,
): Promise<void> {
  const earlier = fifo.get(db) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>(resolve => { release = resolve; });
  fifo.set(db, next);
  await earlier;
  let started = false;
  try {
    await db.execAsync("BEGIN IMMEDIATE");
    started = true;
    await action(db);
    await db.execAsync("COMMIT");
    started = false;
  } catch (error) {
    if (started) {
      try { await db.execAsync("ROLLBACK"); }
      catch { /* preserve original error */ }
    }
    throw error;
  } finally {
    release();
    if (fifo.get(db) === next) fifo.delete(db);
  }
}
