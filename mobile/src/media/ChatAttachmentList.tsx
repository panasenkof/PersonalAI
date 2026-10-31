import React from 'react';
import { Image, Pressable, ScrollView, Text, View } from 'react-native';
import type { ChatAttachment } from '../direct-agent/chat-attachments';
import { useTheme } from '../theme';
import { nebulaTouch, nebulaRadii, nebulaSpacing } from '../design/nebula/tokens';
export function ChatAttachmentList({files, onRemove, onSearch, onSelectImage, selectedImageId, disabled=false}: {
  files: ChatAttachment[]; onRemove?: (id:string)=>void; onSearch?: (file:ChatAttachment)=>void;
  onSelectImage?: (id:string)=>void; selectedImageId?:string; disabled?:boolean;
}) {
  const t=useTheme();
  if (!files.length) return null;
  return <ScrollView horizontal contentContainerStyle={{gap:nebulaSpacing.sm}} accessibilityLabel="Вложения сообщения">
    {files.map(file => <View key={file.id} style={{maxWidth:180, padding:nebulaSpacing.xs, borderRadius:nebulaRadii.field, backgroundColor:t.soft, gap:nebulaSpacing.xs}}>
      {file.kind === 'image' ? <Pressable accessibilityRole="button" disabled={disabled || !onSelectImage}
        accessibilityLabel={'Выбрать фото '+file.name} accessibilityState={{selected:selectedImageId===file.id}}
        onPress={()=>onSelectImage?.(file.id)} style={{borderWidth:selectedImageId===file.id?2:0,borderColor:t.accent,borderRadius:nebulaRadii.field}}>
        <Image source={{uri:`data:${file.mime};base64,${file.data}`}} accessibilityLabel={'Изображение '+file.name}
          style={{width:92,height:72,borderRadius:nebulaRadii.field}} resizeMode="cover"/>
      </Pressable> : null}
      <Text numberOfLines={2} style={{color:t.text,fontSize:12}}>{file.name}</Text>
      {onSearch && file.kind === "image" ? <Pressable accessibilityRole="button" accessibilityLabel={"Найти похожие в памяти по фото " + file.name} disabled={disabled} onPress={() => onSearch(file)} style={{minHeight:nebulaTouch.minimum,justifyContent:"center"}}><Text style={{color:t.accent}}>Найти похожие в памяти</Text></Pressable> : null}
      {onRemove ? <Pressable accessibilityRole="button" accessibilityLabel={'Убрать вложение '+file.name} disabled={disabled} onPress={()=>onRemove(file.id)} style={{minHeight:nebulaTouch.minimum,justifyContent:'center'}}><Text style={{color:t.secondary}}>Убрать</Text></Pressable> : null}
    </View>)}
  </ScrollView>;
}
