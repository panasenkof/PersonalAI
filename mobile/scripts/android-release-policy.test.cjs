#!/usr/bin/env node
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const { latestAndroidApkRelease, getReleaseCommit, decideAndroidBuild } = require("./android-release-policy.cjs");

const release = (sha, tag = "android-test-b100-a1", time = "2026-10-22T08:00:00Z") => ({
  tag_name: tag, published_at: time, draft: false, prerelease: true,
  target_commitish: sha, body: "Android test APK built from verified main commit " + sha + ".",
  assets: [{ name: "PersAI-" + tag + ".apk" }, { name: "checksum.sha256" }],
});

function repoWithCommits(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "persai-release-"));
  const git = (...args) => cp.execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  const commit = (file, content) => {
    const pathname = path.join(dir, file);
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.writeFileSync(pathname, content);
    git("add", file);
    git("commit", "-qm", file);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    return fn({ dir, git, commit });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("last real APK ignores unrelated releases and drafts, preferring newest published APK", () => {
  const a = "a".repeat(40), b = "b".repeat(40);
  assert.equal(latestAndroidApkRelease([
    release(a, "android-test-b10-a1", "2026-10-20T10:00:00Z"),
    { ...release(b, "android-test-b20-a1", "2026-10-22T10:00:00Z"), assets: [] },
    { ...release(b, "android-test-b21-a1", "2026-10-22T11:00:00Z"), draft: true },
    release(b, "android-test-b15-a1", "2026-10-21T10:00:00Z"),
  ]).target_commitish, b);
  assert.equal(latestAndroidApkRelease([]), null);
});

test("release SHA comes from recorded build notes or target, but conflicting metadata fails", () => {
  const a = "a".repeat(40), b = "b".repeat(40);
  assert.equal(getReleaseCommit({ ...release(a), target_commitish: "main" }), a);
  assert.equal(getReleaseCommit({ ...release(a), body: "legacy release" }), a);
  assert.throws(() => getReleaseCommit({ ...release(a), target_commitish: b }), /disagrees/);
  assert.throws(() => getReleaseCommit({ ...release(a), body: "", target_commitish: "main" }), /verifiable/);
});

test("docs-only HEAD after unreleased mobile commit STILL creates an automatic APK", () => {
  repoWithCommits(({ dir, commit }) => {
    const baseline = commit("mobile/app.js", "old");
    commit("mobile/app.js", "changed");
    const docsTip = commit("PLAN.md", "documentation");
    const result = decideAndroidBuild({
      eventName: "workflow_run", targetSha: docsTip, releases: [release(baseline)], cwd: dir,
    });
    assert.equal(result.needed, true);
    assert.deepEqual(result.changedFiles, ["mobile/app.js"]);
  });
});

test("docs-only commits since the last published APK do not rebuild", () => {
  repoWithCommits(({ dir, commit }) => {
    const baseline = commit("mobile/app.js", "already published");
    const docsTip = commit("PLAN.md", "documentation");
    const result = decideAndroidBuild({
      eventName: "workflow_run", targetSha: docsTip, releases: [release(baseline)], cwd: dir,
    });
    assert.equal(result.needed, false);
  });
});

test("published SHA, absent baseline and manual dispatch have distinct behavior", () => {
  repoWithCommits(({ dir, commit }) => {
    const sha = commit("mobile/app.js", "test");
    assert.equal(decideAndroidBuild({ eventName: "workflow_run", targetSha: sha, releases: [release(sha)], cwd: dir }).needed, false);
    assert.equal(decideAndroidBuild({ eventName: "workflow_run", targetSha: sha, releases: [], cwd: dir }).needed, true);
    assert.equal(decideAndroidBuild({ eventName: "workflow_dispatch", targetSha: sha, cwd: dir }).needed, true);
  });
});

test("released commit not on main ancestry is never used for a silent false negative", () => {
  repoWithCommits(({ dir, git, commit }) => {
    const old = commit("mobile/app.js", "base");
    git("checkout", "-qb", "alternate");
    const unrelated = commit("mobile/app.js", "unrelated");
    git("checkout", "-q", "master");
    const target = commit("PLAN.md", "tip");
    assert.notEqual(unrelated, old);
    assert.throws(() => decideAndroidBuild({
      eventName: "workflow_run", targetSha: target, releases: [release(unrelated)], cwd: dir,
    }), /not an ancestor/);
  });
});

test("Android release workflow edits count, arbitrary documentation does not", () => {
  repoWithCommits(({ dir, commit }) => {
    const baseline = commit("PLAN.md", "start");
    const target = commit(".github/workflows/android-test-apk.yml", "new");
    assert.equal(decideAndroidBuild({ eventName: "workflow_run", targetSha: target, releases: [release(baseline)], cwd: dir }).needed, true);
  });
});
