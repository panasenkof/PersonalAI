import {
  capturePortableBackupSettings, parsePortableBackupSettings, applyPortableBackupSettings,
} from "../backup-settings";
import { loadDirectConnections, saveDirectConnections } from "../../direct-agent/settings";
import { loadModelCallLimit, saveModelCallLimit } from "../../direct-agent/agent-preferences";
import { loadMediaPreferences, saveMediaPreferences } from "../../media/preferences";
import { loadPhotoResultCount, savePhotoResultCount } from "../../media/photo-result-preferences";
import { getVoiceEngine, initVoiceEngine, setVoiceEngine } from "../../media/voice-engine";
import { getEnrichState, loadIndexTermsPreference, setIndexTermsEnabled } from "../../direct-agent/enrich-runner";

// Existing settings fixture does not invoke native model hashing/downloads.
jest.mock("../../media/model-backup-recovery", () => ({
  captureInstalledModels: jest.fn(async () => ({version:1,models:[]})),
  parseRecoveryModels: jest.fn((v: unknown) => v),
  saveRecoveryModels: jest.fn(async () => {}),
}));
jest.mock("../../direct-agent/settings", () => ({
  loadDirectConnections: jest.fn(), saveDirectConnections: jest.fn(),
  validateProvider: jest.fn((value: string) => {
    if (!["openai", "openai-compatible", "anthropic"].includes(value))
      throw new Error("invalid_provider");
    return value;
  }),
  validateBaseUrl: jest.fn((url: string) => {
    if (!url.startsWith("https://") && !url.startsWith("http://192.168."))
      throw new Error("invalid_url");
    return url;
  }),
  validateModel: jest.fn((v: string) => {
    if (!v || /[<>\s]/.test(v)) throw new Error("invalid_model");
    return v;
  }),
}));
jest.mock("../../direct-agent/agent-preferences", () => ({
  loadModelCallLimit: jest.fn(), saveModelCallLimit: jest.fn(),
}));
jest.mock("../../direct-agent/limits", () => ({
  validateModelCallLimit: jest.fn((v: number) => {
    if (!Number.isInteger(v) || v < 1 || v > 20) throw new Error("invalid_limit");
    return v;
  }),
}));
jest.mock("../../media/preferences", () => ({
  loadMediaPreferences: jest.fn(), saveMediaPreferences: jest.fn(),
}));
jest.mock("../../media/photo-result-preferences", () => ({
  loadPhotoResultCount: jest.fn(), savePhotoResultCount: jest.fn(),
  validPhotoResultCount: (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 20,
}));
jest.mock("../../media/voice-engine", () => ({
  getVoiceEngine: jest.fn(), initVoiceEngine: jest.fn(), setVoiceEngine: jest.fn(),
}));
jest.mock("../../direct-agent/enrich-runner", () => ({
  getEnrichState: jest.fn(), loadIndexTermsPreference: jest.fn(), setIndexTermsEnabled: jest.fn(),
}));

const connections = {
  activeId: "deepseek",
  connections: [
    {id:"deepseek",name:"DeepSeek",provider:"openai-compatible",baseUrl:"https://api.deepseek.com",
      model:"deepseek-flash",transcriptionModel:"whisper-1",allowWeb:true,
      searchProvider:"deepseek",apiKey:"sk-deepseek-test-private",
      webSearchKey:"sk-deepseek-web-private",searchKeys:{deepseek:"sk-deepseek-web-private"}},
    {id:"anthropic",name:"Claude",provider:"anthropic",baseUrl:"https://api.anthropic.com/v1",
      model:"claude-sonnet-4-5",allowWeb:false,searchProvider:"tavily",
      apiKey:"sk-anthropic-test-private",webSearchKey:"",searchKeys:{tavily:"tvly-private-search"}},
  ],
} as const;
beforeEach(() => {
  jest.clearAllMocks();
  (loadDirectConnections as jest.Mock).mockResolvedValue(connections);
  (loadModelCallLimit as jest.Mock).mockResolvedValue(9);
  (loadMediaPreferences as jest.Mock).mockResolvedValue({visionId:"deepseek",speechId:"anthropic",fileAsrMode:"device"});
  (loadPhotoResultCount as jest.Mock).mockResolvedValue(6);
  (getVoiceEngine as jest.Mock).mockReturnValue({preference:"whisper"});
  (getEnrichState as jest.Mock).mockReturnValue({enabled:false});
  for (const fn of [initVoiceEngine,loadIndexTermsPreference,saveDirectConnections,saveModelCallLimit,
    saveMediaPreferences,savePhotoResultCount,setVoiceEngine,setIndexTermsEnabled])
    (fn as jest.Mock).mockResolvedValue(undefined);
});

test("captures every connection, provider, API/search key and selected portable setting", async () => {
  const raw = await capturePortableBackupSettings("guest");
  expect(raw).toContain("sk-deepseek-test-private");
  const parsed = parsePortableBackupSettings(raw);
  expect(parsed.connections.connections).toHaveLength(2);
  expect(parsed.connections.activeId).toBe("deepseek");
  expect(parsed.connections.connections[1].searchKeys?.tavily).toBe("tvly-private-search");
  expect(parsed.modelCallLimit).toBe(9);
  expect(parsed.voiceEngine).toBe("whisper");
  expect(parsed.indexTermsEnabled).toBe(false);
  expect(parsed.media).toMatchObject({visionId:"deepseek",speechId:"anthropic"});
  await applyPortableBackupSettings("guest", parsed);
  expect(saveDirectConnections).toHaveBeenCalledWith("guest", parsed.connections);
  expect(saveModelCallLimit).toHaveBeenCalledWith("guest", 9);
  expect(saveMediaPreferences).toHaveBeenCalledWith("guest", parsed.media);
  expect(setVoiceEngine).toHaveBeenCalledWith("whisper");
  expect(setIndexTermsEnabled).toHaveBeenCalledWith(false);
});

test("capture fails closed when a source of credentials cannot be read", async () => {
  (loadDirectConnections as jest.Mock).mockRejectedValueOnce(new Error("device credential read failed"));
  await expect(capturePortableBackupSettings("guest")).rejects.toThrow("device credential read failed");
  expect(saveDirectConnections).not.toHaveBeenCalled();
});

test("rejects unknown schema, malformed secrets, endpoint or wrong active connection", async () => {
  const raw = JSON.parse(await capturePortableBackupSettings("guest"));
  const tamper = (patch: (v: any) => void) => {
    const v = JSON.parse(JSON.stringify(raw)); patch(v);
    expect(() => parsePortableBackupSettings(JSON.stringify(v))).toThrow("backup_settings_invalid");
  };
  tamper(v => { v.version = 2; });
  tamper(v => { v.connections.activeId = "missing"; });
  tamper(v => { v.connections.connections[0].apiKey = "key with spaces"; });
  tamper(v => { v.connections.connections[0].baseUrl = "http://insecure.example.com"; });
  tamper(v => { v.connections.connections[0].searchKeys = {unknown:"key"}; });
  tamper(v => { v.modelCallLimit = 999; });
  tamper(v => { v.voiceEngine = "remote"; });
});
