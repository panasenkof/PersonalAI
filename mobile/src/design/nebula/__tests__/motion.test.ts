import { nebulaTiming, resolveNebulaScene, type NebulaEnvironment, type NebulaPhase } from "../motion";

const full: NebulaEnvironment = {
  reduceMotion: false, appActive: true, powerConstrained: false, preferredQuality: "full",
};
describe("Nebula state and motion contract", () => {
  it("never runs a star flight during an active operation", () => {
    for (const phase of ["listening", "transcribing", "thinking", "responding", "offline", "error"] as NebulaPhase[]) {
      expect(resolveNebulaScene(phase, full, true).starFlight).toBe(false);
    }
  });
  it("allows a short requested flight only while idle and foreground", () => {
    expect(resolveNebulaScene("idle", full, true).starFlight).toBe(true);
    expect(nebulaTiming.starFlightMs).toBeLessThanOrEqual(2500);
    expect(resolveNebulaScene("idle", { ...full, appActive: false }, true).starFlight).toBe(false);
  });
  it("stops infinite motion for accessibility or background states", () => {
    for (const change of [{ reduceMotion: true }, { appActive: false }, { preferredQuality: "static" as const }]) {
      const scene = resolveNebulaScene("thinking", { ...full, ...change });
      expect(scene.quality).toBe("static");
      expect(scene.animateCore).toBe(false);
      expect(scene.animateBackground).toBe(false);
      expect(scene.staticArtwork).toBe("REF-ORB-B");
      expect(scene.status).toEqual("Обрабатываю запрос");
    }
  });
  it("limits animation on constrained devices", () => {
    const scene = resolveNebulaScene("listening", { ...full, powerConstrained: true });
    expect(scene.quality).toBe("reduced");
    expect(scene.animateBackground).toBe(false);
    expect(scene.starFlight).toBe(false);
    expect(scene.status).toBe("Идёт запись");
  });
  it("never uses animation as a substitute for user-visible status", () => {
    for (const p of ["listening", "transcribing", "thinking", "responding", "offline", "error"] as NebulaPhase[]) {
      expect(resolveNebulaScene(p, full).status).toBeTruthy();
    }
  });
});
