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
  expect(screen.getByLabelText("Вложения сообщения").props.style.height).toBe(198);
  fireEvent.press(screen.getByLabelText("Выбрать фото "+file.name));
  expect(onSelectImage).toHaveBeenCalledWith("photo");
  fireEvent.press(screen.getByLabelText("Убрать вложение "+file.name));
  expect(onRemove).toHaveBeenCalledWith("photo");
});

test("H1: PDF attachment is visibly labeled as extracted text, not an original PDF upload",()=>{
  const pdf:any={id:"pdf",name:"Текст PDF: report.pdf",kind:"text",mime:"text/plain",
    data:"Извлечённые страницы",size:55};
  const screen=render(<ChatAttachmentList files={[pdf]} onRemove={jest.fn()}/>);
  expect(screen.getByText("Текст PDF: report.pdf")).toBeTruthy();
  expect(screen.getByText(/Только текст PDF/)).toBeTruthy();
  expect(screen.getByLabelText("Убрать вложение Текст PDF: report.pdf")).toBeTruthy();
});

test("H3b: a transcript card explains that only text, not original audio, is sent",()=>{
  const audio:any={id:'a1',name:'Транскрипт аудио: lecture.mp3',kind:'text',
    mime:'text/plain',data:'Локальная расшифровка Whisper. Текст записи',size:300};
  const screen=render(<ChatAttachmentList files={[audio]} onRemove={jest.fn()}/>);
  expect(screen.getByText(/Текст Whisper/)).toBeTruthy();
  expect(screen.getByText(/аудио не отправится/)).toBeTruthy();
  expect(screen.getByLabelText('Убрать вложение Транскрипт аудио: lecture.mp3')).toBeTruthy();
});

test("draft text attachment is compact, with a visible 48dp Nebula remove button", () => {
  const note:any={id:"text-1",name:"note.txt",kind:"text",mime:"text/plain",data:"hello",size:5};
  const remove=jest.fn();
  const screen=render(<ChatAttachmentList files={[note]} onRemove={remove}/>);
  expect(screen.getByLabelText("Вложения сообщения").props.style.height).toBe(90);
  const action=screen.getByLabelText("Убрать вложение note.txt");
  const style=typeof action.props.style==="function" ? action.props.style({pressed:false}) : action.props.style;
  expect(style.minHeight).toBeGreaterThanOrEqual(48);
  expect(style.borderWidth).toBe(1);
  expect(style.backgroundColor).toBeTruthy();
  fireEvent.press(action);
  expect(remove).toHaveBeenCalledWith("text-1");
});

test("mixed photo and text attachments reserve room for both contextual buttons", () => {
  const search=jest.fn(), remove=jest.fn();
  const note:any={id:"text-1",name:"note.txt",kind:"text",mime:"text/plain",data:"hello",size:5};
  const screen=render(<ChatAttachmentList files={[file,note]} onSearch={search} onRemove={remove}/>);
  expect(screen.getByLabelText("Вложения сообщения").props.style.height).toBe(250);
  fireEvent.press(screen.getByLabelText("Найти похожие в памяти по фото "+file.name));
  fireEvent.press(screen.getByLabelText("Убрать вложение "+note.name));
  expect(search).toHaveBeenCalledWith(file);
  expect(remove).toHaveBeenCalledWith("text-1");
});
