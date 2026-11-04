import { trashPurgeBatches, trashPurgeCountLabel, purgeConfirmedTrash } from "../trash-clear";

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

test.each([0,1,50,51,100,101,205])("runner for %i notes never expands confirmed IDs or exceeds writer limit", async n=>{
  const ids=Array.from({length:n},(_,i)=>({id:"note-"+i,record_version:1}));
  const writer=jest.fn(async (_batch:any[])=>{});
  const outcome=await purgeConfirmedTrash(ids,writer,()=>true);
  expect(outcome).toEqual({total:n,confirmed:n,error:null});
  const sent=writer.mock.calls.flatMap(call=>call[0]);
  expect(sent).toEqual(ids);
  expect(writer.mock.calls.every(call=>call[0].length<=100)).toBe(true);
});
test("a conflict in the second batch never triggers a third batch or automatic retry", async()=>{
  const ids=Array.from({length:205},(_,i)=>({id:"note-"+i,record_version:1}));
  const writer=jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("stale_memory_version"));
  const progress=jest.fn();
  const outcome=await purgeConfirmedTrash(ids,writer,()=>true,progress);
  expect(outcome.confirmed).toBe(100);
  expect(outcome.total).toBe(205);
  expect(outcome.error).toBeInstanceOf(Error);
  expect(progress).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenCalledWith(100);
  expect(writer).toHaveBeenCalledTimes(2);
});
test("a lock/profile change between batches stops before another writer call", async()=>{
  const ids=Array.from({length:101},(_,i)=>({id:"note-"+i,record_version:1}));
  let allowed=true;
  const writer=jest.fn(async()=>{allowed=false;});
  const outcome=await purgeConfirmedTrash(ids,writer,()=>allowed);
  expect(outcome.confirmed).toBe(100);
  expect(outcome.error).toBeInstanceOf(Error);
  expect(writer).toHaveBeenCalledTimes(1);
});
test("a rejected first batch is not retried and no completed items are claimed",async()=>{
  const writer=jest.fn(async()=>{throw new Error("commit_not_confirmed");});
  const outcome=await purgeConfirmedTrash([{id:"a",record_version:2}],writer,()=>true);
  expect(outcome.confirmed).toBe(0);
  expect(writer).toHaveBeenCalledTimes(1);
  expect(outcome.error).toBeInstanceOf(Error);
});
