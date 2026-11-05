import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { View } from "react-native";
import { MemoryCover, coverSlot } from "../MemoryCover";
import { attachmentsForEntity, materializeAttachment } from "../attachments";
const mockDelete = jest.fn();
let mockVisible = true;
let mockLock: (value: boolean) => void;
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../../design/nebula/MemoryTypeIcon", () => ({ MemoryTypeIcon: () => null }));
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
});
test.each([
  ["two-column tile", 160, 108, false],
  ["compact list row", 56, 56, true],
] as const)("photo cover fills its %s even when parent centers children", async (_mode, width, height, compact) => {
  const screen = render(<View style={{ width, alignItems: "center" }}>
    <MemoryCover profile="p" entityId="n" active height={height} compact={compact} />
  </View>);
  const container = screen.getByTestId("memory-cover-n");
  // Parent alignItems:center prevents implicit stretch. Without an explicit
  // width the Image's 100% width is relative to a zero-width cover.
  expect(container.props.style.width).toBe("100%");
  expect(container.props.style.height).toBe(height);
  const photo = await waitFor(() => screen.getByLabelText("Обложка записи"));
  expect(photo.props.source).toEqual({ uri: "file:///original" });
  expect(photo.props.style).toEqual({ width: "100%", height: "100%" });
});

test("offscreen cards never decrypt; visible cards show the decrypted original", async () => {
  const screen = render(<MemoryCover profile="p" entityId="n" active={false} />);
  expect(materializeAttachment).not.toHaveBeenCalled();
  expect(screen.getByTestId("memory-cover-n").props.style.height).toBe(132);
  screen.rerender(<MemoryCover profile="p" entityId="n" active />);
  await waitFor(() => expect(screen.getByLabelText("Обложка записи")).toBeTruthy());
  expect(materializeAttachment).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Обложка записи").props.source).toEqual({ uri: "file:///original" });
  act(() => mockLock(false));
  expect(screen.queryByLabelText("Обложка записи")).toBeNull();
  expect(mockDelete).toHaveBeenCalledWith("file:///original");
  expect(screen.getByTestId("memory-cover-n").props.style.height).toBe(132);
});
test("late decryption after leaving the app removes the file and shows nothing", async () => {
  let finish!: (value: string) => void;
  (materializeAttachment as jest.Mock).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const screen = render(<MemoryCover profile="p" entityId="n" />);
  await waitFor(() => expect(materializeAttachment).toHaveBeenCalled());
  mockVisible = false; screen.rerender(<MemoryCover profile="p" entityId="n" />);
  await act(async () => finish("file:///late"));
  expect(mockDelete).toHaveBeenCalledWith("file:///late");
  expect(screen.queryByLabelText("Обложка записи")).toBeNull();
});
test("oversized pictures do not trigger automatic decoding", async () => {
  (attachmentsForEntity as jest.Mock).mockResolvedValue([{ ...items[0], size: 13 * 1024 * 1024 }]);
  render(<MemoryCover profile="p" entityId="n" />);
  await act(async () => {});
  expect(materializeAttachment).not.toHaveBeenCalled();
});
test("compact thumbnail keeps 56dp in loading, missing-file and retry states", async () => {
  (attachmentsForEntity as jest.Mock).mockResolvedValueOnce([]);
  const screen = render(<MemoryCover profile="p" entityId="n" active compact height={56} />);
  expect(screen.getByTestId("memory-cover-n").props.style.height).toBe(56);
  await waitFor(() => expect(attachmentsForEntity).toHaveBeenCalledTimes(1));
  expect(screen.getByTestId("memory-cover-n").props.style.height).toBe(56);
  (attachmentsForEntity as jest.Mock).mockResolvedValue(items);
  screen.rerender(<MemoryCover profile="p" entityId="other" active compact height={56} />);
  await waitFor(() => screen.getByLabelText("Обложка записи"));
  act(() => fireEvent(screen.getByLabelText("Обложка записи"), "error"));
  await waitFor(() => screen.getByLabelText("Повторить загрузку обложки"));
  expect(screen.getByTestId("memory-cover-other").props.style.height).toBe(56);
  fireEvent.press(screen.getByLabelText("Повторить загрузку обложки"));
  await waitFor(() => screen.getByLabelText("Обложка записи"));
  expect(screen.getByTestId("memory-cover-other").props.style.height).toBe(56);
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
test("a broken image file can be retried and disposes what it decrypted", async () => {
  const screen = render(<MemoryCover profile="p" entityId="n" />);
  await waitFor(() => screen.getByLabelText("Обложка записи"));
  act(() => fireEvent(screen.getByLabelText("Обложка записи"), "error"));
  await waitFor(() => screen.getByLabelText("Повторить загрузку обложки"));
  expect(mockDelete).toHaveBeenCalledWith("file:///original");
  fireEvent.press(screen.getByLabelText("Повторить загрузку обложки"));
  await waitFor(() => screen.getByLabelText("Обложка записи"));
});

test("viewport changes retain a mounted cover; background disposes it", async () => {
 const v = render(<MemoryCover profile="p" entityId="n" active />);
 await waitFor(() => v.getByLabelText("Обложка записи"));
 v.rerender(<MemoryCover profile="p" entityId="n" active={false} />);
 v.rerender(<MemoryCover profile="p" entityId="n" active />);
 expect(v.getByLabelText("Обложка записи")).toBeTruthy();
 expect(materializeAttachment).toHaveBeenCalledTimes(1);
 expect(mockDelete).not.toHaveBeenCalledWith("file:///original");
 mockVisible = false; v.rerender(<MemoryCover profile="p" entityId="n" active />);
 expect(v.queryByLabelText("Обложка записи")).toBeNull();
 expect(mockDelete).toHaveBeenCalledWith("file:///original");
});

