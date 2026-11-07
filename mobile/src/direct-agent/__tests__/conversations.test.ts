import { beginTask } from "../task-state";
import { conversationRepository, parseConversation } from "../conversations";
import { SCHEMA_SQL, withLocalMemoryDatabase } from "../../local-memory/storage";
jest.mock("../../local-memory/storage", () => ({ ...jest.requireActual("../../local-memory/storage"), withLocalMemoryDatabase: jest.fn() }));
const { DatabaseSync } = require("node:sqlite");

test("actual SQL preserves attachments, sources and proposals across reopen, keeps profiles separate, and deletes only the chosen chat", async () => {
  const databases = new Map<string, any>();
  (withLocalMemoryDatabase as jest.Mock).mockImplementation(async (profile, work) => {
    if (!databases.has(profile)) { const db = new DatabaseSync(":memory:"); db.exec(SCHEMA_SQL); databases.set(profile, db); }
    const db = databases.get(profile);
    return work({
      getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
      runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
    });
  });
  const guest = conversationRepository("guest");
  const file = {id:"file",name:"note.txt",kind:"text" as const,mime:"text/plain",data:"Text",size:12};
  const conversation = { attachments:[file], id: "first", title: "Рецепт", createdAt: "2026-10-13T09:00:00Z", updatedAt: "2026-10-13T09:00:00Z", question: "",
    rows: [{ id: "u", role: "user" as const, text: "Что приготовить?", attachments:[file] }, { id: "a", role: "assistant" as const, text: "Пасту", sources: ["https://example.org"] }],
    drafts: [{ id: "d", title: "Рецепт", body: "Паста" }], taskState: { ...beginTask(undefined, "Ужин"), selection: "Паста", webPreference: "deny" as const } };
  await guest.save(conversation);
  await guest.save({ ...conversation, title: "Любимый рецепт", updatedAt: "2026-10-13T10:00:00Z" });
  await guest.save({ ...conversation, id: "second", title: "Другой диалог" });
  const reopened = conversationRepository("guest");
  expect((await reopened.load())[0]).toMatchObject({ id: "first", title: "Любимый рецепт", attachments:[file], rows: conversation.rows, drafts: conversation.drafts, taskState: conversation.taskState });
  expect(await conversationRepository("account").load()).toEqual([]);
  await reopened.remove("first"); expect((await reopened.load()).map(c => c.id)).toEqual(["second"]);
  for (const db of databases.values()) db.close();
});

test("one damaged chat does not hide the others and intact messages are kept", async () => {
  const db = new DatabaseSync(":memory:"); db.exec(SCHEMA_SQL);
  (withLocalMemoryDatabase as jest.Mock).mockImplementation(async (_profile, work) => work({
    getAllAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
    runAsync: async (sql: string, params: unknown[] = []) => db.prepare(sql).run(...params),
  }));
  const insert = db.prepare("INSERT INTO direct_conversations(id,title,snapshot_json,created_at,updated_at) VALUES (?,?,?,?,?)");
  insert.run("broken", "x", "{not json", "2026-10-14", "2026-10-14T12:00:00Z");
  insert.run("partly", "Частично", JSON.stringify({ id: "partly", title: "Частично", createdAt: "2026-10-14", updatedAt: "2026-10-14T11:00:00Z",
    rows: [{ id: "ok", role: "user", text: "Целое сообщение", sources: ["https://example.org", "http://bad.test"] }, { id: 5, role: "user" }, null],
    drafts: [{ id: "d", title: "Заметка", body: "Текст" }, { id: "bad" }], question: 3 }), "2026-10-14", "2026-10-14T11:00:00Z");
  insert.run("fine", "Целый", JSON.stringify({ id: "fine", title: "Целый", createdAt: "2026-10-13", updatedAt: "2026-10-13T10:00:00Z", rows: [], drafts: [], question: "" }), "2026-10-13", "2026-10-13T10:00:00Z");
  const skipped = jest.fn();
  const loaded = await conversationRepository("guest", skipped).load();
  expect(loaded.map(c => c.id)).toEqual(["partly", "fine"]);
  expect(loaded[0].rows).toEqual([{ id: "ok", role: "user", text: "Целое сообщение", sources: ["https://example.org"] }]);
  expect(loaded[0].drafts).toEqual([{ id: "d", title: "Заметка", body: "Текст" }]);
  expect(loaded[0].question).toBe("");
  expect(skipped).toHaveBeenCalledWith(1);
  // The unreadable record is left in place for a future repair, never deleted.
  expect(db.prepare("SELECT count(*) AS n FROM direct_conversations").get().n).toBe(3);
  db.close();
});

test("photo search turn retains up to 20 distinct originals across reopen",()=>{
  const memory=Array.from({length:20},(_,i)=>({
    id:"one-note",title:"Коллекция велосипеда",via:"search",photo:true,photoAttachmentId:"photo-"+i,
  }));
  const c=parseConversation(JSON.stringify({
    id:"multi",title:"Поиск",createdAt:"2026-10-31",updatedAt:"2026-10-31",
    question:"",drafts:[],rows:[{id:"answer",role:"assistant",text:"Найдено фото",memory}],
  }));
  expect(c?.rows[0].memory?.map(m=>m.photoAttachmentId)).toEqual(memory.map(m=>m.photoAttachmentId));
});

test("9B: article selection handles survive encrypted conversation reopen and reject unsafe IDs",()=>{
  const page={kind:"saved_topic_links",topic:"космос",queryTerms:["космос"],
    savedFrom:"2026-10-31T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z",
    startLocal:"2026-10-31",endLocal:"2026-11-06",
    selected:[{id:"article-01",version:3},{id:"article-02",version:7}],
  };
  const chat={id:"articles",title:"Подборка",createdAt:"2026-11-06",updatedAt:"2026-11-06",
    question:"",drafts:[],rows:[{id:"answer",role:"assistant",text:"Две статьи",articlePage:page}]};
  const restored=parseConversation(JSON.stringify(chat));
  expect(restored?.rows[0].articlePage).toMatchObject(page);
  const altered=JSON.parse(JSON.stringify(chat));
  altered.rows[0].articlePage.selected=[{id:"article-01",version:3},{id:"../sensitive",version:1}];
  const unsafe=parseConversation(JSON.stringify(altered));
  expect(unsafe?.rows[0].articlePage?.selected).toBeUndefined();
  expect(unsafe?.rows[0].articlePage?.topic).toBe("космос");
  const repeated=JSON.parse(JSON.stringify(chat));
  repeated.rows[0].articlePage.selected=[{id:"article-01",version:3},{id:"article-01",version:4}];
  expect(parseConversation(JSON.stringify(repeated))?.rows[0].articlePage?.selected).toBeUndefined();
});


test("9C: answer keeps validated selected-article provenance across conversation reopen",()=>{
  const page={kind:"saved_topic_links",topic:"космос",queryTerms:["космос"],
    savedFrom:"2026-10-31T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z",
    startLocal:"2026-10-31",endLocal:"2026-11-06",
    selected:[{id:"note-1",version:2},{id:"note-2",version:4},{id:"note-3",version:1}],
  };
  const report={kind:"selected_saved_note_reads",selectedCount:3,
    entries:[
      {selectedIndex:0,id:"note-1",version:2,status:"complete_saved_note_text",
        verifiedChars:7000,totalChars:7000,title:"Первая статья"},
      {selectedIndex:1,id:"note-2",version:4,status:"partial_saved_note",
        verifiedChars:6000,totalChars:13000,title:"Длинная статья"},
      {selectedIndex:2,id:"note-3",version:1,status:"unread",verifiedChars:0},
    ],
  };
  const fixture={id:"chat",title:"Сводка",createdAt:"2026-11-06",updatedAt:"2026-11-06",
    question:"",drafts:[],rows:[{id:"answer",role:"assistant",text:"Выжимка",
      articlePage:page,articleReadReport:report}]};
  const saved=parseConversation(JSON.stringify(fixture));
  expect(saved?.rows[0].articleReadReport).toEqual(report);
  expect(saved?.rows[0].articlePage?.selected).toEqual(page.selected);

  const tampered=(change:(value:any)=>void)=>{
    const value=JSON.parse(JSON.stringify(fixture));change(value);
    const restored=parseConversation(JSON.stringify(value));
    expect(restored?.rows[0].text).toBe("Выжимка");
    expect(restored?.rows[0].articleReadReport).toBeUndefined();
  };
  tampered(v=>{v.rows[0].articleReadReport.entries[0].id="private-note";});
  tampered(v=>{v.rows[0].articleReadReport.entries[0].version=3;});
  tampered(v=>{v.rows[0].articleReadReport.entries[1].status="complete_saved_note_text";});
  tampered(v=>{v.rows[0].articleReadReport.entries[1].verifiedChars=99999;});
  tampered(v=>{v.rows[0].articleReadReport.entries[2].verifiedChars=1;});
  tampered(v=>{v.rows[0].articleReadReport.selectedCount=4;});
  tampered(v=>{v.rows[0].articleReadReport.entries.reverse();});
  tampered(v=>{v.rows[0].articlePage.selected[1].id="../escape";});
  tampered(v=>{v.rows[0].articleReadReport.entries[0].title="x".repeat(200);});
});


test("9C: in-text source offsets survive SQLCipher reopening only with valid read spans",()=>{
  const page={kind:"saved_topic_links",topic:"космос",queryTerms:["космос"],
    savedFrom:"2026-10-31T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z",
    startLocal:"2026-10-31",endLocal:"2026-11-06",
    selected:[{id:"first",version:2},{id:"second",version:4},{id:"third",version:6}],
  };
  const report={kind:"selected_saved_note_reads",selectedCount:3,
    entries:[
      {selectedIndex:0,id:"first",version:2,title:"Первая",status:"complete_saved_note_text",
        verifiedChars:7000,totalChars:7000,ranges:[{startChar:0,endChar:7000}]},
      {selectedIndex:1,id:"second",version:4,title:"Вторая",status:"partial_saved_note",
        verifiedChars:5500,totalChars:9000,ranges:[
          {startChar:0,endChar:1500},{startChar:5000,endChar:9000}]},
      {selectedIndex:2,id:"third",version:6,status:"link_only",
        verifiedChars:20,totalChars:20,ranges:[{startChar:0,endChar:20}]},
    ],
  };
  const fixture={id:"chat",title:"Источники",createdAt:"2026-11-06",
    updatedAt:"2026-11-06",question:"",drafts:[],
    rows:[{id:"answer",role:"assistant",
      text:"Первое [[S1:100-200]] и второе [[S2:6000-7000]]",articlePage:page,
      articleReadReport:report}]};
  const restored=parseConversation(JSON.stringify(fixture));
  expect(restored?.rows[0].articleReadReport).toEqual(report);
  const mutates=[
    (v:any)=>{v.rows[0].articleReadReport.entries[1].ranges[1].startChar=1400;},
    (v:any)=>{v.rows[0].articleReadReport.entries[1].ranges[0].endChar=6500;},
    (v:any)=>{v.rows[0].articleReadReport.entries[1].ranges[1].endChar=9001;},
    (v:any)=>{v.rows[0].articleReadReport.entries[1].ranges[0].endChar=-3;},
    (v:any)=>{v.rows[0].articleReadReport.entries[0].ranges[0].startChar=50;},
    (v:any)=>{v.rows[0].articleReadReport.entries[0].ranges[0].endChar=6999;},
    (v:any)=>{v.rows[0].articleReadReport.entries[1].ranges[1].startChar=5001;},
    (v:any)=>{v.rows[0].articleReadReport.entries[1].ranges=Array.from({length:129},(_,i)=>(
      {startChar:i*2,endChar:i*2+1}));},
    (v:any)=>{v.rows[0].articleReadReport.entries[1].ranges=[{startChar:0,endChar:9000}];},
    (v:any)=>{v.rows[0].articleReadReport.entries[2].ranges=[{startChar:0,endChar:21}];},
  ];
  for(const mutate of mutates){
    const copy=JSON.parse(JSON.stringify(fixture));
    mutate(copy);
    const row=parseConversation(JSON.stringify(copy))?.rows[0];
    expect(row?.text).toBe(fixture.rows[0].text);
    expect(row?.articleReadReport).toBeUndefined();
  }
  // Old answers without detailed ranges are preserved, but cannot produce
  // clickable claim references until a real new canonical read.
  const legacy=JSON.parse(JSON.stringify(fixture));
  for(const e of legacy.rows[0].articleReadReport.entries)delete e.ranges;
  expect(parseConversation(JSON.stringify(legacy))?.rows[0].articleReadReport)
    .toMatchObject({selectedCount:3});
});

test("chat context is backward compatible and each turn preserves its own historical section",()=>{
  const old={id:"old",title:"Диалог",createdAt:"2026-11-07T10:00:00Z",
    updatedAt:"2026-11-07T11:00:00Z",rows:[{id:"u",role:"user",text:"Привет"}],drafts:[],question:""};
  expect(parseConversation(JSON.stringify(old))?.context).toBeUndefined();
  const mixed={...old,context:{topic:"Лазанья",sectionSlug:"recipes",pinned:true},
    rows:[...old.rows,{id:"a",role:"assistant",text:"Аккумулятор",contextChange:{
      topic:"Аккумулятор",sectionSlug:"cars",previousTopic:null,
      previousSectionSlug:null,sectionName:"Авто",previousSectionName:null,
      reason:"Вопрос про автомобиль",at:"2026-11-07T10:10:00Z"}},
      {id:"b",role:"assistant",text:"Рецепт",contextChange:{
        topic:"Лазанья",sectionSlug:"recipes",previousTopic:"Аккумулятор",
        previousSectionSlug:"cars",sectionName:"Рецепты",previousSectionName:"Авто",
        reason:"Смена темы",at:"2026-11-07T11:00:00Z"}}]};
  const restored=parseConversation(JSON.stringify(mixed))!;
  expect(restored.context).toEqual(mixed.context);
  expect(restored.rows.filter(r=>r.contextChange)).toHaveLength(2);
  const malformed={...mixed,context:{topic:"",sectionSlug:"../../docs",pinned:true}};
  expect(parseConversation(JSON.stringify(malformed))?.context).toBeUndefined();
  expect(parseConversation(JSON.stringify(malformed))?.rows).toHaveLength(3);
});
