import React,{useEffect,useRef,useState} from "react";
import {Text,TextInput,View} from "react-native";
import {NebulaAction} from "../design/nebula/components";
import {nebulaRadii,nebulaSpacing,nebulaTypography} from "../design/nebula/tokens";
import {useTheme} from "../theme";
import {listBotPairCandidates,verifyTelegramBot,type BotPairCandidate} from "./bot-api";
import {
  clearTelegramBot,inspectTelegramBot,loadTelegramBotConfig,
  pairTelegramBot,saveVerifiedBot,
} from "./bot-settings";
import {syncTelegramBotText} from "./bot-sync";

/** Explicit pairing and text-only import; no bot token, message or chat history in UI logs. */
export function TelegramBotCard({profile}:{profile:string}){
  const theme=useTheme();
  const [token,setToken]=useState("");
  const [username,setUsername]=useState<string|null>(null);
  const [paired,setPaired]=useState(false);
  const [candidates,setCandidates]=useState<BotPairCandidate[]>([]);
  const [busy,setBusy]=useState(false),[loaded,setLoaded]=useState(false);
  const [error,setError]=useState(""),[notice,setNotice]=useState("");
  const current=useRef(0),running=useRef(false);
  const activeRequest=useRef<AbortController|null>(null);
  useEffect(()=>{
    const version=++current.current;
    setToken("");setError("");setNotice("");setLoaded(false);setCandidates([]);
    void inspectTelegramBot(profile).then(x=>{
      if(version!==current.current)return;
      setUsername(x.username);setPaired(x.paired);
    }).catch(()=>{
      if(version===current.current)setError("Не удалось прочитать настройки бота.");
    }).finally(()=>{if(version===current.current)setLoaded(true);});
    return()=>{current.current++;activeRequest.current?.abort();};
  },[profile]);

  async function action(f:(version:number,signal:AbortSignal)=>Promise<void>){
    if(!loaded||running.current)return;
    const version=current.current;
    const request=new AbortController();
    activeRequest.current=request;
    running.current=true;setBusy(true);setError("");setNotice("");
    try{await f(version,request.signal);}
    catch(e){if(version===current.current)setError(
      e instanceof Error && e.message.length<240 &&
      /^(Telegram|Запрос Telegram|Не удалось|У бота|Укажите|Некорректн|Сначала|В очереди|Есть отредактированное|Сообщение Telegram|Разблокируйте)/.test(e.message)
      ? e.message : "Не удалось выполнить операцию Telegram. Повторите попытку.");}
    finally{running.current=false;if(activeRequest.current===request)activeRequest.current=null;
      if(version===current.current)setBusy(false);}
  }
  function connect(){void action(async(version,signal)=>{
    const id=await verifyTelegramBot(token,signal);
    if(signal.aborted)return;
    await saveVerifiedBot(profile,token,id);
    if(version===current.current){
      setToken("");setUsername(id.username);setPaired(false);setCandidates([]);
      setNotice("Бот проверен. Отправьте /start в его личный чат и подтвердите свой чат ниже.");
    }
  });}
  function findChats(){void action(async(version,signal)=>{
    const saved=await loadTelegramBotConfig(profile);
    if(!saved)throw new Error("Сначала сохраните и проверьте токен бота.");
    const items=await listBotPairCandidates(saved.token,signal);
    if(signal.aborted)return;
    if(version===current.current){
      setCandidates(items);
      setNotice(items.length ? "Выберите именно свой личный чат." :
        "Пока нет сообщений. Отправьте боту /start в Telegram и повторите.");
    }
  });}
  function confirm(chatId:string){void action(async(version)=>{
    const saved=await loadTelegramBotConfig(profile);
    if(!saved)throw new Error("Бот больше не подключён.");
    await pairTelegramBot(profile,saved.botId,chatId);
    if(version===current.current){
      setPaired(true);setCandidates([]);
      setNotice("Личный чат подтверждён. Теперь можно импортировать сообщения.");
    }
  });}
  function sync(){void action(async(version,signal)=>{
    const result=await syncTelegramBotText(profile,signal);
    if(signal.aborted)return;
    if(version===current.current)setNotice(
      "Импортировано: "+result.imported+"; пропущено: "+result.skipped+
      ". Одиночные поддерживаемые файлы сохраняются; альбомы требуют отдельной обработки.");
  });}
  function disconnect(){void action(async(version)=>{
    await clearTelegramBot(profile);
    if(version===current.current){
      setUsername(null);setPaired(false);setCandidates([]);setToken("");
      setNotice("Бот отключён в PersAI. Сам бот в Telegram не удалён.");
    }
  });}
  const disabled=!loaded||busy;
  const input={borderWidth:1,borderColor:theme.line,borderRadius:nebulaRadii.field,
    backgroundColor:theme.panel,color:theme.text,minHeight:48,paddingHorizontal:nebulaSpacing.md};
  return <View style={{gap:nebulaSpacing.sm}}>
    <Text style={{color:theme.muted,...nebulaTypography.label}}>
      Резервный личный бот без сервера: только сообщения и поддерживаемые одиночные файлы, которые вы отправите ему. Альбомы пока ожидают отдельной обработки.
      Используйте отдельного бота без webhook и без другого getUpdates-клиента.
      Обновления на сервере Telegram доступны не более 24 часов.
    </Text>
    {username ? <>
      <Text style={{color:theme.text,...nebulaTypography.body}}>
        Бот: @{username} · {paired?"личный чат подтверждён":"чат не подтверждён"}
      </Text>
      {!paired ? <>
        <NebulaAction icon="search" label="Найти мой чат после /start"
          disabled={disabled} onPress={findChats}/>
        {candidates.map(x=><View key={x.chatId} style={{gap:nebulaSpacing.xs}}>
          <Text style={{color:theme.text,...nebulaTypography.label}}>
            {x.label} · ID {x.chatId}
          </Text>
          <NebulaAction icon="check" label={"Подтвердить чат "+x.chatId} disabled={disabled}
            onPress={()=>confirm(x.chatId)}/>
        </View>)}
      </> : <NebulaAction icon="download" label="Импортировать новые сообщения бота"
        disabled={disabled} onPress={sync}/>}
      <NebulaAction icon="trash-2" label="Отключить бота" variant="danger"
        disabled={disabled} onPress={disconnect}/>
    </> : <>
      <TextInput accessibilityLabel="Telegram Bot Token" secureTextEntry
        autoCapitalize="none" autoCorrect={false}
        placeholder="Токен личного Telegram-бота" placeholderTextColor={theme.muted}
        editable={!disabled} value={token} onChangeText={setToken} style={input}/>
      <NebulaAction icon="shield" label="Проверить и сохранить бота"
        disabled={disabled||!token.trim()} onPress={connect}/>
    </>}
    {busy?<NebulaAction icon="x" label="Отменить операцию Telegram"
      onPress={()=>activeRequest.current?.abort()}/>:null}
    {!loaded||busy?<Text accessibilityLiveRegion="polite" style={{color:theme.muted}}>
      {busy?"Обрабатываю…":"Загружаю настройки бота…"}
    </Text>:null}
    {error?<Text accessibilityRole="alert" style={{color:theme.err}}>{error}</Text>:null}
    {notice?<Text accessibilityLiveRegion="polite" style={{color:theme.ok}}>{notice}</Text>:null}
  </View>;
}
