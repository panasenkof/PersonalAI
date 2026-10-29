"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {validate}=require("./check-memory-acceptance.cjs");
const prefixes=["TIME","CAR","REL","MED","DOC","MEDIA","SEARCH","SAVE","SEC","CLEAN","BKP","ACT"];
const ids=prefixes.flatMap(p=>Array.from({length:8},(_,i)=>p+"-"+String(i+1).padStart(2,"0")));
const matrix=ids.map(id=>"| "+id+" | synthetic scenario | expected | forbidden |").join("\n");
const ledger=ids.map(id=>"| "+id+" | synthetic scenario | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |").join("\n");
test("the unique 96-case registry remains complete",()=>{
  assert.equal(validate(matrix,ledger).scenarios,96);
});
test("a missing, repeated, or reordered case fails the gate",()=>{
  assert.throws(()=>validate(matrix,ledger.replace("| TIME-01 |","| TIME-99 |")));
  assert.throws(()=>validate(matrix,ledger.split("\n").reverse().join("\n")));
  assert.throws(()=>validate(matrix.replace("| CAR-01 |","| CAR-02 |"),ledger));
});
test("partial evidence must be an existing test; no synthetic PASS inflation",()=>{
  const partial=ledger.replace("| REVIEW_REQUIRED | — |","| PARTIAL_C1 | \`mobile/src/real.test.ts\` |");
  assert.throws(()=>validate(matrix,partial,()=>false));
  assert.equal(validate(matrix,partial,()=>true).partial,1);
  const fabricated=ledger.replace("| REVIEW_REQUIRED | — |","| C1_PASS_EXACT_SHA | \`mobile/src/real.test.ts\` |");
  assert.throws(()=>validate(matrix,fabricated));
});
test("device verification cannot be implied by green unit or Android emulator CI",()=>{
  const wrong=ledger.replace("| NOT_RUN_PHYSICAL | — |","| NOT_RUN_PHYSICAL | CI emulator PASS |");
  assert.throws(()=>validate(matrix,wrong));
});
