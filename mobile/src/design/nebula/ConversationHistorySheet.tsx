import Feather from "@expo/vector-icons/Feather";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import type { LiveConversation } from "../../direct-agent/chat-store";
import { BottomSheet } from "../../components/BottomSheet";
import { useTheme } from "../../theme";
import { nebulaSpacing, nebulaTouch } from "./tokens";
import { indexConversationHistory, searchConversationHistory } from "./conversationHistory";

const PAGE_SIZE = 30;

/** U1 history surface. The active chat, drafts and running agent stay in ChatStore. */
export function ConversationHistorySheet({
  visible, conversations, activeId, onClose, onSelect, onDelete, onNewChat,
}: {
  visible: boolean;
  conversations: readonly LiveConversation[];
  activeId?: string | null;
  onClose: () => void;
  onSelect: (conversation: LiveConversation) => void;
  onDelete: (conversation: LiveConversation) => void;
  onNewChat: () => void;
}) {
  const t = useTheme();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  useEffect(() => {
    if (!visible) { setQuery(""); setLimit(PAGE_SIZE); }
  }, [visible]);
  // Build once for a given snapshot, rather than concatenate each message
  // for each character typed. Nothing is indexed outside this visible panel.
  const index = useMemo(() => visible ? indexConversationHistory(conversations) : [], [visible, conversations]);
  const results = useMemo(() => searchConversationHistory(index, query), [index, query]);
  const shown = results.slice(0, limit);
  const searching = Boolean(query.trim());
  const changeQuery = (value: string) => { setQuery(value); setLimit(PAGE_SIZE); };

  return <BottomSheet visible={visible} title="Мои диалоги" onClose={onClose}>
    <Text style={{ color: t.muted, lineHeight: 20 }}>Выберите разговор или найдите нужное сообщение. История хранится на устройстве.</Text>
    <View style={{ flexDirection: "row", alignItems: "center", borderColor: t.line, borderWidth: 1, borderRadius: 16, backgroundColor: t.soft }}>
      <TextInput testID="chat-history-search" accessibilityLabel="Поиск диалогов"
        value={query} onChangeText={changeQuery} autoCorrect={false} returnKeyType="search"
        placeholder="Найти диалог или сообщение" placeholderTextColor={t.muted}
        style={{ flex: 1, minWidth: 0, minHeight: nebulaTouch.minimum, paddingHorizontal: nebulaSpacing.md, color: t.text, fontSize: 16 }} />
      {query.length > 0 ? <Pressable accessibilityRole="button" accessibilityLabel="Очистить поиск диалогов"
        onPress={() => changeQuery("")} style={{ minWidth: nebulaTouch.minimum, minHeight: nebulaTouch.minimum, justifyContent: "center", alignItems: "center" }}>
        <Feather name="x" size={20} color={t.muted} />
      </Pressable> : null}
    </View>
    <Text testID="chat-history-count" accessibilityLiveRegion="polite" style={{ color: t.muted, fontSize: 13 }}>
      {searching ? `Найдено диалогов: ${results.length}` : `Диалогов: ${results.length}`}
    </Text>
    {!results.length ? <View testID="chat-history-empty" style={{ paddingVertical: nebulaSpacing.lg, gap: nebulaSpacing.xs }}>
      <Text style={{ color: t.text, fontSize: 16, fontWeight: "700" }}>
        {searching ? "Ничего не найдено" : "Здесь пока нет диалогов"}
      </Text>
      <Text style={{ color: t.muted, lineHeight: 21 }}>
        {searching ? "Проверьте запрос или попробуйте другие слова." : "Начните разговор на главной — он появится в истории."}
      </Text>
    </View> : null}
    {shown.map(({ conversation: c, preview }) => {
      const selected = c.id === activeId;
      const cannotDelete = c.busy || Boolean(c.savingDraft) || Boolean(c.deleting);
      const date = Date.parse(c.updatedAt);
      const dateText = Number.isFinite(date) ? new Date(date).toLocaleDateString() : "";
      return <View key={c.id} style={{ flexDirection: "row", alignItems: "center", gap: nebulaSpacing.xs }}>
        <Pressable testID={`chat-history-item-${c.id}`} accessibilityRole="button"
          accessibilityLabel={"Открыть диалог " + c.title}
          accessibilityState={{ selected }} onPress={() => onSelect(c)}
          style={({ pressed }) => ({ flex: 1, minWidth: 0, minHeight: 72, borderWidth: 1,
            borderColor: selected ? t.accent : t.line, borderRadius: 16,
            backgroundColor: pressed ? t.soft : t.panel, padding: nebulaSpacing.sm, gap: 4 })}>
          <Text numberOfLines={2} style={{ color: t.text, fontSize: 15, fontWeight: "700" }}>{c.title}</Text>
          <Text numberOfLines={2} style={{ color: t.muted, fontSize: 13, lineHeight: 18 }}>{preview}</Text>
          <Text style={{ color: c.busy ? t.accent : t.muted, fontSize: 12 }}>{c.busy ? "Готовлю ответ…" : dateText}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={"Удалить диалог " + c.title}
          accessibilityState={{ disabled: cannotDelete }} disabled={cannotDelete}
          onPress={() => onDelete(c)}
          style={{ minHeight: nebulaTouch.minimum, minWidth: nebulaTouch.minimum,
            justifyContent: "center", alignItems: "center", opacity: cannotDelete ? 0.45 : 1 }}>
          <Feather name="trash-2" size={19} color={t.err} />
        </Pressable>
      </View>;
    })}
    {shown.length < results.length ? <Pressable testID="chat-history-more"
      accessibilityRole="button" accessibilityLabel="Показать ещё диалоги"
      onPress={() => setLimit(previous => previous + PAGE_SIZE)}
      style={{ minHeight: nebulaTouch.minimum, justifyContent: "center", alignItems: "center", borderWidth: 1,
        borderRadius: 16, borderColor: t.line }}>
      <Text style={{ color: t.accent, fontWeight: "600" }}>{`Показать ещё · ${shown.length} из ${results.length}`}</Text>
    </Pressable> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Создать новый диалог"
      onPress={onNewChat} style={{ minHeight: nebulaTouch.minimum, alignItems: "center", justifyContent: "center" }}>
      <Text style={{ color: t.accent, fontWeight: "700" }}>+ Новый диалог</Text>
    </Pressable>
  </BottomSheet>;
}
