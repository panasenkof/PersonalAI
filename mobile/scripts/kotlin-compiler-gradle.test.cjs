const test = require("node:test");
const assert = require("node:assert/strict");
const { KOTLIN_VERSION, pinKotlinGradlePlugin } = require("./kotlin-compiler-gradle.cjs");
const app = require("../app.json").expo;
test("Expo build-properties pins the same Kotlin version as the real compiler classpath", () => {
  const p = app.plugins.find(x => Array.isArray(x) && x[0] === "expo-build-properties");
  assert.equal(p[1].android.kotlinVersion, KOTLIN_VERSION);
  assert.equal(KOTLIN_VERSION, "2.4.21");
});
test("replace only unversioned compiler plugin and preserve native Gradle settings", () => {
  const input = "buildscript { dependencies {\n  classpath('com.android.tools.build:gradle')\n  classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')\n}}";
  const output = pinKotlinGradlePlugin(input);
  assert.match(output, /org\.jetbrains\.kotlin:kotlin-gradle-plugin:2\.4\.21/);
  assert.match(output, /classpath\('com\.android\.tools\.build:gradle'\)/);
  assert.doesNotMatch(output, /classpath\('org\.jetbrains\.kotlin:kotlin-gradle-plugin'\)/);
});
test("fail closed if upstream Expo Gradle template changes", () => {
  assert.throws(() => pinKotlinGradlePlugin("no known gradle classpath"), /template_changed/);
  assert.throws(() => pinKotlinGradlePlugin("classpath('org.jetbrains.kotlin:kotlin-gradle-plugin')\nclasspath('org.jetbrains.kotlin:kotlin-gradle-plugin')"), /template_changed/);
  assert.throws(() => pinKotlinGradlePlugin("classpath('org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.20')"), /template_changed/);
});
