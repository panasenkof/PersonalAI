/**
 * Compile the exact production SkSL using CanvasKit WASM shipped with Skia 2.6.2.
 * The Android APK build does not compile runtime shaders: without this guard
 * RuntimeEffect.Make may silently return null and render only the static poster.
 *
 * Run after npm ci: node scripts/check-nebula-sksl.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const file = path.resolve(__dirname, "../src/design/nebula/hybridShader.ts");
const code = fs.readFileSync(file, "utf8");
const match = code.match(/export const NEBULA_HYBRID_SKSL = `([\s\S]*?)`;/);
assert.ok(match, "SkSL template source not found in hybridShader.ts");

const initFile = require.resolve("canvaskit-wasm/bin/canvaskit.js");
const CanvasKitInit = require(initFile);
const wasmDir = path.dirname(initFile);
const errors = [];

async function verify() {
  const CanvasKit = await CanvasKitInit({ locateFile: filename => path.join(wasmDir, filename) });
  const baseline = CanvasKit.RuntimeEffect.Make(
    "half4 main(float2 xy) { return half4(0.2, 0.4, 0.7, 1.0); }",
    msg => errors.push(String(msg)),
  );
  assert.ok(baseline, "CanvasKit baseline cannot compile: " + errors.join("; "));
  const effect = CanvasKit.RuntimeEffect.Make(match[1], msg => errors.push(String(msg)));
  if (!effect) {
    console.error("Nebula hybrid shader failed SkSL compilation:\n" + errors.join("\n"));
    process.exitCode = 1;
    return;
  }
  const uniforms = Array.from({ length: effect.getUniformCount() },
    (_, index) => effect.getUniformName(index));
  console.log("PASS Nebula shader compiles in CanvasKit WASM");
  console.log("Compiled uniforms:", uniforms.join(", "));
  for (const name of ["uTime", "uSize", "uEnergy", "uOffline"]) {
    assert.ok(uniforms.includes(name), "Required animated shader uniform missing: " + name);
  }
}
verify().catch(error => { console.error(error); process.exitCode = 1; });
