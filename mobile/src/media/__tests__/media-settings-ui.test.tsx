import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { MediaSettings } from "../MediaSettings";
import { loadMediaPreferences, saveMediaPreferences } from "../preferences";

jest.mock("../preferences", () => ({
  loadMediaPreferences: jest.fn(),
  saveMediaPreferences: jest.fn(),
}));
jest.mock("../../theme", () => ({
  useTheme: () => ({
    text: "#ffffff", muted: "#aaaacc", secondary: "#55ddee", accent: "#4477cc",
    panel: "#191c39", line: "#343855", soft: "#24294d", err: "#ff8899", ok: "#88eeaa",
  }),
}));

const connections: any[] = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
];
beforeEach(() => {
  jest.clearAllMocks();
  (loadMediaPreferences as jest.Mock).mockResolvedValue({ visionId: "", speechId: "" });
  (saveMediaPreferences as jest.Mock).mockResolvedValue(undefined);
});

test("media settings have one immediate Save per choice, not a second hidden save action", async () => {
  const screen = render(<MediaSettings profile="guest" connections={connections as any} />);
  const photo = screen.getByLabelText("Изображения и кадры видео: Anthropic");
  await waitFor(() => expect(photo.props.accessibilityState.disabled).toBe(false));
  expect(screen.queryByText("Сохранить выбор для медиа")).toBeNull();
  fireEvent.press(photo);
  await waitFor(() => expect(saveMediaPreferences).toHaveBeenCalledWith("guest", { visionId: "anthropic", speechId: "" }));
  await waitFor(() => expect(screen.getByLabelText("Изображения и кадры видео: Anthropic").props.accessibilityState.checked).toBe(true));
  expect(screen.getByText("Выбор для медиа сохранён.")).toBeTruthy();

  fireEvent.press(screen.getByLabelText("Речь из аудио и видео: OpenAI"));
  await waitFor(() => expect(saveMediaPreferences).toHaveBeenCalledWith("guest", { visionId: "anthropic", speechId: "openai" }));
  expect(saveMediaPreferences).toHaveBeenCalledTimes(2);
});

test("a failed write does not pretend the unsaved provider is selected", async () => {
  (saveMediaPreferences as jest.Mock).mockRejectedValueOnce(new Error("disk full"));
  const screen = render(<MediaSettings profile="guest" connections={connections as any} />);
  const photo = screen.getByLabelText("Изображения и кадры видео: Anthropic");
  await waitFor(() => expect(photo.props.accessibilityState.disabled).toBe(false));
  fireEvent.press(photo);
  await waitFor(() => screen.getByText(/Прежнее подключение остаётся действующим/));
  expect(screen.getByLabelText("Изображения и кадры видео: Anthropic").props.accessibilityState.checked).toBe(false);
  expect(screen.getByLabelText("Изображения и кадры видео: Активное подключение").props.accessibilityState.checked).toBe(true);
});

test("a removed connection is flagged and the user can repair the routing", async () => {
  (loadMediaPreferences as jest.Mock).mockResolvedValueOnce({ visionId: "removed", speechId: "" });
  const screen = render(<MediaSettings profile="guest" connections={connections as any} />);
  await waitFor(() => screen.getByText("Одно из выбранных подключений удалено. Выберите актуальное подключение."));
  fireEvent.press(screen.getByLabelText("Изображения и кадры видео: OpenAI"));
  await waitFor(() => expect(saveMediaPreferences).toHaveBeenCalledWith("guest", { visionId: "openai", speechId: "" }));
  await waitFor(() => expect(screen.queryByText("Одно из выбранных подключений удалено. Выберите актуальное подключение.")).toBeNull());
});

test("reloading a profile shows the persisted choice, not an unsaved draft", async () => {
  (loadMediaPreferences as jest.Mock).mockResolvedValueOnce({ visionId: "anthropic", speechId: "openai" });
  const screen = render(<MediaSettings profile="guest" connections={connections as any} />);
  await waitFor(() => expect(screen.getByLabelText("Речь из аудио и видео: OpenAI").props.accessibilityState.checked).toBe(true));
  expect(screen.getByLabelText("Изображения и кадры видео: Anthropic").props.accessibilityState.checked).toBe(true);
  expect(saveMediaPreferences).not.toHaveBeenCalled();
});
