import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { ChatAttachmentList } from "../ChatAttachmentList";
jest.mock("../../theme",()=>({useTheme:()=>({
  text:"#fff",secondary:"#52dfef",accent:"#a49bff",soft:"#252a4f",panel:"#151b36",
})}));
const file:any={id:"photo",name:"red-bike-standing-near-tree-park-sunset-time-red-bike-test-long.jpg",
  mime:"image/jpeg",kind:"image",data:"/9j/2Q==",size:4};
test("sent image is a bounded card without a giant empty Android ScrollView",()=>{
  const screen=render(<ChatAttachmentList files={[file]}/>);
  const scroller=screen.getByLabelText("Вложения сообщения");
  expect(scroller.props.style).toEqual(expect.objectContaining({height:146,flexGrow:0,flexShrink:0}));
  expect(screen.getByText("Фотография 1")).toBeTruthy();
  expect(screen.queryByText(file.name)).toBeNull();
  expect(screen.getByLabelText("Изображение "+file.name).props.style.height).toBe(110);
});
test("draft image actions stay accessible and do not stretch the message",()=>{
  const onRemove=jest.fn(),onSelectImage=jest.fn();
  const screen=render(<ChatAttachmentList files={[file]} onRemove={onRemove}
    onSelectImage={onSelectImage} selectedImageId={file.id}/>);
  expect(screen.getByLabelText("Вложения сообщения").props.style.height).toBe(170);
  fireEvent.press(screen.getByLabelText("Выбрать фото "+file.name));
  expect(onSelectImage).toHaveBeenCalledWith("photo");
  fireEvent.press(screen.getByLabelText("Убрать вложение "+file.name));
  expect(onRemove).toHaveBeenCalledWith("photo");
});
