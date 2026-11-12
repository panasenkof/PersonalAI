import React,{useEffect,useState} from "react";
import {Text,View} from "react-native";
import {NebulaAction} from "../design/nebula/components";
import {nebulaSpacing,nebulaTypography} from "../design/nebula/tokens";
import {useTheme} from "../theme";
import {
  chooseTelegramImportTarget,loadTelegramImportTarget,telegramTargetOptions,
  type TelegramTargetOption,
} from "./import-target";
import type {TelegramImportChannel} from "./settings";

export function TelegramImportTargetPicker({profile,channel}:{
 profile:string;channel:TelegramImportChannel;
}){
 const t=useTheme();
 const [current,setCurrent]=useState(""),[options,setOptions]=useState<TelegramTargetOption[]>([]);
 const [choosing,setChoosing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 useEffect(()=>{
   let live=true;
   setCurrent("");setChoosing(false);setOptions([]);setError("");
   void Promise.all([loadTelegramImportTarget(profile,channel),telegramTargetOptions(profile)])
     .then(([target,all])=>{
       if(live){setCurrent(target?.collectionId||"");setOptions(all);}
     }).catch(()=>{if(live)setError("Не удалось прочитать выбранный раздел.");});
   return()=>{live=false;};
 },[profile,channel]);
 const name=options.find(o=>o.id===current)?.name||"Входящие (закрыто от помощника)";
 async function open(){
   setBusy(true);setError("");
   try{
     const next=await telegramTargetOptions(profile);
     setOptions(next);setChoosing(true);
   }catch{setError("Не удалось прочитать доступные разделы.");}
   finally{setBusy(false);}
 }
 async function choose(id:string){
   setBusy(true);setError("");
   try{
     await chooseTelegramImportTarget(profile,channel,id);
     setCurrent(id);setChoosing(false);
   }catch{setError("Раздел больше недоступен. Повторите выбор.");}
   finally{setBusy(false);}
 }
 return <View style={{gap:nebulaSpacing.xs}}>
   <Text style={{color:t.text,...nebulaTypography.label}}>
     Куда сохранять: {name}
   </Text>
   {current?<Text style={{color:t.muted,...nebulaTypography.label}}>
     Записи из этого раздела помощник может передавать выбранной модели при ответе.
   </Text>:null}
   <NebulaAction label={choosing?"Скрыть разделы":"Изменить"} size="compact" disabled={busy}
     onPress={()=>choosing?setChoosing(false):void open()}/>
   {choosing?<View style={{gap:nebulaSpacing.xs}}>
     <NebulaAction label={(current===""?"● ":"○ ")+"Входящие (закрыто от помощника)"}
       size="compact" disabled={busy} onPress={()=>void choose("")}/>
     {options.map(o=><NebulaAction key={o.id} size="compact"
       label={(current===o.id?"● ":"○ ")+o.name}
       disabled={busy} onPress={()=>void choose(o.id)}/>)}
   </View>:null}
   {error?<Text accessibilityRole="alert" style={{color:t.err}}>{error}</Text>:null}
 </View>;
}
