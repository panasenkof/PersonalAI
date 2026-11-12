import type { DirectAgentOptions } from "../engine";
import type { ToolSpec, TurnState } from "./types";
import { text } from "./helpers";

/** ARCH-2: source extraction tools retain their canonical ACL/version readers. */
export function sourceTools(
  options: DirectAgentOptions, _turn: TurnState,
): ToolSpec[] {
  return [
    ...(options.searchSources ? [{
      definition: { name: "search_local_source_segments",
        description: "Искать точную последовательность 1–3 ключевых слов внутри распознанных вложений. При hasMore=true передать nextOffset как offset для следующей страницы ТОГО ЖЕ query. Разрешённые активные заметки и короткие превью, не весь документ; страница/таймкод только по данным обработчика.",
        parameters: { type: "object", properties: {
          query: { type: "string" }, limit: { type: ["integer","null"] },
          offset: { type: ["integer","null"] },
        }, required: ["query","limit","offset"], additionalProperties: false },
      }, effect: "read" as const,
      execute: async (args: Record<string,unknown>) => {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        const limit = args.limit ?? 8;
        const offset = args.offset ?? 0;
        if (query.length < 2 || query.length > 120 ||
            !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 20 ||
            !Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 2_000_000) {
          return { error: "invalid_source_search_request" };
        }
        return options.searchSources!(query, Number(limit), Number(offset));
      },
      verify: (r: Record<string,unknown>) => Array.isArray(r.segments) &&
        r.scope === "standard_active_notes" &&
        r.matchMode === "exact_fts_phrase" ? "read" as const : "failed" as const,
    }] : []),
    ...(options.listSources ? [{
      definition: { name: "list_local_sources",
        description: "Получить только названия источников, короткие превью и координаты извлечённых фрагментов конкретной ранее найденной заметки по id/version. Список не является полным текстом; указанная обработчиком страница/время не проверены независимо по оригиналу.",
        parameters: { type: "object", properties: {
          id: { type: "string" }, version: { type: "integer" }, limit: { type: ["integer","null"] },
        }, required: ["id","version","limit"], additionalProperties: false },
      }, effect: "read" as const,
      execute: async (args: Record<string,unknown>) => {
        const id = text(args.id, 128);
        const version = args.version, limit = args.limit ?? 15;
        if (!id || !Number.isSafeInteger(version) || Number(version) < 1 ||
            !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 30) {
          return { error: "invalid_source_list_request" };
        }
        return options.listSources!(id, Number(version), Number(limit));
      },
      verify: (r: Record<string, unknown>) => Array.isArray(r.segments) &&
        r.metadataOnly === true && r.scope === "standard_active_notes" ? "read" as const : "failed" as const,
    }] : []),
    ...(options.readSource ? [{
      definition: { name: "read_local_source_segment",
        description: "Читать ограниченный текст одного сегмента конкретного вложения. Использовать только идентификаторы из list_local_sources, в той же версии записи. Повторно проверяет права и исходник. Координаты имеют уровень producer_reported, а unknown не является страницей/таймкодом.",
        parameters: { type: "object", properties: {
          id: { type: "string" }, version: { type: "integer" },
          attachmentId: { type: "string" }, extractionId: { type: "string" },
          segmentId: { type: "string" }, offset: { type: ["integer","null"] },
          budget: { type: ["integer","null"] },
        }, required: ["id","version","attachmentId","extractionId","segmentId","offset","budget"],
        additionalProperties: false },
      }, effect: "read" as const,
      execute: async (args: Record<string,unknown>) => {
        const id = text(args.id, 128);
        const attachmentId = text(args.attachmentId, 128);
        const extractionId = text(args.extractionId, 128);
        const segmentId = text(args.segmentId, 128);
        const version = args.version, offset = args.offset ?? 0, budget = args.budget ?? 3000;
        if (!id || !attachmentId || !extractionId || !segmentId ||
            !Number.isSafeInteger(version) || Number(version) < 1 ||
            !Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 6000 ||
            !Number.isSafeInteger(budget) || Number(budget) < 1 || Number(budget) > 4000) {
          return { error: "invalid_source_read_request" };
        }
        return options.readSource!(id, Number(version), attachmentId, extractionId, segmentId,
          Number(offset), Number(budget));
      },
      verify: (r: Record<string, unknown>) => typeof r.content === "string" &&
        typeof r.hasMore === "boolean" && r.sourceCheck === "part_manifest_revision" &&
        r.locationConfidence === "producer_reported" ? "read" as const : "failed" as const,
    }] : []),
  ];
}
