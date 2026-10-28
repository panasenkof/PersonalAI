/**
 * Cross-domain synthetic test examples; no personal medical/family data.
 * The cases are named after the persistent scenario matrix. This is a
 * deterministic T1/T2 C1 gate, not a claim about T3, M4, or real Android QA.
 */
import {
  compareTemporalCandidates, validateTemporalClaim,
  type TemporalBound, type TemporalClaimCandidate, type TemporalReview,
} from "../temporal-claims";

const year=(y:number):TemporalBound=>({
  normalized:String(y),precision:"year",raw:"в "+y+" году",
  anchorDate:null,sourceTimeZone:null,
});
const month=(y:number,m:number):TemporalBound=>({
  normalized:String(y)+"-"+String(m).padStart(2,"0"),precision:"month",
  raw:"в "+m+" месяце "+y,anchorDate:null,sourceTimeZone:null,
});
const day=(d:string):TemporalBound=>({
  normalized:d,precision:"day",raw:"точная дата "+d,anchorDate:null,sourceTimeZone:null,
});
const unknown:TemporalBound={
  normalized:null,precision:"unknown",raw:"дата неизвестна",
  anchorDate:null,sourceTimeZone:null,
};
function state(changes:Partial<TemporalClaimCandidate>={}):TemporalClaimCandidate {
  return {
    recordedAt:"2026-10-27T10:00:00.000Z",
    subjectId:"person-alex",predicate:"employment",context:"primary",
    value:"Компания А",kind:"state",modality:"asserted",
    negated:false,cardinality:"single",occurredOrStarted:year(2022),
    ended:null,endConfirmed:false,
    evidence:{entityId:"source-note-1",recordVersion:1,quote:"Работаю в компании А",origin:"direct"},
    ...changes,
  };
}

type CandidateScenario={
  id:string; domain:string; old:Partial<TemporalClaimCandidate>;
  next:Partial<TemporalClaimCandidate>; expected:TemporalReview;
};
const pairs:CandidateScenario[]=[
  {id:"TM01",domain:"новая основная работа",old:{},next:{value:"Компания Б",occurredOrStarted:year(2025)},expected:"possible_change"},
  {id:"TM02",domain:"повторное подтверждение места работы",old:{},next:{value:"Компания А",occurredOrStarted:year(2025)},expected:"possible_reconfirmation"},
  {id:"TM03",domain:"вторая работа не закрывает основную",old:{},next:{context:"secondary",value:"Компания Б"},expected:"independent"},
  {id:"TM04",domain:"работа по совместительству многозначна",old:{cardinality:"multiple"},next:{cardinality:"multiple",value:"Компания Б"},expected:"independent"},
  {id:"TM05",domain:"старый трудовой документ импортирован сегодня",old:{occurredOrStarted:year(2024)},next:{value:"Компания Б",occurredOrStarted:year(2019),recordedAt:"2026-10-28T10:00:00.000Z"},expected:"independent"},
  {id:"TM06",domain:"старый контракт за месяц до новой работы",old:{occurredOrStarted:month(2024,11)},next:{value:"Компания Б",occurredOrStarted:month(2024,10)},expected:"independent"},
  {id:"TM07",domain:"даты в одном году без точных месяцев",old:{occurredOrStarted:year(2024)},next:{value:"Компания Б",occurredOrStarted:month(2024,3)},expected:"possible_change"},
  {id:"TM08",domain:"поздно внесённое историческое событие ремонта",old:{kind:"event",predicate:"spark_plugs",context:"car-1",value:"2023",occurredOrStarted:year(2023)},next:{kind:"event",predicate:"spark_plugs",context:"car-1",value:"2025",occurredOrStarted:year(2025)},expected:"independent"},
  {id:"TM09",domain:"разные автомобили",old:{subjectId:"car-a",predicate:"service",context:"engine"},next:{subjectId:"car-b",predicate:"service",context:"engine",value:"Oil B"},expected:"independent"},
  {id:"TM10",domain:"смена фактического адреса",old:{predicate:"residence",context:"actual",value:"Москва"},next:{predicate:"residence",context:"actual",value:"Казань",occurredOrStarted:year(2026)},expected:"possible_change"},
  {id:"TM11",domain:"прописка и фактическое проживание разные",old:{predicate:"residence",context:"registered"},next:{predicate:"residence",context:"actual",value:"Казань"},expected:"independent"},
  {id:"TM12",domain:"аренда двух помещений допускается",old:{predicate:"lease",context:"housing",cardinality:"multiple"},next:{predicate:"lease",context:"housing",cardinality:"multiple",value:"Вторая квартира"},expected:"independent"},
  {id:"TM13",domain:"смена домашнего провайдера",old:{predicate:"internet_provider",context:"home",value:"A"},next:{predicate:"internet_provider",context:"home",value:"B",occurredOrStarted:year(2026)},expected:"possible_change"},
  {id:"TM14",domain:"новая запланированная работа не текущая",old:{},next:{modality:"planned",value:"Компания Б"},expected:"independent"},
  {id:"TM15",domain:"слух о смене школы не утверждение",old:{predicate:"school",context:"child-1"},next:{predicate:"school",context:"child-1",value:"Школа 2",modality:"hypothetical"},expected:"independent"},
  {id:"TM16",domain:"отрицание не закрывает сам факт",old:{},next:{negated:true,value:"Компания Б"},expected:"independent"},
  {id:"TM17",domain:"модельная расшифровка не подтверждает работу",old:{},next:{value:"Компания Б",evidence:{entityId:"asr",recordVersion:1,quote:"вроде Б",origin:"derived"}},expected:"independent"},
  {id:"TM18",domain:"нет разрешённой личности",old:{subjectId:null},next:{value:"Компания Б",subjectId:null},expected:"identity_unresolved"},
  {id:"TM19",domain:"два однофамильца",old:{subjectId:"person-ivan-1"},next:{subjectId:"person-ivan-2",value:"Компания Б"},expected:"independent"},
  {id:"TM20",domain:"уже подтверждённое завершение не закрывается повторно",old:{ended:unknown,endConfirmed:true},next:{value:"Компания Б"},expected:"independent"},
  {id:"TM21",domain:"медицинское наблюдение повторяется",old:{kind:"observation",predicate:"blood_pressure",value:"120/80"},next:{kind:"observation",predicate:"blood_pressure",value:"125/82"},expected:"independent"},
  {id:"TM22",domain:"единичный приём лекарства не постоянное состояние",old:{kind:"event",predicate:"medication_dose"},next:{kind:"event",predicate:"medication_dose",value:"dose B"},expected:"independent"},
  {id:"TM23",domain:"смена рабочего телефона",old:{predicate:"phone",context:"work"},next:{predicate:"phone",context:"work",value:"новый"},expected:"possible_change"},
  {id:"TM24",domain:"два любимых рецепта сосуществуют",old:{kind:"enduring",predicate:"recipe_preference",cardinality:"multiple"},next:{kind:"enduring",predicate:"recipe_preference",cardinality:"multiple",value:"Рецепт Б"},expected:"independent"},
  {id:"TM25",domain:"предположение о хобби не факт",old:{predicate:"hobby",context:"sports"},next:{predicate:"hobby",context:"sports",value:"теннис",modality:"hypothetical"},expected:"independent"},
  {id:"TM26",domain:"ремонт свечей другого двигателя не закрывает запись",old:{kind:"event",predicate:"service",context:"car-1"},next:{kind:"event",predicate:"service",context:"car-2",value:"Oil"},expected:"independent"},
  {id:"TM27",domain:"сейчас в одной гостинице не смена прописки",old:{predicate:"residence",context:"registered"},next:{predicate:"stay",context:"hotel",value:"Отель"},expected:"independent"},
  {id:"TM28",domain:"смена школы ребёнка не подменяет собственную работу",old:{predicate:"employment",subjectId:"user"},next:{predicate:"school",subjectId:"child-1",value:"Школа Б"},expected:"independent"},
  {id:"TM29",domain:"известна только приблизительная дата",old:{predicate:"residence",context:"actual",occurredOrStarted:unknown},next:{predicate:"residence",context:"actual",value:"Адрес Б",occurredOrStarted:unknown},expected:"possible_change"},
  {id:"TM30",domain:"старый документ с точным днём до новой месячной границы",old:{occurredOrStarted:month(2025,2)},next:{value:"Компания Б",occurredOrStarted:day("2025-01-31")},expected:"independent"},
];

test.each(pairs)("$id · $domain gives $expected",({old,next,expected})=>{
  expect(compareTemporalCandidates(state(old),state(next))).toBe(expected);
  // Comparison must not mutate source versions, bounds or status.
  expect(state(old).endConfirmed).toBe(Boolean(old.endConfirmed));
});

test.each([
  ["TM31","invalid calendar day",day("2025-02-30")],
  ["TM32","invalid leap day",day("2023-02-29")],
  ["TM33","invalid month 13",{...month(2025,1),normalized:"2025-13"}],
  ["TM34","year outside configured supported calendar",{...month(2025,1),normalized:"0000-03"}],
  ["TM35","unknown date cannot store normalized day",{...unknown,normalized:"2025-01-01"}],
  ["TM36","approximate precision cannot store a guessed exact date",{...unknown,precision:"approximate" as const,normalized:"2025-01-01"}],
] as const)("%s · %s cannot silently change precision",(_id,_label,invalid)=>{
  expect(()=>validateTemporalClaim(state({occurredOrStarted:invalid}))).toThrow("temporal_bound_invalid");
});

test.each([
  ["TM37","end year earlier than a start month",month(2025,11),year(2024)],
  ["TM38","end day earlier than start year",year(2025),day("2024-12-31")],
  ["TM39","end month before start day",day("2025-03-01"),month(2025,2)],
] as const)("%s · %s is rejected",(_id,_label,start,end)=>{
  expect(()=>validateTemporalClaim(state({
    occurredOrStarted:start,ended:end,endConfirmed:true,
  }))).toThrow("temporal_end_before_start");
});

test("TM40 · year/month precision preserves ranges, accepts possible valid overlaps",()=>{
  expect(()=>validateTemporalClaim(state({
    occurredOrStarted:year(2025),ended:day("2025-02-01"),endConfirmed:true,
  }))).not.toThrow();
  expect(()=>validateTemporalClaim(state({
    occurredOrStarted:month(2025,2),ended:day("2025-02-01"),endConfirmed:true,
  }))).not.toThrow();
});

test.each([
  ["TM41","malformed temporal type",{kind:"plan"}],
  ["TM42","unsupported modality",{modality:"auto_confirmed"}],
  ["TM43","unsafe cardinality",{cardinality:"people"}],
  ["TM44","missing boolean negation",{negated:"no"}],
  ["TM45","missing boolean confirmation",{endConfirmed:"yes"}],
] as const)("%s · %s fails at the runtime boundary",(_id,_label,changes)=>{
  expect(()=>validateTemporalClaim(state(changes as unknown as Partial<TemporalClaimCandidate>)))
    .toThrow("temporal_type_invalid");
});
