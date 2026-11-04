import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { AttachmentView } from "../AttachmentView";
import { attachmentPreviewKind, readableAttachmentSize } from "../attachmentPresentation";
import { attachmentsForEntity, materializeAttachment } from "../attachments";
import { localExtractionEvidence } from "../../local-memory/extractions";
import { renderPdfPage, deletePdfPagePreview } from "../pdf-page-preview";

const mockDelete = jest.fn();
let mockFocused = true;
let mockAppVisible = true;
const mockPause = jest.fn();
const mockPlay = jest.fn();
const mockAudioPlayer = {
  currentTime: 0, duration: 10,
  addListener: () => ({ remove: jest.fn() }),
  pause: mockPause, play: mockPlay,
};
jest.mock("expo-file-system", () => ({
  File: class {
    uri: string;
    constructor(uri: string) { this.uri = uri; }
    get exists() { return true; }
    delete() { mockDelete(this.uri); }
  },
}));
jest.mock("expo-video", () => ({
  useVideoPlayer: () => mockAudioPlayer,
  VideoView: () => null,
}));
jest.mock("@react-navigation/native", () => ({ useIsFocused: () => mockFocused }));
jest.mock("../../security/visibility", () => ({ useApplicationVisible: () => mockAppVisible }));
jest.mock("../../theme", () => ({
  useTheme: () => ({ bg: "#070D20", panel: "#14213D", soft: "#26395C", line: "#445574",
    text: "#F6F8FF", muted: "#ABBAD8", secondary: "#30CAED", err: "#FF9FAF" }),
}));
jest.mock("../../local-memory/errors", () => ({ memoryErrorMessage: (e: Error) => e.message }));
jest.mock("../../local-memory/extractions", () => ({ localExtractionEvidence: jest.fn() }));
jest.mock("../pdf-page-preview", () => ({ renderPdfPage: jest.fn(), deletePdfPagePreview: jest.fn(async () => {}) }));
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
  mockAudioPlayer.currentTime = 0; mockAudioPlayer.duration = 10;
  mockFocused = true; mockAppVisible = true;
  (attachmentsForEntity as jest.Mock).mockResolvedValue(items);
  (localExtractionEvidence as jest.Mock).mockResolvedValue([]);
  (renderPdfPage as jest.Mock).mockImplementation(async (_uri,page) => ({uri:"file:///cache/persai-pdf-page-previews/page-"+page+".jpg",page,pageCount:3}));
  (materializeAttachment as jest.Mock).mockImplementation(async (_profile, att) => "file:///preview/" + att.id);
});

test("labels types and sizes without accessing original bytes", () => {
  expect(attachmentPreviewKind({ name: "sound.mp3", mime: "application/octet-stream" })).toBe("audio");
  expect(attachmentPreviewKind({ name: "photo.png", mime: "image/png" })).toBe("image");
  expect(attachmentPreviewKind({ name: "video.mp4", mime: "video/mp4" })).toBe("video");
  expect(attachmentPreviewKind({ name: "file.pdf", mime: "application/pdf" })).toBe("document");
  expect(readableAttachmentSize(512)).toBe("512 Б");
  expect(readableAttachmentSize(2048)).toBe("2.0 КБ");
});

test("lists attachments encrypted and only decrypts the explicitly opened one", async () => {
  const screen = render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(() => expect(screen.getByText("Вложения · 3")).toBeTruthy());
  expect(materializeAttachment).not.toHaveBeenCalled();
  expect(screen.queryByText("document.bin")).toBeNull();
  expect(screen.getByLabelText("Показать остальные · 1")).toBeTruthy();
  fireEvent.press(screen.getByLabelText("Показать остальные · 1"));
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

test("F1: transcript stays local until the original is opened; a verified time seeks the same player", async () => {
  (localExtractionEvidence as jest.Mock).mockResolvedValueOnce([{
    producerKind: "asr", status: "partial", coverage: "unknown",
    segments: [
      { id: "first", text: "Привет", location: { kind: "time", startMs: 1250, endMs: 2450 } },
      { id: "second", text: "Это аудиозаметка", location: { kind: "time", startMs: 2450, endMs: 3900 } },
    ],
  }]);
  const ui = render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(() => expect(ui.getByText("Вложения · 3")).toBeTruthy());
  expect(localExtractionEvidence).not.toHaveBeenCalled();
  expect(materializeAttachment).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Прослушать аудио голос.mp3"));
  await waitFor(() => expect(ui.getByLabelText("Перейти к 0:01 · Привет")).toBeTruthy());
  expect(localExtractionEvidence).toHaveBeenCalledWith("guest", "note", "audio", 10);
  expect(mockPlay).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Перейти к 0:01 · Привет"));
  expect(mockAudioPlayer.currentTime).toBe(1.25);
  expect(mockPlay).toHaveBeenCalledTimes(1);
  fireEvent.press(ui.getByLabelText("Прослушать аудио голос.mp3"));
  await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("file:///preview/audio"));
  expect(mockPause).toHaveBeenCalled();
});

test("F1: unknown positions show searchable transcript as text without a fake seek", async () => {
  (localExtractionEvidence as jest.Mock).mockResolvedValueOnce([{
    producerKind: "asr", status: "partial", coverage: "unknown",
    segments: [
      { id: "unknown", text: "Запись без таймкодов", location: { kind: "unknown" } },
      { id: "invalid", text: "Некорректный таймкод", location: { kind: "time", startMs: 0, endMs: 90_000_000 } },
    ],
  }]);
  const ui = render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(() => ui.getByLabelText("Прослушать аудио голос.mp3"));
  fireEvent.press(ui.getByLabelText("Прослушать аудио голос.mp3"));
  await waitFor(() => expect(ui.getByText("Запись без таймкодов")).toBeTruthy());
  expect(ui.getByText("Некорректный таймкод")).toBeTruthy();
  expect(ui.queryByLabelText(/Перейти к/)).toBeNull();
  expect(mockPlay).not.toHaveBeenCalled();
});

test("F1: a reported time beyond actual duration never seeks or plays", async () => {
  mockAudioPlayer.duration = 2;
  (localExtractionEvidence as jest.Mock).mockResolvedValueOnce([{
    producerKind: "asr", status: "partial", coverage: "unknown",
    segments: [{ id: "future", text: "Дальше конца", location: { kind: "time", startMs: 5000, endMs: 6000 } }],
  }]);
  const ui = render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(() => ui.getByLabelText("Прослушать аудио голос.mp3"));
  fireEvent.press(ui.getByLabelText("Прослушать аудио голос.mp3"));
  await waitFor(() => ui.getByLabelText("Перейти к 0:05 · Дальше конца"));
  fireEvent.press(ui.getByLabelText("Перейти к 0:05 · Дальше конца"));
  expect(mockPlay).not.toHaveBeenCalled();
  expect(mockAudioPlayer.currentTime).toBe(0);
  expect(ui.getByText("Временная отметка выходит за пределы записи.")).toBeTruthy();
});

test("F1: a late transcript read cannot re-open a closed audio preview", async () => {
  let resolveEvidence!: (runs: any[]) => void;
  (localExtractionEvidence as jest.Mock).mockImplementationOnce(() =>
    new Promise(resolve => { resolveEvidence = resolve; }));
  const ui = render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(() => ui.getByLabelText("Прослушать аудио голос.mp3"));
  fireEvent.press(ui.getByLabelText("Прослушать аудио голос.mp3"));
  await waitFor(() => expect(localExtractionEvidence).toHaveBeenCalledWith("guest", "note", "audio", 10));
  fireEvent.press(ui.getByLabelText("Прослушать аудио голос.mp3"));
  await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("file:///preview/audio"));
  await act(async () => resolveEvidence([{
    producerKind: "asr", status: "complete", coverage: "unknown",
    segments: [{ id: "late", text: "Текст уже закрыт", location: { kind: "time", startMs: 0, endMs: 1000 } }],
  }]));
  expect(ui.queryByText("Текст уже закрыт")).toBeNull();
  expect(mockPlay).not.toHaveBeenCalled();
});

test("F1: absent ASR evidence never claims that a transcript exists", async () => {
  const ui = render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(() => ui.getByLabelText("Прослушать аудио голос.mp3"));
  fireEvent.press(ui.getByLabelText("Прослушать аудио голос.mp3"));
  await waitFor(() => expect(ui.getByText(/пока нет сохранённого транскрипта/)).toBeTruthy());
  expect(ui.queryByLabelText(/Перейти к/)).toBeNull();
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


test("step 8 D: PDF text opens only on demand and stays bound to actual page evidence", async () => {
  const pdf={id:"pdf",entity_id:"note",name:"manual.pdf",mime:"application/pdf",size:12345};
  (attachmentsForEntity as jest.Mock).mockResolvedValue([pdf]);
  (localExtractionEvidence as jest.Mock).mockResolvedValue([{
    producerKind:"pdf",segments:[
      {text:"Первая часть",location:{kind:"page",page:1}},
      {text:"Вторая часть",location:{kind:"page",page:1}},
      {text:"Последняя фраза",location:{kind:"page",page:3}},
    ],
  }]);
  const ui=render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(()=>expect(ui.getByText("manual.pdf")).toBeTruthy());
  expect(materializeAttachment).not.toHaveBeenCalled();
  expect(localExtractionEvidence).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Открыть PDF manual.pdf"));
  await waitFor(()=>expect(ui.getByText("Страница 3 · текстовый слой")).toBeTruthy());
  expect(ui.getByText("Первая частьВторая часть")).toBeTruthy();
  expect(ui.getByText("Последняя фраза")).toBeTruthy();
  expect(ui.queryByText("Страница 2 · текстовый слой")).toBeNull();
  expect(ui.getByText(/Переход из результата поиска/)).toBeTruthy();
  expect(localExtractionEvidence).toHaveBeenCalledWith("guest","note","pdf",10);
  fireEvent.press(ui.getByLabelText("Открыть PDF manual.pdf"));
  await waitFor(()=>expect(mockDelete).toHaveBeenCalledWith("file:///preview/pdf"));
});
test("step 8 D: no fabricated PDF page if no saved source evidence",async()=>{
  const pdf={id:"pdf",entity_id:"note",name:"scan.pdf",mime:"application/pdf",size:400};
  (attachmentsForEntity as jest.Mock).mockResolvedValue([pdf]);
  const ui=render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(()=>ui.getByLabelText("Открыть PDF scan.pdf"));
  fireEvent.press(ui.getByLabelText("Открыть PDF scan.pdf"));
  await waitFor(()=>expect(ui.getByText(/Постраничный текст не сохранён/)).toBeTruthy());
  expect(ui.queryByText("Страница 1 · текстовый слой")).toBeNull();
});


test("E2a original PDF pages are opened on demand, one at a time; closing deletes previews",async()=>{
  const pdf={id:"pdf",entity_id:"note",name:"scan.pdf",mime:"application/pdf",size:3000};
  (attachmentsForEntity as jest.Mock).mockResolvedValue([pdf]);
  const ui=render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(()=>ui.getByLabelText("Открыть PDF scan.pdf"));
  expect(renderPdfPage).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Открыть PDF scan.pdf"));
  await waitFor(()=>expect(ui.getByLabelText("Исходная страница PDF 1")).toBeTruthy());
  expect(ui.getByText("Страница 1 из 3")).toBeTruthy();
  expect(renderPdfPage).toHaveBeenCalledWith("file:///preview/pdf",1,expect.anything());
  fireEvent.press(ui.getByLabelText("Следующая страница PDF"));
  await waitFor(()=>expect(ui.getByLabelText("Исходная страница PDF 2")).toBeTruthy());
  await waitFor(()=>expect(deletePdfPagePreview).toHaveBeenCalledWith("file:///cache/persai-pdf-page-previews/page-1.jpg"));
  expect(ui.getByText(/Сканы видны, но текст на них пока не найден поиском/)).toBeTruthy();
  expect(ui.queryByText("Страница 2 · текстовый слой")).toBeNull();
  fireEvent.press(ui.getByLabelText("Открыть PDF scan.pdf"));
  await waitFor(()=>expect(deletePdfPagePreview).toHaveBeenCalledWith("file:///cache/persai-pdf-page-previews/page-2.jpg"));
  expect(mockDelete).toHaveBeenCalledWith("file:///preview/pdf");
});
test("E2a PDF preview is discarded when the app loses focus",async()=>{
  const pdf={id:"pdf",entity_id:"note",name:"manual.pdf",mime:"application/pdf",size:3000};
  (attachmentsForEntity as jest.Mock).mockResolvedValue([pdf]);
  const ui=render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(()=>ui.getByLabelText("Открыть PDF manual.pdf"));
  fireEvent.press(ui.getByLabelText("Открыть PDF manual.pdf"));
  await waitFor(()=>ui.getByLabelText("Исходная страница PDF 1"));
  mockFocused=false;
  ui.rerender(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(()=>expect(deletePdfPagePreview).toHaveBeenCalledWith("file:///cache/persai-pdf-page-previews/page-1.jpg"));
});

test("four+ files stay compact until requested; collapsing securely unmounts their preview", async () => {
  const many = [
    ...items,
    { id: "fourth", entity_id: "note", name: "дополнение.jpg", mime: "image/jpeg", size: 1200 },
    { id: "fifth", entity_id: "note", name: "ещё.jpg", mime: "image/jpeg", size: 1200 },
  ];
  (attachmentsForEntity as jest.Mock).mockResolvedValueOnce(many);
  const ui = render(<AttachmentView profile="guest" entityId="note" />);
  await waitFor(() => expect(ui.getByText("Вложения · 5")).toBeTruthy());
  expect(ui.getByText("снимок.jpg")).toBeTruthy();
  expect(ui.getByText("голос.mp3")).toBeTruthy();
  expect(ui.queryByText("дополнение.jpg")).toBeNull();
  expect(materializeAttachment).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Показать остальные · 3"));
  expect(ui.getByText("дополнение.jpg")).toBeTruthy();
  expect(materializeAttachment).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Открыть фото дополнение.jpg"));
  await waitFor(() => expect(ui.getByLabelText("Просмотр изображения дополнение.jpg")).toBeTruthy());
  fireEvent.press(ui.getByLabelText("Свернуть вложения"));
  await waitFor(() => expect(mockDelete).toHaveBeenCalledWith("file:///preview/fourth"));
  expect(ui.queryByText("дополнение.jpg")).toBeNull();
  expect(ui.getByText("Вложения · 5")).toBeTruthy();
  expect(ui.getByLabelText("Показать остальные · 3")).toBeTruthy();
});

test("verified original and photo search keep their exact source without disclosure", async () => {
  const proof = { ...proofOriginal };
  const ui = render(<AttachmentView profile="guest" entityId="note" verifiedOriginal={proof} />);
  await waitFor(() => expect(ui.getByText("Вложения · 1")).toBeTruthy());
  expect(ui.queryByLabelText(/Показать остальные/)).toBeNull();
  expect(ui.queryByText("снимок.jpg")).toBeNull();
  ui.rerender(<AttachmentView profile="guest" entityId="note" photoAttachmentId="photo" />);
  await waitFor(() => expect(ui.getByText("Вложения · 1")).toBeTruthy());
  expect(ui.queryByLabelText(/Показать остальные/)).toBeNull();
  expect(ui.queryByText("голос.mp3")).toBeNull();
});
