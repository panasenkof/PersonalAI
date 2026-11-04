import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { ImportFileSummary } from "../ImportFileSummary";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../../../theme", () => ({
  useTheme: () => ({ panel: "#14213d", text: "#fff", secondary: "#aaccff", muted: "#aabbcc", line: "#445577" }),
}));
jest.mock("../components", () => ({
  NebulaAction: ({ label, accessibilityLabel, onPress }: any) => {
    const { Pressable, Text } = require("react-native");
    return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress}><Text>{label}</Text></Pressable>;
  },
}));

const files = Array.from({ length: 5 }, (_, index) => ({
  id: "file-" + index, name: "attachment-" + index + ".pdf", kind: "document",
}));

test("large import batches display two files and a labelled expansion near their owner", () => {
  const v = render(<ImportFileSummary files={files} />);
  expect(v.getByText("Вложения · 5")).toBeTruthy();
  expect(v.getAllByTestId("import-selected-file")).toHaveLength(2);
  expect(v.queryByText("3. attachment-2.pdf")).toBeNull();
  fireEvent.press(v.getByLabelText("Показать все вложения"));
  expect(v.getAllByTestId("import-selected-file")).toHaveLength(5);
  expect(v.getByText("3. attachment-2.pdf")).toBeTruthy();
  fireEvent.press(v.getByLabelText("Свернуть список вложений"));
  expect(v.getAllByTestId("import-selected-file")).toHaveLength(2);
});
test("one original keeps its name and preview without unnecessary expansion", () => {
  const { Text } = require("react-native");
  const v = render(<ImportFileSummary files={files.slice(0, 1)} preview={<Text>Предпросмотр фото</Text>} />);
  expect(v.getByText("attachment-0.pdf")).toBeTruthy();
  expect(v.getByText("Предпросмотр фото")).toBeTruthy();
  expect(v.queryByLabelText("Показать все вложения")).toBeNull();
});
