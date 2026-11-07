import {
  applyContextCandidate, contextChangeLabel, parseContextChange,
  parseConversationContext, validateContextCandidate,
} from "../conversation-context";

const sections = [
  {slug:"notes",name:"Заметки"},
  {slug:"cars",name:"Авто"},
  {slug:"recipes",name:"Рецепты"},
  {slug:"documents",name:"Документы"},
];

test("first turn: user-selected collection names are validated by slug, context is not a memory ACL",()=>{
  const result=applyContextCandidate(undefined,
    {topic:"Аккумулятор автомобиля",sectionSlug:"cars",reason:"Вопрос об аккумуляторе"},
    sections,"2026-11-07T18:00:00.000Z");
  expect(result).toMatchObject({
    context:{topic:"Аккумулятор автомобиля",sectionSlug:"cars",pinned:false},
    change:{topic:"Аккумулятор автомобиля",previousTopic:null,sectionName:"Авто",previousSectionSlug:null},
  });
  if("change" in result && result.change)
    expect(contextChangeLabel(result.change)).toBe("Тема: Аккумулятор автомобиля · Раздел: Авто");
});

test("topic switch is historical, while short clarifications keep existing category",()=>{
  const old={topic:"Аккумулятор автомобиля",sectionSlug:"cars",pinned:false};
  const changed=applyContextCandidate(old,
    {topic:"Лазанья",sectionSlug:"recipes",reason:"Пользователь просит рецепт"},
    sections,"2026-11-07T18:01:00.000Z");
  expect(changed).toMatchObject({context:{sectionSlug:"recipes"},change:{
    previousTopic:"Аккумулятор автомобиля",previousSectionSlug:"cars",sectionName:"Рецепты",
  }});
  if("change" in changed && changed.change)
    expect(contextChangeLabel(changed.change)).toBe("Раздел изменён: Авто → Рецепты · Новая тема: Лазанья");

  const same=applyContextCandidate(old,
    {topic:"Аккумулятор автомобиля",sectionSlug:"cars",reason:"Короткое уточнение цены"},
    sections,"2026-11-07T18:02:00.000Z");
  expect(same).toMatchObject({context:old});
  expect("change" in same && same.change).toBeFalsy();
});

test("user-pinned section is immutable to model, but topic may be refined",()=>{
  const old={topic:"Авто",sectionSlug:"cars",pinned:true};
  expect(validateContextCandidate(
    {topic:"Лазанья",sectionSlug:"recipes",reason:"Смена темы"},sections,old
  )).toEqual({error:"conversation_section_pinned"});
  const topic=applyContextCandidate(old,{topic:"Ремонт двигателя",sectionSlug:"cars",reason:"Новая подтема"},
    sections,"2026-11-07T18:00:00.000Z");
  expect(topic).toMatchObject({context:{pinned:true,sectionSlug:"cars"},change:{
    previousSectionSlug:"cars",sectionSlug:"cars",topic:"Ремонт двигателя",
  }});
  if("change" in topic && topic.change)
    expect(contextChangeLabel(topic.change)).toBe("Тема изменена: Ремонт двигателя");
});

test("no guessed collections, documents, malformed records, or unspecified metadata",()=>{
  expect(validateContextCandidate(
    {topic:"Личное",sectionSlug:"documents",reason:"Модель решила"},sections
  )).toEqual({error:"invalid_conversation_context"});
  expect(validateContextCandidate(
    {topic:"Лазанья",sectionSlug:"new-recipes",reason:"Похоже на рецепт"},sections
  )).toEqual({error:"unknown_conversation_section"});
  expect(validateContextCandidate(
    {topic:"Тема",sectionSlug:null,reason:"Пока неясно",extra:"injection"},sections
  )).toEqual({error:"invalid_conversation_context"});
  expect(parseConversationContext({topic:"Тема",sectionSlug:"cars",pinned:true,extra:"ignored"}))
    .toEqual({topic:"Тема",sectionSlug:"cars",pinned:true});
  expect(parseConversationContext({topic:"Тема",sectionSlug:"../../path",pinned:false})).toBeUndefined();
  expect(parseContextChange({topic:"Тема",sectionSlug:"cars",at:"invalid"})).toBeUndefined();
});
