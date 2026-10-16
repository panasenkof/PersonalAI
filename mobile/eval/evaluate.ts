/** Runs the memory question set against real SQLite FTS5 (node:sqlite) through
 * the same code the app uses: searchApprovedNotes and prepareDirectContext. */
import { SqliteMemoryRepository } from "../src/local-memory/repository";
import { ensureSections, sectionBySlug } from "../src/local-memory/sections";
import { searchApprovedNotes } from "../src/direct-agent/memory";
import { prepareDirectContext } from "../src/direct-agent/context";
import { defaultDirectPreferences } from "../src/direct-agent/settings";
import { EVAL_NOTES, EVAL_QUESTIONS, EVAL_TARGETS } from "./memory-fixture";
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

export async function evaluateMemorySearch(): Promise<EvalReport> {
  const { SCHEMA_SQL } = require("../src/local-memory/storage");
  const repo = new SqliteMemoryRepository(new NodeSqlite(SCHEMA_SQL) as never);
  const sections = await ensureSections(repo);
  const idOf = new Map<string, string>();
  const privateIds = new Set<string>();
  for (const note of EVAL_NOTES) {
    const col = sections.find(c => c.slug === note.section)!;
    const saved = await repo.createEntity({ collection_id: col.id, domain: "notes", title: note.title,
      payload: { type: "note", title: note.title, body: note.body }, sensitivity: col.sensitivity, source_kind: "user" });
    idOf.set(saved.id, note.id);
    if (sectionBySlug(note.section)?.sensitivity !== "standard") privateIds.add(note.id);
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
