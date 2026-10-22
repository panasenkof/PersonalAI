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

const begin = plan.indexOf("### Постоянные номера новых задач (54–91)");
const end = plan.indexOf("### Anthropic / Claude", begin);
assert.ok(begin >= 0 && end > begin, "Cannot locate permanent task registry in PLAN.md");
const permanent = plan.slice(begin, end);
const numbered = [...permanent.matchAll(/^\|\s*\*{0,2}(\d{2})\*{0,2}\s*\|/gm)]
  .map(m => Number(m[1])).filter(id => id >= 54 && id <= 91).sort((a,b)=>a-b);
assert.deepEqual(numbered, expected.filter(id => id >= 54),
  "Tasks 54–91 must each stay in the permanent PLAN.md registry");

const required = [
  "Plans/ASSISTANT_FEATURES.md",
  "Plans/LOCAL_MULTIMODAL_AI.md",
  "Plans/SMART_HOME.md",
  "docs/design/NEBULA_PRODUCTION_ROLLOUT.md",
  "docs/design/NEBULA_PERFORMANCE_GATE.md",
  "docs/DEVICE_QA.md",
  "openspec/changes/harness-evidence-improvement/tasks.md",
];
required.forEach(file => assert.ok(fs.existsSync(path.join(root, file)), "Missing preserved subplan: " + file));
assert.match(ledger, /42–53/);
assert.match(ledger, /83\.0–83\.6/);
assert.match(ledger, /№91/);
console.log("Roadmap OK: 91 unique IDs, 54–91 retained in PLAN.md, referenced subplans exist.");
