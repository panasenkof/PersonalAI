import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { PhotoSearchResults } from "../PhotoSearchResults";
jest.mock("../../theme", () => ({useTheme:() => ({text:"white",secondary:"cyan",accent:"cyan"})}));
jest.mock("../MemoryCover", () => ({MemoryCover:() => null}));
const results = Array.from({length:6},(_,i)=>({id:String(i),title:"Фото "+i,via:"search" as const,photo:true,photoAttachmentId:"a"+i}));
test("initial four results expand, open exact photo and separate note, then collapse",()=>{
  const open=jest.fn();
  const screen=render(<PhotoSearchResults profile="guest" results={results} onOpen={open}/>);
  expect(screen.queryByText("Фото 5")).toBeNull();
  fireEvent.press(screen.getByText("Показать ещё 2"));
  fireEvent.press(screen.getByLabelText("Открыть найденное фото Фото 5"));
  expect(open).toHaveBeenLastCalledWith(results[5],true);
  fireEvent.press(screen.getByLabelText("Открыть запись Фото 5"));
  expect(open).toHaveBeenLastCalledWith(results[5],false);
  fireEvent.press(screen.getByText("Свернуть фотографии"));
  expect(screen.queryByText("Фото 5")).toBeNull();
});
