import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { ChatFileFailure } from "./pickChatAttachments";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "../design/nebula/tokens";

/** A bounded, transient view of rejected picker items. There are no original
 * bytes or cache URIs here, and reselect opens the same Android file picker.
 * Success already lives in the normal, encrypted chat draft attachments.
 */
export function ChatAttachmentIssues({issues, onReselect, onDismiss, disabled=false}: {
  issues: ChatFileFailure[]; onReselect:()=>void; onDismiss:(index:number)=>void; disabled?:boolean;
}) {
  const t=useTheme();
  if(!issues.length)return null;
  return <View testID="chat-attachment-issues"
    accessibilityLabel="Не добавленные файлы"
    style={{borderWidth:1,borderColor:t.line,borderRadius:nebulaRadii.field,
      backgroundColor:t.soft,padding:nebulaSpacing.xs,gap:nebulaSpacing.xs}}>
    <Text accessibilityRole="header" style={{color:t.text,fontSize:13,fontWeight:"700"}}>
      Не добавлено: {issues.length}
    </Text>
    <ScrollView nestedScrollEnabled style={{maxHeight:222}}
      contentContainerStyle={{gap:nebulaSpacing.xs}}
      accessibilityLabel="Причины ошибок вложений">
      {issues.map((issue,index)=><View key={index}
        style={{borderRadius:nebulaRadii.chip,backgroundColor:t.panel,
          padding:nebulaSpacing.xs,gap:nebulaSpacing.xs}}>
        <Text numberOfLines={1} style={{color:t.text,fontWeight:"600"}}>{issue.name}</Text>
        <Text numberOfLines={3} accessibilityRole="alert"
          style={{color:t.muted,fontSize:13,lineHeight:19}}>{issue.reason}</Text>
        <View style={{flexDirection:"row",flexWrap:"wrap",gap:nebulaSpacing.xs}}>
          <Pressable accessibilityRole="button" accessibilityLabel={"Выбрать заново "+issue.name}
            disabled={disabled} onPress={onReselect}
            style={{minHeight:nebulaTouch.minimum,justifyContent:"center",paddingHorizontal:nebulaSpacing.xs,
              opacity:disabled?0.5:1}}>
            <Text style={{color:t.accent,fontWeight:"600"}}>Выбрать заново</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={"Убрать ошибку "+issue.name}
            onPress={()=>onDismiss(index)}
            style={{minHeight:nebulaTouch.minimum,justifyContent:"center",paddingHorizontal:nebulaSpacing.xs}}>
            <Text style={{color:t.secondary}}>Убрать</Text>
          </Pressable>
        </View>
      </View>)}
    </ScrollView>
  </View>;
}
