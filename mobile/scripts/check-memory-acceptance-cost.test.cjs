"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {check}=require("./check-memory-acceptance-cost.cjs");
const goodWorkflow="name: Manual memory check\non:\n  workflow_dispatch:\n    inputs:\n      live_llm:\n        type: boolean\n        default: false\n      paid_confirmation:\n        type: string\n        default: \"\"\npermissions:\n  contents: read\njobs:\n  live-model:\n    if: ${{ github.event_name == 'workflow_dispatch' && inputs.live_llm == true && inputs.paid_confirmation == 'RUN_PAID_LLM' }}\n    env:\n      PERSAI_EVAL_LLM_SUITE: ${{ inputs.suite }}";
const goodLive="const enabled=process.env.PERSAI_EVAL_MANUAL_TRIGGER===\"workflow_dispatch\" &&\n  process.env.PERSAI_EVAL_PAID_OPT_IN===PAID_CONFIRMATION;\nconst MAX_PAID_OUTPUT_TOKENS=512;\nconst MAX_PAID_INPUT_CHARS=24000;\npayload.max_tokens=Math.min(payload.max_tokens,MAX_PAID_OUTPUT_TOKENS);\nconst MAX_PAID_API_CALLS=240;\nconst budget=Math.min(MAX_PAID_API_CALLS,totalTurns*MAX_REQUESTS_PER_TURN);\nif(totalPaidCalls>=budget)throw Error(\"budget\");\nmaxRequests:MAX_REQUESTS_PER_TURN";
const guardedLive=[goodLive,"import {request as httpsRequest} from \"node:https\";","return realHttpsTransport(input,{...init,body:JSON.stringify(payload)});","if(e instanceof ModelRequestError)providerFailed=true;"].join("\n");
test("manual-only double confirmation and limit accepted",()=>assert.equal(check(goodWorkflow,guardedLive),true));
test("scheduled, push-triggered or legacy auto LLM eval blocked",()=>{
  assert.throws(()=>check(goodWorkflow.replace("permissions:","  schedule:\n    - cron: 0 2 * * *\npermissions:"),guardedLive));
  assert.throws(()=>check(goodWorkflow.replace("permissions:","  push:\n    branches: [main]\npermissions:"),guardedLive));
  assert.throws(()=>check(goodWorkflow.replace("github.event_name == 'workflow_dispatch' && inputs.live_llm == true && inputs.paid_confirmation == 'RUN_PAID_LLM'","github.event_name == 'schedule' || inputs.live_llm == true"),guardedLive));
});
test("job-level runner.temp expressions are rejected before merge",()=>{
  const invalid=goodWorkflow.replace("    env:\n",
    "    env:\n      PERSAI_EVAL_REPORT_PATH: ${{ runner.temp }}/report.json\n");
  assert.throws(()=>check(invalid,goodLive));
});
test("mere credentials or missing confirmation can never authorize paid calls",()=>{
  assert.throws(()=>check(goodWorkflow.replace("      paid_confirmation:\n        type: string\n        default: \"\"\n",""),guardedLive));
  assert.throws(()=>check(goodWorkflow,guardedLive.replace("PERSAI_EVAL_PAID_OPT_IN===PAID_CONFIRMATION","Boolean(PERSAI_EVAL_LLM_API_KEY)")));
  assert.throws(()=>check(goodWorkflow,guardedLive.replace("const MAX_PAID_API_CALLS=240;","const MAX_PAID_API_CALLS=9999;")));
});

test("live transport cannot fall back to Jest global fetch",()=>{
  assert.throws(()=>check(goodWorkflow,
    guardedLive.replace("return realHttpsTransport(input,{...init,body:JSON.stringify(payload)});",
      "return fetch(input,{...init,body:JSON.stringify(payload)});")));
  assert.throws(()=>check(goodWorkflow,
    guardedLive.replace("if(e instanceof ModelRequestError)providerFailed=true;","")));
});
