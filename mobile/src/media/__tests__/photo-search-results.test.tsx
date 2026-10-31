import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { PhotoSearchResults } from "../PhotoSearchResults";
jest.mock("../../theme", () => ({useTheme:() => ({text:"white",secondary:"cyan",accent:"cyan"})}));
jest.mock("../MemoryCover", () => ({MemoryCover:() => null}));
const results = Array.from({length:6},(_,i)=>({id:String(i),title:"Фото "+i,via:"search" as const,photo:true,photoAttachmentId:"a"+i}));
test("only best photo shown initially, the remaining matches expand on demand",()=>{
  const open=jest.fn();
  const screen=render(<PhotoSearchResults profile="guest" results={results} onOpen={open}/>);
  expect(screen.getByText("Фото 0")).toBeTruthy();
  expect(screen.queryByText("Фото 1")).toBeNull();
  expect(screen.queryByText("Фото 5")).toBeNull();
  fireEvent.press(screen.getByText("Показать другие варианты (5)"));
  fireEvent.press(screen.getByLabelText("Открыть найденное фото Фото 5"));
  expect(open).toHaveBeenLastCalledWith(results[5],true);
  fireEvent.press(screen.getByLabelText("Открыть запись Фото 5"));
  expect(open).toHaveBeenLastCalledWith(results[5],false);
  fireEvent.press(screen.getByText("Скрыть другие варианты"));
  expect(screen.queryByText("Фото 5")).toBeNull();
});

test("a single result has no unnecessary alternative-photos toggle",()=>{
  const screen=render(<PhotoSearchResults profile="guest" results={results.slice(0,1)} onOpen={jest.fn()}/>);
  expect(screen.getByText("Фото 0")).toBeTruthy();
  expect(screen.queryByText(/Показать другие варианты/)).toBeNull();
});
