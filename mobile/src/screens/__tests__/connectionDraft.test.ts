import { connectionDraftFingerprint } from "../connectionDraft";
const model = { id: "a", name: "Сервис", model: "model", apiKey: "secret", provider: "openai", baseUrl: "https://api.example.org/v1", allowWeb: false };
const saved: any = { activeId: "a", connections: [model, { ...model, id: "b", name: "Другой" }] };
test("switching the active connection is pending until Save", () => {
  const baseline = connectionDraftFingerprint(saved, saved.activeId);
  expect(connectionDraftFingerprint(saved, "a")).toBe(baseline);
  expect(connectionDraftFingerprint(saved, "b")).not.toBe(baseline);
});
test("changing credentials and web preference are unsaved even when connection ID is unchanged", () => {
  const baseline = connectionDraftFingerprint(saved, saved.activeId);
  expect(connectionDraftFingerprint({ ...saved, connections: [{ ...model, apiKey: "other" }, saved.connections[1]] }, "a")).not.toBe(baseline);
  expect(connectionDraftFingerprint({ ...saved, connections: [{ ...model, allowWeb: true }, saved.connections[1]] }, "a")).not.toBe(baseline);
  expect(connectionDraftFingerprint(saved, "a")).toBe(baseline);
});
