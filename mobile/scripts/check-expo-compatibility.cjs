#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Run the REAL Expo SDK validation. Never mask a published mismatch or a
// failure unrelated to a not-yet-published SDK patch recommendation.
const UNPUBLISHED_PATCH_ALLOWLIST = new Set([
  "expo", "expo-constants", "expo-sharing", "expo-sqlite",
]);

function parseRemoteMismatches(output) {
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const mismatches = [];
  for (const line of lines) {
    if (!line.includes(" - expected version:")) continue;
    const match = line.match(/^\s+([a-z0-9@/_-]+)@([0-9]+\.[0-9]+\.[0-9]+) - expected version: ~?([0-9]+\.[0-9]+\.[0-9]+)\s*$/);
    if (!match) return null; // Unrecognized diagnostics must fail closed.
    mismatches.push({ name: match[1], installed: match[2], expected: match[3] });
  }
  return mismatches;
}

function isOneUnpublishedPatchAhead(m, manifest, lock) {
  if (!UNPUBLISHED_PATCH_ALLOWLIST.has(m.name)) return false;
  const existing = lock.packages?.["node_modules/" + m.name]?.version;
  const declared = manifest.dependencies?.[m.name];
  if (!existing || !declared || existing !== m.installed) return false;
  const before = existing.split(".").map(Number), after = m.expected.split(".").map(Number);
  return before.length === 3 && after.length === 3 &&
    before.every(Number.isSafeInteger) && after.every(Number.isSafeInteger) &&
    before[0] === after[0] && before[1] === after[1] && before[2] + 1 === after[2] &&
    // The manifest/lock retain a tested, compatible patch in this SDK family.
    (declared === "~" + existing || declared === existing ||
      (declared.startsWith("~") && declared.slice(1).split(".").slice(0, 2).join(".") ===
        before.slice(0, 2).join(".") && Number(declared.slice(1).split(".")[2]) <= before[2]));
}

function onlyUnpublishedPatches(output, manifest, lock, probe) {
  if (!output.includes("Found outdated dependencies")) return false;
  const issues = parseRemoteMismatches(output);
  if (!issues || issues.length === 0) return false;
  if (issues.some(issue => !isOneUnpublishedPatchAhead(issue, manifest, lock))) return false;
  // A published version MUST be installed. Only a confirmed npm E404 permits
  // keeping the already-lockfile-pinned previous patch temporarily.
  return issues.every(issue => probe(issue.name, issue.expected) === "unpublished");
}

function run(command, args, extra = {}) {
  return spawnSync(command, args, {
    cwd: path.resolve(__dirname, ".."), encoding: "utf8",
    timeout: 120000, maxBuffer: 4 * 1024 * 1024, ...extra,
  });
}

function main() {
  const expo = run("npx", ["expo", "install", "--check"]);
  const output = (expo.stdout || "") + "\n" + (expo.stderr || "");
  process.stdout.write(output);
  if (expo.status === 0) return;
  if (expo.error || expo.signal) process.exit(1);

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package-lock.json"), "utf8"));
  const accepted = onlyUnpublishedPatches(output, manifest, lock, (name, version) => {
    const lookup = run("npm", ["view", name + "@" + version, "version", "--json"], {
      timeout: 20000, env: { ...process.env, npm_config_fetch_retries: "0" },
    });
    // npm uses E404 OR ETARGET depending on the registry/CLI generation.
    // Both mean an exact queried version has not been published. Never
    // treat timeouts, permission errors or arbitrary failures as "missing".
    const diagnostic = (lookup.stderr || "").replace(/\\x1b\\[[0-9;]*m/g, "");
    const isAbsent = /\\b(?:E404|ETARGET)\\b|404 Not Found|No match(?:ing)? (?:version )?found for/i.test(diagnostic);
    const accepted = lookup.status !== 0 && !lookup.error && !lookup.signal && isAbsent;
    console.warn("Expo npm probe " + name + "@" + version +
      ": " + (accepted ? "not published" : "published, unreachable or unexpected response") +
      " (exit=" + lookup.status + ", code=" +
      (diagnostic.match(/\\b(?:E404|ETARGET|E401|E403|ENOTFOUND|ETIMEDOUT)\\b/) || ["unknown"])[0] + ")");
    return accepted ? "unpublished" : "published-or-unknown";
  });
  if (!accepted) {
    console.error("Expo SDK dependency validation failed; mismatch is not a confirmed unpublished patch.");
    process.exit(1);
  }
  console.warn("Expo remote SDK matrix requests one-patch-ahead versions absent from npm. " +
    "The exact previously-tested SDK versions remain locked; future CI will fail as soon as npm publishes them.");
}
if (require.main === module) main();
module.exports = { parseRemoteMismatches, isOneUnpublishedPatchAhead, onlyUnpublishedPatches };
