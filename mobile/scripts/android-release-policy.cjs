#!/usr/bin/env node
"use strict";

// Automatic releases compare with the last *published APK*, not only HEAD^.
// A docs-only merge after a skipped/stale build must not hide pending mobile changes.
const fs = require("node:fs");
const cp = require("node:child_process");

const SHA = /^[0-9a-f]{40}$/;
const ANDROID_TAG = /^android-test-b[0-9]+-a[0-9]+$/;

function latestAndroidApkRelease(releases) {
  if (!Array.isArray(releases)) throw new Error("GitHub releases API returned invalid JSON");
  return releases
    .filter(r => !r.draft && r.published_at && ANDROID_TAG.test(r.tag_name || "") &&
      Array.isArray(r.assets) && r.assets.some(a => /\.apk$/i.test(a.name || "")))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0] || null;
}

function getReleaseCommit(release) {
  const note = typeof release.body === "string"
    ? release.body.match(/Android test APK built from verified main commit ([0-9a-f]{40})\./)
    : null;
  const noteSha = note?.[1] || null;
  const targetSha = SHA.test(release.target_commitish || "") ? release.target_commitish : null;
  if (noteSha && targetSha && noteSha !== targetSha) {
    throw new Error("Published release metadata disagrees with its target commit; refusing to guess");
  }
  const sha = noteSha || targetSha;
  if (!sha) {
    throw new Error("Latest Android APK release has no verifiable 40-character commit SHA. Use a manual workflow_dispatch build to establish a new baseline.");
  }
  return sha;
}

function git(args, cwd) {
  return cp.execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function decideAndroidBuild({ eventName, targetSha, releases = [], cwd = process.cwd(), execGit = git }) {
  if (!SHA.test(targetSha || "")) throw new Error("Invalid TARGET_SHA");
  if (eventName === "workflow_dispatch") {
    return { needed: true, reason: "Manual build requested for verified main" };
  }

  const release = latestAndroidApkRelease(releases);
  if (!release) return { needed: true, reason: "No published Android APK baseline found" };

  const baseSha = getReleaseCommit(release);
  if (baseSha === targetSha) {
    return { needed: false, reason: "Current main commit is already published", baseSha };
  }

  try {
    execGit(["merge-base", "--is-ancestor", baseSha, targetSha], cwd);
  } catch {
    throw new Error("Last published APK commit is not an ancestor of main. Refusing an unsafe comparison; check the release history or trigger a manual build.");
  }

  const changed = execGit(["diff", "--name-only", baseSha, targetSha, "--",
    "mobile/", ".github/workflows/android-test-apk.yml"], cwd).trim();

  return {
    needed: changed.length > 0,
    reason: changed ? "Android files changed since the last published APK" : "No Android changes since the last published APK",
    baseSha,
    changedFiles: changed ? changed.split("\n") : [],
  };
}

function main() {
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  const targetSha = process.env.TARGET_SHA;
  const repository = process.env.GITHUB_REPOSITORY;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) throw new Error("GITHUB_OUTPUT is required");
  if (!repository || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
    throw new Error("Invalid GITHUB_REPOSITORY");
  }

  let releases = [];
  if (eventName !== "workflow_dispatch") {
    const raw = cp.execFileSync("gh", ["api", "repos/" + repository + "/releases?per_page=100"],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    releases = JSON.parse(raw);
  }

  const decision = decideAndroidBuild({ eventName, targetSha, releases });
  fs.appendFileSync(outputFile, "needed=" + decision.needed + "\n");
  console.log(decision.reason + (decision.baseSha ? " (last APK: " + decision.baseSha + ")" : ""));
  if (decision.changedFiles) console.log("Android changes: " + decision.changedFiles.join(", "));
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error("::error::" + error.message);
    process.exitCode = 1;
  }
}

module.exports = { latestAndroidApkRelease, getReleaseCommit, decideAndroidBuild };
