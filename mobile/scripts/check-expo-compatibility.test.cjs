"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRemoteMismatches, onlyUnpublishedPatches } = require("./check-expo-compatibility.cjs");

const manifest = { dependencies: {
  expo: "~57.0.32", "expo-constants": "~57.0.22",
  "expo-sharing": "~57.0.25", "expo-sqlite": "~57.0.4",
} };
const lock = { packages: {
  "node_modules/expo": { version: "57.0.32" },
  "node_modules/expo-constants": { version: "57.0.23" },
  "node_modules/expo-sharing": { version: "57.0.25" },
  "node_modules/expo-sqlite": { version: "57.0.4" },
} };
const output = [
  "The following packages should be updated for best compatibility:",
  "  expo@57.0.32 - expected version: ~57.0.33",
  "  expo-constants@57.0.23 - expected version: ~57.0.24",
  "  expo-sharing@57.0.25 - expected version: ~57.0.26",
  "  expo-sqlite@57.0.4 - expected version: ~57.0.5",
  "Found outdated dependencies",
].join("\n");

test("recognized exactly four one-patch-ahead remote versions", () => {
  const issues = parseRemoteMismatches(output);
  assert.equal(issues.length, 4);
  assert.ok(issues.every(x => x.expected.startsWith("57.0.")));
});
test("only confirmed npm-unpublished versions permit temporary pinned lock", () => {
  assert.equal(onlyUnpublishedPatches(output, manifest, lock, () => "unpublished"), true);
  assert.equal(onlyUnpublishedPatches(output, manifest, lock, () => "published-or-unknown"), false);
});
test("published, mismatched or unapproved packages fail closed", () => {
  assert.equal(onlyUnpublishedPatches(output.replace("expo-sqlite@", "react-native@"), manifest, lock, () => "unpublished"), false);
  assert.equal(onlyUnpublishedPatches(output.replace("57.0.33", "57.0.34"), manifest, lock, () => "unpublished"), false);
  assert.equal(onlyUnpublishedPatches(output, manifest, { packages: {} }, () => "unpublished"), false);
  assert.equal(onlyUnpublishedPatches("npm failed due to registry authentication", manifest, lock, () => "unpublished"), false);
  assert.equal(onlyUnpublishedPatches(output.replace("expo@57.0.32", "expo@57.0.31"), manifest, lock, () => "unpublished"), false);
});
