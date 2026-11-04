import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { NebulaConfirmSheet } from "../NebulaConfirmSheet";

jest.mock("../BottomSheet", () => {
  const React = require("react");
  const { View, Text } = require("react-native");
  return { BottomSheet: ({ visible, title, children }: any) =>
    visible ? <View><Text>{title}</Text>{children}</View> : null };
});
jest.mock("../../design/nebula/components", () => {
  const React = require("react");
  const { Pressable, Text } = require("react-native");
  return { NebulaAction: ({ label, onPress, disabled }: any) =>
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}>
      <Text>{label}</Text>
    </Pressable> };
});
jest.mock("../../theme", () => ({ useTheme: () => ({ text: "#fff" }) }));

test("cancel and confirm are distinct, reachable buttons and do not run each other", () => {
  const onCancel = jest.fn(); const onConfirm = jest.fn();
  const ui = render(<NebulaConfirmSheet visible title="Несохранённая запись"
    message="Изменения будут потеряны" confirmLabel="Выйти без сохранения"
    cancelLabel="Продолжить редактирование" danger onCancel={onCancel} onConfirm={onConfirm} />);
  expect(ui.getByText("Изменения будут потеряны")).toBeTruthy();
  fireEvent.press(ui.getByLabelText("Продолжить редактирование"));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(onConfirm).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Выйти без сохранения"));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

test("hidden or disabled confirmations cannot run destructive actions", () => {
  const onConfirm = jest.fn();
  const ui = render(<NebulaConfirmSheet visible={false} title="Проверка"
    message="Текст" confirmLabel="Удалить" onCancel={jest.fn()} onConfirm={onConfirm} />);
  expect(ui.queryByLabelText("Удалить")).toBeNull();
  ui.rerender(<NebulaConfirmSheet visible title="Проверка"
    message="Текст" confirmLabel="Удалить" disabled onCancel={jest.fn()} onConfirm={onConfirm} />);
  fireEvent.press(ui.getByLabelText("Удалить"));
  expect(onConfirm).not.toHaveBeenCalled();
});
