import type { CollectionRecord } from "../../local-memory/types";
import { validateInboxTriageProposal, selectInboxTriageItems } from "../inbox-triage-proposal";

const section = (id:string,slug:string,sensitivity:CollectionRecord["sensitivity"]="standard",
  parent_id:string|null=null):CollectionRecord => ({
  id,slug,name:slug,description:null,sensitivity,parent_id,
  created_at:"2026-11-13T10:00:00.000Z",
});
const sections=[
  section("in","inbox","sensitive"),section("doc","documents"),
  section("a","projects"),section("b","research","standard","a"),
  section("c","private","secret"),section("d","child","standard","c"),
  section("e","orphan","standard","missing"),
];
const ctx={sections,wasReadThisTurn:(id:string,version:number)=>id==="n1"&&version===4 || id==="n2"&&version===7};
const row=(noteId="n1",expectedVersion=4,targetSectionSlug="research")=>({
  noteId,expectedVersion,targetSectionSlug,tags:["AI","Планы"],reason:"Подходящий раздел",
});
test("S9-1c1: accepted rows are normalized, only confirmed subset is selectable",()=>{
  const proposed=validateInboxTriageProposal({items:[row(),row("n2",7,"projects")]},ctx);
  expect(proposed.items[0].tags).toEqual(["ai","планы"]);
  expect(selectInboxTriageItems(proposed,["n2"])).toEqual([proposed.items[1]]);
  expect(()=>selectInboxTriageItems(proposed,["n1","n1"])).toThrow("invalid_inbox_triage_selection");
  expect(()=>selectInboxTriageItems(proposed,[])).toThrow("invalid_inbox_triage_selection");
  expect(()=>selectInboxTriageItems(proposed,["invented"])).toThrow("inbox_triage_selection_not_proposed");
});
test("S9-1c1: no invented IDs, stale versions, duplicates, unknown keys or empty batches",()=>{
  for(const items of [
    [],[row("invented")],[row("n1",3)],[row(),row()],
    [row(),{...row("n2",7),secret:true}],
    [row(),{...row("n2",7),reason:"x"}],
    [row(),{...row("n2",7),tags:Array(6).fill("tag")}],
    Array(11).fill(0).map((_,i)=>row("unread"+i)),
  ])expect(()=>validateInboxTriageProposal({items},ctx)).toThrow();
  expect(()=>validateInboxTriageProposal({items:[row()],extra:1},ctx)).toThrow();
});
test("S9-1c1: protected, secret, orphaned and nonstandard destinations rejected",()=>{
  for(const dest of ["inbox","documents","private","child","orphan","missing"]){
    expect(()=>validateInboxTriageProposal({items:[row("n1",4,dest)]},ctx))
      .toThrow("inbox_triage_target_not_standard");
  }
});
test("S9-1c1: invalid tags and reader revocation fail closed",()=>{
  expect(()=>validateInboxTriageProposal({items:[{...row(),tags:["abc!"]}]},ctx))
    .toThrow("invalid_inbox_triage_tags");
  expect(()=>validateInboxTriageProposal({items:[row()]},{
    ...ctx,wasReadThisTurn:()=>false,
  })).toThrow("inbox_triage_note_not_read_this_turn");
});
