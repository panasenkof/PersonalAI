/** ARCH-6a: per-turn bridge from the chat controller to the existing agent.
 * No new reader, writer, memory index or authorization path: each callback
 * retains the same SQLCipher/AppLock checks and error contract as chat-store.
 */
import * as Crypto from "expo-crypto";
import { mergeTaskReceipts } from "./task-state";
import { runDirectAgent } from "./engine";
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from "../local-memory/storage";
import { searchApprovedNotes, readApprovedNote } from "./memory";
import { searchLocalApprovedSourceSegments, listLocalApprovedSourceSegments, readLocalApprovedSourceSegment } from "../local-memory/source-retrieval";
import { listAllowedNotes, countAllowedNotes } from "../local-memory/agent-catalog";
import { previewMove } from "./move-proposal";
import { previewSectionAction } from "./section-actions";
import { searchLocalPhotosFromChat83 } from "../media/vision-chat-search";
import { selectSavedAiArticles } from "./article-selection";
import type { ChatAttachment } from "./chat-attachments";
import type { ChatArticlePage } from "./conversations";
import type { LiveConversation } from "./chat-store";
import type { MemorySection } from "./fact-tool";

type AgentOptions = Parameters<typeof runDirectAgent>[0];

export type AgentHostInput = {
  profile: string;
  id: string;
  current: LiveConversation;
  settings: AgentOptions["settings"];
  maxRequests: number;
  prompt: string;
  attachments: ChatAttachment[];
  skipLocalMemory: boolean;
  history: AgentOptions["history"];
  previousSources: string[];
  taskState: NonNullable<AgentOptions["taskState"]>;
  privatePhoto?: ChatAttachment;
  articleContinuation?: ChatArticlePage;
  articleSelection?: ChatArticlePage;
  signal: AbortSignal;
  onText: NonNullable<AgentOptions["onText"]>;
  sections: MemorySection[];
  trace: NonNullable<AgentOptions["diagnostic"]>;
  host: string;
  disposed: () => boolean;
  getConversation: () => LiveConversation | undefined;
  getWritableConversation: () => LiveConversation | undefined;
  update: (patch: Partial<LiveConversation>, save?: boolean) => LiveConversation | undefined;
  persist: (conversation: LiveConversation) => Promise<void>;
};

/** Creates the exact same host callbacks that the old send() supplied.
 * Callers pass the live controller operations explicitly; this module never
 * owns a competing conversation snapshot or storage queue. */
export function buildAgentOptions(input: AgentHostInput): Parameters<typeof runDirectAgent>[0] {
  const {
    profile, id, current, settings, maxRequests, prompt, attachments, skipLocalMemory,
    history, previousSources, taskState, privatePhoto, articleContinuation,
    articleSelection, signal, onText, sections, trace, host, disposed,
    getConversation, getWritableConversation, update, persist,
  } = input;
  let stage = "";
  return { settings, maxRequests, prompt, attachments, skipLocalMemory:Boolean(skipLocalMemory), history:privatePhoto ? history.map(turn=>({...turn,attachments:undefined})) : history, previousSources, taskState, pendingNotes: skipLocalMemory ? [] : current.drafts,
    photoQueryAvailable:Boolean(privatePhoto),
    ...(!skipLocalMemory && articleContinuation ? {articleContinuation} : {}),
    ...(!skipLocalMemory && articleSelection ? {articleSelection} : {}),
    // Scratchpad belongs to this unlocked conversation and is serialized by
    // the existing SQLCipher conversation writer, not the personal-note writer.
    workspaceAvailable: () => !signal.aborted && localMemorySessionUnlocked() &&
      !disposed() && Boolean(getWritableConversation()),
    saveWorkspace: async next => {
      if (signal.aborted || !localMemorySessionUnlocked() || disposed())
        throw new Error("workspace_locked");
      const active=getWritableConversation();
      if(!active)throw new Error("workspace_conversation_unavailable");
      const state=mergeTaskReceipts(next,active.taskState);
      // Reuse the serialized SQLCipher conversation writer. An in-memory
      // update is NOT a successful workspace tool receipt.
      await persist({...active,taskState:state});
      if(signal.aborted || !localMemorySessionUnlocked() || disposed())
        throw new Error("workspace_locked");
      const latest=getWritableConversation();
      if(!latest)throw new Error("workspace_conversation_unavailable");
      update({taskState:mergeTaskReceipts(state,latest.taskState)});
    },
    onTaskState: next => {
      const active = getConversation();
      if (active && !signal.aborted) update( { taskState: mergeTaskReceipts(next, active.taskState) }, true);
    }, rewrite: true, signal: signal, onText, sections, context:current.context,
    contextClassificationEnabled: !Boolean(skipLocalMemory) && maxRequests >= 2,
    diagnostic: trace,
    lookup: query => searchApprovedNotes(profile, query),
    previewSectionAction: async request => {
      if(signal.aborted || disposed() || !localMemorySessionUnlocked())
        throw new Error("application_locked");
      const preview=await previewSectionAction(profile,request);
      if(signal.aborted || disposed() || !localMemorySessionUnlocked() ||
         !Boolean(getWritableConversation()))
        throw new Error("application_locked");
      return preview;
    },
    previewMove: async request => {
      if(signal.aborted || disposed() || !localMemorySessionUnlocked())
        throw new Error("application_locked");
      const preview=await previewMove(profile,request);
      if(signal.aborted || disposed() || !localMemorySessionUnlocked() ||
         !Boolean(getWritableConversation()))
        throw new Error("application_locked");
      return preview;
    },
    // 9T1: the same encrypted, ACL-scoped visual search used by the fast
    // chat route. Only verified note/photo handles go back to the model.
    searchPhotos: async query => {
      if (signal.aborted || !localMemorySessionUnlocked() || disposed())
        throw new Error("application_locked");
      if(query.mode==="image" && !privatePhoto)
        throw new Error("vision_query_one_image");
      const found=await searchLocalPhotosFromChat83(profile,
        query,query.mode==="image" ? [privatePhoto!] : [],signal);
      if (signal.aborted || !localMemorySessionUnlocked() || disposed())
        throw new Error("application_locked");
      return found;
    },
    read: async (id, version, offset, budget) => {
      if (signal.aborted || !localMemorySessionUnlocked()) throw new Error("application_locked");
      const evidence=await readApprovedNote(profile, id, version, offset, budget);
      if (signal.aborted || !localMemorySessionUnlocked()) throw new Error("application_locked");
      return { ...evidence };
    },
    searchSources: async (query, limit, offset) => ({
      ...await searchLocalApprovedSourceSegments(profile, query, limit, offset),
    }),
    listSources: async (id, version, limit) => ({
      ...await listLocalApprovedSourceSegments(profile, id, version, limit),
    }),
    readSource: async (id, version, attachmentId, extractionId, segmentId, offset, budget) => ({
      ...await readLocalApprovedSourceSegment(profile, id, version,
        attachmentId, extractionId, segmentId, offset, budget),
    }),
    list: async filters => ({ ...await withLocalMemoryDatabase(profile, db => listAllowedNotes(db, filters)) }),
    count: async filters => ({ ...await withLocalMemoryDatabase(profile, db => countAllowedNotes(db, filters)) }),
    selectArticles: async (intent, cursor) => {
      // Reuse the same SQLCipher reader as the no-model article picker.
      // A mid-call lock, profile suspension or cancellation must not leak its result.
      if (signal.aborted || !localMemorySessionUnlocked()) throw new Error("application_locked");
      const page = await selectSavedAiArticles(profile, intent, undefined, cursor);
      if (signal.aborted || !localMemorySessionUnlocked()) throw new Error("application_locked");
      return page;
    },
    notify: text => {
      trace("turn.notice", { chars: text.length }, { notice: text });
      const c = getConversation();
      if (c && !signal.aborted) update( { rows: [...c.rows, { id: Crypto.randomUUID(), role: "info", text }] }, true);
    },
    status: progress => { stage = progress; trace("turn.stage", { stage: progress }); if (!signal.aborted) update( { progress, progressSince: Date.now() }); },
    // Example: "Запрос к LLM (1/5): подключаюсь к api.openai.com…" — step and network stage; denominator follows saved profile limit.
    phase: phase => {
      trace("turn.network_phase", { phase });
      if (signal.aborted) return;
      const detail = phase === "connecting" ? "подключаюсь к " + host + "…" : phase === "waiting" ? "модель думает…" : "пишет ответ…";
      update( { progress: stage ? stage + ": " + detail : detail[0].toUpperCase() + detail.slice(1), progressSince: Date.now() });
    },
    propose: note => {
      trace("memory.proposal", { section: note.section || null, newSection: Boolean(note.newSection),
        titleChars: note.title.length, bodyChars: note.body.length }, { title: note.title, body: note.body });
      const c = getConversation();
      if (c && !signal.aborted) {
        const draftId = Crypto.randomUUID();
        update( { drafts: [...c.drafts, { ...note, id: draftId }] }, true);
        return draftId;
      }
    },
  };

}
