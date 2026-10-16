import Feather from "@expo/vector-icons/Feather";
import React, { useLayoutEffect, useRef } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useTheme } from "../theme";

export function PromptInput({ value, onChange, onClear, editable }: {
  value: string; onChange: (value: string) => void; onClear: () => void; editable: boolean;
}) {
  const t = useTheme();
  const input = useRef<TextInput>(null);
  const focusAfterClear = useRef(false);
  useLayoutEffect(() => {
    // Restore focus after the pressed clear button has left the native tree.
    if (!value && focusAfterClear.current) { focusAfterClear.current = false; input.current?.focus(); }
  }, [value]);
  return <View style={{ flexDirection: "row", alignItems: "flex-start", borderWidth: 1, borderColor: t.line, borderRadius: 18, backgroundColor: t.soft }}>
    <TextInput ref={input} accessibilityLabel="Сообщение ассистенту" multiline value={value} onChangeText={onChange}
      placeholder="Спросить у ИИ…" placeholderTextColor={t.muted} editable={editable}
      style={{ flex: 1, minWidth: 0, minHeight: 46, maxHeight: 112, padding: 12, color: t.text, fontSize: 16 }} />
    {value.length ? <Pressable accessibilityRole="button" accessibilityLabel="Очистить сообщение" accessibilityHint="Удалить весь текст черновика"
      disabled={!editable} onPress={() => { focusAfterClear.current = true; onClear(); onChange(""); }}
      style={{ minHeight: 46, minWidth: 44, alignItems: "center", justifyContent: "center", opacity: editable ? 1 : 0.5 }}>
      <Feather name="x" size={20} color={t.muted} />
    </Pressable> : null}
  </View>;
}
