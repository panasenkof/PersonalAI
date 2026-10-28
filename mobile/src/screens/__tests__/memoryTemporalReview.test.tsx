import React from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { MemoryTemporalReviewScreen, exactUserEndDate } from "../MemoryTemporalReviewScreen";

const mockReview={
  proposalId:"proposal-1",reviewKind:"possible_change" as const,status:"pending" as const,
  expectedProposalVersion:1,expectedPreviousClaimVersion:1,expectedIncomingClaimVersion:1,
  previous:{value:"Организация А",evidence:{entityId:"note-a",quote:"Работаю в А",recordVersion:1,origin:"direct"}},
  incoming:{value:"Организация Б",evidence:{entityId:"note-b",quote:"Работаю в Б",recordVersion:1,origin:"direct"}},
};
const mockRepo={
  temporalReviewInbox:jest.fn(async()=>({items:[mockReview],nextCursor:null})),
  decideTemporalChange:jest.fn(async()=>({decisionId:"decision-1",nextProposalVersion:2})),
  undoTemporalChange:jest.fn(async()=>({decisionId:"undo-1",nextProposalVersion:3})),
};
let sessionListener:(unlocked:boolean)=>void=()=>{};
jest.mock("../..//local-memory/repository",()=>({
  localMemoryRepository:async()=>mockRepo,
}));
jest.mock("../../profile/ProfileContext",()=>({useProfile:()=> "profile-test"}));
jest.mock("../../local-memory/storage",()=>({
  onLocalMemorySessionChange:(listener:(unlocked:boolean)=>void)=>{
    sessionListener=listener;
    return ()=>{sessionListener=()=>{};};
  },
}));
jest.mock("../../local-memory/errors",()=>({
  memoryErrorMessage:(e:Error)=>e.message,
}));
jest.mock("@react-navigation/native",()=>({
  useRoute:()=>({params:{collectionId:"standard-collection"}}),
  useFocusEffect:(fn:()=>void|(()=>void))=>require("react").useEffect(fn,[fn]),
}));
jest.mock("../../theme",()=>({useTheme:()=>({
  bg:"#05050b",panel:"#181823",soft:"#242435",text:"#fff",muted:"#aaa",
  accent:"#82d4ff",secondary:"#8cdbff",line:"#333",err:"#ff7777",
})}));
beforeEach(()=>{
  jest.clearAllMocks();
  mockRepo.temporalReviewInbox.mockResolvedValue({items:[mockReview],nextCursor:null});
  mockRepo.decideTemporalChange.mockResolvedValue({decisionId:"decision-1",nextProposalVersion:2});
  mockRepo.undoTemporalChange.mockResolvedValue({decisionId:"undo-1",nextProposalVersion:3});
  sessionListener=()=>{};
});

test("source quotes and the older/newer fact are presented; defer uses versioned user-only CAS",async()=>{
  const ui=render(<MemoryTemporalReviewScreen/>);
  await waitFor(()=>ui.getByText("Ранее записано: Организация А"));
  expect(ui.getByText("Источник: «Работаю в А»")).toBeTruthy();
  expect(ui.getByText("В новом материале: Организация Б")).toBeTruthy();
  expect(ui.getByText("Источник: «Работаю в Б»")).toBeTruthy();
  fireEvent.press(ui.getByLabelText("Отложить предложение proposal-1"));
  await waitFor(()=>expect(mockRepo.decideTemporalChange).toHaveBeenCalledWith({
    proposalId:"proposal-1",expectedProposalVersion:1,
    expectedPreviousClaimVersion:1,expectedIncomingClaimVersion:1,
    choice:"defer",
  }));
  expect(mockRepo.undoTemporalChange).not.toHaveBeenCalled();
});

test("accept asks explicitly for an end date; unknown is not substituted with today",async()=>{
  const ui=render(<MemoryTemporalReviewScreen/>);
  await waitFor(()=>ui.getByLabelText("Рассмотреть завершение Организация А"));
  expect(mockRepo.decideTemporalChange).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Рассмотреть завершение Организация А"));
  await waitFor(()=>ui.getByLabelText("Подтвердить окончание без даты"));
  fireEvent.press(ui.getByLabelText("Подтвердить окончание без даты"));
  await waitFor(()=>expect(mockRepo.decideTemporalChange).toHaveBeenCalledWith({
    proposalId:"proposal-1",expectedProposalVersion:1,
    expectedPreviousClaimVersion:1,expectedIncomingClaimVersion:1,
    choice:"accept",
    confirmedEnd:{
      normalized:null,precision:"unknown",
      raw:"Завершение подтверждено пользователем; точная дата неизвестна",
      anchorDate:null,sourceTimeZone:null,
    },
  }));
  await waitFor(()=>ui.getByLabelText("Отменить последнее решение памяти"));
  fireEvent.press(ui.getByLabelText("Отменить последнее решение памяти"));
  await waitFor(()=>expect(mockRepo.undoTemporalChange).toHaveBeenCalledWith({
    proposalId:"proposal-1",decisionId:"decision-1",
    expectedProposalVersion:2,expectedPreviousClaimVersion:2,
    expectedIncomingClaimVersion:1,
  }));
});

test("invalid date does not enable confirmation and a leap day retains day precision",async()=>{
  expect(exactUserEndDate("2025-02-30")).toBeNull();
  expect(exactUserEndDate("2024-02-29")).toMatchObject({
    normalized:"2024-02-29",precision:"day",
  });
  const ui=render(<MemoryTemporalReviewScreen/>);
  await waitFor(()=>ui.getByLabelText("Рассмотреть завершение Организация А"));
  fireEvent.press(ui.getByLabelText("Рассмотреть завершение Организация А"));
  fireEvent.changeText(ui.getByLabelText("Дата окончания прежнего состояния"),"2025-02-30");
  expect(ui.getByLabelText("Подтвердить окончание с указанной датой").props.accessibilityState?.disabled ??
    ui.getByLabelText("Подтвердить окончание с указанной датой").props.disabled).toBe(true);
  expect(mockRepo.decideTemporalChange).not.toHaveBeenCalled();
  fireEvent.changeText(ui.getByLabelText("Дата окончания прежнего состояния"),"2024-02-29");
  fireEvent.press(ui.getByLabelText("Подтвердить окончание с указанной датой"));
  await waitFor(()=>expect(mockRepo.decideTemporalChange).toHaveBeenCalledWith(
    expect.objectContaining({choice:"accept",confirmedEnd:expect.objectContaining({
      normalized:"2024-02-29",precision:"day",
    })}),
  ));
});

test("lock clears evidence immediately; no private text remains visible",async()=>{
  const ui=render(<MemoryTemporalReviewScreen/>);
  await waitFor(()=>ui.getByText("Источник: «Работаю в А»"));
  act(()=>sessionListener(false));
  expect(ui.queryByText("Источник: «Работаю в А»")).toBeNull();
  expect(ui.getByText(/Память заблокирована/)).toBeTruthy();
});
