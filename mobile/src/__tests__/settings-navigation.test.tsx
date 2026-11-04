import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { DeviceSettingsScreen } from "../screens/DeviceSettingsScreen";
import { SettingsDetailScreen, PhotoSearchSettingsScreen } from "../screens/SettingsDetailScreen";
import { loadDirectConnections } from "../direct-agent/settings";
import { loadModelCallLimit } from "../direct-agent/agent-preferences";
import { loadPhotoResultCount } from "../media/photo-result-preferences";

const mockNavigate = jest.fn();
let mockTopic: string = "voice";
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useRoute: () => ({ params: { topic: mockTopic } }),
  useFocusEffect: (cb: () => void | (() => void)) => require("react").useEffect(cb, [cb]),
}));
jest.mock("@react-navigation/elements", () => ({ useHeaderHeight: () => 64 }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }) }));
jest.mock("../profile/ProfileContext", () => ({ useProfile: () => "guest" }));
jest.mock("../direct-agent/settings", () => ({ loadDirectConnections: jest.fn() }));
jest.mock("../direct-agent/agent-preferences", () => ({ loadModelCallLimit: jest.fn() }));
jest.mock("../media/photo-result-preferences", () => ({ loadPhotoResultCount: jest.fn() }));
jest.mock("../media/voice-engine", () => ({
  useVoiceEngine: () => ({ loaded: true, preference: "system", saving: false, error: "" }),
  resolveVoiceEngine: () => "system",
}));
jest.mock("../components/VoiceModelCard", () => ({
  VoiceModelCard: ({ defaultOpen }: any) => require("react").createElement(require("react-native").Text, null,
    "Голос: " + (defaultOpen ? "открыт" : "закрыт")),
}));
jest.mock("../components/AgentLimitsCard", () => ({
  AgentLimitsCard: ({ defaultOpen }: any) => require("react").createElement(require("react-native").Text, null,
    "Лимит: " + (defaultOpen ? "открыт" : "закрыт")),
}));
jest.mock("../components/SmartSearchCard", () => ({
  SmartSearchCard: ({ defaultOpen }: any) => require("react").createElement(require("react-native").Text, null,
    "Умный поиск: " + (defaultOpen ? "открыт" : "закрыт")),
}));
jest.mock("../components/VisionModelCard", () => ({
  VisionModelCard: ({ defaultOpen }: any) => require("react").createElement(require("react-native").Text, null,
    "Фото: " + (defaultOpen ? "открыт" : "закрыт")),
}));
jest.mock("../components/PhotoResultsSettings", () => ({
  PhotoResultsSettings: ({ defaultOpen }: any) => require("react").createElement(require("react-native").Text, null,
    "Результаты: " + (defaultOpen ? "открыт" : "закрыт")),
}));
jest.mock("../media/MediaSettings", () => ({
  MediaSettings: ({ connections }: any) => require("react").createElement(require("react-native").Text, null,
    "Распознавание: " + connections.length + " подключения"),
}));
beforeEach(() => {
  jest.clearAllMocks();
  mockTopic = "voice";
  (loadDirectConnections as jest.Mock).mockResolvedValue({
    activeId: "one", connections: [{ id: "one", name: "OpenAI", model: "gpt-4.1" }],
  });
  (loadModelCallLimit as jest.Mock).mockResolvedValue(7);
  (loadPhotoResultCount as jest.Mock).mockResolvedValue(6);
});

test("settings overview navigates to the right owner and shows saved values without expansion", async () => {
  const ui = render(<DeviceSettingsScreen />);
  await waitFor(() => ui.getByText("OpenAI · gpt-4.1"));
  await waitFor(() => ui.getByText("До 7 обращений к LLM на сообщение"));
  await waitFor(() => ui.getByText("До 6 результатов · модели поиска"));
  fireEvent.press(ui.getByLabelText("Голосовой ввод"));
  expect(mockNavigate).toHaveBeenLastCalledWith("SettingsDetail", { topic: "voice" });
  fireEvent.press(ui.getByLabelText("Работа ИИ"));
  expect(mockNavigate).toHaveBeenLastCalledWith("SettingsDetail", { topic: "limits" });
  fireEvent.press(ui.getByLabelText("Распознавание файлов"));
  expect(mockNavigate).toHaveBeenLastCalledWith("SettingsDetail", { topic: "media" });
  fireEvent.press(ui.getByLabelText("Фото и поиск"));
  expect(mockNavigate).toHaveBeenLastCalledWith("SettingsDetail", { topic: "photos" });
  fireEvent.press(ui.getByLabelText("Модели и подключения"));
  expect(mockNavigate).toHaveBeenLastCalledWith("ModelConnections");
  expect(loadDirectConnections).toHaveBeenCalledWith("guest");
});

test("each detail opens only its canonical editor; legacy photo route shares the same owner", async () => {
  mockTopic = "limits";
  const limits = render(<SettingsDetailScreen />);
  expect(limits.getByText("Лимит: открыт")).toBeTruthy();
  expect(limits.queryByText("Голос: открыт")).toBeNull();
  limits.unmount();

  mockTopic = "media";
  const media = render(<SettingsDetailScreen />);
  await waitFor(() => media.getByText("Распознавание: 1 подключения"));
  media.unmount();

  mockTopic = "photos";
  const photos = render(<SettingsDetailScreen />);
  expect(photos.getByText("Фото: открыт")).toBeTruthy();
  expect(photos.getByText("Результаты: открыт")).toBeTruthy();
  photos.unmount();
  const legacy = render(<PhotoSearchSettingsScreen />);
  expect(legacy.getByText("Фото: открыт")).toBeTruthy();
  expect(legacy.getByText("Результаты: открыт")).toBeTruthy();
});
