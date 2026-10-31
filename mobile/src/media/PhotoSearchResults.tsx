import React, { useState } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import type { ChatMemoryRef } from "../direct-agent/conversations";
import { MemoryCover } from "./MemoryCover";
import { useTheme } from "../theme";
import { nebulaSpacing, nebulaTouch } from "../design/nebula/tokens";

/** Bounded initial previews keep a long result turn readable in the chat. */
export function PhotoSearchResults({ profile, results, onOpen }: {
  profile: string;
  results: ChatMemoryRef[];
  onOpen: (result: ChatMemoryRef, original: boolean) => void;
}) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  const twoColumns = width >= 430 && fontScale <= 1.2;
  const visible = expanded ? results : results.slice(0, 4);
  return <View style={{ gap: nebulaSpacing.sm }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: nebulaSpacing.sm }}>
      {visible.map(result => <View key={result.id} style={{ width: twoColumns ? "47%" : "100%", gap: nebulaSpacing.xs }}>
        <Pressable accessibilityRole="link" accessibilityLabel={"Открыть найденное фото " + result.title}
          onPress={() => onOpen(result, true)} style={{ minHeight: nebulaTouch.minimum }}>
          <MemoryCover profile={profile} entityId={result.id} photoAttachmentId={result.photoAttachmentId}
            height={results.length === 1 ? 220 : 160} fit="contain" label={"Найденная фотография " + result.title} />
          <Text numberOfLines={2} style={{ color: t.text }}>{result.title}</Text>
        </Pressable>
        <Pressable accessibilityRole="link" accessibilityLabel={"Открыть запись " + result.title}
          onPress={() => onOpen(result, false)} style={{ minHeight: nebulaTouch.minimum, justifyContent: "center" }}>
          <Text style={{ color: t.secondary }}>Открыть запись</Text>
        </Pressable>
      </View>)}
    </View>
    {results.length > 4 ? <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
      onPress={() => setExpanded(value => !value)} style={{ minHeight: nebulaTouch.minimum, justifyContent: "center" }}>
      <Text style={{ color: t.accent }}>{expanded ? "Свернуть фотографии" : `Показать ещё ${results.length - 4}`}</Text>
    </Pressable> : null}
  </View>;
}
