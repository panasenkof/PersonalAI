import React from "react";
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
 lastNoteOperation: async () => "", collectionNoteCounts: async () => ({ a: 1, b: 1 }),
 searchNotes: jest.fn(async (term, _limit, _offset, filter) => notes.filter(n => n.record_status === filter.status && (!filter.collectionId || n.collection_id === filter.collectionId) && n.title.includes(term))),
};
jest.mock("../local-memory/repository", () => ({ localMemoryRepository: async () => mockDb }));
jest.mock("../local-memory/sections", () => ({ ensureSections: async () => sections, orderCollections: (v: any) => v }));
jest.mock("../profile/ProfileContext", () => ({ useProfile: () => "p" }));
jest.mock("../media/vector-runner", () => ({ scheduleVectors: jest.fn() }));
jest.mock("../media/MemoryCover", () => ({ MemoryCover: () => null }));
jest.mock("../local-memory/note-actions", () => ({ mergeText: () => "" }));
jest.mock("../local-memory/errors", () => ({ memoryErrorMessage: (e: Error) => e.message }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "id" }));
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../theme", () => ({ useTheme: () => ({}) }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 24 }) }));
jest.mock("../components/BottomSheet", () => ({ BottomSheet: ({ visible, children, title, onClose }: any) => { const { Pressable, Text } = require("react-native"); return visible ? <><Pressable accessibilityLabel={"Закрыть панель " + title} onPress={onClose}><Text>Закрыть</Text></Pressable>{children}</> : null; } }));
jest.mock("@react-navigation/native", () => ({ useNavigation: () => ({ navigate: mockNavigate }), useFocusEffect: (fn: any) => require("react").useEffect(fn, [fn]) }));
beforeEach(() => jest.clearAllMocks());
test("all-records clears collection, archive and search from either entry", async () => {
 const v = render(<LocalMemoryScreen />); await waitFor(() => v.getByLabelText("Открыть заметку Первая"));
 fireEvent.press(v.getByLabelText("Раздел Заметки")); await waitFor(() => expect(v.queryByLabelText("Открыть заметку Вторая")).toBeNull());
 fireEvent.changeText(v.getByLabelText("Поиск по заметкам"), "Нет"); await waitFor(() => v.getByText("Ничего не найдено"));
 fireEvent.press(v.getByLabelText("Меню памяти")); fireEvent.press(v.getByLabelText("Открыть архив"));
 await waitFor(() => v.getByLabelText("Открыть заметку Архивная")); expect(v.getByLabelText("Поиск по заметкам").props.value).toBe("");
 fireEvent.press(v.getByLabelText("Меню памяти")); fireEvent.press(v.getByLabelText("Все коллекции")); fireEvent.press(v.getByLabelText("Раздел Все записи"));
 await waitFor(() => v.getByLabelText("Открыть заметку Вторая")); expect(v.getByLabelText("Открыть заметку Первая")).toBeTruthy(); expect(v.queryByLabelText("Открыть заметку Архивная")).toBeNull();
});
test("selection starts empty and taps select only the chosen record", async () => {
 const v = render(<LocalMemoryScreen />); await waitFor(() => v.getByLabelText("Открыть заметку Первая"));
 fireEvent.press(v.getByLabelText("Выбрать записи")); expect(v.getByText("Выбрано: 0")).toBeTruthy();
 fireEvent.press(v.getByLabelText("Выбрать заметку Первая")); expect(v.getByLabelText("Выбрать заметку Первая").props.accessibilityState.selected).toBe(true);
 expect(v.getByLabelText("Выбрать заметку Вторая").props.accessibilityState.selected).toBe(false); expect(mockNavigate).not.toHaveBeenCalled();
 fireEvent.press(v.getByLabelText("Снять выбор записей")); fireEvent.press(v.getByLabelText("Открыть заметку Вторая")); expect(mockNavigate).toHaveBeenCalledWith("MemoryNote", { entityId: "two" });
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
 expect(v.getByText("Открыть запись")).toBeTruthy();
 expect(v.queryByText("Объединить записи")).toBeNull();
 expect(v.getByText("В корзину")).toBeTruthy();
 fireEvent.press(v.getByLabelText("Закрыть панель Действия с записью"));
 fireEvent.press(v.getByLabelText("Выбрать заметку Вторая"));
 fireEvent.press(v.getByLabelText("Действия с выбранными записями"));
 expect(v.queryByText("Открыть запись")).toBeNull();
 expect(v.getByText("Объединить записи")).toBeTruthy();
 fireEvent.press(v.getByText("Перенести"));
 expect(v.queryByText("Объединить записи")).toBeNull();
 expect(v.getByText("Первая, Вторая")).toBeTruthy();
});
