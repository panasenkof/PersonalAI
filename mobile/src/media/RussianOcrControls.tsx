import React, { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "../design/nebula/tokens";
import { cancelRussianOcrDownload, getRussianOcrStatus, installRussianOcr,
  refreshRussianOcrStatus, removeRussianOcrModel, useRussianOcrStatus } from "./russian-ocr";

/** Same download/verification controls in settings and import. No auto-download. */
export function RussianOcrControls() {
  const t = useTheme(), ocr = useRussianOcrStatus();
  useEffect(() => { void refreshRussianOcrStatus(); }, []);
  const button = { minHeight: nebulaTouch.minimum, justifyContent: "center" as const,
    borderRadius: nebulaRadii.field, borderWidth: 1, borderColor: t.line,
    paddingHorizontal: nebulaSpacing.md };
  return <View style={{ gap: nebulaSpacing.sm }}>
    <Text style={{ color: t.text, fontWeight: "700" }}>Русский текст без интернета (OCR)</Text>
    <Text style={{ color: t.muted, lineHeight: 19 }}>
      Документы и сканы читаются на телефоне. Tesseract, русский язык; модель 3,9 МБ скачивается только вручную и проверяется по SHA-256. Возможны ошибки в датах, цифрах и единицах.
    </Text>
    <Text accessibilityLiveRegion="polite" style={{ color: ocr.ready ? t.ok : t.muted }}>
      {ocr.busy ? "Скачиваю русскую модель: " + ocr.percent + "%" :
        !ocr.checked ? "Проверяю установленную модель…" :
        ocr.ready ? "Русская модель OCR установлена и проверена" : "Русская модель OCR не установлена"}
    </Text>
    {ocr.error ? <Text accessibilityRole="alert" style={{color:t.err}}>{ocr.error}</Text> : null}
    {ocr.busy ? <Pressable accessibilityLabel="Отменить загрузку русской модели OCR"
      accessibilityRole="button" style={button} onPress={cancelRussianOcrDownload}>
      <Text style={{color:t.secondary}}>Отменить загрузку</Text>
    </Pressable> : ocr.ready ? <Pressable accessibilityLabel="Удалить русскую модель OCR"
      accessibilityRole="button" style={button} onPress={() => void removeRussianOcrModel()}>
      <Text style={{color:t.secondary}}>Удалить русскую модель</Text>
    </Pressable> : <Pressable accessibilityLabel="Скачать русскую модель OCR" accessibilityRole="button"
      style={button} onPress={() => void installRussianOcr()}>
      <Text style={{color:t.secondary}}>Скачать русскую модель (3,9 МБ)</Text>
    </Pressable>}
  </View>;
}
