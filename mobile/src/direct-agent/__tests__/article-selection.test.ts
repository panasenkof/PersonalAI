import { savedAiArticleIntent } from "../article-selection";

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
  "Выбери статьи про автомобили за последнюю неделю",
  "Покажи статьи про ИИ без даты",
])("do not misroute unsupported or publication-date requests to local saved-date picker: %s", q => {
  expect(savedAiArticleIntent(q,new Date(2026,10,6))).toBeNull();
});
test("attachments are never consumed by a text-only shortlist",()=>{
  expect(savedAiArticleIntent("Найди статьи про ИИ за неделю",new Date(2026,10,6),true)).toBeNull();
});
