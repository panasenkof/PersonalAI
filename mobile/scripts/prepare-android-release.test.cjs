#!/usr/bin/env node
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareAndroidRelease } = require("./prepare-android-release.cjs");
const buildAppConfig = require("../app.config.js");

test("release signing injection is idempotent and never copies keys into the project", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pia-gradle-"));
  try {
    const app = path.join(temp, "android", "app");
    fs.mkdirSync(app, { recursive: true });
    const buildFile = path.join(app, "build.gradle");
    fs.writeFileSync(buildFile, "android { buildTypes { release { } } }\n");
    prepareAndroidRelease(temp);
    prepareAndroidRelease(temp);
    const gradle = fs.readFileSync(buildFile, "utf8");
    assert.equal(gradle.split('apply from: "./pia-release-signing.gradle"').length - 1, 1);
    const injected = fs.readFileSync(path.join(app, "pia-release-signing.gradle"), "utf8");
    assert.match(injected, /signingConfigs\.piaRelease/);
    assert.match(injected, /PIA_ANDROID_KEYSTORE_PATH/);
    assert.doesNotMatch(injected, /storePassword\s+['"]/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("release signing refuses missing and unexpected Gradle files", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pia-gradle-"));
  try {
    assert.throws(() => prepareAndroidRelease(temp), /prebuild/);
    const app = path.join(temp, "android", "app");
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, "build.gradle"), "plugins {}");
    assert.throws(() => prepareAndroidRelease(temp), /Unexpected/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("Android test builds require HTTPS and preserve a user-selected native package", () => {
  const previous = Object.fromEntries(["PIA_ANDROID_RELEASE", "PIA_ANDROID_PACKAGE", "EXPO_PUBLIC_API_BASE",
    "PIA_ANDROID_VERSION_CODE", "PIA_ANDROID_BUILD_SHA", "EAS_BUILD_PROFILE"].map(k => [k, process.env[k]]));
  const config = { version: "0.3.0", android: {}, ios: {}, extra: {} };
  try {
    process.env.PIA_ANDROID_RELEASE = "true";
    delete process.env.EAS_BUILD_PROFILE;
    process.env.PIA_ANDROID_PACKAGE = "com.example.piaagent";
    process.env.PIA_ANDROID_VERSION_CODE = "1101";
    process.env.PIA_ANDROID_BUILD_SHA = "a".repeat(40);
    delete process.env.EXPO_PUBLIC_API_BASE;
    assert.throws(() => buildAppConfig({ config }), /HTTPS/);
    process.env.EXPO_PUBLIC_API_BASE = "https://api.example.test";
    const built = buildAppConfig({ config });
    assert.equal(built.android.package, "com.example.piaagent");
    assert.equal(built.android.versionCode, 1101);
    assert.equal(built.extra.buildSha, "a".repeat(40));
    assert.equal(built.version, "0.3.0-test.1101");
    process.env.PIA_ANDROID_VERSION_CODE = "not-a-number";
    assert.throws(() => buildAppConfig({ config }), /version code/i);
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
