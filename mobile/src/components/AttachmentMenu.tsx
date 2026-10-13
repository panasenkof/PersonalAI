import Feather from "@expo/vector-icons/Feather";
import React, { useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useTheme } from "../theme";
export function AttachmentMenu({ disabled, onPick }: { disabled: boolean; onPick: (kind: "camera" | "photo" | "file") => void }) {
  const [open, setOpen] = useState(false); const t = useTheme();
  return <>
    <Pressable disabled={disabled} accessibilityRole="button" accessibilityLabel="Добавить вложение" style={{ minWidth: 44, minHeight: 44, justifyContent: "center", alignItems: "center" }} onPress={() => setOpen(true)}><Feather name="plus" color={t.accent} size={23} /></Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,.35)" }}>
        <Pressable accessibilityLabel="Закрыть вложения" style={{ flex: 1 }} onPress={() => setOpen(false)} />
        <View style={{ backgroundColor: t.panel, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 22, paddingBottom: 35, gap: 8 }}>
          <Text style={{ color: t.text, fontSize: 21, fontWeight: "700", marginBottom: 10 }}>Добавить вложение</Text>
          {([ ["camera", "Сделать фото"], ["photo", "Выбрать фото"], ["file", "Прикрепить файл"] ] as const).map(([kind, title]) => <Pressable key={kind} accessibilityRole="button" accessibilityLabel={title} style={{ minHeight: 52, justifyContent: "center" }} onPress={() => { setOpen(false); onPick(kind); }}><Text style={{ color: t.text, fontSize: 16 }}>{title}</Text></Pressable>)}
          <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={{ minHeight: 48, justifyContent: "center" }}><Text style={{ color: t.accent }}>Отмена</Text></Pressable>
        </View>
      </View>
    </Modal>
  </>;
}
