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
  it("outlined Nebula buttons have a visible accessible boundary in both palettes", () => {
    for (const theme of ["dark", "light"] as const) {
      const colors=nebulaColors(theme);
      expect(contrastRatio(colors.actionOutline, colors.surfaceElevated))
        .toBeGreaterThanOrEqual(3);
    }
    const view=render(<NebulaAction icon="x" label="Убрать" variant="quiet" onPress={()=>{}} />);
    const action=view.getByLabelText("Убрать");
    const style=typeof action.props.style==="function"
      ? action.props.style({pressed:false}):action.props.style;
    expect(style.minHeight).toBeGreaterThanOrEqual(48);
    expect(style.borderWidth).toBe(1);
    expect(style.borderColor).toBe(nebulaColors("dark").actionOutline);
  });
  it("compacts secondary actions without losing the accessible label or tap area", () => {
    const pressed = jest.fn();
    const view = render(<NebulaAction label="Очистить корзину" icon="trash-2"
      size="compact" variant="danger" onPress={pressed} />);
    const action = view.getByLabelText("Очистить корзину");
    const style = typeof action.props.style === "function"
      ? action.props.style({ pressed: false }) : action.props.style;
    expect(style.minHeight).toBe(28);
    expect(style.minWidth).toBe(28);
    expect(style.paddingHorizontal).toBe(8);
    expect(action.props.hitSlop).toBe(10); // 28dp visual + 10dp each side = 48dp target
    expect(style.borderWidth).toBe(1);
    expect(style.borderColor).toBe(nebulaColors("dark").actionOutline);
    fireEvent.press(action);
    expect(pressed).toHaveBeenCalledTimes(1);
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
