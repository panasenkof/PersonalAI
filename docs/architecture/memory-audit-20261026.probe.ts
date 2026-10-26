/** Historical audit probes, NOT a normal CI gate: these describe shortcomings
 * of main b1a2b3b. Copy to mobile/eval/__tests__/memory-audit.temp.test.ts and run
 * with the project's Jest preset. Imports are relative to that temporary path.
 * Only synthetic, in-memory Node SQLite; no phone, cloud or SQLCipher claims. */
import { SqliteMemoryRepository } from '../../src/local-memory/repository';
import { searchApprovedNotes } from '../../src/direct-agent/memory';
import { enrichEntity, MODEL_TERMS_SOURCE } from '../../src/direct-agent/enrich';
import { defaultDirectPreferences } from '../../src/direct-agent/settings';
import { VECTOR_MODEL } from '../../src/local-memory/vectors';
jest.mock('expo-crypto', () => ({ randomUUID: () => 'audit-' + Math.random().toString(36).slice(2) }));
const { DatabaseSync } = require('node:sqlite');
const { SCHEMA_SQL } = require('../../src/local-memory/storage');
class SQL {
  db = new DatabaseSync(':memory:');
  reads: { sql: string; rows: number }[] = [];
  constructor() { this.db.exec(SCHEMA_SQL); }
  async getFirstAsync(sql: string, p: any[] = []) { return this.db.prepare(sql).get(...p) ?? null; }
  async getAllAsync(sql: string, p: any[] = []) { const rows = this.db.prepare(sql).all(...p); this.reads.push({ sql, rows: rows.length }); return rows; }
  async runAsync(sql: string, p: any[] = []) { return { changes: Number(this.db.prepare(sql).run(...p).changes) }; }
  async execAsync(sql: string) { this.db.exec(sql); }
}
const opened: SQL[] = [];
afterEach(() => { for (const s of opened.splice(0)) s.db.close(); });
async function fixture() {
  const sql = new SQL(); opened.push(sql);
  const repo = new SqliteMemoryRepository(sql as never);
  const col = await repo.createCollection({ name: 'Notes', slug: 'notes', sensitivity: 'standard' });
  const add = (body: string, payload: Record<string, unknown> = {}) => repo.createEntity({ collection_id: col.id, domain: 'notes', title: 'Материал', payload: { body, ...payload }, sensitivity: 'standard' });
  return { sql, repo, col, add };
}
test('M02: stored structured fields and observations are absent from search', async () => {
  const { repo, add } = await fixture();
  const n = await add('Профиль', { city: 'Воронеж', source_files: ['ЧертёжМеханизма.pdf'] });
  await repo.createObservation({ entity_id: n.id, kind: 'note_event', occurred_at: '2026-01-01T00:00:00Z', payload: { text: 'ГиперссылкаЗефир' } });
  for (const q of ['Воронеж', 'ЧертёжМеханизма', 'ГиперссылкаЗефир']) expect(await repo.searchMemory(q)).toHaveLength(0);
});
test('M05: expired metadata does not affect retrieval or reach the model snippet', async () => {
  const { sql, repo, add } = await fixture(); const n = await add('Абонемент бассейн');
  await sql.runAsync("UPDATE memory_entities SET valid_until='2020-01-01' WHERE id=?", [n.id]);
  const result = await searchApprovedNotes('guest', 'Абонемент', repo);
  expect(result.map(x => x.id)).toContain(n.id); expect(result[0]).not.toHaveProperty('valid_until');
});
test('M03: relevant term after 120 characters is not searched', async () => {
  const { repo, add } = await fixture(); await add('Гелиотроповый');
  expect(await repo.searchMemory('Гелиотроповый')).toHaveLength(1);
  expect(await repo.searchMemory('пожалуйста '.repeat(12) + 'Гелиотроповый')).toHaveLength(0);
});
test('M05: library phrase and assistant word search disagree', async () => {
  const { repo, add } = await fixture(); await add('Квитанция за ремонт холодильника');
  expect(await repo.searchNotes('Квитанция холодильника')).toHaveLength(0);
  expect(await repo.searchMemory('Квитанция холодильника')).toHaveLength(1);
});
test('M10: terms from previous revision are wrongly considered current', async () => {
  const { repo, add } = await fixture(); const n = await add('Работаю библиотекарем');
  const transport = (async () => {
    await repo.reviseEntity(n.id, 1, { body: 'Работаю программистом' }, 'Изменилось место работы');
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: '{"terms":["библиотекарь"],"people":[]}' } }] }) };
  }) as any;
  await enrichEntity(repo, n.id, { ...defaultDirectPreferences, provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'synthetic', apiKey: 'fake' }, transport);
  expect((await repo.entity(n.id))!.payload.body).toBe('Работаю программистом');
  expect((await repo.indexTerms(n.id))[0].terms).toContain('библиотекарь');
  expect(await repo.staleIndexTerms(MODEL_TERMS_SOURCE)).not.toContain(n.id);
});
test('M10: enrichment omits extracted attachment content', async () => {
  const { repo, add } = await fixture(); const n = await add('', { extracted_text: 'УникальныйТекстСканера' }); let sent = '';
  const transport = (async (_url: string, init: RequestInit) => {
    sent = String(init.body); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"terms":[],"people":[]}' } }] }) };
  }) as any;
  await enrichEntity(repo, n.id, { ...defaultDirectPreferences, provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'synthetic', apiKey: 'fake' }, transport);
  expect(sent).not.toContain('УникальныйТекстСканера');
  expect(await repo.searchMemory('УникальныйТекстСканера')).toHaveLength(1);
});
test('M04: requesting 16 pending chunks still transfers all 200 rows to JS', async () => {
  const { sql, repo, add } = await fixture();
  for (let i = 0; i < 200; i++) await add('Материал номер ' + i);
  sql.reads = [];
  expect(await repo.pendingVectorChunks(VECTOR_MODEL, 16)).toHaveLength(16);
  expect(sql.reads.find(x => x.sql.includes('v.content_hash AS vhash'))?.rows).toBe(200);
});
