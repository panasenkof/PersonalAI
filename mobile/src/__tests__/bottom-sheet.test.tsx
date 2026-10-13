import React from "react";
import { Keyboard, Modal, Text } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { BottomSheet } from "../components/BottomSheet";
import { ApplicationVisibility } from "../security/visibility";
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }) }));

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
