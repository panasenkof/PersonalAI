import React from "react";
import { act, render, waitFor } from "@testing-library/react-native";
import { MemoryCover, coverSlot } from "../MemoryCover";
import { attachmentsForEntity, materializeAttachment } from "../attachments";
import { manipulateAsync } from "expo-image-manipulator";
const mockDelete = jest.fn();
let mockVisible = true;
let mockLock: (value: boolean) => void;
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
jest.mock("../../security/visibility", () => ({ useApplicationVisible: () => mockVisible }));
jest.mock("../../theme", () => ({ useTheme: () => ({}) }));
jest.mock("../../local-memory/storage", () => ({ onLocalMemorySessionChange: (fn: any) => { mockLock = fn; return () => {}; } }));
jest.mock("../attachments", () => ({ attachmentsForEntity: jest.fn(), materializeAttachment: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "thumb" }));
jest.mock("expo-image-manipulator", () => ({ manipulateAsync: jest.fn(), SaveFormat: { JPEG: "jpeg" } }));
jest.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  Directory: class { uri = "file:///cache/persai-previews"; create() {} },
  File: class { uri: string; exists = true; constructor(a: any, b?: string) { this.uri = b ? a.uri + "/" + b : a; } move() {} delete() { mockDelete(this.uri); } },
}));
const items = [{ id: "a", entity_id: "n", name: "photo.jpg", mime: "image/jpeg", size: 100 }];
beforeEach(() => {
  jest.clearAllMocks(); mockVisible = true;
  (attachmentsForEntity as jest.Mock).mockResolvedValue(items);
  (materializeAttachment as jest.Mock).mockResolvedValue("file:///original");
  (manipulateAsync as jest.Mock).mockResolvedValue({ uri: "file:///resized" });
});
test("offscreen cards never decrypt; visible cards resize locally and delete original", async () => {
  const screen = render(<MemoryCover profile="p" entityId="n" active={false} />);
  expect(materializeAttachment).not.toHaveBeenCalled();
  expect(screen.getByTestId("memory-cover-n").props.style.height).toBe(132);
  screen.rerender(<MemoryCover profile="p" entityId="n" active />);
  await waitFor(() => expect(screen.getByLabelText("Обложка записи")).toBeTruthy());
  expect(manipulateAsync).toHaveBeenCalledWith("file:///original", [{ resize: { width: 480 } }], expect.anything());
  expect(mockDelete).toHaveBeenCalledWith("file:///original");
  act(() => mockLock(false));
  expect(screen.queryByLabelText("Обложка записи")).toBeNull();
  expect(mockDelete).toHaveBeenCalledWith("file:///cache/persai-previews/thumb.jpg");
  expect(screen.getByTestId("memory-cover-n").props.style.height).toBe(132);
});
test("late image decoding after leaving the app is removed without appearing", async () => {
  let finish!: (value: any) => void;
  (manipulateAsync as jest.Mock).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const screen = render(<MemoryCover profile="p" entityId="n" />);
  await waitFor(() => expect(manipulateAsync).toHaveBeenCalled());
  mockVisible = false; screen.rerender(<MemoryCover profile="p" entityId="n" />);
  await act(async () => finish({ uri: "file:///late" }));
  expect(mockDelete).toHaveBeenCalledWith("file:///late");
  expect(mockDelete).toHaveBeenCalledWith("file:///original");
  expect(screen.queryByLabelText("Обложка записи")).toBeNull();
});
test("oversized pictures do not trigger automatic decoding", async () => {
  (attachmentsForEntity as jest.Mock).mockResolvedValue([{ ...items[0], size: 13 * 1024 * 1024 }]);
  render(<MemoryCover profile="p" entityId="n" />);
  await act(async () => {});
  expect(materializeAttachment).not.toHaveBeenCalled();
});
test("cover work runs at most two jobs concurrently", async () => {
  const release: (() => void)[] = []; let active = 0, max = 0;
  const tasks = Array.from({ length: 5 }, () => coverSlot(async () => {
    max = Math.max(max, ++active);
    await new Promise<void>(resolve => release.push(resolve)); active--;
  }));
  for (let i = 0; i < 5; i++) { await Promise.resolve(); release[i](); await Promise.resolve(); await Promise.resolve(); }
  await Promise.all(tasks); expect(max).toBe(2);
});

test("missing originals and large photos have explanations", async () => {
  (attachmentsForEntity as jest.Mock).mockResolvedValue([]);
  const screen = render(<MemoryCover profile="p" entityId="missing" />);
  await waitFor(() => expect(screen.getByText("Оригинал фото не сохранён")).toBeTruthy());
  expect(screen.queryByLabelText("Загрузка обложки")).toBeNull();
  (attachmentsForEntity as jest.Mock).mockResolvedValue([{ ...items[0], size: 13 * 1024 * 1024 }]);
  screen.rerender(<MemoryCover profile="p" entityId="large" />);
  await waitFor(() => expect(screen.getByText(/Большое фото/)).toBeTruthy());
  expect(materializeAttachment).not.toHaveBeenCalled();
});
test("decode failure can be retried", async () => {
  const { fireEvent } = require("@testing-library/react-native");
  (manipulateAsync as jest.Mock).mockRejectedValueOnce(new Error("decoder"));
  const screen = render(<MemoryCover profile="p" entityId="n" />);
  await waitFor(() => screen.getByLabelText("Повторить загрузку обложки"));
  expect(mockDelete).toHaveBeenCalledWith("file:///original");
  fireEvent.press(screen.getByLabelText("Повторить загрузку обложки"));
  await waitFor(() => screen.getByLabelText("Обложка записи"));
});

test("viewport changes retain a mounted thumbnail; background disposes it", async () => {
 const v = render(<MemoryCover profile="p" entityId="n" active />);
 await waitFor(() => v.getByLabelText("Обложка записи"));
 v.rerender(<MemoryCover profile="p" entityId="n" active={false} />);
 v.rerender(<MemoryCover profile="p" entityId="n" active />);
 expect(v.getByLabelText("Обложка записи")).toBeTruthy();
 expect(manipulateAsync).toHaveBeenCalledTimes(1);
 expect(mockDelete).not.toHaveBeenCalledWith("file:///cache/persai-previews/thumb.jpg");
 mockVisible = false; v.rerender(<MemoryCover profile="p" entityId="n" active />);
 expect(v.queryByLabelText("Обложка записи")).toBeNull();
 expect(mockDelete).toHaveBeenCalledWith("file:///cache/persai-previews/thumb.jpg");
});
