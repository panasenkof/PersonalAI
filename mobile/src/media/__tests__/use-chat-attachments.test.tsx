import React from "react";
import { Pressable, Text } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { useChatAttachments } from "../useChatAttachments";
import { pickChatAttachmentsWithResults } from "../pickChatAttachments";
import type { ChatAttachment } from "../../direct-agent/chat-attachments";

jest.mock("../pickChatAttachments",()=>({pickChatAttachmentsWithResults:jest.fn()}));
jest.mock("../../local-memory/storage",()=>({onLocalMemorySessionChange:()=>()=>{}}));
const textFile=(id:string,count:number):ChatAttachment=>({
  id,name:id+".txt",kind:"text",mime:"text/plain",data:"т".repeat(count),size:count*3,
});
function mountWith(initial:ChatAttachment[]){
  const setAttachments=jest.fn();
  const onError=jest.fn();
  const state={activeId:"chat1",conversations:[{id:"chat1",attachments:initial}]};
  const store={getSnapshot:()=>state,setAttachments};
  function Picker(){
    const {pick,failedFiles,dismissFailure}=useChatAttachments(store as any,"chat1",true,onError);
    return <>
      <Pressable accessibilityRole="button" accessibilityLabel="Выбрать файлы" onPress={()=>void pick()}><Text>Файлы</Text></Pressable>
      <Text accessibilityLabel="Ошибки отдельных файлов">{failedFiles.map(f=>f.name+": "+f.reason).join("\\n")}</Text>
      {failedFiles.map((f,i)=><Pressable key={i} accessibilityLabel={"Убрать ошибку "+f.name}
        onPress={()=>dismissFailure(i)}><Text>Убрать</Text></Pressable>)}
    </>;
  }
  const ui=render(<Picker/>);
  return {ui,setAttachments,onError};
}

beforeEach(()=>jest.clearAllMocks());

test("H2: earlier draft is preserved and per-item aggregate text overflow does not discard later fitting file",async()=>{
  const initial=[textFile("old",200_000)];
  (pickChatAttachmentsWithResults as jest.Mock).mockResolvedValue({
    files:[textFile("too-big",50_000),textFile("fits",1_000)],failures:[],
  });
  const {ui,setAttachments,onError}=mountWith(initial);
  await act(async()=>{fireEvent.press(ui.getByLabelText("Выбрать файлы"));});
  expect(setAttachments).toHaveBeenCalledWith("chat1",[initial[0],expect.objectContaining({id:"fits"})]);
  expect(ui.getByLabelText("Ошибки отдельных файлов").props.children).toContain("too-big");
  expect(onError).toHaveBeenLastCalledWith("");
});

test("H2: existing two files consume two slots, while parser failures are shown without aborting valid item",async()=>{
  const initial=[textFile("old1",12),textFile("old2",12)];
  (pickChatAttachmentsWithResults as jest.Mock).mockResolvedValue({
    files:[textFile("ok",12),textFile("over-capacity",12)],
    failures:[{name:"damaged.pdf",reason:"Файл не является настоящим PDF."}],
  });
  const {ui,setAttachments,onError}=mountWith(initial);
  await act(async()=>{fireEvent.press(ui.getByLabelText("Выбрать файлы"));});
  expect(setAttachments).toHaveBeenCalledWith("chat1",[...initial,expect.objectContaining({id:"ok"})]);
  const message=ui.getByLabelText("Ошибки отдельных файлов").props.children;
  expect(message).toContain("damaged.pdf");
  expect(message).toContain("over-capacity");
  expect(onError).toHaveBeenLastCalledWith("");
  fireEvent.press(ui.getByLabelText("Убрать ошибку damaged.pdf"));
  expect(ui.getByLabelText("Ошибки отдельных файлов").props.children).not.toContain("damaged.pdf");
  expect(setAttachments).toHaveBeenCalledTimes(1);
});

test("H2: no new files after picker cancellation never modifies an existing draft",async()=>{
  (pickChatAttachmentsWithResults as jest.Mock).mockResolvedValue({files:[],failures:[]});
  const {ui,setAttachments}=mountWith([textFile("old",10)]);
  await act(async()=>{fireEvent.press(ui.getByLabelText("Выбрать файлы"));});
  expect(setAttachments).not.toHaveBeenCalled();
});

test("H3b: cancel while local Whisper is preparing prevents committing a late transcript",async()=>{
  const setAttachments=jest.fn(),onError=jest.fn();
  const state={activeId:"chat1",conversations:[{id:"chat1",attachments:[]}]};
  const store={getSnapshot:()=>state,setAttachments};
  let resume!:(files:any)=>void;
  (pickChatAttachmentsWithResults as jest.Mock).mockImplementation(async(signal:AbortSignal,onAudioPreparing:()=>void)=>{
    onAudioPreparing();
    await new Promise(resolve=>{resume=resolve;});
    if(signal.aborted)throw new Error("Выбор файлов прерван.");
    return {files:[textFile("late",16)],failures:[]};
  });
  function Picker(){
    const {pick,cancel,audioPreparing}=useChatAttachments(store as any,"chat1",true,onError);
    return <>
      <Pressable accessibilityLabel="Select" onPress={()=>void pick()}><Text>Select</Text></Pressable>
      {audioPreparing?<Pressable accessibilityLabel="Cancel ASR" onPress={cancel}><Text>Cancel</Text></Pressable>:null}
    </>;
  }
  const ui=render(<Picker/>);
  await act(async()=>{fireEvent.press(ui.getByLabelText("Select"));});
  expect(ui.getByLabelText("Cancel ASR")).toBeTruthy();
  fireEvent.press(ui.getByLabelText("Cancel ASR"));
  await act(async()=>resume(null));
  expect(setAttachments).not.toHaveBeenCalled();
});

test("H4: temporary file errors are not retained in a different chat or after focus loss",async()=>{
  const setAttachments=jest.fn(),onError=jest.fn();
  const state={activeId:"chat1",conversations:[{id:"chat1",attachments:[]},{id:"chat2",attachments:[]}]};
  const store={getSnapshot:()=>state,setAttachments};
  function Picker({id,focused}:{id:string;focused:boolean}){
    const {pick,failedFiles}=useChatAttachments(store as any,id,focused,onError);
    return <>
      <Pressable accessibilityLabel="Выбрать файлы" onPress={()=>void pick()}><Text>Выбрать</Text></Pressable>
      <Text accessibilityLabel="Ошибки файлов">{failedFiles.map(f=>f.name).join(",")}</Text>
    </>;
  }
  (pickChatAttachmentsWithResults as jest.Mock).mockResolvedValue({
    files:[],failures:[{name:"broken.pdf",reason:"Нет текста PDF"}],
  });
  const screen=render(<Picker id="chat1" focused={true}/>);
  await act(async()=>fireEvent.press(screen.getByLabelText("Выбрать файлы")));
  expect(screen.getByLabelText("Ошибки файлов").props.children).toBe("broken.pdf");
  screen.rerender(<Picker id="chat2" focused={true}/>);
  expect(screen.getByLabelText("Ошибки файлов").props.children).toBe("");
  state.activeId="chat2";
  await act(async()=>fireEvent.press(screen.getByLabelText("Выбрать файлы")));
  expect(screen.getByLabelText("Ошибки файлов").props.children).toBe("broken.pdf");
  screen.rerender(<Picker id="chat2" focused={false}/>);
  expect(screen.getByLabelText("Ошибки файлов").props.children).toBe("");
});
