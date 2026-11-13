/**
 * ARCH-11 paid, opt-in acceptance: ONE real provider call per scenario.
 *
 * Calls the actual runDirectAgent/provider adapters and canonical catalog.
 * maxRequests=1 intentionally prevents executing any proposed mutation. The
 * first model tool decision is captured from the provider response; the
 * expected names never enter the model input. No personal memory is loaded.
 *
 * Cost guard: at most 15 HTTPS calls, 512 output tokens per case, only after
 * manual workflow_dispatch with explicit confirmation. Regular CI skips live.
 */
import * as fs from "node:fs";
import {TOOL_CHOICE_CASES, type ToolChoiceCase} from "../tool-choice-cases";
import {realHttpsTransport} from "../real-https-transport";
import {runDirectAgent, type DirectAgentOptions} from "../../src/direct-agent/engine";
import {createToolCatalog} from "../../src/direct-agent/tool-catalog";

jest.mock("expo-crypto", () => ({
  randomUUID: () => require("node:crypto").randomUUID(),
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_kind: string, value: string) =>
    require("node:crypto").createHash("sha256").update(value).digest("hex"),
}));

type Provider = DirectAgentOptions["settings"]["provider"];
const manual = process.env.PERSAI_ARCH3_MANUAL_TRIGGER === "workflow_dispatch" &&
  process.env.PERSAI_ARCH3_APPROVED === "true";
const paidTest = manual ? test : test.skip;
const MAX_CALLS = 15;
const MAX_OUTPUT_TOKENS = 512;
const MAX_INPUT_CHARS = 120_000;
const REPORT_PATH = process.env.PERSAI_ARCH3_REPORT_PATH || "arch3-live-tool-choice.json";

function providerConfig() {
  const provider = process.env.PERSAI_ARCH3_PROVIDER as Provider;
  if (!["openai", "openai-compatible", "anthropic"].includes(provider))
    throw Error("ARCH3_PROVIDER_NOT_ALLOWED");
  const apiKey = process.env.PERSAI_ARCH3_API_KEY || "";
  const model = process.env.PERSAI_ARCH3_MODEL || "";
  const baseUrl = process.env.PERSAI_ARCH3_BASE_URL || "";
  if (!apiKey || !model || !baseUrl) throw Error("ARCH3_PROVIDER_CONFIG_MISSING");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    url.hostname === "localhost" || /\.(local|internal)$/i.test(url.hostname) ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) || url.hostname.includes(":"))
    throw Error("ARCH3_PUBLIC_HTTPS_ENDPOINT_REQUIRED");
  // Prevent a mistaken secret from leaving to an arbitrary third party.
  if (provider === "openai" && url.hostname !== "api.openai.com")
    throw Error("ARCH3_OPENAI_ENDPOINT_MISMATCH");
  if (provider === "anthropic" && url.hostname !== "api.anthropic.com")
    throw Error("ARCH3_ANTHROPIC_ENDPOINT_MISMATCH");
  return { provider, apiKey, model, baseUrl, origin: url.origin,
    path: url.pathname.replace(/\/$/, "") };
}

const syntheticNote = {
  id: "synthetic-lavender-v1", title: "Как выращивать лаванду",
  body: "Сажать на солнечном месте с дренажом. Текст обрезан.",
  section: "Заметки", version: 3, excerptOnly: true,
};
const selectedPage = {
  kind: "saved_ai_links" as const,
  savedFrom: "2026-11-01T00:00:00.000Z",
  savedBefore: "2026-11-08T00:00:00.000Z",
  startLocal: "2026-11-01", endLocal: "2026-11-07",
  nextCursor: { beforeCreatedAt: "2026-11-03T12:00:00.000Z", beforeId: "article-1" },
  selected: [{ id: "article-1", version: 2 }],
};

function optionsFor(item: ToolChoiceCase, config: ReturnType<typeof providerConfig>): DirectAgentOptions {
  const opts: DirectAgentOptions = {
    settings: {
      provider: config.provider, model: config.model, apiKey: config.apiKey,
      baseUrl: config.baseUrl, allowWeb: false, webSearchKey: "",
    },
    prompt: item.prompt, history: [],
    lookup: async () => item.fixture === "read" || item.fixture === "move"
      ? [syntheticNote] : [],
    propose: () => "synthetic-unsaved-fact",
    sections: [
      { slug: "notes", name: "Заметки" },
      { slug: "garden", name: "Сад" },
      { slug: "temporary", name: "Временное" },
    ],
    rewrite: false,
    maxRequests: 1,
  };
  if (item.fixture === "read" || item.fixture === "move") {
    opts.read = async () => ({ id: syntheticNote.id, revision: 3,
      title: syntheticNote.title, content: syntheticNote.body, hasMore: false,
      evidence: { recordId: syntheticNote.id, recordVersion: 3 } });
  }
  if (item.fixture === "count") {
    opts.count = async () => ({ count: 3 });
  }
  if (["articles","continue","selected"].includes(item.fixture)) {
    opts.selectArticles = async () => ({ items: [], hasMore: false }) as any;
  }
  if (item.fixture === "continue") opts.articleContinuation = selectedPage;
  if (item.fixture === "selected") {
    opts.articleSelection = selectedPage;
    opts.read = async () => ({ content: "Синтетический текст", hasMore: false });
  }
  if (item.fixture === "photos") {
    opts.searchPhotos = async () => ({ text: "Синтетический результат", memory: [] });
  }
  if (item.fixture === "move") {
    opts.list = async () => ({ items: [] });
    opts.previewMove = async () => ({ noteId: syntheticNote.id }) as any;
  }
  if (item.fixture === "sections") {
    opts.previewSectionAction = async () => ({ kind: "create" }) as any;
  }
  if (item.fixture === "context") {
    opts.contextClassificationEnabled = true;
  }
  if (item.fixture === "workspace") {
    opts.workspaceAvailable = () => true;
    opts.saveWorkspace = async () => {};
  }
  return opts;
}

type CapturedTool = { name: string; args: unknown };
function parseCalls(data: any, provider: Provider): CapturedTool[] {
  if (provider === "openai") return (data.output || [])
    .filter((x: any) => x.type === "function_call")
    .map((x: any) => ({ name: x.name, args: parseArguments(x.arguments) }));
  if (provider === "anthropic") return (data.content || [])
    .filter((x: any) => x.type === "tool_use")
    .map((x: any) => ({ name: x.name, args: x.input }));
  return (data.choices?.[0]?.message?.tool_calls || [])
    .map((x: any) => ({ name: x.function?.name, args: parseArguments(x.function?.arguments) }));
}
function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
function recordIds(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const obj = raw as Record<string, unknown>;
  return ["id", "noteId"].flatMap(key => typeof obj[key] === "string" ? [obj[key] as string] : []);
}
function bodyTools(body: Record<string, any>, provider: Provider): string[] {
  return (body.tools || []).map((x: any) =>
    provider === "openai-compatible" ? x.function?.name : x.name).filter(Boolean);
}
function bodySystem(body: Record<string, any>, provider: Provider): string {
  const text = provider === "openai" ? body.input?.[0]?.content :
    provider === "anthropic" ? body.system : body.messages?.[0]?.content;
  return typeof text === "string" ? text : "";
}
function evaluateChoice(c: ToolChoiceCase, calls: CapturedTool[], advertised: string[]): string[] {
  const issues: string[] = [];
  const first = calls[0]?.name || null;
  if (first !== c.firstTool) issues.push("wrong_first_tool");
  for (const call of calls) {
    if (!advertised.includes(call.name)) issues.push("unadvertised_tool:" + call.name);
    if (c.forbidden.includes(call.name)) issues.push("forbidden_tool:" + call.name);
    for (const id of recordIds(call.args)) {
      if (!["synthetic-lavender-v1", "article-1"].includes(id))
        issues.push("invented_record_id");
    }
  }
  return [...new Set(issues)];
}

test("ARCH-11 evaluator rejects invented handles, missing or forbidden first tool", () => {
  const c = TOOL_CHOICE_CASES[1];
  expect(evaluateChoice(c, [{name:"read_local_note",args:{id:"invented",version:42}}],
    ["read_local_note"])).toContain("invented_record_id");
  expect(evaluateChoice(c, [{name:"send_email",args:{}}],
    ["read_local_note"])).toEqual(expect.arrayContaining(["wrong_first_tool","unadvertised_tool:send_email"]));
  expect(evaluateChoice(c, [{name:"read_local_note",args:{id:"synthetic-lavender-v1",version:3}}],
    ["read_local_note"])).toEqual([]);
});

paidTest("ARCH-11 LIVE: 15 blind first-tool decisions on ONE explicitly chosen provider", async () => {
  const config = providerConfig();
  const rows: Array<{ id:string; expected:string|null; actual:string|null;
    issues:string[]; advertised:number; promptChars:number; calls:number }> = [];
  let totalCalls = 0;
  let networkError: string | undefined;
  for (const c of TOOL_CHOICE_CASES) {
    const opts = optionsFor(c, config);
    const catalog = createToolCatalog(opts, [], [], []);
    const advertised = catalog.definitions.map(x => x.name);
    if (c.firstTool && !advertised.includes(c.firstTool)) {
      throw Error("ARCH3_FIXTURE_DID_NOT_ADVERTISE_REQUIRED_TOOL:" + c.id);
    }
    let reply: any;
    let promptChars = 0, sentTools: string[] = [];
    const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (++totalCalls > MAX_CALLS) throw Error("ARCH3_PAID_CALL_BUDGET_EXCEEDED");
      const url = new URL(String(input));
      const expectedPath = config.path + (config.provider === "openai" ? "/responses" :
        config.provider === "anthropic" ? "/messages" : "/chat/completions");
      if (url.origin !== config.origin || url.pathname !== expectedPath)
        throw Error("ARCH3_MODEL_ENDPOINT_MISMATCH");
      const raw = String(init?.body || "");
      if (raw.length > MAX_INPUT_CHARS) throw Error("ARCH3_INPUT_BUDGET_EXCEEDED");
      const body = JSON.parse(raw);
      promptChars = bodySystem(body, config.provider).length;
      sentTools = bodyTools(body, config.provider);
      if (typeof body.max_output_tokens === "number") body.max_output_tokens = Math.min(body.max_output_tokens, MAX_OUTPUT_TOKENS);
      if (typeof body.max_tokens === "number") body.max_tokens = Math.min(body.max_tokens, MAX_OUTPUT_TOKENS);
      const response = await realHttpsTransport(input, {...init,body:JSON.stringify(body)});
      const responseText = await response.text();
      if (response.ok) reply = JSON.parse(responseText);
      return {ok: response.ok,status: response.status,
        text: async()=>responseText,json:async()=>JSON.parse(responseText)} as Response;
    }) as typeof fetch;
    try {
      await runDirectAgent({...opts,transport});
    } catch (e) {
      // A selected first tool is deliberately NOT executed. This is the
      // production guard triggered by maxRequests=1, not a provider failure.
      const msg = String((e as Error)?.message || e);
      if (!(reply && /Достигнут лимит обращений к LLM/.test(msg))) {
        networkError = (e as Error)?.name || "ProviderError";
      }
    }
    if (networkError || !reply) break;
    const calls = parseCalls(reply, config.provider);
    const issues = evaluateChoice(c,calls,sentTools);
    if (JSON.stringify(advertised) !== JSON.stringify(sentTools))
      issues.push("provider_advertised_catalog_mismatch");
    rows.push({id:c.id,expected:c.firstTool,actual:calls[0]?.name || null,
      issues,advertised:sentTools.length,promptChars,calls:1});
    process.stdout.write("ARCH3_LIVE_CASE " + JSON.stringify({
      id:c.id,passed:!issues.length,issues,calls:1,promptChars,
    }) + "\n");
  }
  const report = {
    suite:"ARCH-11",provider:config.provider,model:config.model,
    casesExpected:TOOL_CHOICE_CASES.length,executed:rows.length,
    paidCalls:totalCalls,complete:rows.length===TOOL_CHOICE_CASES.length,
    passed:rows.filter(x=>!x.issues.length).length,
    failed:rows.filter(x=>x.issues.length).length,
    networkError:networkError || null,rows,
  };
  fs.writeFileSync(REPORT_PATH,JSON.stringify(report,null,2)+"\n","utf8");
  process.stdout.write("ARCH3_LIVE_SUMMARY " + JSON.stringify({
    provider:report.provider,executed:report.executed,
    passed:report.passed,failed:report.failed,paidCalls:report.paidCalls,
    complete:report.complete,networkError:report.networkError,
  }) + "\n");
  expect(report.complete).toBe(true);
  expect(report.failed).toBe(0);
},300_000);
