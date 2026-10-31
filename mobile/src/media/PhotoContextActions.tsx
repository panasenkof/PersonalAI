import Feather from "@expo/vector-icons/Feather";
import React from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "../design/nebula/tokens";
import { useTheme } from "../theme";

type PhotoActionId = "internet" | "memory" | "note" | "preview";
type PhotoAction = { id: PhotoActionId; label: string; run: () => void };
const icons: Record<PhotoActionId, React.ComponentProps<typeof Feather>["name"]> = {
  internet: "globe", memory: "search", note: "bookmark", preview: "maximize-2",
};
const subtitles: Record<PhotoActionId, string> = {
  internet: "Узнать об объекте", memory: "Найти похожее", note: "В коллекцию", preview: "Открыть снимок",
};

/** Nebula glass actions: compact 2-column grid, visible Cancel, no separate search store.
 * All actions are explicit: no remote transfer or memory write on photo capture.
 */
export function PhotoContextActions({ actions, onCancel, disabled=false }: {
  actions: readonly PhotoAction[]; onCancel: () => void; disabled?: boolean;
}) {
  const t = useTheme();
  const { width, fontScale } = useWindowDimensions();
  const singleColumn = width < 330 || fontScale > 1.3;
  return <View testID="photo-context-actions" style={{ gap: nebulaSpacing.sm, paddingVertical: nebulaSpacing.xs }}>
    <View style={{flexDirection:"row",alignItems:"center",justifyContent:"space-between",gap:8}}>
      <View style={{flex:1,flexDirection:"row",alignItems:"center",gap:8}}>
        <Feather name="image" size={16} color={t.secondary}/>
        <Text style={{color:t.text,fontSize:14,fontWeight:"700"}}>Что сделать с фото?</Text>
      </View>
      <Pressable testID="photo-action-cancel" accessibilityRole="button" accessibilityLabel="Отмена: убрать выбранное фото"
        disabled={disabled} onPress={onCancel} style={{minHeight:nebulaTouch.minimum,minWidth:84,
          flexDirection:"row",alignItems:"center",justifyContent:"center",gap:5,
          borderRadius:nebulaRadii.pill,borderWidth:1,borderColor:t.line,backgroundColor:t.panel,
          opacity:disabled?0.45:1}}>
        <Feather name="x" size={15} color={t.muted}/>
        <Text style={{color:t.muted,fontSize:13,fontWeight:"600"}}>Отмена</Text>
      </Pressable>
    </View>
    <View style={{flexDirection:"row",flexWrap:"wrap",gap:nebulaSpacing.xs}}>
      {actions.map(action=><Pressable key={action.id} testID={"photo-action-"+action.id}
        accessibilityRole="button" accessibilityLabel={action.label}
        accessibilityHint={subtitles[action.id]} accessibilityState={{disabled}}
        disabled={disabled} onPress={action.run}
        style={({pressed})=>({
          width:singleColumn?"100%":"48.5%",flexGrow:1,minHeight:76,
          flexDirection:"row",alignItems:"center",gap:9,paddingHorizontal:11,paddingVertical:10,
          borderRadius:nebulaRadii.card,borderWidth:1,
          borderColor:action.id==="memory"?t.secondary:t.line,
          backgroundColor:pressed?t.glow:t.soft,opacity:disabled?0.45:1,
          shadowColor:t.glow,shadowOpacity:0.12,shadowRadius:9,shadowOffset:{width:0,height:3},
          elevation:2,
        })}>
        <View style={{width:34,height:34,borderRadius:12,alignItems:"center",justifyContent:"center",
          backgroundColor:t.panel,borderWidth:1,borderColor:t.line}}>
          <Feather name={icons[action.id]} size={18} color={action.id==="memory"?t.secondary:t.accent}/>
        </View>
        <View style={{flex:1,minWidth:0,gap:3}}>
          <Text style={{color:t.text,fontSize:13,fontWeight:"700",lineHeight:17}}>{action.label}</Text>
          <Text style={{color:t.muted,fontSize:11,lineHeight:14}}>{subtitles[action.id]}</Text>
        </View>
      </Pressable>)}
    </View>
    <Text style={{color:t.muted,fontSize:11,lineHeight:16}}>
      Поиск в памяти — на телефоне. Перед отправкой фото в интернет потребуется подтверждение.
    </Text>
  </View>;
}
