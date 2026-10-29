import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { LocalMemoryScreen } from "../LocalMemoryScreen";

const fakeNote = (id: string) => ({
  id, record_version: 1, record_status: "active", sensitivity: "standard",
  collection_id: "col", kind: "document", title: "Запись " + id,
  payload: { source_url: "https://example.org/r" },
});
const notes = [fakeNote("first"), fakeNote("second")];
const group = { reason: "same_saved_url", title: "Одна сохранённая ссылка — разные записи",
  proposedAction: "archive", targets: notes.map(n => ({ id: n.id, recordVersion: 1 })) };
const impacted = notes.map(n => ({
  id: n.id, eligible: true, expectedRecordVersion: 1,
  expectedPreferenceVersion: 0, reasons: [] as string[],
}));
const preview = { action: "archive", selectedCount: 2, included: impacted,
  excludedIds: [], eligibleIds: notes.map(n => n.id), blockedIds: [],
  originalBytesAtRisk: 0, canPurgeOriginals: false };
const mockRepo = {
  searchNotes: jest.fn(async () => notes),
  collectionNoteCounts: jest.fn(async () => ({ col: 2 })),
  lastNoteOperation: jest.fn(async () => ""),
  entity: jest.fn(async (id: string) => notes.find(n => n.id === id) ?? null),
  hygiene: jest.fn(() => ({
    discoverGroups: mockDiscover,
    previewWithExclusions: mockPreview,
  })),
  changeNotes: jest.fn(async () => "notes:archive:test"),
};
const mockDiscover = jest.fn(async () => ({ groups: [group], scanned: 2, partial: true }));
const mockPreview = jest.fn(async (_targets: unknown, excluded: string[], action: string) => ({
  ...preview, action, excludedIds: excluded,
  included: impacted.filter(n => !excluded.includes(n.id)),
  eligibleIds: impacted.filter(n => !excluded.includes(n.id)).map(n => n.id),
}));
let mockSessionChange: (unlocked: boolean) => void = () => {};
let mockUnlocked = true;
jest.mock("@react-navigation/native", () => ({
  useFocusEffect: (callback: () => (() => void) | void) => require("react").useEffect(callback, [callback]),
  useNavigation: () => ({ navigate: jest.fn() }),
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) }));
jest.mock("@expo/vector-icons/Feather", () => "Feather");
jest.mock("expo-crypto", () => ({ randomUUID: () => "uuid" }));
jest.mock("../../profile/ProfileContext", () => ({ useProfile: () => "test" }));
jest.mock("../../components/BottomSheet", () => ({
  BottomSheet: ({ visible, title, children }: any) => visible ?
    require("react").createElement(require("react-native").View, {},
      require("react").createElement(require("react-native").Text, {}, title), children) : null,
}));
jest.mock("../../local-memory/repository", () => ({ localMemoryRepository: async () => mockRepo }));
jest.mock("../../local-memory/sections", () => ({
  ensureSections: async () => [{ id: "col", slug: "recipes", name: "Рецепты", sensitivity: "standard" }],
  orderCollections: (v: unknown) => v,
}));
jest.mock("../../local-memory/storage", () => ({
  localMemorySessionUnlocked: () => mockUnlocked,
  onLocalMemorySessionChange: (callback: (unlocked: boolean) => void) => {
    mockSessionChange = callback; return () => { mockSessionChange = () => {}; };
  },
}));
jest.mock("../../media/vector-runner", () => ({ scheduleVectors: jest.fn() }));
jest.mock("../../media/MemoryCover", () => ({ MemoryCover: "MemoryCover" }));
jest.mock("../../design/nebula/MemoryNoteCard", () => ({ MemoryNoteCard: () => null }));
jest.mock("../../local-memory/errors", () => ({ memoryErrorMessage: (e: Error) => e.message }));
jest.mock("../../theme", () => ({ useTheme: () => ({
  bg: "#05050b", panel: "#181823", soft: "#242435", text: "#fff",
  muted: "#aaa", accent: "#82d4ff", secondary: "#8cdbff",
  line: "#333", err: "#ff7777", userText: "#fff",
}) }));

beforeEach(() => {
  jest.clearAllMocks(); mockUnlocked = true; mockSessionChange = () => {};
  mockRepo.searchNotes.mockResolvedValue(notes);
  mockRepo.entity.mockImplementation(async (id: string) => notes.find(n => n.id === id) ?? null);
  mockDiscover.mockResolvedValue({ groups: [group], scanned: 2, partial: true });
  mockPreview.mockImplementation(async (_targets: unknown, excluded: string[], action: string) => ({
    ...preview, action, excludedIds: excluded,
    included: impacted.filter(n => !excluded.includes(n.id)),
    eligibleIds: impacted.filter(n => !excluded.includes(n.id)).map(n => n.id),
  }));
});
async function openGroups(ui: ReturnType<typeof render>) {
  await waitFor(() => expect(mockRepo.searchNotes).toHaveBeenCalled());
  fireEvent.press(ui.getByLabelText("Меню памяти"));
  fireEvent.press(ui.getByLabelText("Найти группы для проверки памяти"));
  await waitFor(() => ui.getByLabelText("Проверить группу: Одна сохранённая ссылка — разные записи, записей 2"));
}

test("CLEAN-01/02/07: read-only discovery reaches existing reviewed batch with exclusions, never auto-applies", async () => {
  const ui = render(<LocalMemoryScreen />);
  await openGroups(ui);
  expect(mockDiscover).toHaveBeenCalledWith(100);
  expect(ui.getByText(/Анализ ограничен/)).toBeTruthy();
  expect(mockRepo.changeNotes).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Проверить группу: Одна сохранённая ссылка — разные записи, записей 2"));
  await waitFor(() => ui.getByLabelText("Исключить из ревизии Запись first"));
  expect(mockPreview).toHaveBeenCalledWith(group.targets, [], "archive");
  fireEvent.press(ui.getByLabelText("Исключить из ревизии Запись first"));
  await waitFor(() => expect(mockPreview).toHaveBeenLastCalledWith(group.targets, ["first"], "archive"));
  expect(mockRepo.changeNotes).not.toHaveBeenCalled();
  await waitFor(() => ui.getByLabelText("Продолжить архивирование группы"));
  fireEvent.press(ui.getByLabelText("Продолжить архивирование группы"));
  fireEvent.press(ui.getByLabelText("Подтвердить групповое действие памяти"));
  await waitFor(() => expect(mockRepo.changeNotes).toHaveBeenCalledWith("archive",
    [{ id: "second", record_version: 1 }], undefined,
    { expectedPreferences: [{ id: "second", preferenceVersion: 0 }] }));
});
test("SEC-01/CLEAN-07: stale/hidden records cannot expose a title or open the review", async () => {
  const ui = render(<LocalMemoryScreen />);
  await openGroups(ui);
  mockPreview.mockResolvedValueOnce({
    ...preview, included: impacted.map((p, index) => index ?
      p : { ...p, eligible: false, reasons: ["private_or_unclassified"] }),
  });
  fireEvent.press(ui.getByLabelText("Проверить группу: Одна сохранённая ссылка — разные записи, записей 2"));
  await waitFor(() => ui.getByText("Группа изменилась. Повторите поиск предложений."));
  expect(mockRepo.entity).not.toHaveBeenCalled();
  expect(mockRepo.changeNotes).not.toHaveBeenCalled();
});
test("SEC-04: lock clears suggestions and prevents applying a late result", async () => {
  const ui = render(<LocalMemoryScreen />);
  await openGroups(ui);
  await act(async () => { mockUnlocked = false; mockSessionChange(false); });
  expect(ui.queryByText("Одна сохранённая ссылка — разные записи")).toBeNull();
  expect(mockRepo.changeNotes).not.toHaveBeenCalled();
});
