import React from "react";
import { BackHandler } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { LocalMemoryScreen } from "../screens/LocalMemoryScreen";
const mockNavigate = jest.fn();
const sections = [{ id: "a", name: "Заметки", slug: "notes" }, { id: "b", name: "Люди", slug: "people" }];
const notes = [
 { id: "one", collection_id: "a", title: "Первая", payload: { body: "Содержание" }, record_status: "active", updated_at: "2026-10-24", kind: "note" },
 { id: "two", collection_id: "b", title: "Вторая", payload: { body: "Содержание" }, record_status: "active", updated_at: "2026-10-24", kind: "note" },
 { id: "old", collection_id: "b", title: "Архивная", payload: {}, record_status: "archived", updated_at: "2026-10-24", kind: "note" },
];
const mockDb = {
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
beforeEach(() => { jest.clearAllMocks(); mockDb.changeNotes.mockResolvedValue("notes:archive:test"); });
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
