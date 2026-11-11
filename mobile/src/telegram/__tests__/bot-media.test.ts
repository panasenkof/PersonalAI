import {prepareBotOriginal} from "../bot-media";
import {getTelegramBotFile} from "../bot-api";
jest.mock("../bot-api",()=>({
  getTelegramBotFile:jest.fn(),TELEGRAM_BOT_MAX_FILE_BYTES:20_000_000,
}));
const mockDeleted=jest.fn();
const mockDownload=jest.fn();
let mockSize=4096;
jest.mock("expo-crypto",()=>({randomUUID:()=> "test-file-uuid"}));
jest.mock("expo-file-system",()=>({
  Paths:{cache:"file:///cache"},
  Directory:class {
    uri:string;
    constructor(...values:any[]){this.uri=values.map(x=>x.uri||x).join("/");}
    create(){}
  },
  File:class {
    uri:string;
    static downloadFileAsync(...args:any[]){return mockDownload(...args);}
    constructor(...values:any[]){this.uri=values.map(x=>x.uri||x).join("/");}
    get size(){return mockSize;}
    get exists(){return true;}
    delete(){mockDeleted();}
  },
}));
const token="12345678:"+"a".repeat(35);
const msg=(payload:Record<string,unknown>)=>({
  message_id:11,chat:{id:12345,type:"private"},...payload,
});
beforeEach(()=>{
  jest.clearAllMocks();
  mockSize=4096;
  (getTelegramBotFile as jest.Mock).mockResolvedValue({path:"photos/file_0.jpg",size:4096});
  mockDownload.mockImplementation(async(_url:string,file:unknown)=>file);
});
test("downloads the largest photo original into private cache, preserving caption outside the file",async()=>{
  const original=await prepareBotOriginal(token,msg({
    caption:"Тест подписи",photo:[
      {file_id:"AgACsmall123",file_size:200},
      {file_id:"AgACbig12345",file_size:4096},
    ],
  }));
  expect(getTelegramBotFile).toHaveBeenCalledWith(token,"AgACbig12345",undefined);
  expect(original?.file).toMatchObject({name:"photo.jpg",mimeType:"image/jpeg",size:4096});
  expect(original?.file.uri).toContain("persai-incoming/test-file-uuid");
  expect(original?.file.uri).not.toContain(token);
  expect(mockDownload).toHaveBeenCalledTimes(1);
  original?.remove();
  expect(mockDeleted).toHaveBeenCalledTimes(1);
});
test("album cannot be acknowledged as a complete original",async()=>{
  await expect(prepareBotOriginal(token,msg({
    media_group_id:"group_1",photo:[{file_id:"AgACbig12345"}],
  }))).rejects.toThrow("альбом");
  expect(getTelegramBotFile).not.toHaveBeenCalled();
});
test("rejects unsupported file type before requesting remote file",async()=>{
  await expect(prepareBotOriginal(token,msg({
    document:{file_id:"BQACfile123",file_name:"secret.zip",mime_type:"application/zip"},
  }))).rejects.toThrow("Выберите изображение");
  expect(getTelegramBotFile).not.toHaveBeenCalled();
});
test("native download failures cannot expose Bot API URLs or tokens",async()=>{
  mockDownload.mockRejectedValue(new Error("https://api.telegram.org/file/bot"+token+"/photos/file_0.jpg"));
  const pending=prepareBotOriginal(token,msg({photo:[{file_id:"AgACbig12345"}]}));
  await expect(pending).rejects.toThrow("Не удалось скачать оригинал");
  await expect(pending).rejects.not.toThrow(token);
  expect(mockDeleted).toHaveBeenCalledTimes(1);
});
test("size mismatch is rejected and temporary file is discarded",async()=>{
  mockSize=1234;
  await expect(prepareBotOriginal(token,msg({photo:[{file_id:"AgACbig12345"}]})))
    .rejects.toThrow("Размер скачанного");
  expect(mockDeleted).toHaveBeenCalledTimes(1);
});

test("only the explicit batch path can stage Telegram album media",async()=>{
  const item=msg({media_group_id:"albumA",photo:[{file_id:"AgACbig12345"}]});
  await expect(prepareBotOriginal(token,item)).rejects.toThrow("альбом");
  const staged=await prepareBotOriginal(token,item,undefined,true);
  expect(staged?.file).toMatchObject({name:"photo.jpg",size:4096});
  staged?.remove();
  expect(mockDeleted).toHaveBeenCalledTimes(1);
});
