
import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { PhotoContextActions } from "../PhotoContextActions";
jest.mock("../../theme",()=>({useTheme:()=>({
  text:"#fff",secondary:"#52dfef",accent:"#a49bff",muted:"#adb3d3",
  line:"#32365a",panel:"#191c39",soft:"#252a4f",glow:"#584a9f",
})}));
test("Nebula actions expose four separate purposes and an explicit safe cancellation",()=>{
  const onCancel=jest.fn();
  const run=jest.fn();
  const actions=[
    {id:"internet" as const,label:"В интернете",run},
    {id:"memory" as const,label:"В моей памяти",run},
    {id:"note" as const,label:"Сохранить заметку",run},
    {id:"preview" as const,label:"Посмотреть",run},
  ];
  const ui=render(<PhotoContextActions actions={actions} onCancel={onCancel}/>);
  expect(ui.getByTestId("photo-context-actions")).toBeTruthy();
  expect(ui.getByText("Что сделать с фото?")).toBeTruthy();
  for(const action of actions) expect(ui.getByLabelText(action.label)).toBeTruthy();
  fireEvent.press(ui.getByLabelText("Отмена: убрать выбранное фото"));
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(run).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("В моей памяти"));
  expect(run).toHaveBeenCalledTimes(1);
});
test("disabled context prevents cancellation and search while running",()=>{
  const onCancel=jest.fn(),run=jest.fn();
  const ui=render(<PhotoContextActions actions={[{id:"memory",label:"В моей памяти",run}]} onCancel={onCancel} disabled/>);
  expect(ui.getByLabelText("В моей памяти").props.accessibilityState.disabled).toBe(true);
  expect(ui.getByLabelText("Отмена: убрать выбранное фото").props.disabled).toBe(true);
});
