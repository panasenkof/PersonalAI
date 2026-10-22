#!/usr/bin/env node
"use strict";

// A release is privileged: verify the exact tested main commit. GitHub's
// workflow_run payload is the authoritative CI event for automatic releases;
// manual dispatch must independently look up successful main CI.
const fs = require("node:fs");
const cp = require("node:child_process");

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function isCiWorkflow(run) {
  return run?.name === "CI" &&
    (!run.path || run.path.split("@")[0] === ".github/workflows/ci.yml");
}

function isVerifiedRun(run, targetSha, repository) {
  return Boolean(isCiWorkflow(run) &&
    run.event === "push" &&
    run.head_branch === "main" &&
    run.head_sha === targetSha &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    run.head_repository?.full_name === repository);
}

function verifyAutomaticCi(event, targetSha, repository) {
  return event?.action === "completed" &&
    isVerifiedRun(event.workflow_run, targetSha, repository);
}

function verifyManualCi(response, targetSha, repository) {
  return Array.isArray(response?.workflow_runs) &&
    response.workflow_runs.some(run => isVerifiedRun(run, targetSha, repository));
}

function main() {
  const targetSha = process.env.TARGET_SHA || "";
  const repository = process.env.GITHUB_REPOSITORY || "";
  const eventName = process.env.GITHUB_EVENT_NAME || "";
  if (!SHA.test(targetSha) || !REPO.test(repository)) {
    throw new Error("Invalid TARGET_SHA or GITHUB_REPOSITORY");
  }

  let verified = false;
  if (eventName === "workflow_run") {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) throw new Error("GITHUB_EVENT_PATH is missing");
    const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
    verified = verifyAutomaticCi(event, targetSha, repository);
  } else if (eventName === "workflow_dispatch") {
    const route = `repos/${repository}/actions/runs?branch=main&head_sha=${targetSha}&per_page=100`;
    const response = JSON.parse(cp.execFileSync("gh", ["api", route], {
      encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }));
    verified = verifyManualCi(response, targetSha, repository);
  } else {
    throw new Error("Unsupported release event: " + eventName);
  }

  if (!verified) {
    throw new Error("No verified successful main push CI for " + targetSha +
      " in " + repository + ". APK will not be published.");
  }
  console.log("Verified successful main CI for " + targetSha + " via " + eventName);
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error("::error::" + error.message);
    process.exitCode = 1;
  }
}
module.exports = { isCiWorkflow, isVerifiedRun, verifyAutomaticCi, verifyManualCi };
