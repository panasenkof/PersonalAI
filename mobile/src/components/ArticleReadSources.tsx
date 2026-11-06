import Feather from "@expo/vector-icons/Feather";
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ChatArticleReadReport } from "../direct-agent/conversations";
import { articleCitationCounts } from "../direct-agent/article-citations";
import { nebulaTouch } from "../design/nebula/tokens";
import { useTheme } from "../theme";

const summaryText=(r:ChatArticleReadReport)=>{
  const count=(status:string)=>r.entries.filter(e=>e.status===status).length;
  const done=count("complete_saved_note_text");
  const partial=count("partial_saved_note");
  const unread=count("unread");
  const other=count("link_only")+count("empty_saved_note")+count("not_available_or_stale");
  return `Отобрано ${r.selectedCount} · весь текст ${done} · часть ${partial} · не прочитано ${unread}` +
    (other ? ` · прочее ${other}` : "");
};
const entryStatus=(e:ChatArticleReadReport["entries"][number])=>{
  switch(e.status){
    case "complete_saved_note_text":return "Прочитан весь сохранённый текст";
    case "partial_saved_note":return `Часть текста: ${e.verifiedChars} из ${e.totalChars ?? "?"} символов`;
    case "link_only":return "Только ссылка, текст статьи не прочитан";
    case "empty_saved_note":return "Сохранённый текст пуст";
    case "not_available_or_stale":return "Недоступно или версия изменилась";
    case "unread":return "Не прочитано";
  }
};

/** Read-only historical provenance beneath one answer. Opening uses canonical
 * MemoryNote navigation and rechecks the source's access at that time. */
export function ArticleReadSources({report,answerText,onOpen}:{
  report:ChatArticleReadReport;answerText:string;onOpen:(id:string)=>void;
}){
  const t=useTheme();
  const [open,setOpen]=useState(false);
  const cited=articleCitationCounts(answerText,report);
  return <View style={{borderWidth:1,borderColor:t.line,borderRadius:14,
    backgroundColor:t.soft,paddingHorizontal:12,paddingVertical:6,gap:4}}>
    <Pressable accessibilityRole="button" accessibilityLabel={
      (open?"Свернуть":"Показать")+" проверку прочитанных материалов"}
      accessibilityState={{expanded:open}}
      onPress={()=>setOpen(value=>!value)}
      style={{minHeight:nebulaTouch.minimum,flexDirection:"row",alignItems:"center",gap:10}}>
      <Feather name="book-open" size={18} color={t.accent}/>
      <View style={{flex:1,gap:3,minWidth:0}}>
        <Text style={{color:t.text,fontWeight:"600"}}>Источники выжимки</Text>
        <Text style={{color:t.muted,fontSize:12}}>{summaryText(report)}</Text>
      </View>
      <Feather name={open?"chevron-up":"chevron-down"} size={20} color={t.secondary}/>
    </Pressable>
    {open ? <View style={{gap:6,paddingBottom:8}}>
      <Text style={{color:t.muted,fontSize:12}}>
        Проверка на момент ответа. Это охват сохранённых заметок, а не подтверждение
        оригинальных веб-страниц или каждого утверждения модели. Сейчас доступ мог измениться.
      </Text>
      <Text style={{color:t.muted,fontSize:12}}>
        {cited.valid
          ? "Ссылок на действительно прочитанные диапазоны: "+cited.valid+
            ". Смысл выводов не проверяется автоматически."
          : "У выводов пока нет ссылок на конкретные прочитанные диапазоны."}
        {cited.invalid ? " Ссылок без подтверждённого чтения: "+cited.invalid+" — они неактивны." : ""}
      </Text>
      {report.entries.map(e=><Pressable key={e.id} accessibilityRole="link"
        accessibilityLabel={`Открыть исходную запись ${e.selectedIndex+1}: ${e.title||"без названия"}`}
        onPress={()=>onOpen(e.id)}
        style={{minHeight:nebulaTouch.minimum,justifyContent:"center",
          paddingVertical:7,borderTopWidth:1,borderTopColor:t.line,gap:3}}>
        <Text numberOfLines={2} style={{color:t.accent,fontWeight:"600"}}>
          {e.selectedIndex+1}. {e.title || "Материал без названия"}
        </Text>
        <Text style={{color:t.muted,fontSize:12}}>{entryStatus(e)}</Text>
      </Pressable>)}
    </View> : null}
  </View>;
}
