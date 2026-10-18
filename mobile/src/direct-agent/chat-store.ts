import * as Crypto from "expo-crypto";
import { runDirectAgent } from "./engine";
import { diagnosticTrace, redactDiagnostic } from "./diagnostics";
import { hostOf } from "./net";
import { proposableMemorySections, saveApprovedNote, searchApprovedNotes } from "./memory";
import { DEFAULT_SECTIONS } from "./fact-tool";
import type { MemorySection } from "./fact-tool";
import { conversationRepository } from "./conversations";
import type { ChatDraft, ConversationRepository, SavedConversation } from "./conversations";
import type { DirectAgentSettings } from "./settings";
import { waitForApplicationSession } from "../local-memory/storage";

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
        ...c, question: c.question || "", busy: false, progress: "", interrupted: false,
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
  async send(settings: DirectAgentSettings) {
    const id = this.snapshot.activeId;
    const current = this.snapshot.conversations.find(c => c.id === id);
    if (!id || !current || current.busy || current.deleting || !current.question.trim() || this.disposed) return;
    const prompt = current.question.trim();
    const trace = diagnosticTrace(this.profile, id, Crypto.randomUUID());
    const startedAt = Date.now();
    const aborter = new AbortController();
    this.requests.set(id, aborter);
    const previousSources = [...current.rows].reverse().filter(r => r.role === "assistant" && r.sources?.length).slice(0, 3).flatMap(r => r.sources!).slice(0, 15);
    const history = current.rows.filter(r => r.role !== "info").slice(-8)
      .map(r => ({ role: r.role as "user" | "assistant", content: r.text }));
    this.publish({ error: "" });
    const pending = this.update(id, {
      question: "", busy: true, progress: "Сохраняю вопрос…", updatedAt: new Date().toISOString(),
      title: current.rows.length ? current.title : prompt.slice(0, 60),
      rows: [...current.rows, { id: Crypto.randomUUID(), role: "user", text: prompt }],
    })!;
    let modelStarted = false;
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
      modelStarted = true;
      const result = await this.runner({ settings, prompt, history, previousSources, rewrite: true, signal: aborter.signal, onText, sections,
        diagnostic: trace,
        lookup: query => searchApprovedNotes(this.profile, query),
        notify: text => {
          trace("turn.notice", { chars: text.length }, { notice: text });
          const c = this.snapshot.conversations.find(c => c.id === id);
          if (c && !aborter.signal.aborted) this.update(id, { rows: [...c.rows, { id: Crypto.randomUUID(), role: "info", text }] }, true);
        },
        status: progress => { stage = progress; trace("turn.stage", { stage: progress }); if (!aborter.signal.aborted) this.update(id, { progress, progressSince: Date.now() }); },
        // "Запрос к LLM (1/4): подключаюсь к api.openai.com…" — the step and its network stage.
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
          if (c && !aborter.signal.aborted) this.update(id, { drafts: [...c.drafts, { ...note, id: Crypto.randomUUID() }] }, true);
        },
      });
      const c = this.snapshot.conversations.find(c => c.id === id);
      if (!c || this.disposed) return;
      if (aborter.signal.aborted) throw new Error("aborted");
      trace("turn.completed", { elapsedMs: Date.now() - startedAt, requests: result.requests,
        answerChars: result.text.length, sources: result.sources.length, memoryRefs: result.memory?.length || 0 }, { answer: result.text });
      this.update(id, { rows: [...c.rows,
        ...(result.notice ? [{ id: Crypto.randomUUID(), role: "info" as const, text: result.notice }] : []),
        { id: Crypto.randomUUID(), role: "assistant", text: result.text, sources: result.sources, ...(result.memory?.length ? { memory: result.memory } : {}) }],
        updatedAt: new Date().toISOString() });
    } catch (e) {
      trace("turn.failed", { elapsedMs: Date.now() - startedAt, aborted: aborter.signal.aborted,
        modelStarted, error: redactDiagnostic(String((e as Error)?.message || e)).slice(0, 500) });
      const c = this.snapshot.conversations.find(c => c.id === id);
      if (c && !this.disposed) this.update(id, {
        ...(!modelStarted && !aborter.signal.aborted ? { question: c.question || prompt } : {}),
        rows: [...c.rows, { id: Crypto.randomUUID(), role: "info",
          text: aborter.signal.aborted ? "Запрос остановлен" : !modelStarted ? "Запрос не отправлен: не удалось сохранить историю." : String((e as Error).message) }],
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
    if (c && c.savingDraft !== draft.id) this.update(c.id, { drafts: c.drafts.filter(d => d.id !== draft.id) }, true);
  }
  async approve(draft: ChatDraft) {
    const c = this.snapshot.conversations.find(c => c.id === this.snapshot.activeId);
    if (!c || c.savingDraft || c.deleting) return;
    this.update(c.id, { savingDraft: draft.id });
    try {
      await saveApprovedNote(this.profile, draft);
      if (draft.newSection && !draft.section) void this.refreshSections();
      this.afterSave?.();
      const latest = this.snapshot.conversations.find(x => x.id === c.id);
      if (latest) this.update(c.id, { drafts: latest.drafts.filter(d => d.id !== draft.id), rows: [...latest.rows,
        { id: Crypto.randomUUID(), role: "info", text: "Сохранено в разделе «" + draftSectionName(draft, this.snapshot.sections) + "»" +
          (draft.person && draft.kind !== "person" ? " и связано с записью «" + draft.person + "» в «Люди»." : ".") }] }, true);
    } catch { this.publish({ error: "Не удалось сохранить заметку. Повторите попытку." }); }
    finally { this.update(c.id, { savingDraft: undefined }); }
  }
  dispose() {
    this.disposed = true;
    this.lifetime.abort();
    for (const request of this.requests.values()) request.abort();
    this.requests.clear(); this.listeners.clear();
  }
}
