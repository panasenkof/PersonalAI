import type { DirectAgentOptions, DirectResult } from "../engine";
import type { UsedNote } from "../context";
import type { MemorySnippet } from "../memory";
import { FACT_TOOL_NAME } from "../fact-tool";
import { TOOL_GUIDANCE } from "../prompt";
import type { ToolOutcome } from "../task-state";
import type { ToolSpec, TurnState } from "./types";
import { sourceTools } from "./source-tools";
import { memoryTools } from "./memory-tools";
import { photoTools } from "./photo-tools";
import { articleTools } from "./article-tools";
import { proposalTools } from "./proposal-tools";
import { conversationTools } from "./conversation-tools";
import { inboxTriageTools } from "./inbox-tools";
import { createTurnState } from "./turn-state";
import { text } from "./helpers";
export type { ToolDefinition, ToolSpec } from "./types";
/** All provider adapters advertise and execute the same catalog. No dynamic code loading. */
export function createToolCatalog(options: DirectAgentOptions, sources: string[], notes: MemorySnippet[], initialUsed: UsedNote[]) {
  const turn: TurnState = createTurnState(options,sources,notes,initialUsed);
  const {web,used,articleCoverage,readNotes,photoMatches,emit,observe,proposalIds,
    selectedArticleHandles} = turn;
  const memory = memoryTools(options,turn);
  const proposals = proposalTools(options,turn);
  const conversations = conversationTools(options,turn);
  const inbox = inboxTriageTools(options);
  const specs: ToolSpec[] = [
    ...(options.contextClassificationEnabled ? [conversations.contextTool] : []),
    memory.search,
    ...photoTools(options,turn),
    ...memory.read,
    ...sourceTools(options,turn),
    ...memory.listing,
    ...articleTools(options,turn),
    ...proposals.move,
    // SAME canonical chat ToolSpec registry as memory search, note drafts and moves.
    // The model never executes a section write: it only stages a card for a user tap.
    ...proposals.section,
    ...inbox.specs,
    proposals.draft,
    conversations.taskTool,
    ...conversations.workspace,
    ...web.definitions.map((definition): ToolSpec => ({ definition, effect: "read", execute: args => web.run(definition.name, args) as Promise<Record<string, unknown>>,
      verify: r => definition.name === "search_web"
        ? Array.isArray(r.sources) && typeof r.context === "string" ? r.sources.length ? "found" : "empty" : "failed"
        : typeof r.content === "string" && r.content.trim() && typeof r.url === "string" ? "read" : "failed" })),
  ];
  // ARCH-3b: source the same literal instruction blocks as the golden
  // Responses prompt. This still does NOT alter the messages sent to a model.
  // Missing/disabled tools have no advertised guidance.
  for (const spec of specs) {
    const guidance = TOOL_GUIDANCE[spec.definition.name];
    if (guidance) spec.guidance = guidance;
  }
  // Import classification uses THIS catalog/engine, but no memory/web/workspace tools.
  // The host must separately authorize transmission before setting contextOnly.
  const activeSpecs = options.contextOnly
    ? options.importTagsEnabled ? [conversations.importMetadataTool] : specs.filter(s => s.definition.name === "set_conversation_context")
    // An authorized private turn must not advertise web, drafting, memory
    // search, workspaces, external actions or any other tool.
    : options.listInboxForTriage ? specs.filter(s => s.definition.name === "list_inbox_for_triage" || s.definition.name === "propose_inbox_triage")
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
        canonical !== "list_inbox_for_triage" && // private text must never be persisted to TaskState
        canonical !== "propose_inbox_triage" && // private proposed ids/tags stay off TaskState
        canonical !== "selected_article_read_coverage" &&
        canonical !== "search_local_photos")
      observe({ tool: canonical, outcome,
      subject: text(result.proposalId || args?.url || args?.query || args?.title || name),
      excerpt: outcome === "read" ? text(result.content) : outcome === "found" && canonical === "search_web" ? text((result.sources as string[]).join("\n")) : text(JSON.stringify(result)) });
    options.diagnostic?.("tool.outcome_verified", { name: canonical, effect: spec?.effect || "unknown", outcome });
    return { ...result, ...(outcome !== "failed" ? { outcome } : {}) };
  }
  function finish(): Pick<DirectResult, "taskState" | "proposalIds" | "articlePage" | "articleReadReport" | "photoAction" | "moveProposal" | "sectionProposal" | "inboxApproval" | "inboxTriageProposal" | "contextCandidate" | "importTags"> {
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
      ...(inbox.approval() ? {inboxApproval:inbox.approval()} : {}),
      ...(inbox.proposal() ? {inboxTriageProposal:inbox.proposal()} : {}),
      ...(turn.contextCandidate ? {contextCandidate:turn.contextCandidate} : {}),
      ...(turn.importTagsCandidate !== undefined ? {importTags:turn.importTagsCandidate} : {}) };
  }
  const observeSources = (urls: string[]) => { if (urls.length) observe({ tool: "web_search", outcome: "found", subject: options.prompt.slice(0, 120), excerpt: urls.join("\n").slice(0, 600) }); };
  return { definitions: activeSpecs.map(s => s.definition),
    // Only ACTIVE tools can contribute guidance to a future shared system prompt.
    // Kept in canonical catalog order, without changing model tool schemas.
    guidance: activeSpecs.map(s => ({ name: s.definition.name, ...(s.guidance ? { guidance: s.guidance } : {}) })),
    run, finish, observeSources,
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
