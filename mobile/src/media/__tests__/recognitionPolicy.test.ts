import { maySendOriginalToProvider } from "../recognitionPolicy";
test("only ordinary notes in ordinary collections can upload stored originals", () => {
  expect(maySendOriginalToProvider("standard", "standard")).toBe(true);
  for (const [note, collection] of [["sensitive", "standard"], ["standard", "sensitive"], ["sensitive", "sensitive"], ["standard", undefined], [undefined, "standard"]] as const)
    expect(maySendOriginalToProvider(note, collection)).toBe(false);
});
