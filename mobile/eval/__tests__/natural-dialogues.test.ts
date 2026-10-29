import {CASES} from "../domain-fixtures";
import {NATURAL_DIALOGUES,CORE_DIALOGUE_COUNT,FULL_DIALOGUE_COUNT,totalNaturalTurns} from "../natural-dialogues";

/** Free, deterministic corpus contract; a real provider is NEVER contacted. */
test("covers all 54 existing records plus 24 diverse everyday scenarios",()=>{
  expect(CORE_DIALOGUE_COUNT).toBe(54);
  expect(FULL_DIALOGUE_COUNT).toBe(78);
  expect(NATURAL_DIALOGUES).toHaveLength(78);
  expect(totalNaturalTurns).toBe(80);
  expect(new Set(NATURAL_DIALOGUES.map(c=>c.id)).size).toBe(78);
  for(const domain of ["car","recipes","web","home","medical"]){
    expect(NATURAL_DIALOGUES.some(x=>x.domain===domain)).toBe(true);
  }
});

test.each(CASES)("NATURAL $id: blind natural-language question, evidence-only oracle",row=>{
  const d=NATURAL_DIALOGUES.find(x=>x.id==="NATURAL-"+row.id)!;
  expect(d).toBeDefined();
  expect(d.domain).toBe(row.domain);
  expect(d.turns).toHaveLength(1);
  const t=d.turns[0];
  expect(t.question.length).toBeGreaterThan(22);
  expect(t.question).not.toBe(row.phrase);
  expect(t.question).toMatch(/[а-яё]/i);
  expect(/[?.!]$/.test(t.question)).toBe(true);
  if(row.scope==="standard"){
    expect(t.required).toEqual([row.id]);
    expect(t.policy).toBeUndefined();
    expect(t.match).toBeTruthy();
    const answerPattern=t.match;
    if(!answerPattern)throw Error("Missing expected answer for "+row.id);
    expect(()=>new RegExp(answerPattern,"i")).not.toThrow();
  }else{
    expect(t.policy).toBe("withheld");
    expect(t.privateId).toBe(row.id);
    expect(t.required).toBeUndefined();
    expect(t.match).toBeUndefined();
  }
});

test("follow-up dialogues use real conversational context, not injected record identifiers",()=>{
  const multi=NATURAL_DIALOGUES.filter(c=>c.turns.length>1);
  expect(multi).toHaveLength(2);
  expect(multi.every(x=>x.turns[1].question.match(/а |во втором/i))).toBe(true);
  expect(NATURAL_DIALOGUES.some(x=>x.turns.some(t=>t.required?.length===2))).toBe(true);
  expect(NATURAL_DIALOGUES.some(x=>x.turns.some(t=>t.policy==="unknown"))).toBe(true);
  expect(NATURAL_DIALOGUES.some(x=>x.turns.some(t=>t.policy==="withheld"))).toBe(true);
});

test("no accidental private source IDs appear as positive ground-truth references",()=>{
  const byId=new Map(CASES.map(c=>[c.id,c]));
  for(const d of NATURAL_DIALOGUES){
    for(const t of d.turns){
      expect(t.question).not.toContain("PRIVATE_RECORD_");
      for(const id of t.required??[]){
        expect(byId.has(id)).toBe(true);
        expect(byId.get(id)!.scope).toBe("standard");
      }
      if(t.privateId)expect(byId.get(t.privateId)?.scope).toBe("sensitive");
    }
  }
});
