import React from "react";
import { Linking, Text, View } from "react-native";
import { useTheme } from "../../theme";
import { NebulaAction } from "./components";
import type { SourceProvenance } from "../../media/source-provenance";

/** The same provenance card appears in the unsaved import and in the saved
 * note. Opening an external URL is ALWAYS a deliberate user action. */
export function SourceProvenanceCard({
  source, onOpenError,
}: { source: SourceProvenance; onOpenError: () => void }) {
  const t = useTheme();
  return <View testID="source-provenance-card" accessibilityLabel="Сведения об источнике"
    style={{padding:12,borderWidth:1,borderColor:t.line,borderRadius:16,
      backgroundColor:t.panel,gap:7}}>
    <Text accessibilityRole="header" style={{color:t.text,fontWeight:"700"}}>
      {source.title}
    </Text>
    <Text style={{color:t.muted,fontSize:13,lineHeight:19}}>{source.details}</Text>
    {source.publication ? <Text style={{color:t.secondary,fontSize:12}}>
      {source.publication}
    </Text> : null}
    {source.url ? <>
      <Text selectable numberOfLines={3} style={{color:t.secondary,fontSize:13}}>
        {source.url}
      </Text>
      <View style={{alignItems:"flex-start"}}>
        <NebulaAction icon="external-link" label="Открыть источник"
          size="compact" accessibilityLabel="Открыть проверенную HTTPS-ссылку в браузере"
          onPress={()=>{void Linking.openURL(source.url!).catch(onOpenError);}} />
      </View>
    </> : null}
  </View>;
}
