import React from "react";
import {act, fireEvent, render, waitFor} from "@testing-library/react-native";
import {VerifiedRelativeConversations} from "../VerifiedRelativeConversations";

const mockNavigate=jest.fn();
let sessionListener:(unlocked:boolean)=>void=()=>{};
const locator={
  attachmentId:"audio-1",recordId:"call-1",recordVersion:1,
  name:"созвон.mp3",mime:"audio/mpeg",size:1000,
  kind:"audio" as const,metadataOnly:true as const,originalTime:null,originalPage:null,
};
const confirmed={
  entity:{id:"call-1",title:"Разговор с Верой",record_version:1,
    collection_id:"standard",kind:"note",record_status:"active",sensitivity:"inherit",payload:{body:"Говорили с Верой"}},
  chunk:"Говорили с Верой",score:100,
  originals:[locator],
  proof:{relativeId:"vera-1",relationEvidenceId:"witness-sister",participantEvidenceId:"witness-call",truncated:false},
};
const mockRepo={
  entity:jest.fn(async()=>({id:"self-1",kind:"person",record_status:"active",record_version:1})),
  searchMemory:jest.fn(async()=>[confirmed]),
};
jest.mock("@react-navigation/native",()=>({useNavigation:()=>({navigate:mockNavigate})}));
jest.mock("../../local-memory/repository",()=>({localMemoryRepository:async()=>mockRepo}));
jest.mock("../../local-memory/storage",()=>({
  onLocalMemorySessionChange:(fn:(unlocked:boolean)=>void)=>{sessionListener=fn;return()=>{sessionListener=()=>{};};},
}));
jest.mock("../../local-memory/errors",()=>({memoryErrorMessage:(e:Error)=>e.message}));
jest.mock("../../components/BottomSheet",()=>({
  BottomSheet:({visible,children}:{visible:boolean;children:React.ReactNode})=>visible?children:null,
}));
jest.mock("../../design/nebula/memoryNotePresentation",()=>({
  memoryDisplayTitle:(v:{title?:string|null})=>v.title||"Без названия",
}));
jest.mock("../../theme",()=>({useTheme:()=>({
  bg:"#05050b",panel:"#181823",soft:"#242435",text:"#fff",muted:"#aaa",
  accent:"#82d4ff",secondary:"#8cdbff",line:"#333",err:"#ff7777",
})}));
beforeEach(()=>{
  jest.clearAllMocks();sessionListener=()=>{};
  mockRepo.entity.mockResolvedValue({id:"self-1",kind:"person",record_status:"active",record_version:1});
  mockRepo.searchMemory.mockResolvedValue([confirmed]);
});
const start=(ui:ReturnType<typeof render>)=>{
  fireEvent.press(ui.getByLabelText("Найти подтверждённые разговоры по связям"));
  fireEvent.press(ui.getByLabelText("Искать разговоры: Сестра"));
};

test("REL-01/R3b2b: explicit person ID, proof-only search and real audio locator reuse",async()=>{
  const ui=render(<VerifiedRelativeConversations profile="guest" personId="self-1" personTitle="Личность пользователя"/>);
  start(ui);
  await waitFor(()=>expect(mockRepo.searchMemory).toHaveBeenCalledWith(
    expect.any(String),{verifiedRelative:{ownerPersonId:"self-1",relationKind:"has_sister"},limit:20},
  ));
  await waitFor(()=>ui.getByLabelText("Открыть подтверждённый разговор Разговор с Верой"));
  expect(ui.getByText(/Исходная персона: Личность пользователя/)).toBeTruthy();
  expect(mockNavigate).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Открыть подтверждённый разговор Разговор с Верой"));
  await waitFor(()=>expect(mockRepo.searchMemory).toHaveBeenCalledTimes(2));
  await waitFor(()=>expect(mockNavigate).toHaveBeenCalledWith("MemoryNote",{
    entityId:"call-1",verifiedOriginal:locator,
  }));
});

test("REL-06/MEDIA-08: mere mention, false proof and similar names never become a conversation",async()=>{
  mockRepo.searchMemory.mockResolvedValueOnce([{
    ...confirmed,entity:{...confirmed.entity,id:"mentioned-1",title:"Упоминание Веры"},
    proof:undefined,originals:undefined,
  }]);
  const ui=render(<VerifiedRelativeConversations profile="guest" personId="self-1" personTitle="Я"/>);
  start(ui);
  await waitFor(()=>ui.getByText(/Подтверждённых разговоров в доступной части/));
  expect(ui.queryByLabelText("Открыть подтверждённый разговор Упоминание Веры")).toBeNull();
  expect(mockNavigate).not.toHaveBeenCalled();
});

test("SEC-08/REL-08: retracted witness between display and tap refuses stale navigation",async()=>{
  mockRepo.searchMemory.mockResolvedValueOnce([confirmed]).mockResolvedValueOnce([]);
  const ui=render(<VerifiedRelativeConversations profile="guest" personId="self-1" personTitle="Я"/>);
  start(ui);
  await waitFor(()=>ui.getByLabelText("Открыть подтверждённый разговор Разговор с Верой"));
  fireEvent.press(ui.getByLabelText("Открыть подтверждённый разговор Разговор с Верой"));
  await waitFor(()=>ui.getByText("Связь или источник изменились. Повторите поиск."));
  expect(mockNavigate).not.toHaveBeenCalled();
});

test("SEC-04/07: lock wipes proof titles and discards a pending stale search",async()=>{
  let resolveSearch!:(value:unknown[])=>void;
  mockRepo.searchMemory.mockImplementationOnce(()=>new Promise(resolve=>{resolveSearch=resolve;}));
  const ui=render(<VerifiedRelativeConversations profile="guest" personId="self-1" personTitle="Я"/>);
  start(ui);
  await waitFor(()=>expect(mockRepo.searchMemory).toHaveBeenCalledTimes(1));
  act(()=>sessionListener(false));
  await act(async()=>resolveSearch([confirmed]));
  expect(ui.queryByText("Разговор с Верой")).toBeNull();
  expect(mockNavigate).not.toHaveBeenCalled();
});

test("SEARCH-06: a missing/archived person is not inferred from its display name",async()=>{
  mockRepo.entity.mockResolvedValueOnce({id:"self-1",kind:"person",record_status:"archived"});
  const ui=render(<VerifiedRelativeConversations profile="guest" personId="self-1" personTitle="Я"/>);
  start(ui);
  await waitFor(()=>ui.getByText("Выбранная запись человека больше не доступна."));
  expect(mockRepo.searchMemory).not.toHaveBeenCalled();
});
