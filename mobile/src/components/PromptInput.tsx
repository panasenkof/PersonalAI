import Feather from "@expo/vector-icons/Feather";
import React, { useLayoutEffect, useRef } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useTheme } from "../theme";

export function PromptInput({ value, onChange, onClear, editable, onFocusChange }: {
  value: string; onChange: (value: string) => void; onClear: () => void; editable: boolean;
  /** Optional UI-only signal; used to keep decorative artwork above the keyboard. */
  onFocusChange?: (focused: boolean) => void;
}) {
  const t = useTheme();
  const input = useRef<TextInput>(null);
  const focusAfterClear = useRef(false);
  const restoreFocusFrame = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (value !== "" || !focusAfterClear.current) return;
    // Pressable takes focus before onPress, while clearing remounts VoiceInput
    // and can resize the empty-state artwork. A single synchronous focus()
    // briefly succeeds and then loses focus as the press/layout settles.
    input.current?.focus();
    restoreFocusFrame.current = requestAnimationFrame(() => {
      if (!focusAfterClear.current) return;
      input.current?.focus();
      restoreFocusFrame.current = requestAnimationFrame(() => {
        restoreFocusFrame.current = null;
        if (focusAfterClear.current) input.current?.focus();
        focusAfterClear.current = false;
      });
    });
    // Cancel deferred refocus when the draft changes, the user navigates
    // away, or this input unmounts. Never reopen Gboard on another screen.
    return () => {
      if (restoreFocusFrame.current !== null) cancelAnimationFrame(restoreFocusFrame.current);
      restoreFocusFrame.current = null;
      focusAfterClear.current = false;
    };
  }, [value]);
  return <View style={{ flexDirection: "row", alignItems: "flex-start", borderWidth: 1, borderColor: t.line, borderRadius: 18, backgroundColor: t.soft }}>
    <TextInput ref={input} accessibilityLabel="Сообщение ассистенту" multiline value={value} onChangeText={onChange}
      onFocus={() => onFocusChange?.(true)} onBlur={() => onFocusChange?.(false)}
      placeholder="Спросить у ИИ…" placeholderTextColor={t.muted} editable={editable}
      style={{ flex: 1, minWidth: 0, minHeight: 46, maxHeight: 112, padding: 12, color: t.text, fontSize: 16 }} />
    {value.length ? <Pressable accessibilityRole="button" accessibilityLabel="Очистить сообщение" accessibilityHint="Удалить весь текст черновика"
      disabled={!editable} onPress={() => {
        focusAfterClear.current = true;
        onClear();
        onChange("");
        // Focus is restored after React commits the empty draft and settles
        // the clear-button removal; see the layout effect above.
      }}
      style={{ minHeight: 46, minWidth: 44, alignItems: "center", justifyContent: "center", opacity: editable ? 1 : 0.5 }}>
      <Feather name="x" size={20} color={t.muted} />
    </Pressable> : null}
  </View>;
}
