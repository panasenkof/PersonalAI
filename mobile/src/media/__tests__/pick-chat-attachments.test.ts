import { pickChatAttachments, pickChatAttachmentsWithResults, safeChatFileFailure } from '../pickChatAttachments';
import { chatContent } from "../../direct-agent/chat-attachments";
import { extractPdfPages } from "../pdf-pages";
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
  (extractPdfPages as jest.Mock).mockResolvedValue({text:"Страница 1:\\nДоговор",totalPageCount:1,
    extractedPageCount:1,missingPages:[],coverage:"partial",segments:[]});
});
test('stages actual text and removes only picker cache copies',async()=>{const files=await pickChatAttachments(new AbortController().signal);expect(files[0]).toMatchObject({data:'Text',kind:'text',name:'a.txt'});expect(mockDelete).toHaveBeenCalledWith(asset.uri);});
test('cancellation and oversized files never read content',async()=>{(getDocumentAsync as jest.Mock).mockResolvedValueOnce({canceled:true});expect(await pickChatAttachments(new AbortController().signal)).toEqual([]);mockSize=3*1024*1024;await expect(pickChatAttachments(new AbortController().signal)).rejects.toThrow('24 000 символов');expect(readAsStringAsync).not.toHaveBeenCalled();expect(mockDelete).toHaveBeenCalledWith(asset.uri);});
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
  await expect(pickChatAttachments(new AbortController().signal)).rejects.toThrow("24 000");
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
  (readAsStringAsync as jest.Mock).mockResolvedValueOnce("А".repeat(20_000))
    .mockResolvedValueOnce("Б".repeat(5_000)).mockResolvedValueOnce("В".repeat(1_000));
  const result=await pickChatAttachmentsWithResults(new AbortController().signal);
  expect(result.files.map(f=>f.name)).toEqual(["first.txt","last.txt"]);
  expect(result.failures).toEqual([{name:"oversize.txt",reason:expect.stringContaining("24 000")}]);
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
