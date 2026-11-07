import React from "react";
import { Linking, Text, View } from "react-native";
import { useTheme } from "../../theme";
import { NebulaAction } from "./components";
import type { SourceProvenance } from "../../media/source-provenance";

/** The same provenance card appears in the unsaved import and in the saved
 * note. Opening an external URL is ALWAYS a deliberate user action. */
export function SourceProvenanceCard({
  source, onOpenError, onRecheck, onCancelRecheck, recheckBusy = false, recheckDisabled = false, recheckMessage,
}: { source: SourceProvenance; onOpenError: () => void;
  onRecheck?: () => void; onCancelRecheck?: () => void;
  recheckBusy?: boolean; recheckDisabled?: boolean; recheckMessage?: string | null;
}) {
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
          size="compact" accessibilityLabel="Открыть ссылку на источник в браузере"
          onPress={()=>{void Linking.openURL(source.url!).catch(onOpenError);}} />
      </View>
    </> : null}
    {onRecheck ? <View style={{flexDirection:"row",flexWrap:"wrap",alignItems:"center",gap:8}}>
      <NebulaAction icon="refresh-cw" label={recheckBusy ? "Проверяем текст…" : "Сверить текст"}
        size="compact" accessibilityLabel="Сверить текст публичного поста Telegram"
        disabled={recheckBusy || recheckDisabled} onPress={onRecheck}/>
      {recheckBusy && onCancelRecheck ? <NebulaAction icon="x" label="Отменить"
        size="compact" accessibilityLabel="Отменить сверку текста"
        onPress={onCancelRecheck}/> : null}
    </View> : null}
    {recheckMessage ? <Text accessibilityLiveRegion="polite"
      style={{color:t.secondary,fontSize:13,lineHeight:19}}>{recheckMessage}</Text> : null}
  </View>;
}
