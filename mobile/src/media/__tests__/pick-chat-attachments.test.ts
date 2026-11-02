import { pickChatAttachments, pickChatAttachmentsWithResults, safeChatFileFailure } from '../pickChatAttachments';
import { chatContent } from "../../direct-agent/chat-attachments";
import { extractPdfPages } from "../pdf-pages";
import { getWhisperStatus, initWhisper, transcribeAudioFile } from "../whisper";
import { getDocumentAsync } from 'expo-document-picker';
import { readAsStringAsync } from 'expo-file-system/legacy';
import { manipulateAsync } from 'expo-image-manipulator';
let mockUnlocked=true;let mockSize=100;const mockDelete=jest.fn();
let mockPdfHeader = new Uint8Array([37,80,68,70,45]);
jest.mock('expo-image-manipulator',()=>({manipulateAsync:jest.fn(),SaveFormat:{JPEG:'jpeg'}}));
jest.mock('expo-crypto',()=>({randomUUID:()=> 'file-id'}));
jest.mock('expo-document-picker',()=>({getDocumentAsync:jest.fn()}));
jest.mock('expo-file-system/legacy',()=>({cacheDirectory:'file:///cache/',EncodingType:{Base64:'base64',UTF8:'utf8'},readAsStringAsync:jest.fn()}));
jest.mock('expo-file-system',()=>({
  FileMode:{ReadOnly:'r'},
  File:class {
    uri:string;exists=true;
    constructor(uri:string){this.uri=uri;}
    get size(){return mockSize;}
    delete(){mockDelete(this.uri);}
    open(){return {readBytes:()=>mockPdfHeader,close:jest.fn()};}
  }
}));
jest.mock('../../local-memory/storage',()=>({localMemorySessionUnlocked:()=>mockUnlocked}));
jest.mock('../whisper',()=>({getWhisperStatus:jest.fn(),initWhisper:jest.fn(),transcribeAudioFile:jest.fn()}));
jest.mock('../pdf-pages',()=>({
  extractPdfPages:jest.fn(),
  pdfCoverageMessage:jest.fn(()=> 'Текст PDF: 1 из 1 стр.'),
}));
jest.mock('../../security/native-interaction',()=>({withNativeInteraction:async (work:any)=>work()}));
const asset={uri:'file:///cache/a.txt',name:'a.txt',mimeType:'text/plain',size:100};
beforeEach(()=>{jest.resetAllMocks();mockUnlocked=true;mockSize=100;
  mockPdfHeader=new Uint8Array([37,80,68,70,45]);
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:[asset]});
  (readAsStringAsync as jest.Mock).mockResolvedValue('Text');
  (getWhisperStatus as jest.Mock).mockReturnValue({state:'ready',id:'base'});
  (initWhisper as jest.Mock).mockResolvedValue(undefined);
  (transcribeAudioFile as jest.Mock).mockResolvedValue('Привет, проверь договор.');
  (extractPdfPages as jest.Mock).mockResolvedValue({text:"Страница 1:\\nДоговор",totalPageCount:1,
    extractedPageCount:1,missingPages:[],coverage:"partial",segments:[]});
});
test('stages actual text and removes only picker cache copies',async()=>{const files=await pickChatAttachments(new AbortController().signal);expect(files[0]).toMatchObject({data:'Text',kind:'text',name:'a.txt'});expect(mockDelete).toHaveBeenCalledWith(asset.uri);});
test('cancellation and oversized files never read content',async()=>{(getDocumentAsync as jest.Mock).mockResolvedValueOnce({canceled:true});expect(await pickChatAttachments(new AbortController().signal)).toEqual([]);mockSize=7*1024*1024;await expect(pickChatAttachments(new AbortController().signal)).rejects.toThrow('6 МБ');expect(readAsStringAsync).not.toHaveBeenCalled();expect(mockDelete).toHaveBeenCalledWith(asset.uri);});
test('lock during reading rejects late result and clears the plaintext cache',async()=>{(readAsStringAsync as jest.Mock).mockImplementation(async()=>{mockUnlocked=false;return 'Text';});await expect(pickChatAttachments(new AbortController().signal)).rejects.toThrow('прерван');expect(mockDelete).toHaveBeenCalledWith(asset.uri);});
test('abort while picker open discards its result before reading',async()=>{const controller=new AbortController();(getDocumentAsync as jest.Mock).mockImplementation(async()=>{controller.abort();return {canceled:false,assets:[asset]};});await expect(pickChatAttachments(controller.signal)).rejects.toThrow('прерван');expect(readAsStringAsync).not.toHaveBeenCalled();expect(mockDelete).toHaveBeenCalledWith(asset.uri);});
test('unsupported binary is rejected; non-cache source is not deleted',async()=>{
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:[{uri:'content://provider/document',name:'x.zip',mimeType:'application/zip'}]});
  await expect(pickChatAttachments(new AbortController().signal)).rejects.toThrow('PDF');
  expect(mockDelete).not.toHaveBeenCalled();
});

test('oversized photo is resized locally before any base64 read; both copies are cleaned',async()=>{
  mockSize=7*1024*1024;
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:[{uri:'file:///cache/pic.jpg',name:'pic.jpg',mimeType:'image/jpeg'}]});
  (manipulateAsync as jest.Mock).mockImplementation(async()=>{mockSize=1024;return {uri:'file:///cache/resized.jpg'};});
  (readAsStringAsync as jest.Mock).mockResolvedValue('/9j/2Q==');
  const files=await pickChatAttachments(new AbortController().signal);
  expect(manipulateAsync).toHaveBeenCalledTimes(1);
  expect(files[0]).toMatchObject({mime:'image/jpeg',kind:'image',size:4});
  expect(mockDelete).toHaveBeenCalledWith('file:///cache/resized.jpg');
  expect(mockDelete).toHaveBeenCalledWith('file:///cache/pic.jpg');
});

test("H1: a digital PDF becomes explicitly labeled, untrusted text; original PDF bytes are not sent", async()=>{
  const pdf={uri:"file:///cache/invoice.pdf",name:"invoice.pdf",mimeType:"application/pdf"};
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:[pdf,asset]});
  const files=await pickChatAttachments(new AbortController().signal);
  expect(files).toHaveLength(2);
  expect(files[0]).toMatchObject({kind:"text",mime:"text/plain",name:"Текст PDF: invoice.pdf"});
  expect(files[0].data).toContain("Исходный файл в модель не отправляется");
  expect(files[0].data).toContain("Договор");
  expect(extractPdfPages).toHaveBeenCalledWith({uri:pdf.uri,name:pdf.name,mimeType:"application/pdf"},expect.anything());
  const content=JSON.stringify(chatContent("Сравни",files,"responses"));
  expect(content).toContain("Текст PDF: invoice.pdf");
  expect(content).not.toContain("data:application/pdf;base64");
  expect(readAsStringAsync).toHaveBeenCalledTimes(1); // only the ordinary text attachment
  expect(mockDelete).toHaveBeenCalledWith(pdf.uri);
});

test("H1: forged PDF extension or magic header never reads as UTF-8 or enters chat",async()=>{
  const pdf={uri:"file:///cache/forged.pdf",name:"forged.pdf",mimeType:"text/plain"};
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:[pdf]});
  mockPdfHeader=new Uint8Array([60,104,116,109,108]);
  await expect(pickChatAttachments(new AbortController().signal)).rejects.toThrow("не является PDF");
  expect(extractPdfPages).not.toHaveBeenCalled();
  expect(readAsStringAsync).not.toHaveBeenCalled();
  expect(mockDelete).toHaveBeenCalledWith(pdf.uri);
});

test("H1: empty/scanned or overlong PDF refuses upload and cleans cache, never truncates",async()=>{
  const pdf={uri:"file:///cache/scan.pdf",name:"scan.pdf",mimeType:"application/pdf"};
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:[pdf]});
  (extractPdfPages as jest.Mock).mockRejectedValueOnce(new Error("В PDF не найден текстовый слой"));
  await expect(pickChatAttachments(new AbortController().signal)).rejects.toThrow("текстовый слой");
  expect(mockDelete).toHaveBeenCalledWith(pdf.uri);
  (extractPdfPages as jest.Mock).mockResolvedValueOnce({text:"Л".repeat(24_000),totalPageCount:1,
    extractedPageCount:1,missingPages:[],coverage:"partial",segments:[]});
  const long=await pickChatAttachments(new AbortController().signal);
  expect(long[0].data).toContain("Л".repeat(24_000));
  mockSize=6*1024*1024+1;
  await expect(pickChatAttachments(new AbortController().signal)).rejects.toThrow("6 МБ");
});

test("H1: cancelled native PDF read cannot commit a late attachment",async()=>{
  const pdf={uri:"file:///cache/abort.pdf",name:"abort.pdf",mimeType:"application/pdf"};
  const controller=new AbortController();
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:[pdf]});
  (extractPdfPages as jest.Mock).mockImplementationOnce(async()=>{controller.abort();return {text:"Договор",totalPageCount:1,
    extractedPageCount:1,missingPages:[],coverage:"partial",segments:[]};});
  await expect(pickChatAttachments(controller.signal)).rejects.toThrow("прерван");
  expect(readAsStringAsync).not.toHaveBeenCalled();
  expect(mockDelete).toHaveBeenCalledWith(pdf.uri);
});

test("H2: invalid PDF in the middle does not discard valid earlier and later text",async()=>{
  const first={uri:"file:///cache/first.txt",name:"first.txt",mimeType:"text/plain"};
  const bad={uri:"file:///cache/broken.pdf",name:"broken.pdf",mimeType:"application/pdf"};
  const last={uri:"file:///cache/last.txt",name:"last.txt",mimeType:"text/plain"};
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:[first,bad,last]});
  mockPdfHeader=new Uint8Array([60,104,116,109,108]);
  (readAsStringAsync as jest.Mock).mockResolvedValue("Полезный текст");
  const result=await pickChatAttachmentsWithResults(new AbortController().signal);
  expect(result.files.map(f=>f.name)).toEqual(["first.txt","last.txt"]);
  expect(result.failures).toEqual([{name:"broken.pdf",reason:"Файл не является настоящим PDF."}]);
  expect(extractPdfPages).not.toHaveBeenCalled();
  for(const asset of [first,bad,last])expect(mockDelete).toHaveBeenCalledWith(asset.uri);
});

test("H2: exceeding combined text budget rejects only overflowing item, preserves earlier texts",async()=>{
  const files=[{uri:"file:///cache/first.txt",name:"first.txt",mimeType:"text/plain"},
    {uri:"file:///cache/oversize.txt",name:"oversize.txt",mimeType:"text/plain"},
    {uri:"file:///cache/last.txt",name:"last.txt",mimeType:"text/plain"}];
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:files});
  (readAsStringAsync as jest.Mock).mockResolvedValueOnce("А".repeat(200_000))
    .mockResolvedValueOnce("Б".repeat(50_000)).mockResolvedValueOnce("В".repeat(1_000));
  const result=await pickChatAttachmentsWithResults(new AbortController().signal);
  expect(result.files.map(f=>f.name)).toEqual(["first.txt","last.txt"]);
  expect(result.failures).toEqual([{name:"oversize.txt",reason:expect.stringContaining("240 000")}]);
  expect(chatContent("Сравни",result.files,"chat")).toBeTruthy();
});

test("H2: session abort is never treated as an individual failure or partial success",async()=>{
  const controller=new AbortController();
  const files=[{uri:"file:///cache/first.txt",name:"first.txt",mimeType:"text/plain"},
    {uri:"file:///cache/second.txt",name:"second.txt",mimeType:"text/plain"}];
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:files});
  (readAsStringAsync as jest.Mock).mockImplementationOnce(async()=>{controller.abort();return "Первый";});
  await expect(pickChatAttachmentsWithResults(controller.signal)).rejects.toThrow("прерван");
  expect(mockDelete).toHaveBeenCalledWith(files[0].uri);
  expect(mockDelete).toHaveBeenCalledWith(files[1].uri);
});

test("H2: native reader errors cannot leak provider paths into per-file messages",async()=>{
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:[asset]});
  (readAsStringAsync as jest.Mock).mockRejectedValue(new Error("failed at content://private/documents/secret"));
  const result=await pickChatAttachmentsWithResults(new AbortController().signal);
  expect(result.files).toEqual([]);
  expect(result.failures[0].reason).toMatch(/Проверьте формат и доступ/);
  expect(JSON.stringify(result.failures)).not.toContain("content://");
});

test('H3a: unsupported MIME diagnostic mentioning UTF-8 is never mislabeled a text decoding failure',()=>{
  const unsupported=new Error('В чат можно прикрепить фото JPEG/PNG/WebP, текст UTF-8 или PDF с текстовым слоем. Аудио и видео пока доступны в памяти.');
  expect(safeChatFileFailure(unsupported)).toBe('Формат файла не поддерживается в чате.');
  expect(safeChatFileFailure(new Error('Ошибка текстового файла UTF-8'))).toContain('UTF-8');
});

test("H3b: explicit picker MP3 becomes offline Whisper text, no audio bytes in any adapter",async()=>{
  const audio={uri:"file:///cache/meeting.mp3",name:"meeting.mp3",mimeType:"audio/mpeg"};
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:[audio]});
  const onPreparing=jest.fn();
  const result=await pickChatAttachmentsWithResults(new AbortController().signal,onPreparing);
  expect(onPreparing).toHaveBeenCalledTimes(1);
  expect(transcribeAudioFile).toHaveBeenCalledWith(audio.uri,expect.anything());
  expect(result.failures).toEqual([]);
  expect(result.files).toHaveLength(1);
  expect(result.files[0]).toMatchObject({kind:'text',mime:'text/plain',name:'Транскрипт аудио: meeting.mp3'});
  expect(result.files[0].data).toContain('Привет, проверь договор.');
  expect(result.files[0].data).toContain('Оригинальное аудио не отправляется');
  for(const protocol of ['chat','responses','anthropic'] as const){
    const blocks=JSON.stringify(chatContent('Обобщи',result.files,protocol));
    expect(blocks).toContain('Локальная расшифровка Whisper');
    expect(blocks).not.toContain('data:audio');
    expect(blocks).not.toContain('file:///cache/');
  }
  expect(readAsStringAsync).not.toHaveBeenCalled();
  expect(mockDelete).toHaveBeenCalledWith(audio.uri);
});

test("H3b: absent Whisper leaves other text ready without any network fallback",async()=>{
  const audio={uri:"file:///cache/meeting.m4a",name:"meeting.m4a",mimeType:"audio/mp4"};
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:[audio,asset]});
  (getWhisperStatus as jest.Mock).mockReturnValue({state:'absent'});
  const result=await pickChatAttachmentsWithResults(new AbortController().signal);
  expect(result.files.map(x=>x.name)).toEqual(['a.txt']);
  expect(result.failures).toMatchObject([{name:'meeting.m4a',reason:expect.stringContaining('Whisper')}]);
  expect(transcribeAudioFile).not.toHaveBeenCalled();
  expect(mockDelete).toHaveBeenCalledWith(audio.uri);
});

test("H3b: silence and excessive transcript cannot be treated as valid chat attachment",async()=>{
  const audio={uri:"file:///cache/silent.wav",name:"silent.wav",mimeType:"audio/wav"};
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:[audio]});
  (transcribeAudioFile as jest.Mock).mockResolvedValueOnce('  ');
  const silence=await pickChatAttachmentsWithResults(new AbortController().signal);
  expect(silence.files).toEqual([]);
  expect(silence.failures[0].reason).toContain('не удалось распознать');
  (transcribeAudioFile as jest.Mock).mockResolvedValueOnce('а'.repeat(24_000));
  const big=await pickChatAttachmentsWithResults(new AbortController().signal);
  expect(big.files).toEqual([]);
  expect(big.failures[0].reason).toContain('24 000');
});

test("H3b: abort or profile lock while decoding stops late result and clears picker copy",async()=>{
  const audio={uri:"file:///cache/late.ogg",name:"late.ogg",mimeType:"audio/ogg"};
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:[audio]});
  const controller=new AbortController();
  (transcribeAudioFile as jest.Mock).mockImplementationOnce(async()=>{controller.abort();return 'Поздний текст';});
  await expect(pickChatAttachmentsWithResults(controller.signal)).rejects.toThrow('прерван');
  expect(mockDelete).toHaveBeenCalledWith(audio.uri);
  (transcribeAudioFile as jest.Mock).mockImplementationOnce(async()=>{mockUnlocked=false;return 'Поздний текст';});
  await expect(pickChatAttachmentsWithResults(new AbortController().signal)).rejects.toThrow('прерван');
});

test("H3b: Share/non-picker reader never starts local ASR without explicit picker action",async()=>{
  const audio={uri:"file:///cache/incoming.mp3",name:"incoming.mp3",mimeType:"audio/mpeg"};
  const {readChatAttachments}=require('../pickChatAttachments') as typeof import('../pickChatAttachments');
  await expect(readChatAttachments([audio],new AbortController().signal)).rejects.toThrow('Share');
  expect(transcribeAudioFile).not.toHaveBeenCalled();
});

test("H-DOC1a: four selected valid files keep three attached and report fourth separately",async()=>{
  const selected=Array.from({length:4},(_,i)=>({
    uri:"file:///cache/file"+i+".txt",name:"file"+i+".txt",mimeType:"text/plain",
  }));
  (getDocumentAsync as jest.Mock).mockResolvedValue({canceled:false,assets:selected});
  (readAsStringAsync as jest.Mock).mockResolvedValue("Короткий текст");
  const result=await pickChatAttachmentsWithResults(new AbortController().signal);
  expect(result.files.map(x=>x.name)).toEqual(["file0.txt","file1.txt","file2.txt"]);
  expect(result.failures).toEqual([{name:"file3.txt",reason:expect.stringContaining("до 3 файлов")}]);
  expect(readAsStringAsync).toHaveBeenCalledTimes(3);
  for(const file of selected)expect(mockDelete).toHaveBeenCalledWith(file.uri);
});
