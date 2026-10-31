import React from "react";
import { render } from "@testing-library/react-native";
import { VisionModelCard } from "../../components/VisionModelCard";
import { useVisionModelStatus } from "../vision-model-manager";
import { VISION_MODELS } from "../vision-model-catalog";

jest.mock("../../theme",()=>({useTheme:()=>({
  text:"#ffffff",muted:"#bbbbbb",secondary:"#00ffff",ok:"#00bb77",
  err:"#ff0000",line:"#444444",panel:"#222222",
})}));
jest.mock("../../components/Collapsible",()=>({
  Collapsible:({children,summary}:any)=><>{summary}{children}</>,
}));
jest.mock("../../components/VisionIndexControls",()=>({
  VisionIndexControls:()=>null,
}));
jest.mock("../vision-model-manager",()=>({
  useVisionModelStatus:jest.fn(),
  cancelVisionModelDownload:jest.fn(),
  chooseVisionModel:jest.fn(),
  deleteVisionModel:jest.fn(),
  downloadVisionModel:jest.fn(),
}));

const installed = {id:VISION_MODELS[0].id,filename:"verified.litertlm",
  sha256:"a".repeat(64),revision:"b".repeat(40),bytes:388000000};
const useStatus=useVisionModelStatus as jest.Mock;
beforeEach(()=>{
  jest.clearAllMocks();
  useStatus.mockReturnValue({
    loaded:true,busy:false,progress:0,downloadingId:null,
    activeId:installed.id,installed:[installed],error:"",notice:"",
  });
});
test("downloaded and selected vision model has explicit download label",()=>{
  const screen=render(<VisionModelCard defaultOpen/>);
  expect(screen.getByText("Скачана · Выбрана")).toBeTruthy();
  expect(screen.getByText(/Модель скачана/)).toBeTruthy();
  expect(screen.getByLabelText("Модель скачана и выбрана для поиска")).toBeTruthy();
});
test("another downloaded model says downloaded, not selected",()=>{
  useStatus.mockReturnValue({
    loaded:true,busy:false,progress:0,downloadingId:null,
    activeId:installed.id,
    installed:[installed,{...installed,id:VISION_MODELS[1].id}],
    error:"",notice:"",
  });
  const screen=render(<VisionModelCard defaultOpen/>);
  expect(screen.getByText("Скачана")).toBeTruthy();
  expect(screen.getByText("Скачана · Выбрана")).toBeTruthy();
});
test("model not on the phone is never labelled downloaded",()=>{
  useStatus.mockReturnValue({
    loaded:true,busy:false,progress:0,downloadingId:null,
    activeId:null,installed:[],error:"",notice:"",
  });
  const screen=render(<VisionModelCard defaultOpen/>);
  expect(screen.getByText(/Модель ещё не скачана/)).toBeTruthy();
  expect(screen.queryByText("Скачана")).toBeNull();
  expect(screen.queryByText("Скачана · Выбрана")).toBeNull();
});
