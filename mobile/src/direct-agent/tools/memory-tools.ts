import type { DirectAgentOptions } from "../engine";
import { usedNotes } from "../context";
import type { UsedNote } from "../context";
import type { MemorySnippet } from "../memory";
import type { createWebTools } from "../web-tools";
import type { ToolSpec } from "./types";

/** ARCH-2: note search/read/list/count still use the same host ACL readers. */
export function memoryTools(
  options: DirectAgentOptions,
  scope: {
    web: ReturnType<typeof createWebTools>;
    used: Map<string, UsedNote>;
    readNotes: Set<string>;
    admitMoveHandle: (note: {id:string;version?:number}) => void;
  },
  text: (value: unknown, cap?: number) => string,
  queryParameters: object,
): {search:ToolSpec;read:ToolSpec[];listing:ToolSpec[]} {
  const {web, used, readNotes, admitMoveHandle} = scope;
  const searchSpecs:ToolSpec[] = [
    { definition: { name: "search_local_notes", description: "Найти заметки на телефоне по 1–3 ключевым словам. Найденный фрагмент не является полным чтением записи.", parameters: queryParameters }, effect: "read",
      execute: async args => {
        const query = text(args.query, 120).trim();
        if (query.length < 2) return { error: "invalid_search_query" };
        options.status?.("Поиск в памяти телефона");
        const found = await options.lookup(query);
        if (!Array.isArray(found) || found.some(n => !n || typeof n.id !== "string" || typeof n.body !== "string")) return { error: "invalid_memory_result" };
        for (const n of usedNotes(found, "assistant")) used.set(n.id, n);
        found.forEach(admitMoveHandle);
        web.addNotes(found);
        options.diagnostic?.("memory.tool_search", { queryChars: query.length, found: found.length, noteIds: found.map(n => n.id), excerptCount: found.filter(n => n.excerptOnly).length }, { query });
        return { notes: found };
      }, verify: r => Array.isArray(r.notes) ? r.notes.length ? "found" : "empty" : "failed" },
  ];
  const readSpecs:ToolSpec[] = [
    ...(options.read ? [{
      definition: { name: "read_local_note", description: "Дочитать разрешённую заметку по id/version из поиска или каталога. Полный текст НЕ ограничен начальным контекстом 24 000 символов. Читай до hasMore=false с offset=nextOffset; если бюджет вызовов кончился, явно говори о частичном охвате. Каждый вызов максимум 6000 символов; версия/ACL проверяются заново.", parameters: {
        type: "object", properties: { id: { type: "string" }, version: { type: "integer" },
          offset: { type: ["integer", "null"] }, budget: { type: ["integer", "null"], maximum: 6000 } },
        required: ["id", "version", "offset", "budget"], additionalProperties: false,
      } },
      effect: "read" as const,
      execute: async (args: Record<string, unknown>) => {
        const id = text(args.id, 128);
        const version = args.version;
        const offset = args.offset ?? 0;
        const budget = args.budget ?? 4000;
        if (!id || !Number.isSafeInteger(version) || Number(version) < 1 ||
            !Number.isSafeInteger(offset) || Number(offset) < 0 ||
            !Number.isSafeInteger(budget) || Number(budget) < 1 || Number(budget) > 6000)
          return { error: "invalid_memory_read_request" };
        const result = await options.read!(id, Number(version), Number(offset), Number(budget));
        // A successful ACL+revision-checked read is actual source use, even if
        // the note was first discovered through a metadata catalogue.
        if (result.id===id && result.revision===Number(version) &&
            typeof result.content==="string" && typeof result.title==="string") {
          used.set(id,{id,title:result.title.slice(0,160),via:"assistant"});
          readNotes.add(id);
        }
        return result;
      },
      verify: (r: Record<string, unknown>) => typeof r.content === "string" &&
        typeof r.revision === "number" && typeof r.hasMore === "boolean" ? "read" as const : "failed" as const,
    }] : []),
  ];
  const listingSpecs:ToolSpec[] = [
    ...(options.list ? [{
      definition: { name: "list_local_notes", description: "Постраничный список метаданных только разрешённых активных заметок. Не является полным чтением. Поиск query означает точную FTS-фразу, не семантическое совпадение.", parameters: {
        type: "object", properties: { query: { type: ["string", "null"] }, collectionId: { type: ["string", "null"] },
          limit: { type: ["integer", "null"] }, beforeUpdatedAt: { type: ["string", "null"] }, beforeId: { type: ["string", "null"] } },
        required: ["query","collectionId","limit","beforeUpdatedAt","beforeId"], additionalProperties: false,
      } }, effect: "read" as const,
      execute: async (args: Record<string, unknown>) => {
        const opts = {
          ...(typeof args.collectionId === "string" ? { collectionId: args.collectionId } : {}),
          ...(typeof args.query === "string" ? { query: args.query } : {}),
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          ...(typeof args.beforeUpdatedAt === "string" ? { beforeUpdatedAt: args.beforeUpdatedAt } : {}),
          ...(typeof args.beforeId === "string" ? { beforeId: args.beforeId } : {}),
        };
        if (Object.keys(args).some(key => !["query","collectionId","limit","beforeUpdatedAt","beforeId"].includes(key) ||
          (args[key] !== null && !(key in opts)))) return { error: "invalid_catalog_arguments" };
        const page=await options.list!(opts);
        if(page.scope==="standard_active_notes" && Array.isArray(page.records) &&
           page.records.every(row=>row && typeof row==="object" &&
             typeof row.id==="string" && Number.isSafeInteger(row.version) && row.version>0))
          (page.records as Array<{id:string;version:number}>).forEach(admitMoveHandle);
        return page;
      },
      verify: (r: Record<string, unknown>) => Array.isArray(r.records) &&
        typeof r.hasMore === "boolean" && r.contentIncluded === false ? "read" as const : "failed" as const,
    }] : []),
    ...(options.count ? [{
      definition: { name: "count_local_notes", description: "Количество только разрешённых активных заметок. При collectionId по умолчанию считаются только непосредственные записи. Если пользователь спрашивает обо всём дереве, укажи includeDescendants=true: поиск по вложенным разделам с сохранением ACL. Не интерпретируй ноль в приватном/недоступном разделе как отсутствие записей; query — точная FTS-фраза.", parameters: {
        type: "object", properties: { query: { type: ["string", "null"] }, collectionId: { type: ["string", "null"] },
          includeDescendants: { type: "boolean", description: "Включить все вложенные разделы (только с collectionId)" } },
        required: ["query","collectionId"], additionalProperties: false,
      } }, effect: "read" as const,
      execute: async (args: Record<string, unknown>) => {
        if (Object.keys(args).some(key => !["query","collectionId","includeDescendants"].includes(key)) ||
            (args.query != null && typeof args.query !== "string") ||
            (args.collectionId != null && typeof args.collectionId !== "string") ||
            (args.includeDescendants !== undefined && typeof args.includeDescendants !== "boolean")) {
          return { error: "invalid_catalog_arguments" };
        }
        return options.count!({
          ...(typeof args.query === "string" ? { query: args.query } : {}),
          ...(typeof args.collectionId === "string" ? { collectionId: args.collectionId } : {}),
          ...(args.includeDescendants === true ? { includeDescendants: true } : {}),
        });
      },
      verify: (r: Record<string, unknown>) => typeof r.count === "number" &&
        r.scope === "standard_active_notes" ? "read" as const : "failed" as const,
    }] : []),
  ];
  return {search:searchSpecs[0],read:readSpecs,listing:listingSpecs};
}
