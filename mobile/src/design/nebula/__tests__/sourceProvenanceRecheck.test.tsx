import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { SourceProvenanceCard } from "../SourceProvenanceCard";

jest.mock("../../../theme", () => ({ useTheme: () => ({
  line: "#30314F", panel: "#11162F", text: "#FFFFFF", muted: "#A7AFD0", secondary: "#98C8FC",
}) }));
jest.mock("../components", () => ({
  NebulaAction: ({label,onPress,accessibilityLabel,disabled}: any) => {
    const {Pressable,Text} = require("react-native");
    return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel || label}
      disabled={disabled} onPress={onPress}><Text>{label}</Text></Pressable>;
  },
}));
const source={title:"Источник · текст публичного поста",details:"Получен текст источника.",
  url:"https://t.me/public_news/42"};
test("saved-note source: explicit read, cancellable busy state, no write button",()=>{
  const verify=jest.fn(),cancel=jest.fn(),error=jest.fn();
  const view=render(<SourceProvenanceCard source={source} onOpenError={error}
    onRecheck={verify} onCancelRecheck={cancel}/>);
  fireEvent.press(view.getByLabelText("Сверить текст публичного поста Telegram"));
  expect(verify).toHaveBeenCalledTimes(1);
  view.rerender(<SourceProvenanceCard source={source} onOpenError={error}
    onRecheck={verify} onCancelRecheck={cancel} recheckBusy
    recheckMessage="Сверка ещё выполняется." />);
  expect(view.getByText("Сверка ещё выполняется.")).toBeTruthy();
  expect(view.getByLabelText("Сверить текст публичного поста Telegram").props.accessibilityState?.disabled ||
    view.getByLabelText("Сверить текст публичного поста Telegram").props.disabled).toBeTruthy();
  fireEvent.press(view.getByLabelText("Отменить сверку текста"));
  expect(cancel).toHaveBeenCalledTimes(1);
});
test("draft and legacy source display no recheck command",()=>{
  const view=render(<SourceProvenanceCard source={source} onOpenError={jest.fn()}/>);
  expect(view.queryByLabelText("Сверить текст публичного поста Telegram")).toBeNull();
});
