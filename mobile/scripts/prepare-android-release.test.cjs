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

test("Android test builds retain com.persai.app and refuse stale package variables", () => {
  const previous = Object.fromEntries(["PIA_ANDROID_RELEASE", "PIA_ANDROID_PACKAGE",
    "PIA_ANDROID_VERSION_CODE", "PIA_ANDROID_BUILD_SHA", "EAS_BUILD_PROFILE"].map(k => [k, process.env[k]]));
  const config = { version: "0.3.0", android: {}, ios: {}, extra: {} };
  try {
    process.env.PIA_ANDROID_RELEASE = "true";
    delete process.env.EAS_BUILD_PROFILE;
    process.env.PIA_ANDROID_PACKAGE = "com.persai.app";
    process.env.PIA_ANDROID_VERSION_CODE = "1101";
    process.env.PIA_ANDROID_BUILD_SHA = "a".repeat(40);
    const built = buildAppConfig({ config });
    assert.equal(built.android.package, "com.persai.app");
    assert.equal(built.android.versionCode, 1101);
    assert.equal(built.extra.buildSha, "a".repeat(40));
    assert.equal(built.extra.apiBase, undefined);
    assert.equal(built.version, "0.3.0-test.1101");
    process.env.PIA_ANDROID_PACKAGE = "com.paigent.app";
    assert.throws(() => buildAppConfig({ config }), /PIA_ANDROID_PACKAGE must be com.persai.app/);
    process.env.PIA_ANDROID_PACKAGE = "com.persai.app";
    process.env.PIA_ANDROID_VERSION_CODE = "not-a-number";
    assert.throws(() => buildAppConfig({ config }), /version code/i);
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});


test("published Android ID is pinned across Expo, CI, Maestro and release notes", () => {
  const root = path.resolve(__dirname, "..", "..");
  const app = JSON.parse(fs.readFileSync(path.join(root, "mobile", "app.json"), "utf8"));
  assert.equal(app.expo.android.package, "com.persai.app");
  const appConfig = fs.readFileSync(path.join(root, "mobile", "app.config.js"), "utf8");
  assert.match(appConfig, /PERSAI_ANDROID_PACKAGE = 'com\.persai\.app'/);
  const native = fs.readFileSync(path.join(root, ".github", "workflows", "mobile-native-sqlcipher.yml"), "utf8");
  assert.match(native, /PIA_ANDROID_PACKAGE:\s*com\.persai\.app/);
  const release = fs.readFileSync(path.join(root, ".github", "workflows", "android-test-apk.yml"), "utf8");
  assert.match(release, /PIA_ANDROID_PACKAGE:\s*com\.persai\.app/);
  assert.doesNotMatch(release, /vars\.PIA_ANDROID_PACKAGE/);
  for (const name of ["flows/minimal.yaml", "flows/smoke.yaml", "unlock.yaml"]) {
    const flow = fs.readFileSync(path.join(root, "mobile", ".maestro", name), "utf8");
    assert.match(flow, /^appId: com\.persai\.app\s*$/m);
  }
});
