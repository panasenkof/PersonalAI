import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Route integration guard; verifies that experimental shader is lazy-loaded
 * from diagnostics and never added as a permanent fourth bottom tab.
 * Not a substitute for manual launch on real Android hardware.
 */
describe("Nebula laboratory access", () => {
  const navigation = readFileSync(join(__dirname, "..", "navigation.tsx"), "utf8");
  const diagnostic = readFileSync(join(__dirname, "..", "screens", "DiagnosticLogsScreen.tsx"), "utf8");

  it("registers a diagnostic-only nested stack screen without eager Skia initialization", () => {
    expect(navigation).toMatch(/NebulaLab:\s*undefined/);
    expect(navigation).toContain('<Stack.Screen name="NebulaLab"');
    expect(navigation).toContain('getComponent={() => require("./design/nebula/NebulaSkiaLabScreen").NebulaSkiaLabScreen}');
    expect(navigation).not.toContain('<Tab.Screen name="NebulaLab"');
  });

  it("offers a labeled accessible action to enter the laboratory", () => {
    expect(diagnostic).toContain('accessibilityLabel="Открыть лабораторию Nebula"');
    expect(diagnostic).toContain('navigation.navigate("NebulaLab")');
    expect(diagnostic).toContain('testID="open-nebula-lab"');
  });
});
