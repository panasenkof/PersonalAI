import { checkedChatAttachments, MAX_CONVERSATION_FILE_BYTES, type ChatAttachment } from "./chat-attachments";

import * as Crypto from "expo-crypto";
import { mergeTaskReceipts, recordEvidence } from "./task-state";

import { runDirectAgent } from "./engine";
import { runDocumentSynthesis } from "./document-synthesis";
import type { DialogueSummaryScope } from "./dialogue-summary";
import { diagnosticTrace, redactDiagnostic } from "./diagnostics";
import { MAX_USER_PROMPT_CHARS } from "./limits";
import { loadModelCallLimit } from "./agent-preferences";
import { hostOf } from "./net";
import { proposableMemorySections, saveApprovedNote } from "./memory";
import { memoryErrorMessage } from "../local-memory/errors";

import { DEFAULT_SECTIONS } from "./fact-tool";
import type { MemorySection } from "./fact-tool";
import { conversationRepository } from "./conversations";
import type { ChatDraft, ConversationRepository, SavedConversation } from "./conversations";
import type { DirectAgentSettings } from "./settings";
import { waitForApplicationSession, onLocalMemorySessionChange } from "../local-memory/storage";
import { InboxTriageChatAccess } from "./inbox-triage-chat";

import { rowProposal, rowReceipt } from "./proposals";
import { buildAgentOptions, prepareAgentDraft, prepareTurnHistory, pendingTurnPatch, articleTurnContext, summarizeWithAgentHost, newConversation, saved, agentTextStream } from "./agent-host";
import { assistantRowFromResult, interruptedAssistantPatch } from "./agent-result";

/** `streamText` is the answer as it arrives; it is never persisted. */
/** `progressSince` is when the current stage began, for the elapsed timer. */
export type LiveConversation = SavedConversation & { retryPhoto?: {rowId:string; image:ChatAttachment}; busy: boolean; progress: string; progressSince?: number; streamText?: string; savingDraft?: string; movingRowId?: string; deleting?: boolean };
/** `notice` is informational (e.g. unreadable old chats), unlike `error`. */
/** `sections` are the memory sections a proposal can go to, the user's own included. */
export type ChatSnapshot = { ready: boolean; error: string; notice: string; conversations: LiveConversation[]; activeId: string | null; sections: MemorySection[] };
/** Where a proposal will be saved: its section, the new one, or «Заметки». */
export function draftSectionName(draft: ChatDraft, sections: MemorySection[]): string {
  if (draft.section) return sections.find(s => s.slug === draft.section)?.name || DEFAULT_SECTIONS.find(s => s.slug === draft.section)?.name || "Заметки";
  return draft.newSection || "Заметки";
}

/** Owns work independently of the navigation tree. Only an explicit Stop or
 * a profile change aborts the model; focus/blur and overlays never do. */
export class DirectChatStore {
  private snapshot: ChatSnapshot = { ready: false, error: "", notice: "", conversations: [], activeId: null, sections: DEFAULT_SECTIONS };
  private skipped = 0;
  private listeners = new Set<() => void>();
  private requests = new Map<string, AbortController>();
  private disposed = false;
  private initializing = false;
  private lifetime = new AbortController();
  private writes: Promise<void> = Promise.resolve();
  private repository: ConversationRepository;
  private readonly inboxTriage: InboxTriageChatAccess;
  private readonly activeInboxTurns = new Set<string>();
  private readonly stopInboxSessionWatch: () => void;
  /** `afterSave` runs after an approved record is saved (index words in the background). */
  constructor(private profile: string, repository?: ConversationRepository, private runner = runDirectAgent, private afterSave?: () => void) {
    this.repository = repository || conversationRepository(profile, count => { this.skipped = count; });
    this.inboxTriage = new InboxTriageChatAccess(profile, () => !this.disposed);
    this.stopInboxSessionWatch = typeof onLocalMemorySessionChange === "function"
      ? onLocalMemorySessionChange(unlocked => { if (!unlocked) {
          this.inboxTriage.revokeAll();
          for (const id of this.activeInboxTurns) this.requests.get(id)?.abort();
        } })
      : () => {};
  }
  getSnapshot = () => this.snapshot;
  /** Re-reads the user's sections; on failure the previous list stays. */
  async refreshSections(): Promise<MemorySection[]> {
    try {
      const sections = await proposableMemorySections(this.profile);
      if (Array.isArray(sections) && sections.length) this.publish({ sections });
    } catch { /* memory locked or unavailable: keep the known list */ }
    return this.snapshot.sections;
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<ChatSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  private update(id: string, patch: Partial<LiveConversation>, persist = false): LiveConversation | undefined {
    const previous = this.snapshot.conversations.find(c => c.id === id);
    if (!previous || this.disposed) return;
    const next = { ...previous, ...patch };
    this.publish({ conversations: this.snapshot.conversations.map(c => c.id === id ? next : c) });
    if (persist) void this.persist(next).catch(() => {});
    return next;
  }
  private persist(conversation: LiveConversation): Promise<void> {
    if (conversation.deleting) return Promise.resolve();
    // Capture immutable state NOW, serialize all writes, and wait through app
    // locking. A late save can never overwrite a newer message or resurrect a deleted chat.
    const value = saved(conversation);
    const work = this.writes.catch(() => {}).then(async () => {
      await waitForApplicationSession(this.lifetime.signal);
      if (this.disposed || !this.snapshot.conversations.some(c => c.id === value.id)) return;
      await this.repository.save(value);
    });
    this.writes = work;
    void work.catch(() => {
      this.publish({ error: "Не удалось сохранить историю. Диалог остаётся открыт; повторите сохранение." });
    });
    return work;
  }
  async initialize() {
    if (this.initializing || this.disposed || this.requests.size) return;
    this.initializing = true;
    try {
      await this.writes.catch(() => {});
      await waitForApplicationSession(this.lifetime.signal);
      const records = await this.repository.load();
      const conversations: LiveConversation[] = records.map(c => ({
        ...c, ...(c.taskState?.turnStatus === "running" ? { taskState: { ...c.taskState, turnStatus: "interrupted" as const } } : {}), question: c.question || "", busy: false, progress: "", interrupted: false,
        rows: c.interrupted ? [...c.rows, { id: Crypto.randomUUID(), role: "info" as const,
          text: "Приложение закрылось до завершения ответа. Можно отправить вопрос повторно." }] : c.rows,
      }));
      this.publish({ ready: true, error: "", conversations, activeId: conversations[0]?.id || null,
        notice: this.skipped ? `Не удалось прочитать диалогов: ${this.skipped}. Остальные открыты; повреждённые записи сохранены без изменений.` : "" });
      for (const c of conversations.filter(c => records.find(r => r.id === c.id)?.interrupted)) await this.persist(c);
      if (!conversations.length) this.create();
      void this.refreshSections();
    } catch {
      this.publish({ ready: false, error: "Не удалось открыть историю диалогов. Повторите загрузку." });
    } finally { this.initializing = false; }
  }
  create() {
    if (!this.snapshot.ready || this.disposed) return;
    const conversation = newConversation();
    this.inboxTriage.revokeAll();
    for(const id of this.activeInboxTurns)this.requests.get(id)?.abort();
    this.publish({ conversations: [conversation, ...this.snapshot.conversations], activeId: conversation.id, error: "" });
    void this.persist(conversation).catch(() => {});
  }
  select(id: string) {
    if (this.snapshot.conversations.some(c => c.id === id)) {
      if (id !== this.snapshot.activeId) {
        this.inboxTriage.revokeAll();
        for(const active of this.activeInboxTurns)this.requests.get(active)?.abort();
      }
      this.publish({ activeId: id, error: "" });
    }
  }
  setQuestion(question: string) {
    if (this.snapshot.activeId) this.update(this.snapshot.activeId, { question });
  }
  private validateDraftAttachments(current: LiveConversation, files: ChatAttachment[]) {
    const checked = checkedChatAttachments(files);
    const total = [...current.rows.flatMap(r => r.attachments || []), ...checked].reduce((sum, f) => sum + f.size, 0);
    if (total > MAX_CONVERSATION_FILE_BYTES) throw new Error("Вложения этого диалога занимают больше 24 МБ. Начните новый диалог.");
    return checked;
  }
  setAttachments(id: string, files: ChatAttachment[]) {
    const current = this.snapshot.conversations.find(c => c.id === id);
    if (!current || current.busy || current.deleting || this.disposed) return;
    this.update(id, {attachments:this.validateDraftAttachments(current, files)}, true);
  }
  /** Validate without mutation for the Share chooser; repeat atomically on confirmation. */
  sharedDraft(id: string, text: string, files: ChatAttachment[]) {
    const current = this.snapshot.conversations.find(c => c.id === id);
    if (!this.snapshot.ready || this.disposed || !current || id !== this.snapshot.activeId) throw new Error("Текущий диалог недоступен.");
    if (current.busy || current.deleting) throw new Error("Дождитесь завершения работы в текущем диалоге.");
    const question = [current.question, text].filter(Boolean).join("\n\n");
    if (question.length > MAX_USER_PROMPT_CHARS) throw new Error("Вместе с черновиком получится больше 24 000 символов.");
    return {question, attachments:this.validateDraftAttachments(current, [...(current.attachments || []), ...files])};
  }
  appendSharedDraft(id: string, text: string, files: ChatAttachment[]) {
    const patch = this.sharedDraft(id, text, files);
    this.update(id, patch, true);
  }
  async checkpoint() {
    const ids = this.snapshot.conversations.map(c => c.id);
    for (const id of ids) {
      const current = this.snapshot.conversations.find(c => c.id === id);
      if (current) await this.persist(current);
    }
    this.publish({ error: "" });
  }
  async remove(id: string) {
    const conversation = this.snapshot.conversations.find(c => c.id === id);
    if (!conversation || conversation.busy || conversation.savingDraft || conversation.deleting) return;
    this.inboxTriage.revoke(id);
    this.update(id, { deleting: true });
    const work = this.writes.catch(() => {}).then(async () => {
      await waitForApplicationSession(this.lifetime.signal);
      if (this.disposed) return;
      await this.repository.remove(id);
      const remaining = this.snapshot.conversations.filter(c => c.id !== id);
      this.publish({ conversations: remaining, activeId: this.snapshot.activeId === id ? remaining[0]?.id || null : this.snapshot.activeId });
      if (!remaining.length) this.create();
    });
    this.writes = work;
    try { await work; } catch { this.update(id, { deleting: false }); this.publish({ error: "Не удалось удалить диалог." }); }
  }
  /** A camera/gallery photo action is a normal model turn whose private image
   * is exposed ONLY to the on-device photo tool, never to the provider payload.
   * Unrelated draft text and attachments remain in the composer. */
  async searchPhotosWithAgent(settings: DirectAgentSettings, camera: ChatAttachment,
    expectedConversationId?: string): Promise<void> {
    const id=expectedConversationId||this.snapshot.activeId;
    const current=this.snapshot.conversations.find(c=>c.id===id);
    if(!id||!current||id!==this.snapshot.activeId||current.busy||current.deleting||
      this.disposed||!this.snapshot.ready||camera.kind!=="image"||
      !(current.attachments?.some(f=>f.id===camera.id && f.kind==="image")||
        current.retryPhoto?.image.id===camera.id))return;
    await this.send(settings,undefined,undefined,false,{
      prompt:"Найди похожие фотографии в моей памяти",
      privatePhoto:camera,conversationId:id,preserveDraft:true,
    });
  }

  /** Follow the pinned article cursor through the LLM's existing
   * continue_local_articles tool; never do a hidden local chat reply. */
  async continueArticlesWithAgent(settings:DirectAgentSettings,sourceRowId:string):Promise<void>{
    const id=this.snapshot.activeId;
    const current=this.snapshot.conversations.find(c=>c.id===id);
    if(!id||!current||current.busy||current.deleting||this.disposed||
      !current.rows.some(r=>r.id===sourceRowId&&Boolean(r.articlePage?.nextCursor)))return;
    await this.send(settings,undefined,undefined,false,{
      prompt:"Покажи ещё сохранённые статьи из этой подборки",
      articleRowId:sourceRowId,conversationId:id,preserveDraft:true,
    });
  }

  /** Explicit internet photo action reuses the existing model and web tools,
   * without consuming the user's unrelated composer draft. */
  async send(settings: DirectAgentSettings, internetPhotoId?:string, documentApprovalKey?:string,
    rerun = false, intent?:{prompt:string;privatePhoto?:ChatAttachment;articleRowId?:string;
      inboxApprovalRowId?:string;conversationId:string;preserveDraft:true}) {
    const id = this.snapshot.activeId;
    const current = this.snapshot.conversations.find(c => c.id === id);
    if (!id || !current || current.busy || current.deleting || this.disposed ||
      (!internetPhotoId && !intent && !current.question.trim() && !current.attachments?.length) ||
      (intent && intent.conversationId!==id)) return;
    const drafted = prepareAgentDraft({
      current, settings, internetPhotoId, documentApprovalKey, intent,
      report: patch => this.publish(patch),
    });
    if (!drafted) return;
    const { prompt, displayPrompt, draftFiles, privatePhoto, attachments, documentPlan } = drafted;
    const trace = diagnosticTrace(this.profile, id, Crypto.randomUUID());
    const startedAt = Date.now();
    const inboxTurnId = Crypto.randomUUID();
    const aborter = new AbortController();
    this.requests.set(id, aborter);
    const { previousSources, history, taskState } = prepareTurnHistory(
      current, settings, prompt, Boolean(internetPhotoId),
    );
    this.publish({ error: "" });
    const pending = this.update(id, pendingTurnPatch({
      current, taskState, displayPrompt, internetPhotoId, intent, rerun, attachments,
    }))!;
    let modelStarted = false;
    let beforeModelError = "Запрос не отправлен: не удалось сохранить историю.";
    const host = hostOf(settings.baseUrl || "https://api.openai.com/v1");
    trace("turn.start", { provider: settings.provider, model: settings.model, host, promptChars: prompt.length,
      historyTurns: history.length, previousSources: previousSources.length, webEnabled: settings.allowWeb }, { prompt });
    // Repaint at most every 60 ms while tokens arrive.
    const { onText, getLatest, cancel } = agentTextStream(
      aborter.signal, text => this.update(id, { streamText: text }),
    );
    try {
      // Persist the submitted question before spending a model request.
      await this.persist(pending);
      trace("turn.question_persisted");
      if (this.disposed) return;
      if (aborter.signal.aborted) throw new Error("aborted");
      // The model must see the sections as they are now, including ones the
      // user created a minute ago in the memory screen.
      const sections = await this.refreshSections();
      trace("turn.sections_ready", { count: sections.length });
      if (aborter.signal.aborted) throw new Error("aborted");
      beforeModelError = "Запрос не отправлен: не удалось прочитать лимит обращений к LLM. Откройте Настройки → Работа ИИ и сохраните лимит.";
      const maxRequests = await loadModelCallLimit(this.profile);
      if (this.disposed || aborter.signal.aborted) throw new Error("aborted");
      if(documentPlan && documentPlan.calls>maxRequests)throw new Error("Для полного анализа требуется "+documentPlan.calls+" обращений к модели, но в настройках разрешено "+maxRequests+". Измените лимит перед отправкой.");
      modelStarted = true;
      const { articleSelection, articleContinuation } = articleTurnContext(current, intent?.articleRowId);
      if (intent?.inboxApprovalRowId) {
        if (!this.inboxTriage.beginTurn(id,intent.inboxApprovalRowId,inboxTurnId))
          throw new Error("Разрешение на разбор «Входящих» истекло. Запросите его снова.");
        this.activeInboxTurns.add(id);
      }
      const agentOptions = buildAgentOptions({
        profile: this.profile, id, current, settings, maxRequests, prompt, attachments,
        skipLocalMemory: Boolean(internetPhotoId), history: privatePhoto
          ? history.map(turn => ({...turn, attachments: undefined})) : history,
        previousSources, taskState, privatePhoto,
        articleContinuation, articleSelection, signal: aborter.signal,
        inboxTriage: {
          requestInboxTriageApproval: limit => {
            if(aborter.signal.aborted || this.disposed || this.snapshot.activeId !== id)
              throw new Error("inbox_triage_not_authorized");
            return this.inboxTriage.request(id,limit);
          },
          ...(intent?.inboxApprovalRowId ? {listInboxForTriage: options =>
            this.inboxTriage.listForTurn(id,inboxTurnId,options,aborter.signal),
            proposeInboxTriage: proposal => this.inboxTriage.proposeForTurn(
              id,inboxTurnId,proposal,aborter.signal)} : {}),
        },
        onText, sections, trace, host,
        disposed: () => this.disposed,
        getConversation: () => this.snapshot.conversations.find(c => c.id === id),
        getWritableConversation: () => this.snapshot.conversations.find(c => c.id === id && !c.deleting),
        update: (patch, save) => this.update(id, patch, save),
        persist: conversation => this.persist(conversation),
      });
      const result = documentPlan ? await runDocumentSynthesis(agentOptions,documentPlan,this.runner) : await this.runner(agentOptions);
      const c = this.snapshot.conversations.find(c => c.id === id);
      if (!c || this.disposed) return;
      if (aborter.signal.aborted) throw new Error("aborted");
      trace("turn.completed", { elapsedMs: Date.now() - startedAt, requests: result.requests,
        answerChars: result.text.length, sources: result.sources.length, memoryRefs: result.memory?.length || 0 },
        intent?.inboxApprovalRowId ? undefined : { answer: result.text, sources: result.sources.join("\n") });
      const answerRowId=Crypto.randomUUID();
      if(result.inboxApproval && !this.inboxTriage.markRow(id,answerRowId,result.inboxApproval))
        throw new Error("Разрешение на чтение «Входящих» недоступно.");
      const updatedAt=new Date().toISOString();
      // The same in-turn context candidate is checked once against current
      // sections; private web-photo turns do not classify conversation context.
      const view = assistantRowFromResult(
        internetPhotoId ? {...result, contextCandidate: undefined} : result,
        c, sections, updatedAt,
      );
      const patch: Partial<LiveConversation> = {
        retryPhoto: privatePhoto && result.photoAction
          ? {rowId:answerRowId,image:privatePhoto} : undefined,
        taskState: mergeTaskReceipts({ ...(result.taskState || c.taskState || taskState), turnStatus: "answered" }, c.taskState),
        rows: [...c.rows,
          ...view.notices.map(text => ({ id: Crypto.randomUUID(), role: "info" as const, text })),
          { id: answerRowId, ...view.row, ...(intent?.inboxApprovalRowId ? {inboxTriageResult:true} : {}) },
        ],
        ...(view.context ? { context:view.context, title:view.context.topic } : {}),
        updatedAt,
      };
      if (view.change) {
        // Commit metadata and the answer atomically in the existing encrypted
        // conversation snapshot BEFORE UI claims that the section changed.
        await this.persist({...c,...patch});
        if(this.disposed || aborter.signal.aborted ||
          !this.snapshot.conversations.some(row=>row.id===id&&!row.deleting))
          throw new Error("conversation_unavailable_after_context_commit");
      }
      this.update(id,patch);
    } catch (e) {
      trace("turn.failed", { elapsedMs: Date.now() - startedAt, aborted: aborter.signal.aborted,
        modelStarted, errorType: (e as Error)?.name || "Error" },
        { error: redactDiagnostic(String((e as Error)?.message || e)).slice(0, 500) });
      const c = this.snapshot.conversations.find(c => c.id === id);
      this.inboxTriage.revoke(id);
      if (c && !this.disposed) {
        // The store remains responsible for updating this conversation.
        this.update(id, interruptedAssistantPatch({
          conversation:c,taskState,privatePhoto,internetPhotoId:Boolean(internetPhotoId),
          intentPreserveDraft:Boolean(intent?.preserveDraft),inboxTriageResult:Boolean(intent?.inboxApprovalRowId),
          modelStarted,beforeModelError,
          prompt,draftFiles,signalAborted:aborter.signal.aborted,latest:getLatest(),error:e,
          newId:Crypto.randomUUID,
        }));
      }
    } finally {
      this.inboxTriage.endTurn(id,inboxTurnId);
      this.activeInboxTurns.delete(id);
      trace("turn.finished", { elapsedMs: Date.now() - startedAt });
      this.requests.delete(id);
      cancel();
      const final = this.update(id, { busy: false, progress: "", progressSince: undefined, streamText: undefined });
      if (final) await this.persist(final).catch(() => {});
    }
  }
  /** Explicit UI pin: never changes memory-record sensitivity or moves notes. */
  setContextPinned(pinned:boolean, conversationId=this.snapshot.activeId):void{
    const c=this.snapshot.conversations.find(row=>row.id===conversationId);
    if(!c || !c.context || c.busy || c.deleting || this.disposed)return;
    this.update(c.id,{context:{...c.context,pinned}},true);
  }

  /** Re-runs the last submitted question after a failed answer.
   * The user bubble stays single: the question is put back into the draft slot
   * and send() runs its normal guarded path with `rerun` set. */
  async retry(settings: DirectAgentSettings) {
    const id = this.snapshot.activeId;
    const current = this.snapshot.conversations.find(c => c.id === id);
    if (!id || !current || current.busy || current.deleting || this.disposed) return;
    const lastUser = [...current.rows].reverse().find(r => r.role === "user");
    if (!lastUser || !lastUser.text.trim()) return;
    this.update(id, { question: lastUser.text, attachments: lastUser.attachments || [] });
    await this.send(settings, undefined, undefined, true);
  }
  /** H-SAVE1b still uses the same encrypted conversation writer and owner. */
  async summarizeForNote(
    conversationId: string, settings: DirectAgentSettings,
    scope: DialogueSummaryScope, approvalKey: string,
  ): Promise<{conversationId:string;rowId:string}> {
    return summarizeWithAgentHost({
      conversationId, settings, scope, approvalKey, profile:this.profile,
      ready:()=>this.snapshot.ready, disposed:()=>this.disposed,
      requestExists:id=>this.requests.has(id),
      beginRequest:(id,controller)=>{this.requests.set(id,controller);},
      endRequest:id=>{this.requests.delete(id);},
      sessionSignal:this.lifetime.signal,
      getConversation:id=>this.snapshot.conversations.find(c=>c.id===id),
      update:(id,patch)=>this.update(id,patch),
      persist:conversation=>this.persist(conversation),
      publishError:error=>this.publish({error}),
      runner:this.runner,
    });
  }
  stop(id = this.snapshot.activeId) { if (id && this.requests.has(id)) { this.update(id, { progress: "Останавливаю запрос…" }); this.requests.get(id)?.abort(); } }
  /** The user moves a proposed note to another section before saving it. */
  /** `section` is an existing slug, or null for the new section the model proposed. */
  setDraftSection(draft: ChatDraft, section: string | null) {
    const c = this.snapshot.conversations.find(c => c.id === this.snapshot.activeId);
    if (c && c.savingDraft !== draft.id) this.update(c.id, { drafts: c.drafts.map(d => {
      if (d.id !== draft.id) return d;
      const { section: _old, ...rest } = d;
      return section ? { ...rest, section } : rest;
    }) }, true);
  }
  dismiss(draft: ChatDraft) {
    const c = this.snapshot.conversations.find(c => c.id === this.snapshot.activeId);
    if (c && c.savingDraft !== draft.id && c.drafts.some(d => d.id === draft.id)) this.update(c.id, {
      drafts: c.drafts.filter(d => d.id !== draft.id),
      ...(c.taskState ? { taskState: recordEvidence(c.taskState, { tool: "draft_memory_fact", outcome: "dismissed", subject: draft.id, excerpt: draft.title }) } : {}),
    }, true);
  }
  /** The same user-click confirmation lifecycle for a move or a section action.
   * The handler calls the EXISTING SQLCipher writer. No model-side mutation.
   * A stale version or an ACL change still fails inside the canonical writer. */
  async confirmProposal(rowId: string, settings?:DirectAgentSettings): Promise<void> {
    const c = this.snapshot.conversations.find(x => x.id === this.snapshot.activeId);
    const row = c?.rows.find(x => x.id === rowId && x.role === "assistant");
    if(row?.inboxApproval){
      if(!c || c.busy || c.deleting || this.disposed) return;
      if(!settings){this.publish({error:"Сначала подключите модель для разбора «Входящих»."});return;}
      try{
        if(!this.inboxTriage.confirm(c.id,rowId,row.inboxApproval))
          throw new Error("Разрешение устарело. Запросите разбор «Входящих» снова.");
        const updated=this.update(c.id,{rows:c.rows.map(r=>r.id===rowId
          ? (({inboxApproval:_discard,...rest})=>rest)(r) : r)});
        if(!updated)throw new Error("Диалог недоступен.");
        await this.persist(updated);
        if(this.snapshot.activeId!==c.id)throw new Error("Диалог изменился.");
        await this.send(settings,undefined,undefined,false,{
          prompt:"Прочитай разрешённую пачку «Входящих» и предложи разделы и теги для каждой записи. Пока ничего не сохраняй.",
          conversationId:c.id,preserveDraft:true,inboxApprovalRowId:rowId,
        });
      }catch(e){
        this.inboxTriage.revoke(c.id);
        this.publish({error:String((e as Error).message || e)});
      }
      return;
    }
    const selected = row ? rowProposal(row) : undefined;
    if (!c || !selected || c.busy || c.movingRowId || c.deleting || this.disposed) return;
    const { handler, proposal } = selected;
    this.update(c.id, { movingRowId: rowId });
    try {
      const receipt = await handler.confirm(this.profile, proposal);
      const latest = this.snapshot.conversations.find(x => x.id === c.id);
      if (!latest || this.disposed) return;
      const current = latest.rows.find(r => r.id === rowId);
      if (!current || handler.fromRow(current) !== proposal) {
        // The canonical write may have succeeded. Do not fabricate a receipt
        // for an unrelated/removed row or claim that memory was untouched.
        this.publish({ error: "Предложение изменилось во время подтверждения. Проверьте состояние памяти." });
        return;
      }
      const rows = latest.rows.map(r => r.id === rowId ? handler.withReceipt(r, receipt) : r);
      const affectedSlug = handler.clearedContextSection?.(receipt);
      const patch = this.update(c.id, {
        rows: [...rows, {
          id: Crypto.randomUUID(), role: "info" as const, text: handler.confirmNotice(receipt),
        }],
        ...(affectedSlug && latest.context?.sectionSlug === affectedSlug
          ? { context: { ...latest.context, sectionSlug: null, pinned: false } } : {}),
      });
      if (patch) await this.persist(patch);
      if (handler.refreshSectionsAfterConfirm) await this.refreshSections();
      this.afterSave?.();
    } catch (error) {
      this.publish({ error: memoryErrorMessage(error) + handler.confirmErrorSuffix });
    } finally {
      this.update(c.id, { movingRowId: undefined });
    }
  }

  /** Cancel changes only the existing SQLCipher conversation snapshot. */
  dismissProposal(rowId: string): void {
    const c = this.snapshot.conversations.find(x => x.id === this.snapshot.activeId);
    if (!c || c.busy || c.movingRowId || c.deleting || this.disposed) return;
    const row = c.rows.find(r => r.id === rowId && r.role === "assistant");
    if(row?.inboxApproval){
      this.inboxTriage.dismiss(c.id,rowId);
      this.update(c.id,{rows:[...c.rows.map(r=>r.id===rowId
        ? (({inboxApproval:_discard,...rest})=>rest)(r) : r),
        {id:Crypto.randomUUID(),role:"info",text:"Разбор «Входящих» отменён. Ничего не прочитано и не отправлено."}]},true);
      return;
    }
    const selected = row ? rowProposal(row) : undefined;
    if (!selected) return;
    const rows = c.rows.map(r => r.id === rowId ? selected.handler.withoutProposal(r) : r);
    this.update(c.id, { rows: [...rows, {
      id: Crypto.randomUUID(), role: "info" as const,
      text: selected.handler.dismissNotice,
    }] }, true);
  }

  /** Only handlers with a canonical undo operation can undo a stored receipt. */
  async undoProposal(rowId: string): Promise<void> {
    const c = this.snapshot.conversations.find(x => x.id === this.snapshot.activeId);
    const row = c?.rows.find(r => r.id === rowId && r.role === "assistant");
    const selected = row ? rowReceipt(row) : undefined;
    if (!c || !selected || !selected.handler.undo ||
        !selected.handler.presentReceipt(selected.receipt).undoable ||
        c.busy || c.movingRowId || c.deleting || this.disposed) return;
    const { handler, receipt } = selected;
    this.update(c.id, { movingRowId: rowId });
    try {
      const reversed = await handler.undo!(this.profile, receipt);
      const latest = this.snapshot.conversations.find(x => x.id === c.id);
      if (!latest || this.disposed) return;
      const current = latest.rows.find(r => r.id === rowId);
      if (!current || handler.receiptFromRow(current) !== receipt) {
        this.publish({ error: "Квитанция изменилась во время отмены. Проверьте актуальное состояние записи." });
        return;
      }
      const rows = latest.rows.map(r => r.id === rowId ? handler.withReceipt(r, reversed) : r);
      const patch = this.update(c.id, { rows: [...rows, {
        id: Crypto.randomUUID(), role: "info" as const,
        text: handler.undoNotice ? handler.undoNotice(receipt) : "Операция отменена.",
      }] });
      if (patch) await this.persist(patch);
      this.afterSave?.();
    } catch (error) {
      this.publish({ error: memoryErrorMessage(error) + (handler.undoErrorSuffix || "") });
    } finally {
      this.update(c.id, { movingRowId: undefined });
    }
  }

  /** Backward-compatible entry points for existing screens and tests. */
  async confirmSectionProposal(rowId: string): Promise<void> { return this.confirmProposal(rowId); }
  cancelSectionProposal(rowId: string): void { this.dismissProposal(rowId); }
  async confirmMoveProposal(rowId: string): Promise<void> { return this.confirmProposal(rowId); }
  cancelMoveProposal(rowId: string): void { this.dismissProposal(rowId); }
  async undoConfirmedMove(rowId: string): Promise<void> { return this.undoProposal(rowId); }

  async approve(draft: ChatDraft) {
    const c = this.snapshot.conversations.find(c => c.id === this.snapshot.activeId);
    if (!c || c.savingDraft || c.deleting || !c.drafts.some(d => d.id === draft.id)) return;
    this.update(c.id, { savingDraft: draft.id });
    try {
      await saveApprovedNote(this.profile, draft);
      if (draft.newSection && !draft.section) void this.refreshSections();
      this.afterSave?.();
      const latest = this.snapshot.conversations.find(x => x.id === c.id);
      if (latest) this.update(c.id, {
        ...(latest.taskState ? { taskState: recordEvidence(latest.taskState, { tool: "draft_memory_fact", outcome: "saved", subject: draft.id, excerpt: draft.title }) } : {}),
        drafts: latest.drafts.filter(d => d.id !== draft.id), rows: [...latest.rows,
        { id: Crypto.randomUUID(), role: "info", text: "Сохранено в разделе «" + draftSectionName(draft, this.snapshot.sections) + "»" +
          (draft.person && draft.kind !== "person" ? " и связано с записью «" + draft.person + "» в «Люди»." : ".") }] }, true);
    } catch (error) { this.publish({ error: memoryErrorMessage(error) }); }
    finally { this.update(c.id, { savingDraft: undefined }); }
  }
  dispose() {
    this.disposed = true;
    this.lifetime.abort();
    for (const request of this.requests.values()) request.abort();
    this.inboxTriage.revokeAll(); this.activeInboxTurns.clear(); this.stopInboxSessionWatch();
    this.requests.clear(); this.listeners.clear();
  }
}
