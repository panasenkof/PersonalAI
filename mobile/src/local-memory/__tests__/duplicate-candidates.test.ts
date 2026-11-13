import {findDuplicateCandidates, normalizeDuplicateText} from "../duplicate-candidates";
import {localMemorySessionUnlocked} from "../storage";

jest.mock("expo-crypto",()=>({
  CryptoDigestAlgorithm:{SHA256:"SHA-256"},
  digestStringAsync:jest.fn(async (_algorithm:string,value:string)=>
    require("node:crypto").createHash("sha256").update(value).digest("hex")),
}));
jest.mock("../storage",()=>({
  ...jest.requireActual("../storage"),
  localMemorySessionUnlocked:jest.fn(()=>true),
}));
const {DatabaseSync}=require("node:sqlite");
const {SCHEMA_SQL}=require("../storage");

class SqliteFixture {
  sqlite=new DatabaseSync(":memory:");
  constructor(){
    this.sqlite.exec(SCHEMA_SQL);
    for(const [id,parent,sensitivity] of [
      ["regular",null,"standard"],["secret",null,"secret"],
      ["private-child","secret","standard"],["public-child","regular","standard"],
    ]){
      this.sqlite.prepare(
        "INSERT INTO memory_collections(id,name,slug,sensitivity,created_at,parent_id) VALUES (?,?,?,?,?,?)",
      ).run(id,id,id,sensitivity,"2026-11-13",parent);
    }
  }
  add(id:string,col:string,body:string,url:string,
      status="active",sensitivity="inherit",version=1){
    this.sqlite.prepare(`INSERT INTO memory_entities(
      id,collection_id,domain,title,payload_json,record_status,sensitivity,
      created_at,updated_at,record_version,kind)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        id,col,"notes","Заголовок "+id,JSON.stringify({
          body,source_url:url,tags:["проект"],
        }),status,sensitivity,"2026-11-13","2026-11-13",version,"note");
  }
  async getAllAsync<T>(sql:string,params:unknown[]=[]):Promise<T[]>{
    return this.sqlite.prepare(sql).all(...params) as T[];
  }
  close(){this.sqlite.close();}
}
beforeEach(()=>{(localMemorySessionUnlocked as jest.Mock).mockReturnValue(true);});

test("S9-2a: exact URL groups use canonical public scope, never leak ancestors or text",async()=>{
  const db=new SqliteFixture();
  try{
    db.add("a","regular","Личный текст 1","https://example.org/post");
    db.add("b","public-child","Личный текст 2","https://example.org/post","active","standard",2);
    db.add("c","regular","Личный текст 3","https://example.org/post");
    db.add("hidden","private-child","Скрытый текст","https://example.org/post");
    db.add("secret","secret","Закрытый текст","https://example.org/post");
    db.add("sensitive","regular","Чувствительное","https://example.org/post","active","sensitive");
    db.add("archived","regular","Архивное","https://example.org/post","archived");
    db.add("trashed","regular","Удалённое","https://example.org/post","trashed");
    db.add("other","regular","Оригинальное","https://example.org/different");
    const result=await findDuplicateCandidates(db as never,"same_url",10);
    expect(result).toMatchObject({kind:"same_url",scope:"standard_active_notes",
      contentIncluded:false,scanTruncated:false,moreGroups:false});
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].totalMatches).toBe(3);
    expect(result.groups[0].notes.map(x=>x.noteId)).toEqual(["a","b","c"]);
    expect(result.groups[0].notes[1]).toMatchObject({
      expectedVersion:2,section:"public-child",attachmentCount:0,tagCount:1,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /Личный текст|Скрытый|Закрытый|Чувствительное|https:\/\//u);
  }finally{db.close();}
});

test("S9-2a: same_text is SHA-256 of NFC, whitespace-folded, lowercase on device",async()=>{
  const db=new SqliteFixture();
  try{
    db.add("a","regular","  МОЛОКО \n   свежее  ","https://example.org/1");
    db.add("b","regular","молоко свежее","https://example.org/2");
    db.add("c","regular","Молоко не свежее","https://example.org/3");
    db.add("d","regular","","https://example.org/4");
    db.add("hidden","private-child","МОЛОКО СВЕЖЕЕ","https://example.org/5");
    const result=await findDuplicateCandidates(db as never,"same_text",10);
    expect(result.groups.map(group=>group.notes.map(note=>note.noteId))).toEqual([["a","b"]]);
    expect(result.groups[0].totalMatches).toBe(2);
    expect(normalizeDuplicateText("  Два\n СЛОВА ")).toBe("два слова");
    expect(JSON.stringify(result)).not.toMatch(/молоко|example.org|hidden/u);
  }finally{db.close();}
});

test("S9-2a: max five handles per group and ten groups, no auto merge",async()=>{
  const db=new SqliteFixture();
  try{
    for(let i=0;i<7;i++)db.add("dup"+i,"regular","Текст "+i,"https://same.example/item");
    for(let i=0;i<2;i++)db.add("extra"+i,"regular","Другой "+i,"https://different.example/item");
    const result=await findDuplicateCandidates(db as never,"same_url",1);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({totalMatches:7});
    expect(result.groups[0].notes).toHaveLength(5);
    expect(result.moreGroups).toBe(true);
  }finally{db.close();}
});

test("S9-2a: invalid kind/limit and locking fail closed",async()=>{
  const db=new SqliteFixture();
  try{
    await expect(findDuplicateCandidates(db as never,"same_url",11))
      .rejects.toThrow("invalid_duplicate_limit");
    await expect(findDuplicateCandidates(db as never,"same_fuzzy" as never,3))
      .rejects.toThrow("invalid_duplicate_kind");
    (localMemorySessionUnlocked as jest.Mock).mockReturnValue(false);
    await expect(findDuplicateCandidates(db as never,"same_text",2))
      .rejects.toThrow("application_locked");
  }finally{db.close();}
});
