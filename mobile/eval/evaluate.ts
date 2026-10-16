/** Runs the memory question set against real SQLite FTS5 (node:sqlite) through
 * the same code the app uses: searchApprovedNotes and prepareDirectContext. */
import { SqliteMemoryRepository } from "../src/local-memory/repository";
import { ensureSections, sectionBySlug } from "../src/local-memory/sections";
import { searchApprovedNotes } from "../src/direct-agent/memory";
import { prepareDirectContext } from "../src/direct-agent/context";
import { defaultDirectPreferences } from "../src/direct-agent/settings";
import { EVAL_MODEL_TERMS, EVAL_NOTES, EVAL_QUESTIONS, EVAL_TARGETS } from "./memory-fixture";
import { enrichPending } from "../src/direct-agent/enrich";
import type { EvalCategory } from "./memory-fixture";

class NodeSqlite {
  private sqlite: any;
  constructor(schema: string) { const { DatabaseSync } = require("node:sqlite"); this.sqlite = new DatabaseSync(":memory:"); this.sqlite.exec(schema); }
  async getFirstAsync<T>(sql: string, params: unknown[] = []) { return (this.sqlite.prepare(sql).get(...params) as T) ?? null; }
  async getAllAsync<T>(sql: string, params: unknown[] = []) { return this.sqlite.prepare(sql).all(...params) as T[]; }
  async runAsync(sql: string, params: unknown[] = []) { return { changes: Number(this.sqlite.prepare(sql).run(...params).changes) }; }
  async execAsync(sql: string) { this.sqlite.exec(sql); }
}

export type QuestionResult = { q: string; category: EvalCategory; ok: boolean; found: string[]; web: boolean };
export type CategoryScore = { category: EvalCategory; passed: number; total: number; rate: number; target: number; when: string };
export type EvalReport = { results: QuestionResult[]; scores: CategoryScore[]; extraWeb: number };

/** `withTerms`: index words from the model (п. 12) are added first, through
 * the same enrichment code the app runs, with EVAL_MODEL_TERMS as answers. */
export async function evaluateMemorySearch(options: { withTerms?: boolean } = {}): Promise<EvalReport> {
  const { SCHEMA_SQL } = require("../src/local-memory/storage");
  const repo = new SqliteMemoryRepository(new NodeSqlite(SCHEMA_SQL) as never);
  const sections = await ensureSections(repo);
  const idOf = new Map<string, string>();
  const privateIds = new Set<string>();
  for (const note of EVAL_NOTES) {
    const col = sections.find(c => c.slug === note.section)!;
    const saved = await repo.createEntity({ collection_id: col.id, domain: "notes", title: note.title,
      payload: { type: "note", title: note.title, body: note.body }, sensitivity: col.sensitivity === "unclassified" ? "inherit" : col.sensitivity, source_kind: "user" });
    idOf.set(saved.id, note.id);
    if (sectionBySlug(note.section)?.sensitivity !== "standard") privateIds.add(note.id);
  }
  if (options.withTerms) {
    const byTitle = new Map(EVAL_NOTES.map(n => [n.title, EVAL_MODEL_TERMS[n.id]]));
    const transport = (async (_url: string, init: RequestInit) => {
      const title = /Название: (.*)/.exec(JSON.parse(String(init.body)).messages[1].content)?.[1] || "";
      const answer = byTitle.get(title);
      if (!answer) throw new Error("eval: a record outside the fixture was sent: " + title);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: JSON.stringify(answer) } }] }) };
    }) as unknown as typeof fetch;
    const settings = { ...defaultDirectPreferences, provider: "openai-compatible" as const, baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "eval", webSearchKey: "" };
    for (let pass = 0; pass < 5; pass++) { const r = await enrichPending(repo, settings, { transport, limit: 50 }); if (r.error) throw new Error(r.error); if (!r.done) break; }
  }
  const results: QuestionResult[] = [];
  let extraWeb = 0;
  for (const item of EVAL_QUESTIONS) {
    const notes = await searchApprovedNotes("guest", item.q, repo);
    const found = notes.map(n => idOf.get(n.id) || n.id);
    // Would the assistant go to the internet with these notes?
    let web = false;
    await prepareDirectContext({
      settings: { ...defaultDirectPreferences, provider: "openai-compatible", allowWeb: true, searchProvider: "tavily", apiKey: "k", webSearchKey: "tvly-eval" },
      prompt: item.q, history: [], propose: () => {}, lookup: async () => notes,
      transport: (async () => { web = true; return { ok: true, status: 200, json: async () => ({ results: [] }) }; }) as unknown as typeof fetch,
    });
    const ok = item.category === "absent" ? web && !found.length :
      item.category === "private" ? !found.some(id => privateIds.has(id)) :
      item.expect.some(id => found.includes(id));
    // Wasted search: the right note was found and the internet was used anyway.
    if (item.expect.some(id => found.includes(id)) && web) extraWeb++;
    results.push({ q: item.q, category: item.category, ok, found, web });
  }
  const scores = (Object.keys(EVAL_TARGETS) as EvalCategory[]).map(category => {
    const rows = results.filter(r => r.category === category);
    const passed = rows.filter(r => r.ok).length;
    return { category, passed, total: rows.length, rate: rows.length ? passed / rows.length : 1, ...EVAL_TARGETS[category] };
  });
  return { results, scores, extraWeb };
}

const NAMES: Record<EvalCategory, string> = { forms: "Другая форма слова", synonyms: "Синоним", person: "Через человека",
  meaning: "По смыслу", absent: "Нет в памяти → интернет", private: "Личные записи не уходят" };
export function formatReport(report: EvalReport): string {
  const pct = (x: number) => Math.round(x * 100) + " %";
  const lines = ["| Показатель | Сейчас | Цель |", "| --- | --- | --- |",
    ...report.scores.map(s => `| ${NAMES[s.category]} | ${pct(s.rate)} (${s.passed}/${s.total}) | ${pct(s.target)} ${s.when} |`),
    `| Лишний поиск в интернете, когда ответ есть в памяти | ${report.extraWeb} | 0 |`, "", "Не прошли:",
    ...report.results.filter(r => !r.ok).map(r => `- [${r.category}] «${r.q}» → найдено: ${r.found.join(", ") || "ничего"}${r.web ? ", пошёл в интернет" : ""}`)];
  return lines.join("\n");
}
