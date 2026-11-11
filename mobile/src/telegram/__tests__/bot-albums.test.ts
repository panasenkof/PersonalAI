import {planBotAlbum} from "../bot-albums";
import type {BotUpdate} from "../bot-api";
const chat=(id:number,group?:string,caption=""):BotUpdate=>({
  update_id:id,message:{
    message_id:id,chat:{id:12345,type:"private"},
    ...(group?{media_group_id:group,photo:[{file_id:"AgACfile12345"}]}:{text:caption}),
    ...(caption&&group?{caption}:{}),
  },
});
test("two album parts close on next owner message, preserving all originals",()=>{
  const updates=[chat(1,"group1"),chat(2,"group1","caption"),chat(3,undefined,"/done")];
  expect(planBotAlbum(updates,0,"12345")).toEqual({
    state:"ready",groupId:"group1",lastUpdateId:2,nextIndex:2,
    messages:[updates[0].message,updates[1].message],
  });
});
test("an unbounded trailing album stays pending, no inferred completeness",()=>{
  expect(planBotAlbum([chat(10,"group1"),chat(11,"group1")],0,"12345"))
    .toEqual({state:"pending",received:2,groupId:"group1"});
});
test("other chats cannot confirm an album boundary",()=>{
  const foreign={update_id:3,message:{message_id:3,chat:{id:999,type:"private"},text:"outsider"}};
  expect(planBotAlbum([chat(1,"group1"),chat(2,"group1"),foreign],0,"12345").state)
    .toBe("pending");
  const plan=planBotAlbum([chat(1,"group1"),foreign,chat(2,"group1"),chat(4,undefined,"end")],0,"12345");
  expect(plan.state).toBe("ready");
  if(plan.state==="ready"){
    expect(plan.messages.map(m=>m.message_id)).toEqual([1,2]);
    expect(plan.nextIndex).toBe(3);
    expect(plan.lastUpdateId).toBe(2);
  }
});
test("ten originals terminate an album even without another message",()=>{
  const updates=Array.from({length:10},(_,i)=>chat(i+1,"group1"));
  const plan=planBotAlbum(updates,0,"12345");
  expect(plan.state).toBe("ready");
  if(plan.state==="ready")expect(plan.lastUpdateId).toBe(10);
});
test("duplicate and invalid album identities stop before any ACK",()=>{
  expect(()=>planBotAlbum([chat(1,"bad/group"),chat(2,"bad/group")],0,"12345"))
    .toThrow("Непроверенный");
  expect(()=>planBotAlbum([chat(1,"group1"),{...chat(2,"group1"),
    message:{...chat(1,"group1").message!,message_id:1}}],0,"12345"))
    .toThrow("повторный ID");
});
test("edits of an uncommitted album member cannot be used as boundary",()=>{
  const changes=[chat(1,"group1"),chat(2,"group1"),{
    update_id:3,edited_message:{...chat(1,"group1").message!,message_id:1},
  }];
  expect(()=>planBotAlbum(changes,0,"12345")).toThrow("изменён");
});
