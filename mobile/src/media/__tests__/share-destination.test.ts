import {inspectSharedMaterial,prepareSharedMaterial} from '../share-destination';
import {readAsStringAsync} from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
let mockUnlocked=true, mockSize=100;const mockDelete=jest.fn(), mockCopy=jest.fn();let mockId=0;
jest.mock('expo-crypto',()=>({randomUUID:()=>String(++mockId)}));
jest.mock('expo-sharing',()=>({getResolvedSharedPayloadsAsync:jest.fn()}));
jest.mock('expo-document-picker',()=>({getDocumentAsync:jest.fn()}));
jest.mock('expo-file-system/legacy',()=>({copyAsync:(v:any)=>mockCopy(v),readAsStringAsync:jest.fn(),EncodingType:{Base64:'base64',UTF8:'utf8'}}));
jest.mock('expo-file-system',()=>({Paths:{cache:'file:///cache'},Directory:class {uri:string;constructor(...p:string[]){this.uri=p.join('/');}create(){}},File:class {uri:string;exists=true;constructor(p:any,name?:string){this.uri=typeof p==='string'?p:p.uri+'/'+name;}get name(){return this.uri.split('/').pop();}get size(){return mockSize;}delete(){mockDelete(this.uri);}}}));
jest.mock('../../local-memory/storage',()=>({localMemorySessionUnlocked:()=>mockUnlocked}));
jest.mock('../../security/native-interaction',()=>({withNativeInteraction:(w:any)=>w()}));
const file={shareType:'file' as const,value:'content://provider/recipe.txt',mimeType:'text/plain'};
beforeEach(()=>{jest.resetAllMocks();mockUnlocked=true;mockSize=100;mockId=0;mockCopy.mockResolvedValue(undefined);(readAsStringAsync as jest.Mock).mockResolvedValue('Рецепт');});
test('mixed share prepares text and original locally, never resolves URLs, deletes only private copies',async()=>{
  const result=await prepareSharedMaterial([{shareType:'url',value:'https://example.org/private'},file],new AbortController().signal);
  expect(result.text).toBe('https://example.org/private');expect(result.attachments[0].data).toBe('Рецепт');expect(result.chatError).toBe('');
  expect(Sharing.getResolvedSharedPayloadsAsync).not.toHaveBeenCalled();expect(mockDelete).toHaveBeenCalledWith('file:///cache/persai-incoming/1');expect(mockDelete).not.toHaveBeenCalledWith(file.value);
});
test.each(['audio/mpeg','video/mp4'])('unsupported chat %s remains available for memory without copying',async mimeType=>{
  const result=await prepareSharedMaterial([{shareType:'file',value:'content://provider/blob',mimeType}],new AbortController().signal);
  expect(result.chatError).toBeTruthy();expect(result.memoryError).toBe('');expect(mockCopy).not.toHaveBeenCalled();
});
test('count, sizes and actual read limits are checked before chat is offered',async()=>{
  expect(inspectSharedMaterial(Array(4).fill(file)).chatError).toContain('3');mockSize=3*1024*1024;
  expect(inspectSharedMaterial([file]).chatError).toContain('2 МБ');mockSize=81*1024*1024;expect(inspectSharedMaterial([file]).memoryError).toContain('80 МБ');
  mockSize=100;(readAsStringAsync as jest.Mock).mockResolvedValue('x'.repeat(24001));const result=await prepareSharedMaterial([file],new AbortController().signal);expect(result.chatError).toBeTruthy();expect(result.attachments).toEqual([]);expect(mockDelete).toHaveBeenCalled();
});
test.each(['abort','lock'])('%s during copy discards the late result and cleans cache',async mode=>{
  const controller=new AbortController();mockCopy.mockImplementation(async()=>{if(mode==='abort')controller.abort();else mockUnlocked=false;});
  await expect(prepareSharedMaterial([file],controller.signal)).rejects.toThrow('прерван');expect(readAsStringAsync).not.toHaveBeenCalled();expect(mockDelete).toHaveBeenCalled();
});
test('copy failure does not expose provider path and leaves recovery through memory',async()=>{
  mockCopy.mockRejectedValue(new Error('private content://provider/secret'));
  const result=await prepareSharedMaterial([file],new AbortController().signal);expect(result.chatError).not.toContain('content://');expect(result.memoryError).toBe('');expect(mockDelete).toHaveBeenCalled();
});
test('remote binary and empty inputs are rejected; PDF is not promised in new-note import',()=>{
  expect(()=>inspectSharedMaterial([{...file,value:'https://example.org/file'}])).toThrow('локальный');expect(()=>inspectSharedMaterial([])).toThrow();
  const pdf=inspectSharedMaterial([{...file,value:'content://provider/file.pdf',mimeType:'application/pdf'}]);expect(pdf.chatError).toBeTruthy();expect(pdf.memoryError).toContain('существующей');
});
