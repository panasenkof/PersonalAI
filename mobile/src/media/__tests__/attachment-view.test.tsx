import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { AttachmentView } from "../AttachmentView";
import { attachmentPreviewKind, readableAttachmentSize } from "../attachmentPresentation";
import { attachmentsForEntity, materializeAttachment } from "../attachments";

const mockDelete = jest.fn();
let mockFocused = true;
let mockAppVisible = true;
const mockPause = jest.fn();
const mockPlay = jest.fn();
jest.mock("expo-file-system", () => ({
  File: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get exists() { return true; }
    delete() { mockDelete(this.uri); }
  },
}));
jest.mock("expo-video", () => ({
  useVideoPlayer: () => ({
    addListener: () => ({ remove: jest.fn() }),
    pause: mockPause, play: mockPlay,
  }),
  VideoView: () => null,
}));
jest.mock("@react-navigation/native", () => ({ useIsFocused: () => mockFocused }));
jest.mock("../../security/visibility", () => ({ useApplicationVisible: () => mockAppVisible }));
jest.mock("../../theme", () => ({
  useTheme: () => ({ bg: "#070D20", panel: "#14213D", soft: "#26395C", line: "#445574",
    text: "#F6F8FF", muted: "#ABBAD8", secondary: "#30CAED", err: "#FF9FAF" }),
}));
jest.mock("../../local-memory/errors", () => ({ memoryErrorMessage: (e: Error) => e.message }));
jest.mock("../attachments", () => ({
  attachmentsForEntity: jest.fn(),
  materializeAttachment: jest.fn(),
}));
const items = [
  { id: "photo", entity_id: "note", name: "снимок.jpg", mime: "image/jpeg", size: 2048 },
  { id: "audio", entity_id: "note", name: "голос.mp3", mime: "audio/mpeg", size: 880000 },
  { id: "other", entity_id: "note", name: "document.bin", mime: "application/octet-stream", size: 100 },
];
beforeEach(() => {
  jest.clearAllMocks();
  mockFocused = true; mockAppVisible = true;
  (attachmentsForEntity as jest.Mock).mockResolvedValue(items);
  (materializeAttachment as jest.Mock).mockImplementation(async (_profile, att) => "file:///preview/" + att.id);
});

test("labels types and sizes without accessing original bytes", () => {
  expect(attachmentPreviewKind({ name: "sound.mp3", mime: "application/octet-stream" })).toBe("audio");
  expect(attachmentPreviewKind({ name: "photo.png", mime: "image/png" })).toBe("image");
  expect(attachmentPreviewKind({ name: "video.mp4", mime: "video/mp4" })).toBe("video");
  expect(attachmentPreviewKind({ name: "file.pdf", mime: "application/pdf" })).toBe("unsupported");
  expect(readableAttachmentSize(512)).toBe("512 Б");
  expect(readableAttachmentSize(2048)).toBe("2.0 КБ");
});

test("lists attachments encrypted and only decrypts the explicitly opened one", async () => {
  const screen = render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(() => expect(screen.getByText("Вложения · 3")).toBeTruthy());
  expect(materializeAttachment).not.toHaveBeenCalled();
  expect(screen.getByText("document.bin")).toBeTruthy();
  expect(screen.getByText(/Встроенный просмотр этого формата/)).toBeTruthy();
  fireEvent.press(screen.getByLabelText("Открыть фото снимок.jpg"));
  await waitFor(() => expect(screen.getByLabelText("Просмотр изображения снимок.jpg")).toBeTruthy());
  expect(materializeAttachment).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByLabelText("Прослушать аудио голос.mp3"));
  await waitFor(() => expect(screen.getByLabelText("Воспроизвести аудио")).toBeTruthy());
  expect(materializeAttachment).toHaveBeenCalledTimes(2);
  expect(screen.queryByLabelText("Просмотр изображения снимок.jpg")).toBeNull();
  expect(mockDelete).toHaveBeenCalledWith("file:///preview/photo");
  fireEvent.press(screen.getByLabelText("Воспроизвести аудио"));
  expect(mockPlay).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByLabelText("Прослушать аудио голос.mp3"));
  await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("file:///preview/audio"));
  expect(mockPause).toHaveBeenCalled();
});

test("losing focus closes and cleans the preview", async () => {
  const screen = render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(() => expect(screen.getByText("Вложения · 3")).toBeTruthy());
  fireEvent.press(screen.getByLabelText("Открыть фото снимок.jpg"));
  await waitFor(() => expect(screen.getByLabelText("Просмотр изображения снимок.jpg")).toBeTruthy());
  mockFocused = false;
  screen.rerender(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("file:///preview/photo"));
  expect(screen.queryByLabelText("Просмотр изображения снимок.jpg")).toBeNull();
});

test("failed decryption shows retry instead of losing the encrypted original", async () => {
  (materializeAttachment as jest.Mock).mockRejectedValueOnce(new Error("Оригинал повреждён"));
  const screen = render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(() => expect(screen.getByText("Вложения · 3")).toBeTruthy());
  fireEvent.press(screen.getByLabelText("Открыть фото снимок.jpg"));
  await waitFor(() => expect(screen.getByText("Оригинал повреждён")).toBeTruthy());
  fireEvent.press(screen.getByLabelText("Открыть фото снимок.jpg"));
  await waitFor(() => expect(screen.getByLabelText("Просмотр изображения снимок.jpg")).toBeTruthy());
  expect(materializeAttachment).toHaveBeenCalledTimes(2);
});


test("native media preview error hides the broken image and offers a retry", async () => {
  const screen = render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(() => expect(screen.getByText("Вложения · 3")).toBeTruthy());
  fireEvent.press(screen.getByLabelText("Открыть фото снимок.jpg"));
  await waitFor(() => expect(screen.getByLabelText("Просмотр изображения снимок.jpg")).toBeTruthy());
  fireEvent(screen.getByLabelText("Просмотр изображения снимок.jpg"), "onError");
  await waitFor(() => expect(screen.queryByLabelText("Просмотр изображения снимок.jpg")).toBeNull());
  expect(screen.getByText(/Для повторной попытки/)).toBeTruthy();
  fireEvent.press(screen.getByLabelText("Открыть фото снимок.jpg"));
  await waitFor(() => expect(screen.getByLabelText("Просмотр изображения снимок.jpg")).toBeTruthy());
  expect(materializeAttachment).toHaveBeenCalledTimes(2);
});

test("a released native player cannot throw from cleanup", async () => {
  const screen = render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(() => screen.getByLabelText("Прослушать аудио голос.mp3"));
  fireEvent.press(screen.getByLabelText("Прослушать аудио голос.mp3"));
  await waitFor(() => screen.getByLabelText("Воспроизвести аудио"));
  mockPause.mockImplementationOnce(() => { throw new Error("Shared object released"); });
  expect(() => screen.unmount()).not.toThrow();
  expect(mockDelete).toHaveBeenCalledWith("file:///preview/audio");
});

const proofOriginal = {
  attachmentId: "audio", recordId: "note", recordVersion: 1,
  name: "голос.mp3", mime: "audio/mpeg", size: 880000,
  kind: "audio" as const, metadataOnly: true as const,
  originalTime: null, originalPage: null,
};

test("R3b2a/REL-06/SEC-08: only the verified audio appears; opening uses the source-bound materializer", async () => {
  const ui = render(<AttachmentView profile="guest" entityId="note" verifiedOriginal={proofOriginal} />);
  await waitFor(() => expect(ui.getByText("Вложения · 1")).toBeTruthy());
  expect(ui.queryByText("снимок.jpg")).toBeNull();
  expect(ui.queryByText("document.bin")).toBeNull();
  expect(materializeAttachment).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Прослушать аудио голос.mp3"));
  await waitFor(() => expect(materializeAttachment).toHaveBeenCalledWith(
    "guest", items[1], expect.anything(), proofOriginal,
  ));
  await waitFor(() => expect(ui.getByLabelText("Воспроизвести аудио")).toBeTruthy());
});

test("R3b2a/SEC-08: a missing verified original must never fall back to other local originals", async () => {
  (attachmentsForEntity as jest.Mock).mockResolvedValue([items[0], items[2]]);
  const ui = render(<AttachmentView profile="guest" entityId="note" verifiedOriginal={proofOriginal} />);
  await waitFor(() => expect(ui.getByText("Источник изменён или недоступен. Повторите поиск.")).toBeTruthy());
  expect(ui.queryByLabelText("Открыть фото снимок.jpg")).toBeNull();
  expect(materializeAttachment).not.toHaveBeenCalled();
});

test("R3b2a/SEARCH-06: invalid or stale source version never exposes bytes or a different attachment", async () => {
  (materializeAttachment as jest.Mock).mockRejectedValueOnce(new Error("memory_source_not_available_or_stale"));
  const ui = render(<AttachmentView profile="guest" entityId="note" verifiedOriginal={{...proofOriginal,recordVersion:7}} />);
  await waitFor(() => ui.getByLabelText("Прослушать аудио голос.mp3"));
  fireEvent.press(ui.getByLabelText("Прослушать аудио голос.mp3"));
  await waitFor(() => expect(ui.getByText("memory_source_not_available_or_stale")).toBeTruthy());
  expect(ui.queryByLabelText("Воспроизвести аудио")).toBeNull();
  expect(materializeAttachment).toHaveBeenCalledTimes(1);
  expect((materializeAttachment as jest.Mock).mock.calls[0][3]).toMatchObject({recordVersion:7});
});

test("search photo opens the exact original immediately and never substitutes a missing id", async () => {
  const screen = render(<AttachmentView profile="guest" entityId="note" photoAttachmentId="photo" />);
  await waitFor(() => expect(materializeAttachment).toHaveBeenCalledWith("guest",items[0],expect.anything(),undefined));
  expect(screen.queryByText("голос.mp3")).toBeNull();
  screen.rerender(<AttachmentView profile="guest" entityId="note" photoAttachmentId="deleted" />);
  await waitFor(() => expect(screen.getByText("Источник изменён или недоступен. Повторите поиск.")).toBeTruthy());
  expect(materializeAttachment).toHaveBeenCalledTimes(1);
});
