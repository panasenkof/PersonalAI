const mockRead = jest.fn();
const mockWrite = jest.fn();
jest.mock("expo-secure-store", () => ({ getItemAsync: mockRead, setItemAsync: mockWrite }));
let engine: typeof import("../voice-engine");
beforeEach(() => {
  jest.resetModules(); jest.clearAllMocks();
  mockRead.mockResolvedValue(null); mockWrite.mockResolvedValue(undefined);
  engine = require("../voice-engine");
});
test("existing users retain automatic selection until an explicit engine is saved", async () => {
  await engine.initVoiceEngine();
  expect(engine.resolveVoiceEngine(engine.getVoiceEngine().preference, true)).toBe("whisper");
  expect(engine.resolveVoiceEngine(engine.getVoiceEngine().preference, false)).toBe("system");
  await engine.setVoiceEngine("system");
  expect(engine.resolveVoiceEngine(engine.getVoiceEngine().preference, true)).toBe("system");
  expect(mockWrite).toHaveBeenCalledWith("pia.voice.engine.v1", "system");
});
test.each(["system", "whisper"] as const)("%s is restored after an app restart, independently of model availability", async value => {
  mockRead.mockResolvedValue(value);
  await engine.initVoiceEngine();
  expect(engine.resolveVoiceEngine(engine.getVoiceEngine().preference, true)).toBe(value);
  expect(engine.resolveVoiceEngine(engine.getVoiceEngine().preference, false)).toBe(value);
});
test("rapid selections are saved in order and the last choice wins", async () => {
  let complete!: () => void;
  mockWrite.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
  const first = engine.setVoiceEngine("system");
  const second = engine.setVoiceEngine("whisper");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(mockWrite).toHaveBeenCalledTimes(1);
  complete(); await Promise.all([first, second]);
  expect(mockWrite.mock.calls.map(c => c[1])).toEqual(["system", "whisper"]);
  expect(engine.getVoiceEngine()).toMatchObject({ preference: "whisper", saving: false });
});
test("a failed save preserves the previous engine and can be retried", async () => {
  mockRead.mockResolvedValue("whisper"); await engine.initVoiceEngine();
  mockWrite.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(engine.setVoiceEngine("system")).rejects.toThrow("сохранить");
  expect(engine.getVoiceEngine()).toMatchObject({ preference: "whisper", saving: false });
  expect(engine.getVoiceEngine().error).toContain("сохранить");
  await engine.setVoiceEngine("system");
  expect(engine.getVoiceEngine()).toMatchObject({ preference: "system", saving: false, error: "" });
});
test("an unreadable preference is reported and an explicit choice repairs it", async () => {
  mockRead.mockRejectedValueOnce(new Error("cannot read")); await engine.initVoiceEngine();
  expect(engine.getVoiceEngine().error).toContain("прочитать");
  await engine.setVoiceEngine("whisper");
  expect(engine.getVoiceEngine()).toMatchObject({ preference: "whisper", loaded: true, error: "" });
});

test("if the last queued selection fails, the previous successful write remains the active engine", async () => {
  mockRead.mockResolvedValue("whisper");
  mockWrite.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("failed second write"));
  const first = engine.setVoiceEngine("system");
  const second = engine.setVoiceEngine("whisper");
  await first; await expect(second).rejects.toThrow("сохранить");
  expect(engine.getVoiceEngine()).toMatchObject({ preference: "system", saving: false });
});
