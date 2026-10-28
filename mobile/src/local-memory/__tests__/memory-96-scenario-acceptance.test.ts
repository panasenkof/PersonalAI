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
  "^\\|\\s*("+idPattern+")\\s*\\|\\s*([^|]+)\\|\\s*(PARTIAL_C1|REVIEW_REQUIRED|C1_PASS_EXACT_SHA)\\s*\\|\\s*([^|]+)\\|\\s*(NOT_RUN_PHYSICAL|C2_VERIFIED)\\s*\\|\\s*([^|]+)\\|\\s*$","gm",
))].map(match=>({id:match[1],name:match[2].trim(),
  c1:match[3],evidence:match[4].trim(),c2:match[5],c2Evidence:match[6].trim()}));

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

test("cross-domain gate: C1 PASS requires exact SHA+test; C2 PASS requires real QA report",()=>{
  for(const row of ledgerRows){
    expect(row.name.length).toBeGreaterThan(3);
    if(row.c1==="PARTIAL_C1"||row.c1==="C1_PASS_EXACT_SHA"){
      const evidence=row.c1==="PARTIAL_C1"
        ? row.evidence.match(/^`(mobile\/src\/.*\.test\.tsx?)`$/)
        : row.evidence.match(/^`(mobile\/src\/.*\.test\.tsx?)` @ `([0-9a-f]{40})` CI:https:\/\/github\.com\/panasenkof\/PersonalAI\/actions\/runs\/\d+$/);
      expect(evidence).not.toBeNull();
      expect(existsSync(resolve(root,evidence![1]))).toBe(true);
    }else{
      expect(row.evidence).toBe("—");
    }
    if(row.c2==="C2_VERIFIED"){
      // Preserve a concrete, versioned, human-reviewed Android QA report.
      const evidence=row.c2Evidence.match(/^`(Plans\/[A-Za-z0-9_./-]+\.md)`$/);
      expect(evidence).not.toBeNull();
      expect(existsSync(resolve(root,evidence![1]))).toBe(true);
    }else{
      expect(row.c2).toBe("NOT_RUN_PHYSICAL");
      expect(row.c2Evidence).toBe("—");
    }
  }
  expect(ledger).toContain("C1_PASS_EXACT_SHA");
  expect(ledger).toContain("C2_VERIFIED");
});
