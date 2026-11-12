"use strict";
/**
 * Roadmap integrity gate: never silently drop a numbered PersAI commitment.
 * The authority for task order is PLAN.md; Plans/ROADMAP_STATUS.md inventories
 * distinct statuses, including intentionally deferred or declined items.
 *
 * Usage from mobile/: node scripts/check-roadmap-integrity.cjs
 * Zero npm dependencies so it can run before npm ci.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const plan = read("PLAN.md");
const ledger = read("Plans/ROADMAP_STATUS.md");

assert.match(plan, /^# Единый план PersAI — ред\. \d+/);
assert.match(plan, /\[Plans\/ROADMAP_STATUS\.md\]\(Plans\/ROADMAP_STATUS\.md\)/);

const ledgerRows = [...ledger.matchAll(/^\|\s*(\d{1,3})\s*\|\s*([^|\n]+)\|\s*([^|\n]+)\|\s*([^|\n]+)\|$/gm)]
  .map(match => ({
    id: Number(match[1]),
    status: match[2].trim(),
    title: match[3].trim(),
    remaining: match[4].trim(),
  }));
const expected = Array.from({ length: 91 }, (_, i) => i + 1);
assert.deepEqual(ledgerRows.map(row => row.id), expected, "Plan register must list IDs 1–91 exactly once in order");
for (const row of ledgerRows) {
  assert.ok(row.status.length > 2 && row.title.length > 2 && row.remaining.length > 3,
    "Roadmap entry is incomplete: " + row.id);
}

// Since PLAN.md ред. 96 (11.11.2026) the ledger above is the single registry of
// IDs 1–91; the former duplicate «Постоянные номера новых задач (54–91)» table
// is preserved verbatim in the archived snapshot below, not in the work queue.
const archive = read("Plans/history/PLAN_FULL_2026-11-11.md");
assert.ok(archive.includes("### Постоянные номера новых задач (54–91)"),
  "Archived PLAN.md snapshot with the former 54–91 registry must be preserved");

const required = [
  "Plans/ASSISTANT_FEATURES.md",
  "Plans/LOCAL_MULTIMODAL_AI.md",
  "Plans/SMART_HOME.md",
  "Plans/ANDROID_PERFORMANCE.md",
  "docs/ANDROID_UI_TESTING.md",
  "docs/design/NEBULA_PRODUCTION_ROLLOUT.md",
  "docs/design/NEBULA_PERFORMANCE_GATE.md",
  "docs/DEVICE_QA.md",
  "openspec/changes/harness-evidence-improvement/tasks.md",
];
required.forEach(file => assert.ok(fs.existsSync(path.join(root, file)), "Missing preserved subplan: " + file));
assert.match(ledger, /42–53/);
assert.match(ledger, /83\.0–83\.6/);
assert.match(ledger, /№91/);
console.log("Roadmap OK: 91 unique IDs in Plans/ROADMAP_STATUS.md, archived registry and referenced subplans exist.");
