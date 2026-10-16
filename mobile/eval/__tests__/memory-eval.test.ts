import { evaluateMemorySearch, formatReport } from "../evaluate";
jest.mock("expo-crypto", () => ({ randomUUID: () => "id-" + Math.random().toString(36).slice(2) }));

/** Floors = what the search reaches today. A change that lowers any of them
 * fails here; raise a floor when an improvement lands (пп. 11–14 плана). */
const FLOORS = { forms: 1, synonyms: 3 / 8, person: 5 / 6, meaning: 4 / 6, absent: 1, private: 1 };

test("memory question set: no category drops below today's level, private notes never leave", async () => {
  const report = await evaluateMemorySearch();
  console.log("\n" + formatReport(report));
  for (const s of report.scores) expect({ [s.category]: s.rate >= FLOORS[s.category] }).toEqual({ [s.category]: true });
  expect(report.scores.find(s => s.category === "private")!.rate).toBe(1);
  expect(report.extraWeb).toBe(0);
}, 30_000);

/** With the model's index words (п. 12): synonyms and questions through a
 * person reach their targets; nothing from «Документы» is ever sent. */
const FLOORS_WITH_TERMS = { forms: 1, synonyms: 1, person: 1, meaning: 1, absent: 1, private: 1 };
test("memory question set with index words from the model", async () => {
  const report = await evaluateMemorySearch({ withTerms: true });
  console.log("\nС индексными словами (п. 12):\n" + formatReport(report));
  for (const s of report.scores) expect({ [s.category]: s.rate >= FLOORS_WITH_TERMS[s.category] }).toEqual({ [s.category]: true });
  expect(report.extraWeb).toBe(0);
}, 30_000);
