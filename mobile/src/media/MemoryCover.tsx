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
import { MemoryTypeIcon } from "../design/nebula/MemoryTypeIcon";

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
export function MemoryCover({ profile, entityId, photoAttachmentId, active = true, height = 132, label = "Обложка записи", compact = false, fit = "cover", icon = "image", expectPhoto = true }: {
  profile: string; entityId: string; photoAttachmentId?: string; active?: boolean; height?: number; label?: string; compact?: boolean; fit?: "cover" | "contain"; icon?: string; expectPhoto?: boolean;
}) {
  const t = useTheme(); const focused = useIsFocused(); const visible = useApplicationVisible();
  const [unlocked, setUnlocked] = useState(true);
  const [uri, setUri] = useState(""); const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState(""); const [loading, setLoading] = useState(false); const [attempt, setAttempt] = useState(0);
  useEffect(() => onLocalMemorySessionChange(setUnlocked), []);
  const activation = useRef({ key: "", seen: false });
  const key = profile + ":" + entityId + ":" + (photoAttachmentId || "");
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
      const image = items.find(item => (!photoAttachmentId || item.id === photoAttachmentId) && attachmentPreviewKind(item) === "image" && item.size <= 12 * 1024 * 1024);
      if (controller.signal.aborted) return;
      if (!image) {
        setMessage(!expectPhoto ? "" : items.some(item => attachmentPreviewKind(item) === "image") ? "Большое фото · откройте оригинал во вложениях" : "Оригинал фото не сохранён");
        return;
      }
      let original = "";
      try {
        original = await materializeAttachment(profile, image, controller.signal);
        if (controller.signal.aborted) return;
        // A decoder failure stays retryable. A resize that "succeeds" but leaves
        // an unusable file must not blank the cover: the decrypted original is a
        // local file the note screen already renders, so fall back to it.
        const result = await manipulateAsync(original, [{ resize: { width: 480 } }], { compress: 0.7, format: SaveFormat.JPEG });
        if (controller.signal.aborted) { removeCoverFile(result.uri); return; }
        let moved = "";
        try {
          const directory = new Directory(Paths.cache, "persai-previews");
          directory.create({ intermediates: true, idempotent: true });
          const destination = new File(directory, Crypto.randomUUID() + ".jpg");
          new File(result.uri).move(destination);
          // A zero-byte destination renders as a blank card: fall back to the
          // original instead of showing nothing.
          const size = Number((destination as { size?: number }).size);
          if (!(size === 0)) moved = destination.uri;
        } catch { moved = ""; }
        thumbnail = moved || original;
        if (controller.signal.aborted) { if (thumbnail !== original) removeCoverFile(thumbnail); return; }
        setUri(thumbnail);
      } finally { if (thumbnail !== original) removeCoverFile(original); }
    }).catch(() => { if (!controller.signal.aborted) { setFailed(true); setMessage("Не удалось загрузить превью"); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); removeCoverFile(thumbnail); };
  }, [enabled, profile, entityId, photoAttachmentId, attempt]);
  // Keep the same bounded footprint during loading, missing originals and decoder errors.
  // A failed thumbnail must not push adjacent grid items or move the list anchor.
  return <View testID={"memory-cover-" + entityId} style={{ height, minHeight: compact ? height : 64, paddingVertical: uri ? 0 : 8, backgroundColor: t.soft, justifyContent: "center", alignItems: "center", overflow: "hidden" }}>
    {enabled && uri && !failed ? <Image source={{ uri }} accessibilityLabel={label} resizeMode={fit}
      onError={() => { removeCoverFile(uri); setUri(""); setFailed(true); setMessage("Не удалось показать превью"); }} style={{ width: "100%", height: "100%" }} /> : <>
      {loading ? <ActivityIndicator accessibilityLabel="Загрузка обложки" /> : <MemoryTypeIcon feather={icon} size={compact ? 24 : 28} />}
      {!compact ? <Text style={{ color: t.muted, fontSize: 13, padding: 8, textAlign: "center" }}>{loading ? "Загружаю…" : message}</Text> : null}
      {failed && enabled ? <Pressable accessibilityRole="button" accessibilityLabel="Повторить загрузку обложки"
        onPress={event => { event?.stopPropagation?.(); setAttempt(value => value + 1); }}
        style={compact ? { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, minHeight: 48, alignItems: "center", justifyContent: "center", backgroundColor: t.soft } :
          { minHeight: 48, justifyContent: "center", paddingHorizontal: 12, borderWidth: 1,
            borderColor: t.secondary, backgroundColor: t.panel, borderRadius: 12 }}>
        {compact ? <Feather name="refresh-cw" size={22} color={t.secondary} /> : <Text style={{ color: t.secondary }}>Повторить</Text>}
      </Pressable> : null}
    </>}
  </View>;
}



