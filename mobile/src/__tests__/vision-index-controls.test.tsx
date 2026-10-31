import React from "react";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { VisionIndexControls } from "../components/VisionIndexControls";
import { indexPhotoPage83 } from "../media/vision-index-pages";

jest.mock("../profile/ProfileContext", () => ({ useProfile: () => "guest" }));
jest.mock("../theme", () => ({ useTheme: () => ({
  text:"#fafafa",muted:"#aabbcc",panel:"#12203f",line:"#456",
  secondary:"#19c4dd",err:"#ff8888",
}) }));
jest.mock("../local-memory/storage", () => ({
  onLocalMemorySessionChange: (_fn:unknown) => () => {},
}));
jest.mock("../media/vision-index-pages", () => ({indexPhotoPage83:jest.fn()}));
const page=indexPhotoPage83 as jest.Mock;
beforeEach(()=>{jest.clearAllMocks();page.mockResolvedValue({
  modelSpace:"eg2|vision|768|sha256:"+"a".repeat(64),
  nextCursor:"att-01",hasMore:false,examined:1,alreadyCurrent:0,
  indexed:1,sourceChanged:0,failed:0,halted:"none",
});});
test("index is opt-in, runs in same profile and reports results, not on mount",async()=>{
 const v=render(<VisionIndexControls activeModel />);
 expect(page).not.toHaveBeenCalled();
 fireEvent.press(v.getByLabelText("Индексировать фотографии"));
 await waitFor(()=>expect(v.getByText(/Проверено: 1 · Новых: 1/)).toBeTruthy());
 expect(page).toHaveBeenCalledWith("guest",expect.objectContaining({
   afterId:"",limit:2,signal:expect.any(Object),
 }));
});
test("no active model disables a pass and never touches user memory",()=>{
 const v=render(<VisionIndexControls activeModel={false} />);
 expect(v.getByLabelText("Индексировать фотографии").props.accessibilityState.disabled).toBe(true);
 fireEvent.press(v.getByLabelText("Индексировать фотографии"));
 expect(page).not.toHaveBeenCalled();
});
test("multi-page index resumes from prior cursor, never starts a second queue",async()=>{
 page.mockResolvedValueOnce({
   modelSpace:"eg2|vision|768|sha256:"+"a".repeat(64),
   nextCursor:"att-01",hasMore:true,examined:1,alreadyCurrent:1,
   indexed:0,sourceChanged:0,failed:0,halted:"none",
 }).mockResolvedValueOnce({
   modelSpace:"eg2|vision|768|sha256:"+"a".repeat(64),
   nextCursor:"att-02",hasMore:false,examined:1,alreadyCurrent:0,
   indexed:1,sourceChanged:0,failed:0,halted:"none",
 });
 const v=render(<VisionIndexControls activeModel />);
 fireEvent.press(v.getByLabelText("Индексировать фотографии"));
 await waitFor(()=>expect(v.getByText(/Проверено: 2 · Новых: 1 · Уже готовы: 1/)).toBeTruthy());
 expect(page).toHaveBeenNthCalledWith(2,"guest",expect.objectContaining({afterId:"att-01"}));
});
