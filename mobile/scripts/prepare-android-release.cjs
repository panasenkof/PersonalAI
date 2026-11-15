#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Expo prebuild generates android/; keep signing secrets and settings out of Git.
function prepareAndroidRelease(root = path.resolve(__dirname, "..")) {
  const appDir = path.join(root, "android", "app");
  const buildFile = path.join(appDir, "build.gradle");
  const signingFile = path.join(appDir, "pia-release-signing.gradle");
  const sourceFile = path.join(__dirname, "pia-release-signing.gradle");
  if (!fs.existsSync(buildFile)) {
    throw new Error("Android Gradle project missing; run npx expo prebuild --platform android first.");
  }
  const initial = fs.readFileSync(buildFile, "utf8");
  if (!/\bandroid\s*\{/.test(initial) || !/\bbuildTypes\s*\{/.test(initial)) {
    throw new Error("Unexpected Expo-generated build.gradle; refusing to inject signing.");
  }
  // Expo build-properties writes this file at prebuild. Validate, never rewrite:
  // local/EAS/native CI all have exactly one source of truth.
  const rulesFile = path.join(appDir, "proguard-rules.pro");
  if (!fs.existsSync(rulesFile) || !initial.includes("proguard-rules.pro")) {
    throw new Error("Expo-generated release ProGuard configuration missing");
  }
  const required = fs.readFileSync(path.join(__dirname, "persai-jni-keep.pro"), "utf8").trim();
  if (!fs.readFileSync(rulesFile, "utf8").includes(required)) {
    throw new Error("Expo build-properties did not install PersAI JNI keep rules");
  }
  fs.copyFileSync(sourceFile, signingFile);
  const directive = 'apply from: "./pia-release-signing.gradle"';
  if (!initial.includes(directive)) {
    fs.appendFileSync(buildFile, "\n// Private signing credentials come from the CI environment.\n" + directive + "\n");
  }
  return { buildFile, signingFile };
}

if (require.main === module) {
  try {
    prepareAndroidRelease();
    process.stdout.write("Android release signing integration prepared.\n");
  } catch (error) {
    process.stderr.write(String(error.message) + "\n");
    process.exitCode = 1;
  }
}

module.exports = { prepareAndroidRelease };
