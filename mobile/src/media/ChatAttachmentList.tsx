import React from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import type { ChatAttachment } from "../direct-agent/chat-attachments";
import { useTheme } from "../theme";
import { nebulaTouch, nebulaRadii, nebulaSpacing } from "../design/nebula/tokens";

/** Chat attachments must have a bounded height. Horizontal ScrollView without
 * an explicit height can stretch to the FlatList viewport on Android and leave
 * huge empty coloured rectangles as the user scrolls.
 */
export function ChatAttachmentList({files, onRemove, onSearch, onSelectImage, selectedImageId, disabled=false}: {
  files: ChatAttachment[]; onRemove?: (id:string)=>void; onSearch?: (file:ChatAttachment)=>void;
  onSelectImage?: (id:string)=>void; selectedImageId?:string; disabled?:boolean;
}) {
  const t=useTheme();
  if (!files.length) return null;
  const interactive=Boolean(onRemove || onSearch || onSelectImage);
  const height=interactive?(onRemove&&onSearch?214:onRemove||onSearch?170:146):146;
  return <ScrollView horizontal
    style={{height,flexGrow:0,flexShrink:0,alignSelf:"flex-start",maxWidth:"100%"}}
    contentContainerStyle={{gap:nebulaSpacing.sm,alignItems:"flex-start"}}
    accessibilityLabel="Вложения сообщения" showsHorizontalScrollIndicator={files.length>1}>
    {files.map((file,index) => <View key={file.id}
      style={{width:160,padding:nebulaSpacing.xs,borderRadius:nebulaRadii.field,
        backgroundColor:t.soft,gap:nebulaSpacing.xs}}>
      {file.kind === "image" ? <Pressable accessibilityRole="button" disabled={disabled || !onSelectImage}
        accessibilityLabel={"Выбрать фото "+file.name}
        accessibilityState={{selected:selectedImageId===file.id}}
        onPress={()=>onSelectImage?.(file.id)}
        style={{borderWidth:selectedImageId===file.id?2:0,borderColor:t.accent,
          borderRadius:nebulaRadii.field,overflow:"hidden"}}>
        <Image source={{uri:`data:${file.mime};base64,${file.data}`}}
          accessibilityLabel={"Изображение "+file.name}
          style={{width:"100%",height:110,backgroundColor:t.panel}}
          resizeMode="contain"/>
      </Pressable> : null}
      <Text numberOfLines={1} ellipsizeMode="middle" style={{color:t.text,fontSize:12}}>
        {interactive ? file.name : file.kind==="image" ? `Фотография ${index+1}` : file.name}
      </Text>
      {onSearch && file.kind==="image" ? <Pressable accessibilityRole="button"
        accessibilityLabel={"Найти похожие в памяти по фото "+file.name} disabled={disabled}
        onPress={()=>onSearch(file)} style={{minHeight:nebulaTouch.minimum,justifyContent:"center"}}>
        <Text style={{color:t.accent}}>Найти похожие</Text>
      </Pressable> : null}
      {onRemove ? <Pressable accessibilityRole="button"
        accessibilityLabel={"Убрать вложение "+file.name} disabled={disabled}
        onPress={()=>onRemove(file.id)}
        style={{minHeight:nebulaTouch.minimum,justifyContent:"center"}}>
        <Text style={{color:t.secondary}}>Убрать</Text>
      </Pressable> : null}
    </View>)}
  </ScrollView>;
}
