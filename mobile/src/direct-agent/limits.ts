/** Output budget for one model call. */
export const MAX_DIRECT_REPLY_TOKENS = 4000;
/** Longer user messages must be rejected visibly, not silently sliced before the model sees them. */
export const MAX_USER_PROMPT_CHARS = 24_000;
/** Reasoning models spend part of the output budget on hidden reasoning. */
export const MAX_REASONING_REPLY_TOKENS = 8000;
export const TRUNCATED_NOTE = "\n\n(Ответ обрезан по лимиту длины. Попросите продолжить, если нужно.)";

/** OpenAI reasoning families accept reasoning.encrypted_content; other models
 * (gpt-4.1, gpt-4o and compatible models) reject it with HTTP 400. */
export function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5|codex)/i.test(model.trim().split("/").pop() || "");
}
