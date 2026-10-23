"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const root = path.join(__dirname, "..");
const flowNames = ["minimal", "memory-note", "settings", "import-url", "import-photo"];
const runner = fs.readFileSync(path.join(__dirname, "android-native-flows.sh"), "utf8");
const workflow = fs.readFileSync(path.join(root, "..", ".github/workflows/mobile-native-sqlcipher.yml"), "utf8");
test("required Android job runs only the minimal native smoke", () => {
  assert.equal(workflow.split("bash mobile/scripts/android-native-flows.sh").length - 1, 1 - 1, "expanded suite must not block CI");
  assert.equal(workflow.split("script: bash mobile/scripts/android-ui-smoke.sh").length - 1, 2, "minimal flow required on both AVD attempts");
  assert.match(runner, /set -euo pipefail/);
  assert.match(runner, /for scenario in memory-note settings import-url import-photo/);
  assert.match(runner, /maestro test --format junit/);
  assert.match(runner, /junit-\$scenario\.xml/);
  assert.doesNotMatch(runner, /locksettings/);
});
for (const name of flowNames) {
  test("flow " + name + " is independent, real-unlocked, and has assertions", () => {
    const yaml = fs.readFileSync(path.join(root, ".maestro/flows", name + ".yaml"), "utf8");
    assert.match(yaml, /^appId: com\.paigent\.app/m);
    assert.match(yaml, /- launchApp:\s*\n\s*clearState: true/);
    assert.match(yaml, /- runFlow: \.\.\/unlock\.yaml/);
    assert.match(yaml, /- (assertVisible|extendedWaitUntil):/);
  });
}
test("native test selectors reflect current production components", () => {
  const read = p => fs.readFileSync(path.join(root, "src", p), "utf8");
  const note = read("screens/MemoryNoteScreen.tsx");
  const importer = read("screens/MemoryImportScreen.tsx");
  const viewer = read("media/AttachmentView.tsx");
  const settings = read("components/AgentLimitsCard.tsx");
  for (const tag of ["note-title-input", "note-body-input", "note-save-button"]) assert.ok(note.includes(tag), tag);
  for (const tag of ["Ссылка для импорта", "Изменить источник", "Сохранить сведения в память"]) assert.ok(importer.includes(tag), tag);
  for (const tag of ["Открыть фото", "Просмотр изображения"]) assert.ok(viewer.includes(tag), tag);
  assert.ok(settings.includes("Лимит обращений к LLM на сообщение"));
});
test("reopening an editor must not send Android Back via hideKeyboard before editing", () => {
  const flow = fs.readFileSync(path.join(root, ".maestro/flows/memory-note.yaml"), "utf8");
  const point = flow.indexOf('- assertVisible: "Saved offline"');
  assert.ok(point >= 0, "native persistence assertion must remain");
  const nextInput = flow.indexOf('- tapOn:\n    id: "note-body-input"', point);
  assert.ok(nextInput > point, "tap existing editor after the persistence assertion");
  assert.doesNotMatch(flow.slice(point, nextInput).split("\n").filter(line => !line.trim().startsWith("#")).join("\n"), /hideKeyboard|scrollUntilVisible/, "no navigation-triggering actions between saved text and editor tap");
});
test("generated fixture is an offline PNG", () => {
  const { png } = require("./prepare-maestro-fixtures.cjs");
  const data = png();
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  for (const marker of ["IHDR", "IDAT", "IEND"]) assert.ok(data.includes(Buffer.from(marker)), marker);
  assert.ok(data.length > 80);
});
