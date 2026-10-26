import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Pressable, ScrollView, Text, View} from 'react-native';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {RootStackParams} from '../navigation';
import {useDirectChat} from '../direct-agent/ChatContext';
import {useProfile} from '../profile/ProfileContext';
import {localMemorySessionUnlocked, onLocalMemorySessionChange} from '../local-memory/storage';
import {prepareSharedMaterial, type PreparedShare} from '../media/share-destination';
import {ChatAttachmentList} from '../media/ChatAttachmentList';
import {useTheme} from '../theme';
import {nebulaSpacing, nebulaRadii, nebulaTouch} from '../design/nebula/tokens';

export function ShareDestinationScreen(){
  const route=useRoute<RouteProp<RootStackParams,'ShareDestination'>>();
  const navigation=useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const {store,active}=useDirectChat();const profile=useProfile(), owner=useRef(profile);
  const t=useTheme(), insets=useSafeAreaInsets();
  const [material,setMaterial]=useState<PreparedShare|null>(null), [error,setError]=useState('');
  const [loading,setLoading]=useState(true), [attempt,setAttempt]=useState(0);
  const handled=useRef(false);
  useEffect(()=>{
    const controller=new AbortController();let alive=true;
    setLoading(true);setMaterial(null);setError('');
    const off=onLocalMemorySessionChange(unlocked=>{if(!unlocked){controller.abort();if(alive){setMaterial(null);setError('Сеанс завершён. Повторите проверку после разблокировки.');setLoading(false);}}});
    if(profile!==owner.current){setLoading(false);setError('Профиль изменился. Поделитесь материалом ещё раз.');}
    else void prepareSharedMaterial(route.params.incoming,controller.signal).then(value=>{if(alive && !controller.signal.aborted)setMaterial(value);}).catch(()=>{if(alive && !controller.signal.aborted)setError('Не удалось прочитать входящий материал. Повторите проверку или поделитесь им заново.');}).finally(()=>{if(alive)setLoading(false);});
    return ()=>{alive=false;controller.abort();off();};
  },[route.params.incoming,profile,attempt]);
  let chatError=material?.chatError || '';
  if(material && !chatError){try{store.sharedDraft(active?.id || '',material.text,material.attachments);}catch(e){chatError=(e as Error).message;}}
  const available=Boolean(material && !loading && profile===owner.current);
  const button={minHeight:nebulaTouch.minimum,padding:nebulaSpacing.md,borderRadius:nebulaRadii.card,gap:nebulaSpacing.xs};
  const guard=()=>available && !handled.current && localMemorySessionUnlocked();
  function toChat(){
    if(!guard() || chatError || !material || !active)return;
    try{store.appendSharedDraft(active.id,material.text,material.attachments);handled.current=true;navigation.popTo('Tabs',{screen:'Home'});}
    catch(e){setError((e as Error).message);}
  }
  function toMemory(){
    if(!guard() || material?.memoryError)return;
    handled.current=true;navigation.replace('MemoryImport',{incoming:route.params.incoming});
  }
  return <ScrollView style={{flex:1,backgroundColor:t.bg}} contentContainerStyle={{padding:nebulaSpacing.md,paddingBottom:insets.bottom+nebulaSpacing.lg,gap:nebulaSpacing.md}}>
    <Text accessibilityRole="header" style={{color:t.text,fontSize:26,fontWeight:'800'}}>Куда добавить?</Text>
    <Text style={{color:t.muted}}>Получено из другого приложения. Выберите назначение.</Text>
    {loading ? <ActivityIndicator accessibilityLabel="Проверка входящих материалов"/> : null}
    {material ? <View style={{...button,backgroundColor:t.panel}}>
      <Text style={{color:t.text}}>Материалов: {route.params.incoming.length}</Text>
      {material.text ? <Text numberOfLines={4} style={{color:t.muted}}>{material.text}</Text> : null}
      {material.attachments.length ? <ChatAttachmentList files={material.attachments}/> : material.files.map((f,i)=><Text key={i} style={{color:t.text}}>{f.name}</Text>)}
    </View> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Добавить входящее в чат" accessibilityState={{disabled:!available || Boolean(chatError)}} disabled={!available || Boolean(chatError)} onPress={toChat} style={{...button,backgroundColor:t.soft,opacity:available&&!chatError?1:.5}}>
      <Text style={{color:t.secondary,fontSize:18,fontWeight:'700'}}>В чат</Text>
      <Text style={{color:t.muted}}>Дополнить черновик{active?.title ? ` «${active.title}»` : ''}. Отправка модели — только кнопкой отправки.</Text>
    </Pressable>
    {chatError ? <Text accessibilityLiveRegion="polite" style={{color:t.muted}}>{chatError}</Text> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Добавить входящее в память" accessibilityState={{disabled:!available || Boolean(material?.memoryError)}} disabled={!available || Boolean(material?.memoryError)} onPress={toMemory} style={{...button,backgroundColor:t.soft,opacity:available&&!material?.memoryError?1:.5}}>
      <Text style={{color:t.secondary,fontSize:18,fontWeight:'700'}}>В память</Text>
      <Text style={{color:t.muted}}>Предпросмотр новой заметки и выбор коллекции. Сохранение — отдельной кнопкой.</Text>
    </Pressable>
    {material?.memoryError ? <Text style={{color:t.muted}}>{material.memoryError}</Text> : null}
    {error ? <><Text accessibilityRole="alert" style={{color:t.err}}>{error}</Text><Pressable accessibilityRole="button" accessibilityLabel="Повторить проверку входящего" onPress={()=>setAttempt(n=>n+1)} style={button}><Text style={{color:t.secondary}}>Повторить проверку</Text></Pressable></> : null}
    <Pressable accessibilityRole="button" accessibilityLabel="Отменить приём материала" onPress={()=>navigation.goBack()} style={button}><Text style={{color:t.secondary}}>Отмена</Text></Pressable>
  </ScrollView>;
}
