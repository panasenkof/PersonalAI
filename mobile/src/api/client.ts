import type {
  Attachment, ChatTurn, Conversation, Fact, JobOut, LLMSettings, Me, MessageOut, Tokens,
} from "../types";

export class ApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}

type Hooks = {
  getBase: () => string;
  getTokens: () => Tokens | null;
  setTokens: (t: Tokens | null) => Promise<void>;
};

let hooks: Hooks | null = null;
export function configureApi(h: Hooks): void {
  hooks = h;
}
const h = (): Hooks => {
  if (!hooks) throw new Error("api not configured");
  return hooks;
};

export const baseUrl = (): string => h().getBase().replace(/\/$/, "");
export const accessToken = (): string | null => h().getTokens()?.access_token ?? null;

function detailOf(body: unknown, status: number): string {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (typeof d === "string") return d;
  if (d) return JSON.stringify(d);
  return `HTTP ${status}`;
}

let refreshing: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  const rt = h().getTokens()?.refresh_token;
  if (!rt) return false;
  // several requests can hit 401 at once: share one refresh call
  refreshing ??= (async () => {
    try {
      const r = await fetch(`${baseUrl()}/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!r.ok) return false;
      await h().setTokens((await r.json()) as Tokens);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

const AUTH_PATHS = ["/v1/auth/token", "/v1/auth/register", "/v1/auth/refresh"];

export async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) || {}) };
  const tokens = h().getTokens();
  if (tokens) headers.Authorization = `Bearer ${tokens.access_token}`;
  let body = init.body;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const r = await fetch(`${baseUrl()}${path}`, { ...init, headers, body });
  if (r.status === 401 && retry && !AUTH_PATHS.includes(path)) {
    if (await refreshTokens()) return request<T>(path, init, false);
    await h().setTokens(null); // session is gone → the UI returns to the login screen
    throw new ApiError(401, "session_expired");
  }
  if (r.status === 204) return undefined as T;
  const data: unknown = await r.json().catch(() => null);
  if (!r.ok) throw new ApiError(r.status, detailOf(data, r.status));
  return data as T;
}

export const api = {
  login: (email: string, password: string, otp?: string) =>
    request<Tokens>("/v1/auth/token", { method: "POST", json: { email, password, otp: otp || undefined } }),
  register: (email: string, password: string) =>
    request<Tokens>("/v1/auth/register", { method: "POST", json: { email, password } }),
  me: () => request<Me>("/v1/auth/me"),
  logoutAll: () => request<void>("/v1/auth/logout-all", { method: "POST" }),
  twofaSetup: () => request<{ secret: string; otpauth_uri: string }>("/v1/auth/2fa/setup", { method: "POST" }),
  twofaEnable: (code: string) =>
    request<{ enabled: boolean; recovery_codes: string[] }>("/v1/auth/2fa/enable", { method: "POST", json: { code } }),
  twofaDisable: (password: string, code: string) =>
    request<{ enabled: boolean }>("/v1/auth/2fa/disable", { method: "POST", json: { password, code } }),

  conversations: () => request<Conversation[]>("/v1/conversations"),
  history: (id: string) => request<ChatTurn[]>(`/v1/conversations/${id}/messages`),
  deleteConversation: (id: string) => request<unknown>(`/v1/conversations/${id}`, { method: "DELETE" }),

  sendMessage: (text: string, conversationId?: string | null, attachments: Attachment[] = []) =>
    request<MessageOut>("/v1/messages", {
      method: "POST",
      json: { text, channel: "mobile", conversation_id: conversationId ?? undefined, attachments },
    }),
  job: (id: string) => request<JobOut>(`/v1/jobs/${id}`),
  cancelJob: (id: string) => request<JobOut>(`/v1/jobs/${id}/cancel`, { method: "POST" }),

  facts: () => request<{ facts: Fact[] }>("/v1/facts"),
  resolveFact: (id: string, action: "confirm" | "reject") =>
    request<unknown>(`/v1/facts/${id}/${action}`, { method: "POST" }),

  llmSettings: () => request<LLMSettings>("/v1/settings/llm"),
  saveLlmSettings: (s: Partial<LLMSettings> & { api_key?: string }) =>
    request<LLMSettings>("/v1/settings/llm", { method: "PATCH", json: s }),
  linkCode: (channel: string) =>
    request<{ code: string; instructions?: string }>(`/v1/channels/${channel}/link-code`, { method: "POST" }),

  async upload(uri: string, name: string, mime: string): Promise<Attachment> {
    const form = new FormData();
    // React Native's FormData accepts {uri,name,type} file descriptors
    form.append("file", { uri, name, type: mime } as unknown as Blob);
    const out = await request<{ storage_key: string; mime: string }>("/v1/blobs", { method: "POST", body: form });
    return { storage_key: out.storage_key, mime: out.mime || mime, filename: name };
  },
};
