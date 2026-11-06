import { countAllowedNotes, listAllowedNotes } from "../agent-catalog";
const { DatabaseSync } = require("node:sqlite");
const { SCHEMA_SQL } = require("../storage");
class Db {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    this.sqlite.exec(SCHEMA_SQL);
    for (const [id, sensitivity] of [["c-standard", "standard"], ["c-secret", "secret"]]) {
      this.sqlite.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES (?,?,?,?,?)")
        .run(id, id, id, sensitivity, "2026-01-01");
    }
  }
  add(id: string, col: string, status: string, sensitivity: string, title: string, updated: string) {
    this.sqlite.prepare(`INSERT INTO memory_entities(
      id,collection_id,domain,title,payload_json,record_status,sensitivity,created_at,updated_at,record_version,kind)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, col, "notes", title, JSON.stringify({ body: title }), status, sensitivity,
        "2025-01-01", updated, 1, "note");
    this.sqlite.prepare("INSERT INTO memory_search_fts(entity_id,chunk_id,title,body,terms,aliases) VALUES (?,?,?,?,?,?)")
      .run(id, id + ":0", title, title, "", "");
  }
  async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T|null> {
    return (this.sqlite.prepare(sql).get(...params) as T) || null;
  }
  async getAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.sqlite.prepare(sql).all(...params) as T[];
  }
}
test("exact filtered count excludes private, secret, archived and trashed data", async () => {
  const db = new Db();
  db.add("a", "c-standard", "active", "standard", "Квитанция январь", "2026-10-05T00:00:00Z");
  db.add("b", "c-standard", "active", "inherit", "Квитанция март", "2026-10-04T00:00:00Z");
  db.add("c", "c-standard", "active", "sensitive", "Квитанция секрет", "2026-10-03T00:00:00Z");
  db.add("d", "c-secret", "active", "standard", "Квитанция тайна", "2026-10-02T00:00:00Z");
  db.add("e", "c-standard", "archived", "standard", "Квитанция архив", "2026-10-01T00:00:00Z");
  expect(await countAllowedNotes(db as never)).toEqual({
    count: 2, scope: "standard_active_notes", matchMode: "all_allowed",
  });
  expect(await countAllowedNotes(db as never, { query: "Квитанция" })).toEqual({
    count: 2, scope: "standard_active_notes", matchMode: "exact_fts_phrase",
  });
  expect((await listAllowedNotes(db as never)).records.map(v => v.id)).toEqual(["a", "b"]);
  expect(await countAllowedNotes(db as never, { collectionId: "c-secret" })).toMatchObject({ count: 0 });
});

test("list is keyset-paged, no bodies leave SQLCipher and count ignores cursor", async () => {
  const db = new Db();
  for (let i = 0; i < 5; i++) db.add(String(i), "c-standard", "active", "standard",
    "Рецепт " + i, "2026-10-0" + (i+1) + "T00:00:00Z");
  const first = await listAllowedNotes(db as never, { limit: 2 });
  expect(first.records.map(x => x.id)).toEqual(["4","3"]);
  expect(first.contentIncluded).toBe(false);
  expect(JSON.stringify(first)).not.toContain("payload_json");
  expect(first.nextCursor).toBeDefined();
  const next = await listAllowedNotes(db as never, { limit: 2, ...first.nextCursor });
  expect(next.records.map(x => x.id)).toEqual(["2","1"]);
  expect((await countAllowedNotes(db as never)).count).toBe(5);
  await expect(listAllowedNotes(db as never, { limit: 100 })).rejects.toThrow("invalid_catalog_limit");
  await expect(listAllowedNotes(db as never, { beforeId: "1" })).rejects.toThrow("invalid_catalog_cursor");
});

test("stage 9A searches only dated active standard saved links with an exact scoped count", async () => {
  const db = new Db();
  for (const [id,col,status,sensitivity,title,created,source] of [
    ["a","c-standard","active","inherit","Нейросети сегодня","2026-11-06T10:00:00.000Z","https://example.org/a"],
    ["b","c-standard","active","standard","Искусственный интеллект вчера","2026-11-04T10:00:00.000Z","https://example.org/b"],
    ["c","c-standard","active","standard","Нейросети старые","2026-10-25T10:00:00.000Z","https://example.org/c"],
    ["d","c-secret","active","standard","Нейросети тайна","2026-11-06T10:00:00.000Z","https://example.org/d"],
    ["e","c-standard","active","sensitive","Нейросети секрет","2026-11-06T10:00:00.000Z","https://example.org/e"],
    ["f","c-standard","trashed","standard","Нейросети мусор","2026-11-06T10:00:00.000Z","https://example.org/f"],
    ["g","c-standard","active","standard","Нейросети без ссылки","2026-11-06T10:00:00.000Z",""],
    ["h","c-standard","active","standard","Ремонт автомобиля","2026-11-06T10:00:00.000Z","https://example.org/h"],
  ] as string[][]) {
    db.add(id,col,status,sensitivity,title,"2026-11-06T11:00:00.000Z");
    db.sqlite.prepare("UPDATE memory_entities SET created_at=?,payload_json=? WHERE id=?")
      .run(created,JSON.stringify({body:title,...(source?{source_url:source}:{})}),id);
  }
  const filters = {queryTerms:["ИИ","AI","нейросети","искусственный интеллект"],
    savedFrom:"2026-10-31T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z",
    linkedOnly:true,sortBySaved:true};
  expect(await countAllowedNotes(db as never,filters)).toMatchObject({count:2,matchMode:"one_of_fts_phrases"});
  const page=await listAllowedNotes(db as never,{...filters,limit:8});
  expect(page.records.map(x=>x.id)).toEqual(["a","b"]);
  expect(page.records[0].createdAt).toBe("2026-11-06T10:00:00.000Z");
  expect(JSON.stringify(page)).not.toContain("payload_json");
});

test("bounded OR-FTS rejects unsafe query terms and inconsistent date windows", async () => {
  const db = new Db();
  await expect(listAllowedNotes(db as never,{queryTerms:[]})).rejects.toThrow("invalid_catalog_query_terms");
  await expect(listAllowedNotes(db as never,{queryTerms:["neural", " "]})).rejects.toThrow("invalid_catalog_query_terms");
  await expect(listAllowedNotes(db as never,{query:"AI",queryTerms:["ИИ"]})).rejects.toThrow("invalid_catalog_query_terms");
  await expect(listAllowedNotes(db as never,{savedFrom:"2026-11-07T00:00:00.000Z",savedBefore:"2026-11-06T00:00:00.000Z"})).rejects.toThrow("invalid_catalog_date_window");
});

test("stage 9A2: saved-date paging handles tied timestamps without duplicates or omissions", async () => {
  const db = new Db();
  for (let i = 0; i < 23; i++) {
    db.add("p" + String(i).padStart(2,"0"), "c-standard", "active", "standard",
      "Нейросети " + i, "2026-11-06T13:00:00.000Z");
    db.sqlite.prepare("UPDATE memory_entities SET created_at=?,payload_json=? WHERE id=?")
      .run(i < 14 ? "2026-11-05T12:00:00.000Z" : "2026-11-04T12:00:00.000Z",
        JSON.stringify({body:"Нейросети",source_url:"https://example.org/" + i}),
        "p" + String(i).padStart(2,"0"));
  }
  const filters = {queryTerms:["нейросети"], linkedOnly:true,sortBySaved:true,
    savedFrom:"2026-11-01T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z"};
  const seen: string[] = [];
  let cursor: {beforeCreatedAt:string;beforeId:string}|undefined;
  for (let pageNum=0;pageNum<4;pageNum++) {
    const page=await listAllowedNotes(db as never,{...filters,...cursor,limit:8});
    seen.push(...page.records.map(x=>x.id));
    if (!page.hasMore) { expect(page.nextCursor).toBeUndefined(); break; }
    expect(page.nextCursor?.beforeCreatedAt).toBeDefined();
    cursor=page.nextCursor as {beforeCreatedAt:string;beforeId:string};
  }
  expect(seen).toHaveLength(23);
  expect(new Set(seen).size).toBe(23);
  expect((await countAllowedNotes(db as never,filters)).count).toBe(23);
  await expect(listAllowedNotes(db as never,{...filters,beforeCreatedAt:"bad",beforeId:"p00"}))
    .rejects.toThrow("invalid_catalog_saved_cursor");
  await expect(listAllowedNotes(db as never,{...filters,beforeId:"p00"}))
    .rejects.toThrow("invalid_catalog_saved_cursor");
  await expect(listAllowedNotes(db as never,{beforeCreatedAt:"2026-11-05T12:00:00.000Z",beforeId:"p00"}))
    .rejects.toThrow("invalid_catalog_cursor");
});

test("stage 9A3 arbitrary-topic phrase is scoped and excludes other subjects",async()=>{
  const db=new Db();
  for(const [id,col,title] of [
    ["car","c-standard","Ремонт автомобиля — замена масла"],
    ["unrelated","c-standard","Модели ИИ для телефона"],
    ["secret","c-secret","Ремонт автомобиля тайный"],
  ] as string[][]){
    db.add(id,col,"active","standard",title,"2026-11-06T10:00:00.000Z");
    db.sqlite.prepare("UPDATE memory_entities SET created_at=?,payload_json=? WHERE id=?")
      .run("2026-11-06T10:00:00.000Z",JSON.stringify({body:title,source_url:"https://example.org/"+id}),id);
  }
  const opts={queryTerms:["Ремонт автомобиля"],savedFrom:"2026-11-01T00:00:00.000Z",
    savedBefore:"2026-11-07T00:00:00.000Z",linkedOnly:true,sortBySaved:true};
  expect((await countAllowedNotes(db as never,opts)).count).toBe(1);
  expect((await listAllowedNotes(db as never,{...opts,limit:8})).records.map(x=>x.id)).toEqual(["car"]);
});
