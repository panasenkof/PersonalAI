import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";
import { MemoryTagFacet } from "../MemoryTagFacet";
import type { SqliteMemoryRepository } from "../../../local-memory/repository";

let unlocked = true;
let sessionListener: ((unlocked: boolean) => void) | null = null;
jest.mock("../../../local-memory/storage", () => ({
  localMemorySessionUnlocked: () => unlocked,
  onLocalMemorySessionChange: (cb: (v: boolean) => void) => { sessionListener=cb; return () => {sessionListener=null;}; },
}));
jest.mock("../../../components/BottomSheet", () => ({
  BottomSheet: ({visible,children}:any) => visible ? children : null,
}));
jest.mock("../components", () => ({
  NebulaAction: ({label,accessibilityLabel,disabled,onPress}:any) =>
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel||label}
      accessibilityState={{disabled}} disabled={disabled} onPress={onPress}><Text>{label}</Text></Pressable>,
}));
jest.mock("../../../theme", () => ({
  useTheme: () => ({text:"#fff",muted:"#abbad8",line:"#445574"}),
}));

const listNoteTags=jest.fn(async (_filters:unknown,_limit:number,offset:number)=>
  offset===0?["авто","дом"]:[]);
const repo={listNoteTags} as unknown as SqliteMemoryRepository;
beforeEach(()=>{jest.clearAllMocks();unlocked=true;sessionListener=null;});
test("MSG-6C7: no network or note write, choose exact stored tag only after explicit tap", async()=>{
  const onTagChange=jest.fn(),onError=jest.fn();
  const ui=render(<MemoryTagFacet repository={repo} profile="guest" status="active"
    disabled={false} onTagChange={onTagChange} onError={onError} />);
  expect(listNoteTags).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Фильтр по тегу"));
  await waitFor(()=>expect(ui.getByLabelText("Выбрать тег авто")).toBeTruthy());
  expect(listNoteTags).toHaveBeenCalledWith({collectionId:undefined,status:"active"},50,0);
  expect(onTagChange).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Выбрать тег авто"));
  expect(onTagChange).toHaveBeenCalledWith("авто");
  expect(ui.queryByLabelText("Выбрать тег авто")).toBeNull();
  expect(onError).not.toHaveBeenCalled();
});
test("MSG-6C7: manual facet validates one tag and a separate clear operation",async()=>{
  const onTagChange=jest.fn(),onError=jest.fn();
  const ui=render(<MemoryTagFacet repository={repo} profile="guest" status="archived"
    tag="авто" disabled={false} onTagChange={onTagChange} onError={onError} />);
  fireEvent.press(ui.getByLabelText("Фильтр по тегу"));
  fireEvent.changeText(ui.getByLabelText("Ввести тег для фильтра"),"#ДОМ");
  fireEvent.press(ui.getByLabelText("Применить тег"));
  expect(onTagChange).toHaveBeenCalledWith("дом");
  fireEvent.press(ui.getByLabelText("Сбросить фильтр тега"));
  expect(onTagChange).toHaveBeenLastCalledWith(undefined);
  expect(onError).not.toHaveBeenCalled();
});
test("MSG-6C7: AppLock closes catalog without persisting tag or rendering saved labels",async()=>{
  const onTagChange=jest.fn(),onError=jest.fn();
  const ui=render(<MemoryTagFacet repository={repo} profile="guest" status="active"
    disabled={false} onTagChange={onTagChange} onError={onError} />);
  fireEvent.press(ui.getByLabelText("Фильтр по тегу"));
  await waitFor(()=>expect(ui.getByLabelText("Выбрать тег дом")).toBeTruthy());
  unlocked=false; sessionListener?.(false);
  await waitFor(()=>expect(ui.queryByLabelText("Выбрать тег дом")).toBeNull());
  expect(onTagChange).not.toHaveBeenCalled();
});
