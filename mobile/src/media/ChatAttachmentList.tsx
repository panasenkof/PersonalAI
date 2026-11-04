import React from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import type { ChatAttachment } from "../direct-agent/chat-attachments";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing } from "../design/nebula/tokens";
import { NebulaAction } from "../design/nebula/components";

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
  const hasImage=files.some(file=>file.kind==="image");
  const hasTranscript=files.some(file=>file.kind==="text" &&
    (file.name.startsWith("Текст PDF: ") || file.name.startsWith("Транскрипт аудио: ")));
  // Reserve actual vertical space for all Nebula buttons; text-only attachments
  // must not inherit a photo-sized blank rectangle. The horizontal row height
  // is the tallest attachment, avoiding clipped actions on mixed selections.
  const actionCount=(onRemove?1:0)+(onSearch && hasImage?1:0);
  const height=hasImage ? (actionCount===2?250:actionCount===1?198:146)
    : (actionCount===2?142:actionCount===1?(hasTranscript?124:90):(hasTranscript?76:48));
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
      {file.kind === "text" && file.name.startsWith("Текст PDF: ") ? <Text style={{color:t.muted,fontSize:12,lineHeight:17}}>
        Только текст PDF · оригинал не отправится
      </Text> : null}
      {file.kind === "text" && file.name.startsWith("Транскрипт аудио: ") ? <Text style={{color:t.muted,fontSize:12,lineHeight:17}}>
        Текст Whisper · аудио не отправится
      </Text> : null}
      {onSearch && file.kind==="image" ? <NebulaAction label="Найти похожие"
        accessibilityLabel={"Найти похожие в памяти по фото "+file.name} disabled={disabled}
        onPress={()=>onSearch(file)} /> : null}
      {onRemove ? <NebulaAction icon="x" label="Убрать"
        accessibilityLabel={"Убрать вложение "+file.name} disabled={disabled}
        onPress={()=>onRemove(file.id)} /> : null}
    </View>)}
  </ScrollView>;
}
