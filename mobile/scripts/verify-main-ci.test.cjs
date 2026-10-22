#!/usr/bin/env node
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  verifyAutomaticCi, verifyManualCi, isVerifiedRun,
} = require("./verify-main-ci.cjs");

const SHA = "6d31db5141553ef79b8cbf0e2d3add39aa481567";
const REPO = "panasenkof/PersonalAI";
const run = () => ({
  name: "CI", path: ".github/workflows/ci.yml@main",
  event: "push", head_branch: "main", head_sha: SHA,
  status: "completed", conclusion: "success",
  head_repository: { full_name: REPO },
});
const event = () => ({ action: "completed", workflow_run: run() });

test("RG-01: exact successful main CI workflow_run passes (no re-query needed)", () => {
  assert.equal(verifyAutomaticCi(event(), SHA, REPO), true);
});

test("RG-02: fails closed for wrong SHA, repo, branch, event, workflow, status or conclusion", () => {
  for (const [field, value] of [
    ["head_sha", "a".repeat(40)], ["head_branch", "feature"],
    ["event", "pull_request"], ["name", "Build"], ["path", ".github/workflows/other.yml"],
    ["status", "in_progress"], ["conclusion", "failure"], ["conclusion", "cancelled"],
    ["head_repository", { full_name: "other/repository" }],
  ]) {
    const candidate = event();
    candidate.workflow_run[field] = value;
    assert.equal(verifyAutomaticCi(candidate, SHA, REPO), false, field);
  }
  assert.equal(verifyAutomaticCi({ ...event(), action: "requested" }, SHA, REPO), false);
  assert.equal(verifyAutomaticCi({}, SHA, REPO), false);
});

test("RG-03: manual release only accepts an exact completed push CI for same main SHA", () => {
  assert.equal(verifyManualCi({ workflow_runs: [run()] }, SHA, REPO), true);
  assert.equal(verifyManualCi({ workflow_runs: [run()] }, "b".repeat(40), REPO), false);
  assert.equal(verifyManualCi({ workflow_runs: [{ ...run(), event: "pull_request" }] }, SHA, REPO), false);
  assert.equal(verifyManualCi({ workflow_runs: [{ ...run(), head_repository: { full_name: "bad/repo" } }] }, SHA, REPO), false);
  assert.equal(verifyManualCi({ workflow_runs: [{ ...run(), conclusion: "skipped" }] }, SHA, REPO), false);
  assert.equal(verifyManualCi({ workflow_runs: [null, { name: "APK" }] }, SHA, REPO), false);
  assert.equal(verifyManualCi(null, SHA, REPO), false);
  assert.equal(isVerifiedRun(null, SHA, REPO), false);
});

test("RG-04: YAML uses verified event/API helper instead of jq env filter, preserves main checks", () => {
  const workflow = fs.readFileSync(path.join(__dirname, "..", "..", ".github", "workflows", "android-test-apk.yml"), "utf8");
  assert.match(workflow, /node mobile\/scripts\/verify-main-ci\.cjs/);
  assert.doesNotMatch(workflow, /env\.TARGET_SHA/);
  assert.match(workflow, /git rev-parse HEAD/);
  assert.match(workflow, /git\/ref\/heads\/main/);
  assert.match(workflow, /Check cumulative Android changes since last published APK/);
  assert.match(workflow, /Verify APK, embedded JS and signing certificate/);
});
