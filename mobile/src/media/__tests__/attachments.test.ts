import { SqliteMemoryRepository } from '../../local-memory/repository';
import { appendNoteAttachments, writeOriginal, materializeAttachment, saveMediaNote, MAX_ORIGINAL_BYTES, MAX_ORIGINALS_PER_NOTE } from '../attachments';
import { SCHEMA_SQL } from '../../local-memory/storage';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
let mockUnlocked = true;
let mockDb: any;
const mockFiles = new Map<string, Uint8Array>();
let mockFailure = false;
let mockFailUri = '';
const mockSizes = new Map<string, number>();
let mockMaxRead = 0;
jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'sha256' },
  randomUUID: () => require('node:crypto').randomUUID(),
  digest: async (_a: string, bytes: Uint8Array) => new Uint8Array(require('node:crypto').createHash('sha256').update(bytes).digest()).buffer,
  digestStringAsync: async (_a: string, text: string) => require('node:crypto').createHash('sha256').update(text).digest('hex'),
}));
jest.mock('../../local-memory/storage', () => ({
  ...jest.requireActual('../../local-memory/storage'),
  localMemorySessionUnlocked: () => mockUnlocked,
  withLocalMemoryDatabase: async (_p: string, cb: any) => cb(mockDb),
}));
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' }, FileMode: { ReadOnly: 'r', WriteOnly: 'w' },
  Directory: class { uri: string; constructor(...parts: any[]) { this.uri = parts.join('/'); } create() {} },
  File: class {
    uri: string;
    constructor(...parts: any[]) { this.uri = parts.map(p => p.uri || p).join('/'); }
    get size() { return mockSizes.get(this.uri) ?? mockFiles.get(this.uri)?.length ?? 0; }
    get md5() { return mockFiles.has(this.uri) ? require('node:crypto').createHash('md5').update(mockFiles.get(this.uri)).digest('hex') : null; }
    get exists() { return mockFiles.has(this.uri); }
    create() { mockFiles.set(this.uri, new Uint8Array()); }
    delete() { mockFiles.delete(this.uri); }
    open() {
      const uri = this.uri; let offset = 0;
      return { size: mockFiles.get(uri)?.length, close() {}, readBytes(n: number) {
        mockMaxRead = Math.max(mockMaxRead, n);
        if ((mockFailure || mockFailUri === uri) && offset > 0) throw new Error('disk read failed');
        const bytes = mockFiles.get(uri)!.slice(offset, offset + n); offset += bytes.length; return bytes;
      }, writeBytes(bytes: Uint8Array) { mockFiles.set(uri, new Uint8Array([...mockFiles.get(uri)!, ...bytes])); } };
    }
  },
}));
let sqlite: any;
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON;'); sqlite.exec(SCHEMA_SQL);
  mockDb = {
    execAsync: async (s: string) => sqlite.exec(s),
    runAsync: async (s: string, p: any[] = []) => sqlite.prepare(s).run(...p),
    getFirstAsync: async (s: string, p: any[] = []) => sqlite.prepare(s).get(...p) || null,
    getAllAsync: async (s: string, p: any[] = []) => sqlite.prepare(s).all(...p),
  };
  mockUnlocked = true; mockFailure = false; mockFailUri = ''; mockMaxRead = 0; mockFiles.clear(); mockSizes.clear();
  mockFiles.set('file:///photo.png', new Uint8Array(600_000).fill(83));
});
afterEach(() => sqlite.close());
const input = { file: { uri: 'file:///photo.png', name: 'photo.png', mimeType: 'image/png' }, title: 'Фото', body: '', sensitivity: 'sensitive' as const };
test('saves original without transcript, bounds memory, preserves bytes on reopen and deduplicates retries', async () => {
  const id = await saveMediaNote('guest', input);
  expect(await saveMediaNote('guest', input)).toBe(id);
  expect(sqlite.prepare('SELECT count(*) AS n FROM memory_entities').get().n).toBe(1);
  expect(mockMaxRead).toBeLessThanOrEqual(256 * 1024);
  const attachment = sqlite.prepare('SELECT * FROM memory_attachments').get();
  const uri = await materializeAttachment('guest', attachment);
  expect(Buffer.from(mockFiles.get(uri)!)).toEqual(Buffer.from(mockFiles.get(input.file.uri)!));
  expect(sqlite.prepare('SELECT payload_json FROM memory_entities').get().payload_json).not.toContain('bytes');
  sqlite.prepare('DELETE FROM memory_entities WHERE id=?').run(id);
  expect(sqlite.prepare('SELECT count(*) AS n FROM memory_attachment_parts').get().n).toBe(0);
});
test('partial write and cancellation roll back note, attachment, index and receipt together', async () => {
  mockFailure = true;
  await expect(saveMediaNote('guest', input)).rejects.toThrow('disk read failed');
  for (const table of ['memory_entities', 'memory_attachments', 'memory_attachment_parts', 'memory_search_fts', 'memory_received_shares']) expect(sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n).toBe(0);
  const controller = new AbortController(); controller.abort();
  await expect(saveMediaNote('guest', input, controller.signal)).rejects.toThrow('остановлено');
});
test('refuses corrupted original and removes partial plaintext preview', async () => {
  await saveMediaNote('guest', input);
  sqlite.prepare("UPDATE memory_attachment_parts SET sha256='broken' WHERE ord=1").run();
  await expect(materializeAttachment('guest', sqlite.prepare('SELECT * FROM memory_attachments').get())).rejects.toThrow('повреждён');
  expect([...mockFiles.keys()]).toEqual([input.file.uri]);
});
test('changed file at same URI is a new note; locked session cannot read or write', async () => {
  const first = await saveMediaNote('guest', input);
  mockFiles.set(input.file.uri, new Uint8Array([1, 2]));
  expect(await saveMediaNote('guest', input)).not.toBe(first);
  mockUnlocked = false;
  await expect(saveMediaNote('guest', input)).rejects.toThrow('application_locked');
  await expect(materializeAttachment('guest', sqlite.prepare('SELECT * FROM memory_attachments LIMIT 1').get())).rejects.toThrow('application_locked');
});
test('refuses remote originals and empty originals', async () => {
  await expect(writeOriginal(mockDb, 'id', { ...input.file, uri: 'https://example.org/a.png' })).rejects.toThrow('локальный');
  mockFiles.set(input.file.uri, new Uint8Array());
  await expect(saveMediaNote('guest', input)).rejects.toThrow('непустой');
});


const multi = [
  { uri: "file:///photo.png", name: "photo.png", mimeType: "image/png" },
  { uri: "file:///voice.mp3", name: "voice.mp3", mimeType: "audio/mpeg" },
  { uri: "file:///recipe.txt", name: "recipe.txt", mimeType: "text/plain" },
];

test("three originals share one encrypted note, preserve names, chunks, and receipt deduplication", async () => {
  mockFiles.set(multi[1].uri, new Uint8Array(400_000).fill(14));
  mockFiles.set(multi[2].uri, new Uint8Array(1200).fill(22));
  const request = { files: multi, title: "Семейная подборка", body: "Моя подпись", extractedText: "Файл 1: photo.png\nЧек\n\nФайл 2: voice.mp3\nРазговор", sensitivity: "standard" as const };
  const id = await saveMediaNote("guest", request);
  expect(await saveMediaNote("guest", request)).toBe(id);
  expect(sqlite.prepare("SELECT count(*) n FROM memory_entities").get().n).toBe(1);
  const originals = sqlite.prepare("SELECT * FROM memory_attachments").all();
  expect(originals).toHaveLength(3);
  expect(originals.map((x: any) => x.name).sort()).toEqual(multi.map(x => x.name).sort());
  for (const row of originals) {
    const uri = await materializeAttachment("guest", row);
    const original = multi.find(m => m.name === row.name)!;
    expect(Buffer.from(mockFiles.get(uri)!)).toEqual(Buffer.from(mockFiles.get(original.uri)!));
  }
  const payload = JSON.parse(sqlite.prepare("SELECT payload_json FROM memory_entities").get().payload_json);
  expect(payload.source_files).toEqual(multi.map(f => f.name));
  expect(payload.extracted_text).toContain("voice.mp3");
  expect(mockMaxRead).toBeLessThanOrEqual(256 * 1024);
});

test("a failed second file rolls back the entire transaction (note and all chunks)", async () => {
  mockFiles.set(multi[1].uri, new Uint8Array(600_000).fill(31));
  mockFailUri = multi[1].uri;
  await expect(saveMediaNote("guest", { files: multi.slice(0, 2), title: "Two", body: "", sensitivity: "standard" })).rejects.toThrow("disk read failed");
  for (const table of ["memory_entities", "memory_attachments", "memory_attachment_parts", "memory_received_shares"])
    expect(sqlite.prepare("SELECT count(*) n FROM " + table).get().n).toBe(0);
});

test("multiple originals cannot exceed limits and cannot mix two file input formats", async () => {
  await expect(saveMediaNote("guest", { files: Array(MAX_ORIGINALS_PER_NOTE + 1).fill(multi[0]), title: "Too many", body: "", sensitivity: "standard" })).rejects.toThrow("10 вложений");
  await expect(saveMediaNote("guest", { file: multi[0], files: multi, title: "Both", body: "", sensitivity: "standard" })).rejects.toThrow("одним способом");
  mockSizes.set(multi[0].uri, 81 * 1024 * 1024);
  await expect(saveMediaNote("guest", { files: [multi[0]], title: "Too big", body: "", sensitivity: "standard" })).rejects.toThrow("80 МБ");
  mockSizes.set(multi[0].uri, 50 * 1024 * 1024);
  mockSizes.set(multi[1].uri, 40 * 1024 * 1024);
  await expect(saveMediaNote("guest", { files: multi.slice(0, 2), title: "Together too big", body: "", sensitivity: "standard" })).rejects.toThrow("Размер вложений вместе не должен превышать 80 МБ.");
});


async function savedNote() {
  const id = await saveMediaNote('guest', { ...input, body: 'Keep my text', sourceUrl: 'https://example.org/source' });
  return (await new SqliteMemoryRepository(mockDb).entity(id))!;
}
function snapshot() {
  return ['memory_entities', 'memory_attachments', 'memory_attachment_parts', 'memory_revisions', 'memory_search_fts']
    .map(table => sqlite.prepare('SELECT * FROM ' + table).all());
}
test('append preserves text, classification and provenance; PDF bytes survive reopen and stale retries do not duplicate', async () => {
  const before = await savedNote(), pdf = {uri:'file:///doc.pdf', name:'doc.pdf', mimeType:'application/pdf'};
  mockFiles.set(pdf.uri, new Uint8Array([37, 80, 68, 70, 45, 49]));
  const after = await appendNoteAttachments('guest', before.id, before.record_version, [pdf]);
  expect(after.record_version).toBe(before.record_version + 1);
  for (const key of ['title', 'sensitivity', 'collection_id', 'record_status'] as const) expect(after[key]).toEqual(before[key]);
  for (const [key, value] of Object.entries(before.payload)) expect(after.payload[key]).toEqual(value);
  expect(after.payload.source_files).toEqual(['photo.png', 'doc.pdf']);
  const row = sqlite.prepare("SELECT * FROM memory_attachments WHERE name='doc.pdf'").get();
  const uri = await materializeAttachment('guest', row);
  expect(mockFiles.get(uri)).toEqual(mockFiles.get(pdf.uri));
  await expect(appendNoteAttachments('guest', before.id, before.record_version, [pdf])).rejects.toThrow('stale_memory_version');
  expect(sqlite.prepare('SELECT COUNT(*) n FROM memory_attachments').get().n).toBe(2);
});
test('failed second append file rolls back revision, index and every new original', async () => {
  const note = await savedNote(), before = snapshot();
  mockFiles.set(multi[1].uri, new Uint8Array(600000)); mockFailUri = multi[1].uri;
  await expect(appendNoteAttachments('guest', note.id, note.record_version, multi.slice(0, 2))).rejects.toThrow('disk read failed');
  expect(snapshot()).toEqual(before);
});
test.each(['abort', 'lock'])('mid-write %s leaves existing note and originals intact', async mode => {
  const note = await savedNote(), before = snapshot(), controller = new AbortController();
  const run = mockDb.runAsync;
  mockDb.runAsync = async (sql: string, params: any[]) => {
    const result = await run(sql, params);
    if (sql.startsWith('INSERT INTO memory_attachment_parts')) {
      if (mode === 'abort') controller.abort(); else mockUnlocked = false;
    }
    return result;
  };
  await expect(appendNoteAttachments('guest', note.id, note.record_version, [input.file], controller.signal)).rejects.toThrow();
  expect(snapshot()).toEqual(before);
});
test('append limits include existing originals, disallow trash and remote input', async () => {
  const note = await savedNote(), before = snapshot();
  await expect(appendNoteAttachments('guest', note.id, note.record_version, Array(10).fill(input.file))).rejects.toThrow('10 вложений');
  mockSizes.set(input.file.uri, MAX_ORIGINAL_BYTES);
  await expect(appendNoteAttachments('guest', note.id, note.record_version, [input.file])).rejects.toThrow('вместе');
  await expect(appendNoteAttachments('guest', note.id, note.record_version, [{...input.file, uri:'https://example.org/a.png'}])).rejects.toThrow('локальный');
  expect(snapshot()).toEqual(before);
  sqlite.prepare("UPDATE memory_entities SET record_status='trashed' WHERE id=?").run(note.id);
  await expect(appendNoteAttachments('guest', note.id, note.record_version, [input.file])).rejects.toThrow('корзины');
});
