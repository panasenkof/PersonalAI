import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { DirectAgentSettingsScreen } from "../screens/DirectAgentSettingsScreen";
import { loadDirectConnections, newDirectConnection, saveDirectConnections } from "../direct-agent/settings";
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: mockBack }),
  useRoute: () => ({ params: mockParams.current }),
  useFocusEffect: (cb: () => void | (() => void)) => require("react").useEffect(cb, [cb]),
  usePreventRemove: () => {},
}));
jest.mock("../profile/ProfileContext", () => ({ useProfile: () => "guest" }));
jest.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 64 }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) }));
jest.mock("../direct-agent/settings", () => ({ ...jest.requireActual("../direct-agent/settings"), loadDirectConnections: jest.fn(), saveDirectConnections: jest.fn() }));
const mockBack = jest.fn();
const mockParams: { current: { presetId?: string } | undefined } = { current: undefined };
beforeEach(() => {
  jest.clearAllMocks();
  mockParams.current = undefined;
  (loadDirectConnections as jest.Mock).mockResolvedValue({ activeId: "one", connections: [
    { ...newDirectConnection("openai", "one"), name: "OpenAI", apiKey: "key-a" },
    { ...newDirectConnection("anthropic", "two"), name: "Anthropic", baseUrl: "https://my.example/v1", apiKey: "key-b", model: "my-claude" },
  ] });
  (saveDirectConnections as jest.Mock).mockResolvedValue(undefined);
});
test("edits survive switching profiles; save selects the current profile and leaves the settings screen", async () => {
  const v = render(<DirectAgentSettingsScreen />);
  await waitFor(() => v.getByLabelText("Адрес API LLM"));
  fireEvent.changeText(v.getByLabelText("Название модели"), "gpt-4.1");
  fireEvent.press(v.getByLabelText("Подключение Anthropic"));
  expect(v.getByLabelText("Адрес API LLM").props.value).toBe("https://my.example/v1");
  expect(v.getByLabelText("API-ключ LLM").props.value).toBe("key-b");
  fireEvent.press(v.getByLabelText("Подключение OpenAI"));
  expect(v.getByLabelText("Название модели").props.value).toBe("gpt-4.1");
  fireEvent.press(v.getByText("Сохранить настройки"));
  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  expect(saveDirectConnections).toHaveBeenCalledWith("guest", expect.objectContaining({ activeId: "one", connections: expect.arrayContaining([
    expect.objectContaining({ id: "one", model: "gpt-4.1", apiKey: "key-a" }), expect.objectContaining({ id: "two", apiKey: "key-b" }),
  ]) }));
});
test("editing an endpoint clears only that connection's key, and a failed save keeps the editor open", async () => {
  const v = render(<DirectAgentSettingsScreen />); await waitFor(() => v.getByLabelText("Адрес API LLM"));
  fireEvent.changeText(v.getByLabelText("Адрес API LLM"), "https://new.example/v1");
  expect(v.getByLabelText("API-ключ LLM").props.value).toBe("");
  fireEvent.press(v.getByLabelText("Подключение Anthropic"));
  expect(v.getByLabelText("API-ключ LLM").props.value).toBe("key-b");
  (saveDirectConnections as jest.Mock).mockRejectedValueOnce(new Error("Не удалось сохранить"));
  fireEvent.press(v.getByText("Сохранить настройки"));
  await waitFor(() => v.getByText("Не удалось сохранить")); expect(mockBack).not.toHaveBeenCalled();
});
test("a ready-made provider can be added and its connection checked before saving", async () => {
  const fetchMock = jest.spyOn(globalThis, "fetch" as any).mockResolvedValue({ ok: true, status: 200,
    json: async () => ({ choices: [{ message: { role: "assistant", content: "Готово" } }] }) } as any);
  const v = render(<DirectAgentSettingsScreen />); await waitFor(() => v.getByLabelText("Адрес API LLM"));
  fireEvent.press(v.getByLabelText("Добавить подключение"));
  expect(v.getByLabelText("Адрес API LLM").props.value).toBe("");
  fireEvent.press(v.getByLabelText("Шаблон DeepSeek"));
  expect(v.getByLabelText("Адрес API LLM").props.value).toBe("https://api.deepseek.com");
  expect(v.getByLabelText("Название подключения").props.value).toBe("DeepSeek");
  expect(v.getByText(/platform.deepseek.com/)).toBeTruthy();
  fireEvent.changeText(v.getByLabelText("API-ключ LLM"), "ds-key");
  fireEvent.press(v.getByLabelText("Проверить связь"));
  await waitFor(() => v.getByText(/Связь есть/));
  expect(fetchMock.mock.calls[0][0]).toBe("https://api.deepseek.com/chat/completions");
  fetchMock.mockRestore();
});
test("first-run setup opens straight on the chosen provider", async () => {
  mockParams.current = { presetId: "openrouter" };
  const v = render(<DirectAgentSettingsScreen />); await waitFor(() => v.getByLabelText("Адрес API LLM"));
  expect(v.getByLabelText("Адрес API LLM").props.value).toBe("https://openrouter.ai/api/v1");
  expect(v.getByLabelText("API-ключ LLM").props.value).toBe("");
  expect(v.getByLabelText("Подключение OpenRouter")).toBeTruthy();
});
test("each search service keeps its own key when switching", async () => {
  const v = render(<DirectAgentSettingsScreen />); await waitFor(() => v.getByLabelText("Адрес API LLM"));
  // The search group is folded; its summary says whether search is on.
  expect(v.queryByLabelText("Разрешить веб-поиск")).toBeNull();
  fireEvent.press(v.getByLabelText("Развернуть: Интернет-поиск"));
  fireEvent(v.getByLabelText("Разрешить веб-поиск"), "valueChange", true);
  fireEvent.press(v.getByLabelText("Поиск Tavily"));
  fireEvent.changeText(v.getByLabelText("Ключ Tavily"), "tvly-1");
  fireEvent.press(v.getByLabelText("Поиск Яндекс"));
  expect(v.getByLabelText("API-ключ Yandex Cloud для поиска").props.value).toBe("");
  fireEvent.changeText(v.getByLabelText("API-ключ Yandex Cloud для поиска"), "AQVN-1");
  fireEvent.changeText(v.getByLabelText("Идентификатор каталога Yandex Cloud"), "b1gfolder");
  fireEvent.press(v.getByLabelText("Поиск DeepSeek"));
  fireEvent.changeText(v.getByLabelText("Ключ DeepSeek для поиска"), "sk-ds-1");
  fireEvent.press(v.getByLabelText("Поиск Tavily"));
  expect(v.getByLabelText("Ключ Tavily").props.value).toBe("tvly-1");
  fireEvent.press(v.getByText("Сохранить настройки"));
  await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
  expect(saveDirectConnections).toHaveBeenCalledWith("guest", expect.objectContaining({ connections: expect.arrayContaining([
    expect.objectContaining({ id: "one", searchProvider: "tavily", webSearchKey: "tvly-1", searchKeys: { tavily: "tvly-1", yandex: "AQVN-1", deepseek: "sk-ds-1" }, searchFolderId: "b1gfolder" }),
  ]) }));
});
test("two API types: switching to Anthropic sets its address and asks for a new key", async () => {
  const v = render(<DirectAgentSettingsScreen />); await waitFor(() => v.getByLabelText("Адрес API LLM"));
  fireEvent.press(v.getByLabelText("Тип API Anthropic"));
  expect(v.getByLabelText("Адрес API LLM").props.value).toBe("https://api.anthropic.com/v1");
  expect(v.getByLabelText("API-ключ LLM").props.value).toBe("");
  expect(v.getByLabelText("Шаблон Anthropic (Claude)")).toBeTruthy();
  expect(v.queryByLabelText("Шаблон DeepSeek")).toBeNull();
});
