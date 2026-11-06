import React from "react";
import { Image, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import type { ChatAttachment } from "../direct-agent/chat-attachments";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing } from "../design/nebula/tokens";
import { NebulaAction } from "../design/nebula/components";

/** Bound the horizontal rail to its tallest real card, including multiline
 * accessible action labels. This prevents Android from stretching the ScrollView
 * to the viewport while keeping both photo buttons visible at large font sizes.
 * No photo-sized empty slot is reserved for a text-only attachment. */
export function chatAttachmentRailHeight(
  files: readonly ChatAttachment[],
  removable: boolean,
  searchable: boolean,
  fontScale = 1,
): number {
  if (!files.length) return 0;
  const scale = Number.isFinite(fontScale) ? Math.max(1, fontScale) : 1;
  const titleHeight = Math.ceil(18 * scale);
  // "Найти похожие" may wrap to two or three lines inside a 160dp card.
  const actionHeight = scale > 1.6
    ? Math.ceil(60 * scale)
    : Math.max(48, Math.ceil(40 * scale));
  const descriptionHeight = Math.ceil(38 * scale);
  return Math.max(...files.map(file => {
    const image = file.kind === "image";
    const description = file.kind === "text" &&
      (file.name.startsWith("Текст PDF: ") || file.name.startsWith("Транскрипт аудио: "));
    const actions = Number(removable) + Number(searchable && image);
    const children = 1 + Number(image) + Number(description) + actions;
    return 2 * nebulaSpacing.xs + (children - 1) * nebulaSpacing.xs
      + titleHeight + (image ? 114 : 0) + (description ? descriptionHeight : 0)
      + actions * actionHeight + 4; // Small native font/layout rounding allowance
  }));
}

/** Chat attachments must have a bounded height. Horizontal ScrollView without
 * an explicit height can stretch to the FlatList viewport on Android and leave
 * huge empty coloured rectangles as the user scrolls.
 */
export function ChatAttachmentList({files, onRemove, onSearch, onSelectImage, selectedImageId, disabled=false}: {
  files: ChatAttachment[]; onRemove?: (id:string)=>void; onSearch?: (file:ChatAttachment)=>void;
  onSelectImage?: (id:string)=>void; selectedImageId?:string; disabled?:boolean;
}) {
  const t=useTheme();
  const { fontScale } = useWindowDimensions();
  if (!files.length) return null;
  const interactive=Boolean(onRemove || onSearch || onSelectImage);
  const height=chatAttachmentRailHeight(files,Boolean(onRemove),Boolean(onSearch),fontScale);
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
      {onSearch && file.kind==="image" ? <NebulaAction label="Найти похожие" size="compact"
        accessibilityLabel={"Найти похожие в памяти по фото "+file.name} disabled={disabled}
        onPress={()=>onSearch(file)} /> : null}
      {onRemove ? <NebulaAction icon="x" label="Убрать" size="compact"
        accessibilityLabel={"Убрать вложение "+file.name} disabled={disabled}
        onPress={()=>onRemove(file.id)} /> : null}
    </View>)}
  </ScrollView>;
}
