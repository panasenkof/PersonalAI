import React, { useCallback, useEffect, useRef, useState } from "react";
import { useFocusEffect, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { localMemoryRepository } from "../local-memory/repository";
import type { RootStackParams } from "../navigation";
import type { TemporalInboxCursor, TemporalInboxItem } from "../local-memory/temporal-review-inbox";
import type { RelationInboxCursor, RelationReviewCandidate, RelationCandidateExpected,
  RelationCandidateReviewChoice } from "../local-memory/relation-evidence";
import type { TemporalUserChoice, TemporalDecisionExpected } from "../local-memory/temporal-decisions";
import type { TemporalBound } from "../local-memory/temporal-claims";
import { onLocalMemorySessionChange } from "../local-memory/storage";
import { memoryErrorMessage } from "../local-memory/errors";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "../design/nebula/tokens";

type UndoAction =
  | (TemporalDecisionExpected & { kind: "temporal"; decisionId: string })
  | (RelationCandidateExpected & { kind: "relation"; actionId: string });
/** Keep date-only semantics. This is a user-entered local date, not midnight UTC. */
export function exactUserEndDate(value: string): TemporalBound | null {
  const input=value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;
  const [y,m,d]=input.split("-").map(Number);
  if (y<1000 || y>9999) return null;
  if (new Date(Date.UTC(y,m-1,d)).toISOString().slice(0,10)!==input) return null;
  return {normalized:input,precision:"day",raw:"Дата окончания подтверждена пользователем: "+input,
    anchorDate:null,sourceTimeZone:null};
}
const unknownUserEnd:TemporalBound={
  normalized:null,precision:"unknown",
  raw:"Завершение подтверждено пользователем; точная дата неизвестна",
  anchorDate:null,sourceTimeZone:null,
};

const RELATION_NAMES:Record<RelationReviewCandidate["kind"],string>={
  has_sister:"сестра",has_brother:"брат",has_mother:"мать",has_father:"отец",
  has_spouse:"супруг или супруга",has_child:"ребёнок",has_friend:"друг",
  has_colleague:"коллега",has_doctor:"врач",has_teacher:"учитель",
  participant_of:"участник разговора",
};

export function MemoryTemporalReviewScreen() {
  const t=useTheme(),profile=useProfile();
  const route=useRoute<RouteProp<RootStackParams,"MemoryTemporalReview">>();
  const collectionId=route.params.collectionId;
  const [items,setItems]=useState<TemporalInboxItem[]>([]);
  const [cursor,setCursor]=useState<TemporalInboxCursor|null>(null);
  // One existing screen for both review domains; NO additional source of
  // truth. Each original repository inbox owns its own stable cursor.
  const [relations,setRelations]=useState<RelationReviewCandidate[]>([]);
  const [relationCursor,setRelationCursor]=useState<RelationInboxCursor|null>(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  const [error,setError]=useState(""),[notice,setNotice]=useState("");
  const [revision,setRevision]=useState(0);
  const [confirming,setConfirming]=useState<string|null>(null);
  const [dateText,setDateText]=useState("");
  const [undo,setUndo]=useState<UndoAction|null>(null);
  const generation=useRef(0);

  useEffect(()=>onLocalMemorySessionChange(unlocked=>{
    if(!unlocked) {
      generation.current++;setItems([]);setCursor(null);setRelations([]);setRelationCursor(null);setUndo(null);
      setConfirming(null);setDateText("");setNotice("");
      setError("Память заблокирована. Разблокируйте приложение, чтобы увидеть предложения.");
    } else { setRevision(n=>n+1); }
  }),[]);

  useFocusEffect(useCallback(()=>{
    const request=++generation.current;
    setLoading(true);setError("");setItems([]);setCursor(null);setRelations([]);setRelationCursor(null);
    if(profile) void localMemoryRepository(profile)
      .then(db=>Promise.all([
        db.temporalReviewInbox({collectionId,limit:20}),
        db.relationCandidateInbox({collectionId,limit:20}),
      ]))
      .then(([temporal,relation])=>{if(request===generation.current){
        setItems(temporal.items);setCursor(temporal.nextCursor);
        setRelations(relation.items);setRelationCursor(relation.nextCursor);
      }})
      .catch(e=>{if(request===generation.current)setError(memoryErrorMessage(e));})
      .finally(()=>{if(request===generation.current)setLoading(false);});
    else {setLoading(false);setError("Память недоступна без профиля.");}
    return ()=>{generation.current++;};
  },[profile,collectionId,revision]));

  async function more() {
    if(!profile||!cursor||busy||loading) return;
    const request=generation.current, before=cursor;
    setBusy(true);setError("");
    try{
      const db=await localMemoryRepository(profile);
      const next=await db.temporalReviewInbox({collectionId,limit:20,before});
      if(request!==generation.current)return;
      setItems(rows=>[...rows,...next.items.filter(x=>!rows.some(y=>y.proposalId===x.proposalId))]);
      setCursor(next.nextCursor);
    } catch(e){if(request===generation.current)setError(memoryErrorMessage(e));}
    finally{if(request===generation.current)setBusy(false);}
  }

  async function moreRelations() {
    if(!profile||!relationCursor||busy||loading)return;
    const request=generation.current,before=relationCursor;
    setBusy(true);setError("");
    try {
      const db=await localMemoryRepository(profile);
      const page=await db.relationCandidateInbox({collectionId,limit:20,before});
      if(request!==generation.current)return;
      setRelations(rows=>[...rows,...page.items.filter(x=>!rows.some(y=>y.proposalId===x.proposalId))]);
      setRelationCursor(page.nextCursor);
    }catch(e){if(request===generation.current)setError(memoryErrorMessage(e));}
    finally{if(request===generation.current)setBusy(false);}
  }

  async function chooseRelation(item:RelationReviewCandidate,choice:RelationCandidateReviewChoice) {
    if(!profile||busy)return;
    const request=generation.current;setBusy(true);setError("");setNotice("");
    try {
      const db=await localMemoryRepository(profile);
      const result=await db.decideRelationCandidate({
        proposalId:item.proposalId,expectedVersion:item.proposalVersion,
        choice,userConfirmed:true,
      });
      if(request!==generation.current)return;
      setUndo({kind:"relation",proposalId:item.proposalId,
        expectedVersion:result.nextVersion,actionId:result.actionId,userConfirmed:true});
      setNotice(choice==="accept"?"Связь подтверждена с указанным источником. Можно отменить.": 
        choice==="reject"?"Предложение отклонено и сохранено в истории.":"Рассмотрение связи отложено.");
      setRevision(v=>v+1);
    }catch(e){if(request===generation.current){
      setNotice("Решение по связи не применено: "+memoryErrorMessage(e));
      setRevision(v=>v+1);
    }}finally{if(request===generation.current)setBusy(false);}
  }

  async function choose(item:TemporalInboxItem,choice:TemporalUserChoice,end?:TemporalBound) {
    if(!profile||busy)return;
    const request=generation.current;setBusy(true);setError("");setNotice("");
    try{
      const db=await localMemoryRepository(profile);
      const result=await db.decideTemporalChange({
        proposalId:item.proposalId,expectedProposalVersion:item.expectedProposalVersion,
        expectedPreviousClaimVersion:item.expectedPreviousClaimVersion,
        expectedIncomingClaimVersion:item.expectedIncomingClaimVersion,
        choice,...(end?{confirmedEnd:end}:{}),
      });
      if(request!==generation.current)return;
      setUndo({
        kind:"temporal",proposalId:item.proposalId,decisionId:result.decisionId,
        expectedProposalVersion:result.nextProposalVersion,
        expectedPreviousClaimVersion:item.expectedPreviousClaimVersion+(choice==="accept"?1:0),
        expectedIncomingClaimVersion:item.expectedIncomingClaimVersion,
      });
      setNotice(choice==="accept"?"Завершение сохранено. Его можно отменить.":
        choice==="keep_both"?"Оба варианта оставлены без изменения.":
        choice==="defer"?"Рассмотрение отложено.":"Предложение отклонено.");
      setConfirming(null);setDateText("");setRevision(n=>n+1);
    } catch(e){
      if(request===generation.current){
        setNotice("Решение не применено: "+memoryErrorMessage(e)+". Предложения обновлены; проверьте актуальные данные.");
        setRevision(n=>n+1);
      }
    }finally{if(request===generation.current)setBusy(false);}
  }

  async function undoLast() {
    if(!profile||!undo||busy)return;
    const request=generation.current;setBusy(true);setError("");
    try{
      const db=await localMemoryRepository(profile);
      if(undo.kind==="temporal")await db.undoTemporalChange({
        proposalId:undo.proposalId,decisionId:undo.decisionId,
        expectedProposalVersion:undo.expectedProposalVersion,
        expectedPreviousClaimVersion:undo.expectedPreviousClaimVersion,
        expectedIncomingClaimVersion:undo.expectedIncomingClaimVersion,
      });
      else await db.undoRelationCandidateDecision({
        proposalId:undo.proposalId,expectedVersion:undo.expectedVersion,
        actionId:undo.actionId,userConfirmed:true,
      });
      if(request!==generation.current)return;
      setUndo(null);setNotice("Последнее решение отменено; история изменений сохранена.");
      setRevision(n=>n+1);
    }catch(e){if(request===generation.current)setError("Отмена не выполнена: "+memoryErrorMessage(e));}
    finally{if(request===generation.current)setBusy(false);}
  }

  const action=(disabled:boolean)=>({
    minHeight:nebulaTouch.minimum,paddingHorizontal:nebulaSpacing.md,paddingVertical:10,
    borderRadius:nebulaRadii.field,backgroundColor:t.panel,
    justifyContent:"center" as const,opacity:disabled ? 0.5 : 1,
    borderWidth:1,borderColor:t.line,
  });
  return <ScrollView style={{flex:1,backgroundColor:t.bg}} keyboardShouldPersistTaps="handled"
    contentContainerStyle={{padding:nebulaSpacing.md,paddingBottom:32,gap:nebulaSpacing.md}}>
    <Text accessibilityRole="header" style={{color:t.text,fontSize:22,fontWeight:"800"}}>На проверке</Text>
    <Text style={{color:t.muted,lineHeight:21}}>Здесь возможные изменения состояния и новые связи в выбранной коллекции.
      Слова и даты взяты из источников. Ничего не изменяется без вашего действия.
      Закрытые и неподтверждённые источники не показываются.</Text>
    {notice?<Text accessibilityLiveRegion="polite" style={{color:t.secondary}}>{notice}</Text>:null}
    {undo?<Pressable accessibilityRole="button" accessibilityLabel="Отменить последнее решение памяти"
      disabled={busy} style={action(busy)} onPress={()=>void undoLast()}>
      <Text style={{color:t.secondary,fontWeight:"700"}}>Отменить последнее решение</Text>
    </Pressable>:null}
    {error?<Text accessibilityRole="alert" style={{color:t.err}}>{error}</Text>:null}
    {loading?<ActivityIndicator accessibilityLabel="Загрузка предложений памяти" />:null}
    {!loading&&!error&&items.length===0&&relations.length===0?<Text style={{color:t.muted}}>
      Предложений для этой коллекции пока нет.
    </Text>:null}
    {relations.length>0?<Text accessibilityRole="header" style={{color:t.text,fontSize:18,fontWeight:"700"}}>
      Возможные связи
    </Text>:null}
    {relations.map(item=><View key={"relation:"+item.proposalId} style={{
      borderRadius:nebulaRadii.card,borderWidth:1,borderColor:t.line,
      backgroundColor:t.panel,padding:nebulaSpacing.md,gap:nebulaSpacing.sm,
    }}>
      <Text accessibilityRole="header" style={{fontSize:16,fontWeight:"700",color:t.text}}>
        Возможная связь: {RELATION_NAMES[item.kind]}
      </Text>
      {item.status==="deferred"?<Text style={{color:t.muted}}>Отложено</Text>:null}
      <Text style={{color:t.text,fontWeight:"600"}}>{item.kind==="participant_of"?"Разговор":"Человек"}: {item.sourceTitle||"Без названия"}</Text>
      <Text style={{color:t.text,fontWeight:"600"}}>{item.kind==="participant_of"?"Участник":"Связан с"}: {item.targetTitle||"Без названия"}</Text>
      <Text style={{color:t.muted}} numberOfLines={5}>Источник: «{item.evidenceQuote}»</Text>
      <Text style={{color:t.muted,fontSize:12}}>
        Предполагаемая связь не считается доказанной до вашего подтверждения.
        Учитываются конкретные записи, а не совпадение имён.
      </Text>
      <View style={{flexDirection:"row",flexWrap:"wrap",gap:8}}>
        <Pressable accessibilityRole="button" accessibilityLabel={"Подтвердить связь "+item.proposalId}
          disabled={busy} style={action(busy)} onPress={()=>void chooseRelation(item,"accept")}>
          <Text style={{color:t.secondary,fontWeight:"700"}}>Подтвердить связь</Text>
        </Pressable>
        {item.status!=="deferred"?<Pressable accessibilityRole="button"
          accessibilityLabel={"Отложить связь "+item.proposalId}
          disabled={busy} style={action(busy)} onPress={()=>void chooseRelation(item,"defer")}>
          <Text style={{color:t.text}}>Позже</Text>
        </Pressable>:null}
        <Pressable accessibilityRole="button" accessibilityLabel={"Не связывать "+item.proposalId}
          disabled={busy} style={action(busy)} onPress={()=>void chooseRelation(item,"reject")}>
          <Text style={{color:t.text}}>Не связывать</Text>
        </Pressable>
      </View>
    </View>)}
    {relationCursor?<Pressable accessibilityRole="button" accessibilityLabel="Показать ещё связи памяти"
      disabled={busy||loading} style={action(busy||loading)} onPress={()=>void moreRelations()}>
      <Text style={{color:t.secondary}}>Показать ещё связи</Text>
    </Pressable>:null}
    {items.length>0?<Text accessibilityRole="header" style={{color:t.text,fontSize:18,fontWeight:"700"}}>
      Возможные изменения состояния
    </Text>:null}
    {items.map(item=><View key={item.proposalId} style={{
      borderRadius:nebulaRadii.card,borderWidth:1,borderColor:t.line,
      backgroundColor:t.panel,padding:nebulaSpacing.md,gap:nebulaSpacing.sm,
    }}>
      <Text accessibilityRole="header" style={{fontSize:16,fontWeight:"700",color:t.text}}>
        {item.reviewKind==="possible_reconfirmation"?"Возможно, повторное подтверждение":"Возможная смена состояния"}
      </Text>
      {item.status==="deferred"?<Text style={{color:t.muted}}>Отложено</Text>:null}
      <Text style={{color:t.text,fontWeight:"600"}}>Ранее записано: {item.previous.value}</Text>
      <Text style={{color:t.muted}} numberOfLines={5}>Источник: «{item.previous.evidence.quote}»</Text>
      <Text style={{color:t.text,fontWeight:"600"}}>В новом материале: {item.incoming.value}</Text>
      <Text style={{color:t.muted}} numberOfLines={5}>Источник: «{item.incoming.evidence.quote}»</Text>
      <Text style={{color:t.muted,fontSize:12}}>Новая запись не доказывает, что прежнее состояние завершилось.
        Дата и обстоятельства требуют вашего подтверждения.</Text>
      <View style={{flexDirection:"row",flexWrap:"wrap",gap:8}}>
        {item.reviewKind==="possible_change"?
          <Pressable accessibilityRole="button" accessibilityLabel={"Рассмотреть завершение "+item.previous.value}
            disabled={busy} style={action(busy)} onPress={()=>{setConfirming(item.proposalId);setDateText("");}}>
            <Text style={{color:t.secondary,fontWeight:"700"}}>Подтвердить изменение</Text>
          </Pressable>:null}
        <Pressable accessibilityRole="button" accessibilityLabel={"Оставить оба факта "+item.proposalId}
          disabled={busy} style={action(busy)} onPress={()=>void choose(item,"keep_both")}>
          <Text style={{color:t.text}}>Оставить оба</Text>
        </Pressable>
        {item.status!=="deferred"?<Pressable accessibilityRole="button"
          accessibilityLabel={"Отложить предложение "+item.proposalId}
          disabled={busy} style={action(busy)} onPress={()=>void choose(item,"defer")}>
          <Text style={{color:t.text}}>Позже</Text>
        </Pressable>:null}
        <Pressable accessibilityRole="button" accessibilityLabel={"Отклонить предложение "+item.proposalId}
          disabled={busy} style={action(busy)} onPress={()=>void choose(item,"dismiss")}>
          <Text style={{color:t.text}}>Не предлагать</Text>
        </Pressable>
      </View>
      {confirming===item.proposalId?<View style={{gap:8,borderTopWidth:1,borderTopColor:t.line,paddingTop:12}}>
        <Text style={{color:t.text,fontWeight:"700"}}>Подтвердить окончание прежнего состояния</Text>
        <Text style={{color:t.muted}}>Введите известную дату окончания (ГГГГ-ММ-ДД).
          Если точная дата неизвестна, подтвердите завершение без даты: мы её не будем придумывать.</Text>
        <TextInput accessibilityLabel="Дата окончания прежнего состояния" value={dateText}
          onChangeText={setDateText} placeholder="ГГГГ-ММ-ДД" placeholderTextColor={t.muted}
          keyboardType="numbers-and-punctuation" autoCorrect={false} maxLength={10}
          style={{minHeight:nebulaTouch.minimum,borderColor:t.line,borderWidth:1,
            borderRadius:nebulaRadii.field,paddingHorizontal:12,color:t.text}}/>
        <View style={{flexDirection:"row",flexWrap:"wrap",gap:8}}>
          <Pressable accessibilityRole="button" accessibilityLabel="Подтвердить окончание с указанной датой"
            disabled={busy||!exactUserEndDate(dateText)} style={action(busy||!exactUserEndDate(dateText))}
            onPress={()=>{const bound=exactUserEndDate(dateText);if(bound)void choose(item,"accept",bound);}}>
            <Text style={{color:t.secondary}}>Подтвердить дату</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Подтвердить окончание без даты"
            disabled={busy} style={action(busy)} onPress={()=>void choose(item,"accept",unknownUserEnd)}>
            <Text style={{color:t.secondary}}>Дата неизвестна</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Отменить подтверждение изменения"
            disabled={busy} style={action(busy)} onPress={()=>{setConfirming(null);setDateText("");}}>
            <Text style={{color:t.muted}}>Отмена</Text>
          </Pressable>
        </View>
      </View>:null}
    </View>)}
    {cursor?<Pressable accessibilityRole="button" accessibilityLabel="Показать ещё предложения памяти"
      disabled={busy||loading} style={action(busy||loading)} onPress={()=>void more()}>
      <Text style={{color:t.secondary}}>{busy?"Загружаю…":"Показать ещё"}</Text>
    </Pressable>:null}
  </ScrollView>;
}
