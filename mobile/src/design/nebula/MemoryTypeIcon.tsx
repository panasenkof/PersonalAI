import React from "react";
import { Image } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { useTheme } from "../../theme";

/** Nebula artwork for memory types: one generated sheet, sliced 1:1 and padded to
 * a common scale, so icons keep their relative weight. Feather remains the
 * fallback for any type the sheet does not cover. */
const ARTWORK = {
  note: require("../../../assets/memory-icons/note.png"),
  person: require("../../../assets/memory-icons/person.png"),
  event: require("../../../assets/memory-icons/event.png"),
  preference: require("../../../assets/memory-icons/preference.png"),
  document: require("../../../assets/memory-icons/document.png"),
  photo: require("../../../assets/memory-icons/photo.png"),
  audio: require("../../../assets/memory-icons/audio.png"),
  video: require("../../../assets/memory-icons/video.png"),
  link: require("../../../assets/memory-icons/link.png"),
  file: require("../../../assets/memory-icons/file.png"),
  archive: require("../../../assets/memory-icons/archive.png"),
  trash: require("../../../assets/memory-icons/trash.png"),
  folder: require("../../../assets/memory-icons/folder.png"),
} as const;

export type MemoryArtworkName = keyof typeof ARTWORK;

/** `memoryNoteType` speaks Feather; this maps those names to the artwork. */
const FROM_FEATHER: Record<string, MemoryArtworkName> = {
  "edit-3": "note", user: "person", calendar: "event", heart: "preference",
  "file-text": "document", image: "photo", music: "audio", video: "video", link: "link",
};

export function MemoryTypeIcon({ feather, name, size = 28, dimmed = false }: {
  feather?: string;
  name?: MemoryArtworkName;
  size?: number;
  dimmed?: boolean;
}) {
  const t = useTheme();
  const key = name || (feather ? FROM_FEATHER[feather] : undefined);
  if (key) {
    return <Image source={ARTWORK[key]} accessibilityIgnoresInvertColors resizeMode="contain"
      style={{ width: size, height: size, opacity: dimmed ? 0.5 : 1 }} />;
  }
  return <Feather name={(feather || "file-text") as never} size={size} color={t.muted} />;
}

