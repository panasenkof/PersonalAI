import React from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import type { ChatMemoryRef } from "../direct-agent/conversations";
import { MemoryCover } from "./MemoryCover";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "../design/nebula/tokens";

/** All relevant returned matches are visible in similarity order, not silently
 * hidden behind a one-result preview. Each attachment has a distinct key:
 * several photographs can belong to one note.
 */
export function PhotoSearchResults({ profile, results, onOpen }: {
  profile: string;
  results: ChatMemoryRef[];
  onOpen: (result: ChatMemoryRef, original: boolean) => void;
}) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const twoColumns = width >= 360 && fontScale <= 1.2;
  return <View style={{ gap: nebulaSpacing.sm }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: nebulaSpacing.sm }}>
      {results.map((result, index) => <View key={result.id+":"+(result.photoAttachmentId||index)}
        style={{ width: twoColumns ? "47%" : "100%", gap: nebulaSpacing.xs,
          padding:nebulaSpacing.xs,borderRadius:nebulaRadii.card,borderWidth:1,
          borderColor:t.line,backgroundColor:t.soft }}>
        <Pressable accessibilityRole="link" accessibilityLabel={"Открыть найденное фото " + result.title+" "+(index+1)}
          onPress={() => onOpen(result, true)} style={{ minHeight: nebulaTouch.minimum }}>
          <MemoryCover profile={profile} entityId={result.id} photoAttachmentId={result.photoAttachmentId}
            height={twoColumns ? 142 : 210} fit="contain" label={"Найденная фотография " + result.title} />
          <Text numberOfLines={2} style={{ color: t.text,fontSize:13,fontWeight:"600" }}>{result.title}</Text>
        </Pressable>
        <Pressable accessibilityRole="link" accessibilityLabel={"Открыть запись " + result.title+" "+(index+1)}
          onPress={() => onOpen(result, false)} style={{ minHeight: nebulaTouch.minimum, justifyContent: "center" }}>
          <Text style={{ color: t.secondary,fontSize:12 }}>Открыть запись</Text>
        </Pressable>
      </View>)}
    </View>
  </View>;
}
