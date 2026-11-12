import type { DirectAgentOptions, DirectResult } from "../engine";
import { usedNotes } from "../context";
import type { UsedNote } from "../context";
import type { MemorySnippet } from "../memory";
import { FACT_TOOL_NAME, FACT_TOOL_DESCRIPTION, factToolParameters, factProposal } from "../fact-tool";
import { createWebTools } from "../web-tools";
import { beginTask, recordEvidence, TASK_STATE_TOOL, updateTaskInterpretation,
  WORKSPACE_MAX_ENTRIES, WORKSPACE_ENTRY_MAX_CHARS } from "../task-state";
import type { TaskWorkspaceEntry } from "../task-state";
import type { TaskEvidence, ToolOutcome } from "../task-state";
import { webPreference } from "../dialogue";
import { savedArticleToolIntent, savedAiArticlePageIntent } from "../article-selection";
import type { SavedArticleIntent } from "../article-selection";
import type { ChatArticlePage, ChatMemoryRef } from "../conversations";
import { validMoveProposal, type ChatMoveProposal } from "../move-proposal";
import { validSectionProposal, type ChatSectionProposal } from "../section-actions";
import { createArticleReadCoverage } from "../article-read-coverage";
import { validateContextCandidate, type ContextCandidate } from "../conversation-context";
import { checkedNoteTags } from "../../local-memory/note-tags";

import type { ToolSpec } from "./types";
import { sourceTools } from "./source-tools";
import { memoryTools } from "./memory-tools";
import { photoTools } from "./photo-tools";
import { articleTools } from "./article-tools";
import { proposalTools } from "./proposal-tools";
import { conversationTools } from "./conversation-tools";
import { createTurnState } from "./turn-state";
export type { ToolDefinition, ToolSpec } from "./types";
const queryParameters = { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false };
const text = (v: unknown, cap = 600) => typeof v === "string" ? v.slice(0, cap) : "";
const SECTION_TOOL_ERRORS = new Set([
  "application_locked","invalid_section_action_args","section_parent_unavailable",
  "section_parent_changed","section_sibling_name_exists","section_delete_protected_or_missing",
  "section_has_children","section_not_empty","collection_not_empty","collection_delete_protected",
  "stale_collection",
]);
const sectionToolError = (error:unknown) => {
  const code=error instanceof Error ? error.message : "";
  return SECTION_TOOL_ERRORS.has(code) ? code : "section_action_unavailable";
};


/** All provider adapters advertise and execute the same catalog. No dynamic code loading. */
export function createToolCatalog(options: DirectAgentOptions, sources: string[], notes: MemorySnippet[], initialUsed: UsedNote[]) {
  const turn = createTurnState(options,sources,notes,initialUsed);
  const {web,used,moveHandles,admitMoveHandle,articleCoverage,readNotes,photoMatches,
    emit,observe,fingerprint,pending,proposalIds,articleClock,readArticleSelection,
    selectedArticleHandles,verifiedSelectedArticleRead} = turn;
  const memory = memoryTools(options, {web,used,readNotes,admitMoveHandle}, text, queryParameters);
  const proposals = proposalTools(options, {
    getMovePreview:()=>turn.movePreview,setMovePreview:value=>{turn.movePreview=value;},moveHandles,
    getSectionPreview:()=>turn.sectionPreview,setSectionPreview:value=>{turn.sectionPreview=value;},
    sectionToolError,fingerprint,pending,proposalIds,
  });
  const conversations = conversationTools(options, {
    getContextCandidate:()=>turn.contextCandidate,
    setContextCandidate:value=>{turn.contextCandidate=value;},
    getImportTagsCandidate:()=>turn.importTagsCandidate,
    setImportTagsCandidate:tags=>{turn.importTagsCandidate=tags;},
    get state(){return turn.state;},
    set state(next){turn.state=next;},
    emit,
  });
  const specs: ToolSpec[] = [
    ...(options.contextClassificationEnabled ? [conversations.contextTool] : []),
    memory.search,
    ...photoTools(options, {
      photoMatches, getLookups: () => turn.photoLookups,
      incrementLookups: () => { turn.photoLookups++; },
      setRecovery: reason => { turn.photoRecovery = reason; },
    }),
    ...memory.read,
    ...sourceTools(options, text),
    ...memory.listing,
    ...articleTools(options, {
      articleClock,readArticleSelection,selectedArticleHandles,verifiedSelectedArticleRead,
      articleCoverage,used,readNotes,
      getMixedArticleFilters:()=>turn.mixedArticleFilters,
      markUsedSelectedArticleTool:()=>{turn.usedSelectedArticleTool=true;},
    }),
    ...proposals.move,
    // SAME canonical chat ToolSpec registry as memory search, note drafts and moves.
    // The model never executes a section write: it only stages a card for a user tap.
    ...proposals.section,
    proposals.draft,
    conversations.taskTool,
    ...conversations.workspace,
    ...web.definitions.map((definition): ToolSpec => ({ definition, effect: "read", execute: args => web.run(definition.name, args) as Promise<Record<string, unknown>>,
      verify: r => definition.name === "search_web"
        ? Array.isArray(r.sources) && typeof r.context === "string" ? r.sources.length ? "found" : "empty" : "failed"
        : typeof r.content === "string" && r.content.trim() && typeof r.url === "string" ? "read" : "failed" })),
  ];
  // Import classification uses THIS catalog/engine, but no memory/web/workspace tools.
  // The host must separately authorize transmission before setting contextOnly.
  const activeSpecs = options.contextOnly
    ? options.importTagsEnabled ? [conversations.importMetadataTool] : specs.filter(s => s.definition.name === "set_conversation_context")
    : specs;
  const registry = new Map(activeSpecs.map(s => [s.definition.name, s]));
  emit();
  if (notes.length) observe({ tool: "search_local_notes", outcome: "found", subject: options.prompt.slice(0, 120), excerpt: JSON.stringify(notes.map(n => ({ id: n.id, title: n.title }))).slice(0, 600) });
  if (sources.length) observe({ tool: "search_web", outcome: "found", subject: options.prompt.slice(0, 120), excerpt: sources.join("\n").slice(0, 600) });
  async function run(name: string, raw: unknown): Promise<Record<string, unknown>> {
    if (options.signal?.aborted) throw new Error("Запрос остановлен");
    const canonical = name === "draft_local_note" ? FACT_TOOL_NAME : name;
    const spec = registry.get(canonical);
    options.diagnostic?.("llm.tool_requested", { name, argumentsChars: JSON.stringify(raw)?.length || 0 }, { arguments: JSON.stringify(raw) || "" });
    let result: Record<string, unknown>, outcome: ToolOutcome | "state_updated" = "failed";
    const args = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    try {
      if (!spec) result = { error: "tool_not_allowed" };
      else if (!args) result = { error: "invalid_tool_args" };
      else {
        result = await spec.execute(args);
        if (options.signal?.aborted) throw new Error("Запрос остановлен");
        outcome = "error" in result ? "failed" : spec.verify(result);
        if (outcome === "failed" && !("error" in result)) result = { error: "invalid_tool_result" };
      }
    } catch {
      if (options.signal?.aborted) throw new Error("Запрос остановлен");
      result = { error: "tool_failed_or_unavailable" };
    }
    // A coverage snapshot is valid ONLY for this model turn. Do not persist it
    // as task evidence that a later turn could mistake for a reauthorized read.
    if (outcome !== "state_updated" &&
        canonical !== "selected_article_read_coverage" &&
        canonical !== "search_local_photos")
      observe({ tool: canonical, outcome,
      subject: text(result.proposalId || args?.url || args?.query || args?.title || name),
      excerpt: outcome === "read" ? text(result.content) : outcome === "found" && canonical === "search_web" ? text((result.sources as string[]).join("\n")) : text(JSON.stringify(result)) });
    options.diagnostic?.("tool.outcome_verified", { name: canonical, effect: spec?.effect || "unknown", outcome });
    return { ...result, ...(outcome !== "failed" ? { outcome } : {}) };
  }
  function finish(): Pick<DirectResult, "taskState" | "proposalIds" | "articlePage" | "articleReadReport" | "photoAction" | "moveProposal" | "sectionProposal" | "contextCandidate" | "importTags"> {
    turn.state = { ...turn.state, turnStatus: "answered" }; emit();
    const selected = !turn.mixedArticleFilters && turn.usedSelectedArticleTool ? selectedArticleHandles() : undefined;
    const checked = selected && articleCoverage.summary(selected);
    // This is a historic, read-only answer annotation. It is NOT promoted into
    // TaskState evidence and cannot authorize a future read or preserve source text.
    const articleReadReport = selected && checked && checked.checkedCount>0 ? {
      kind:"selected_saved_note_reads" as const,selectedCount:selected.length,
      entries:checked.entries.map((entry,index)=>({
        selectedIndex:index,id:selected[index].id,version:selected[index].version,
        status:entry.status,verifiedChars:entry.verifiedChars,
        ...("totalChars" in entry && typeof entry.totalChars==="number" ?
          {totalChars:entry.totalChars} : {}),
        ...("title" in entry && typeof entry.title==="string" ?
          {title:entry.title} : {}),
        // Ranges are read-only source coordinates, not a copy of article text.
        // Very fragmented notes retain aggregate coverage but lose inline links.
        ...("ranges" in entry && Array.isArray(entry.ranges) && entry.ranges.length<=128 ?
          {ranges:entry.ranges.filter(r=>r.endChar>r.startChar).map(r=>({
            startChar:r.startChar,endChar:r.endChar,
          }))} : {}),
      })),
    } : undefined;
    return { taskState: turn.state, proposalIds: [...proposalIds],
      ...(turn.persistedArticle ? {articlePage:turn.persistedArticle} :
        turn.usedSelectedArticleTool && options.articleSelection ? {articlePage:options.articleSelection} : {}),
      ...(articleReadReport ? {articleReadReport} : {}),
      ...(!photoMatches.length && turn.photoRecovery ? {photoAction:turn.photoRecovery} : {}),
      ...(turn.movePreview ? {moveProposal:turn.movePreview} : {}),
      ...(turn.sectionPreview ? {sectionProposal:turn.sectionPreview} : {}),
      ...(turn.contextCandidate ? {contextCandidate:turn.contextCandidate} : {}),
      ...(turn.importTagsCandidate !== undefined ? {importTags:turn.importTagsCandidate} : {}) };
  }
  const observeSources = (urls: string[]) => { if (urls.length) observe({ tool: "web_search", outcome: "found", subject: options.prompt.slice(0, 120), excerpt: urls.join("\n").slice(0, 600) }); };
  return { definitions: activeSpecs.map(s => s.definition), run, finish, observeSources,
    memory: () => {
      const read=[...readNotes].reverse().flatMap(id=>used.has(id)?[used.get(id)!]:[]);
      // Photo originals are per attachment, not per note. Do not deduplicate
      // photos sharing a note ID, and let existing PhotoSearchResults render
      // the top match + collapsible alternatives without a second photo UI.
      const ordinary=[...read,
        ...[...used.values()].filter(item=>!readNotes.has(item.id))].slice(0,8);
      return [...photoMatches,...ordinary];
    } };
}
