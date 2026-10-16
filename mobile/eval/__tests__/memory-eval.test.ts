import { evaluateMemorySearch, formatReport } from "../evaluate";
jest.mock("expo-crypto", () => ({ randomUUID: () => "id-" + Math.random().toString(36).slice(2) }));

/** Floors = what the search reaches today. A change that lowers any of them
 * fails here; raise a floor when an improvement lands (пп. 11–14 плана). */
const FLOORS = { forms: 1, synonyms: 3 / 8, person: 5 / 6, meaning: 4 / 6, absent: 2 / 3, private: 1 };

test("memory question set: no category drops below today's level, private notes never leave", async () => {
  const report = await evaluateMemorySearch();
  console.log("\n" + formatReport(report));
  for (const s of report.scores) expect({ [s.category]: s.rate >= FLOORS[s.category] }).toEqual({ [s.category]: true });
  expect(report.scores.find(s => s.category === "private")!.rate).toBe(1);
  expect(report.extraWeb).toBe(0);
}, 30_000);
