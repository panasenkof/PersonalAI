import React,{useEffect,useRef,useState} from "react";
import {Text,View} from "react-native";
import {NebulaAction} from "../design/nebula/components";
import {nebulaSpacing,nebulaTypography} from "../design/nebula/tokens";
import {useTheme} from "../theme";
import {onLocalMemorySessionChange} from "../local-memory/storage";
import {importSavedTextPage,type SavedTextImportResult} from "./saved-import";
import {listSavedTopics,type TelegramSavedTopic} from "./saved-topics";
import {TelegramImportTargetPicker} from "./TelegramImportTargetPicker";
import {loadTelegramTargetForWrite} from "./import-target";

/** Explicit local import, one page at a time. Does not reimplement the note editor. */
export function TelegramSavedImportCard({profile}:{profile:string}){
  const t=useTheme();
  const [cursor,setCursor]=useState("0");
  const [busy,setBusy]=useState(false);
  const [done,setDone]=useState(false);
  const [result,setResult]=useState<SavedTextImportResult|null>(null);
  const [error,setError]=useState("");
  const [cancelRequested,setCancelRequested]=useState(false);
  const [topics,setTopics]=useState<TelegramSavedTopic[]|null>(null);
  const [selectedTopic,setSelectedTopic]=useState<TelegramSavedTopic|null>(null);
  const running=useRef(false),generation=useRef(0);
  const activeImport=useRef<AbortController|null>(null);
  useEffect(()=>{
    // A profile switch must not inherit another profile's busy UI or worker.
    // Its in-flight request is aborted; a late settlement must not touch the
    // new profile's running flag or UI state.
    generation.current++;
    activeImport.current?.abort();
    activeImport.current=null;
    running.current=false;
    setBusy(false);setCancelRequested(false);
    setCursor("0");setDone(false);setResult(null);setError("");
    setTopics(null);setSelectedTopic(null);
    return()=>{
      generation.current++;
      activeImport.current?.abort();
      activeImport.current=null;
      running.current=false;
    };
  },[profile]);
  useEffect(()=>onLocalMemorySessionChange(unlocked=>{
    if(!unlocked)activeImport.current?.abort();
  }),[]);

  async function importPage(){
    if(running.current)return;
    const version=generation.current;
    const request=new AbortController();
    activeImport.current=request;
    running.current=true;setBusy(true);setError("");setCancelRequested(false);
    try{
      const target=await loadTelegramTargetForWrite(profile,"saved");
      const outcome=selectedTopic
        ? await importSavedTextPage(profile,cursor,request.signal,selectedTopic.id,"supported-originals",target)
        : await importSavedTextPage(profile,cursor,request.signal,undefined,"supported-originals",target);
      if(generation.current===version){
        setResult(outcome);
        setCursor(outcome.nextCursor||cursor);
        setDone(!outcome.pendingAlbum && (!outcome.nextCursor || outcome.nextCursor===cursor));
      }
    }catch{
      if(generation.current===version)setError(request.signal.aborted
        ? "Импорт Telegram отменён. Курсор истории не изменён; сохранённые ранее записи остаются."
        : "Не удалось прочитать или сохранить сообщения Telegram. Проверьте соединение и блокировку PersAI.");
    }finally{
      if(activeImport.current===request){
        running.current=false;
        activeImport.current=null;
        if(generation.current===version){setBusy(false);setCancelRequested(false);}
      }
    }
  }
  async function showTopics(){
    if(running.current)return;
    running.current=true;setBusy(true);setError("");
    const version=generation.current;
    try{
      const result=await listSavedTopics(profile);
      if(generation.current===version)setTopics(result);
    }catch{
      if(generation.current===version)setError(
        "Не удалось получить подборки Telegram. Проверьте вход и попробуйте ещё раз.");
    }finally{
      running.current=false;
      if(generation.current===version)setBusy(false);
    }
  }
  function chooseTopic(value:TelegramSavedTopic|null){
    if(running.current)return;
    setSelectedTopic(value);setCursor("0");setDone(false);setResult(null);setError("");
  }
  const topicLabel=(topic:TelegramSavedTopic)=>
    topic.kind==="savedMessagesTopicTypeMyNotes"?"Мои заметки":
    topic.kind==="savedMessagesTopicTypeAuthorHidden"?"Автор скрыт":
    topic.title?.trim()||"Чат без названия";
  return <View style={{gap:nebulaSpacing.sm}}>
    <Text style={{color:t.text,...nebulaTypography.body,fontWeight:"600"}}>
      Импорт «Избранного»
    </Text>
    <Text style={{color:t.muted,...nebulaTypography.label}}>
      Вручную импортируются тексты, одиночные оригиналы и завершённые альбомы
      (фото, PDF, аудио и видео) с подписями. Обычно до 20 сообщений за запрос;
      на границе альбома возможна ограниченная дочитка истории.
      Незавершённый альбом не сохраняется частично. Автозагрузка при запуске
      остаётся текстовой. Записи попадают в раздел «Входящие» без отдельной базы.
    </Text>
    <TelegramImportTargetPicker profile={profile} channel="saved"/>
    <Text style={{color:t.muted,...nebulaTypography.label}}>
      {selectedTopic?"Источник: "+topicLabel(selectedTopic):
        "Источник: все сообщения «Избранного»."}
    </Text>
    <NebulaAction icon="layers" label={topics===null?"Показать подборки":"Загрузить ещё подборки"}
      disabled={busy} onPress={()=>void showTopics()}/>
    {topics!==null?<View style={{gap:nebulaSpacing.xs}}>
      <Text style={{color:t.muted,...nebulaTypography.label}}>
        Telegram группирует пересылки по источнику — это не разделы PersAI.
        {topics.length===0?" Список пока пуст. Если синхронизация только началась, обновите его ещё раз.":""}
      </Text>
      <NebulaAction icon="list" size="compact" label={(selectedTopic===null?"● ":"○ ")+"Все сообщения «Избранного»" }
        disabled={busy} onPress={()=>chooseTopic(null)}/>
      <Text style={{color:t.muted,...nebulaTypography.label}}>
        Telegram отдаёт подборки частями по 20.
      </Text>
      {topics.map(topic=><NebulaAction key={topic.id} size="compact" icon="folder"
        label={(selectedTopic?.id===topic.id?"● ":"○ ")+topicLabel(topic)} disabled={busy} onPress={()=>chooseTopic(topic)}/>)}
    </View>:null}
    <NebulaAction icon="download" label={cursor==="0"?
      "Импортировать последние 20 сообщений":"Продолжить историю (до 20)"}
      disabled={busy||done} onPress={()=>void importPage()}/>
    {cursor!=="0" ? <NebulaAction label="Начать с новых сообщений"
      size="compact" disabled={busy} onPress={()=>{
        setCursor("0");setDone(false);setResult(null);setError("");
      }} />:null}
    {result?<Text accessibilityLiveRegion="polite" style={{color:t.text,...nebulaTypography.label}}>
      Сохранено: {result.saved}; уже были: {result.duplicates};
      неподдержанных: {result.unsupported}; пустых: {result.empty}.
      {result.pendingAlbum?" Альбом из "+result.pendingAlbum+" элементов ожидает завершения. Повторите импорт позже — эти файлы не пропущены.":""}
      {done?" Больше сообщений в этом диапазоне нет.":""}
    </Text>:null}
    {busy?<View style={{gap:nebulaSpacing.xs}}>
      <Text accessibilityLiveRegion="polite" style={{color:t.muted}}>
        {cancelRequested
          ? "Отменяю импорт после завершения текущего запроса TDLib…"
          : "Читаю «Избранное» и сохраняю оригиналы…"}
      </Text>
      {!cancelRequested?<NebulaAction icon="x" size="compact"
        label="Отменить импорт Telegram" onPress={()=>{
          activeImport.current?.abort();
          setCancelRequested(true);
        }}/>:null}
    </View>:null}
    {error?<Text accessibilityRole="alert" style={{color:t.err}}>{error}</Text>:null}
  </View>;
}
