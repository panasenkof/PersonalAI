import { APP_SESSION_TIMEOUT_MS, sessionExpired } from "../session";

test("deadline includes deep sleep and cannot be extended by a backward wall-clock correction", () => {
  const leftAt = { wall: 1000000, monotonic: 1000 };
  expect(sessionExpired(leftAt, { wall: 1000001, monotonic: 1001 })).toBe(false);
  expect(sessionExpired(leftAt, { wall: leftAt.wall + APP_SESSION_TIMEOUT_MS, monotonic: 1001 })).toBe(true);
  expect(sessionExpired(leftAt, { wall: 100, monotonic: leftAt.monotonic + APP_SESSION_TIMEOUT_MS })).toBe(true);
  expect(sessionExpired(null, { wall: 10000000, monotonic: 10000000 })).toBe(false);
});
