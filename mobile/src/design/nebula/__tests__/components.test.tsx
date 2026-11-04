import React from "react";
import { Text } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { NebulaAction, NebulaSection, NebulaSettingRow, NebulaSurface } from "../components";
import { contrastRatio, nebulaColors } from "../tokens";

jest.mock("@expo/vector-icons/Feather", () => () => null);

describe("Nebula base components", () => {
  it("performs user action only while enabled", () => {
    const onPress = jest.fn();
    const v = render(<NebulaAction label="Добавить файл" icon="plus" onPress={onPress} />);
    fireEvent.press(v.getByLabelText("Добавить файл"));
    expect(onPress).toHaveBeenCalledTimes(1);
    v.rerender(<NebulaAction label="Добавить файл" icon="plus" onPress={onPress} disabled />);
    expect(v.getByLabelText("Добавить файл").props.accessibilityState.disabled).toBe(true);
    fireEvent.press(v.getByLabelText("Добавить файл"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
  it("renders a true filled irreversible action, with contrast, and preserves cancellation", () => {
    const onPress = jest.fn();
    const view = render(<NebulaAction label="Удалить 101 запись" variant="danger-solid"
      icon="trash-2" onPress={onPress} />);
    const action = view.getByLabelText("Удалить 101 запись");
    const style = typeof action.props.style === "function"
      ? action.props.style({ pressed: false }) : action.props.style;
    expect(style.backgroundColor).toBe(nebulaColors("dark").danger);
    expect(style.borderWidth).toBe(0);
    expect(contrastRatio(nebulaColors("dark").canvas, nebulaColors("dark").danger))
      .toBeGreaterThan(4.5);
    expect(view.getByText("Удалить 101 запись").props.style.color).toBe(nebulaColors("dark").canvas);
    fireEvent.press(action);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
  it("presents settings as one navigable summary, not an inline settings form", () => {
    const open = jest.fn();
    const v = render(<NebulaSettingRow title="Подключения" summary="Модели и API" icon="link" onPress={open} />);
    fireEvent.press(v.getByLabelText("Подключения"));
    expect(open).toHaveBeenCalledTimes(1);
    expect(v.getByText("Модели и API")).toBeTruthy();
  });
  it("reuses the same semantic surface for separate sections", () => {
    const v = render(<NebulaSurface><NebulaSection title="Память"><Text>Текст заметки</Text></NebulaSection></NebulaSurface>);
    expect(v.getByText("Память")).toBeTruthy();
    expect(v.getByText("Текст заметки")).toBeTruthy();
  });
});
