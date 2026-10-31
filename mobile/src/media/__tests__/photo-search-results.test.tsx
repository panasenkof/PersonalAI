import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { PhotoSearchResults } from "../PhotoSearchResults";
jest.mock("../../theme", () => ({useTheme:() => ({text:"white",secondary:"cyan",accent:"cyan"})}));
jest.mock("../MemoryCover", () => ({MemoryCover:() => null}));
const results = Array.from({length:6},(_,i)=>({id:String(i),title:"Фото "+i,via:"search" as const,photo:true,photoAttachmentId:"a"+i}));
test("all relevant returned photos are visible without extra taps",()=>{
  const open=jest.fn();
  const screen=render(<PhotoSearchResults profile="guest" results={results} onOpen={open}/>);
  for(let i=0;i<results.length;i++)expect(screen.getByText("Фото "+i)).toBeTruthy();
  expect(screen.queryByText(/Показать другие варианты/)).toBeNull();
  fireEvent.press(screen.getByLabelText("Открыть найденное фото Фото 5 6"));
  expect(open).toHaveBeenLastCalledWith(results[5],true);
  fireEvent.press(screen.getByLabelText("Открыть запись Фото 5 6"));
  expect(open).toHaveBeenLastCalledWith(results[5],false);
});
test("several originals of one note stay separate and selectable",()=>{
  const same=results.slice(0,3).map(r=>({...r,id:"note-1",title:"Одна коллекция"}));
  const screen=render(<PhotoSearchResults profile="guest" results={same} onOpen={jest.fn()}/>);
  expect(screen.getAllByText("Одна коллекция")).toHaveLength(3);
});
