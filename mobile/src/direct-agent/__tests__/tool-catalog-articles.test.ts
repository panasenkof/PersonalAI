import { createToolCatalog } from "../tool-catalog";
import type { DirectAgentSettings } from "../settings";

const settings: DirectAgentSettings = {
  provider: "openai", baseUrl: "https://api.openai.com/v1", model: "test-model",
  apiKey: "test", webSearchKey: "", allowWeb: false,
};
const request = { topic: "ИИ", period: "last7days", dateMode: "published",
  beforeCreatedAt: null, beforeId: null };
const page = {
  scope: "standard_active_saved_links" as const,
  matchMode: "one_of_fts_phrases" as const, count: 10,
  records: [{ id: "note-1", version: 3, title: "ИИ сегодня", section: "Статьи",
    createdAt: "2026-09-01T12:00:00.000Z", publicationDay: "2026-11-05",
    duplicateCount: 1 }],
  hasMore: true,
  nextCursor: { beforeCreatedAt: "2026-09-01T12:00:00.000Z", beforeId: "note-1" },
  unknownPublicationCount: 4,
};
function harness(enabled = true) {
  const selectArticles = jest.fn().mockResolvedValue(page);
  const opts = { settings, prompt: "Обобщи мои статьи об ИИ за неделю",
    history: [], lookup: jest.fn().mockResolvedValue([]),
    propose: jest.fn(), ...(enabled ? {selectArticles} : {}) };
  return { selectArticles, catalog: createToolCatalog(opts, [], [], []) };
}

test("9T0 availability: tool is absent without authorized application adapter", async () => {
  const { catalog, selectArticles } = harness(false);
  expect(catalog.definitions.some(x => x.name === "select_local_articles")).toBe(false);
  expect(await catalog.run("select_local_articles", request)).toEqual({ error: "tool_not_allowed" });
  expect(selectArticles).not.toHaveBeenCalled();
});

test("9T1: one model call gets only ACL-scoped article metadata, count, evidence and handle for full read", async () => {
  const {catalog,selectArticles}=harness();
  expect(catalog.definitions.some(x=>x.name==="select_local_articles")).toBe(true);
  const result=await catalog.run("select_local_articles",request);
  expect(selectArticles).toHaveBeenCalledWith(expect.objectContaining({
    dateMode:"published",topic:"ai",queryTerms:expect.arrayContaining(["нейросеть"]),
  }),undefined);
  expect(result).toMatchObject({
    outcome:"found",count:10,hasMore:true,contentIncluded:false,
    unknownPublicationCount:4,selection:{dateMode:"published",
      dateEvidence:"html_meta_source_claim"},
    records:[{id:"note-1",version:3,publicationDay:"2026-11-05"}],
  });
  expect(JSON.stringify(result)).not.toContain("body");
  expect(JSON.stringify(result)).not.toContain("source_url");
});

test("9T1: no broadening for invalid topic/cursor/unknown args; no extra calls", async () => {
  const {catalog,selectArticles}=harness();
  expect(await catalog.run("select_local_articles",{...request,topic:"ИИ кроме чего-то"}))
    .toMatchObject({error:"invalid_article_tool_arguments"});
  expect(await catalog.run("select_local_articles",{...request,extra:"unsafe"}))
    .toMatchObject({error:"invalid_article_tool_arguments"});
  expect(await catalog.run("select_local_articles",{...request,beforeCreatedAt:"2026-09-01T12:00:00.000Z"}))
    .toMatchObject({error:"invalid_article_cursor"});
  expect(await catalog.run("select_local_articles",{...request,beforeCreatedAt:"not-a-date",beforeId:"note-1"}))
    .toMatchObject({error:"invalid_article_cursor"});
  expect(selectArticles).not.toHaveBeenCalled();
});

test("9T1: bounded pages, repeated cursor and failed ACL reader are fail-closed", async () => {
  const {catalog,selectArticles}=harness();
  const first=await catalog.run("select_local_articles",request);
  expect(first).toMatchObject({outcome:"found"});
  expect(await catalog.run("select_local_articles",request))
    .toMatchObject({error:"article_page_already_requested"});
  const cursor=(id:string)=>({...request,beforeCreatedAt:"2026-09-01T12:00:00.000Z",beforeId:id});
  expect(await catalog.run("select_local_articles",cursor("note-1"))).toMatchObject({outcome:"found"});
  expect(await catalog.run("select_local_articles",cursor("note-2"))).toMatchObject({outcome:"found"});
  expect(await catalog.run("select_local_articles",cursor("note-3")))
    .toMatchObject({error:"article_page_budget_exhausted"});
  expect(selectArticles).toHaveBeenCalledTimes(3);
  const denied=harness();
  denied.selectArticles.mockRejectedValueOnce(new Error("application_locked"));
  expect(await denied.catalog.run("select_local_articles",request))
    .toMatchObject({error:"tool_failed_or_unavailable"});
});

test("9T1: empty is not invented as a read article", async () => {
  const {catalog,selectArticles}=harness();
  selectArticles.mockResolvedValueOnce({...page,count:0,records:[],hasMore:false,nextCursor:undefined});
  const result=await catalog.run("select_local_articles",{...request,dateMode:"saved"});
  expect(result).toMatchObject({outcome:"empty",count:0,records:[],contentIncluded:false});
});
