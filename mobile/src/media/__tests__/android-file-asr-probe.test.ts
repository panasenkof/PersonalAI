import { androidFileProbeEligible, PROBE_MAX_INPUT_BYTES, PROBE_MAX_SECONDS, PROBE_TIMEOUT_MS } from "../android-file-asr-probe";

test("H-ASR2 debug probe rejects unsupported platforms, unsafe URIs and oversized sources", () => {
  expect(androidFileProbeEligible("android", 32, "file:///data/user/0/cache/sample.wav", 400)).toBe(false);
  expect(androidFileProbeEligible("ios", 36, "file:///data/user/0/cache/sample.wav", 400)).toBe(false);
  expect(androidFileProbeEligible("android", 36, "https://example.com/audio.wav", 400)).toBe(false);
  expect(androidFileProbeEligible("android", 36, "content://provider/audio", 400)).toBe(false);
  expect(androidFileProbeEligible("android", 36, "file:///cache/empty.wav", 0)).toBe(false);
  expect(androidFileProbeEligible("android", 36, "file:///cache/large.wav", PROBE_MAX_INPUT_BYTES + 1)).toBe(false);
  expect(androidFileProbeEligible("android", 36, "file:///cache/sample.wav", 400)).toBe(true);
});

test("H-ASR2 experiment stays bounded; never a long-form production file-ASR option", () => {
  expect(PROBE_MAX_SECONDS).toBeLessThanOrEqual(12);
  expect(PROBE_TIMEOUT_MS).toBeLessThanOrEqual(20_000);
  expect(PROBE_MAX_INPUT_BYTES).toBeLessThanOrEqual(1024 * 1024);
});
