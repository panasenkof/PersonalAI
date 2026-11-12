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
import {importEntireSavedHistory,savedHistoryFailure} from "./full-history";
import {loadSavedHistoryCheckpoint,type SavedHistoryCheckpoint} from "./settings";

/** Explicit local import, one page at a time. Does not reimplement the note editor. */
export function TelegramSavedImportCard({profile}:{profile:string}){
  const t=useTheme();
  const [cursor,setCursor]=useState("0");
  const [busy,setBusy]=useState(false);
  const [done,setDone]=useState(false);
  const [result,setResult]=useState<SavedTextImportResult|null>(null);
  const [error,setError]=useState("");
  const [cancelRequested,setCancelRequested]=useState(false);
  const [fullRunning,setFullRunning]=useState(false);
  const [historyCheckpoint,setHistoryCheckpoint]=useState<SavedHistoryCheckpoint|null>(null);
  const [historyProgress,setHistoryProgress]=useState<SavedHistoryCheckpoint|null>(null);
  const [historyStatus,setHistoryStatus]=useState("");
  const [historyLoaded,setHistoryLoaded]=useState(false);
  const [topics,setTopics]=useState<TelegramSavedTopic[]|null>(null);
  const [selectedTopic,setSelectedTopic]=useState<TelegramSavedTopic|null>(null);
  const running=useRef(false),generation=useRef(0);
  const activeImport=useRef<AbortController|null>(null);
  useEffect(()=>{
    // A profile switch must not inherit another profile's busy UI or worker.
    // Its in-flight request is aborted; a late settlement must not touch the
    // new profile's running flag or UI state.
    const version=++generation.current;
    activeImport.current?.abort();
    activeImport.current=null;
    running.current=false;
    setBusy(false);setCancelRequested(false);
    setCursor("0");setDone(false);setResult(null);setError("");
    setFullRunning(false);setHistoryCheckpoint(null);setHistoryProgress(null);
    setHistoryStatus("");setHistoryLoaded(false);
    void loadSavedHistoryCheckpoint(profile).then(checkpoint=>{
      if(generation.current===version){setHistoryCheckpoint(checkpoint);setHistoryLoaded(true);}
    }).catch(()=>{
      if(generation.current===version){setHistoryLoaded(true);setError("Не удалось прочитать позицию импорта Telegram.");}
    });
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
  async function importFullHistory(resume:boolean){
    if(running.current||!historyLoaded)return;
    const version=generation.current;
    const request=new AbortController();
    activeImport.current=request;
    running.current=true;setBusy(true);setFullRunning(true);
    setError("");setCancelRequested(false);setHistoryStatus("");
    try{
      const target=await loadTelegramTargetForWrite(profile,"saved");
      if(request.signal.aborted)throw new Error("telegram_saved_import_cancelled");
      const outcome=await importEntireSavedHistory(profile,selectedTopic?.id,target,
        request.signal,progress=>{
          if(generation.current===version&&!request.signal.aborted){
            setHistoryProgress(progress);setHistoryCheckpoint(progress);
          }
        },resume);
      if(generation.current===version){
        setHistoryProgress(outcome.progress);
        setHistoryCheckpoint(outcome.status==="completed"?null:outcome.progress);
        setHistoryStatus(outcome.status==="completed"?"История импортирована полностью.":
          outcome.status==="pending_album"?
          "Незавершённый альбом ожидает следующих сообщений. Прогресс сохранён; повторите позже.":
          "Telegram не отдал следующую страницу. Позиция сохранена; попробуйте продолжить позже.");
      }
    }catch(e){
      if(generation.current===version){
        setHistoryStatus(request.signal.aborted?
          "Импорт остановлен. Сохранённые заметки остаются; можно продолжить с контрольной точки.":"");
        if(!request.signal.aborted)setError(savedHistoryFailure(e));
        // The saved checkpoint is the authority, not an uncommitted UI cursor.
        try{
          const checkpoint=await loadSavedHistoryCheckpoint(profile);
          if(generation.current===version&&checkpoint)setHistoryCheckpoint(checkpoint);
        }catch{/* AppLock may have hidden device-only settings. */}
      }
    }finally{
      if(activeImport.current===request){
        running.current=false;activeImport.current=null;
        if(generation.current===version){
          setBusy(false);setFullRunning(false);setCancelRequested(false);
        }
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
      остаётся текстовой. По умолчанию используется закрытый раздел «Входящие»; его можно поменять ниже.
    </Text>
    <Text style={{color:t.muted,...nebulaTypography.label}}>
      Сообщения, пропущенные раньше как медиа, можно догрузить: начните импорт с новых
      сообщений и продолжайте историю — уже сохранённое не повторится и не скачивается заново.
    </Text>
    <TelegramImportTargetPicker profile={profile} channel="saved" disabled={busy}/>
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
    <NebulaAction icon="layers" label="Импортировать всю историю"
      disabled={busy||!historyLoaded} onPress={()=>void importFullHistory(false)}/>
    {historyCheckpoint&&historyCheckpoint.topicId===(selectedTopic?.id||"")?
      <NebulaAction icon="play" label="Продолжить с места остановки"
        disabled={busy||!historyLoaded} onPress={()=>void importFullHistory(true)}/>:null}
    {historyProgress||historyCheckpoint?
      <Text accessibilityLiveRegion="polite" style={{color:t.text,...nebulaTypography.label}}>
        Обработано записей (альбом — одна запись): {(historyProgress||historyCheckpoint)!.processed};
        сохранено: {(historyProgress||historyCheckpoint)!.saved};
        уже были: {(historyProgress||historyCheckpoint)!.duplicates};
        пропущено: {(historyProgress||historyCheckpoint)!.unsupported};
        страниц: {(historyProgress||historyCheckpoint)!.pages}.
      </Text>:null}
    {historyStatus?<Text accessibilityLiveRegion="polite" style={{color:t.muted,...nebulaTypography.label}}>
      {historyStatus}
    </Text>:null}
    <NebulaAction icon="download" label={cursor==="0"?
      "Импортировать последние 20 сообщений":"Продолжить историю (до 20)"}
      disabled={busy||done} onPress={()=>void importPage()}/>
    {cursor!=="0" ? <NebulaAction label="Начать с новых сообщений"
      size="compact" disabled={busy} onPress={()=>{
        setCursor("0");setDone(false);setResult(null);setError("");
      }} />:null}
    {result?<Text accessibilityLiveRegion="polite" style={{color:t.text,...nebulaTypography.label}}>
      Сохранено: {result.saved} (с файлами: {result.withFiles}); уже были: {result.duplicates};
      пропущено: {result.unsupported}, из них слишком больших: {result.tooLarge}; пустых: {result.empty}.
      {result.pendingAlbum?" Альбом из "+result.pendingAlbum+" элементов ожидает завершения. Повторите импорт позже — эти файлы не пропущены.":""}
      {done?" Больше сообщений в этом диапазоне нет.":""}
    </Text>:null}
    {busy?<View style={{gap:nebulaSpacing.xs}}>
      <Text accessibilityLiveRegion="polite" style={{color:t.muted}}>
        {cancelRequested
          ? "Останавливаю после текущего запроса TDLib…"
          : fullRunning
          ? "Импортирую историю с сохранением позиции после каждой страницы…"
          : "Читаю «Избранное» и сохраняю оригиналы…"}
      </Text>
      {!cancelRequested?<NebulaAction icon="x" size="compact"
        label={fullRunning?"Остановить":"Отменить импорт Telegram"} onPress={()=>{
          activeImport.current?.abort();
          setCancelRequested(true);
        }}/>:null}
    </View>:null}
    {error?<Text accessibilityRole="alert" style={{color:t.err}}>{error}</Text>:null}
  </View>;
}
