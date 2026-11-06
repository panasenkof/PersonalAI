import { savedAiArticleIntent, savedAiArticlePageIntent } from "../article-selection";

test("saved AI articles: 7 calendar days including today, not rolling 168 hours", () => {
  const at = new Date(2026,10,6,23,57,0);
  const i = savedAiArticleIntent("Выбери статьи на тему ИИ за последнюю неделю", at);
  expect(i).toMatchObject({topic:"ai",dateMode:"saved",startLocal:"2026-10-31",endLocal:"2026-11-06"});
  expect(i?.savedFrom).toBe(new Date(2026,9,31).toISOString());
  expect(i?.savedBefore).toBe(new Date(2026,10,7).toISOString());
});

test("current week starts on local Monday, even across year", () => {
  const i = savedAiArticleIntent("Покажи материалы про AI на этой неделе", new Date(2027,0,1,15));
  expect(i?.startLocal).toBe("2026-12-28");
  expect(i?.endLocal).toBe("2027-01-01");
});

test.each([
  "Выбери опубликованные статьи про ИИ за последнюю неделю",
  "Найди статьи про ИИ за неделю в интернете",
  "Найди фото ИИ за неделю",
  "Сделай выжимку статей про ИИ за последнюю неделю",
  "Покажи статьи про ИИ без даты",
])("do not misroute unsupported or publication-date requests to local saved-date picker: %s", q => {
  expect(savedAiArticleIntent(q,new Date(2026,10,6))).toBeNull();
});
test("attachments are never consumed by a text-only shortlist",()=>{
  expect(savedAiArticleIntent("Найди статьи про ИИ за неделю",new Date(2026,10,6),true)).toBeNull();
});

test.each([
  ["Выбери статьи про автомобили за последнюю неделю","автомобили"],
  ["Покажи сохранённые материалы про ремонт автомобиля на этой неделе","ремонт автомобиля"],
  ["Найди статьи о MiniLM на этой неделе","MiniLM"],
  ["Выбери материалы на тему EmbeddingGemma 2 за неделю","EmbeddingGemma 2"],
])("literal topic saved-date intent: %s", (q,topic)=>{
  const intent=savedAiArticleIntent(q,new Date(2026,10,6));
  expect(intent).toMatchObject({topic,queryTerms:[topic],dateMode:"saved"});
});
test.each([
  "Найди статьи про автомобили кроме электромобилей за неделю",
  "Найди статьи про велосипеды за последние 3 дня",
  "Покажи материалы про API/ключи на этой неделе",
  "Найди статьи про ????????? за неделю",
  "Выбери статьи о ИИ без ссылок за неделю",
])("do not silently reinterpret unsupported syntax or exclusion: %s", q=>{
  expect(savedAiArticleIntent(q,new Date(2026,10,6))).toBeNull();
});
test("AI synonyms retain existing local query terms, not unrelated literal topics",()=>{
  expect(savedAiArticleIntent("Найди статьи об ИИ за неделю",new Date(2026,10,6))?.queryTerms)
    .toContain("нейросеть");
  expect(savedAiArticleIntent("Найди статьи об AI за неделю",new Date(2026,10,6))?.topic).toBe("ai");
});

test("9A5c: explicitly published requests filter by source publication day, never saved day",()=>{
  const at=new Date(2026,10,6,15);
  const request=savedAiArticleIntent("Найди статьи об ИИ, опубликованные за последние 7 дней",at);
  expect(request).toMatchObject({dateMode:"published",topic:"ai",
    publicationFrom:"2026-10-31",publicationBefore:"2026-11-07"});
  expect(savedAiArticleIntent("Найди статьи об ИИ за последние 7 дней",at)?.dateMode).toBe("saved");
  expect(savedAiArticleIntent("Выбери статьи про автомобили опубликованные за неделю",at))
    .toMatchObject({dateMode:"published",topic:"автомобили"});
  expect(savedAiArticleIntent("Покажи материалы про автомобили, вышедшие на этой неделе",at))
    .toMatchObject({dateMode:"published",topic:"автомобили",publicationFrom:"2026-11-02"});
});
test("9A5c: next page retains the original publication period across changes of today's date",()=>{
  const page=savedAiArticlePageIntent({kind:"saved_topic_links",topic:"автомобили",
    queryTerms:["автомобили"],dateMode:"published",
    savedFrom:"2026-10-31T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z",
    startLocal:"2026-10-31",endLocal:"2026-11-06"});
  expect(page).toMatchObject({dateMode:"published",topic:"автомобили",
    publicationFrom:"2026-10-31",publicationBefore:"2026-11-07"});
});
