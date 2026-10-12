import { shouldLockLocalMemory } from "../lifecycle";

test("real backgrounding locks the encrypted database", () => {
  expect(shouldLockLocalMemory("background")).toBe(true);
});
test("biometric prompt blur/inactive must not close the database and loop authentication", () => {
  expect(shouldLockLocalMemory("inactive")).toBe(false);
  expect(shouldLockLocalMemory("active")).toBe(false);
  expect(shouldLockLocalMemory("unknown")).toBe(false);
});
