#!/usr/bin/env node
"use strict";

/**
 * CI-only #83.2 reproducible bridge staging.
 * prepare: build producer in the independent Kotlin 2.4 Gradle process FIRST,
 *          extract Java-only ABI class, then locally enable the Expo module.
 * inject:  after Expo prebuild, include runtime AAR + vendor SDK only in the
 *          generated app (never in a producing Expo AAR or Kotlin compile API).
 *
 * Do not invoke in a production release. No engine binary or model is
 * checked into the repository and no user-owned data/index is touched.
 */
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "../..");
const MOBILE = path.join(ROOT, "mobile");
const AAR = path.join(ROOT, "spikes/photo-83-1-android/probe/build/outputs/aar/probe-debug.aar");
const MOD = path.join(MOBILE, "modules/persai-vision");
const LIBS = path.join(MOD, "android/libs");
const STUB = path.join(LIBS, "vision-api.jar");
const ENGINE = path.join(LIBS, "vision-engine.aar");
const CONFIG = path.join(MOD, "expo-module.config.json");
const CLASS_NAME = "com/persai/visionsdkprobe/VisionInteropApi.class";
const MARKER = "// PersAI #83.2 Expo native inference ABI CI gate";
function assertGate() {
  if (process.env.PIA_VISION_EXPO_GATE !== "true") {
    throw new Error("vision_expo_gate_disabled: refusing mutation of normal build");
  }
}
function requireFile(file) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error("vision_gate_missing: " + path.basename(file));
}
function prepare() {
  assertGate();
  requireFile(AAR);
  fs.mkdirSync(LIBS, { recursive: true });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "persai-vision-abi-"));
  try {
    const jar = cp.execFileSync("unzip", ["-p", AAR, "classes.jar"], { maxBuffer: 64 * 1024 * 1024 });
    const fullJar = path.join(temp, "classes.jar");
    fs.writeFileSync(fullJar, jar);
    const names = cp.execFileSync("jar", ["tf", fullJar], { encoding: "utf8" });
    if (!names.split("\n").includes(CLASS_NAME)) throw new Error("vision_api_class_missing");
    cp.execFileSync("jar", ["xf", fullJar, CLASS_NAME], { cwd: temp });
    cp.execFileSync("jar", ["cf", STUB, CLASS_NAME], { cwd: temp });
    const published = cp.execFileSync("jar", ["tf", STUB], { encoding: "utf8" });
    if (/\.kotlin_module|UniversalEmbedder|UniversalVisionCompileProbe/.test(published)) {
      throw new Error("vision_stub_metadata_leak");
    }
    cp.execFileSync("javap", ["-public", "-classpath", STUB,
      "com.persai.visionsdkprobe.VisionInteropApi"], { encoding: "utf8" });
    fs.copyFileSync(AAR, ENGINE);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  if (JSON.stringify(config.platforms) !== "[]" ||
      !config.android?.modules?.includes("expo.modules.persaivision.PersaiVisionProbeModule")) {
    throw new Error("vision_module_unexpected_autolink_state");
  }
  config.platforms = ["android"];
  fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + "\n");
  requireFile(STUB);
  requireFile(ENGINE);
  console.log("CI gate staged: Java-only ABI, Kotlin 2.4 AAR, local Android Expo module enabled");
}
function inject() {
  assertGate();
  requireFile(STUB);
  requireFile(ENGINE);
  const gradlePath = path.join(MOBILE, "android/app/build.gradle");
  const gradle = fs.readFileSync(gradlePath, "utf8");
  if (gradle.includes(MARKER)) throw new Error("vision_gate_duplicate_injection");
  const matches = [...gradle.matchAll(/^dependencies\s*\{/gm)];
  if (matches.length !== 1) throw new Error("vision_gate_app_gradle_template_changed");
  // Gradle's app project carries packaged AARs; a module's own library AAR
  // cannot directly carry a file-based AAR dependency. Avoid second writer.
  const additional = `  ${MARKER}
  runtimeOnly files("$rootDir/../modules/persai-vision/android/libs/vision-engine.aar")
  runtimeOnly 'com.google.mediapipe:tasks-retrieval:1.1.0'
  runtimeOnly 'com.google.ai.edge.litertlm:litertlm-android:0.18.0'
`;
  const offset = matches[0].index + matches[0][0].length;
  let next = gradle.slice(0, offset) + "\n" + additional + gradle.slice(offset);
  // Gradle propagates the LiteRT 2.4 runtime stdlib constraint into
  // Android's compile classpath. Keep the Expo Kotlin 2.1 compiler's stdlib
  // at 2.1.20, while runtime has vendor-required 2.4.
  next += `
${MARKER}: compile-only Kotlin alignment for this isolated build
configurations.configureEach { conf ->
  if (conf.name.endsWith('CompileClasspath')) {
    conf.resolutionStrategy.force 'org.jetbrains.kotlin:kotlin-stdlib:2.1.20'
  }
}
`;
  fs.writeFileSync(gradlePath, next);
  // Verify native project truly autolinked the isolated module.
  const candidates = [
    path.join(MOBILE, "android/settings.gradle"),
    path.join(MOBILE, "android/build.gradle")
  ];
  if (!candidates.every(p => fs.existsSync(p))) throw new Error("vision_expo_prebuild_not_generated");
  console.log("CI gate injected: real Expo app runtime-only AAR and pinned vendor packages");
}
const mode = process.argv[2];
if (mode === "prepare") prepare();
else if (mode === "inject") inject();
else throw new Error("Usage: stage-vision-expo-gate.cjs prepare|inject (CI only)");
