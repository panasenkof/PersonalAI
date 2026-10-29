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
  assert.doesNotMatch(triggers,/\bpaid_confirmation:/,
    "Typed confirmation must not be required");
  const liveInput=triggers.split("\n      live_llm:\n")[1]?.split(/\n      [a-z_]+:\n/)[0]||"";
  assert.match(liveInput,/type:\s*boolean\s*\n\s*default:\s*false/,
    "Paid checkbox must be boolean and default to false");
  assert.match(workflow,/github\.event_name == 'workflow_dispatch' && inputs\.live_llm == true/,
    "Live job must require manual dispatch and a checked box");
  assert.match(workflow,/PERSAI_EVAL_LIVE_LLM_APPROVED:\s*\$\{\{ inputs\.live_llm \}\}/,
    "The independent paid guard must receive the checkbox value");
  assert.doesNotMatch(workflow,/RUN_PAID_LLM|PERSAI_EVAL_PAID_OPT_IN/,
    "Legacy typed opt-in must not remain");
  assert.match(liveTest,/PERSAI_EVAL_MANUAL_TRIGGER==="workflow_dispatch"/,
    "Test must refuse non-manual execution even with credentials");
  assert.match(liveTest,/PERSAI_EVAL_LIVE_LLM_APPROVED==="true"/,
    "Test must require checked checkbox independently of workflow");
  assert.match(liveTest,/const MAX_PAID_OUTPUT_TOKENS=512;/,
    "Paid evaluation must limit model completion tokens");
  assert.match(liveTest,/const MAX_PAID_INPUT_CHARS=24000;/,
    "Paid evaluation must reject unbounded input context");
  assert.match(liveTest,/payload\.max_tokens=Math\.min\(payload\.max_tokens,MAX_PAID_OUTPUT_TOKENS\)/,
    "Paid evaluation must cap max_tokens before fetch");
  assert.match(liveTest,/const MAX_PAID_API_CALLS=400;/,
    "Test must define a bounded total API request budget");
  assert.match(liveTest,/if\(totalPaidCalls>=budget\)/,
    "Budget must be checked before the provider network call");
  assert.match(liveTest,/const MAX_REQUESTS_PER_TURN=5;/,
    "The proposed per-question ceiling is exactly five calls");
  assert.match(liveTest,/maxRequests:MAX_REQUESTS_PER_TURN/,
    "Each question must have bounded turns");
  // Jest-Expo replaces global fetch. A paid live test must use a real HTTPS
  // transport, or every mock response silently fails as "HTTP undefined".
  assert.match(liveTest,/import \{request as httpsRequest\} from "node:https"/,
    "Live evaluation must import the Node HTTPS client");
  assert.match(liveTest,/return realHttpsTransport\(input,\{\.\.\.init,body:JSON\.stringify\(payload\)\}\)/,
    "Live evaluation must not call the Jest global fetch mock");
  assert.match(liveTest,/if\(e instanceof ModelRequestError\)providerFailed=true;/,
    "Provider/network failure must stop the remaining paid scenarios");
  assert.match(liveTest,/Math\.min\(MAX_PAID_API_CALLS,totalTurns\*MAX_REQUESTS_PER_TURN\)/,
    "The API cap must reflect the manual suite size");
  assert.match(workflow,/PERSAI_EVAL_LLM_SUITE: \$\{\{ inputs\.suite \}\}/,
    "Manual suite selection must be explicitly forwarded");
  // Runner context is valid in step-level env, NOT in job-level env.
  // Without this check GitHub can reject the manually dispatched workflow
  // only after merge, leaving no PR job to explain the invalid YAML.
  const liveHeader=workflow.split("\n  live-model:\n")[1]?.split("\n    steps:\n")[0]||"";
  assert.doesNotMatch(liveHeader,/\$\{\{\s*runner\.temp\s*\}\}/,
    "runner.temp must not be referenced by job-level env");
  assert.doesNotMatch(liveHeader,/\bneeds:/,
    "Paid LLM job must not wait for the Android build");
  assert.match(workflow,/run: node scripts\/check-llm-access\.cjs/,
    "Paid LLM job must check provider connectivity before npm installation");

  return true;
}
function checkNativeSeparation(manualWorkflow, ciWorkflow){
  assert.doesNotMatch(manualWorkflow,/^  android:\s*$/m,
    "Manual memory acceptance must not define an Android job");
  assert.doesNotMatch(manualWorkflow,/mobile-native-sqlcipher\.yml|:app:assembleRelease|android-emulator-runner/,
    "Manual memory acceptance must not build an APK or run an emulator");
  const native=ciWorkflow.split("\n  native:\n")[1]?.split(/\n  [a-z_-]+:\n/)[0]||"";
  assert.match(native,/uses: \.\/\.github\/workflows\/mobile-native-sqlcipher\.yml/,
    "Ordinary CI must retain the reusable native Android smoke");
  const required=ciWorkflow.split("\n  required:\n")[1]||"";
  assert.match(required,/needs: \[changes, mobile, native\]/,
    "Required main CI must still depend on native checks");
  assert.match(required,/test "\$NATIVE" = success/,
    "Required CI must fail when native Android fails");
  return true;
}
function checkQuick(workflow){
  const triggers=workflow.split(/\npermissions:|\njobs:/)[0];
  assert.match(triggers,/\non:\s*\n\s+workflow_dispatch:/,
    "Quick paid connection check must be manual only");
  assert.doesNotMatch(triggers,/^\s*(?:push|schedule|cron|pull_request|workflow_run|workflow_call)\s*:/m);
  assert.match(triggers,/\blive_llm:/);
  assert.doesNotMatch(triggers,/\bpaid_confirmation:/);
  const liveInput=triggers.split("\n      live_llm:\n")[1]?.split(/\n      [a-z_]+:\n/)[0]||"";
  assert.match(liveInput,/type:\s*boolean\s*\n\s*default:\s*false/);
  assert.match(workflow,/github\.event_name == 'workflow_dispatch' && inputs\.live_llm == true/);
  assert.match(workflow,/PERSAI_EVAL_LIVE_LLM_APPROVED:\s*\$\{\{ inputs\.live_llm \}\}/);
  assert.doesNotMatch(workflow,/RUN_PAID_LLM|PERSAI_EVAL_PAID_OPT_IN/);
  assert.match(workflow,/run: node mobile\/scripts\/check-llm-access\.cjs/);
  assert.doesNotMatch(workflow,/npm ci|\bgradle\b|\bmaestro\b|mobile-native-sqlcipher/);
  return true;
}

/** Scan every tracked text file in CI, not only the tests edited in this PR.
 * Report all model-call/four candidates for review, and fail on explicit stale
 * four-call defaults. Historical results and gpt-4.1 model names are not defaults. */
function checkTrackedDefaultModelLimit(root=ROOT, runGit){
  const git=runGit || require("node:child_process").execFileSync;
  const paths=String(git("git",["ls-files","-z"],{cwd:root,maxBuffer:12*1024*1024}))
    .split("\0").filter(Boolean).filter(p=>/\.(?:ts|tsx|js|jsx|cjs|mjs|md|yml|yaml)$/i.test(p))
    // This checker deliberately contains literal bad examples as test fixtures.
    .filter(p=>p!=="mobile/scripts/check-memory-acceptance-cost.cjs" &&
      p!=="mobile/scripts/check-memory-acceptance-cost.test.cjs");
  const candidate=[],stale=[];
  const explicit=[
    /DEFAULT_MODEL_CALL_LIMIT\s*=\s*4\b/i,
    /MAX_REQUESTS_PER_TURN\s*=\s*4\b/i,
    /default is four\b/i,
    /limitInput\.inputValue\(\)\s*,\s*["']4["']/i,
    /nebula-home-status.*\(1\/4\)/i,
    /\b(?:default|по умолчанию).{0,50}(?:four\b|четыр|\b4\b).{0,30}(?:calls?\b|обращени|LLM)/i,
    /\b(?:calls?\b|обращени|LLM).{0,50}(?:default|по умолчанию).{0,30}(?:four\b|четыр|\b4\b)/i,
  ];
  for(const p of paths){
    const whole=path.join(root,p);
    if(!fs.existsSync(whole))continue;
    const content=fs.readFileSync(whole,"utf8");
    if(content.includes("\0"))continue;
    content.split(/\r?\n/).forEach((line,index)=>{
      if(!/(?:\b4\b|\bfour\b|четыр)/i.test(line))return;
      if(!/(?:LLM|модел|model|лимит|обращени|requests?|calls?|default|по умолчанию|nebula-home-status|inputValue)/i.test(line))return;
      // A record about previous failed scenarios is not an expected value.
      const historical=/(?:\b4 FAIL\b|old four-call|прежн.{0,20}4\b|gpt-4[.\-])/i.test(line);
      const entry=p+":"+(index+1)+": "+line.trim().slice(0,210);
      if(!historical)candidate.push(entry);
      if(!historical&&explicit.some(re=>re.test(line)))stale.push(entry);
    });
  }
  process.stdout.write("MODEL_CALL_FOUR_REPO_SCAN "+JSON.stringify({
    trackedTextFiles:paths.length,candidates:candidate.slice(0,80),candidateCount:candidate.length,stale
  })+"\n");
  assert.deepEqual(stale,[],"Stale four-call default found in tracked files");
  return {trackedTextFiles:paths.length,candidates:candidate,stale};
}

if(require.main===module){
  check(fs.readFileSync(path.join(ROOT,".github/workflows/memory-acceptance.yml"),"utf8"),
    fs.readFileSync(path.join(ROOT,"mobile/eval/__tests__/live-memory-model.test.ts"),"utf8"));
  checkQuick(fs.readFileSync(path.join(ROOT,".github/workflows/llm-connectivity.yml"),"utf8"));
  checkNativeSeparation(fs.readFileSync(path.join(ROOT,".github/workflows/memory-acceptance.yml"),"utf8"),
    fs.readFileSync(path.join(ROOT,".github/workflows/ci.yml"),"utf8"));
  checkTrackedDefaultModelLimit();
  process.stdout.write("Paid memory eval guard: manual-only checkbox approval, capped calls; native only in main CI.\n");
}
module.exports={check,checkQuick,checkNativeSeparation,checkTrackedDefaultModelLimit};
