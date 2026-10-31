import { indexSavedPhoto83 } from "../vision-index-attachment";
import { localMemorySessionUnlocked, withLocalMemoryDatabase } from "../../local-memory/storage";
import { verifiedActiveVisionModel } from "../vision-model-manager";
import { materializeAttachment } from "../attachments";
import { embedVisionImage83 } from "../vision-native-vectors";
import { SqliteMemoryRepository } from "../../local-memory/repository";

jest.mock("expo-crypto",()=>({randomUUID:()=> "test-photo-id"}));
const mockFilesDeleted:string[]=[];
const mockCopies:string[]=[];
jest.mock("expo-file-system",()=>({
  Paths:{cache:"/app/cache"},
  Directory:class { path:string;constructor(...parts:unknown[]){this.path=parts.join("/");}
    create(){} },
  File:class { uri:string;name:string;exists=true;
    constructor(...args:any[]){this.uri=args.map(a=>typeof a==="string"?a:a.path).join("/");
      this.name=this.uri.split("/").at(-1) ?? "";}
    copy(dest:{uri:string}){mockCopies.push(dest.uri);}
    delete(){mockFilesDeleted.push(this.uri);}
  },
}));
jest.mock("../../local-memory/storage",()=>({
  localMemorySessionUnlocked:jest.fn(),withLocalMemoryDatabase:jest.fn(),
}));
jest.mock("../vision-model-manager",()=>({verifiedActiveVisionModel:jest.fn()}));
jest.mock("../vision-native-vectors",()=>({embedVisionImage83:jest.fn()}));
jest.mock("../attachments",()=>({materializeAttachment:jest.fn()}));
jest.mock("../../local-memory/extractions",()=>({fingerprintExtractionSource:jest.fn(async()=> "f".repeat(64))}));
jest.mock("../../local-memory/repository",()=>({SqliteMemoryRepository:jest.fn()}));

const unlocked=localMemorySessionUnlocked as jest.Mock;
const database=withLocalMemoryDatabase as jest.Mock;
const selected=verifiedActiveVisionModel as jest.Mock;
const materialize=materializeAttachment as jest.Mock;
const embed=embedVisionImage83 as jest.Mock;
const Repository=SqliteMemoryRepository as jest.Mock;
const mockSaveVector=jest.fn();
const attachment={
  id:"att-1",entity_id:"note-1",name:"family.jpg",mime:"image/jpeg",
  size:128,record_version:4,
};
const model={path:"/data/user/0/com.persai.app/files/persai-vision-models/model.litertlm",
  space:"eg2|vision|768|sha256:"+"a".repeat(64)};
const mockDb={getFirstAsync:jest.fn()};
beforeEach(()=>{
  jest.clearAllMocks();mockFilesDeleted.length=0;mockCopies.length=0;
  unlocked.mockReturnValue(true);
  database.mockImplementation(async (_profile:string,work:(db:typeof mockDb)=>Promise<unknown>)=>work(mockDb));
  mockDb.getFirstAsync.mockResolvedValue(attachment);
  selected.mockResolvedValue(model);
  materialize.mockResolvedValue("file:///app/cache/persai-previews/source.jpg");
  embed.mockResolvedValue(new Float32Array([1,...Array(767).fill(0)]));
  mockSaveVector.mockResolvedValue(true);
  Repository.mockImplementation(()=>({saveImageVector:mockSaveVector}));
});

test("one original is decrypted through canonical materializer, saved via existing SQLCipher repo and both previews deleted",async()=>{
  const result=await indexSavedPhoto83("guest","att-1");
  expect(result).toEqual({indexed:true,attachmentId:"att-1",modelSpace:model.space});
  expect(mockDb.getFirstAsync.mock.calls[0][0]).toMatch(/e\.sensitivity IN \('standard','inherit'\).*c\.sensitivity='standard'/s);
  expect(materialize).toHaveBeenCalledWith("guest",expect.objectContaining({id:"att-1"}),
    undefined,expect.objectContaining({recordId:"note-1",recordVersion:4,metadataOnly:true}));
  expect(mockCopies).toHaveLength(1);
  expect(embed).toHaveBeenCalledWith(expect.objectContaining({
    modelName:"model.litertlm",modelSha256:"a".repeat(64),imageName:"test-photo-id.jpg",
  }));
  expect(mockSaveVector).toHaveBeenCalledWith("att-1",model.space,
    expect.any(Float32Array),"f".repeat(64));
  expect(mockFilesDeleted).toHaveLength(2);
});
test("locked, absent model and inaccessible source never open original",async()=>{
  unlocked.mockReturnValue(false);
  await expect(indexSavedPhoto83("guest","att-1")).rejects.toThrow("application_locked");
  unlocked.mockReturnValue(true);
  selected.mockResolvedValue(null);
  expect(await indexSavedPhoto83("guest","att-1")).toEqual({
    indexed:false,attachmentId:"att-1",reason:"model_not_installed",
  });
  selected.mockResolvedValue(model);
  mockDb.getFirstAsync.mockResolvedValue(null);
  await expect(indexSavedPhoto83("guest","att-1")).rejects.toThrow("memory_source_not_available_or_stale");
  expect(materialize).not.toHaveBeenCalled();
  expect(embed).not.toHaveBeenCalled();
  expect(mockSaveVector).not.toHaveBeenCalled();
});
test("unsupported HEIC (until native support) is skipped without unencrypted copies",async()=>{
  mockDb.getFirstAsync.mockResolvedValue({...attachment,mime:"image/heic"});
  expect(await indexSavedPhoto83("guest","att-1")).toEqual({
    indexed:false,attachmentId:"att-1",reason:"unsupported_format",
  });
  expect(materialize).not.toHaveBeenCalled();
  expect(mockCopies).toEqual([]);
});
test("a changed original cannot be accepted and indexer cleans up on failure",async()=>{
  mockSaveVector.mockResolvedValue(false);
  expect(await indexSavedPhoto83("guest","att-1")).toEqual({
    indexed:false,attachmentId:"att-1",reason:"source_changed",
  });
  expect(mockFilesDeleted).toHaveLength(2);
  mockFilesDeleted.length=0;
  embed.mockRejectedValueOnce(new Error("native_inference_crashed"));
  await expect(indexSavedPhoto83("guest","att-1")).rejects.toThrow("native_inference_crashed");
  expect(mockFilesDeleted).toHaveLength(2);
});
test("AppLock expiry during native inference discards vector and deletes plaintext",async()=>{
  embed.mockImplementationOnce(async()=>{
    unlocked.mockReturnValue(false);
    return new Float32Array([1,...Array(767).fill(0)]);
  });
  await expect(indexSavedPhoto83("guest","att-1")).rejects.toThrow("application_locked");
  expect(mockSaveVector).not.toHaveBeenCalled();
  expect(mockFilesDeleted).toHaveLength(2);
});
test("reject unsafe model paths, target ids and cancellation before writing",async()=>{
  selected.mockResolvedValue({...model,path:"/tmp/unsafe.litertlm"});
  await expect(indexSavedPhoto83("guest","att-1")).rejects.toThrow("vision_model_path_invalid");
  await expect(indexSavedPhoto83("guest","../att-1")).rejects.toThrow("vision_invalid_index_target");
  selected.mockResolvedValue(model);
  const control=new AbortController();control.abort();
  await expect(indexSavedPhoto83("guest","att-1",control.signal))
    .rejects.toThrow("vision_index_cancelled");
  expect(embed).not.toHaveBeenCalled();
});
