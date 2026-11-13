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
import { checkedChatAttachments } from "./chat-attachments";
import { imageCapability, historyForImageCapability } from "./attachment-capabilities";
import { localPhotoIntent83 } from "../media/vision-chat-search";
import { historyWithoutLargeDocuments, planDocumentSynthesis } from "./document-synthesis";
import { beginTask } from "./task-state";
import { webPreference } from "./dialogue";
import { MAX_USER_PROMPT_CHARS } from "./limits";
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

export type AgentSendIntent = {
  prompt: string;
  privatePhoto?: ChatAttachment;
  articleRowId?: string;
  conversationId: string;
  preserveDraft: true;
};

export type DraftInputs = {
  current: LiveConversation;
  settings: AgentOptions["settings"];
  internetPhotoId?: string;
  documentApprovalKey?: string;
  intent?: AgentSendIntent;
  report: (patch: { notice?: string; error?: string }) => void;
};

/** Preflight is pure apart from its existing UI notice callback.
 * Reject before consuming a draft or persisting a user turn. */
export function prepareAgentDraft(input: DraftInputs) {
  const { current, settings, internetPhotoId, documentApprovalKey, intent, report } = input;
    const selected=internetPhotoId ? current.attachments?.find(f=>f.id===internetPhotoId && f.kind==="image") : undefined;
    if(internetPhotoId && (!selected || !settings.allowWeb))return;
    const prompt = internetPhotoId
      ? "Найди в интернете сведения о том, что изображено на приложенной фотографии. Определи объект по фото, затем воспользуйся разрешённым веб-поиском. Ответь по-русски, приведи проверяемые факты и ссылки на реальные источники. Если изображение или поиск недоступны, сообщи об этом, не выдумывай источники."
      : intent?.prompt || current.question.trim() || "Посмотри приложенные файлы.";
    const displayPrompt = internetPhotoId ? "Что изображено на фото? Найти информацию в интернете" : prompt;
    const draftFiles = checkedChatAttachments(internetPhotoId ? [selected!] :
      intent?.preserveDraft ? [] : current.attachments);
    const localPhotoMatch=!internetPhotoId&&!intent ? localPhotoIntent83(prompt,draftFiles):null;
    const imageQueryFiles=localPhotoMatch?.mode==="image"
      ? draftFiles.filter(f=>f.kind==="image") : [];
    if(imageQueryFiles.length>1){
      report({notice:"Для поиска похожих фотографий выберите один снимок."});return;
    }
    const privatePhoto=intent?.privatePhoto||imageQueryFiles[0];
    // The model is responsible for deciding which tool to call. The app only
    // keeps image bytes out of the provider request for local-photo intents.
    const attachments=privatePhoto
      ? draftFiles.filter(f=>f.id!==privatePhoto.id):draftFiles;
    let documentPlan;
    try { documentPlan = internetPhotoId ? null : planDocumentSynthesis(attachments,settings.model); }
    catch(e) { report({error:String((e as Error).message)}); return; }
    if(documentPlan && documentApprovalKey!==documentPlan.approvalKey) {
      report({notice:"Для отправки большого документа подтвердите объём и вызовы ИИ в окне отправки."});
      return;
    }
    // All chat messages now run through the model and its allowed tools.
    // No regex or shortcut may directly answer for photos, saved articles or
    // a contextual "Покажи ещё".
    // Recheck the ACTIVE model at the moment of Send (not the model selected
    // when a draft photo was picked). Refuse known text-only routes before
    // consuming the draft, persisting a user turn, or making a network call.
    if (imageCapability(settings,attachments) === "unsupported") {
      report({ notice:"Выбранная модель «" + settings.model +
        "» не принимает изображения. Фото осталось в черновике; выберите модель с поддержкой фото или уберите вложение." });
      return;
    }
    if (prompt.length > MAX_USER_PROMPT_CHARS) {
      report({ error: "Сообщение длиннее 24 000 символов. Разделите его на части: текст не отправлен и не обрезан." });
      return;
    }

  return { prompt, displayPrompt, draftFiles, privatePhoto, attachments, documentPlan };
}

/** The history and task state still derive solely from the encrypted active
 * conversation. Private photo attachments never enter a cloud model payload. */
export function prepareTurnHistory(
  current: LiveConversation, settings: AgentOptions["settings"],
  prompt: string, internetPhotoId: boolean,
) {
    // A one-tap image-to-web query is a standalone purpose. Never transmit
    // unrelated history images, private drafts or prior conversation selections.
    const previousSources = internetPhotoId ? [] : [...current.rows].reverse().filter(r => r.role === "assistant" && r.sources?.length).slice(0, 3).flatMap(r => r.sources!).slice(0, 15);
    const previousHistory = internetPhotoId ? [] : current.rows.filter(r => r.role !== "info").slice(-8)
      .map(r => ({ role: r.role as "user" | "assistant", content: r.text, ...(r.attachments?.length ? {attachments:r.attachments} : {}) }));
    // After switching to a model known to be text-only, historical photo
    // originals stay encrypted in prior turns but are not uploaded again.
    const history = historyForImageCapability(historyWithoutLargeDocuments(previousHistory),
      imageCapability(settings,previousHistory.flatMap(r => r.attachments || [])));
    const previousTaskState = internetPhotoId ? undefined : current.taskState;
    const taskState = { ...beginTask(previousTaskState, prompt), webPreference: webPreference({ prompt, history, taskState: previousTaskState }) };

  return { previousSources, history, taskState };
}

/** Builds the original pre-network snapshot, including the one user bubble.
 * The caller remains the only SQLCipher conversation writer. */
export function pendingTurnPatch(input: {
  current: LiveConversation;
  taskState: NonNullable<AgentOptions["taskState"]>;
  displayPrompt: string;
  internetPhotoId?: string;
  intent?: AgentSendIntent;
  rerun: boolean;
  attachments: ChatAttachment[];
}): Partial<LiveConversation> {
  const { current, taskState, displayPrompt, internetPhotoId, intent, rerun, attachments } = input;
    return {
      taskState, question: (internetPhotoId||intent?.preserveDraft) ? current.question : "",
      // Camera/selected-photo and article-more actions preserve unrelated
      // drafts. A local query photo is never persisted as a chat attachment.
      attachments: internetPhotoId
        ? (current.attachments || []).filter(file=>file.id!==internetPhotoId)
        : intent?.privatePhoto
          ? (current.attachments||[]).filter(file=>file.id!==intent.privatePhoto!.id)
          : intent?.preserveDraft ? current.attachments : [],
      busy: true, progress: "Сохраняю вопрос…", updatedAt: new Date().toISOString(),
      title: current.rows.length ? current.title : displayPrompt.slice(0, 60),
      // A retry re-runs the same question: the user bubble already exists.
      rows: rerun ? current.rows : [...current.rows, { id: Crypto.randomUUID(), role: "user", text: displayPrompt, ...(attachments.length ? {attachments} : {}) }],
    };
}

/** Prefer the explicit cursor pinned to the clicked article page; never
 * resurrect an exhausted selection from an older page. */
export function articleTurnContext(current: LiveConversation, articleRowId?: string) {
      const articleSelection=[...current.rows].reverse().find(row=>
        row.role==="assistant" && row.articlePage?.selected?.length)?.articlePage;
      // Do not reuse an obsolete cursor if a newer article page has already
      // exhausted the selection. An explicit button can pin its own row.
      const latestArticleRow=[...current.rows].reverse().find(row=>
        row.role==="assistant" && row.articlePage);
      const articleContinuation=(articleRowId
        ? current.rows.find(row=>row.id===articleRowId &&
          row.role==="assistant" && row.articlePage?.nextCursor)
        : latestArticleRow?.articlePage?.nextCursor ? latestArticleRow : undefined)?.articlePage;

  return { articleSelection, articleContinuation };
}
