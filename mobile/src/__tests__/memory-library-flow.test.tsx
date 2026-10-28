import React from "react";
import { BackHandler } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { LocalMemoryScreen } from "../screens/LocalMemoryScreen";
const mockNavigate = jest.fn();
const mockHygienePreference=jest.fn(async(id:string)=>({entityId:id,guard:"normal",skipUntil:null,preferenceVersion:2}));
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
];
const mockDb = {
 hygiene: () => ({ previewWithExclusions: mockHygienePreview, preference:mockHygienePreference,setPreference:mockHygieneSetPreference }),
 changeNotes: jest.fn(async () => "notes:archive:test"),
 lastNoteOperation: async () => "", collectionNoteCounts: async () => ({ a: 1, b: 1 }),
 searchNotes: jest.fn(async (term, _limit, _offset, filter) => notes.filter(n => n.record_status === filter.status && (!filter.collectionId || n.collection_id === filter.collectionId) && n.title.includes(term))),
};
jest.mock("../local-memory/repository", () => ({ localMemoryRepository: async () => mockDb }));
jest.mock("../local-memory/sections", () => ({ ensureSections: async () => sections, orderCollections: (v: any) => v }));
jest.mock("../profile/ProfileContext", () => ({ useProfile: () => "p" }));
jest.mock("../media/vector-runner", () => ({ scheduleVectors: jest.fn() }));
jest.mock("../media/MemoryCover", () => ({ MemoryCover: () => null }));
jest.mock("../local-memory/note-actions", () => ({ mergeText: () => "", noteUndoLabel: () => "Отменить архивирование" }));
jest.mock("../local-memory/errors", () => ({ memoryErrorMessage: (e: Error) => e.message }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "id" }));
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../theme", () => ({ useTheme: () => ({}) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 24 }) }));
jest.mock("../components/BottomSheet", () => ({ BottomSheet: ({ visible, children, title, onClose }: any) => { const { Pressable, Text } = require("react-native"); return visible ? <><Pressable accessibilityLabel={"Закрыть панель " + title} onPress={onClose}><Text>Закрыть</Text></Pressable>{children}</> : null; } }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: mockNavigate }), useFocusEffect: (fn: any) => require("react").useEffect(fn, [fn]) }));
beforeEach(() => { jest.clearAllMocks(); mockDb.changeNotes.mockResolvedValue("notes:archive:test"); mockHygienePreference.mockResolvedValue({entityId:"one",guard:"normal",skipUntil:null,preferenceVersion:2}); });
test("all-records clears collection, archive and search from either entry", async () => {
 const v = render(<LocalMemoryScreen />); await waitFor(() => v.getByLabelText("Открыть заметку Первая"));
 fireEvent.press(v.getByLabelText("Раздел Заметки")); await waitFor(() => expect(v.queryByLabelText("Открыть заметку Вторая")).toBeNull());
 fireEvent.changeText(v.getByLabelText("Поиск по заметкам"), "Нет"); await waitFor(() => v.getByText("Ничего не найдено"));
 fireEvent.press(v.getByLabelText("Меню памяти")); fireEvent.press(v.getByLabelText("Открыть архив"));
 await waitFor(() => v.getByLabelText("Открыть заметку Архивная")); expect(v.getByLabelText("Поиск по заметкам").props.value).toBe("");
 fireEvent.press(v.getByLabelText("Меню памяти")); fireEvent.press(v.getByLabelText("Открыть текущие записи")); await waitFor(() => v.getByLabelText("Все коллекции")); fireEvent.press(v.getByLabelText("Все коллекции")); fireEvent.press(v.getByLabelText("Раздел Все записи"));
 await waitFor(() => v.getByLabelText("Открыть заметку Вторая")); expect(v.getByLabelText("Открыть заметку Первая")).toBeTruthy(); expect(v.queryByLabelText("Открыть заметку Архивная")).toBeNull();
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
 await act(async () => { fireEvent.press(v.getByLabelText("Добавить фото")); });
 expect(mockNavigate).toHaveBeenCalledWith("MemoryImport", { source: "photo", collectionId: "a" });
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
  fireEvent.press(ui.getByLabelText("Раздел Люди"));
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
