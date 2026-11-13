import { diagnosticToolResultContent, diagnosticToolArguments } from "../tool-diagnostics";

test("approved Inbox content is never copied to diagnostics", () => {
  const sensitive = {items:[{noteId:"n1",excerpt:"СЕКРЕТНЫЙ ТЕКСТ ИЗ ВХОДЯЩИХ"}]};
  expect(diagnosticToolResultContent("list_inbox_for_triage",sensitive)).toBeUndefined();
});
test("other tool diagnostics retain existing behavior", () => {
  const result = {items:[],outcome:"empty"};
  expect(diagnosticToolResultContent("list_local_notes",result))
    .toEqual({result:JSON.stringify(result)});
  expect(diagnosticToolResultContent("request_inbox_triage_access",
    {saved:false,contentRead:false})).toEqual({
    result:JSON.stringify({saved:false,contentRead:false}),
  });
});

test("private proposal reasons/tags and read arguments do not reach diagnostic files",()=>{
  const argumentsFromModel={items:[{noteId:"n1",reason:"PRIVATE",tags:["personal"]}]};
  expect(diagnosticToolArguments("propose_inbox_triage",argumentsFromModel)).toBeUndefined();
  expect(diagnosticToolArguments("list_inbox_for_triage",{limit:10,cursor:null})).toBeUndefined();
  expect(diagnosticToolArguments("search_local_notes",{query:"hello"})).toEqual({
    arguments:JSON.stringify({query:"hello"}),
  });
});

test("S9-2a: duplicate source URLs and record IDs are never persisted to diagnostics",()=>{
  const page={groups:[{sourceUrl:"https://private-link.example",records:[{id:"note-x"}]}]};
  expect(diagnosticToolResultContent("find_duplicate_candidates",page)).toBeUndefined();
  expect(diagnosticToolArguments("find_duplicate_candidates",{kind:"same_url",limit:5}))
    .toBeUndefined();
});

test("S9-2b: unconfirmed merge handles and choices never enter diagnostic content",()=>{
  const args={noteIds:["n1","n2"],expectedVersions:[1,2],keepNoteId:"n1",reason:"Test reason"};
  expect(diagnosticToolArguments("propose_merge_notes",args)).toBeUndefined();
  expect(diagnosticToolResultContent("propose_merge_notes",{
    status:"awaiting_user_confirmation",keepNoteId:"n1",
  })).toBeUndefined();
});
