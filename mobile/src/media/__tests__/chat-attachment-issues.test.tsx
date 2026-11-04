import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { ChatAttachmentIssues } from "../ChatAttachmentIssues";

jest.mock("../../theme",()=>({useTheme:()=>({
  text:"#fff",secondary:"#52dfef",accent:"#a49bff",soft:"#252a4f",
  panel:"#151b36",line:"#40496c",muted:"#b5b6d2",
})}));

const issues=[
  {name:"scan.pdf",reason:"В PDF нет читаемого текстового слоя."},
  {name:"meeting.mp3",reason:"Сначала скачайте локальный Whisper."},
];

test("H4: rejected items are independently actionable and no original data is rendered",()=>{
  const retry=jest.fn(),dismiss=jest.fn();
  const ui=render(<ChatAttachmentIssues issues={issues} onReselect={retry} onDismiss={dismiss}/>);
  expect(ui.getByText("Не добавлено: 2")).toBeTruthy();
  expect(ui.getByText(issues[0].reason)).toBeTruthy();
  expect(ui.getByText(issues[1].reason)).toBeTruthy();
  expect(ui.getByLabelText("Причины ошибок вложений").props.style.maxHeight).toBe(222);
  const retryButton=ui.getByLabelText("Выбрать заново scan.pdf");
  const removeButton=ui.getByLabelText("Убрать ошибку meeting.mp3");
  for (const button of [retryButton,removeButton]) {
    const style=typeof button.props.style==="function" ? button.props.style({pressed:false}) : button.props.style;
    expect(style.minHeight).toBeGreaterThanOrEqual(48);
    expect(style.borderWidth).toBe(1);
    expect(style.borderColor).toBeTruthy();
    expect(style.backgroundColor).toBeTruthy();
  }
  fireEvent.press(retryButton);
  fireEvent.press(removeButton);
  expect(retry).toHaveBeenCalledTimes(1);
  expect(dismiss).toHaveBeenCalledWith(1);
});
test("H4: retry disabled when app is processing, dismissal remains available",()=>{
  const retry=jest.fn(),dismiss=jest.fn();
  const ui=render(<ChatAttachmentIssues issues={[issues[0]]} disabled onReselect={retry} onDismiss={dismiss}/>);
  fireEvent.press(ui.getByLabelText("Выбрать заново scan.pdf"));
  expect(retry).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Убрать ошибку scan.pdf"));
  expect(dismiss).toHaveBeenCalledWith(0);
  ui.rerender(<ChatAttachmentIssues issues={[]} onReselect={retry} onDismiss={dismiss}/>);
  expect(ui.queryByTestId("chat-attachment-issues")).toBeNull();
});
