import * as FileSystem from "expo-file-system/legacy";
import { createVideoPlayer } from "expo-video";
import { ImageManipulator } from "expo-image-manipulator";
import { extractMedia, parseProviderTimeSegments } from "../extract";
import { getWhisperStatus, transcribeAudioFile } from "../whisper";
import { recognizeRussianPhoto, recognizeRussianPdf } from "../russian-ocr";
import { defaultDirectPreferences } from "../../direct-agent/settings";
jest.mock("expo-file-system/legacy", () => ({ getInfoAsync: jest.fn(), readAsStringAsync: jest.fn(), deleteAsync: jest.fn(), EncodingType: { Base64: "base64" } }));
jest.mock("expo-video", () => ({ createVideoPlayer: jest.fn() }));
jest.mock("../video-audio", () => ({ videoAudio: jest.fn(async () => { throw new Error("Нет звуковой дорожки"); }) }));
jest.mock("../whisper", () => ({ getWhisperStatus: jest.fn(() => ({ state: "absent" })), transcribeAudioFile: jest.fn() }));
jest.mock("../russian-ocr", () => ({ recognizeRussianPhoto: jest.fn(), recognizeRussianPdf: jest.fn() }));
jest.mock("expo-image-manipulator", () => ({ ImageManipulator: { manipulate: jest.fn() }, SaveFormat: { JPEG: "jpeg" } }));
const mockPlayer = { muted: false, release: jest.fn(), generateThumbnailsAsync: jest.fn(), replaceAsync: jest.fn(),
  listeners: {} as Record<string, (e: any) => void>,
  addListener(name: string, fn: (e: any) => void) { this.listeners[name] = fn; return { remove() {} }; } };
const settings = { ...defaultDirectPreferences, apiKey: "secret", webSearchKey: "" };
beforeEach(() => {
  jest.clearAllMocks();
  (FileSystem.getInfoAsync as jest.Mock).mockResolvedValue({ exists: true, isDirectory: false, size: 1000 });
  (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue("dGVzdA==");
  (createVideoPlayer as jest.Mock).mockReturnValue(mockPlayer);
  mockPlayer.replaceAsync.mockImplementation(async () => { mockPlayer.listeners.sourceLoad({ duration: 100 }); });
  mockPlayer.generateThumbnailsAsync.mockImplementation(async (times: number[]) => times.map(t => ({ requestedTime: t })));
  (ImageManipulator.manipulate as jest.Mock).mockImplementation((thumb: { requestedTime: number }) => ({
    renderAsync: async () => ({ saveAsync: async () => ({ uri: "file:///cache/frame-" + thumb.requestedTime + ".jpg", base64: "ZnJhbWU=" }) }) }));
});
test("unapproved images, audio and video never reach a provider", async () => {
  const transport = jest.fn();
  for (const [name, mimeType] of [["image.png", "image/png"], ["audio.mp3", "audio/mpeg"], ["video.mp4", "video/mp4"]]) {
    await expect(extractMedia({ uri: "file:///cache/" + name, name, mimeType }, settings, false, undefined, transport as unknown as typeof fetch)).rejects.toThrow(name === "audio.mp3" ? "Локальный Whisper" : "Разрешите");
  }
  expect(transport).not.toHaveBeenCalled(); expect(createVideoPlayer).not.toHaveBeenCalled();
});
test("text imports stay on-device and reject truncation", async () => {
  (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue("Мой рецепт"); const transport = jest.fn();
  expect(await extractMedia({ uri: "file:///cache/note.txt", name: "note.txt" }, settings, false, undefined, transport as unknown as typeof fetch)).toBe("Мой рецепт");
  expect(transport).not.toHaveBeenCalled();
  (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue("a".repeat(60_001));
  await expect(extractMedia({ uri: "file:///cache/note.txt", name: "note.txt" }, settings, false, undefined, transport as unknown as typeof fetch)).rejects.toThrow("Разделите");
});
test("images use the chosen vision protocol with no conversation store", async () => {
  const transport = jest.fn(async (..._args: any[]) => ({ ok: true, json: async () => ({ output_text: "Распознанный рецепт" }) }));
  const text = await extractMedia({ uri: "file:///cache/photo.png", name: "photo.png", mimeType: "image/png" }, settings, true, undefined, transport as unknown as typeof fetch);
  expect(text).toBe("Распознанный рецепт");
  const payload = JSON.parse(transport.mock.calls[0][1].body);
  expect(payload.store).toBe(false); expect(payload.input[0].content[1].image_url).toContain("data:image/png;base64,");
});
test("video samples across its duration and removes every extracted frame after failure", async () => {
  const transport = jest.fn(async () => ({ ok: false, status: 400 }));
  await expect(extractMedia({ uri: "file:///cache/video.mp4", name: "video.mp4", duration: 100_000 }, settings, true, undefined, transport as unknown as typeof fetch)).rejects.toThrow("HTTP 400");
  expect(mockPlayer.generateThumbnailsAsync.mock.calls[0][0]).toEqual([2, 25, 50, 75, 97]);
  expect(FileSystem.deleteAsync).toHaveBeenCalledTimes(5);
  expect(mockPlayer.release).toHaveBeenCalledTimes(2);
});
test("provider errors cannot expose an echoed key and cancellation prevents egress", async () => {
  const transport = jest.fn(async () => ({ ok: false, status: 401, text: async () => "secret" }));
  await expect(extractMedia({ uri: "file:///cache/photo.png", name: "photo.png" }, settings, true, undefined, transport as unknown as typeof fetch)).rejects.not.toThrow("secret");
  const aborter = new AbortController(); aborter.abort(); transport.mockClear();
  await expect(extractMedia({ uri: "file:///cache/photo.png", name: "photo.png" }, settings, true, aborter.signal, transport as unknown as typeof fetch)).rejects.toThrow("остановлен");
  expect(transport).not.toHaveBeenCalled();
});

test("with Whisper downloaded, audio is transcribed on the phone without approval and nothing is sent", async () => {
  (getWhisperStatus as jest.Mock).mockReturnValueOnce({ state: "ready", id: "base" });
  (transcribeAudioFile as jest.Mock).mockResolvedValueOnce("Купить молоко");
  const transport = jest.fn();
  expect(await extractMedia({ uri: "file:///cache/voice.m4a", name: "voice.m4a", mimeType: "audio/mp4" }, settings, false, undefined, transport as unknown as typeof fetch)).toBe("Купить молоко");
  expect(transport).not.toHaveBeenCalled();
});
test("unsupported online DeepSeek host is rejected before audio upload", async () => {
  const transport = jest.fn();
  const selected = { ...settings, provider: "openai-compatible" as const, baseUrl: "https://api.deepseek.com", fileAsrMode: "online" as const };
  await expect(extractMedia({ uri: "file:///cache/voice.m4a", name: "voice.m4a" }, selected, true, undefined, transport as unknown as typeof fetch, selected))
    .rejects.toThrow("не подтверждает распознавание");
  expect(transport).not.toHaveBeenCalled();
});

test("video retains visual result when audio fails and labels missing speech", async () => {
  const transport = jest.fn(async () => ({ ok: true, json: async () => ({ output_text: "На кадре рецепт" }) }));
  const text = await extractMedia({ uri: "file:///clip.mp4", name: "clip.mp4" }, settings, true, undefined, transport as unknown as typeof fetch);
  expect(text).toContain("Речь не распознана"); expect(text).toContain("На кадре рецепт");
  expect(text).toContain("выборочных кадров");
});

test("official Whisper-1 requests real segment timestamps in one approved upload", async () => {
  const segments = [
    { start: 0, end: 1.23, text: "Привет" },
    { start: 1.23, end: 3.5, text: "Как дела?" },
  ];
  const transport = jest.fn(async (..._args:any[]) => ({ok:true,json:async()=>({
    text:"Привет Как дела?",duration:3.5,segments,
  })}));
  const captured=jest.fn();
  const text=await extractMedia({uri:"file:///cache/audio.mp3",name:"audio.mp3",mimeType:"audio/mpeg"},
    { ...settings, provider:"openai",baseUrl:"https://api.openai.com/v1",transcriptionModel:"whisper-1" },
    true,undefined,transport as unknown as typeof fetch,
      {...settings,transcriptionModel:"whisper-1",fileAsrMode:"online"},captured);
  expect(text).toBe("Привет Как дела?");
  expect(captured).toHaveBeenCalledTimes(1);
  expect(captured).toHaveBeenCalledWith([
    {text:"Привет",location:{kind:"time",startMs:0,endMs:1230}},
    {text:"Как дела?",location:{kind:"time",startMs:1230,endMs:3500}},
  ]);
  expect(transport).toHaveBeenCalledTimes(1);
  const request = transport.mock.calls[0][1] as any;
  expect(request.method).toBe("POST");
  // FormData is intentionally opaque to JSON.stringify in RN/Jest.
  const form = request.body as {
    get?: (key:string)=>unknown;
    getParts?: ()=>Array<{fieldName:string;string?:string}>;
  };
  const field = (key:string)=>form.get?.(key) ?? form.getParts?.().find(part=>part.fieldName===key)?.string;
  expect(field("response_format")).toBe("verbose_json");
  expect(field("timestamp_granularities[]")).toBe("segment");
});

test("broken vendor time positions are never passed to memory, but full plain text survives",async()=>{
  const transport=jest.fn(async (..._args:any[])=>({ok:true,json:async()=>({
    text:"Слова остаются",duration:3,segments:[
      {start:0,end:1,text:"Слова"},
      {start:-3,end:2,text:"остаются"},
    ],
  })}));
  const captured=jest.fn();
  expect(await extractMedia({uri:"file:///cache/audio.mp3",name:"audio.mp3"},
    {...settings,provider:"openai",baseUrl:"https://api.openai.com/v1",transcriptionModel:"whisper-1"},
    true,undefined,transport as unknown as typeof fetch,
      {...settings,transcriptionModel:"whisper-1",fileAsrMode:"online"},captured)).toBe("Слова остаются");
  expect(captured).not.toHaveBeenCalled();
  expect(parseProviderTimeSegments([{start:0,end:0.1,text:"A"},{start:0.05,end:1,text:"B"}])).toBeNull();
  expect(parseProviderTimeSegments([{start:0,end:1,text:"A"}],0.2)).toBeNull();
  expect(parseProviderTimeSegments([{start:0,end:NaN,text:"A"}])).toBeNull();
  expect(parseProviderTimeSegments([{start:0,end:1,text:"A"},{start:1,end:2,text:"B"}])).toHaveLength(2);
});

test("unknown OpenAI-compatible host cannot receive a file without documented capability", async()=>{
  const transport=jest.fn();
  const custom={...settings,provider:"openai-compatible" as const,baseUrl:"https://api.example.org/v1",fileAsrMode:"online" as const};
  await expect(extractMedia({uri:"file:///cache/audio.mp3",name:"audio.mp3"},
    custom,true,undefined,transport as unknown as typeof fetch,custom)).rejects.toThrow("не подтверждает распознавание");
  expect(transport).not.toHaveBeenCalled();
});

test("explicit OpenAI online overrides already installed Whisper; no guessed timestamps",async()=>{
  (getWhisperStatus as jest.Mock).mockReturnValue({state:"ready",id:"base"});
  const transport=jest.fn(async()=>({ok:true,json:async()=>({text:"Онлайн запись"})}));
  const online={...settings,fileAsrMode:"online" as const};
  const segments=jest.fn();
  expect(await extractMedia({uri:"file:///cache/voice.m4a",name:"voice.m4a"},
    settings,true,undefined,transport as unknown as typeof fetch,online,segments)).toBe("Онлайн запись");
  expect(transcribeAudioFile).not.toHaveBeenCalled();
  expect(transport).toHaveBeenCalledTimes(1);
  expect(segments).not.toHaveBeenCalled();
  const form=(transport.mock.calls[0][1] as any).body;
  const model=form.get?.("model") ?? form.getParts?.().find((p:any)=>p.fieldName==="model")?.string;
  expect(model).toBe("gpt-transcribe");
});

test("online audio never uploads without consent, key, or recognized model",async()=>{
  const transport=jest.fn();
  const online={...settings,fileAsrMode:"online" as const};
  const audio={uri:"file:///cache/voice.m4a",name:"voice.m4a"};
  await expect(extractMedia(audio,settings,false,undefined,transport as unknown as typeof fetch,online)).rejects.toThrow("Разрешите");
  await expect(extractMedia(audio,settings,true,undefined,transport as unknown as typeof fetch,{...online,apiKey:""})).rejects.toThrow("ключ");
  await expect(extractMedia(audio,settings,true,undefined,transport as unknown as typeof fetch,{...online,transcriptionModel:"gpt-4.1-mini"})).rejects.toThrow("не предназначена");
  expect(transport).not.toHaveBeenCalled();
});


test("step 8 E photo text mode is an explicit approved provider request, not automatic OCR",async()=>{
  const transport=jest.fn(async()=>({ok:true,json:async()=>({output_text:"Квитанция\nИтого: 125,50 ₽"})}));
  const photo={uri:"file:///cache/receipt.png",name:"receipt.png",mimeType:"image/png"};
  await expect(extractMedia(photo,settings,false,undefined,transport as unknown as typeof fetch,undefined,undefined,undefined,"document-text")).rejects.toThrow("Разрешите передачу");
  expect(transport).not.toHaveBeenCalled();
  const text=await extractMedia(photo,settings,true,undefined,transport as unknown as typeof fetch,undefined,undefined,undefined,"document-text");
  expect(text).toBe("Квитанция\nИтого: 125,50 ₽");
  const payload=JSON.parse((transport as jest.Mock).mock.calls[0][1].body);
  expect(payload.store).toBe(false);
  expect(payload.input[0].content[0].text).toMatch(/дословно.*русский/);
  expect(payload.input[0].content[0].text).toMatch(/не додумывай неразборчивые/i);
  expect(payload.input[0].content[1].detail).toBe("high");
  expect(transport).toHaveBeenCalledTimes(1);
});
test("step 8 E default photo analysis stays unchanged and low-detail",async()=>{
  const transport=jest.fn(async()=>({ok:true,json:async()=>({output_text:"На фото коробка"})}));
  await extractMedia({uri:"file:///cache/photo.png",name:"photo.png",mimeType:"image/png"},settings,true,undefined,transport as unknown as typeof fetch);
  const payload=JSON.parse((transport as jest.Mock).mock.calls[0][1].body);
  expect(payload.input[0].content[0].text).toMatch(/Описание изображения/);
  expect(payload.input[0].content[1].detail).toBe("low");
});
test("step 8 E unreadable photo and overlong provider response never become a fabricated/truncated transcript",async()=>{
  const photo={uri:"file:///cache/scan.png",name:"scan.png",mimeType:"image/png"};
  const unreadable=jest.fn(async()=>({ok:true,json:async()=>({output_text:"НЕРАЗБОРЧИВО"})}));
  await expect(extractMedia(photo,settings,true,undefined,unreadable as unknown as typeof fetch,undefined,undefined,undefined,"document-text")).rejects.toThrow("не смогла прочитать");
  const long=jest.fn(async()=>({ok:true,json:async()=>({output_text:"A".repeat(60_001)})}));
  await expect(extractMedia(photo,settings,true,undefined,long as unknown as typeof fetch,undefined,undefined,undefined,"document-text")).rejects.toThrow("60 000");
});
test("step 8 E cancellation prevents paid image upload and preserves local-only fallback",async()=>{
  const photo={uri:"file:///cache/photo.png",name:"photo.png",mimeType:"image/png"};
  const aborted=new AbortController(); aborted.abort();
  const transport=jest.fn();
  await expect(extractMedia(photo,settings,true,aborted.signal,transport as unknown as typeof fetch,undefined,undefined,undefined,"document-text")).rejects.toThrow("остановлен");
  expect(transport).not.toHaveBeenCalled();
});


test("step 8 E2b: offline Russian OCR of a personal photo calls no external provider",async()=>{
  (recognizeRussianPhoto as jest.Mock).mockResolvedValueOnce("Продукт: 200 г");
  const provider=jest.fn();
  const text=await extractMedia({uri:"file:///cache/photo.png",name:"photo.png",mimeType:"image/png"},
    settings,false,undefined,provider as unknown as typeof fetch,undefined,undefined,undefined,"offline-ocr");
  expect(text).toBe("Продукт: 200 г");
  expect(recognizeRussianPhoto).toHaveBeenCalledTimes(1);
  expect(provider).not.toHaveBeenCalled();
});
test("step 8 E2b: offline Russian PDF OCR passes real page evidence without provider access",async()=>{
  const coverage={totalPageCount:3,extractedPageCount:2,missingPages:[2],coverage:"partial"};
  const pages={...coverage,text:"Страница 1:\\nЛимон\\n\\nСтраница 3:\\nмёд",
    segments:[{text:"Лимон",location:{kind:"page",page:1}},{text:"мёд",location:{kind:"page",page:3}}]};
  (recognizeRussianPdf as jest.Mock).mockResolvedValueOnce(pages);
  const provider=jest.fn(), segments=jest.fn(), notified=jest.fn();
  expect(await extractMedia({uri:"file:///cache/scanned.pdf",name:"scanned.pdf",mimeType:"application/pdf"},
    settings,false,undefined,provider as unknown as typeof fetch,undefined,segments,notified,"offline-ocr")).toContain("Лимон");
  expect(segments).toHaveBeenCalledWith(pages.segments);
  expect(notified).toHaveBeenCalledWith(pages);
  expect(provider).not.toHaveBeenCalled();
});
