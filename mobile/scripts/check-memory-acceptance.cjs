"use strict";
/**
 * D / №66, 72, 77, 79: preserve the ONE 96-case memory acceptance contract.
 * This is an integrity gate, not a substitute for SQLCipher/Android E2E tests.
 * Run before npm install: node mobile/scripts/check-memory-acceptance.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "../..");
const PREFIXES = ["TIME","CAR","REL","MED","DOC","MEDIA","SEARCH","SAVE","SEC","CLEAN","BKP","ACT"];
const IDS = PREFIXES.flatMap(prefix =>
  Array.from({length:8},(_,i)=>prefix+"-"+String(i+1).padStart(2,"0")));
const ID_PATTERN = /^\|\s*((?:TIME|CAR|REL|MED|DOC|MEDIA|SEARCH|SAVE|SEC|CLEAN|BKP|ACT)-\d{2})\s*\|/gm;
const expectedPath = /\`([^\`]+\.(?:test\.[a-z]+|cjs))\`/;
function idsIn(text) { return [...text.matchAll(ID_PATTERN)].map(m=>m[1]); }
function validate(matrix, acceptance, fileExists=()=>true) {
  const required=idsIn(matrix), reported=idsIn(acceptance);
  assert.deepEqual(required,IDS,"The original 96 scenarios must remain complete and ordered");
  assert.deepEqual(reported,IDS,"Acceptance must cover all original 96 IDs once in order");
  // Avoid a stateful /g test() across separate lines (would skip rows).
  const rows=acceptance.split("\n").filter(line=>
    /^\|\s*(?:TIME|CAR|REL|MED|DOC|MEDIA|SEARCH|SAVE|SEC|CLEAN|BKP|ACT)-\d{2}\s*\|/.test(line));
  assert.equal(rows.length,96,"Exactly 96 acceptance rows required");
  for (const line of rows) {
    const cells=line.split("|").slice(1,-1).map(s=>s.trim());
    assert.equal(cells.length,6,"Acceptance row requires six columns: "+line);
    const [id,scenario,c1,c1Evidence,c2,c2Evidence]=cells;
    assert.ok(scenario.length>3,"Missing scenario text: "+id);
    assert.ok(["PARTIAL_C1","REVIEW_REQUIRED","C1_PASS_EXACT_SHA"].includes(c1),
      "Unrecognized C1 evidence state: "+id);
    assert.ok(["NOT_RUN_PHYSICAL","C2_VERIFIED"].includes(c2),
      "Unrecognized physical evidence state: "+id);
    if(c1==="REVIEW_REQUIRED")
      assert.equal(c1Evidence,"—","Unreviewed scenario must not claim evidence: "+id);
    if(c1==="PARTIAL_C1"){
      const found=c1Evidence.match(expectedPath);
      assert.ok(found,"Partial C1 needs an actual test path: "+id);
      assert.ok(fileExists(found[1]),"Missing C1 test path for "+id+": "+found[1]);
    }
    if(c1==="C1_PASS_EXACT_SHA"){
      // A test name alone is not proof. Require a named test, exact commit and
      // CI run, rather than a broad green build or a synthetic fixture.
      assert.match(c1Evidence,/\`[^\`]+\.test\.[a-z]+\`/,"Missing E2E test for "+id);
      assert.match(c1Evidence,/\b[0-9a-f]{40}\b/,"Missing exact commit for "+id);
      assert.match(c1Evidence,/actions\/runs\/\d+/,"Missing CI run for "+id);
    }
    if(c2==="NOT_RUN_PHYSICAL")
      assert.equal(c2Evidence,"—","Do not imply a device test without physical evidence: "+id);
    else assert.ok(c2Evidence!=="—" && c2Evidence.length>15,
      "Physical C2 needs identifiable real-device evidence: "+id);
  }
  return {scenarios:96,partial:rows.filter(l=>l.includes("| PARTIAL_C1 |")).length};
}
if(require.main===module){
  const read=file=>fs.readFileSync(path.join(ROOT,file),"utf8");
  const result=validate(read("Plans/MEMORY_SCENARIO_MATRIX_2026-10-27.md"),
    read("Plans/MEMORY_96_SCENARIO_ACCEPTANCE_2026-10-28.md"),
    relative=>fs.existsSync(path.join(ROOT,relative)));
  process.stdout.write("Memory acceptance registry intact: "+result.scenarios+
    " scenarios; "+result.partial+" PARTIAL_C1 (not full PASS).\n");
}
module.exports={validate};
