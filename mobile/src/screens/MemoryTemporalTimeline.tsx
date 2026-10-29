/** M4-UX U-M2/U-M3: source-backed temporal CANDIDATES on an existing person
 * card. No new temporal read path, automatic confirmation or inferred dates.
 * Never call a candidate "current fact"; valid time != recorded knowledge time.
 */
import React, {useEffect,useRef,useState} from "react";
import {ActivityIndicator,Pressable,Text,View} from "react-native";
import {useNavigation} from "@react-navigation/native";
import type {NativeStackNavigationProp} from "@react-navigation/native-stack";
import {localMemoryRepository} from "../local-memory/repository";
import {memoryErrorMessage} from "../local-memory/errors";
import {onLocalMemorySessionChange} from "../local-memory/storage";
import type {TemporalHistoryItem,TemporalHistoryMode,TemporalHistoryCursor} from "../local-memory/temporal-store";
import type {TemporalBound} from "../local-memory/temporal-claims";
import type {RootStackParams} from "../navigation";
import {useTheme} from "../theme";
import {nebulaRadii,nebulaSpacing,nebulaTouch} from "../design/nebula/tokens";

const MODES:ReadonlyArray<{mode:TemporalHistoryMode;label:string}>=[
  {mode:"all",label:"Все"},{mode:"states",label:"Состояния"},
  {mode:"events",label:"События"},
];
export function displayTemporalBound(bound:TemporalBound|null):string{
  if(!bound)return "Дата не установлена";
  return bound.raw?.trim()||bound.normalized||"Точная дата неизвестна";
}
export function MemoryTemporalTimeline({profile,subjectId,collectionId}:{
  profile:string;subjectId:string;collectionId:string;
}){
  const t=useTheme();
  const navigation=useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const generation=useRef(0);
  const [expanded,setExpanded]=useState(false);
  const [mode,setMode]=useState<TemporalHistoryMode>("all");
  const [items,setItems]=useState<TemporalHistoryItem[]>([]);
  const [cursor,setCursor]=useState<TemporalHistoryCursor|null>(null);
  const [busy,setBusy]=useState(false);
  const [loaded,setLoaded]=useState(false);
  const [error,setError]=useState("");

  const clear=()=>{
    generation.current++;setExpanded(false);setMode("all");setItems([]);
    setCursor(null);setBusy(false);setLoaded(false);setError("");
  };
  useEffect(()=>{
    const off=onLocalMemorySessionChange(unlocked=>{if(!unlocked)clear();});
    return ()=>{generation.current++;off();};
  },[]);
  useEffect(clear,[profile,subjectId,collectionId]);

  async function load(nextMode:TemporalHistoryMode,before?:TemporalHistoryCursor){
    const request=++generation.current;
    setBusy(true);setError("");
    if(!before){setMode(nextMode);setItems([]);setCursor(null);setLoaded(false);}
    try{
      const db=await localMemoryRepository(profile);
      const page=await db.temporalKnowledgeHistory({
        subjectId,collectionId,mode:nextMode,limit:10,
        ...(before?{before}:{}),
      });
      if(request!==generation.current)return;
      setItems(previous=>before?[...previous,...page.items.filter(row=>
        !previous.some(existing=>existing.claimId===row.claimId))]:page.items);
      setCursor(page.nextCursor);setLoaded(true);
    }catch(e){
      if(request===generation.current)setError(memoryErrorMessage(e));
    }finally{
      if(request===generation.current)setBusy(false);
    }
  }
  async function showSource(item:TemporalHistoryItem){
    if(busy)return;
    const request=++generation.current;
    setBusy(true);setError("");
    try{
      const db=await localMemoryRepository(profile);
      const source=await db.entity(item.claim.evidence.entityId);
      const sections=await db.listCollections();
      const collection=sections.find(c=>c.id===source?.collection_id);
      if(!source||source.record_version!==item.claim.evidence.recordVersion||
        source.record_status!=="active"||source.collection_id!==collectionId||
        !["standard","inherit"].includes(source.sensitivity)||
        collection?.sensitivity!=="standard")
        throw new Error("Источник изменён или недоступен. Обновите список.");
      if(request===generation.current)navigation.push("MemoryNote",{entityId:source.id});
    }catch(e){
      if(request===generation.current)setError(memoryErrorMessage(e));
    }finally{
      if(request===generation.current)setBusy(false);
    }
  }
  const touch={minHeight:nebulaTouch.minimum,borderRadius:nebulaRadii.field,
    padding:nebulaSpacing.md,justifyContent:"center" as const};
  return <View style={{gap:nebulaSpacing.sm}}>
    <Pressable accessibilityRole="button" accessibilityLabel="Периоды и события в памяти"
      accessibilityState={{expanded}} style={{...touch,backgroundColor:t.soft}}
      onPress={()=>{if(expanded){clear();}else{setExpanded(true);void load("all");}}}>
      <Text style={{color:t.text,fontWeight:"700"}}>Периоды и события {expanded?"⌃":"⌄"}</Text>
    </Pressable>
    {expanded?<View style={{gap:nebulaSpacing.sm}}>
      <Text style={{color:t.muted}}>История по источникам. Сведения ещё не подтверждены как текущие факты; дата события может отличаться от даты сохранения.</Text>
      <View style={{flexDirection:"row",flexWrap:"wrap",gap:nebulaSpacing.sm}}>
        {MODES.map(option=><Pressable key={option.mode} accessibilityRole="button"
          accessibilityLabel={"История: "+option.label} accessibilityState={{selected:mode===option.mode,disabled:busy}}
          disabled={busy} style={{...touch,borderWidth:1,borderColor:t.line,backgroundColor:mode===option.mode?t.soft:t.panel}}
          onPress={()=>void load(option.mode)}>
          <Text style={{color:t.text}}>{option.label}</Text>
        </Pressable>)}
      </View>
      {busy?<ActivityIndicator accessibilityLabel="Проверяю источники временной истории" />:null}
      {error?<Text accessibilityRole="alert" style={{color:t.err}}>{error}</Text>:null}
      {loaded&&items.length===0&&!busy?<Text style={{color:t.muted}}>В этом разделе нет доступных сведений для истории.</Text>:null}
      {items.map(item=><View key={item.claimId} style={{padding:nebulaSpacing.md,borderWidth:1,
        borderColor:t.line,borderRadius:nebulaRadii.card,gap:nebulaSpacing.sm}}>
        <Text style={{color:t.text,fontWeight:"700"}}>
          {item.claim.kind==="event"?"Событие":item.claim.kind==="observation"?"Наблюдение":item.claim.kind==="enduring"?"Длительное обстоятельство":"Состояние"} · {item.claim.value}
        </Text>
        <Text style={{color:t.text}}>Время события или состояния: {displayTemporalBound(item.claim.occurredOrStarted)}</Text>
        {item.claim.ended?<Text style={{color:t.muted}}>Конец периода: {displayTemporalBound(item.claim.ended)}
          {item.claim.endConfirmed?" · граница подтверждена пользователем":""}</Text>:null}
        <Text style={{color:t.muted}}>Сведения получены: {new Date(item.claim.recordedAt).toLocaleDateString()}</Text>
        <Text style={{color:t.muted}}>{item.claim.modality==="planned"?"План, не свершившийся факт":
          item.claim.modality==="hypothetical"?"Гипотеза, не факт":
          item.claim.negated?"Отрицательное утверждение источника":"Не подтверждено как текущий факт"}</Text>
        <Text numberOfLines={4} style={{color:t.muted}}>Из источника: «{item.claim.evidence.quote}»</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={"Проверить источник "+item.claimId}
          disabled={busy} style={touch} onPress={()=>void showSource(item)}>
          <Text style={{color:t.secondary}}>Открыть источник</Text>
        </Pressable>
      </View>)}
      {cursor&&!busy?<Pressable accessibilityRole="button" accessibilityLabel="Показать ещё периоды и события"
        onPress={()=>void load(mode,cursor)} style={touch}>
        <Text style={{color:t.secondary}}>Показать ещё</Text>
      </Pressable>:null}
    </View>:null}
  </View>;
}
