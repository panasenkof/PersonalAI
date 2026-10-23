import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { Text } from "react-native";
import { NoteEditorSection } from "../NoteEditorSection";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../../../theme", () => ({
  useTheme: () => ({
    text: "#ffffff", muted: "#abbad8", panel: "#14213d",
    line: "#445574", accent: "#7051db",
  }),
}));

describe("U2 memory note editor disclosure", () => {
  it("hides additional fields by default and exposes them after expanding", () => {
    const onToggle = jest.fn();
    const view = render(<NoteEditorSection title="Параметры записи" summary="Тип: заметка" expanded={false} onToggle={onToggle}>
      <Text>Другие имена и прозвища</Text>
    </NoteEditorSection>);
    const trigger = view.getByLabelText("Параметры записи");
    expect(trigger.props.accessibilityState.expanded).toBe(false);
    expect(view.queryByText("Другие имена и прозвища")).toBeNull();
    expect(view.getByText("Тип: заметка")).toBeTruthy();
    fireEvent.press(trigger);
    expect(onToggle).toHaveBeenCalledTimes(1);
    view.rerender(<NoteEditorSection title="Параметры записи" expanded onToggle={onToggle}>
      <Text>Другие имена и прозвища</Text>
    </NoteEditorSection>);
    expect(view.getByText("Другие имена и прозвища")).toBeTruthy();
    expect(view.getByLabelText("Параметры записи").props.accessibilityState.expanded).toBe(true);
  });
  it("does not persist disclosure state or private notes and uses 48dp touch targets", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(path.join(__dirname, "..", "NoteEditorSection.tsx"), "utf8");
    expect(source).not.toMatch(/SecureStore|AsyncStorage|remember\(/);
    expect(source).toContain("nebulaTouch.minimum");
  });
});
