import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { ChatsScreen } from "../screens/ChatsScreen";
import { api } from "../api/client";
import { useNavigation } from "@react-navigation/native";

jest.mock("@react-navigation/native", () => ({
  useNavigation: jest.fn(),
  useFocusEffect: (cb: () => void | (() => void)) => {
    require("react").useEffect(cb, [cb]);
  },
}));
jest.mock("../api/client", () => ({ api: {
  conversations: jest.fn(), facts: jest.fn(), deleteConversation: jest.fn(),
} }));
jest.mock("../components/FloatingBrand", () => ({
  FloatingBrand: () => require("react").createElement(require("react-native").View),
}));
const navigate = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  (useNavigation as jest.Mock).mockReturnValue({ navigate });
  (api.conversations as jest.Mock).mockResolvedValue([]);
  (api.facts as jest.Mock).mockResolvedValue({ facts: [] });
});

test("Aurora home offers accessible actions that draft, rather than send, a new chat message", async () => {
  const view = render(<ChatsScreen />);
  await waitFor(() => expect(view.getByText("Больше, чем ответы ✦")).toBeTruthy());
  fireEvent.press(view.getByLabelText("Помоги составить план"));
  expect(navigate).toHaveBeenCalledWith("Chat", { initialPrompt: "Помоги составить план на неделю" });
  expect(api.conversations).toHaveBeenCalledTimes(1);
  fireEvent.press(view.getByLabelText("Начать первый чат"));
  expect(navigate).toHaveBeenCalledWith("Chat", { initialPrompt: undefined });
});

test("existing chats remain accessible after the redesign", async () => {
  (api.conversations as jest.Mock).mockResolvedValue([
    { id: "chat-1", channel: "mobile", title: "Идеи", updated_at: "2026-10-10T12:00:00Z" },
  ]);
  const view = render(<ChatsScreen />);
  await waitFor(() => expect(view.getByLabelText("Открыть чат Идеи")).toBeTruthy());
  fireEvent.press(view.getByLabelText("Открыть чат Идеи"));
  expect(navigate).toHaveBeenCalledWith("Chat", { conversationId: "chat-1", title: "Идеи" });
  fireEvent.press(view.getByLabelText("Новый чат"));
  expect(navigate).toHaveBeenCalledWith("Chat", { initialPrompt: undefined });
});
