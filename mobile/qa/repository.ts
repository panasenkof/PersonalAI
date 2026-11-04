import type { EntityRecord } from "../src/local-memory/types";
const notes: EntityRecord[] = JSON.parse(localStorage.getItem("qa.notes") || "[]");
const collections: any[] = JSON.parse(localStorage.getItem("qa.collections") || "[]");
const aliases = new Map<string, string[]>();
const userTerms = new Map<string, string[]>();
// The browser adapter mirrors the production card-save contract, but is NOT
// SQLCipher and does not prove native rollback/ACL behavior.
const applyCard = (note: EntityRecord, card?: { kind: EntityRecord["kind"]; aliases: string[]; userTerms: string[] }) => {
  if (!card) return;
  note.kind = card.kind;
  aliases.set(note.id, [...card.aliases]);
  userTerms.set(note.id, [...card.userTerms]);
};
const history: any[] = []; const events: any[] = []; const relations: any[] = [];
const save = () => { localStorage.setItem("qa.notes", JSON.stringify(notes)); localStorage.setItem("qa.collections", JSON.stringify(collections)); };
export class SqliteMemoryRepository {}
export async function localMemoryRepository(_profile: string): Promise<any> {
  if (!(window as any).__qa.authorized) throw new Error("application_locked");
  return {
    lastNoteOperation: async () => "",
    entity: async (id: string) => notes.find(n => n.id === id) || null,
    searchNotes: async (term: string, limit = 50, offset = 0, filter: any = {}) => notes.filter(n => n.record_status === (filter.status || "active") && (!filter.collectionId || filter.collectionId === n.collection_id) && (!term || JSON.stringify(n).toLowerCase().includes(term.toLowerCase()))).slice(offset, offset + limit),
    collectionNoteCounts: async () => Object.fromEntries(collections.map(c => [c.id, notes.filter(n => n.collection_id === c.id && n.record_status === "active").length])),
    trashNoteCount: async () => notes.filter(n => n.domain === "notes" && n.record_status === "trashed").length,
    // QA substitutes localStorage for native SQLCipher. This is a scope/CAS
    // fixture, not evidence for native cascade/rollback correctness.
    trashPurgeSnapshot: async () => {
      const trashed = notes.filter(n => n.domain === "notes" && n.record_status === "trashed");
      const protectedIds = new Set(trashed.filter(n => relations.some(r =>
        r.source_entity_id === n.id || r.target_entity_id === n.id)).map(n => n.id));
      return { items: trashed.filter(n => !protectedIds.has(n.id))
        .map(n => ({id:n.id,record_version:n.record_version})),
        totalCount: trashed.length, protectedCount: protectedIds.size,
        originalCount: 0, affectedRelationCount: relations.filter(r => trashed.some(n =>
          n.id === r.source_entity_id || n.id === r.target_entity_id)).length };
    },
    purgeNotes: async (items: {id:string;record_version:number}[], options?: {protectReferences?:boolean}) => {
      if (!items.length || items.length > 100 || new Set(items.map(x => x.id)).size !== items.length)
        throw new Error("invalid_note_selection");
      const selected = items.map(x => {
        const note = notes.find(n => n.id === x.id);
        if (!note || note.domain !== "notes" || note.record_status !== "trashed" ||
            note.record_version !== x.record_version) throw new Error("stale_memory_version");
        if (options?.protectReferences && relations.some(r =>
          r.source_entity_id === x.id || r.target_entity_id === x.id))
          throw new Error("trash_references_changed_repeat_preview");
        return note;
      });
      for (const note of selected) notes.splice(notes.indexOf(note),1);
      save();
    },
    listCollections: async () => collections,
    createCollection: async (item: any) => { const c = { ...item, id: crypto.randomUUID(), created_at: new Date().toISOString() }; collections.push(c); save(); return c; },
    createEntity: async (item: any, _writeAttachment?: any, card?: any) => { const n = { kind: "note", ...item, id: crypto.randomUUID(), record_status: "active", record_version: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; applyCard(n as EntityRecord, card); notes.unshift(n); save(); return n; },
    reviseEntity: async (id: string, version: number, payload: any, reason: string, collectionId?: string, _allowAgent?: boolean, _writeAttachment?: any, card?: any) => { const n = notes.find(n => n.id === id)!; if (n.record_version !== version) throw new Error("stale_memory_version"); Object.assign(n, { payload, title: payload.title, collection_id: collectionId || n.collection_id, record_version: version + 1 }); applyCard(n, card); history.push({ id: crypto.randomUUID(), entityId: id, version: n.record_version, created_at: new Date().toISOString(), reason }); save(); return n; },
    setEntityStatus: async (id: string, version: number, status: any) => { const n = notes.find(n => n.id === id)!; if (n.record_version !== version) throw new Error("stale_memory_version"); Object.assign(n, { record_status: status, record_version: version + 1 }); save(); return n; },
    // QA-only replica of the existing changeNotes contract: verify the whole
    // selection before mutating it, then emulate its status/payload transitions.
    // This does NOT replace native SQLCipher/ACL/transaction tests.
    changeNotes: async (action: string, selected: {id: string;record_version: number}[], targetCollectionId?: string) => {
      if (!selected.length || selected.length > 100 || new Set(selected.map(n => n.id)).size !== selected.length)
        throw new Error("invalid_note_selection");
      const rows = selected.map(item => {
        const note = notes.find(n => n.id === item.id);
        if (!note || note.record_version !== item.record_version) throw new Error("stale_memory_version");
        const status = note.record_status;
        if (action === "restore" ? status !== "trashed" :
            action === "unarchive" ? status !== "archived" :
            action === "archive" ? status !== "active" :
            !["active", "archived"].includes(status)) throw new Error("stale_note_status");
        return note;
      });
      if (!["trash", "restore", "archive", "unarchive", "move"].includes(action))
        throw new Error("unsupported_browser_note_action");
      if (action === "move" && !collections.some(c => c.id === targetCollectionId))
        throw new Error("invalid_collection");
      const now = new Date().toISOString();
      for (const note of rows) {
        const payload: Record<string, unknown> = { ...note.payload };
        if (action === "trash") { payload.pre_trash_status = note.record_status; payload.trashed_at = now; note.record_status = "trashed"; }
        if (action === "restore") {
          note.record_status = payload.pre_trash_status === "archived" ? "archived" : "active";
          delete payload.trashed_at; delete payload.pre_trash_status;
        }
        if (action === "archive") note.record_status = "archived";
        if (action === "unarchive") note.record_status = "active";
        if (action === "move") note.collection_id = targetCollectionId!;
        note.payload = payload;
        note.record_version += 1;
        note.updated_at = now;
      }
      save();
      return "notes:" + action + ":qa";
    },
    observations: async (entityId: string) => events.filter(e => e.entity_id === entityId),
    relationsForEntity: async (id: string) => relations.filter(r => r.source_entity_id === id || r.target_entity_id === id),
    revisions: async (_type: string, id: string) => history.filter(r => r.entityId === id),
    createObservation: async (item: any) => { const e = { ...item, id: crypto.randomUUID() }; events.push(e); return e; },
    aliases: async (id: string) => aliases.get(id) || [],
    setAliases: async (id: string, names: string[]) => { aliases.set(id, names); return names; },
    entitiesByAlias: async (name: string) => notes.filter(n => (aliases.get(n.id) || []).some(a => a.toLowerCase() === name.toLowerCase()) || String(n.title).toLowerCase() === name.toLowerCase()),
    setEntityKind: async (id: string, version: number, kind: any) => { const n = notes.find(n => n.id === id)!; if (n.record_version !== version) throw new Error("stale_memory_version"); Object.assign(n, { kind, record_version: version + 1 }); save(); return n; },
    indexTerms: async (id: string) => userTerms.has(id) ? [{ source: "user", terms: userTerms.get(id)! }] : [],
    setIndexTerms: async (id: string, terms: string[]) => { userTerms.set(id, [...terms]); return terms; },
    staleIndexTerms: async () => [], indexTermsStatus: async () => ({ done: 0, pending: 0 }),
    pendingVectorChunks: async () => [], saveVectors: async () => 0, vectorStatus: async () => ({ done: 0, total: 0 }),
    searchMemory: async (term: string, options: any = {}) => notes.filter(n => n.record_status === "active" && (!options.collectionIds || options.collectionIds.includes(n.collection_id)) && JSON.stringify(n).toLowerCase().includes(term.toLowerCase().slice(0, 4))).slice(0, options.limit || 5).map(entity => ({ entity, chunk: String(entity.payload.body || ""), score: 1 })),
    linkEntities: async (source: string, target: string, kind: string) => { const r = { id: crypto.randomUUID(), source_entity_id: source, target_entity_id: target, kind }; relations.push(r); return r; },
  };
}
