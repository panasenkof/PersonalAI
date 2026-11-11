import {planSavedAlbum} from "../saved-album-plan";
import {parseSavedMessagesPage} from "../saved-messages";
import type {SavedMessagePreview} from "../saved-messages";
const photo=(id:string,albumId?:string):SavedMessagePreview=>({
  id,date:1794300000,kind:"messagePhoto",text:"",hasMedia:true,
  ...(albumId?{hasAlbum:true,albumId}:{}),
});
const text=(id:string):SavedMessagePreview=>({
  id,date:1794300000,kind:"messageText",text:"Раздел",hasMedia:false,
});
test("complete scoped album requires the older boundary message",()=>{
  const album="9223372036854775807";
  const messages=[photo("33",album),photo("32",album),text("31")];
  expect(planSavedAlbum(messages,0)).toEqual({
    state:"ready",albumId:album,messages:messages.slice(0,2),nextIndex:2,
  });
});
test("page tail is not proof of an album ending",()=>{
  const messages=[photo("33","123"),photo("32","123")];
  expect(planSavedAlbum(messages,0)).toEqual({
    state:"pending",albumId:"123",received:2,reason:"page_tail",
  });
});
test("ten complete originals can form bounded group without an older boundary",()=>{
  const messages=Array.from({length:10},(_,i)=>photo(String(100-i),"5678"));
  const plan=planSavedAlbum(messages,0);
  expect(plan.state).toBe("ready");
  if(plan.state==="ready")expect(plan.messages).toHaveLength(10);
});
test("interleaved same-group photos fail closed, not silently split",()=>{
  const messages=[photo("33","123"),photo("32","123"),text("31"),photo("30","123")];
  expect(()=>planSavedAlbum(messages,0)).toThrow("telegram_saved_album_interleaved");
});
test("an old signed binary without albumId stays read-only pending",()=>{
  expect(planSavedAlbum([{...photo("34"),hasAlbum:true}],0)).toEqual({
    state:"pending",albumId:"",received:1,reason:"legacy_source",
  });
});
test("invalid parts and missing album head cannot be grouped",()=>{
  expect(()=>planSavedAlbum([text("33")],0)).toThrow("telegram_saved_album_invalid_head");
  expect(()=>planSavedAlbum([photo("33","123"),photo("33","123")],0))
    .toThrow("telegram_saved_album_invalid_part");
});
test("native projected string preserves int64 group without unsafe JS number conversion",()=>{
  const raw=JSON.stringify({
    selfChatId:"12345",nextCursor:"32",messages:[
      photo("33","9223372036854775807"),photo("32","9223372036854775807"),
    ],
  });
  const parsed=parseSavedMessagesPage(raw,"0",20);
  expect(parsed.messages[0].albumId).toBe("9223372036854775807");
  const invalid=JSON.stringify({
    selfChatId:"12345",nextCursor:"33",messages:[
      {...photo("33","123"),albumId:123},
    ],
  });
  expect(()=>parseSavedMessagesPage(invalid,"0",20)).toThrow("telegram_saved_item_invalid");
});
