import {requireOptionalNativeModule} from "expo-modules-core";
import {Platform} from "react-native";
import {localMemorySessionUnlocked} from "../local-memory/storage";
import {tdlibAccountState,tdlibAvailable} from "./account";
import {parseSavedMessagesPage,type SavedMessagesPage} from "./saved-messages";

export type TelegramSavedTopic = {
  id:string;kind:"savedMessagesTopicTypeMyNotes"|
  "savedMessagesTopicTypeAuthorHidden"|"savedMessagesTopicTypeChat";
  isPinned:boolean;order:string;
};
type NativeTopics = {
  listSavedMessagesTopics(profile:string):Promise<string>;
  getSavedMessagesTopicPage(profile:string,topicId:string,cursor:string,limit:number):Promise<string>;
};
const native=():NativeTopics|null=>Platform.OS==="android"?
  requireOptionalNativeModule<NativeTopics>("PersaiTelegramTdlib"):null;
export const safeTopicId=(v:unknown):v is string=>
  typeof v==="string" && /^(0|-?[1-9][0-9]{0,15})$/.test(v) &&
  Number.isSafeInteger(Number(v));
const ordered=(v:unknown):v is string=>
  typeof v==="string"&&/^-?(0|[1-9][0-9]{0,18})$/.test(v);
function checkAuth(){
  if(!localMemorySessionUnlocked())throw new Error("telegram_app_locked");
  if(!tdlibAvailable()||tdlibAccountState()!=="authorizationStateReady")
    throw new Error("telegram_account_not_authorized");
}
const validProfile=(profile:string)=>/^(guest|[a-zA-Z0-9_-]{1,120})$/.test(profile);

export function parseSavedTopics(raw:string):TelegramSavedTopic[]{
  if(typeof raw!=="string"||raw.length>50000)throw new Error("telegram_saved_topics_invalid");
  let obj:unknown;
  try{obj=JSON.parse(raw);}catch{throw new Error("telegram_saved_topics_invalid");}
  if(!obj||typeof obj!=="object"||
    !Array.isArray((obj as {topics?:unknown}).topics) ||
    (obj as {topics:unknown[]}).topics.length>100)
    throw new Error("telegram_saved_topics_invalid");
  const output:TelegramSavedTopic[]=[];const seen=new Set<string>();
  for(const value of (obj as {topics:unknown[]}).topics){
    if(!value||typeof value!=="object")throw new Error("telegram_saved_topic_invalid");
    const topic=value as Partial<TelegramSavedTopic>;
    if(!safeTopicId(topic.id)||seen.has(topic.id)||
       !["savedMessagesTopicTypeMyNotes","savedMessagesTopicTypeAuthorHidden",
        "savedMessagesTopicTypeChat"].includes(topic.kind||"")||
       typeof topic.isPinned!=="boolean"||!ordered(topic.order))
      throw new Error("telegram_saved_topic_invalid");
    seen.add(topic.id);
    output.push({id:topic.id,kind:topic.kind!,isPinned:topic.isPinned,order:topic.order!});
  }
  return output;
}

/** No generic chat ID. Topic ID was received by native TDLib; no remote LLM. */
export async function listSavedTopics(profile:string):Promise<TelegramSavedTopic[]>{
  if(!validProfile(profile))throw new Error("telegram_saved_profile_invalid");
  checkAuth();
  const module=native();if(!module?.listSavedMessagesTopics)
    throw new Error("telegram_saved_topic_reader_missing");
  const raw=await module.listSavedMessagesTopics(profile);
  checkAuth();
  return parseSavedTopics(raw);
}

export async function readSavedTopicPage(profile:string,topicId:string,cursor="0",limit=20):
  Promise<SavedMessagesPage>{
  if(!validProfile(profile)||!safeTopicId(topicId))
    throw new Error("telegram_saved_topic_request_invalid");
  checkAuth();
  const module=native();if(!module?.getSavedMessagesTopicPage)
    throw new Error("telegram_saved_topic_reader_missing");
  const raw=await module.getSavedMessagesTopicPage(profile,topicId,cursor,limit);
  checkAuth();
  let embedded:unknown;
  try{embedded=JSON.parse(raw);}catch{throw new Error("telegram_saved_topic_page_invalid");}
  if(!embedded||typeof embedded!=="object"||
    (embedded as {topicId?:unknown}).topicId!==topicId)
    throw new Error("telegram_saved_topic_source_mismatch");
  return parseSavedMessagesPage(raw,cursor,limit);
}
