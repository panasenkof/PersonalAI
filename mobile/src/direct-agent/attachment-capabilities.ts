import type { ChatAttachment } from "./chat-attachments";
import type { DirectAgentSettings } from "./settings";

export type ImageCapability = "no-images" | "supported" | "unsupported" | "unverified";

/** Validate only a narrow, documented model+endpoint pairing. OpenAI-compatible
 * means wire-format compatibility, NOT proof of image capability. Never
 * infer vision from a provider name or hallucinate a /models response.
 *
 * The relevant result must be recomputed at Send after the user changes model.
 */
export function imageCapability(settings: Pick<DirectAgentSettings,"provider"|"baseUrl"|"model">,
  attachments: readonly Pick<ChatAttachment,"kind">[]): ImageCapability {
  if (!attachments.some(f => f.kind === "image")) return "no-images";
  const model = settings.model.toLowerCase().trim();
  // Known non-chat endpoints cannot accept user image parts in chat.
  if (/^(text-embedding-|whisper-|tts-|omni-moderation-)/.test(model))
    return "unsupported";
  let host = "";
  try { host = new URL(settings.baseUrl).hostname.toLowerCase(); } catch {/* Unknown endpoint stays unverified. */}
  if (settings.provider === "openai-compatible" && host === "api.deepseek.com") {
    // Official DeepSeek vision contract: image inputs available on Flash.
    if (["deepseek-flash","deepseek-v4-flash","deepseek-v4-flash-vision-exp"].includes(model))
      return "supported";
    // Pro currently has no documented image input; legacy chat/reasoner IDs
    // were retired. Fail closed without deleting the unsent photo.
    if (["deepseek-v4-pro","deepseek-chat","deepseek-reasoner"].includes(model))
      return "unsupported";
  }
  // Users may select arbitrary custom/server/LLM models; unknown is NOT false.
  return "unverified";
}

/** Historical messages are never removed from SQLCipher. On a known text-only
 * model we omit only the binary image parts from the outbound history and leave
 * a visible marker so neither the model nor the user treats them as reviewed.
 */
export function historyForImageCapability<T extends {content:string;attachments?:ChatAttachment[]}>(
  rows: T[], capability: ImageCapability,
): T[] {
  if (capability !== "unsupported") return rows;
  return rows.map(row => {
    if (!row.attachments?.some(f => f.kind === "image")) return row;
    return {...row,
      content:row.content + "\n[Изображения из этого старого сообщения не переданы: выбранная модель не поддерживает фото.]",
      attachments:row.attachments.filter(f => f.kind === "text"),
    };
  });
}
