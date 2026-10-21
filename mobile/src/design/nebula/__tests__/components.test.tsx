import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { NebulaAction, NebulaSection, NebulaSettingRow, NebulaSurface } from "../components";

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
  it("presents settings as one navigable summary, not an inline settings form", () => {
    const open = jest.fn();
    const v = render(<NebulaSettingRow title="Подключения" summary="Модели и API" icon="link" onPress={open} />);
    fireEvent.press(v.getByLabelText("Подключения"));
    expect(open).toHaveBeenCalledTimes(1);
    expect(v.getByText("Модели и API")).toBeTruthy();
  });
  it("reuses the same semantic surface for separate sections", () => {
    const v = render(<NebulaSurface><NebulaSection title="Память">Текст заметки</NebulaSection></NebulaSurface>);
    expect(v.getByText("Память")).toBeTruthy();
    expect(v.getByText("Текст заметки")).toBeTruthy();
  });
});
