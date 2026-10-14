import React from "react";
import { Platform, ToastAndroid } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { IconAction } from "../components/IconAction";
jest.mock("@expo/vector-icons/Feather", () => () => null);

test("an Android icon has a visible label and a tap explains and executes the action without opening a modal", () => {
  jest.replaceProperty(Platform, "OS", "android");
  const toast = jest.spyOn(ToastAndroid, "show").mockImplementation(() => {});
  const pressed = jest.fn();
  const v = render(<IconAction icon="clock" label="История" accessibilityLabel="История диалогов" hint="Открыть сохранённые диалоги" onPress={pressed} />);
  expect(v.getByText("История")).toBeTruthy();
  fireEvent.press(v.getByLabelText("История диалогов"));
  expect(pressed).toHaveBeenCalledTimes(1);
  expect(toast).toHaveBeenCalledWith("Открыть сохранённые диалоги", ToastAndroid.SHORT);
  fireEvent(v.getByLabelText("История диалогов"), "longPress");
  expect(toast).toHaveBeenCalledTimes(2); expect(pressed).toHaveBeenCalledTimes(1);
  jest.restoreAllMocks();
});

test("the non-Android hint is inline, expires, and a disabled action remains named", () => {
  jest.useFakeTimers(); jest.replaceProperty(Platform, "OS", "ios");
  const pressed = jest.fn();
  const v = render(<IconAction icon="edit" label="Новый чат" accessibilityLabel="Новый диалог" hint="Создать пустой диалог" onPress={pressed} />);
  fireEvent.press(v.getByLabelText("Новый диалог"));
  expect(v.getByText("Создать пустой диалог")).toBeTruthy(); expect(pressed).toHaveBeenCalledTimes(1);
  act(() => { jest.advanceTimersByTime(2500); }); expect(v.queryByText("Создать пустой диалог")).toBeNull();
  v.rerender(<IconAction icon="edit" label="Новый чат" accessibilityLabel="Новый диалог" hint="Создать пустой диалог" onPress={pressed} disabled />);
  expect(v.getByText("Новый чат")).toBeTruthy();
  fireEvent.press(v.getByLabelText("Новый диалог")); expect(pressed).toHaveBeenCalledTimes(1);
  v.unmount(); jest.useRealTimers(); jest.restoreAllMocks();
});
