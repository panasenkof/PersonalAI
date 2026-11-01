import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { PhotoResultsSettings } from "../PhotoResultsSettings";
import { loadPhotoResultCount, savePhotoResultCount } from "../../media/photo-result-preferences";

jest.mock("../../profile/ProfileContext",()=>({useProfile:()=>"guest"}));
jest.mock("../../theme",()=>({useTheme:()=>({
  text:"#fff",muted:"#aaa",panel:"#192039",line:"#456",secondary:"#52dfef",
  accent:"#a49bff",err:"#f66",ok:"#5e7",
})}));
jest.mock("../Collapsible",()=>({Collapsible:({children,summary}:any)=>{
  const {View,Text}=require("react-native");return <View><Text>{summary}</Text>{children}</View>;
}}));
jest.mock("../../media/photo-result-preferences",()=>({
  DEFAULT_PHOTO_RESULT_COUNT:6,MAX_PHOTO_RESULT_COUNT:20,
  loadPhotoResultCount:jest.fn(),savePhotoResultCount:jest.fn(),
}));
const load=loadPhotoResultCount as jest.Mock,save=savePhotoResultCount as jest.Mock;
beforeEach(()=>{jest.resetAllMocks();load.mockResolvedValue(6);save.mockResolvedValue(undefined);});
test("model-style minus/number/plus replaces photo result chips and saves the chosen value",async()=>{
  const view=render(<PhotoResultsSettings/>);
  await waitFor(()=>expect(view.getByText("Показывать до 6 фото")).toBeTruthy());
  fireEvent.press(view.getByLabelText("Увеличить количество найденных фотографий"));
  expect(view.getByLabelText("Максимум найденных фотографий").props.value).toBe("7");
  fireEvent.press(view.getByLabelText("Сохранить количество найденных фотографий"));
  await waitFor(()=>expect(save).toHaveBeenCalledWith("guest",7));
  expect(view.getByText("Показывать до 7 фото")).toBeTruthy();
  fireEvent.press(view.getByLabelText("Уменьшить количество найденных фотографий"));
  expect(view.getByLabelText("Максимум найденных фотографий").props.value).toBe("6");
});
test("the stepper stops at 1 and 20 and rejects invalid manual input",async()=>{
  load.mockResolvedValueOnce(20);
  const view=render(<PhotoResultsSettings/>);
  await waitFor(()=>expect(view.getByText("Показывать до 20 фото")).toBeTruthy());
  expect(view.getByLabelText("Увеличить количество найденных фотографий").props.accessibilityState.disabled).toBe(true);
  fireEvent.changeText(view.getByLabelText("Максимум найденных фотографий"),"21");
  fireEvent.press(view.getByLabelText("Сохранить количество найденных фотографий"));
  expect(view.getByText("Введите число от 1 до 20.")).toBeTruthy();
  expect(save).not.toHaveBeenCalled();
});
