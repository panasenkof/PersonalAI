import { checkedChatAttachments, MAX_CONVERSATION_FILE_BYTES, type ChatAttachment } from "./chat-attachments";
import { historyForImageCapability, imageCapability } from "./attachment-capabilities";
import * as Crypto from "expo-crypto";
import { beginTask, mergeTaskReceipts, recordEvidence } from "./task-state";
import { webPreference } from "./dialogue";
import { runDirectAgent } from "./engine";
import { historyWithoutLargeDocuments, planDocumentSynthesis, runDocumentSynthesis } from "./document-synthesis";
import { planDialogueSummary, runDialogueSummary, type DialogueSummaryScope } from "./dialogue-summary";
import { diagnosticTrace, redactDiagnostic } from "./diagnostics";
import { MAX_USER_PROMPT_CHARS } from "./limits";
import { loadModelCallLimit } from "./agent-preferences";
import { hostOf } from "./net";
import { proposableMemorySections, saveApprovedNote, searchApprovedNotes, readApprovedNote } from "./memory";
import { memoryErrorMessage } from "../local-memory/errors";
import { searchLocalApprovedSourceSegments, listLocalApprovedSourceSegments, readLocalApprovedSourceSegment } from "../local-memory/source-retrieval";
import { listAllowedNotes, countAllowedNotes } from "../local-memory/agent-catalog";
import { withLocalMemoryDatabase, localMemorySessionUnlocked } from "../local-memory/storage";
import { DEFAULT_SECTIONS } from "./fact-tool";
import type { MemorySection } from "./fact-tool";
import { conversationRepository } from "./conversations";
import type { ChatDraft, ConversationRepository, SavedConversation } from "./conversations";
import type { DirectAgentSettings } from "./settings";
import { waitForApplicationSession, onLocalMemorySessionChange } from "../local-memory/storage";
import { localPhotoIntent83, localPhotoSuggestion83, searchLocalPhotosFromChat83 } from "../media/vision-chat-search";
import { savedAiArticleIntent, selectSavedAiArticles, savedAiArticlePageIntent } from "./article-selection";

/** Publication days are site assertions, never independently verified facts. */
function articleDateLabel(record:{createdAt:string;publicationDay?:string}, dateMode:"saved"|"published"):string {
  if(dateMode==="published")return "дата публикации по сайту "+(record.publicationDay||"неизвестна");
  return "сохранено "+(Number.isFinite(Date.parse(record.createdAt))
    ? new Date(record.createdAt).toLocaleDateString("ru-RU") : "дата неизвестна");
}
/** `streamText` is the answer as it arrives; it is never persisted. */
/** `progressSince` is when the current stage began, for the elapsed timer. */
export type LiveConversation = SavedConversation & { retryPhoto?: {rowId:string; image:ChatAttachment}; busy: boolean; progress: string; progressSince?: number; streamText?: string; savingDraft?: string; deleting?: boolean };
/** `notice` is informational (e.g. unreadable old chats), unlike `error`. */
/** `sections` are the memory sections a proposal can go to, the user's own included. */
export type ChatSnapshot = { ready: boolean; error: string; notice: string; conversations: LiveConversation[]; activeId: string | null; sections: MemorySection[] };
const newConversation = (): LiveConversation => {
  const timestamp = new Date().toISOString();
  return { id: Crypto.randomUUID(), title: "Новый диалог", createdAt: timestamp, updatedAt: timestamp,
    rows: [], drafts: [], question: "", busy: false, progress: "" };
};
const saved = ({ busy, progress, progressSince, streamText, savingDraft, deleting, retryPhoto, ...conversation }: LiveConversation): SavedConversation =>
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
  async searchPhotosLocally(camera?: ChatAttachment, expectedConversationId?:string, suggested = false):Promise<void> {
    const id=expectedConversationId || this.snapshot.activeId;
    const current=this.snapshot.conversations.find(c=>c.id===id);
    if(!id || !current || id!==this.snapshot.activeId || current.busy ||
      current.deleting || this.disposed || !this.snapshot.ready)return;
    const prompt=camera ? "Найди похожие фотографии в моей памяти" : current.question.trim();
    const attachments=camera ? [camera] : checkedChatAttachments(current.attachments);
    const intent=suggested ? localPhotoSuggestion83(prompt,attachments) : localPhotoIntent83(prompt,attachments);
    if(!intent) return;
    const aborter=new AbortController();
    this.requests.set(id,aborter);
    const pending=this.update(id,{
      retryPhoto:undefined,busy:true,progress:"Ищу фотографии в памяти…",updatedAt:new Date().toISOString(),
      // An explicit sent text query consumes its draft, like normal send().
      // One-tap camera/gallery searches preserve any unrelated unsent draft.
      // On failure restore the consumed draft only if the user has not typed a replacement.
      question:camera ? current.question : "",
      // A one-tap image search consumes only its selected image, not other
      // draft files or the user's unsent text. Hide the action panel immediately.
      attachments:camera
        ? (current.attachments || []).filter(file=>file.id!==camera.id)
        : [],
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
      const rowId = Crypto.randomUUID();
      if(latest)this.update(id,{
        retryPhoto:camera && result.photoAction ? {rowId,image:camera} : undefined,
        rows:[...latest.rows,{id:rowId,role:"assistant",
          text:result.text,memory:result.memory,photoAction:result.photoAction}],updatedAt:new Date().toISOString(),
      });
    } catch(e) {
      if(this.disposed)return;
      const rowId = Crypto.randomUUID();
      const latest=this.snapshot.conversations.find(c=>c.id===id);
      if(latest)this.update(id,{
        ...(camera && !aborter.signal.aborted ? {retryPhoto:{rowId,image:camera}} : {}),
        ...(!camera && latest.question === "" ? {question:current.question,attachments:current.attachments} : {}),
        rows:[...latest.rows,{id:rowId,role:"info",
          text:aborter.signal.aborted?"Поиск фотографий остановлен":memoryErrorMessage(e)}],
      });
    } finally {
      this.requests.delete(id);
      const latest=this.update(id,{busy:false,progress:"",progressSince:undefined});
      if(latest)await this.persist(latest).catch(()=>{});
    }
  }

  /** Stage 9A1: ordinary chat selection is a local READ, not a paid model turn.
   * The saved URL is not proof of a fully read article; only the linked note
   * can be opened. Follow-up summaries and more pages belong to 9A2/9B.
   */
  async searchSavedArticlesLocally(): Promise<void> {
    const id=this.snapshot.activeId;
    const current=this.snapshot.conversations.find(c=>c.id===id);
    if(!id || !current || current.busy || current.deleting || this.disposed || !this.snapshot.ready)return;
    const prompt=current.question.trim();
    const intent=savedAiArticleIntent(prompt,new Date(),Boolean(current.attachments?.length));
    if(!intent)return;
    const aborter=new AbortController();
    this.requests.set(id,aborter);
    const pending=this.update(id,{
      busy:true,progress:"Подбираю сохранённые материалы…",updatedAt:new Date().toISOString(),
      question:"",title:current.rows.length?current.title:prompt.slice(0,60),
      rows:[...current.rows,{id:Crypto.randomUUID(),role:"user",text:prompt}],
    })!;
    try {
      await this.persist(pending);
      if(aborter.signal.aborted||this.disposed)throw new Error("aborted");
      const found=await selectSavedAiArticles(this.profile,intent);
      // A lock after the SQL snapshot must prevent a delayed chat update.
      if(!localMemorySessionUnlocked())throw new Error("application_locked");
      if(aborter.signal.aborted||this.disposed)throw new Error("aborted");
      const latest=this.snapshot.conversations.find(c=>c.id===id);
      if(!latest)return;
      const dates=intent.startLocal.split("-").reverse().join(".")+"–"+intent.endLocal.split("-").reverse().join(".");
      const titles=found.records.map((n,i)=>
        (i+1)+". "+(n.title||"Без названия")+" · "+articleDateLabel(n,intent.dateMode)+
        (typeof n.duplicateCount === "number" && Number.isSafeInteger(n.duplicateCount) && n.duplicateCount>0
          ? " · ещё доступных сохранений этого URL: "+n.duplicateCount : "")).join("\n");
      const subject=intent.topic==="ai" ? "по ключевым словам об ИИ" :
        "по точной фразе «"+intent.topic+"»";
      const head=found.count
        ? "Найдено "+found.count+" сохранённых материалов со ссылкой "+subject+". "+(intent.dateMode==="published" ? "Период публикации по данным сайта: " : "Даты сохранения: ")+dates+
          ". Показано "+found.records.length+(found.hasMore?"; это только первая страница.":".")
        : "За "+dates+" сохранённых материалов со ссылкой "+subject+" не найдено "+(intent.dateMode==="published" ? "с датой публикации по данным сайта." : "по дате сохранения.");
      this.update(id,{updatedAt:new Date().toISOString(),
        rows:[...latest.rows,{id:Crypto.randomUUID(),role:"assistant",
          text:head+(titles?"\n\n"+titles:"")+
            (intent.dateMode==="published" ? "\n\nДата публикации заявлена сайтом, не проверена независимо. Материалов по теме с неизвестной датой публикации: "+(found.unknownPublicationCount??0)+"." : "")+
            "\n\nПоиск выполнен только в памяти телефона. Ссылки открывают оригинальные заметки. Сохранённая ссылка не означает, что полный текст статьи был прочитан; другие заметки без URL здесь не учитывались.",
          memory:found.records.map(n=>({id:n.id,title:n.title||"Без названия",section:n.section,via:"search" as const})),
          articlePage:{kind:intent.topic==="ai" ? "saved_ai_links" as const : "saved_topic_links" as const,
            ...(intent.dateMode==="published" ? {dateMode:"published" as const} : {}),
            ...(intent.topic!=="ai" ? {topic:intent.topic,queryTerms:intent.queryTerms} : {}),
            savedFrom:intent.savedFrom,savedBefore:intent.savedBefore,
            startLocal:intent.startLocal,endLocal:intent.endLocal,
            ...(found.nextCursor ? {nextCursor:found.nextCursor} : {}),
            selected:found.records.map(n=>({id:n.id,version:n.version}))}}],
      });
    }catch(e){
      if(this.disposed)return;
      const latest=this.snapshot.conversations.find(c=>c.id===id);
      if(latest)this.update(id,{
        ...(!aborter.signal.aborted&&latest.question===""?{question:prompt}:{}),
        rows:[...latest.rows,{id:Crypto.randomUUID(),role:"info",
          text:aborter.signal.aborted?"Подборка остановлена":memoryErrorMessage(e),
          ...(!aborter.signal.aborted?{error:true as const}:{})}],
      });
    }finally{
      this.requests.delete(id);
      const latest=this.update(id,{busy:false,progress:"",progressSince:undefined});
      if(latest)await this.persist(latest).catch(()=>{});
    }
  }

  /** Continue an existing shortlist in the ordinary chat without a model call.
   * Each page re-runs the same ACL-scoped SQL query; only the cursor and time
   * window are persisted, never copied source contents.
   */
  async loadMoreSavedArticlesLocally(sourceRowId:string, fromComposer=false):Promise<void> {
    const id=this.snapshot.activeId;
    const current=this.snapshot.conversations.find(c=>c.id===id);
    const previous=current?.rows.find(row=>row.id===sourceRowId && row.role==="assistant");
    const page=previous?.articlePage;
    if(!id || !current || !page?.nextCursor || current.busy || current.deleting ||
      this.disposed || !this.snapshot.ready || (fromComposer && Boolean(current.attachments?.length)))return;
    const aborter=new AbortController();
    this.requests.set(id,aborter);
    const pending=this.update(id,{
      busy:true,progress:"Загружаю следующую страницу…",updatedAt:new Date().toISOString(),
      question:fromComposer?"":current.question,
      rows:[...current.rows,{id:Crypto.randomUUID(),role:"user",text:"Показать ещё"}],
    })!;
    try {
      await this.persist(pending);
      if(aborter.signal.aborted || this.disposed)throw new Error("aborted");
      const found=await selectSavedAiArticles(this.profile,savedAiArticlePageIntent(page),
        undefined,page.nextCursor);
      if(!localMemorySessionUnlocked())throw new Error("application_locked");
      if(aborter.signal.aborted || this.disposed)throw new Error("aborted");
      const latest=this.snapshot.conversations.find(c=>c.id===id);
      if(!latest)return;
      const titles=found.records.map((n,i)=>
        (i+1)+". "+(n.title||"Без названия")+" · "+articleDateLabel(n,page.dateMode||"saved")+
        (typeof n.duplicateCount === "number" && Number.isSafeInteger(n.duplicateCount) && n.duplicateCount>0
          ? " · ещё доступных сохранений этого URL: "+n.duplicateCount : "")).join("\n");
      const text=found.records.length
        ? "Следующая страница: "+found.records.length+" сохранённых материалов со ссылками. Сейчас по этому фильтру доступно "+found.count+
          (found.hasMore?"; есть следующие страницы.":".")+
          (page.dateMode==="published" ? " Даты — по данным сайтов, не проверены независимо. С неизвестной датой: "+(found.unknownPublicationCount??0)+"." : "")+
          "\n\n"+titles+"\n\nПоиск локальный; полный текст ссылок не прочитан. Открывайте записи ниже."
        : "Больше доступных сохранённых материалов по этому фильтру нет. Состав памяти мог измениться с предыдущего запроса.";
      this.update(id,{updatedAt:new Date().toISOString(),rows:[
        ...latest.rows.map(row=>row.id===sourceRowId && row.articlePage
          ? {...row,articlePage:{...row.articlePage,nextCursor:undefined}} : row),
        {id:Crypto.randomUUID(),role:"assistant",text,
          memory:found.records.map(n=>({id:n.id,title:n.title||"Без названия",
            section:n.section,via:"search" as const})),
          articlePage:{kind:page.kind,savedFrom:page.savedFrom,savedBefore:page.savedBefore,
            ...(page.dateMode==="published" ? {dateMode:"published" as const} : {}),
            ...(page.kind==="saved_topic_links" ? {topic:page.topic,queryTerms:page.queryTerms} : {}),
            startLocal:page.startLocal,endLocal:page.endLocal,
            ...(found.nextCursor ? {nextCursor:found.nextCursor} : {}),
            selected:[...(page.selected||[]),...found.records.map(n=>({id:n.id,version:n.version}))]
              .filter((n,i,all)=>all.findIndex(m=>m.id===n.id)===i).slice(-24)}},
      ]});
    }catch(e){
      if(this.disposed)return;
      const latest=this.snapshot.conversations.find(c=>c.id===id);
      if(latest)this.update(id,{
        ...(fromComposer && !aborter.signal.aborted && latest.question==="" ? {question:current.question} : {}),
        rows:[...latest.rows,{id:Crypto.randomUUID(),role:"info",
          text:aborter.signal.aborted?"Подборка остановлена":memoryErrorMessage(e),
          ...(!aborter.signal.aborted?{error:true as const}:{})}],
      });
    }finally{
      this.requests.delete(id);
      const latest=this.update(id,{busy:false,progress:"",progressSince:undefined});
      if(latest)await this.persist(latest).catch(()=>{});
    }
  }

  /** Explicit internet photo action reuses the existing model and web tools,
   * without consuming the user's unrelated composer draft. */
  async send(settings: DirectAgentSettings, internetPhotoId?:string, documentApprovalKey?:string, rerun = false) {
    const id = this.snapshot.activeId;
    const current = this.snapshot.conversations.find(c => c.id === id);
    if (!id || !current || current.busy || current.deleting || this.disposed ||
      (!internetPhotoId && !current.question.trim() && !current.attachments?.length)) return;
    const selected=internetPhotoId ? current.attachments?.find(f=>f.id===internetPhotoId && f.kind==="image") : undefined;
    if(internetPhotoId && (!selected || !settings.allowWeb))return;
    const prompt = internetPhotoId
      ? "Найди в интернете сведения о том, что изображено на приложенной фотографии. Определи объект по фото, затем воспользуйся разрешённым веб-поиском. Ответь по-русски, приведи проверяемые факты и ссылки на реальные источники. Если изображение или поиск недоступны, сообщи об этом, не выдумывай источники."
      : current.question.trim() || "Посмотри приложенные файлы.";
    const displayPrompt = internetPhotoId ? "Что изображено на фото? Найти информацию в интернете" : prompt;
    const attachments = checkedChatAttachments(internetPhotoId ? [selected!] : current.attachments);
    let documentPlan;
    try { documentPlan = internetPhotoId ? null : planDocumentSynthesis(attachments,settings.model); }
    catch(e) { this.publish({error:String((e as Error).message)}); return; }
    if(documentPlan && documentApprovalKey!==documentPlan.approvalKey) {
      this.publish({notice:"Для отправки большого документа подтвердите объём и вызовы ИИ в окне отправки."});
      return;
    }
    // A contextual "Покажи ещё" remains on-device; unrelated requests still use the usual runner.
    if (!internetPhotoId && !attachments.length &&
        /^(?:покажи|показать)\s+ещ[её](?:\s+(?:материалы|статьи|записи))?[.!?]?$/iu.test(prompt)) {
      const page=[...current.rows].reverse().find(row=>row.role==="assistant" && row.articlePage?.nextCursor);
      if(page){await this.loadMoreSavedArticlesLocally(page.id,true);return;}
    }
    // Explicit photo intent runs only against encrypted device memory.
    // Do not send user image bytes or photo search text to the remote LLM.
    // Specific saved-article intent precedes generic object/photo search.
    if (!internetPhotoId && savedAiArticleIntent(prompt,new Date(),attachments.length>0)) {
      await this.searchSavedArticlesLocally(); return;
    }
    if (!internetPhotoId && localPhotoIntent83(prompt,attachments)) {
      await this.searchPhotosLocally(); return;
    }
    // Recheck the ACTIVE model at the moment of Send (not the model selected
    // when a draft photo was picked). Refuse known text-only routes before
    // consuming the draft, persisting a user turn, or making a network call.
    if (imageCapability(settings,attachments) === "unsupported") {
      this.publish({ notice:"Выбранная модель «" + settings.model +
        "» не принимает изображения. Фото осталось в черновике; выберите модель с поддержкой фото или уберите вложение." });
      return;
    }
    if (prompt.length > MAX_USER_PROMPT_CHARS) {
      this.publish({ error: "Сообщение длиннее 24 000 символов. Разделите его на части: текст не отправлен и не обрезан." });
      return;
    }
    const trace = diagnosticTrace(this.profile, id, Crypto.randomUUID());
    const startedAt = Date.now();
    const aborter = new AbortController();
    this.requests.set(id, aborter);
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
    this.publish({ error: "" });
    const pending = this.update(id, {
      taskState, question: internetPhotoId ? current.question : "",
      // Once the user confirms web lookup, the chosen photo is submitted in
      // the user turn and leaves the draft. Other files are never uploaded.
      attachments: internetPhotoId
        ? (current.attachments || []).filter(file=>file.id!==internetPhotoId)
        : [],
      busy: true, progress: "Сохраняю вопрос…", updatedAt: new Date().toISOString(),
      title: current.rows.length ? current.title : displayPrompt.slice(0, 60),
      // A retry re-runs the same question: the user bubble already exists.
      rows: rerun ? current.rows : [...current.rows, { id: Crypto.randomUUID(), role: "user", text: displayPrompt, ...(attachments.length ? {attachments} : {}) }],
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
      if(documentPlan && documentPlan.calls>maxRequests)throw new Error("Для полного анализа требуется "+documentPlan.calls+" обращений к модели, но в настройках разрешено "+maxRequests+". Измените лимит перед отправкой.");
      modelStarted = true;
      const articleContinuation=[...current.rows].reverse().find(row=>
        row.role==="assistant" && row.articlePage?.nextCursor)?.articlePage;
      const agentOptions: Parameters<typeof runDirectAgent>[0] = { settings, maxRequests, prompt, attachments, skipLocalMemory:Boolean(internetPhotoId), history, previousSources, taskState, pendingNotes: internetPhotoId ? [] : current.drafts,
        ...(!internetPhotoId && articleContinuation ? {articleContinuation} : {}),
        onTaskState: next => {
          const active = this.snapshot.conversations.find(c => c.id === id);
          if (active && !aborter.signal.aborted) this.update(id, { taskState: mergeTaskReceipts(next, active.taskState) }, true);
        }, rewrite: true, signal: aborter.signal, onText, sections,
        diagnostic: trace,
        lookup: query => searchApprovedNotes(this.profile, query),
        read: async (id, version, offset, budget) => ({ ...await readApprovedNote(this.profile, id, version, offset, budget) }),
        searchSources: async (query, limit, offset) => ({
          ...await searchLocalApprovedSourceSegments(this.profile, query, limit, offset),
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
        selectArticles: async (intent, cursor) => {
          // Reuse the same SQLCipher reader as the no-model article picker.
          // A mid-call lock, profile suspension or cancellation must not leak its result.
          if (aborter.signal.aborted || !localMemorySessionUnlocked()) throw new Error("application_locked");
          const page = await selectSavedAiArticles(this.profile, intent, undefined, cursor);
          if (aborter.signal.aborted || !localMemorySessionUnlocked()) throw new Error("application_locked");
          return page;
        },
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
      };
      const result = documentPlan ? await runDocumentSynthesis(agentOptions,documentPlan,this.runner) : await this.runner(agentOptions);
      const c = this.snapshot.conversations.find(c => c.id === id);
      if (!c || this.disposed) return;
      if (aborter.signal.aborted) throw new Error("aborted");
      trace("turn.completed", { elapsedMs: Date.now() - startedAt, requests: result.requests,
        answerChars: result.text.length, sources: result.sources.length, memoryRefs: result.memory?.length || 0 },
        { answer: result.text, sources: result.sources.join("\n") });
      this.update(id, { taskState: mergeTaskReceipts({ ...(result.taskState || c.taskState || taskState), turnStatus: "answered" }, c.taskState), rows: [...c.rows,
        ...(result.proposalIds?.some(id => c.drafts.some(d => d.id === id)) ? [{ id: Crypto.randomUUID(), role: "info" as const, text: "Запись подготовлена, но ещё не сохранена. Подтвердите её в карточке предложения." }] : []),
        ...(result.notice ? [{ id: Crypto.randomUUID(), role: "info" as const, text: result.notice }] : []),
        { id: Crypto.randomUUID(), role: "assistant", text: result.text, sources: result.sources,
          ...(result.memory?.length ? { memory: result.memory } : {}),
          ...(result.articlePage ? {articlePage:result.articlePage} : {}) }],
        updatedAt: new Date().toISOString() });
    } catch (e) {
      trace("turn.failed", { elapsedMs: Date.now() - startedAt, aborted: aborter.signal.aborted,
        modelStarted, errorType: (e as Error)?.name || "Error" },
        { error: redactDiagnostic(String((e as Error)?.message || e)).slice(0, 500) });
      const c = this.snapshot.conversations.find(c => c.id === id);
      if (c && !this.disposed) {
        // Stop must not throw away what the model already produced: the user
        // stops precisely when the needed fragment has arrived.
        const aborted = aborter.signal.aborted;
        const partial = aborted ? latest.trim() : "";
        this.update(id, {
          taskState: { ...(c.taskState || taskState), turnStatus: "interrupted" },
          ...(!internetPhotoId && !modelStarted && !aborted ? { question: c.question || prompt, attachments } : {}),
          rows: [...c.rows,
            ...(partial ? [{ id: Crypto.randomUUID(), role: "assistant" as const, text: partial }] : []),
            { id: Crypto.randomUUID(), role: "info", ...(aborted ? {} : { error: true as const }),
              text: aborted ? (partial ? "Ответ остановлен" : "Запрос остановлен") : !modelStarted ? beforeModelError : String((e as Error).message) }],
        });
      }
    } finally {
      trace("turn.finished", { elapsedMs: Date.now() - startedAt });
      this.requests.delete(id);
      if (paint) clearTimeout(paint);
      const final = this.update(id, { busy: false, progress: "", progressSince: undefined, streamText: undefined });
      if (final) await this.persist(final).catch(() => {});
    }
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
  /** H-SAVE1b: explicit, bounded summary of a chosen history range. Only the
   * existing SQLCipher conversation writer persists the generated preview.
   * Nothing is written into memory until the existing note editor saves it. */
  async summarizeForNote(
    conversationId: string, settings: DirectAgentSettings,
    scope: DialogueSummaryScope, approvalKey: string,
  ): Promise<{conversationId:string;rowId:string}> {
    const current=this.snapshot.conversations.find(c=>c.id===conversationId);
    if (!this.snapshot.ready || this.disposed || !current || current.busy || current.deleting ||
        this.requests.has(conversationId))
      throw new Error("Диалог занят или недоступен. Дождитесь завершения ответа.");
    const plan=planDialogueSummary(current,scope,settings.model,settings.provider);
    if (plan.approvalKey!==approvalKey)
      throw new Error("После подтверждения переписка или модель изменились. Подтвердите диапазон заново.");
    const maxRequests=await loadModelCallLimit(this.profile);
    if (plan.calls>maxRequests)
      throw new Error("Нужно "+plan.calls+" обращений к модели, разрешено "+maxRequests+". Ничего не отправлено.");
    const latest=this.snapshot.conversations.find(c=>c.id===conversationId);
    if (!latest || latest.busy || latest.deleting || this.requests.has(conversationId) ||
        planDialogueSummary(latest,scope,settings.model,settings.provider).approvalKey!==approvalKey)
      throw new Error("Диалог изменился до начала обработки. Повторите подтверждение.");
    const aborter=new AbortController();
    this.requests.set(conversationId,aborter);
    // Unlike ordinary visible chat responses, an optional paid whole-history
    // export stops as soon as AppLock closes; never continue shipping text.
    const offSession=onLocalMemorySessionChange(unlocked=>{if(!unlocked)aborter.abort();});
    this.update(conversationId,{busy:true,progress:"Готовлю итог диалога…",progressSince:Date.now()});
    try {
      await waitForApplicationSession(this.lifetime.signal);
      if(this.disposed || aborter.signal.aborted)throw new Error("Создание итога отменено.");
      const result=await runDialogueSummary({
        settings, prompt:"Составить итог переписки",history:[],maxRequests,
        signal:aborter.signal, lookup:async()=>[],propose:()=>undefined,
        status:progress=>{if(!aborter.signal.aborted)this.update(conversationId,{progress,progressSince:Date.now()});},
      },plan,this.runner);
      if(this.disposed || aborter.signal.aborted)throw new Error("Создание итога отменено.");
      const beforeSave=this.snapshot.conversations.find(c=>c.id===conversationId);
      if(!beforeSave || beforeSave.deleting ||
          planDialogueSummary(beforeSave,scope,settings.model,settings.provider).approvalKey!==approvalKey)
        throw new Error("История изменилась во время составления итога. Результат не сохранён.");
      const rowId=Crypto.randomUUID();
      const createdAt=new Date().toISOString();
      const rows=[...beforeSave.rows,{id:rowId,role:"assistant" as const,text:result.body,
        dialogueSummary:{scope:plan.scope,includedRows:plan.includedRows,totalRows:plan.totalRows,
          omittedAttachments:plan.omittedAttachments,sourceChars:plan.source.length,
          parts:plan.parts.length,firstRowId:plan.firstRowId,lastRowId:plan.lastRowId,
          model:settings.model,provider:settings.provider,createdAt}}];
      // Durability before navigating to a note. Do not create a new writer.
      await this.persist({...beforeSave,rows,updatedAt:createdAt});
      if(this.disposed || aborter.signal.aborted)throw new Error("Обработка остановлена. Проверьте историю диалога.");
      this.update(conversationId,{rows,updatedAt:createdAt});
      return {conversationId,rowId};
    } catch(e) {
      if(!this.disposed)this.publish({error:(e as Error)?.message||"Не удалось составить итог диалога."});
      throw e;
    } finally {
      offSession();
      this.requests.delete(conversationId);
      const final=this.update(conversationId,{busy:false,progress:"",progressSince:undefined});
      if(final)await this.persist(final).catch(()=>{});
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
