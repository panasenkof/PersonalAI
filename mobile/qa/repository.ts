import type { EntityRecord } from "../src/local-memory/types";
const notes: EntityRecord[] = JSON.parse(localStorage.getItem("qa.notes") || "[]");
const collections: any[] = JSON.parse(localStorage.getItem("qa.collections") || "[]");
const aliases = new Map<string, string[]>();
const history: any[] = []; const events: any[] = []; const relations: any[] = [];
const save = () => { localStorage.setItem("qa.notes", JSON.stringify(notes)); localStorage.setItem("qa.collections", JSON.stringify(collections)); };
export class SqliteMemoryRepository {}
export async function localMemoryRepository(_profile: string): Promise<any> {
  if (!(window as any).__qa.authorized) throw new Error("application_locked");
  return {
    lastNoteOperation: async () => "",
    entity: async (id: string) => notes.find(n => n.id === id) || null,
    searchNotes: async (term: string, limit = 50, offset = 0, filter: any = {}) => notes.filter(n => n.record_status === (filter.status || "active") && (!filter.collectionId || filter.collectionId === n.collection_id) && (!term || JSON.stringify(n).toLowerCase().includes(term.toLowerCase()))).slice(offset, offset + limit),
    listCollections: async () => collections,
    createCollection: async (item: any) => { const c = { ...item, id: crypto.randomUUID(), created_at: new Date().toISOString() }; collections.push(c); save(); return c; },
    createEntity: async (item: any) => { const n = { kind: "note", ...item, id: crypto.randomUUID(), record_status: "active", record_version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; notes.unshift(n); save(); return n; },
    reviseEntity: async (id: string, version: number, payload: any, reason: string, collectionId?: string) => { const n = notes.find(n => n.id === id)!; if (n.record_version !== version) throw new Error("stale_memory_version"); Object.assign(n, { payload, title: payload.title, collection_id: collectionId || n.collection_id, record_version: version + 1 }); history.push({ id: crypto.randomUUID(), entityId: id, version: n.record_version, created_at: new Date().toISOString(), reason }); save(); return n; },
    setEntityStatus: async (id: string, version: number, status: any) => { const n = notes.find(n => n.id === id)!; if (n.record_version !== version) throw new Error("stale_memory_version"); Object.assign(n, { record_status: status, record_version: version + 1 }); save(); return n; },
    observations: async (entityId: string) => events.filter(e => e.entity_id === entityId),
    relationsForEntity: async (id: string) => relations.filter(r => r.source_entity_id === id || r.target_entity_id === id),
    revisions: async (_type: string, id: string) => history.filter(r => r.entityId === id),
    createObservation: async (item: any) => { const e = { ...item, id: crypto.randomUUID() }; events.push(e); return e; },
    aliases: async (id: string) => aliases.get(id) || [],
    setAliases: async (id: string, names: string[]) => { aliases.set(id, names); return names; },
    entitiesByAlias: async (name: string) => notes.filter(n => (aliases.get(n.id) || []).some(a => a.toLowerCase() === name.toLowerCase()) || String(n.title).toLowerCase() === name.toLowerCase()),
    setEntityKind: async (id: string, version: number, kind: any) => { const n = notes.find(n => n.id === id)!; if (n.record_version !== version) throw new Error("stale_memory_version"); Object.assign(n, { kind, record_version: version + 1 }); save(); return n; },
    indexTerms: async () => [], setIndexTerms: async (_id: string, terms: string[]) => terms,
    staleIndexTerms: async () => [], indexTermsStatus: async () => ({ done: 0, pending: 0 }),
    pendingVectorChunks: async () => [], saveVectors: async () => 0, vectorStatus: async () => ({ done: 0, total: 0 }),
    searchMemory: async (term: string, options: any = {}) => notes.filter(n => n.record_status === "active" && (!options.collectionIds || options.collectionIds.includes(n.collection_id)) && JSON.stringify(n).toLowerCase().includes(term.toLowerCase().slice(0, 4))).slice(0, options.limit || 5).map(entity => ({ entity, chunk: String(entity.payload.body || ""), score: 1 })),
    linkEntities: async (source: string, target: string, kind: string) => { const r = { id: crypto.randomUUID(), source_entity_id: source, target_entity_id: target, kind }; relations.push(r); return r; },
  };
}
