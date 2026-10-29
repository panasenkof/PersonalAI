import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { AgentLimitsCard } from "../components/AgentLimitsCard";
import { loadModelCallLimit, saveModelCallLimit } from "../direct-agent/agent-preferences";

jest.mock("../profile/ProfileContext", () => ({ useProfile: () => "guest" }));
jest.mock("../components/Collapsible", () => ({ Collapsible: ({ children, summary }: any) => { const { View, Text } = require("react-native"); return <View><Text>{summary}</Text>{children}</View>; } }));
jest.mock("../direct-agent/agent-preferences", () => ({ loadModelCallLimit: jest.fn(), saveModelCallLimit: jest.fn() }));
beforeEach(() => {
  jest.clearAllMocks(); (loadModelCallLimit as jest.Mock).mockResolvedValue(5); (saveModelCallLimit as jest.Mock).mockResolvedValue(undefined);
});
const input = "Лимит обращений к LLM на сообщение";
const save = "Сохранить лимит обращений к LLM";

test("the loaded value can be stepped and saved, and is restored on a new mount", async () => {
  const v = render(<AgentLimitsCard />);
  await waitFor(() => expect(v.getByLabelText(input).props.editable).toBe(true));
  fireEvent.press(v.getByLabelText("Увеличить лимит обращений к LLM"));
  expect(v.getByLabelText(input).props.value).toBe("5");
  fireEvent.press(v.getByLabelText(save));
  await waitFor(() => v.getByText(/Лимит сохранён/));
  expect(saveModelCallLimit).toHaveBeenCalledWith("guest", 5);
  v.unmount(); (loadModelCallLimit as jest.Mock).mockResolvedValue(5);
  const reopened = render(<AgentLimitsCard />);
  await waitFor(() => expect(reopened.getByLabelText(input).props.value).toBe("5"));
});
test.each(["", "0", "21", "1.5", "abc"])("invalid input %s is explained without writing settings", async value => {
  const v = render(<AgentLimitsCard />);
  await waitFor(() => expect(v.getByLabelText(input).props.editable).toBe(true));
  fireEvent.changeText(v.getByLabelText(input), value); fireEvent.press(v.getByLabelText(save));
  expect(v.getByText(/от 1 до 20/)).toBeTruthy(); expect(saveModelCallLimit).not.toHaveBeenCalled();
});
test("a failed save keeps the old saved summary and allows retry", async () => {
  (saveModelCallLimit as jest.Mock).mockRejectedValueOnce(new Error("storage_failure"));
  const v = render(<AgentLimitsCard />); await waitFor(() => expect(v.getByLabelText(input).props.editable).toBe(true));
  fireEvent.changeText(v.getByLabelText(input), "8"); fireEvent.press(v.getByLabelText(save));
  await waitFor(() => v.getByText(/Прежнее значение остаётся/));
  expect(v.getByText("До 5 обращений к LLM на сообщение")).toBeTruthy();
  fireEvent.press(v.getByLabelText(save)); await waitFor(() => v.getByText(/Лимит сохранён/));
  expect(v.getByText("До 8 обращений к LLM на сообщение")).toBeTruthy();
});
test("a pending save cannot be submitted twice", async () => {
  let finish!: () => void;
  (saveModelCallLimit as jest.Mock).mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  const v = render(<AgentLimitsCard />); await waitFor(() => expect(v.getByLabelText(input).props.editable).toBe(true));
  fireEvent.press(v.getByLabelText(save)); fireEvent.press(v.getByLabelText(save));
  expect(saveModelCallLimit).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); });
});
