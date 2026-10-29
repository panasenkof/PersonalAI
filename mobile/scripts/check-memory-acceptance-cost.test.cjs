"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {check,checkQuick,checkNativeSeparation}=require("./check-memory-acceptance-cost.cjs");
const goodWorkflow=[
  "name: Manual memory check",
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  "      live_llm:",
  "        type: boolean",
  "        default: false",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  live-model:",
  "    if: ${{ github.event_name == 'workflow_dispatch' && inputs.live_llm == true }}",
  "    env:",
  "      PERSAI_EVAL_LLM_SUITE: ${{ inputs.suite }}",
  "      PERSAI_EVAL_LIVE_LLM_APPROVED: ${{ inputs.live_llm }}"
].join("\n");
const guardedWorkflow=goodWorkflow+"\n      - name: Preflight\n        run: node scripts/check-llm-access.cjs";
const goodLive=[
  "const enabled=process.env.PERSAI_EVAL_MANUAL_TRIGGER===\"workflow_dispatch\" &&",
  "  process.env.PERSAI_EVAL_LIVE_LLM_APPROVED===\"true\";",
  "const MAX_PAID_OUTPUT_TOKENS=512;",
  "const MAX_PAID_INPUT_CHARS=24000;",
  "payload.max_tokens=Math.min(payload.max_tokens,MAX_PAID_OUTPUT_TOKENS);",
  "const MAX_PAID_API_CALLS=240;",
  "const budget=Math.min(MAX_PAID_API_CALLS,totalTurns*MAX_REQUESTS_PER_TURN);",
  "if(totalPaidCalls>=budget)throw Error(\"budget\");",
  "maxRequests:MAX_REQUESTS_PER_TURN"
].join("\n");
const guardedLive=[goodLive,"import {request as httpsRequest} from \"node:https\";","return realHttpsTransport(input,{...init,body:JSON.stringify(payload)});","if(e instanceof ModelRequestError)providerFailed=true;"].join("\n");
test("manual-only paid checkbox and limits accepted",()=>assert.equal(check(guardedWorkflow,guardedLive),true));
test("scheduled, push-triggered or legacy auto LLM eval blocked",()=>{
  assert.throws(()=>check(guardedWorkflow.replace("permissions:","  schedule:\n    - cron: 0 2 * * *\npermissions:"),guardedLive));
  assert.throws(()=>check(guardedWorkflow.replace("permissions:","  push:\n    branches: [main]\npermissions:"),guardedLive));
  assert.throws(()=>check(guardedWorkflow.replace("github.event_name == 'workflow_dispatch' && inputs.live_llm == true","github.event_name == 'schedule' || inputs.live_llm == true"),guardedLive));
});
test("job-level runner.temp expressions are rejected before merge",()=>{
  const invalid=guardedWorkflow.replace("    env:\n",
    "    env:\n      PERSAI_EVAL_REPORT_PATH: ${{ runner.temp }}/report.json\n");
  assert.throws(()=>check(invalid,goodLive));
});
test("only an explicit manual true checkbox enables paid tests",()=>{
  assert.throws(()=>check(guardedWorkflow.replace("        default: false","        default: true"),guardedLive));
  assert.throws(()=>check(guardedWorkflow.replace("inputs.live_llm == true","true"),guardedLive));
  assert.throws(()=>check(guardedWorkflow.replace("PERSAI_EVAL_LIVE_LLM_APPROVED: ${{ inputs.live_llm }}","PERSAI_EVAL_LIVE_LLM_APPROVED: true"),guardedLive));
  assert.throws(()=>check(guardedWorkflow,guardedLive.replace('PERSAI_EVAL_LIVE_LLM_APPROVED==="true"',"Boolean(PERSAI_EVAL_LLM_API_KEY)")));
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
  "        default: false",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  connectivity:",
  "    if: ${{ github.event_name == 'workflow_dispatch' && inputs.live_llm == true }}",
  "    env:",
  "      PERSAI_EVAL_LIVE_LLM_APPROVED: ${{ inputs.live_llm }}",
  "    steps:",
  "      - name: Verify",
  "        run: node mobile/scripts/check-llm-access.cjs"
 ].join("\n");
test("separate quick access check is manual paid only, without npm or Android",()=>{
  assert.equal(checkQuick(goodQuick),true);
  assert.throws(()=>checkQuick(goodQuick.replace("  workflow_dispatch:","  push:")));
  assert.throws(()=>checkQuick(goodQuick.replace("inputs.live_llm == true","true")));
  assert.throws(()=>checkQuick(goodQuick.replace("        default: false","        default: true")));
  assert.throws(()=>checkQuick(goodQuick.replace("PERSAI_EVAL_LIVE_LLM_APPROVED: ${{ inputs.live_llm }}","PERSAI_EVAL_LIVE_LLM_APPROVED: true")));
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
