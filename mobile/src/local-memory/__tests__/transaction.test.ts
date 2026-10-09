import { waitForUnlockedTransaction, withUnlockedTransaction } from "../transaction";

test("serializes transactions on the same unlocked SQLCipher connection", async () => {
  const sql: string[] = [];
  let unlockFirst: () => void = () => {};
  const gate = new Promise<void>(resolve => { unlockFirst = resolve; });
  const db = { execAsync: jest.fn(async (statement: string) => { sql.push(statement); }) };
  const first = withUnlockedTransaction(db, async tx => {
    await tx.execAsync("INSERT FIRST");
    await gate;
  });
  const second = withUnlockedTransaction(db, async tx => {
    await tx.execAsync("INSERT SECOND");
  });
  // Both transactions are queued before the gate is opened.
  await Promise.resolve();
  unlockFirst();
  await Promise.all([first, second]);
  expect(sql).toEqual([
    "BEGIN IMMEDIATE", "INSERT FIRST", "COMMIT",
    "BEGIN IMMEDIATE", "INSERT SECOND", "COMMIT",
  ]);
});

test("rolls back failed mutation and never opens a new native connection", async () => {
  const sql: string[] = [];
  const db = { execAsync: jest.fn(async (statement: string) => {
    sql.push(statement);
    if (statement === "INSERT INVALID") throw new Error("write_failed");
  }) };
  await expect(withUnlockedTransaction(db, async tx => {
    await tx.execAsync("INSERT INVALID");
  })).rejects.toThrow("write_failed");
  expect(sql).toEqual(["BEGIN IMMEDIATE", "INSERT INVALID", "ROLLBACK"]);
  await waitForUnlockedTransaction(db);
});
