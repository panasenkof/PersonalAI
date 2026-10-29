"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {check,checkQuick,checkNativeSeparation}=require("./check-memory-acceptance-cost.cjs");
const goodWorkflow="name: Manual memory check\non:\n  workflow_dispatch:\n    inputs:\n      live_llm:\n        type: boolean\n        default: false\n      paid_confirmation:\n        type: string\n        default: \"\"\npermissions:\n  contents: read\njobs:\n  live-model:\n    if: ${{ github.event_name == 'workflow_dispatch' && inputs.live_llm == true && inputs.paid_confirmation == 'RUN_PAID_LLM' }}\n    env:\n      PERSAI_EVAL_LLM_SUITE: ${{ inputs.suite }}";
const guardedWorkflow=goodWorkflow+"\n      - name: Preflight\n        run: node scripts/check-llm-access.cjs";
const goodLive="const enabled=process.env.PERSAI_EVAL_MANUAL_TRIGGER===\"workflow_dispatch\" &&\n  process.env.PERSAI_EVAL_PAID_OPT_IN===PAID_CONFIRMATION;\nconst MAX_PAID_OUTPUT_TOKENS=512;\nconst MAX_PAID_INPUT_CHARS=24000;\npayload.max_tokens=Math.min(payload.max_tokens,MAX_PAID_OUTPUT_TOKENS);\nconst MAX_PAID_API_CALLS=240;\nconst budget=Math.min(MAX_PAID_API_CALLS,totalTurns*MAX_REQUESTS_PER_TURN);\nif(totalPaidCalls>=budget)throw Error(\"budget\");\nmaxRequests:MAX_REQUESTS_PER_TURN";
const guardedLive=[goodLive,"import {request as httpsRequest} from \"node:https\";","return realHttpsTransport(input,{...init,body:JSON.stringify(payload)});","if(e instanceof ModelRequestError)providerFailed=true;"].join("\n");
test("manual-only double confirmation and limit accepted",()=>assert.equal(check(guardedWorkflow,guardedLive),true));
test("scheduled, push-triggered or legacy auto LLM eval blocked",()=>{
  assert.throws(()=>check(guardedWorkflow.replace("permissions:","  schedule:\n    - cron: 0 2 * * *\npermissions:"),guardedLive));
  assert.throws(()=>check(guardedWorkflow.replace("permissions:","  push:\n    branches: [main]\npermissions:"),guardedLive));
  assert.throws(()=>check(guardedWorkflow.replace("github.event_name == 'workflow_dispatch' && inputs.live_llm == true && inputs.paid_confirmation == 'RUN_PAID_LLM'","github.event_name == 'schedule' || inputs.live_llm == true"),guardedLive));
});
test("job-level runner.temp expressions are rejected before merge",()=>{
  const invalid=guardedWorkflow.replace("    env:\n",
    "    env:\n      PERSAI_EVAL_REPORT_PATH: ${{ runner.temp }}/report.json\n");
  assert.throws(()=>check(invalid,goodLive));
});
test("mere credentials or missing confirmation can never authorize paid calls",()=>{
  assert.throws(()=>check(guardedWorkflow.replace("      paid_confirmation:\n        type: string\n        default: \"\"\n",""),guardedLive));
  assert.throws(()=>check(guardedWorkflow,guardedLive.replace("PERSAI_EVAL_PAID_OPT_IN===PAID_CONFIRMATION","Boolean(PERSAI_EVAL_LLM_API_KEY)")));
  assert.throws(()=>check(guardedWorkflow,guardedLive.replace("const MAX_PAID_API_CALLS=240;","const MAX_PAID_API_CALLS=9999;")));
});

test("live transport cannot fall back to Jest global fetch",()=>{
  assert.throws(()=>check(guardedWorkflow,
    guardedLive.replace("return realHttpsTransport(input,{...init,body:JSON.stringify(payload)});",
      "return fetch(input,{...init,body:JSON.stringify(payload)});")));
  assert.throws(()=>check(guardedWorkflow,
    guardedLive.replace("if(e instanceof ModelRequestError)providerFailed=true;","")));
});

const goodQuick=[
  "name: Quick LLM check",
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  "      live_llm:",
  "        type: boolean",
  "      paid_confirmation:",
  "        type: string",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  connectivity:",
  "    if: ${{ github.event_name == 'workflow_dispatch' && inputs.live_llm == true && inputs.paid_confirmation == 'RUN_PAID_LLM' }}",
  "    steps:",
  "      - name: Verify",
  "        run: node mobile/scripts/check-llm-access.cjs"
].join("\n");
test("separate quick access check is manual paid only, without npm or Android",()=>{
  assert.equal(checkQuick(goodQuick),true);
  assert.throws(()=>checkQuick(goodQuick.replace("  workflow_dispatch:","  push:")));
  assert.throws(()=>checkQuick(goodQuick.replace("inputs.live_llm == true","true")));
  assert.throws(()=>checkQuick(goodQuick+"\n        run: npm ci"));
});
test("full suite must not wait for Android and must check access first",()=>{
  assert.throws(()=>check(guardedWorkflow.replace("  live-model:\n",
    "  live-model:\n    needs: [deterministic, android]\n"),guardedLive));
  assert.throws(()=>check(guardedWorkflow.replace("run: node scripts/check-llm-access.cjs",
    "run: echo fake"),guardedLive));
});

const mainCi=fs.readFileSync(path.join(__dirname,"../..",".github/workflows/ci.yml"),"utf8");
const manualAcceptance=fs.readFileSync(path.join(__dirname,"../..",".github/workflows/memory-acceptance.yml"),"utf8");
test("manual memory acceptance has no APK/emulator; required main CI keeps native",()=>{
  assert.equal(checkNativeSeparation(manualAcceptance,mainCi),true);
});
test("native workflow cannot be reintroduced in manual memory checks",()=>{
  assert.throws(()=>checkNativeSeparation(manualAcceptance+"\n  android:\n    uses: ./.github/workflows/mobile-native-sqlcipher.yml\n",mainCi));
  assert.throws(()=>checkNativeSeparation(manualAcceptance+"\n  other:\n    run: ./gradlew :app:assembleRelease\n",mainCi));
});
test("Android build cannot silently disappear from required main CI",()=>{
  assert.throws(()=>checkNativeSeparation(manualAcceptance,mainCi.replace(
    "uses: ./.github/workflows/mobile-native-sqlcipher.yml","uses: ./.github/workflows/placeholder.yml")));
  assert.throws(()=>checkNativeSeparation(manualAcceptance,mainCi.replace(
    "needs: [changes, mobile, native]","needs: [changes, mobile]")));
  assert.throws(()=>checkNativeSeparation(manualAcceptance,mainCi.replace(
    'test "$NATIVE" = success','true')));
});
