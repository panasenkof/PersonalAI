import React from "react";
import {act,fireEvent,render,waitFor} from "@testing-library/react-native";
import {MemoryTemporalTimeline,displayTemporalBound} from "../MemoryTemporalTimeline";

const mockPush=jest.fn();
let sessionListener:(unlocked:boolean)=>void=()=>{};
const bound=(raw:string,normalized:string|null,precision="year")=>({
  raw,normalized,precision,anchorDate:null,sourceTimeZone:null,
});
const first={
  claimId:"claim-2023",claimVersion:1,verification:"candidate_unconfirmed",
  claim:{
    subjectId:"car-1",predicate:"replace_spark_plugs",context:"car.main",
    value:"Замена свечей в 2023",kind:"event",modality:"asserted",
    negated:false,cardinality:"multiple",
    occurredOrStarted:bound("2023 год","2023-01-01"),ended:null,endConfirmed:false,
    recordedAt:"2026-10-28T12:00:00.000Z",
    evidence:{entityId:"service-2023",recordVersion:1,
      quote:"Свечи заменены в 2023",origin:"direct"},
  },
};
const planned={...first,claimId:"plan-2027",claim:{
  ...first.claim,value:"Замена свечей в 2027",modality:"planned",
  occurredOrStarted:bound("2027 год","2027-01-01"),
  evidence:{entityId:"plan-source",recordVersion:1,quote:"Планирую заменить свечи",origin:"direct"},
}};
const mockDb={
  temporalKnowledgeHistory:jest.fn(async(_q:any):Promise<any>=>({items:[first,planned],nextCursor:null})),
  entity:jest.fn(async():Promise<any>=>({
    id:"service-2023",record_version:1,collection_id:"collection-a",
    record_status:"active",sensitivity:"standard",
  })),
  listCollections:jest.fn(async():Promise<any>=>[{id:"collection-a",sensitivity:"standard"}]),
};
jest.mock("@react-navigation/native",()=>({useNavigation:()=>({push:mockPush})}));
jest.mock("../../local-memory/repository",()=>({localMemoryRepository:async()=>mockDb}));
jest.mock("../../local-memory/storage",()=>({
  onLocalMemorySessionChange:(fn:(unlocked:boolean)=>void)=>{sessionListener=fn;return()=>{sessionListener=()=>{};};},
}));
jest.mock("../../local-memory/errors",()=>({memoryErrorMessage:(e:Error)=>e.message}));
jest.mock("../../theme",()=>({useTheme:()=>({
  bg:"#05050b",panel:"#181823",soft:"#242435",text:"#fff",muted:"#aaa",
  accent:"#82d4ff",secondary:"#8cdbff",line:"#333",err:"#ff7777",
})}));
beforeEach(()=>{
  jest.clearAllMocks();sessionListener=()=>{};
  mockDb.temporalKnowledgeHistory.mockResolvedValue({items:[first,planned],nextCursor:null});
  mockDb.entity.mockResolvedValue({id:"service-2023",record_version:1,collection_id:"collection-a",
    record_status:"active",sensitivity:"standard"});
  mockDb.listCollections.mockResolvedValue([{id:"collection-a",sensitivity:"standard"}]);
});
const show=(ui:ReturnType<typeof render>)=>
  fireEvent.press(ui.getByLabelText("Периоды и события в памяти"));

test("TIME-01/CAR-01/U-M3: candidate history never claims a current fact and keeps valid != knowledge date",async()=>{
  const ui=render(<MemoryTemporalTimeline profile="guest" subjectId="car-1" collectionId="collection-a"/>);
  show(ui);
  await waitFor(()=>ui.getByText("Событие · Замена свечей в 2023"));
  expect(mockDb.temporalKnowledgeHistory).toHaveBeenCalledWith({
    subjectId:"car-1",collectionId:"collection-a",mode:"all",limit:10,
  });
  expect(ui.getByText("Время события или состояния: 2023 год")).toBeTruthy();
  expect(ui.getAllByText(/Сведения получены:/).length).toBe(2);
  expect(ui.getByText(/Сведения ещё не подтверждены как текущие факты/)).toBeTruthy();
  expect(ui.queryByText("replace_spark_plugs · car.main")).toBeNull();
  expect(ui.getByText("План, не свершившийся факт")).toBeTruthy();
  expect(ui.getByText("Из источника: «Свечи заменены в 2023»")).toBeTruthy();
});

test("TIME-05: approximate and unknown time remain raw or explicitly unknown",()=>{
  expect(displayTemporalBound(bound("примерно весной",null,"approximate") as never)).toBe("примерно весной");
  expect(displayTemporalBound(null)).toBe("Дата не установлена");
  expect(displayTemporalBound(bound("",null,"unknown") as never)).toBe("Точная дата неизвестна");
});

test("U-M3: source navigation rejects changed version or secret scope, allows current standard source",async()=>{
  const ui=render(<MemoryTemporalTimeline profile="guest" subjectId="car-1" collectionId="collection-a"/>);
  show(ui);
  await waitFor(()=>ui.getByLabelText("Проверить источник claim-2023"));
  mockDb.entity.mockResolvedValueOnce({id:"service-2023",record_version:2,
    collection_id:"collection-a",record_status:"active",sensitivity:"standard"});
  fireEvent.press(ui.getByLabelText("Проверить источник claim-2023"));
  await waitFor(()=>ui.getByText("Источник изменён или недоступен. Обновите список."));
  expect(mockPush).not.toHaveBeenCalled();
  mockDb.entity.mockResolvedValueOnce({id:"service-2023",record_version:1,
    collection_id:"collection-a",record_status:"active",sensitivity:"secret"});
  fireEvent.press(ui.getByLabelText("Проверить источник claim-2023"));
  await waitFor(()=>expect(mockDb.entity).toHaveBeenCalledTimes(2));
  expect(mockPush).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Проверить источник claim-2023"));
  await waitFor(()=>expect(mockPush).toHaveBeenCalledWith("MemoryNote",{entityId:"service-2023"}));
});

test("SEC-04/SEARCH-06: AppLock removes sensitive history and ignores late query",async()=>{
  let resolve!:(v:any)=>void;
  mockDb.temporalKnowledgeHistory.mockImplementationOnce(()=>new Promise(resolveSearch=>{resolve=resolveSearch;}));
  const ui=render(<MemoryTemporalTimeline profile="guest" subjectId="car-1" collectionId="collection-a"/>);
  show(ui);
  await waitFor(()=>expect(mockDb.temporalKnowledgeHistory).toHaveBeenCalledTimes(1));
  act(()=>sessionListener(false));
  await act(async()=>resolve({items:[first],nextCursor:null}));
  expect(ui.queryByText("Событие · Замена свечей в 2023")).toBeNull();
  expect(mockPush).not.toHaveBeenCalled();
});

test("U-M3: filter mode calls same canonical reader and shows bounded pagination",async()=>{
  mockDb.temporalKnowledgeHistory.mockResolvedValueOnce({
    items:[first],nextCursor:{recordedAt:"2026-10-28T12:00:00.000Z",claimId:"claim-2023"},
  }).mockResolvedValueOnce({items:[planned],nextCursor:null});
  const ui=render(<MemoryTemporalTimeline profile="guest" subjectId="car-1" collectionId="collection-a"/>);
  show(ui);
  await waitFor(()=>ui.getByLabelText("Показать ещё периоды и события"));
  fireEvent.press(ui.getByLabelText("Показать ещё периоды и события"));
  await waitFor(()=>expect(mockDb.temporalKnowledgeHistory).toHaveBeenLastCalledWith({
    subjectId:"car-1",collectionId:"collection-a",mode:"all",limit:10,
    before:{recordedAt:"2026-10-28T12:00:00.000Z",claimId:"claim-2023"},
  }));
  await waitFor(()=>ui.getByText("Событие · Замена свечей в 2027"));
  fireEvent.press(ui.getByLabelText("История: События"));
  await waitFor(()=>expect(mockDb.temporalKnowledgeHistory).toHaveBeenLastCalledWith({
    subjectId:"car-1",collectionId:"collection-a",mode:"events",limit:10,
  }));
});
