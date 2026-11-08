import { PROPOSABLE_SECTIONS, SECTIONS, ensureSections, orderCollections, sectionGuide } from "../sections";

function repo(initial: any[] = []) {
  const collections = [...initial];
  return {
    collections,
    listCollections: jest.fn(async () => [...collections]),
    createCollection: jest.fn(async (c: any) => { const r = { id: "id-" + c.slug, description: null, created_at: "2026-10-14T00:00:0" + collections.length, ...c }; collections.push(r); return r; }),
  };
}

test("all built-in sections are created once, with documents kept personal", async () => {
  const db = repo();
  const first = await ensureSections(db);
  expect(first.map(c => c.slug)).toEqual(SECTIONS.map(s => s.slug));
  expect(first.find(c => c.slug === "documents")?.sensitivity).toBe("sensitive");
  await ensureSections(db);
  expect(db.createCollection).toHaveBeenCalledTimes(SECTIONS.length);
});

test("existing sections and the user's own are kept untouched and ordered after built-ins", async () => {
  const db = repo([
    { id: "mine", slug: "section-1", name: "Рецепты", sensitivity: "standard", description: null, created_at: "2026-01-01" },
    { id: "old-notes", slug: "notes", name: "Мои заметки", sensitivity: "secret", description: null, created_at: "2025-01-01" },
  ]);
  const all = await ensureSections(db);
  expect(all.find(c => c.slug === "notes")).toMatchObject({ id: "old-notes", name: "Мои заметки", sensitivity: "secret" });
  expect(all[all.length - 1].id).toBe("mine");
  expect(db.createCollection).not.toHaveBeenCalledWith(expect.objectContaining({ slug: "notes" }));
});

test("the assistant can propose every section except personal documents", () => {
  expect(PROPOSABLE_SECTIONS).toEqual(["about", "people", "projects", "preferences", "dates", "notes"]);
  expect(sectionGuide()).toContain("people — Люди");
  expect(sectionGuide()).not.toContain("documents");
  expect(orderCollections([{ slug: "x", created_at: "1" } as any, { slug: "about", created_at: "2" } as any]).map(c => c.slug)).toEqual(["about", "x"]);
});


test("nested paths have no configured depth limit and preserve sibling identities", () => {
  const base = {sensitivity:"standard",description:null,created_at:"2026-11-08"};
  const rows = [
    {id:"root",slug:"ai",name:"ИИ",parent_id:null,...base},
    {id:"child",slug:"training",name:"Обучение",parent_id:"root",...base},
    {id:"skills",slug:"skills",name:"Полезные скиллы",parent_id:"child",...base},
    {id:"other",slug:"other",name:"Обучение",parent_id:null,...base},
  ];
  const {collectionTree,collectionPath,validCollectionParents}=require("../sections");
  expect(validCollectionParents(rows)).toBe(true);
  expect(collectionTree(rows).map((item:any)=>item.path)).toEqual([
    "ИИ","ИИ / Обучение","ИИ / Обучение / Полезные скиллы","Обучение",
  ]);
  expect(collectionPath(rows[2],rows)).toBe("ИИ / Обучение / Полезные скиллы");
  expect(validCollectionParents([{id:"one",parent_id:"two"},{id:"two",parent_id:"one"}])).toBe(false);
  expect(validCollectionParents([{id:"a",parent_id:"missing"}])).toBe(false);
  expect(validCollectionParents([{id:"a",parent_id:"a"}])).toBe(false);
});

test("model resolves identical subsection names only by path or stable slug", () => {
  const {findSection,factProposal}=require("../../direct-agent/fact-tool");
  const sections=[
    {slug:"one",name:"Обучение",path:"ИИ / Обучение"},
    {slug:"two",name:"Обучение",path:"Работа / Обучение"},
  ];
  expect(findSection("ИИ / Обучение",sections)?.slug).toBe("one");
  expect(findSection("two",sections)?.slug).toBe("two");
  expect(findSection("Обучение",sections)).toBeUndefined();
  expect(()=>factProposal({title:"Тест",body:"Содержимое",section:"Обучение"},sections))
    .toThrow("ambiguous_section_path");
});


test("v19 imported collection parents must not downgrade sensitivity",()=>{
  const {validCollectionParents}=require("../sections");
  expect(validCollectionParents([
    {id:"sensitive",parent_id:null,sensitivity:"sensitive"},
    {id:"public",parent_id:"sensitive",sensitivity:"standard"},
  ])).toBe(false);
});
