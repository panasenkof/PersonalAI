import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { NoteReadPreview } from "../NoteReadPreview";

jest.mock("../../../components/BottomSheet", () => {
  const React = require("react");
  const { View, Text, Pressable } = require("react-native");
  return { BottomSheet: ({ visible, title, children, onClose }: any) =>
    visible ? <View><Text>{title}</Text>{children}<Pressable accessibilityLabel="Закрыть чтение" onPress={onClose}><Text>Закрыть</Text></Pressable></View> : null };
});
jest.mock("../../../components/Markdown", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return { MarkdownText: ({ text, numberOfLines }: any) =>
    <Text testID="preview-markdown" numberOfLines={numberOfLines}>{text}</Text> };
});
jest.mock("../../../theme", () => ({ useTheme: () => ({text:"#fff",muted:"#aaa"}) }));
jest.mock("../components", () => {
  const React = require("react");
  const { Pressable, Text } = require("react-native");
  return { NebulaAction: ({ label, onPress }: any) =>
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}><Text>{label}</Text></Pressable> };
});

test("long note shows bounded preview and preserves full selectable text in reading panel", () => {
  const whole = "Статья ".repeat(1000);
  const ui = render(<NoteReadPreview text={whole} maxLines={6}
    fullTitle="Полный текст заметки" actionLabel="Читать полностью" />);
  expect(ui.getAllByTestId("preview-markdown")).toHaveLength(1);
  expect(ui.getAllByTestId("preview-markdown")[0].props.numberOfLines).toBe(6);
  expect(ui.queryByText(whole)).toBeNull();
  fireEvent.press(ui.getByLabelText("Читать полностью"));
  expect(ui.getByText(whole)).toBeTruthy();
  fireEvent.press(ui.getByLabelText("Закрыть чтение"));
  expect(ui.queryByText(whole)).toBeNull();
});

test("short note needs no extra sheet or text copy", () => {
  const ui=render(<NoteReadPreview text="Короткая запись" maxLines={6}
    fullTitle="Текст" actionLabel="Читать полностью" />);
  expect(ui.getByText("Короткая запись")).toBeTruthy();
  expect(ui.queryByLabelText("Читать полностью")).toBeNull();
});
