import React from "react";
import { ActivityIndicator, Text, View } from "react-native";
import type { ChatAttachment } from "../../direct-agent/chat-attachments";
import type { DirectAgentSettings } from "../../direct-agent/settings";
import type { ChatFileFailure } from "../../media/pickChatAttachments";
import type { NebulaVoicePhase } from "../../design/nebula/homePhase";
import type { useTheme } from "../../theme";
import { ChatAttachmentIssues } from "../../media/ChatAttachmentIssues";
import { ChatAttachmentList } from "../../media/ChatAttachmentList";
import { PhotoContextActions } from "../../media/PhotoContextActions";
import { PromptInput } from "../PromptInput";
import { VoiceInput } from "../VoiceInput";
import { IconAction } from "../IconAction";
import { NebulaAction } from "../../design/nebula/components";

/** Existing composer view only. All state, mutations and navigation remain
 * owned by HomeScreen and pass through the same callbacks as before ARCH-6b. */
export function ChatComposer({
  t, pickingAttachment, audioPreparing, draftImageSupport, failedFiles,
  ready, busy, dictating, cameraBusy, attachments, selectedPhoto,
  question, activeId, voiceReset, showWhisperImprove, normalizationBusy,
  normalizationNormalized, normalizationAlternate, canSend, settings,
  onCancelAttachmentPreparation, onPickAttachment, onDismissFailure,
  onSelectImage, onRemoveAttachment, onCancelSelectedPhoto,
  onFindSelectedOnline, onSearchSelectedPhoto, onSaveSelectedPhotoNote,
  onPreviewSelectedPhoto, onQuestionChange, onClearQuestion,
  onFocusChange, onCaptureCamera, onVoiceChange, onVoiceError, onVoiceBegin,
  onDictatingChange, onVoicePhaseChange, onToggleNormalization, onSendOrStop,
  inboxApproval, onRequestInbox, onConfirmInbox, onDismissInbox,
}: {
  t: ReturnType<typeof useTheme>;
  pickingAttachment: boolean;
  audioPreparing: boolean;
  draftImageSupport: string;
  failedFiles: ChatFileFailure[];
  ready: boolean;
  busy: boolean;
  dictating: boolean;
  cameraBusy: boolean;
  attachments?: ChatAttachment[];
  selectedPhoto?: ChatAttachment;
  question: string;
  activeId?: string;
  voiceReset: number;
  showWhisperImprove: boolean;
  normalizationBusy: boolean;
  normalizationNormalized: boolean;
  normalizationAlternate: boolean;
  canSend: boolean;
  settings: DirectAgentSettings | null;
  onCancelAttachmentPreparation: () => void;
  onPickAttachment: () => void;
  onDismissFailure: (index: number) => void;
  onSelectImage: (id: string) => void;
  onRemoveAttachment: (id: string) => void;
  onCancelSelectedPhoto: () => void;
  onFindSelectedOnline: () => void;
  onSearchSelectedPhoto: () => void;
  onSaveSelectedPhotoNote: () => void;
  onPreviewSelectedPhoto: () => void;
  onQuestionChange: (value: string) => void;
  onClearQuestion: () => void;
  onFocusChange: (focused: boolean) => void;
  onCaptureCamera: () => void;
  onVoiceChange: (value: string) => void;
  onVoiceError: (message: string) => void;
  onVoiceBegin: () => void;
  onDictatingChange: (active: boolean) => void;
  onVoicePhaseChange: (phase: NebulaVoicePhase) => void;
  onToggleNormalization: () => void;
  onSendOrStop: () => void;
  inboxApproval?: {conversationId:string;limit:number;label:string};
  onRequestInbox:()=>void;
  onConfirmInbox:()=>void;
  onDismissInbox:()=>void;
}) {
  return <View style={{ zIndex: 3, padding: 10, gap: 5, backgroundColor: t.panel, borderTopWidth: 1, borderColor: t.line }}>
      {inboxApproval ? <View style={{borderWidth:1,borderColor:t.line,borderRadius:12,padding:10,gap:8}}>
        <Text style={{color:t.text,fontWeight:"700"}}>Разрешить разбор «Входящих»?</Text>
        <Text style={{color:t.secondary,fontSize:13}}>В модель будут отправлены заголовки, теги и до 600 символов текста каждой из максимум {inboxApproval.limit} записей. Разрешение только на один ответ. Записи останутся на месте до отдельного подтверждения переноса.</Text>
        <View style={{flexDirection:"row",gap:8,flexWrap:"wrap"}}>
          <NebulaAction icon="check" label="Разрешить разбор" onPress={onConfirmInbox} accessibilityLabel="Разрешить однократное чтение Входящих моделью"/>
          <NebulaAction icon="x" label="Отмена" onPress={onDismissInbox}/>
        </View>
      </View> : <NebulaAction icon="list" size="compact" label="Разобрать «Входящие»" disabled={!ready||busy||!canSend}
        onPress={onRequestInbox} accessibilityLabel="Запросить разрешение на разбор Входящих"/>}
      {pickingAttachment && audioPreparing ? <View style={{flexDirection:'row',alignItems:'center',gap:12,minHeight:48,paddingHorizontal:6}}>
        <ActivityIndicator accessibilityLabel="Локальное распознавание аудио"/>
        <Text accessibilityLiveRegion="polite" style={{color:t.secondary,flex:1}}>Распознаю аудио на телефоне…</Text>
        <NebulaAction icon="x" label="Отмена" accessibilityLabel="Отменить распознавание аудио"
          onPress={onCancelAttachmentPreparation} />
      </View> : null}
      {draftImageSupport === "unsupported" ? <Text accessibilityRole="alert"
        style={{color:t.accent,fontSize:13,lineHeight:19,paddingHorizontal:6}}>
        Выбранная модель не принимает фотографии. Фото останется в черновике: выберите другую модель или уберите вложение.
      </Text> : draftImageSupport === "unverified" ? <Text
        style={{color:t.muted,fontSize:12,lineHeight:18,paddingHorizontal:6}}>
        Поддержка фото моделью «{settings?.model}» не подтверждена. Если она не принимает изображения, выберите другую модель. Текстовые вложения продолжат работать.
      </Text> : null}
      {failedFiles.length ? <ChatAttachmentIssues issues={failedFiles}
        disabled={!ready || busy || pickingAttachment || dictating}
        onReselect={onPickAttachment} onDismiss={onDismissFailure}/> : null}
      {attachments?.length ? <>
        <ChatAttachmentList files={attachments} disabled={busy || cameraBusy || pickingAttachment}
          selectedImageId={selectedPhoto?.id} onSelectImage={onSelectImage}
          onRemove={onRemoveAttachment}/>
        {selectedPhoto ? <PhotoContextActions disabled={busy || cameraBusy || pickingAttachment}
          onCancel={onCancelSelectedPhoto}
          actions={[
            {id:"internet",label:"В интернете",run:onFindSelectedOnline},
            {id:"memory",label:"В моей памяти",run:onSearchSelectedPhoto},
            {id:"note",label:"Сохранить заметку",run:onSaveSelectedPhotoNote},
            {id:"preview",label:"Посмотреть",run:onPreviewSelectedPhoto},
          ]} /> : null}
      </> : null}
      <PromptInput value={question} onChange={onQuestionChange} onClear={onClearQuestion} editable={ready} onFocusChange={onFocusChange} />
      <View testID="composer-actions" style={{ zIndex: 1, flexDirection: "row", alignItems: "center", gap: 4 }}>
        <IconAction compact explainOnTap={false} icon="paperclip" label="Файл" accessibilityLabel="Прикрепить файл к сообщению" hint="JPEG/PNG/WebP, текст, PDF с текстовым слоем и аудио MP3/M4A/WAV/OGG/FLAC/AAC до 20 МБ через скачанный Whisper. Аудио распознаётся только на телефоне; в чат попадёт текст без оригинала. До 3 файлов, PDF до 6 МБ, совокупный текст до 240 000 символов (защита памяти телефона, не предел ИИ). Большие документы анализируются по частям после подтверждения расходов. Файлы не сохраняются как заметки." hintAbove hintAlign="start" disabled={!ready || busy || pickingAttachment || dictating} onPress={onPickAttachment} />
<IconAction compact icon="camera" label={cameraBusy?"Съёмка…":"Камера"} accessibilityLabel="Сделать снимок"
          hint="Камера откроется сразу. После съёмки можно спросить ИИ, найти в интернете или памяти, сохранить заметку."
          hintAbove disabled={!ready || cameraBusy || busy || pickingAttachment || dictating}
          onPress={onCaptureCamera} />
        <VoiceInput key={`${activeId}:${voiceReset}`} value={question} onChange={onVoiceChange} disabled={!ready || busy} onError={onVoiceError} showLabel={false} onBegin={onVoiceBegin} onActiveChange={onDictatingChange} onPhaseChange={onVoicePhaseChange} />
        {showWhisperImprove ? <IconAction compact icon={normalizationBusy ? "x" : normalizationNormalized ? "rotate-ccw" : "edit-3"}
          label={normalizationBusy ? "Отмена" : normalizationNormalized ? "Исходный" : "Улучшить"}
          accessibilityLabel={normalizationBusy ? "Отменить улучшение текста" : normalizationNormalized ? "Вернуть исходный текст" : "Улучшить текст"}
          hint={normalizationBusy ? "Отменить улучшение: исходный текст останется." : normalizationNormalized ? "Вернуть текст до улучшения. Повторное нажатие снова покажет исправленный вариант без запроса к LLM." : normalizationAlternate ? "Показать исправленный вариант без нового запроса к LLM." : "Исправить ошибки и пунктуацию всего черновика через выбранное подключение LLM. Один дополнительный запрос; сообщение не отправляется."}
          hintAbove hintAlign="center" emphasized={normalizationNormalized}
          disabled={!ready || dictating || (!normalizationBusy && (!question.trim() || (!normalizationAlternate && !canSend)))}
          onPress={onToggleNormalization} /> : null}
        <View style={{ flex: 1, minWidth: 0 }} />
        <IconAction compact explainOnTap={false} icon={busy ? "square" : "arrow-up"} label={busy ? "Стоп" : "Отправить"} accessibilityLabel={busy ? "Остановить запрос" : "Отправить запрос"}
          hint={busy ? "Остановить ответ ИИ в этом диалоге." : "Сообщение обрабатывает выбранная LLM, которая при необходимости вызывает локальные инструменты памяти, фото или сохранённых статей."} hintAbove emphasized={!busy}
          disabled={!busy && (pickingAttachment || !canSend || (!question.trim() && !attachments?.length))} onPress={onSendOrStop} />
      </View>
    </View>;
}
