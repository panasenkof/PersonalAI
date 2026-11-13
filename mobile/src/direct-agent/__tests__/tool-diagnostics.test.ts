import { diagnosticToolResultContent } from "../tool-diagnostics";

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
