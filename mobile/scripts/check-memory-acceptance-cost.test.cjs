"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {check}=require("./check-memory-acceptance-cost.cjs");
const goodWorkflow="name: Manual memory check\non:\n  workflow_dispatch:\n    inputs:\n      live_llm:\n        type: boolean\n        default: false\n      paid_confirmation:\n        type: string\n        default: \"\"\npermissions:\n  contents: read\njobs:\n  live-model:\n    if: ${{ github.event_name == 'workflow_dispatch' && inputs.live_llm == true && inputs.paid_confirmation == 'RUN_PAID_LLM' }}\n    env:\n      PERSAI_EVAL_LLM_SUITE: ${{ inputs.suite }}";
const goodLive="const enabled=process.env.PERSAI_EVAL_MANUAL_TRIGGER===\"workflow_dispatch\" &&\n  process.env.PERSAI_EVAL_PAID_OPT_IN===PAID_CONFIRMATION;\nconst MAX_PAID_OUTPUT_TOKENS=512;\nconst MAX_PAID_INPUT_CHARS=24000;\npayload.max_tokens=Math.min(payload.max_tokens,MAX_PAID_OUTPUT_TOKENS);\nconst MAX_PAID_API_CALLS=240;\nconst budget=Math.min(MAX_PAID_API_CALLS,totalTurns*MAX_REQUESTS_PER_TURN);\nif(totalPaidCalls>=budget)throw Error(\"budget\");\nmaxRequests:MAX_REQUESTS_PER_TURN";
test("manual-only double confirmation and limit accepted",()=>assert.equal(check(goodWorkflow,goodLive),true));
test("scheduled, push-triggered or legacy auto LLM eval blocked",()=>{
  assert.throws(()=>check(goodWorkflow.replace("permissions:","  schedule:\n    - cron: 0 2 * * *\npermissions:"),goodLive));
  assert.throws(()=>check(goodWorkflow.replace("permissions:","  push:\n    branches: [main]\npermissions:"),goodLive));
  assert.throws(()=>check(goodWorkflow.replace("github.event_name == 'workflow_dispatch' && inputs.live_llm == true && inputs.paid_confirmation == 'RUN_PAID_LLM'","github.event_name == 'schedule' || inputs.live_llm == true"),goodLive));
});
test("mere credentials or missing confirmation can never authorize paid calls",()=>{
  assert.throws(()=>check(goodWorkflow.replace("      paid_confirmation:\n        type: string\n        default: \"\"\n",""),goodLive));
  assert.throws(()=>check(goodWorkflow,goodLive.replace("PERSAI_EVAL_PAID_OPT_IN===PAID_CONFIRMATION","Boolean(PERSAI_EVAL_LLM_API_KEY)")));
  assert.throws(()=>check(goodWorkflow,goodLive.replace("const MAX_PAID_API_CALLS=240;","const MAX_PAID_API_CALLS=9999;")));
});
