import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { DirectAgentSettingsScreen } from "../screens/DirectAgentSettingsScreen";
import { loadDirectConnections, newDirectConnection, saveDirectConnections } from "../direct-agent/settings";
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: mockBack }),
  useFocusEffect: (cb: () => void | (() => void)) => require("react").useEffect(cb, [cb]),
}));
jest.mock("../auth/AuthContext", () => ({ useAuth: () => ({ offlineMode: true }) }));
jest.mock("../direct-agent/settings", () => ({ ...jest.requireActual("../direct-agent/settings"), loadDirectConnections: jest.fn(), saveDirectConnections: jest.fn() }));
const mockBack = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
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
