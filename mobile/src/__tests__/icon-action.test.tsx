import React from "react";
import { Platform, ToastAndroid } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { IconAction, resetActionHints } from "../components/IconAction";
jest.mock("@expo/vector-icons/Feather", () => () => null);

beforeEach(() => resetActionHints());
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
test.each(["android", "ios"] as const)("%s: tapping shows help beside the button and performs the action; holding only explains", os => {
  jest.useFakeTimers(); jest.replaceProperty(Platform, "OS", os);
  const toast = jest.spyOn(ToastAndroid, "show").mockImplementation(() => {});
  const pressed = jest.fn();
  const v = render(<IconAction icon="clock" label="История" accessibilityLabel="История диалогов" hint="Открыть сохранённые диалоги" onPress={pressed} />);
  fireEvent.press(v.getByLabelText("История диалогов"));
  expect(pressed).toHaveBeenCalledTimes(1);
  expect(v.getByText("Открыть сохранённые диалоги")).toBeTruthy();
  expect(v.getByTestId("action-hint").props.pointerEvents).toBe("none");
  expect(toast).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(2000));
  fireEvent(v.getByLabelText("История диалогов"), "longPress");
  act(() => jest.advanceTimersByTime(1000));
  expect(v.getByText("Открыть сохранённые диалоги")).toBeTruthy();
  expect(pressed).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(1500));
  expect(v.queryByText("Открыть сохранённые диалоги")).toBeNull();
  v.unmount();
});

test("a disabled action does not show help or execute", () => {
  const pressed = jest.fn();
  const v = render(<IconAction icon="edit" label="Новый чат" accessibilityLabel="Новый диалог" hint="Создать пустой диалог" onPress={pressed} disabled />);
  fireEvent.press(v.getByLabelText("Новый диалог"));
  fireEvent(v.getByLabelText("Новый диалог"), "longPress");
  expect(pressed).not.toHaveBeenCalled(); expect(v.queryByText("Создать пустой диалог")).toBeNull();
});

test("only the most recently requested hint remains visible until its own timeout", () => {
  jest.useFakeTimers();
  const v = render(<>
    <IconAction icon="mic" label="Голос" accessibilityLabel="Голос" hint="Надиктовать" onPress={() => {}} />
    <IconAction icon="arrow-up" label="Отправить" accessibilityLabel="Отправить" hint="Отправить сообщение" onPress={() => {}} />
  </>);
  fireEvent.press(v.getByLabelText("Голос"));
  act(() => jest.advanceTimersByTime(1000));
  fireEvent.press(v.getByLabelText("Отправить"));
  expect(v.queryByText("Надиктовать")).toBeNull();
  act(() => jest.advanceTimersByTime(1500));
  expect(v.getByText("Отправить сообщение")).toBeTruthy();
  act(() => jest.advanceTimersByTime(1000));
  expect(v.queryByText("Отправить сообщение")).toBeNull();
});

test("a tap explains an action only the first time; holding explains it again", () => {
  jest.useFakeTimers();
  const pressed = jest.fn();
  const v = render(<IconAction icon="arrow-up" label="Отправить" accessibilityLabel="Отправить запрос" hint="Отправить сообщение" onPress={pressed} />);
  fireEvent.press(v.getByLabelText("Отправить запрос"));
  expect(v.getByText("Отправить сообщение")).toBeTruthy();
  act(() => jest.advanceTimersByTime(2500));
  fireEvent.press(v.getByLabelText("Отправить запрос"));
  expect(v.queryByText("Отправить сообщение")).toBeNull();
  expect(pressed).toHaveBeenCalledTimes(2);
  fireEvent(v.getByLabelText("Отправить запрос"), "longPress");
  expect(v.getByText("Отправить сообщение")).toBeTruthy();
});


test("compact composer action is icon-only, keyboard-accessible, and retains its hint/action", () => {
  const onPress = jest.fn();
  const view = render(<IconAction icon="camera" label="Камера" accessibilityLabel="Сфотографировать и распознать"
    hint="Снять фото и распознать текст" compact onPress={onPress} />);
  const action = view.getByLabelText("Сфотографировать и распознать");
  expect(view.queryByText("Камера")).toBeNull();
  const style = typeof action.props.style === "function" ? action.props.style({ pressed: false }) : action.props.style;
  expect(style.minWidth).toBe(48);
  expect(style.minHeight).toBe(48);
  fireEvent.press(action);
  expect(onPress).toHaveBeenCalledTimes(1);
  expect(view.getByText("Снять фото и распознать текст")).toBeTruthy();
});
