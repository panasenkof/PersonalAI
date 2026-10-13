import type { EntityRecord } from "../src/local-memory/types";
const notes: EntityRecord[] = []; const collections: any[] = []; let counter = 0;
export class SqliteMemoryRepository {}
export async function localMemoryRepository(_profile: string): Promise<any> {
  if (!(window as any).__qa.authorized) throw new Error("application_locked");
  return {
    searchNotes: async (term: string, limit = 50, offset = 0) => notes.filter(n => !term || JSON.stringify(n).toLowerCase().includes(term.toLowerCase())).slice(offset, offset + limit),
    listCollections: async () => collections,
    createCollection: async (item: any) => { const c = { ...item, id: "c-" + ++counter }; collections.push(c); return c; },
    createEntity: async (item: any) => { const n = { ...item, id: "n-" + ++counter, record_status: "active", record_version: 1 }; notes.unshift(n); return n; },
    reviseEntity: async (id: string, version: number, payload: any) => { const n = notes.find(n => n.id === id)!; Object.assign(n, { payload, title: payload.title, record_version: version + 1 }); return n; },
    observations: async () => [], relationsForEntity: async () => [], revisions: async () => [],
    createObservation: async () => ({}), linkEntities: async () => ({}),
  };
}
