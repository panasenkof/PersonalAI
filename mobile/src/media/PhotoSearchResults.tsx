import React, { useState } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import type { ChatMemoryRef } from "../direct-agent/conversations";
import { MemoryCover } from "./MemoryCover";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "../design/nebula/tokens";

/** One best match is visible by default; more ranked photos can be
 * expanded on demand. Distinct attachment keys preserve images within a note.
 */
export function PhotoSearchResults({ profile, results, limit = 6, onOpen }: {
  profile: string;
  results: ChatMemoryRef[];
  limit?: number;
  onOpen: (result: ChatMemoryRef, original: boolean) => void;
}) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  const twoColumns = width >= 360 && fontScale <= 1.2;
  const closest = results.slice(0, Number.isInteger(limit) && limit >= 1 && limit <= 20 ? limit : 6);
  const visible = expanded ? closest : closest.slice(0, 1);
  return <View style={{ gap: nebulaSpacing.sm }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: nebulaSpacing.sm }}>
      {visible.map((result, index) => <View key={result.id+":"+(result.photoAttachmentId||index)}
        style={{ width: expanded && twoColumns ? "47%" : "100%", gap: nebulaSpacing.xs,
          padding:nebulaSpacing.xs,borderRadius:nebulaRadii.card,borderWidth:1,
          borderColor:t.line,backgroundColor:t.soft }}>
        <Pressable accessibilityRole="link" accessibilityLabel={"Открыть найденное фото " + result.title+" "+(index+1)}
          onPress={() => onOpen(result, true)} style={{ minHeight: nebulaTouch.minimum }}>
          <MemoryCover profile={profile} entityId={result.id} photoAttachmentId={result.photoAttachmentId}
            height={expanded && twoColumns ? 142 : 210} fit="contain" label={"Найденная фотография " + result.title} />
          <Text numberOfLines={2} style={{ color: t.text,fontSize:13,fontWeight:"600" }}>{result.title}</Text>
        </Pressable>
        <Pressable accessibilityRole="link" accessibilityLabel={"Открыть запись " + result.title+" "+(index+1)}
          onPress={() => onOpen(result, false)} style={{ minHeight: nebulaTouch.minimum, justifyContent: "center" }}>
          <Text style={{ color: t.secondary,fontSize:12 }}>Открыть запись</Text>
        </Pressable>
      </View>)}
    </View>
    {closest.length > 1 ? <Pressable testID="photo-results-toggle"
      accessibilityRole="button" accessibilityState={{expanded}}
      accessibilityLabel={expanded ? "Свернуть похожие фотографии" : "Показать ещё похожие фотографии"}
      onPress={() => setExpanded(value => !value)}
      style={{minHeight:nebulaTouch.minimum,justifyContent:"center",alignItems:"center",
        borderRadius:nebulaRadii.pill,borderWidth:1,borderColor:t.line,backgroundColor:t.soft,
        paddingHorizontal:nebulaSpacing.sm}}>
      <Text style={{color:t.accent,fontSize:13,fontWeight:"600"}}>
        {expanded ? "Свернуть дополнительные фото" : `Показать ещё ${closest.length - 1} похожих фото`}
      </Text>
    </Pressable> : null}
  </View>;
}
