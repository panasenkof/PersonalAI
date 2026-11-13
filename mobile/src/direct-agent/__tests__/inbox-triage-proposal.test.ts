import { checkedInboxTriageProposal } from "../inbox-triage-proposal";
import type { MemorySection } from "../fact-tool";

const sections:MemorySection[]=[
  {slug:"projects",name:"Проекты"},{slug:"notes",name:"Заметки"},
  {slug:"documents",name:"Документы"},{slug:"inbox",name:"Входящие"},
];
const suggestion=(overrides:Record<string,unknown>={})=>({
  noteId:"note1",expectedVersion:3,targetSectionSlug:"projects",
  tags:["AI","план"],reason:"Относится к проекту",...overrides,
});
const authorized=jest.fn((id:string,version:number)=>id==="note1"&&version===3);

beforeEach(()=>authorized.mockClear());

test("S9-1c: one verified read handle becomes an inert proposal, never a write",()=>{
  const value=checkedInboxTriageProposal([suggestion()],sections,authorized);
  expect(value).toEqual({kind:"inbox_triage",requiresUserTap:true,saved:false,
    items:[{noteId:"note1",expectedVersion:3,targetSectionSlug:"projects",
      tags:["ai","план"],reason:"Относится к проекту"}]});
  expect(authorized).toHaveBeenCalledWith("note1",3);
});
test("S9-1c: forbid model-invented IDs, stale versions and duplicate rows",()=>{
  for(const bad of [suggestion({noteId:"forged"}),suggestion({expectedVersion:4})])
    expect(()=>checkedInboxTriageProposal([bad],sections,authorized))
      .toThrow("inbox_triage_note_not_read_this_turn");
  expect(()=>checkedInboxTriageProposal([suggestion(),suggestion()],sections,authorized))
    .toThrow("duplicate_inbox_triage_note");
  expect(()=>checkedInboxTriageProposal([suggestion()],sections,()=>false))
    .toThrow("inbox_triage_note_not_read_this_turn");
});
test("S9-1c: never propose a protected, nonexistent or unapproved destination",()=>{
  for(const slug of ["inbox","documents","secret","../../outside"])
    expect(()=>checkedInboxTriageProposal([suggestion({targetSectionSlug:slug})],sections,authorized))
      .toThrow("invalid_inbox_triage_item");
});
test("S9-1c: bounded suggestion list, exact keys and canonical tags",()=>{
  const cases=[
    [],Array.from({length:11},()=>suggestion()),[suggestion({sql:"DROP"})],
    [suggestion({tags:["один","два","три","четыре","пять","шесть"]})],
    [suggestion({tags:["bad tag"]})],
    [suggestion({reason:"x"})],
    [suggestion({expectedVersion:0})],
    [suggestion({targetSectionSlug:"notes",noteId:""})],
  ];
  for(const batch of cases)expect(()=>checkedInboxTriageProposal(batch,sections,authorized)).toThrow();
  expect(()=>checkedInboxTriageProposal("not-array",sections,authorized)).toThrow("invalid_inbox_triage_items");
});
test("S9-1c: no suggestions if no same-turn read handles, even with real note IDs",()=>{
  expect(()=>checkedInboxTriageProposal([suggestion()],sections,()=>false))
    .toThrow("inbox_triage_note_not_read_this_turn");
});
