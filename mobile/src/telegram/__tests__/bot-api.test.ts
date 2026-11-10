import {fetchBotUpdates,listBotPairCandidates,verifyTelegramBot} from "../bot-api";
const token="12345678:"+"a".repeat(35);
const apiResult=(result:unknown,ok=true)=>({ok:true,text:async()=>JSON.stringify({ok,result})}) as Response;
afterEach(()=>jest.restoreAllMocks());
test("verifies actual Bot API getMe identity and never trusts a username alone",async()=>{
  const mock=jest.spyOn(globalThis,"fetch").mockResolvedValue(apiResult({
    id:456,username:"MyPersAIBot",is_bot:true,
  }));
  expect(await verifyTelegramBot(token)).toEqual({id:456,username:"MyPersAIBot"});
  expect(mock).toHaveBeenCalledTimes(1);
  expect(mock.mock.calls[0][0]).toContain("https://api.telegram.org/bot12345678:");
  expect((mock.mock.calls[0][1] as RequestInit).method).toBe("POST");
  mock.mockResolvedValueOnce(apiResult({id:999,username:"SomeUser",is_bot:false}));
  await expect(verifyTelegramBot(token)).rejects.toThrow("не подтверждает");
});
test("pairing observes private chats without confirming Telegram updates or exposing messages",async()=>{
  const mock=jest.spyOn(globalThis,"fetch")
    .mockResolvedValueOnce(apiResult({url:""}))
    .mockResolvedValueOnce(apiResult([
      {update_id:1,message:{message_id:1,chat:{id:12345,type:"private"},
        from:{first_name:"Alice",username:"alice"},text:"private secret"}},
      {update_id:2,message:{message_id:2,chat:{id:-1003,type:"supergroup"},text:"group"}},
    ]));
  const candidates=await listBotPairCandidates(token);
  expect(candidates).toEqual([{chatId:"12345",label:"Alice · @alice"}]);
  expect(JSON.stringify(candidates)).not.toContain("private secret");
  const payload=JSON.parse((mock.mock.calls[1][1] as RequestInit).body as string);
  expect(payload).not.toHaveProperty("offset");
  expect(payload.timeout).toBe(0);
});
test("pending bot import only reads from cursor+1; webhook is never silently disabled",async()=>{
  const mock=jest.spyOn(globalThis,"fetch")
    .mockResolvedValueOnce(apiResult({url:""}))
    .mockResolvedValueOnce(apiResult([{update_id:9,message:{message_id:9,chat:{id:12345,type:"private"},text:"Hello"}}]));
  expect((await fetchBotUpdates(token,8)).map(x=>x.update_id)).toEqual([9]);
  const payload=JSON.parse((mock.mock.calls[1][1] as RequestInit).body as string);
  expect(payload.offset).toBe(9);
  mock.mockReset();
  mock.mockResolvedValueOnce(apiResult({url:"https://other.example/hook"}));
  await expect(fetchBotUpdates(token,0)).rejects.toThrow("webhook");
  expect(mock).toHaveBeenCalledTimes(1);
});
test("network failures sanitize potentially sensitive token URLs",async()=>{
  jest.spyOn(globalThis,"fetch").mockRejectedValueOnce(new Error("https://api.telegram.org/bot"+token+"/getMe"));
  await expect(verifyTelegramBot(token)).rejects.toThrow("Telegram недоступен");
  try{await verifyTelegramBot("invalid");}catch(e){expect(String(e)).not.toContain(token);}
});
