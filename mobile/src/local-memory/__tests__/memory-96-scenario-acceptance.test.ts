/** Static acceptance gate, NOT a claim that all 96 E2E scenarios pass.
 * The independent run/CI/evidence chain remains mandatory in PLAN.md §2.
 * Any new or accidentally dropped scenario must cause a regression failure.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root=resolve(__dirname,"../../../..");
const source=readFileSync(resolve(root,"Plans/MEMORY_SCENARIO_MATRIX_2026-10-27.md"),"utf8");
const ledger=readFileSync(resolve(root,"Plans/MEMORY_96_SCENARIO_ACCEPTANCE_2026-10-28.md"),"utf8");
const categories=["TIME","CAR","REL","MED","DOC","MEDIA","SEARCH","SAVE","SEC","CLEAN","BKP","ACT"] as const;
const idPattern="(?:"+categories.join("|")+")-\\d{2}";
const matrixIds=[...source.matchAll(new RegExp("^\\|\\s*("+idPattern+")\\s*\\|","gm"))].map(x=>x[1]);
const ledgerRows=[...ledger.matchAll(new RegExp(
  "^\\|\\s*("+idPattern+")\\s*\\|\\s*([^|]+)\\|\\s*(PARTIAL_C1|REVIEW_REQUIRED)\\s*\\|\\s*([^|]+)\\|\\s*(NOT_RUN_PHYSICAL)\\s*\\|\\s*$","gm",
))].map(match=>({id:match[1],name:match[2].trim(),
  c1:match[3],evidence:match[4].trim(),c2:match[5]}));

test("cross-domain gate: every one of the 96 independently specified IDs has exactly one acceptance row",()=>{
  expect(matrixIds).toHaveLength(96);
  expect(new Set(matrixIds).size).toBe(96);
  expect(ledgerRows).toHaveLength(96);
  expect(new Set(ledgerRows.map(r=>r.id)).size).toBe(96);
  expect(ledgerRows.map(r=>r.id)).toEqual(matrixIds);
  for(const category of categories){
    expect(matrixIds.filter(id=>id.startsWith(category+"-"))).toEqual(
      Array.from({length:8},(_,n)=>category+"-"+String(n+1).padStart(2,"0")));
  }
});
test("cross-domain gate: partial evidence exists, and neither synthetic CI nor mock passes physical QA",()=>{
  for(const row of ledgerRows){
    expect(row.name.length).toBeGreaterThan(3);
    expect(row.c2).toBe("NOT_RUN_PHYSICAL");
    if(row.c1==="PARTIAL_C1"){
      expect(row.evidence).toMatch(/^\`mobile\/src\/.*\.test\.tsx?\`$/);
      const target=resolve(root,row.evidence.slice(1,-1));
      expect(existsSync(target)).toBe(true);
    }else{
      expect(row.evidence).toBe("—");
    }
  }
  expect(ledger).toContain("НЕТ СТАТУСА PASS");
  expect(ledger).toContain("45 TM и 28 RE");
});
