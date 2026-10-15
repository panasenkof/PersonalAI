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
