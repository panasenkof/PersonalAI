"use strict";
/**
 * Fails closed if the optional paid memory eval can start automatically.
 * This gate is free, runs in ordinary PR CI, and inspects source text only.
 */
const fs=require("node:fs");
const path=require("node:path");
const assert=require("node:assert/strict");
const ROOT=path.resolve(__dirname,"../..");
function check(workflow,liveTest){
  const triggers=workflow.split(/\npermissions:|\njobs:/)[0];
  assert.match(triggers,/\non:\s*\n\s+workflow_dispatch:/,"Manual dispatch is required");
  assert.doesNotMatch(triggers,/^\s*(?:schedule|cron|push|pull_request|workflow_run|workflow_call)\s*:/m,
    "Memory acceptance must not have an automatic trigger");
  assert.match(triggers,/\blive_llm:/,"Paid toggle is required");
  assert.match(triggers,/\bpaid_confirmation:/,"Typed confirmation is required");
  assert.match(workflow,/github\.event_name == 'workflow_dispatch' && inputs\.live_llm == true && inputs\.paid_confirmation == 'RUN_PAID_LLM'/,
    "Live job must be guarded by both human confirmations and event type");
  assert.match(liveTest,/PERSAI_EVAL_MANUAL_TRIGGER==="workflow_dispatch"/,
    "Test must refuse non-manual execution even with credentials");
  assert.match(liveTest,/PERSAI_EVAL_PAID_OPT_IN===PAID_CONFIRMATION/,
    "Test must require paid opt-in independently of workflow");
  assert.match(liveTest,/const MAX_PAID_OUTPUT_TOKENS=512;/,
    "Paid evaluation must limit model completion tokens");
  assert.match(liveTest,/const MAX_PAID_INPUT_CHARS=24000;/,
    "Paid evaluation must reject unbounded input context");
  assert.match(liveTest,/limited\.max_tokens=Math\.min\(limited\.max_tokens,MAX_PAID_OUTPUT_TOKENS\)/,
    "Paid evaluation must cap max_tokens before fetch");
  assert.match(liveTest,/const MAX_PAID_API_CALLS=9;/,
    "Test must define a bounded total API request budget");
  assert.match(liveTest,/if\(\+\+totalPaidCalls>MAX_PAID_API_CALLS\)/,
    "Budget must be checked before the provider network call");
  assert.match(liveTest,/maxRequests:3/,
    "Each question must have bounded turns");
  return true;
}
if(require.main===module){
  check(fs.readFileSync(path.join(ROOT,".github/workflows/memory-acceptance.yml"),"utf8"),
    fs.readFileSync(path.join(ROOT,"mobile/eval/__tests__/live-memory-model.test.ts"),"utf8"));
  process.stdout.write("Paid memory eval guard: manual only, double opt-in, capped calls.\n");
}
module.exports={check};
