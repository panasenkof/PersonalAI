import * as Crypto from "expo-crypto";
import { findAllowedDuplicateCandidates, normalizedDuplicateText,
  DUPLICATE_SCAN_LIMIT } from "../agent-catalog";

jest.mock("expo-crypto",()=>({
  CryptoDigestAlgorithm:{SHA256:"SHA-256"},
  digestStringAsync:jest.fn(async (_algorithm:string,input:string)=>"hash-"+
    Array.from(input).reduce((h,c)=>((h*31+c.codePointAt(0)!)>>>0),0).toString(16)),
}));

const entry=(id:string,version:number,body:string,section="Проекты")=>({
  id,version,title:"Название "+id,section,collection_id:"ordinary-id",
  attachment_count:id==="n1"?2:0,
  payload_json:JSON.stringify({body,tags:id==="n1"?["Идея"]:["Планы"]}),
});
const query=(db: {getAllAsync:jest.Mock},kind:"same_url"|"same_text",limit=10)=>
  findAllowedDuplicateCandidates(db as never,kind,limit);
beforeEach(()=>jest.clearAllMocks());

test("S9-2a: normalization ignores case and whitespace, not different content",()=>{
  expect(normalizedDuplicateText({body:"  ПРИВЕТ \n  мир  "})).toBe("привет мир");
  expect(normalizedDuplicateText({body:"привет мир"})).toBe("привет мир");
  expect(normalizedDuplicateText({body:"привет мир!",tags:["x"]})).not.toBe("привет мир");
  expect(normalizedDuplicateText({source_url:"https://example.org",tags:["x"]})).toBe("");
});

test("S9-2a: same text is SHA-256-only locally; model sees metadata, not bodies",async()=>{
  const rows=[
    entry("n1",3,"  НОВАЯ   заметка  "),
    entry("n2",4,"новая заметка"),
    entry("n3",7,"Другое содержание"),
  ];
  const db={getAllAsync:jest.fn(async()=>rows)};
  const result=await query(db,"same_text");
  expect(result).toMatchObject({
    scope:"standard_active_notes",kind:"same_text",
    scanned:3,partial:false,hasMoreGroups:false,contentIncluded:false,
  });
  expect(result.groups).toHaveLength(1);
  expect(result.groups[0]).toMatchObject({
    totalCount:2,complete:true,
    records:[{id:"n1",version:3,attachmentCount:2,tagCount:1},{id:"n2",version:4}],
  });
  expect(JSON.stringify(result)).not.toContain("НОВАЯ   заметка");
  expect(JSON.stringify(result)).not.toContain("новая заметка");
  expect(Crypto.digestStringAsync).toHaveBeenCalledWith("SHA-256","text:новая заметка");
  const sql=db.getAllAsync.mock.calls[0][0] as string;
  expect(sql).toContain("e.record_status='active'");
  expect(sql).toContain("e.domain='notes'");
  expect(sql).toContain("e.sensitivity IN ('standard','inherit')");
  expect(sql).toContain("c.sensitivity='standard'");
  expect(sql).toContain("WITH RECURSIVE safe");
  expect(sql).toContain("parent_id IS NULL");
  expect(db.getAllAsync.mock.calls[0][1]).toEqual([DUPLICATE_SCAN_LIMIT+1]);
});

test("S9-2a: exact URL groups use existing source_url and do not include arbitrary note bodies",async()=>{
  const groupRows=[entry("a",2,"Что-то про статью"),entry("b",8,"Другой текст")];
  const db={getAllAsync:jest.fn(async (sql:string)=>{
    if(sql.includes("GROUP BY match_value"))
      return [{match_value:"https://example.com/article",match_count:2}];
    return groupRows;
  })};
  const result=await query(db,"same_url",2);
  expect(result.groups).toMatchObject([
    {sourceUrl:"https://example.com/article",totalCount:2,complete:true,
      records:[{id:"a",version:2},{id:"b",version:8}]},
  ]);
  expect(result.groups[0].fingerprint).toBe(await Crypto.digestStringAsync(
    "SHA-256","url:https://example.com/article"));
  expect(JSON.stringify(result)).not.toContain("Что-то про статью");
  expect(db.getAllAsync.mock.calls[0][0]).toContain("json_extract(e.payload_json,'$.source_url')");
  expect(db.getAllAsync.mock.calls[1][0]).toContain(" AND CASE WHEN json_valid");
  expect(db.getAllAsync.mock.calls[1][1]).toEqual(["https://example.com/article"]);
});

test("S9-2a: a six-note URL group is shown but cannot be merged as complete",async()=>{
  const db={getAllAsync:jest.fn(async (sql:string)=>{
    if(sql.includes("GROUP BY match_value"))
      return [{match_value:"https://example.com",match_count:6}];
    return Array.from({length:5},(_,i)=>entry("n"+i,2,"text"));
  })};
  const result=await query(db,"same_url");
  expect(result.groups[0].records).toHaveLength(5);
  expect(result.groups[0]).toMatchObject({totalCount:6,complete:false});
  expect(result.partial).toBe(true);
});

test("S9-2a: bounded text scan cannot claim full coverage or authorize a merge",async()=>{
  const rows=Array.from({length:DUPLICATE_SCAN_LIMIT+1},(_,i)=>entry(
    "n"+i,1,i<2?"КОРОТКИЙ ТЕКСТ":"Уникальный текст "+i));
  const db={getAllAsync:jest.fn(async()=>rows)};
  const result=await query(db,"same_text");
  expect(result.scanned).toBe(DUPLICATE_SCAN_LIMIT);
  expect(result.partial).toBe(true);
  expect(result.groups[0].complete).toBe(false);
});

test("S9-2a: malformed, unsupported and overlimit requests fail closed",async()=>{
  const db={getAllAsync:jest.fn(async()=>[])};
  for(const [kind,limit] of [["semantic",10],["same_url",11],["same_text",0],
    ["same_text",1.5]] as const)
    await expect(findAllowedDuplicateCandidates(db as never,kind as any,limit))
      .rejects.toThrow("invalid_duplicate_candidate_query");
  expect(db.getAllAsync).not.toHaveBeenCalled();
});
