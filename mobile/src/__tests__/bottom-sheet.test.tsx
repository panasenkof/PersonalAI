import React from "react";
import { Keyboard, Modal, View, Text } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { BottomSheet } from "../components/BottomSheet";
import { ApplicationVisibility, applicationModalActive } from "../security/visibility";
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("react-native-safe-area-context", () => {
  const React = require("react");
  // The Activity has no bottom inset; its translucent Modal has a 48px bar.
  const context = React.createContext({ top: 24, bottom: 0, left: 0, right: 0 });
  return {
    useSafeAreaInsets: () => React.useContext(context),
    SafeAreaProvider: ({ children }: any) => React.createElement(context.Provider, { value: { top: 24, bottom: 48, left: 0, right: 0 } }, children),
  };
});

test("a native portal disappears immediately while the application is covered and preserves the requesting screen", () => {
  const close = jest.fn();
  const tree = (visible: boolean) => <ApplicationVisibility.Provider value={visible}><BottomSheet visible title="Мои диалоги" onClose={close}><Text>Личные диалоги</Text></BottomSheet></ApplicationVisibility.Provider>;
  const v = render(tree(true)); expect(v.getByText("Личные диалоги")).toBeTruthy();
  v.rerender(tree(false)); expect(v.queryByText("Личные диалоги", { includeHiddenElements: true })).toBeNull();
  expect(close).not.toHaveBeenCalled();
  v.rerender(tree(true)); expect(v.getByText("Личные диалоги")).toBeTruthy();
});
test("backdrop, explicit close and system Back dismiss the keyboard and the sheet", () => {
  const close = jest.fn(); jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
  const v = render(<BottomSheet visible title="Раздел" onClose={close}><Text>Рецепты</Text></BottomSheet>);
  fireEvent.press(v.getByLabelText("Закрыть: Раздел", { includeHiddenElements: true }));
  fireEvent.press(v.getByLabelText("Закрыть панель Раздел"));
  fireEvent(v.UNSAFE_getByType(Modal), "requestClose");
  expect(close).toHaveBeenCalledTimes(3); expect(Keyboard.dismiss).toHaveBeenCalledTimes(3);
});

test("the sheet uses its own native window's system inset and releases its focus registration on hide/unmount", () => {
  const tree = (visible: boolean) => <BottomSheet visible={visible} title="Раздел" onClose={() => {}}><Text>Создать</Text></BottomSheet>;
  const v = render(tree(true));
  const panel = v.UNSAFE_getAllByType(View).find(node => node.props.accessibilityViewIsModal);
  expect(panel?.props.style.paddingBottom).toBeGreaterThanOrEqual(48);
  expect(applicationModalActive()).toBe(true);
  v.rerender(tree(false)); expect(applicationModalActive()).toBe(false);
  v.rerender(tree(true)); expect(applicationModalActive()).toBe(true);
  v.unmount(); expect(applicationModalActive()).toBe(false);
});
