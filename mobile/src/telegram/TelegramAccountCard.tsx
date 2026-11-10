import React,{useEffect,useRef,useState} from "react";
import {Text,TextInput,View} from "react-native";
import {NebulaAction} from "../design/nebula/components";
import {nebulaRadii,nebulaSpacing,nebulaTypography} from "../design/nebula/tokens";
import {useTheme} from "../theme";
import {onLocalMemorySessionChange} from "../local-memory/storage";
import {
  tdlibAvailable,tdlibAccountState,observeTelegramAccountState,
  initializeTelegramAccount,completeTelegramAuthorization,logOutTelegramAccount,
  type TelegramAccountState,
} from "./account";

type Step="phone"|"code"|"password"|"email"|"emailCode";
const stepFor=(state:TelegramAccountState):Step|null=>{
  switch(state){
    case "authorizationStateWaitPhoneNumber":return "phone";
    case "authorizationStateWaitCode":return "code";
    case "authorizationStateWaitPassword":return "password";
    case "authorizationStateWaitEmailAddress":return "email";
    case "authorizationStateWaitEmailCode":return "emailCode";
    default:return null;
  }
};
const labelFor:Record<Step,string>={
  phone:"Телефон с кодом страны",
  code:"Код подтверждения Telegram",
  password:"Пароль двухэтапной защиты",
  email:"Адрес электронной почты",
  emailCode:"Код из электронной почты",
};
const explanation=(state:TelegramAccountState):string=>{
  switch(state){
    case "authorizationStateReady":return "Telegram подтвердил авторизацию аккаунта.";
    case "authorizationStateWaitTdlibParameters":case "starting":
      return "TDLib устанавливает защищённое соединение.";
    case "authorizationStateWaitOtherDeviceConfirmation":
      return "Подтвердите вход на другом устройстве Telegram.";
    case "authorizationStateWaitRegistration":
      return "Регистрация нового аккаунта здесь недоступна. Сначала завершите её в официальном Telegram.";
    case "authorizationStateWaitPremiumPurchase":
      return "Telegram запросил дополнительную проверку. Продолжите в официальном клиенте.";
    case "authorizationStateLoggingOut":case "authorizationStateClosing":
      return "Telegram завершает сеанс.";
    case "authorizationStateClosed":case "offline":
      return "Аккаунт Telegram ещё не подключён.";
    case "tdlib_runtime_error":case "unsupported_state":
      return "TDLib вернула ошибку или неизвестное состояние. Проверьте подключение.";
    default:return "Telegram ожидает данные для входа.";
  }
};

/** No fake 'connected' state; native updateAuthorizationState is authoritative. */
export function TelegramAccountCard({profile,apiConfigured}:{
  profile:string;apiConfigured:boolean;
}){
  const t=useTheme();
  const [nativeAvailable,setNativeAvailable]=useState(false);
  const [state,setState]=useState<TelegramAccountState>("offline");
  const [value,setValue]=useState("");
  const [saving,setSaving]=useState(false),[confirmLogout,setConfirmLogout]=useState(false);
  const [error,setError]=useState(""),[notice,setNotice]=useState("");
  const running=useRef(false),version=useRef(0);
  useEffect(()=>{
    const current=++version.current;
    const supported=tdlibAvailable();
    setNativeAvailable(supported);setState(tdlibAccountState());
    setValue("");setError("");setNotice("");
    const unsubscribe=observeTelegramAccountState(next=>{
      if(current===version.current){setState(next);setValue("");setError("");}
    });
    const lock=onLocalMemorySessionChange(unlocked=>{
      if(!unlocked && current===version.current){setValue("");setConfirmLogout(false);}
    });
    return()=>{version.current++;unsubscribe();lock();};
  },[profile]);
  async function run(action:()=>Promise<TelegramAccountState>,message:string){
    if(running.current)return;
    const current=version.current;
    running.current=true;setSaving(true);setError("");setNotice("");
    try{
      const next=await action();
      if(version.current===current){setState(next);setNotice(message);}
    }catch{
      if(version.current===current)setError("Операция Telegram не выполнена. Проверьте данные и состояние соединения.");
    }finally{
      running.current=false;
      if(version.current===current){setSaving(false);setValue("");}
    }
  }
  const step=stepFor(state);
  const password=step==="password";
  const secret=step==="code"||step==="password"||step==="emailCode";
  const fieldStyle={minHeight:48,borderWidth:1,borderColor:t.line,
    backgroundColor:t.panel,borderRadius:nebulaRadii.field,
    paddingHorizontal:nebulaSpacing.md,color:t.text};
  return <View style={{gap:nebulaSpacing.sm}}>
    {!nativeAvailable ? <Text accessibilityRole="alert"
      style={{color:t.muted,...nebulaTypography.label}}>
      TDLib ещё не включена в этот APK. Аккаунт нельзя подключить, пока
      не пройдёт проверенная нативная сборка. Резервный бот работает отдельно.
    </Text> : <>
      <Text accessibilityLiveRegion="polite" style={{color:t.text,...nebulaTypography.label}}>
        {explanation(state)}
      </Text>
      {state==="offline"||state==="authorizationStateClosed"||
       state==="tdlib_runtime_error"||state==="unsupported_state"
        ? <NebulaAction icon="log-in" label="Подключить аккаунт Telegram"
            disabled={saving||!apiConfigured}
            onPress={()=>void run(()=>initializeTelegramAccount(profile),"Запрос на авторизацию отправлен.")}/>
        : null}
      {!apiConfigured?<Text style={{color:t.muted,...nebulaTypography.label}}>
        Сначала сохраните API ID и API hash выше.
      </Text>:null}
      {step?<View style={{gap:nebulaSpacing.sm}}>
        <Text style={{color:t.text,...nebulaTypography.label}}>{labelFor[step]}</Text>
        <TextInput accessibilityLabel={labelFor[step]} value={value}
          onChangeText={setValue} editable={!saving}
          keyboardType={step==="phone"?"phone-pad":step==="email"?"email-address":
            step==="password"||step==="emailCode"?"default":"number-pad"}
          secureTextEntry={secret} autoCapitalize="none" autoCorrect={false}
          maxLength={password?256:step==="email"?254:32}
          placeholder={labelFor[step]} placeholderTextColor={t.muted} style={fieldStyle}/>
        <NebulaAction icon="check" label="Продолжить вход"
          disabled={saving||!value.trim()}
          onPress={()=>void run(()=>completeTelegramAuthorization(step,value),"Данные отправлены в Telegram.")}/>
      </View>:null}
      {state==="authorizationStateReady" ? <>
        {!confirmLogout?<NebulaAction icon="log-out" variant="danger"
          label="Выйти из аккаунта Telegram"
          disabled={saving} onPress={()=>setConfirmLogout(true)}/>
        : <>
          <Text style={{color:t.muted,...nebulaTypography.label}}>
            Это завершит текущую сессию Telegram в PersAI. Заметки сохранятся.
          </Text>
          <NebulaAction icon="log-out" variant="danger" label="Подтвердить выход из Telegram"
            disabled={saving} onPress={()=>void run(async()=>{
              const next=await logOutTelegramAccount();setConfirmLogout(false);return next;
            },"Запрос на выход отправлен Telegram.")}/>
          <NebulaAction label="Отмена" disabled={saving} onPress={()=>setConfirmLogout(false)}/>
        </>}
      </>:null}
    </>}
    {saving?<Text accessibilityLiveRegion="polite" style={{color:t.muted}}>
      Обрабатываю запрос Telegram…
    </Text>:null}
    {error?<Text accessibilityRole="alert" style={{color:t.err}}>{error}</Text>:null}
    {notice?<Text accessibilityLiveRegion="polite" style={{color:t.ok}}>{notice}</Text>:null}
  </View>;
}
