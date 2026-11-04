import { trashPurgeBatches, trashPurgeCountLabel } from "../trash-clear";

test.each([0,1,50,51,100,101,205])("confirmed trash snapshot of %i items is split into valid batches", n => {
  const ids=Array.from({ length:n },(_,i)=>({id:"note-"+i,record_version:i+1}));
  const batches=trashPurgeBatches(ids);
  expect(batches.flat()).toEqual(ids);
  expect(batches.every(b=>b.length>=1&&b.length<=100)).toBe(true);
  expect(batches.map(b=>b.length)).toEqual(
    n===0?[]:n<=100?[n]:n===101?[100,1]:[100,100,5]
  );
});
test("invalid, duplicated and stale versions are never sent to the purge writer",()=>{
  expect(()=>trashPurgeBatches([{id:"x",record_version:1},{id:"x",record_version:2}])).toThrow("trash_preview_invalid");
  expect(()=>trashPurgeBatches([{id:"x",record_version:0}])).toThrow("trash_preview_invalid");
  expect(()=>trashPurgeBatches([{id:"x",record_version:1.5}])).toThrow("trash_preview_invalid");
});
test.each([[0,"0 записей"],[1,"1 запись"],[2,"2 записи"],[5,"5 записей"],[11,"11 записей"],[21,"21 запись"],[24,"24 записи"],[111,"111 записей"],[205,"205 записей"]])("Russian count %i is inflected as %s",(count,label)=>{
  expect(trashPurgeCountLabel(count)).toBe(label);
});
