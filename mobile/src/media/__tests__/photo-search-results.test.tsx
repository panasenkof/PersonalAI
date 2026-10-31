import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { PhotoSearchResults } from "../PhotoSearchResults";
jest.mock("../../theme", () => ({useTheme:() => ({text:"white",secondary:"cyan",accent:"cyan",soft:"#252A4F",line:"#32365A"})}));
jest.mock("../MemoryCover", () => ({MemoryCover:() => null}));
const results = Array.from({length:9},(_,i)=>({
  id:String(i),title:"Фото "+i,via:"search" as const,photo:true,photoAttachmentId:"a"+i,
}));
test("only the best result is visible; five next-best are expandable and collapsible",()=>{
  const open=jest.fn();
  const screen=render(<PhotoSearchResults profile="guest" results={results} onOpen={open}/>);
  expect(screen.getByText("Фото 0")).toBeTruthy();
  for(let i=1;i<9;i++)expect(screen.queryByText("Фото "+i)).toBeNull();
  expect(screen.getByTestId("photo-results-toggle").props.accessibilityState.expanded).toBe(false);
  fireEvent.press(screen.getByText("Показать ещё 5 похожих фото"));
  for(let i=0;i<6;i++)expect(screen.getByText("Фото "+i)).toBeTruthy();
  for(let i=6;i<9;i++)expect(screen.queryByText("Фото "+i)).toBeNull();
  expect(screen.getByTestId("photo-results-toggle").props.accessibilityState.expanded).toBe(true);
  fireEvent.press(screen.getByLabelText("Открыть найденное фото Фото 5 6"));
  expect(open).toHaveBeenLastCalledWith(results[5],true);
  fireEvent.press(screen.getByLabelText("Открыть запись Фото 5 6"));
  expect(open).toHaveBeenLastCalledWith(results[5],false);
  fireEvent.press(screen.getByText("Свернуть дополнительные фото"));
  expect(screen.queryByText("Фото 5")).toBeNull();
  expect(screen.getByText("Фото 0")).toBeTruthy();
});
test("one photo needs no expand toggle",()=>{
  const screen=render(<PhotoSearchResults profile="guest" results={results.slice(0,1)} onOpen={jest.fn()}/>);
  expect(screen.getByText("Фото 0")).toBeTruthy();
  expect(screen.queryByTestId("photo-results-toggle")).toBeNull();
});
test("fewer than six matched photos offer only existing alternatives",()=>{
  const screen=render(<PhotoSearchResults profile="guest" results={results.slice(0,3)} onOpen={jest.fn()}/>);
  expect(screen.getByText("Показать ещё 2 похожих фото")).toBeTruthy();
  fireEvent.press(screen.getByTestId("photo-results-toggle"));
  expect(screen.getByText("Фото 2")).toBeTruthy();
});
test("several originals of the same note stay separate and selectable",()=>{
  const same=results.slice(0,3).map(r=>({...r,id:"note-1",title:"Одна коллекция"}));
  const open=jest.fn();
  const screen=render(<PhotoSearchResults profile="guest" results={same} onOpen={open}/>);
  expect(screen.getAllByText("Одна коллекция")).toHaveLength(1);
  fireEvent.press(screen.getByTestId("photo-results-toggle"));
  expect(screen.getAllByText("Одна коллекция")).toHaveLength(3);
  fireEvent.press(screen.getByLabelText("Открыть найденное фото Одна коллекция 3"));
  expect(open).toHaveBeenLastCalledWith(same[2],true);
});
