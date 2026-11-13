import React from "react";
import Feather from "@expo/vector-icons/Feather";
import { Pressable, Text, View } from "react-native";
import type { PresentedChatRow } from "../../design/nebula/chatPresentation";
import type { LiveConversation } from "../../direct-agent/chat-store";
import type { useTheme } from "../../theme";
import { MarkdownText } from "../Markdown";
import { NebulaAction } from "../../design/nebula/components";
import { IconAction } from "../IconAction";
import { ChatProposalCards } from "../ProposalCard";
import { ChatAttachmentList } from "../../media/ChatAttachmentList";
import { PhotoSearchResults } from "../../media/PhotoSearchResults";
import { ArticleReadSources } from "../ArticleReadSources";
import { contextChangeLabel } from "../../direct-agent/conversation-context";

/** A failed turn carries a raw transport tail after "Системное сообщение:".
 * The bubble shows only the human part; the full text stays in diagnostics. */
function errorHeadline(text: string) {
  return text.split(/Системное сообщение:/i)[0].trim();
}

/** One source line: domain first, path muted and truncated by numberOfLines. */
function sourceParts(url: string) {
  try {
    const parsed = new URL(url);
    const rest = (parsed.pathname === "/" ? "" : parsed.pathname) + (parsed.search ? "?" + parsed.search.slice(1, 40) : "");
    return { domain: parsed.hostname.replace(/^www\./, ""), rest };
  } catch {
    return { domain: url, rest: "" };
  }
}

/** One existing bubble; layout and all callbacks remain owned by HomeScreen. */
export function ChatRowView({
  item, t, profile, photoResultCount, ready, busy, canSend, retryPhoto, movingRowId,
  onSaveReply, onOpenNote, onRetryRequest, onRetryPhoto, onPhotoAction,
  onConfirmProposal, onDismissProposal, onUndoProposal, onContinueArticles, onOpenSource,
}: {
  item: PresentedChatRow;
  t: ReturnType<typeof useTheme>;
  profile: string;
  photoResultCount: number;
  ready: boolean;
  busy: boolean;
  canSend: boolean;
  retryPhoto?: LiveConversation["retryPhoto"];
  movingRowId?: string;
  onSaveReply: (rowId: string) => void;
  onOpenNote: (noteId: string, photoAttachmentId?: string) => void;
  onRetryRequest: () => void;
  onRetryPhoto: (rowId: string) => void;
  onPhotoAction: (action: NonNullable<PresentedChatRow["photoAction"]>) => void;
  onConfirmProposal: (rowId: string) => void;
  onDismissProposal: (rowId: string) => void;
  onUndoProposal: (rowId: string) => void;
  onContinueArticles: (rowId: string) => void;
  onOpenSource: (url: string) => void;
}) {
  return <View testID={"chat-message-" + item.role} accessibilityLiveRegion={item.streaming ? "polite" : undefined} style={{ alignSelf: item.role === "user" ? "flex-end" : "stretch", backgroundColor: item.role === "user" ? t.userBubble : item.role === "info" ? t.soft : t.panel,
        borderWidth: item.role === "assistant" ? 1 : 0, borderColor: t.line, borderRadius: 20, padding: 15, gap: 10 }}>
        {item.role === "assistant" ? <Pressable
          disabled={Boolean(item.streaming)}
          delayLongPress={430}
          accessibilityRole="button"
          accessibilityLabel="Ответ ИИ. Долгое нажатие: сохранить в заметки"
          accessibilityHint="Долгое нажатие открывает черновик заметки без отправки в сеть"
          accessibilityActions={[{ name: "longpress", label: "Сохранить ответ в заметки" }]}
          onAccessibilityAction={event => {
            if(event.nativeEvent.actionName === "longpress" && !item.streaming)
              onSaveReply(item.id);
          }}
          onLongPress={() => {if(!item.streaming)onSaveReply(item.id);}}>
          <MarkdownText text={item.text} style={{ color: t.text, lineHeight: 23 }}
            articleReadReport={item.articleReadReport}
            onArticleSourcePress={noteId=>onOpenNote(noteId)} />
        </Pressable> :
        (item.role === "info" && item.error ? <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
            <Feather name="alert-triangle" size={16} color={t.err} style={{ marginTop: 2 }} />
            <Text selectable accessibilityRole="alert" style={{ flex: 1, color: t.err, lineHeight: 21 }}>{errorHeadline(item.text)}</Text>
          </View>
          {ready && !busy && settings ? <View style={{ alignSelf: "flex-start" }}>
            <NebulaAction icon="refresh-cw" label="Повторить" size="compact" accessibilityLabel="Повторить последний запрос"
              onPress={onRetryRequest} />
          </View> : null}
        </View> :
          <Text selectable style={{ color: item.role === "user" ? t.userText : item.role === "info" ? t.muted : t.text, lineHeight: 23 }}>{item.text}</Text>)}
        {item.role === "assistant" && !item.streaming && item.contextChange ? <Text
          testID="chat-context-change" accessibilityRole="text"
          style={{color:t.secondary,fontSize:12,lineHeight:18}}>{contextChangeLabel(item.contextChange)}</Text> : null}
        {item.role === "assistant" && !item.streaming && item.text.trim() ? <View style={{ alignSelf: "flex-end", borderWidth: 1, borderColor: t.line, backgroundColor: t.soft, borderRadius: 15 }}>
          <IconAction compact explainOnTap={false} icon="bookmark" label="Сохранить ответ"
            accessibilityLabel="Сохранить ответ в заметки" hint="Открыть черновик заметки без нового запроса ИИ"
            onPress={() => onSaveReply(item.id)} />
        </View> : null}
        {retryPhoto?.rowId === item.id && retryPhoto ?
          <NebulaAction icon="refresh-cw" label="Повторить поиск по фото" size="compact"
            disabled={busy || !canSend} onPress={() => onRetryPhoto(item.id)} /> : null}
        {item.photoAction ? <NebulaAction
          icon={item.photoAction === "import" ? "plus-circle" : "settings"}
          label={item.photoAction === "model" ? "Выбрать модель" : item.photoAction === "import" ? "Добавить фото в память" : "Подготовить фото"}
          onPress={() => onPhotoAction(item.photoAction!)} /> : null}
        {item.role === "assistant" && !item.streaming ?
          <ChatProposalCards row={item}
            busy={busy || Boolean(movingRowId)}
            working={movingRowId === item.id}
            onConfirm={() => onConfirmProposal(item.id)}
            onDismiss={() => onDismissProposal(item.id)}
            onUndo={() => onUndoProposal(item.id)}
            onOpenNote={id => onOpenNote(id)} /> : null}
        {item.attachments?.length ? <ChatAttachmentList files={item.attachments}/> : null}
        {item.memory?.filter(m=>m.photo || !item.articleReadReport?.entries.some(e=>e.id===m.id)).length ?
          <View style={{ gap: 4 }}><Text style={{ color: t.muted, fontSize: 12 }}>Из памяти</Text>
          {item.memory.some(m => m.photo) ? <PhotoSearchResults key={item.id} profile={profile} results={item.memory.filter(m=>m.photo)} limit={photoResultCount}
            onOpen={(result, original) => onOpenNote(result.id, original ? result.photoAttachmentId : undefined)} /> : null}
          {item.memory.filter(m=>!m.photo && !item.articleReadReport?.entries.some(e=>e.id===m.id)).map(m => <Pressable key={m.id} accessibilityRole="link" accessibilityLabel={"Открыть запись " + m.title}
              onPress={() => navigation.navigate("MemoryNote", {entityId:m.id})} style={{minHeight:48,justifyContent:"center"}}>
              <Text style={{color:t.accent}}>{m.title}<Text style={{color:t.muted,fontSize:12}}>{(m.section ? " · " + m.section : "") + (m.via === "rewrite" ? " · найдено другими словами" : m.via === "assistant" ? " · нашёл помощник" : "")}</Text></Text>
            </Pressable>)}
        </View> : null}
        {item.role === "assistant" && !item.streaming && item.articleReadReport ?
          <ArticleReadSources report={item.articleReadReport} answerText={item.text}
            onOpen={noteId=>onOpenNote(noteId)} /> : null}
        {item.role === "assistant" && !item.streaming && item.articlePage?.nextCursor ?
          <View style={{ alignSelf: "flex-start" }}>
            <NebulaAction icon="chevron-down" label="Показать ещё" size="compact"
              accessibilityLabel="Показать следующую страницу сохранённых материалов"
              disabled={busy || !canSend} onPress={() => onContinueArticles(item.id)} />
          </View> : null}
        {item.sources?.length ? <View style={{ gap: 2 }}><Text style={{ color: t.muted, fontSize: 12 }}>Источники</Text>{item.sources.map(url => {
          const part = sourceParts(url);
          return <Pressable key={url} accessibilityRole="link" accessibilityLabel={"Открыть источник " + part.domain}
            onPress={() => onOpenSource(url)}
            style={{ minHeight: 48, justifyContent: "center" }}>
            <Text numberOfLines={1} style={{ color: t.accent }}>{part.domain}<Text style={{ color: t.muted }}>{part.rest}</Text></Text>
          </Pressable>;
        })}</View> : null}
      </View>;
}
