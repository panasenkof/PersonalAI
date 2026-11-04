import {
  memoryScrollReloadCount, memoryScrollRowIndex, memoryScrollScope,
  type MemoryScrollAnchor,
} from "../memoryScrollAnchor";

const home = memoryScrollScope("profile-a", undefined, "active", "");
const collection = memoryScrollScope("profile-a", "photos", "active", "");
const anchor: MemoryScrollAnchor = { scope: home, id: "note-83", index: 82, loaded: 150 };
const notes = Array.from({ length: 150 }, (_, i) => ({ id: `note-${i + 1}` }));

test("an anchor cannot restore into a different profile, collection or query", () => {
  expect(home).not.toBe(collection);
  expect(home).not.toBe(memoryScrollScope("profile-b", undefined, "active", ""));
  expect(home).not.toBe(memoryScrollScope("profile-a", undefined, "trashed", ""));
  expect(home).not.toBe(memoryScrollScope("profile-a", undefined, "active", "bike"));
  expect(memoryScrollRowIndex(notes, anchor, collection, 2)).toBeNull();
  expect(memoryScrollReloadCount(anchor, collection)).toBe(50);
});

test("view changes preserve the identity and calculate row indexes for both layouts", () => {
  expect(memoryScrollRowIndex(notes, anchor, home, 1)).toBe(82);
  expect(memoryScrollRowIndex(notes, anchor, home, 2)).toBe(41);
  expect(memoryScrollReloadCount(anchor, home)).toBe(150);
});

test("an inserted note before the anchor does not change the target identity", () => {
  const reordered = [{ id: "new-note" }, ...notes];
  expect(memoryScrollRowIndex(reordered, anchor, home, 2)).toBe(41);
});

test("a deleted anchor falls back to the nearest surviving row without using another scope", () => {
  const remaining = notes.filter(note => note.id !== anchor.id);
  expect(memoryScrollRowIndex(remaining, anchor, home, 2)).toBe(41);
  expect(memoryScrollRowIndex([], anchor, home, 2)).toBeNull();
});

test("loaded pages above the database 100-row request limit are retained", () => {
  expect(memoryScrollReloadCount({ ...anchor, loaded: 205, index: 190 }, home)).toBe(205);
  expect(memoryScrollReloadCount({ ...anchor, loaded: 30, index: 79 }, home)).toBe(80);
  expect(memoryScrollReloadCount(null, home)).toBe(50);
});
