import { checkedChatAttachments, MAX_CONVERSATION_FILE_BYTES, type ChatAttachment } from "./chat-attachments";
import * as Crypto from "expo-crypto";
import { beginTask, mergeTaskReceipts, recordEvidence } from "./task-state";
import { webPreference } from "./dialogue";
import { runDirectAgent } from "./engine";
import { diagnosticTrace, redactDiagnostic } from "./diagnostics";
import { MAX_USER_PROMPT_CHARS } from "./limits";
import { loadModelCallLimit } from "./agent-preferences";
import { hostOf } from "./net";
import { proposableMemorySections, saveApprovedNote, searchApprovedNotes, readApprovedNote } from "./memory";
import { memoryErrorMessage } from "../local-memory/errors";
import { searchLocalApprovedSourceSegments, listLocalApprovedSourceSegments, readLocalApprovedSourceSegment } from "../local-memory/source-retrieval";
import { listAllowedNotes, countAllowedNotes } from "../local-memory/agent-catalog";
import { withLocalMemoryDatabase } from "../local-memory/storage";
import { DEFAULT_SECTIONS } from "./fact-tool";
import type { MemorySection } from "./fact-tool";
import { conversationRepository } from "./conversations";
import type { ChatDraft, ConversationRepository, SavedConversation } from "./conversations";
import type { DirectAgentSettings } from "./settings";
import { waitForApplicationSession } from "../local-memory/storage";
import { localPhotoIntent83, searchLocalPhotosFromChat83 } from "../media/vision-chat-search";

/** `streamText` is the answer as it arrives; it is never persisted. */
/** `progressSince` is when the current stage began, for the elapsed timer. */
export type LiveConversation = SavedConversation & { busy: boolean; progress: string; progressSince?: number; streamText?: string; savingDraft?: string; deleting?: boolean };
/** `notice` is informational (e.g. unreadable old chats), unlike `error`. */
/** `sections` are the memory sections a proposal can go to, the user's own included. */
export type ChatSnapshot = { ready: boolean; error: string; notice: string; conversations: LiveConversation[]; activeId: string | null; sections: MemorySection[] };
const newConversation = (): LiveConversation => {
  const timestamp = new Date().toISOString();
  return { id: Crypto.randomUUID(), title: "Новый диалог", createdAt: timestamp, updatedAt: timestamp,
    rows: [], drafts: [], question: "", busy: false, progress: "" };
};
const saved = ({ busy, progress, progressSince, streamText, savingDraft, deleting, ...conversation }: LiveConversation): SavedConversation =>
  ({ ...conversation, interrupted: busy });

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
  /** `afterSave` runs after an approved record is saved (index words in the background). */
  constructor(private profile: string, repository?: ConversationRepository, private runner = runDirectAgent, private afterSave?: () => void) {
    this.repository = repository || conversationRepository(profile, count => { this.skipped = count; });
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
    this.publish({ conversations: [conversation, ...this.snapshot.conversations], activeId: conversation.id, error: "" });
    void this.persist(conversation).catch(() => {});
  }
  select(id: string) {
    if (this.snapshot.conversations.some(c => c.id === id)) this.publish({ activeId: id, error: "" });
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
  /** Local visual retrieval is a chat turn, not a remote LLM request.
   * A captured camera image is *never* stored in a conversation or in Memory.
   * A normal attached photo also remains local for explicit photo-search turns.
   */
  async searchPhotosLocally(camera?: ChatAttachment, expectedConversationId?:string):Promise<void> {
    const id=expectedConversationId || this.snapshot.activeId;
    const current=this.snapshot.conversations.find(c=>c.id===id);
    if(!id || !current || id!==this.snapshot.activeId || current.busy ||
      current.deleting || this.disposed || !this.snapshot.ready)return;
    const prompt=camera ? "Найди похожие фотографии в моей памяти" : current.question.trim();
    const attachments=camera ? [camera] : checkedChatAttachments(current.attachments);
    const intent=localPhotoIntent83(prompt,attachments);
    if(!intent) return;
    const aborter=new AbortController();
    this.requests.set(id,aborter);
    const pending=this.update(id,{
      busy:true,progress:"Ищу фотографии в памяти…",updatedAt:new Date().toISOString(),
      // A direct camera search does not alter an unrelated unsent draft.
      ...(!camera?{question:"",attachments:[]}:{}),
      title:current.rows.length?current.title:prompt.slice(0,60),
      rows:[...current.rows,{id:Crypto.randomUUID(),role:"user",text:prompt}],
    })!;
    try {
      // Preserve the turn BEFORE running native inference, just like send().
      await this.persist(pending);
      if(aborter.signal.aborted || this.disposed)throw new Error("vision_query_cancelled");
      const result=await searchLocalPhotosFromChat83(this.profile,intent,attachments,aborter.signal);
      if(aborter.signal.aborted || this.disposed)throw new Error("vision_query_cancelled");
      const latest=this.snapshot.conversations.find(c=>c.id===id);
      if(latest)this.update(id,{
        rows:[...latest.rows,{id:Crypto.randomUUID(),role:"assistant",
          text:result.text,memory:result.memory}],updatedAt:new Date().toISOString(),
      });
    } catch(e) {
      if(this.disposed)return;
      const latest=this.snapshot.conversations.find(c=>c.id===id);
      if(latest)this.update(id,{
        rows:[...latest.rows,{id:Crypto.randomUUID(),role:"info",
          text:aborter.signal.aborted?"Поиск фотографий остановлен":memoryErrorMessage(e)}],
      });
    } finally {
      this.requests.delete(id);
      const latest=this.update(id,{busy:false,progress:"",progressSince:undefined});
      if(latest)await this.persist(latest).catch(()=>{});
    }
  }

  async send(settings: DirectAgentSettings) {
    const id = this.snapshot.activeId;
    const current = this.snapshot.conversations.find(c => c.id === id);
    if (!id || !current || current.busy || current.deleting || (!current.question.trim() && !current.attachments?.length) || this.disposed) return;
    const prompt = current.question.trim() || "Посмотри приложенные файлы.";
    const attachments = checkedChatAttachments(current.attachments);
    // Explicit photo intent runs only against encrypted device memory.
    // Do not send user image bytes or photo search text to the remote LLM.
    if (localPhotoIntent83(prompt,attachments)) {
      await this.searchPhotosLocally(); return;
    }
    if (prompt.length > MAX_USER_PROMPT_CHARS) {
      this.publish({ error: "Сообщение длиннее 24 000 символов. Разделите его на части: текст не отправлен и не обрезан." });
      return;
    }
    const trace = diagnosticTrace(this.profile, id, Crypto.randomUUID());
    const startedAt = Date.now();
    const aborter = new AbortController();
    this.requests.set(id, aborter);
    const previousSources = [...current.rows].reverse().filter(r => r.role === "assistant" && r.sources?.length).slice(0, 3).flatMap(r => r.sources!).slice(0, 15);
    const history = current.rows.filter(r => r.role !== "info").slice(-8)
      .map(r => ({ role: r.role as "user" | "assistant", content: r.text, ...(r.attachments?.length ? {attachments:r.attachments} : {}) }));
    const taskState = { ...beginTask(current.taskState, prompt), webPreference: webPreference({ prompt, history, taskState: current.taskState }) };
    this.publish({ error: "" });
    const pending = this.update(id, {
      taskState, question: "", attachments: [], busy: true, progress: "Сохраняю вопрос…", updatedAt: new Date().toISOString(),
      title: current.rows.length ? current.title : prompt.slice(0, 60),
      rows: [...current.rows, { id: Crypto.randomUUID(), role: "user", text: prompt, ...(attachments.length ? {attachments} : {}) }],
    })!;
    let modelStarted = false;
    let beforeModelError = "Запрос не отправлен: не удалось сохранить историю.";
    const host = hostOf(settings.baseUrl || "https://api.openai.com/v1");
    trace("turn.start", { provider: settings.provider, model: settings.model, host, promptChars: prompt.length,
      historyTurns: history.length, previousSources: previousSources.length, webEnabled: settings.allowWeb }, { prompt });
    let stage = "";
    // Repaint at most every 60 ms while tokens arrive.
    let latest = ""; let paint: ReturnType<typeof setTimeout> | null = null;
    const onText = (text: string) => {
      latest = text;
      if (paint || aborter.signal.aborted) return;
      paint = setTimeout(() => { paint = null; if (!aborter.signal.aborted) this.update(id, { streamText: latest }); }, 60);
    };
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
      modelStarted = true;
      const result = await this.runner({ settings, maxRequests, prompt, attachments, history, previousSources, taskState, pendingNotes: current.drafts,
        onTaskState: next => {
          const active = this.snapshot.conversations.find(c => c.id === id);
          if (active && !aborter.signal.aborted) this.update(id, { taskState: mergeTaskReceipts(next, active.taskState) }, true);
        }, rewrite: true, signal: aborter.signal, onText, sections,
        diagnostic: trace,
        lookup: query => searchApprovedNotes(this.profile, query),
        read: async (id, version, offset, budget) => ({ ...await readApprovedNote(this.profile, id, version, offset, budget) }),
        searchSources: async (query, limit) => ({
          ...await searchLocalApprovedSourceSegments(this.profile, query, limit),
        }),
        listSources: async (id, version, limit) => ({
          ...await listLocalApprovedSourceSegments(this.profile, id, version, limit),
        }),
        readSource: async (id, version, attachmentId, extractionId, segmentId, offset, budget) => ({
          ...await readLocalApprovedSourceSegment(this.profile, id, version,
            attachmentId, extractionId, segmentId, offset, budget),
        }),
        list: async filters => ({ ...await withLocalMemoryDatabase(this.profile, db => listAllowedNotes(db, filters)) }),
        count: async filters => ({ ...await withLocalMemoryDatabase(this.profile, db => countAllowedNotes(db, filters)) }),
        notify: text => {
          trace("turn.notice", { chars: text.length }, { notice: text });
          const c = this.snapshot.conversations.find(c => c.id === id);
          if (c && !aborter.signal.aborted) this.update(id, { rows: [...c.rows, { id: Crypto.randomUUID(), role: "info", text }] }, true);
        },
        status: progress => { stage = progress; trace("turn.stage", { stage: progress }); if (!aborter.signal.aborted) this.update(id, { progress, progressSince: Date.now() }); },
        // Example: "Запрос к LLM (1/5): подключаюсь к api.openai.com…" — step and network stage; denominator follows saved profile limit.
        phase: phase => {
          trace("turn.network_phase", { phase });
          if (aborter.signal.aborted) return;
          const detail = phase === "connecting" ? "подключаюсь к " + host + "…" : phase === "waiting" ? "модель думает…" : "пишет ответ…";
          this.update(id, { progress: stage ? stage + ": " + detail : detail[0].toUpperCase() + detail.slice(1), progressSince: Date.now() });
        },
        propose: note => {
          trace("memory.proposal", { section: note.section || null, newSection: Boolean(note.newSection),
            titleChars: note.title.length, bodyChars: note.body.length }, { title: note.title, body: note.body });
          const c = this.snapshot.conversations.find(c => c.id === id);
          if (c && !aborter.signal.aborted) {
            const draftId = Crypto.randomUUID();
            this.update(id, { drafts: [...c.drafts, { ...note, id: draftId }] }, true);
            return draftId;
          }
        },
      });
      const c = this.snapshot.conversations.find(c => c.id === id);
      if (!c || this.disposed) return;
      if (aborter.signal.aborted) throw new Error("aborted");
      trace("turn.completed", { elapsedMs: Date.now() - startedAt, requests: result.requests,
        answerChars: result.text.length, sources: result.sources.length, memoryRefs: result.memory?.length || 0 },
        { answer: result.text, sources: result.sources.join("\n") });
      this.update(id, { taskState: mergeTaskReceipts({ ...(result.taskState || c.taskState || taskState), turnStatus: "answered" }, c.taskState), rows: [...c.rows,
        ...(result.proposalIds?.some(id => c.drafts.some(d => d.id === id)) ? [{ id: Crypto.randomUUID(), role: "info" as const, text: "Запись подготовлена, но ещё не сохранена. Подтвердите её в карточке предложения." }] : []),
        ...(result.notice ? [{ id: Crypto.randomUUID(), role: "info" as const, text: result.notice }] : []),
        { id: Crypto.randomUUID(), role: "assistant", text: result.text, sources: result.sources, ...(result.memory?.length ? { memory: result.memory } : {}) }],
        updatedAt: new Date().toISOString() });
    } catch (e) {
      trace("turn.failed", { elapsedMs: Date.now() - startedAt, aborted: aborter.signal.aborted,
        modelStarted, errorType: (e as Error)?.name || "Error" },
        { error: redactDiagnostic(String((e as Error)?.message || e)).slice(0, 500) });
      const c = this.snapshot.conversations.find(c => c.id === id);
      if (c && !this.disposed) this.update(id, {
        taskState: { ...(c.taskState || taskState), turnStatus: "interrupted" },
        ...(!modelStarted && !aborter.signal.aborted ? { question: c.question || prompt, attachments } : {}),
        rows: [...c.rows, { id: Crypto.randomUUID(), role: "info",
          text: aborter.signal.aborted ? "Запрос остановлен" : !modelStarted ? beforeModelError : String((e as Error).message) }],
      });
    } finally {
      trace("turn.finished", { elapsedMs: Date.now() - startedAt });
      this.requests.delete(id);
      if (paint) clearTimeout(paint);
      const final = this.update(id, { busy: false, progress: "", progressSince: undefined, streamText: undefined });
      if (final) await this.persist(final).catch(() => {});
    }
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
    this.requests.clear(); this.listeners.clear();
  }
}
