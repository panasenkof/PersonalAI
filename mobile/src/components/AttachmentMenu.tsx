import Feather from "@expo/vector-icons/Feather";
import React, { useState } from "react";
import { Pressable, Text } from "react-native";
import { BottomSheet } from "./BottomSheet";
import { useTheme } from "../theme";
export function AttachmentMenu({ disabled, onPick }: { disabled: boolean; onPick: (kind: "camera" | "photo" | "file") => void }) {
  const [open, setOpen] = useState(false); const t = useTheme();
  return <>
    <Pressable disabled={disabled} accessibilityRole="button" accessibilityLabel="Добавить вложение" style={{ minWidth: 44, minHeight: 44, justifyContent: "center", alignItems: "center" }} onPress={() => setOpen(true)}><Feather name="plus" color={t.accent} size={23} /></Pressable>
    <BottomSheet visible={open} title="Добавить вложение" onClose={() => setOpen(false)}>
          {([ ["camera", "Сделать фото"], ["photo", "Выбрать фото"], ["file", "Прикрепить файл"] ] as const).map(([kind, title]) => <Pressable key={kind} accessibilityRole="button" accessibilityLabel={title} style={{ minHeight: 52, justifyContent: "center" }} onPress={() => { setOpen(false); onPick(kind); }}><Text style={{ color: t.text, fontSize: 16 }}>{title}</Text></Pressable>)}
          <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={{ minHeight: 48, justifyContent: "center" }}><Text style={{ color: t.accent }}>Отмена</Text></Pressable>
    </BottomSheet>
  </>;
}
