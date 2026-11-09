import React from "react";
import { BackHandler } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { LocalMemoryScreen } from "../screens/LocalMemoryScreen";
const mockNavigate = jest.fn();
const mockHygienePreference=jest.fn(async(id:string)=>({entityId:id,guard:"normal",skipUntil:null,preferenceVersion:2}));
const mockLastNoteOperation=jest.fn(async()=> "");
const mockHygieneSetPreference=jest.fn(async()=>({entityId:"one",guard:"pinned",skipUntil:null,preferenceVersion:3}));
const mockHygienePreview = jest.fn(async(targets: Array<{id:string;recordVersion:number}>,excluded:string[],action:string)=>({
 action,selectedCount:targets.length,excludedIds:targets.filter(t=>excluded.includes(t.id)).map(t=>t.id),
 included:targets.filter(t=>!excluded.includes(t.id)).map(t=>({id:t.id,eligible:true,reasons:[],expectedRecordVersion:t.recordVersion,expectedPreferenceVersion:0})),
 eligibleIds:targets.filter(t=>!excluded.includes(t.id)).map(t=>t.id),blockedIds:[],
 originalBytesAtRisk:0,canPurgeOriginals:false,
}));
const sections = [{ id: "a", name: "Заметки", slug: "notes", sensitivity: "standard" }, { id: "b", name: "Люди", slug: "people", sensitivity: "unclassified" }];
const notes = [
 { id: "one", collection_id: "a", sensitivity: "inherit", title: "Первая", payload: { body: "Содержание" }, record_status: "active", record_version: 1, updated_at: "2026-10-24", kind: "note" },
 { id: "two", collection_id: "b", title: "Вторая", payload: { body: "Содержание" }, record_status: "active", record_version: 1, updated_at: "2026-10-24", kind: "note" },
 { id: "old", collection_id: "b", title: "Архивная", payload: {}, record_status: "archived", updated_at: "2026-10-24", kind: "note" },
 { id: "deleted", collection_id: "a", title: "Удалённая", payload: {}, record_status: "trashed", record_version: 7, updated_at: "2026-10-24", kind: "note" },
];
const mockDb = {
 hygiene: () => ({ previewWithExclusions: mockHygienePreview, preference:mockHygienePreference,setPreference:mockHygieneSetPreference }),
 changeNotes: jest.fn(async () => "notes:archive:test"),
 lastNoteOperation: mockLastNoteOperation, undoNotes: jest.fn(async () => {}),
 collectionNoteCounts: async () => ({ a: 1, b: 1 }),
 trashNoteCount: jest.fn(async () => 1),
 trashPurgeSnapshot: jest.fn(async () => ({items:[{id:"deleted",record_version:7}],totalCount:1,protectedCount:0,originalCount:0,affectedRelationCount:0})),
 purgeNotes: jest.fn(async (_batch: Array<{ id: string; record_version: number }>, _options?: { protectReferences?: boolean }) => {}),
 searchNotes: jest.fn(async (term, _limit, _offset, filter) => notes.filter(n => n.record_status === filter.status && (!filter.collectionId || n.collection_id === filter.collectionId) && n.title.includes(term))),
};
jest.mock("../local-memory/repository", () => ({ localMemoryRepository: async () => mockDb }));
// Only the signed-in and unlocked screen is exercised here; batch stop on lock
// is separately verified in trash-clear runner tests.
jest.mock("../local-memory/storage", () => ({
  localMemorySessionUnlocked: () => true,
  onLocalMemorySessionChange: () => () => {},
}));
jest.mock("../local-memory/sections", () => ({ ...jest.requireActual("../local-memory/sections"), ensureSections: async () => sections, orderCollections: (v: any) => v }));
jest.mock("../profile/ProfileContext", () => ({ useProfile: () => "p" }));
jest.mock("../media/vector-runner", () => ({ scheduleVectors: jest.fn() }));
jest.mock("../media/MemoryCover", () => ({ MemoryCover: () => null, purgeLegacyCoverCache: jest.fn() }));
jest.mock("../local-memory/note-actions", () => ({ mergeText: (items: { title: string }[]) => items.map(note => note.title + "\\n" + "Т".repeat(1000)).join("\\n"), noteUndoLabel: () => "Отменить архивирование" }));
jest.mock("../local-memory/errors", () => ({ memoryErrorMessage: (e: Error) => e.message }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "id" }));
jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => undefined),
}));
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../theme", () => ({
  useTheme: () => ({}),
  useNebulaColors: () => ({
    text: "#ffffff", textOnAccent: "#ffffff", border: "#445574", accent: "#7051db",
    danger: "#ff9faf", surfaceElevated: "#1d2e51",
  }),
}));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 24 }) }));
jest.mock("../components/BottomSheet", () => ({ BottomSheet: ({ visible, children, title, onClose }: any) => { const { Pressable, Text } = require("react-native"); return visible ? <><Pressable accessibilityLabel={"Закрыть панель " + title} onPress={onClose}><Text>Закрыть</Text></Pressable>{children}</> : null; } }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: mockNavigate }), useFocusEffect: (fn: any) => require("react").useEffect(fn, [fn]) }));
beforeEach(() => { jest.clearAllMocks(); mockLastNoteOperation.mockResolvedValue(""); mockDb.changeNotes.mockResolvedValue("notes:archive:test"); mockDb.trashNoteCount.mockResolvedValue(1); mockDb.trashPurgeSnapshot.mockResolvedValue({items:[{id:"deleted",record_version:7}],totalCount:1,protectedCount:0,originalCount:0,affectedRelationCount:0}); mockDb.purgeNotes.mockResolvedValue(undefined); mockHygienePreference.mockResolvedValue({entityId:"one",guard:"normal",skipUntil:null,preferenceVersion:2}); });
test("all-records clears collection, archive and search from either entry", async () => {
 const v = render(<LocalMemoryScreen />); await waitFor(() => v.getByLabelText("Открыть заметку Первая"));
 fireEvent.press(v.getByLabelText("Раздел Заметки")); await waitFor(() => expect(v.queryByLabelText("Открыть заметку Вторая")).toBeNull());
 fireEvent.changeText(v.getByLabelText("Поиск по заметкам"), "Нет"); await waitFor(() => v.getByText("Ничего не найдено"));
  expect(v.getByText("Попробуйте другой поисковый запрос.")).toBeTruthy();
 fireEvent.press(v.getByLabelText("Ко всем записям"));
 await waitFor(() => v.getByLabelText("Открыть архив"));
 fireEvent.press(v.getByLabelText("Открыть архив"));
 await waitFor(() => v.getByLabelText("Открыть заметку Архивная")); expect(v.getByLabelText("Поиск по заметкам").props.value).toBe("");
 expect(v.queryByLabelText("Добавить в память")).toBeNull();
 expect(v.queryByLabelText("Меню памяти")).toBeNull();
 fireEvent.press(v.getByLabelText("Ко всем записям"));
 await waitFor(() => v.getByLabelText("Все разделы")); fireEvent.press(v.getByLabelText("Все разделы")); fireEvent.press(v.getByLabelText("Раздел Все записи"));
 await waitFor(() => v.getByLabelText("Открыть заметку Вторая")); expect(v.getByLabelText("Открыть заметку Первая")).toBeTruthy(); expect(v.queryByLabelText("Открыть заметку Архивная")).toBeNull();
}, 15000); // multi-navigation scenario includes several debounced asynchronous reloads
test("compact collection rows are labelled, touchable and keep the canonical destination", async () => {
 const v = render(<LocalMemoryScreen />);
 await waitFor(() => v.getByLabelText("Раздел Заметки"));
 const card = v.getByLabelText("Раздел Заметки");
 expect(card.props.style.flexDirection).toBe("row");
 expect(card.props.style.minHeight).toBeGreaterThanOrEqual(48);
 expect(v.getAllByText("Записей: 1").length).toBeGreaterThan(0);
 fireEvent.press(card);
 await waitFor(() => expect(v.getByLabelText("Ко всем записям")).toBeTruthy());
 expect(v.getByLabelText("Открыть заметку Первая")).toBeTruthy();
});
test("one-tap restore targets only the versioned trashed note and keeps the existing writer", async () => {
 const v = render(<LocalMemoryScreen />);
 await waitFor(() => v.getByLabelText("Открыть заметку Первая"));
 fireEvent.press(v.getByLabelText("Открыть корзину"));
 await waitFor(() => v.getByLabelText("Восстановить заметку Удалённая"));
 expect(v.queryByLabelText("Восстановить заметку Первая")).toBeNull();
 await act(async () => { fireEvent.press(v.getByLabelText("Восстановить заметку Удалённая")); });
 expect(mockDb.changeNotes).toHaveBeenCalledWith("restore", [expect.objectContaining({id: "deleted", record_version: 7})], undefined);
 expect(mockNavigate).not.toHaveBeenCalled();
});
test("archive and trash have direct, non-duplicated entries and Android Back returns to memory", async () => {
 const spy = jest.spyOn(BackHandler, "addEventListener");
 const v = render(<LocalMemoryScreen />); await waitFor(() => v.getByLabelText("Открыть архив"));
 fireEvent.press(v.getByLabelText("Меню памяти"));
 expect(v.getAllByLabelText("Открыть архив")).toHaveLength(1);
 expect(v.getAllByLabelText("Открыть корзину")).toHaveLength(1);
 expect(v.queryByLabelText("Резервные копии")).toBeNull();
 fireEvent.press(v.getByLabelText("Закрыть панель Инструменты памяти"));
 fireEvent.press(v.getByLabelText("Открыть архив"));
 await waitFor(() => v.getByLabelText("Открыть заметку Архивная"));
 expect(v.getByText("Записи в архиве")).toBeTruthy();
 expect(v.queryByLabelText("Показать плитками")).toBeNull();
 expect(v.queryByLabelText("Показать списком")).toBeNull();
 expect(v.queryByLabelText("Открыть корзину")).toBeNull();
 expect(v.queryByLabelText("Добавить в память")).toBeNull();
 const back = () => spy.mock.calls.filter(c => c[0] === "hardwareBackPress").at(-1)![1]({ type: "hardwareBackPress", timeStamp: 0 });
 act(() => expect(back()).toBe(true));
 await waitFor(() => v.getByLabelText("Открыть корзину"));
 fireEvent.press(v.getByLabelText("Открыть корзину"));
 await waitFor(() => v.getByLabelText("Восстановить заметку Удалённая"));
 expect(v.queryByLabelText("Добавить в память")).toBeNull();
 act(() => expect(back()).toBe(true));
 await waitFor(() => v.getByLabelText("Открыть заметку Первая"));
 v.unmount(); spy.mockRestore();
});
test("selection starts empty and taps select only the chosen record", async () => {
 const v = render(<LocalMemoryScreen />); await waitFor(() => v.getByLabelText("Открыть заметку Первая"));
 fireEvent.press(v.getByLabelText("Выбрать записи")); expect(v.getByText("Выбрано: 0")).toBeTruthy();
 fireEvent.press(v.getByLabelText("Выбрать заметку Первая")); expect(v.getByLabelText("Выбрать заметку Первая").props.accessibilityState.selected).toBe(true);
 expect(v.getByLabelText("Выбрать заметку Вторая").props.accessibilityState.selected).toBe(false); expect(mockNavigate).not.toHaveBeenCalled();
 fireEvent.press(v.getByLabelText("Отменить выбор записей")); fireEvent.press(v.getByLabelText("Открыть заметку Вторая")); expect(mockNavigate).toHaveBeenCalledWith("MemoryNote", { entityId: "two" });
});
test("add menu passes collection to the existing import screen", async () => {
 const v = render(<LocalMemoryScreen />); await waitFor(() => v.getByLabelText("Открыть заметку Первая"));
 fireEvent.press(v.getByLabelText("Раздел Заметки")); fireEvent.press(v.getByLabelText("Добавить в память"));
 await act(async () => { fireEvent.press(v.getByLabelText("Галерея")); });
 expect(mockNavigate).toHaveBeenCalledWith("MemoryImport", { source: "gallery", collectionId: "a" });
});


test("selection actions are contextual and stay in one menu", async () => {
 const v = render(<LocalMemoryScreen />); await waitFor(() => v.getByLabelText("Открыть заметку Первая"));
 fireEvent.press(v.getByLabelText("Выбрать записи"));
 expect(v.getByLabelText("Действия с выбранными записями").props.accessibilityState.disabled).toBe(true);
 fireEvent.press(v.getByLabelText("Выбрать заметку Первая"));
 expect(v.queryByText("Перенести")).toBeNull();
 fireEvent.press(v.getByLabelText("Действия с выбранными записями"));
 expect(v.getByText("Редактировать")).toBeTruthy();
 expect(v.queryByText("Объединить записи")).toBeNull();
 expect(v.getByText("В корзину")).toBeTruthy();
 fireEvent.press(v.getByLabelText("Закрыть панель Действия с записью"));
 fireEvent.press(v.getByLabelText("Выбрать заметку Вторая"));
 fireEvent.press(v.getByLabelText("Действия с выбранными записями"));
 expect(v.queryByText("Редактировать")).toBeNull();
 expect(v.getByText("Объединить записи")).toBeTruthy();
 fireEvent.press(v.getByText("Перенести"));
 expect(v.queryByText("Объединить записи")).toBeNull();
 expect(v.getByText("Первая, Вторая")).toBeTruthy();
});

test("merge preview identifies the primary record, keeps the full text optional and writes only after confirmation", async () => {
 mockDb.changeNotes.mockClear();
 const v = render(<LocalMemoryScreen />);
 await waitFor(() => v.getByLabelText("Открыть заметку Первая"));
 fireEvent.press(v.getByLabelText("Выбрать записи"));
 fireEvent.press(v.getByLabelText("Выбрать заметку Первая"));
 fireEvent.press(v.getByLabelText("Выбрать заметку Вторая"));
 fireEvent.press(v.getByLabelText("Действия с выбранными записями"));
 fireEvent.press(v.getByText("Объединить записи"));
 expect(v.getByText("Основная · Первая")).toBeTruthy();
 expect(v.getByText("Будет объединена · Вторая")).toBeTruthy();
 expect(v.getByText(/вложения остальных/)).toBeTruthy();
 expect(v.getByText(/Текст: .*\/ 60 000 символов/)).toBeTruthy();
 expect(mockDb.changeNotes).not.toHaveBeenCalled();
 fireEvent.press(v.getByText("Проверить полный текст"));
 expect(v.getByText("Свернуть предпросмотр")).toBeTruthy();
 fireEvent.press(v.getByText("Подтвердить объединение"));
 await waitFor(() => expect(mockDb.changeNotes).toHaveBeenCalledWith("merge", [notes[0], notes[1]], undefined));
});

test("card menu does not select; last deselection exits and filters stay fixed", async () => {
 const v = render(<LocalMemoryScreen />); await waitFor(() => v.getByLabelText("Действия с заметкой Первая"));
 fireEvent.press(v.getByLabelText("Действия с заметкой Первая"));
 expect(v.queryByTestId("memory-selection-toolbar")).toBeNull();
 expect(v.getByText("В архив")).toBeTruthy(); expect(mockNavigate).not.toHaveBeenCalled();
 fireEvent.press(v.getByLabelText("Закрыть панель Действия с записью"));
 fireEvent(v.getByLabelText("Открыть заметку Первая"), "longPress");
 expect(v.getByText("Выбрано: 1")).toBeTruthy();
 expect(v.getByLabelText("Поиск по заметкам").props.editable).toBe(false);
 expect(v.getByLabelText("Раздел Заметки").props.accessibilityState.disabled).toBe(true);
 fireEvent.press(v.getByLabelText("Выбрать заметку Первая"));
 expect(v.queryByTestId("memory-selection-toolbar")).toBeNull();
 expect(v.queryByText("Выбрать все")).toBeNull();
});
test("Android Back exits selection; an open modal handles Back first", async () => {
 const spy = jest.spyOn(BackHandler, "addEventListener");
 const v = render(<LocalMemoryScreen />); await waitFor(() => v.getByLabelText("Открыть заметку Первая"));
 fireEvent(v.getByLabelText("Открыть заметку Первая"), "longPress");
 const back = () => spy.mock.calls.filter(c => c[0] === "hardwareBackPress").at(-1)![1]({ type: "hardwareBackPress", timeStamp: 0 });
 fireEvent.press(v.getByLabelText("Действия с выбранными записями"));
 expect(back()).toBe(false);
 fireEvent.press(v.getByLabelText("Закрыть панель Действия с записью"));
 expect(v.getByText("Выбрано: 1")).toBeTruthy();
 act(() => { expect(back()).toBe(true); });
 expect(v.queryByTestId("memory-selection-toolbar")).toBeNull();
 v.unmount(); spy.mockRestore();
});
test("archive failure preserves selection; retry succeeds and exits", async () => {
 mockDb.changeNotes.mockRejectedValueOnce(new Error("Конфликт"));
 const v = render(<LocalMemoryScreen />); await waitFor(() => v.getByLabelText("Открыть заметку Первая"));
 fireEvent(v.getByLabelText("Открыть заметку Первая"), "longPress");
 fireEvent.press(v.getByLabelText("Выбрать заметку Вторая"));
 fireEvent.press(v.getByLabelText("Действия с выбранными записями"));
 await act(async () => { fireEvent.press(v.getByText("В архив")); });
 expect(v.getAllByText("Конфликт").length).toBeGreaterThan(0);
 expect(v.getByText("Выбрано: 2")).toBeTruthy();
 await act(async () => { fireEvent.press(v.getByText("В архив")); });
 await waitFor(() => expect(v.queryByTestId("memory-selection-toolbar")).toBeNull());
 expect(mockDb.changeNotes).toHaveBeenLastCalledWith("archive", [notes[0], notes[1]], undefined);
});

test("trash confirmation replaces actions, cancel retains selection, confirm mutates once", async () => {
 const v = render(<LocalMemoryScreen />); await waitFor(() => v.getByLabelText("Открыть заметку Первая"));
 fireEvent(v.getByLabelText("Открыть заметку Первая"), "longPress");
 fireEvent.press(v.getByLabelText("Действия с выбранными записями"));
 fireEvent.press(v.getByText("В корзину"));
 expect(v.queryByLabelText("Закрыть панель Действия с записью")).toBeNull();
 expect(v.queryByText("Перенести")).toBeNull();
 expect(v.getByLabelText("Закрыть панель В корзину?")).toBeTruthy();
 expect(mockDb.changeNotes).not.toHaveBeenCalled();
 fireEvent.press(v.getByLabelText("Закрыть панель В корзину?"));
 expect(v.getByText("Выбрано: 1")).toBeTruthy();
 expect(v.getByText("Перенести")).toBeTruthy();
 fireEvent.press(v.getByText("В корзину"));
 await act(async () => { fireEvent.press(v.getByLabelText("Подтвердить перемещение в корзину")); });
 expect(mockDb.changeNotes).toHaveBeenCalledTimes(1);
 expect(mockDb.changeNotes).toHaveBeenCalledWith("trash", [notes[0]], undefined);
 expect(v.queryByTestId("memory-selection-toolbar")).toBeNull();
});


test("review entry only appears in an explicitly selected standard collection, not hidden sections",async()=>{
  const ui=render(<LocalMemoryScreen />);
  await waitFor(()=>ui.getByLabelText("Раздел Заметки"));
  expect(ui.queryByLabelText("Открыть предложения по изменению памяти")).toBeNull();
  fireEvent.press(ui.getByLabelText("Раздел Заметки"));
  await waitFor(()=>ui.getByLabelText("Открыть предложения по изменению памяти"));
  fireEvent.press(ui.getByLabelText("Открыть предложения по изменению памяти"));
  expect(mockNavigate).toHaveBeenCalledWith("MemoryTemporalReview",{collectionId:"a"});
  fireEvent.press(ui.getByLabelText("Ко всем записям"));
  fireEvent.press(await waitFor(() => ui.getByLabelText("Раздел Люди")));
  await waitFor(()=>expect(ui.queryByLabelText("Открыть предложения по изменению памяти")).toBeNull());
});

test("CLEAN-07/CLEAN-04/SAVE-04: one existing batch menu previews and excludes without writing",async()=>{
  const v=render(<LocalMemoryScreen/>);
  await waitFor(()=>v.getByLabelText("Открыть заметку Первая"));
  fireEvent(v.getByLabelText("Открыть заметку Первая"),"longPress");
  fireEvent.press(v.getByLabelText("Выбрать заметку Вторая"));
  fireEvent.press(v.getByLabelText("Действия с выбранными записями"));
  await act(async()=>{fireEvent.press(v.getByLabelText("Проверить последствия групповой ревизии"));});
  await waitFor(()=>expect(mockHygienePreview).toHaveBeenCalledWith([
    {id:"one",recordVersion:1},{id:"two",recordVersion:1},
  ],[],"archive"));
  expect(v.getByLabelText("Закрыть панель Предпросмотр групповой ревизии")).toBeTruthy();
  expect(v.getByText("Выбрано: 2 · Исключено: 0 · Можно архивировать: 2 · Требуют проверки: 0")).toBeTruthy();
  expect(mockDb.changeNotes).not.toHaveBeenCalled();
  await act(async()=>{fireEvent.press(v.getByLabelText("Исключить из ревизии Первая"));});
  await waitFor(()=>expect(mockHygienePreview).toHaveBeenLastCalledWith([
    {id:"one",recordVersion:1},{id:"two",recordVersion:1},
  ],["one"],"archive"));
  expect(v.getByText("Выбрано: 2 · Исключено: 1 · Можно архивировать: 1 · Требуют проверки: 0")).toBeTruthy();
  expect(v.getByText("Исключено · Первая")).toBeTruthy();
  expect(mockDb.changeNotes).not.toHaveBeenCalled();
  fireEvent.press(v.getByLabelText("Закрыть предпросмотр без изменений"));
  expect(v.getByText("Выбрано: 2")).toBeTruthy();
  expect(mockDb.changeNotes).not.toHaveBeenCalled();
});

test("CLEAN-04/07: archive requires explicit second confirmation and reuses note-action CAS+undo",async()=>{
  const v=render(<LocalMemoryScreen/>);
  await waitFor(()=>v.getByLabelText("Открыть заметку Первая"));
  fireEvent(v.getByLabelText("Открыть заметку Первая"),"longPress");
  fireEvent.press(v.getByLabelText("Выбрать заметку Вторая"));
  fireEvent.press(v.getByLabelText("Действия с выбранными записями"));
  await act(async()=>fireEvent.press(v.getByLabelText("Проверить последствия групповой ревизии")));
  await waitFor(()=>v.getByLabelText("Продолжить архивирование группы"));
  expect(mockDb.changeNotes).not.toHaveBeenCalled();
  fireEvent.press(v.getByLabelText("Продолжить архивирование группы"));
  expect(mockDb.changeNotes).not.toHaveBeenCalled();
  fireEvent.press(v.getByLabelText("Отмена подтверждения группового действия"));
  expect(mockDb.changeNotes).not.toHaveBeenCalled();
  fireEvent.press(v.getByLabelText("Продолжить архивирование группы"));
  await act(async()=>fireEvent.press(v.getByLabelText("Подтвердить групповое действие памяти")));
  expect(mockDb.changeNotes).toHaveBeenCalledWith("archive",[
    {id:"one",record_version:1},{id:"two",record_version:1},
  ],undefined,{expectedPreferences:[
    {id:"one",preferenceVersion:0},{id:"two",preferenceVersion:0},
  ]});
  await waitFor(()=>expect(v.queryByTestId("memory-selection-toolbar")).toBeNull());
});

test("CLEAN-08/SEC-08: trash confirmation respects exclusion and failed CAS never loses selection",async()=>{
  mockDb.changeNotes.mockRejectedValueOnce(new Error("hygiene_review_changed_repeat_preview"));
  const v=render(<LocalMemoryScreen/>);
  await waitFor(()=>v.getByLabelText("Открыть заметку Первая"));
  fireEvent(v.getByLabelText("Открыть заметку Первая"),"longPress");
  fireEvent.press(v.getByLabelText("Выбрать заметку Вторая"));
  fireEvent.press(v.getByLabelText("Действия с выбранными записями"));
  await act(async()=>fireEvent.press(v.getByLabelText("Проверить последствия групповой ревизии")));
  await act(async()=>fireEvent.press(v.getByLabelText("Ревизия: в корзину")));
  await waitFor(()=>expect(mockHygienePreview).toHaveBeenLastCalledWith(expect.anything(),[],"trash"));
  await act(async()=>fireEvent.press(v.getByLabelText("Исключить из ревизии Первая")));
  await waitFor(()=>expect(mockHygienePreview).toHaveBeenLastCalledWith(expect.anything(),["one"],"trash"));
  fireEvent.press(v.getByLabelText("Продолжить перемещение группы в корзину"));
  await act(async()=>fireEvent.press(v.getByLabelText("Подтвердить групповое действие памяти")));
  expect(mockDb.changeNotes).toHaveBeenCalledWith("trash",[
    {id:"two",record_version:1},
  ],undefined,{expectedPreferences:[{id:"two",preferenceVersion:0}]});
  expect(v.getByText("hygiene_review_changed_repeat_preview")).toBeTruthy();
  expect(v.getByText("Выбрано: 2")).toBeTruthy();
  expect(v.queryByLabelText("Подтвердить групповое действие памяти")).toBeNull();
});

test("CLEAN-04/07: user pins a chosen source via one existing CAS policy writer and refreshes preview",async()=>{
  const v=render(<LocalMemoryScreen/>);
  await waitFor(()=>v.getByLabelText("Открыть заметку Первая"));
  fireEvent(v.getByLabelText("Открыть заметку Первая"),"longPress");
  fireEvent.press(v.getByLabelText("Выбрать заметку Вторая"));
  fireEvent.press(v.getByLabelText("Действия с выбранными записями"));
  await act(async()=>fireEvent.press(v.getByLabelText("Проверить последствия групповой ревизии")));
  await waitFor(()=>v.getByLabelText("Правила сохранения Первая"));
  expect(v.queryByLabelText("Правила сохранения Вторая")).toBeNull(); // unclassified collection
  fireEvent.press(v.getByLabelText("Правила сохранения Первая"));
  await act(async()=>fireEvent.press(v.getByLabelText("Всегда сохранять · Первая")));
  expect(mockHygienePreference).toHaveBeenCalledWith("one");
  expect(mockHygieneSetPreference).toHaveBeenCalledWith(
    {id:"one",recordVersion:1},2,"pinned",null);
  await waitFor(()=>expect(mockHygienePreview).toHaveBeenCalledTimes(2));
  expect(mockDb.changeNotes).not.toHaveBeenCalled();
});

test("CLEAN-08: policy CAS conflict never implicitly approves a group action",async()=>{
  mockHygieneSetPreference.mockRejectedValueOnce(new Error("stale_review_preference"));
  const v=render(<LocalMemoryScreen/>);
  await waitFor(()=>v.getByLabelText("Открыть заметку Первая"));
  fireEvent(v.getByLabelText("Открыть заметку Первая"),"longPress");
  fireEvent.press(v.getByLabelText("Выбрать заметку Вторая"));
  fireEvent.press(v.getByLabelText("Действия с выбранными записями"));
  await act(async()=>fireEvent.press(v.getByLabelText("Проверить последствия групповой ревизии")));
  await waitFor(()=>v.getByLabelText("Правила сохранения Первая"));
  fireEvent.press(v.getByLabelText("Правила сохранения Первая"));
  await act(async()=>fireEvent.press(v.getByLabelText("Не предлагать к очистке · Первая")));
  expect(v.getByText("stale_review_preference")).toBeTruthy();
  expect(mockDb.changeNotes).not.toHaveBeenCalled();
  expect(v.getByText("Выбрано: 2")).toBeTruthy();
});

test("C3: returning from a note card exposes the canonical archive undo", async () => {
  mockLastNoteOperation.mockResolvedValueOnce("notes:archive:card-click");
  const view = render(<LocalMemoryScreen />);
  await waitFor(() => view.getByLabelText("Отменить архивирование"));
  await act(async () => { fireEvent.press(view.getByLabelText("Отменить архивирование")); });
  expect(mockDb.undoNotes).toHaveBeenCalledWith("notes:archive:card-click");
});

test("03.4: clear-trash is contextual, previews ALL 205 rows, cancel never calls writer", async () => {
  const items = Array.from({length:205}, (_,i)=>({ id:"trash-"+i,record_version:i+1 }));
  mockDb.trashNoteCount.mockResolvedValue(205);
  mockDb.trashPurgeSnapshot.mockResolvedValue({items,totalCount:205,protectedCount:0,originalCount:14,affectedRelationCount:3});
  const ui=render(<LocalMemoryScreen />);
  await waitFor(()=>ui.getByLabelText("Открыть корзину"));
  expect(ui.queryByLabelText("Очистить всю корзину")).toBeNull();
  fireEvent.press(ui.getByLabelText("Открыть корзину"));
  await waitFor(()=>ui.getByLabelText("Очистить всю корзину"));
  expect(ui.getByTestId("trash-total-counter").props.children).toBe("205 записей");
  await act(async()=>fireEvent.press(ui.getByLabelText("Очистить всю корзину")));
  expect(mockDb.trashPurgeSnapshot).toHaveBeenCalledTimes(1);
  expect(ui.getByText(/Проверен весь список, а не только видимые 50/)).toBeTruthy();
  expect(ui.queryByLabelText("Подтвердить очистку всей корзины")).toBeNull();
  fireEvent.press(ui.getByLabelText("Проверить последствия очистки корзины"));
  expect(ui.getByLabelText("Подтвердить очистку всей корзины")).toBeTruthy();
  expect(ui.getByText(/Оригиналов в удаляемых записях: 14/)).toBeTruthy();
  fireEvent.press(ui.getByLabelText("Отменить очистку корзины"));
  expect(mockDb.purgeNotes).not.toHaveBeenCalled();
  await waitFor(()=>ui.getByLabelText("Восстановить заметку Удалённая"));
  fireEvent.changeText(ui.getByLabelText("Поиск по заметкам"),"нет");
  await waitFor(()=>expect(ui.queryByLabelText("Очистить всю корзину")).toBeNull());
});

test("03.4: confirmed 101 note snapshot calls existing purge writer only in batches 100+1", async () => {
  const items = Array.from({length:101},(_,i)=>({ id:"trash-"+i,record_version:7 }));
  mockDb.trashNoteCount.mockResolvedValueOnce(101).mockResolvedValue(0);
  mockDb.trashPurgeSnapshot.mockResolvedValue({items,totalCount:101,protectedCount:0,originalCount:0,affectedRelationCount:0});
  const ui=render(<LocalMemoryScreen />);
  await waitFor(()=>ui.getByLabelText("Открыть корзину"));
  fireEvent.press(ui.getByLabelText("Открыть корзину"));
  await waitFor(()=>ui.getByLabelText("Очистить всю корзину"));
  await act(async()=>fireEvent.press(ui.getByLabelText("Очистить всю корзину")));
  fireEvent.press(ui.getByLabelText("Проверить последствия очистки корзины"));
  await act(async()=>fireEvent.press(ui.getByLabelText("Подтвердить очистку всей корзины")));
  await waitFor(()=>expect(mockDb.purgeNotes).toHaveBeenCalledTimes(2));
  expect(mockDb.purgeNotes.mock.calls[0][0]).toEqual(items.slice(0,100));
  expect(mockDb.purgeNotes.mock.calls[1][0]).toEqual(items.slice(100));
  expect(ui.queryByLabelText("Подтвердить очистку всей корзины")).toBeNull();
});

test("03.4: linked sources are counted but never included in bulk purge confirmation", async () => {
  mockDb.trashNoteCount.mockResolvedValue(1);
  mockDb.trashPurgeSnapshot.mockResolvedValue({
    items: [], totalCount: 1, protectedCount: 1,
    originalCount: 0, affectedRelationCount: 2,
  });
  const ui=render(<LocalMemoryScreen />);
  await waitFor(()=>ui.getByLabelText("Открыть корзину"));
  fireEvent.press(ui.getByLabelText("Открыть корзину"));
  await waitFor(()=>ui.getByLabelText("Очистить всю корзину"));
  await act(async()=>fireEvent.press(ui.getByLabelText("Очистить всю корзину")));
  expect(ui.getByText(/Все записи требуют отдельной проверки/)).toBeTruthy();
  expect(ui.queryByLabelText("Подтвердить очистку всей корзины")).toBeNull();
  expect(ui.queryByLabelText("Проверить последствия очистки корзины")).toBeNull();
  expect(mockDb.purgeNotes).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Отменить очистку корзины"));
  expect(mockDb.purgeNotes).not.toHaveBeenCalled();
});


test("03.4: entering search while a batch is in flight stops every subsequent destructive batch", async () => {
  const items = Array.from({length: 101}, (_,i) => ({id:"trash-"+i,record_version:7}));
  mockDb.trashNoteCount.mockResolvedValue(101);
  mockDb.trashPurgeSnapshot.mockResolvedValue({items,totalCount:101,
    protectedCount:0,originalCount:0,affectedRelationCount:0});
  let finish: (() => void) | undefined;
  mockDb.purgeNotes.mockImplementationOnce(() => new Promise<void>(resolve => {finish=resolve;}));
  const ui=render(<LocalMemoryScreen />);
  await waitFor(()=>ui.getByLabelText("Открыть корзину"));
  fireEvent.press(ui.getByLabelText("Открыть корзину"));
  await waitFor(()=>ui.getByLabelText("Очистить всю корзину"));
  await act(async()=>fireEvent.press(ui.getByLabelText("Очистить всю корзину")));
  fireEvent.press(ui.getByLabelText("Проверить последствия очистки корзины"));
  act(()=>fireEvent.press(ui.getByLabelText("Подтвердить очистку всей корзины")));
  await waitFor(()=>expect(mockDb.purgeNotes).toHaveBeenCalledTimes(1));
  fireEvent.changeText(ui.getByLabelText("Поиск по заметкам"),"ищу другое");
  await act(async()=>{ finish?.(); });
  expect(mockDb.purgeNotes).toHaveBeenCalledTimes(1);
  expect(ui.queryByLabelText("Подтвердить очистку всей корзины")).toBeNull();
  ui.unmount();
});

test("editing an active note from its menu opens the editor in one navigation, not the viewer", async () => {
 const v = render(<LocalMemoryScreen />);
 await waitFor(() => v.getByLabelText("Действия с заметкой Первая"));
 fireEvent.press(v.getByLabelText("Действия с заметкой Первая"));
 fireEvent.press(v.getByText("Редактировать"));
 expect(mockNavigate).toHaveBeenCalledWith("MemoryNote", { entityId: "one", edit: true });
 expect(mockNavigate).toHaveBeenCalledTimes(1);
});
test("trash menu opens the read-only note and never bypasses restore", async () => {
 const v = render(<LocalMemoryScreen />);
 await waitFor(() => v.getByLabelText("Открыть корзину"));
 fireEvent.press(v.getByLabelText("Открыть корзину"));
 await waitFor(() => v.getByLabelText("Действия с заметкой Удалённая"));
 fireEvent.press(v.getByLabelText("Действия с заметкой Удалённая"));
 fireEvent.press(v.getByText("Открыть запись"));
 expect(mockNavigate).toHaveBeenCalledWith("MemoryNote", { entityId: "deleted" });
});


