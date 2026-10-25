import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useIsFocused } from "@react-navigation/native";
import { Directory, Paths, File } from "expo-file-system";
import * as Crypto from "expo-crypto";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { useApplicationVisible } from "../security/visibility";
import { onLocalMemorySessionChange } from "../local-memory/storage";
import { attachmentsForEntity, materializeAttachment } from "./attachments";
import { attachmentPreviewKind } from "./attachmentPresentation";
import { useTheme } from "../theme";

// Bound decryption/decoding across the visible grid and collection covers.
let running = 0;
const waiting: (() => void)[] = [];
export async function coverSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= 2) await new Promise<void>(resolve => waiting.push(resolve));
  else running++;
  try { return await work(); }
  finally { const next = waiting.shift(); if (next) next(); else running--; }
}
export function removeCoverFile(uri: string) {
  if (!uri) return;
  try { const file = new File(uri); if (file.exists) file.delete(); } catch { /* lock already cleared cache */ }
}

/** Local-only disposable thumbnail. No remote URL, no persistent plaintext cache.
 * Large/unsupported files remain readable through the explicit attachment viewer. */
export function MemoryCover({ profile, entityId, active = true, height = 132, label = "Обложка записи", compact = false }: {
  profile: string; entityId: string; active?: boolean; height?: number; label?: string; compact?: boolean;
}) {
  const t = useTheme(); const focused = useIsFocused(); const visible = useApplicationVisible();
  const [unlocked, setUnlocked] = useState(true);
  const [uri, setUri] = useState(""); const [failed, setFailed] = useState(false);
  const [noPreview, setNoPreview] = useState(false);
  useEffect(() => setNoPreview(false), [profile, entityId]);
  const [message, setMessage] = useState(""); const [loading, setLoading] = useState(false); const [attempt, setAttempt] = useState(0);
  useEffect(() => onLocalMemorySessionChange(setUnlocked), []);
  const activation = useRef({ key: "", seen: false });
  const key = profile + ":" + entityId;
  if (activation.current.key !== key || !focused || !visible || !unlocked) activation.current = { key, seen: false };
  if (active && focused && visible && unlocked) activation.current.seen = true;
  // Retain only while mounted in the bounded FlatList window. Blur, lock,
  // background and unmount still dispose the plaintext thumbnail.
  const enabled = activation.current.seen && focused && visible && unlocked;
  useEffect(() => {
    const controller = new AbortController(); let thumbnail = "";
    setUri(""); setFailed(false); setMessage(""); setLoading(enabled);
    if (enabled) void coverSlot(async () => {
      if (controller.signal.aborted) return;
      const items = await attachmentsForEntity(profile, entityId);
      const image = items.find(item => attachmentPreviewKind(item) === "image" && item.size <= 12 * 1024 * 1024);
      if (controller.signal.aborted) return;
      if (!image) {
        setNoPreview(true);
        setMessage(items.some(item => attachmentPreviewKind(item) === "image") ? "Большое фото · откройте оригинал во вложениях" : "Оригинал фото не сохранён");
        return;
      }
      let original = "";
      try {
        original = await materializeAttachment(profile, image, controller.signal);
        if (controller.signal.aborted) return;
        const result = await manipulateAsync(original, [{ resize: { width: 480 } }], { compress: 0.7, format: SaveFormat.JPEG });
        thumbnail = result.uri;
        if (controller.signal.aborted) removeCoverFile(thumbnail);
        else {
          const directory = new Directory(Paths.cache, "persai-previews");
          directory.create({ intermediates: true, idempotent: true });
          const destination = new File(directory, Crypto.randomUUID() + ".jpg");
          new File(thumbnail).move(destination); thumbnail = destination.uri;
          setNoPreview(false); setUri(thumbnail);
        }
      } finally { removeCoverFile(original); }
    }).catch(() => { if (!controller.signal.aborted) { setFailed(true); setNoPreview(true); setMessage("Не удалось загрузить превью"); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); removeCoverFile(thumbnail); };
  }, [enabled, profile, entityId, attempt]);
  return <View testID={"memory-cover-" + entityId} style={{ height: noPreview ? undefined : height, minHeight: compact ? 48 : 64, paddingVertical: uri ? 0 : 8, backgroundColor: t.soft, justifyContent: "center", alignItems: "center", overflow: "hidden" }}>
    {enabled && uri && !failed ? <Image source={{ uri }} accessibilityLabel={label} resizeMode="cover"
      onError={() => { removeCoverFile(uri); setUri(""); setFailed(true); setNoPreview(true); setMessage("Не удалось показать превью"); }} style={{ width: "100%", height: "100%" }} /> : <>
      {loading ? <ActivityIndicator accessibilityLabel="Загрузка обложки" /> : <Feather name="image" size={compact ? 24 : 28} color={t.muted} />}
      {!compact ? <Text style={{ color: t.muted, fontSize: 13, padding: 8, textAlign: "center" }}>{loading ? "Загружаю фото…" : message || "Фото"}</Text> : null}
      {failed && enabled ? <Pressable accessibilityRole="button" accessibilityLabel="Повторить загрузку обложки" onPress={event => { event?.stopPropagation?.(); setAttempt(value => value + 1); }} style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 12 }}><Text style={{ color: t.secondary }}>Повторить</Text></Pressable> : null}
    </>}
  </View>;
}
