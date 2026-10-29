"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {authorize,statusReason,check}=require("./check-llm-access.cjs");
const valid={
  trigger:"workflow_dispatch",optIn:"RUN_PAID_LLM",key:"dummy-not-real",
  baseUrl:"https://api.deepseek.com",model:"deepseek-flash",
};
test("public HTTPS base and model resolve to only chat completions",()=>{
  assert.equal(authorize(valid).href,"https://api.deepseek.com/chat/completions");
  assert.equal(authorize({...valid,baseUrl:"https://example.com/v1"}).href,
    "https://example.com/v1/chat/completions");
});
test("no call without manual paid approval or configured credentials",async()=>{
  let calls=0;
  const stub=async()=>{calls++;return {status:200,body:'{"choices":[{"message":{"content":"OK"}}]}'};};
  for(const config of [
    {...valid,optIn:""}, {...valid,trigger:"push"}, {...valid,key:""},
    {...valid,baseUrl:"http://api.deepseek.com"},
    {...valid,baseUrl:"https://127.0.0.1"},
    {...valid,baseUrl:"https://api.deepseek.com/other"},
  ]) await assert.rejects(()=>check(config,stub));
  assert.equal(calls,0);
});
test("one real shape and bounded cheap model request",async()=>{
  let calls=0;
  const result=await check(valid,async(url,headers,body)=>{
    calls++;
    assert.equal(url.href,"https://api.deepseek.com/chat/completions");
    assert.equal(headers.Authorization,"Bearer dummy-not-real");
    const payload=JSON.parse(body);
    assert.equal(payload.model,"deepseek-flash");
    assert.equal(payload.max_tokens,64);
    assert.deepEqual(payload.thinking,{type:"disabled"});
    assert.equal(payload.messages.length,1);
    return {status:200,body:JSON.stringify({choices:[{message:{role:"assistant",content:"OK"}}],usage:{prompt_tokens:10,completion_tokens:1}})};
  });
  assert.equal(calls,1);
  assert.equal(result.status,"PASS");
  assert.equal(result.completionTokens,1);
});
test("malformed success and HTTP errors fail closed",async()=>{
  await assert.rejects(()=>check(valid,async()=>({status:200,body:'{"choices":[]}'})),
    /EMPTY_OR_INVALID_MODEL_RESPONSE/);
  await assert.rejects(()=>check(valid,async()=>({status:401,body:'{"error":"secret"}'})),
    /HTTP_401_API_KEY_REJECTED/);
  assert.equal(statusReason(429),"QUOTA_OR_RATE_LIMIT");
});
