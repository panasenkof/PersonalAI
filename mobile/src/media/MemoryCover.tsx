import React, { useEffect, useState } from "react";
import { Image, Text, View } from "react-native";
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
  useEffect(() => onLocalMemorySessionChange(setUnlocked), []);
  const enabled = active && focused && visible && unlocked;
  useEffect(() => {
    const controller = new AbortController(); let thumbnail = "";
    setUri(""); setFailed(false);
    if (enabled) void coverSlot(async () => {
      if (controller.signal.aborted) return;
      const items = await attachmentsForEntity(profile, entityId);
      const image = items.find(item => attachmentPreviewKind(item) === "image" && item.size <= 12 * 1024 * 1024);
      if (!image || controller.signal.aborted) return;
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
          setUri(thumbnail);
        }
      } finally { removeCoverFile(original); }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); removeCoverFile(thumbnail); };
  }, [enabled, profile, entityId]);
  return <View style={{ height, backgroundColor: t.soft, justifyContent: "center", alignItems: "center", overflow: "hidden" }}>
    {enabled && uri && !failed ? <Image source={{ uri }} accessibilityLabel={label} resizeMode="cover"
      onError={() => { removeCoverFile(uri); setUri(""); setFailed(true); }} style={{ width: "100%", height: "100%" }} /> : <>
      <Feather name="image" size={compact ? 24 : 32} color={t.muted} />
      {!compact ? <Text style={{ color: t.muted, fontSize: 13, padding: 8 }}>{failed ? "Превью недоступно" : "Фото"}</Text> : null}
    </>}
  </View>;
}
