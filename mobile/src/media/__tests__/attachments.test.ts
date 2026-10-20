import { SqliteMemoryRepository } from '../../local-memory/repository';
import { writeOriginal, materializeAttachment, saveMediaNote, MAX_ORIGINAL_BYTES } from '../attachments';
import { SCHEMA_SQL } from '../../local-memory/storage';
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
let mockUnlocked = true;
let mockDb: any;
const mockFiles = new Map<string, Uint8Array>();
let mockFailure = false;
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
    get size() { return mockFiles.get(this.uri)?.length || 0; }
    get md5() { return mockFiles.has(this.uri) ? require('node:crypto').createHash('md5').update(mockFiles.get(this.uri)).digest('hex') : null; }
    get exists() { return mockFiles.has(this.uri); }
    create() { mockFiles.set(this.uri, new Uint8Array()); }
    delete() { mockFiles.delete(this.uri); }
    open() {
      const uri = this.uri; let offset = 0;
      return { size: mockFiles.get(uri)?.length, close() {}, readBytes(n: number) {
        mockMaxRead = Math.max(mockMaxRead, n);
        if (mockFailure && offset > 0) throw new Error('disk read failed');
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
  mockUnlocked = true; mockFailure = false; mockMaxRead = 0; mockFiles.clear();
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
