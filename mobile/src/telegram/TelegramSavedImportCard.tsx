import React,{useEffect,useRef,useState} from "react";
import {Text,View} from "react-native";
import {NebulaAction} from "../design/nebula/components";
import {nebulaSpacing,nebulaTypography} from "../design/nebula/tokens";
import {useTheme} from "../theme";
import {importSavedTextPage,type SavedTextImportResult} from "./saved-import";

/** Explicit local import, one page at a time. Does not reimplement the note editor. */
export function TelegramSavedImportCard({profile}:{profile:string}){
  const t=useTheme();
  const [cursor,setCursor]=useState("0");
  const [busy,setBusy]=useState(false);
  const [done,setDone]=useState(false);
  const [result,setResult]=useState<SavedTextImportResult|null>(null);
  const [error,setError]=useState("");
  const running=useRef(false),generation=useRef(0);
  useEffect(()=>{
    generation.current++;
    setCursor("0");setDone(false);setResult(null);setError("");
    return()=>{generation.current++;};
  },[profile]);

  async function importPage(){
    if(running.current)return;
    const version=generation.current;
    running.current=true;setBusy(true);setError("");
    try{
      const outcome=await importSavedTextPage(profile,cursor);
      if(generation.current===version){
        setResult(outcome);
        setCursor(outcome.nextCursor||cursor);
        setDone(!outcome.nextCursor || outcome.nextCursor===cursor);
      }
    }catch{
      if(generation.current===version)setError(
        "Не удалось прочитать или сохранить сообщения Telegram. Проверьте соединение и блокировку PersAI.");
    }finally{
      running.current=false;
      if(generation.current===version)setBusy(false);
    }
  }
  return <View style={{gap:nebulaSpacing.sm}}>
    <Text style={{color:t.text,...nebulaTypography.body,fontWeight:"600"}}>
      Импорт «Избранного»
    </Text>
    <Text style={{color:t.muted,...nebulaTypography.label}}>
      Сохраняются только текстовые сообщения и ссылки, по 20 за раз.
      Фото, документы и подписи к ним пока не сохраняются. Записи попадут
      в существующий раздел «Входящие», без отдельной базы.
    </Text>
    <NebulaAction icon="download" label={cursor==="0"?
      "Импортировать последние 20 сообщений":"Продолжить историю (до 20)"}
      disabled={busy||done} onPress={()=>void importPage()}/>
    {cursor!=="0" ? <NebulaAction label="Начать с новых сообщений"
      size="compact" disabled={busy} onPress={()=>{
        setCursor("0");setDone(false);setResult(null);setError("");
      }} />:null}
    {result?<Text accessibilityLiveRegion="polite" style={{color:t.text,...nebulaTypography.label}}>
      Сохранено: {result.saved}; уже были: {result.duplicates};
      медиа пропущено: {result.unsupported}; пустых: {result.empty}.
      {done?" Больше сообщений в этом диапазоне нет.":""}
    </Text>:null}
    {busy?<Text accessibilityLiveRegion="polite" style={{color:t.muted}}>
      Читаю «Избранное» и сохраняю тексты…
    </Text>:null}
    {error?<Text accessibilityRole="alert" style={{color:t.err}}>{error}</Text>:null}
  </View>;
}
