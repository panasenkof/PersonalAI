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
  expect(inspectSharedMaterial(Array(4).fill(file)).chatError).toContain('3');mockSize=7*1024*1024;
  expect(inspectSharedMaterial([file]).chatError).toContain('6 МБ');mockSize=81*1024*1024;expect(inspectSharedMaterial([file]).memoryError).toContain('80 МБ');
  mockSize=100;(readAsStringAsync as jest.Mock).mockResolvedValue('x'.repeat(240001));const result=await prepareSharedMaterial([file],new AbortController().signal);expect(result.chatError).toBeTruthy();expect(result.attachments).toEqual([]);expect(mockDelete).toHaveBeenCalled();
});
test.each(['abort','lock'])('%s during copy discards the late result and cleans cache',async mode=>{
  const controller=new AbortController();mockCopy.mockImplementation(async()=>{if(mode==='abort')controller.abort();else mockUnlocked=false;});
  await expect(prepareSharedMaterial([file],controller.signal)).rejects.toThrow('прерван');expect(readAsStringAsync).not.toHaveBeenCalled();expect(mockDelete).toHaveBeenCalled();
});
test('copy failure does not expose provider path and leaves recovery through memory',async()=>{
  mockCopy.mockRejectedValue(new Error('private content://provider/secret'));
  const result=await prepareSharedMaterial([file],new AbortController().signal);expect(result.chatError).not.toContain('content://');expect(result.memoryError).toBe('');expect(mockDelete).toHaveBeenCalled();
});
test('remote binary and empty inputs rejected; PDF is text-only in chat and original in memory',()=>{
  expect(()=>inspectSharedMaterial([{...file,value:'https://example.org/file'}])).toThrow('локальный');expect(()=>inspectSharedMaterial([])).toThrow();
  const pdf={...file,value:'content://provider/file.pdf',mimeType:'application/pdf'};
  expect(inspectSharedMaterial([pdf]).chatError).toBe('');
  expect(inspectSharedMaterial([pdf]).memoryError).toBe('');
  mockSize=6*1024*1024+1;
  expect(inspectSharedMaterial([pdf]).chatError).toContain('6 МБ');
  expect(inspectSharedMaterial([pdf]).memoryError).toBe('');
});


test('shared photos of 3 MB are allowed for local resizing, but photos over 80 MB are rejected',()=>{
  const photo={shareType:'image' as const,value:'content://provider/bike.jpg',mimeType:'image/jpeg'};
  mockSize=3*1024*1024;
  expect(inspectSharedMaterial([photo]).chatError).toBe('');
  expect(inspectSharedMaterial([photo]).memoryError).toBe('');
  mockSize=81*1024*1024;
  expect(inspectSharedMaterial([photo]).chatError).toContain('80 МБ');
  expect(inspectSharedMaterial([photo]).memoryError).toContain('80 МБ');
});

test('H3a: unsupported audio does not discard a ready text file from the same Share',async()=>{
  const audio={shareType:'audio' as const,value:'content://provider/voice.mp3',mimeType:'audio/mpeg'};
  const result=await prepareSharedMaterial([file,audio],new AbortController().signal);
  expect(result.chatError).toBe('');
  expect(result.attachments).toHaveLength(1);
  expect(result.attachments[0].data).toBe('Рецепт');
  expect(result.chatStatuses).toEqual([
    {name:'recipe.txt',state:'ready'},
    {name:'voice.mp3',state:'error',reason:expect.stringContaining('Whisper')},
  ]);
  expect(result.memoryError).toBe('');
  expect(mockCopy).toHaveBeenCalledTimes(1);
  expect(mockDelete).not.toHaveBeenCalledWith(audio.value);
});

test('H3a: one provider copy error leaves following valid text available without leaking a URI',async()=>{
  const second={...file,value:'content://provider/second.txt'};
  mockCopy.mockRejectedValueOnce(new Error('private content://provider/secret'));
  const result=await prepareSharedMaterial([file,second],new AbortController().signal);
  expect(result.chatError).toBe('');
  expect(result.attachments).toHaveLength(1);
  expect(result.chatStatuses[0]).toMatchObject({name:'recipe.txt',state:'error'});
  expect(result.chatStatuses[1]).toMatchObject({name:'second.txt',state:'ready'});
  expect(JSON.stringify(result.chatStatuses)).not.toContain('content://');
  expect(mockDelete).toHaveBeenCalledWith('file:///cache/persai-incoming/1');
  expect(mockDelete).toHaveBeenCalledWith('file:///cache/persai-incoming/2');
});

test('H3a: aggregate 24k limit rejects only overflow, not a later smaller file',async()=>{
  const second={...file,value:'content://provider/second.txt'};
  const third={...file,value:'content://provider/third.txt'};
  (readAsStringAsync as jest.Mock).mockResolvedValueOnce('А'.repeat(200_000))
    .mockResolvedValueOnce('Б'.repeat(50_000)).mockResolvedValueOnce('В'.repeat(1000));
  const result=await prepareSharedMaterial([file,second,third],new AbortController().signal);
  expect(result.chatError).toBe('');
  expect(result.attachments.map(x=>x.name)).toEqual(['recipe.txt','third.txt']);
  expect(result.chatStatuses.map(x=>x.state)).toEqual(['ready','error','ready']);
  expect(result.chatStatuses[1].reason).toContain('240 000');
});

test('H3a: session lock during second file aborts entire Share and cleans all copies',async()=>{
  const second={...file,value:'content://provider/second.txt'};
  let calls=0;
  mockCopy.mockImplementation(async()=>{
    if(++calls===2)mockUnlocked=false;
  });
  await expect(prepareSharedMaterial([file,second],new AbortController().signal)).rejects.toThrow('прерван');
  expect(mockDelete).toHaveBeenCalledWith('file:///cache/persai-incoming/1');
  expect(mockDelete).toHaveBeenCalledWith('file:///cache/persai-incoming/3');
});

test('H3a: memory can still import an otherwise unsupported chat file',async()=>{
  const audio={shareType:'audio' as const,value:'content://provider/voice.mp3',mimeType:'audio/mpeg'};
  const result=await prepareSharedMaterial([audio],new AbortController().signal);
  expect(result.chatError).toContain('Нет готовых');
  expect(result.memoryError).toBe('');
  expect(result.chatStatuses).toEqual([{name:'voice.mp3',state:'error',reason:expect.any(String)}]);
  expect(mockCopy).not.toHaveBeenCalled();
});

test("H3b: incoming audio Share is never silently transcribed; local picker action is required",async()=>{
  const incoming={shareType:'audio' as const,value:'content://provider/recording.m4a',mimeType:'audio/mp4'};
  const result=await prepareSharedMaterial([file,incoming],new AbortController().signal);
  expect(result.chatError).toBe('');
  expect(result.attachments.map(x=>x.name)).toEqual(['recipe.txt']);
  expect(result.chatStatuses[1]).toMatchObject({name:'recording.m4a',state:'error',reason:expect.stringContaining('Whisper')});
  expect(mockCopy).toHaveBeenCalledTimes(1);
  expect(mockDelete).not.toHaveBeenCalledWith(incoming.value);
});
