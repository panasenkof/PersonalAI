export type Tokens = { email_verification_required?: boolean; access_token: string; refresh_token?: string | null };

export type Me = {
  id: string;
  email: string;
  role: "user" | "admin";
  totp_enabled: boolean;
  email_verified?: boolean;
  channels: Record<"telegram" | "max" | "slack" | "whatsapp" | "discord", boolean>;
};

export type Conversation = {
  id: string;
  channel: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export type ChatTurn = { role: "user" | "assistant"; content: string; created_at: string };

export type Fact = {
  id: string;
  status: "pending_user_confirm" | "committed" | "rejected";
  kind?: string | null;
  summary?: string | null;
};

export type MessageOut = {
  job_id: string;
  status: string;
  assistant_text?: string | null;
  error?: string | null;
  conversation_id?: string | null;
  pending_facts: Fact[];
};

export type JobOut = {
  id: string;
  status: "accepted" | "processing" | "completed" | "failed" | "cancelled" | "awaiting_confirm";
  result?: { assistant_text?: string } | null;
  error?: string | null;
  pending_facts: Fact[];
};

export type LLMSettings = {
  provider_kind: "cloud" | "local";
  base_url: string;
  default_model: string;
  embedding_model: string | null;
  supports_vision: boolean;
};

/** Live progress of one agent run (what the chat screen renders). */
export type ToolStep = {
  key: string;
  name: string;
  state: "composing" | "running" | "ok" | "error";
  args?: string;
  summary?: string;
  ms?: number;
};

export type StreamEvent =
  | { type: "status"; status: string }
  | { type: "token"; content: string }
  | { type: "reset" }
  | { type: "tool_call"; index: number; name: string; arguments_delta: string }
  | { type: "tool_start"; name: string; arguments: string }
  | { type: "tool"; name: string; ok: boolean; summary: string; ms?: number }
  | { type: "done"; text: string; pending_facts?: Fact[]; status?: string; conversation_id?: string }
  | { type: "cancelled"; text?: string }
  | { type: "error"; text: string };

export type Attachment = { mime: string; storage_key: string; filename?: string };

export type ServiceInfo = { name: string; version: string; operator: string; support_email: string; privacy_url: string; terms_url: string; email_enabled: boolean; backup_retention_days: number };
