import { importLink } from "./link-import";
import { validTelegramTextObservation } from "./source-provenance";

/**
 * A deliberate, read-only comparison of two independently fetched *local text
 * snapshots* of one public Telegram post. Never call this in background.
 * Equality is NOT an upstream revision/edit ID, proof of unchanged attachments
 * or proof that Telegram serves the same content to other readers.
 */
export type TelegramTextRecheckResult = "same_text" | "different_text" | "unverifiable";

export type SavedTelegramSource = {
  sourceUrl?: unknown;
  coverage?: unknown;
  observation?: unknown;
};

export function canRecheckTelegramText(saved: SavedTelegramSource): boolean {
  return validTelegramTextObservation(saved.sourceUrl, saved.coverage, saved.observation);
}

export async function recheckTelegramText(saved: SavedTelegramSource, signal?: AbortSignal):
  Promise<TelegramTextRecheckResult> {
  if (!canRecheckTelegramText(saved)) return "unverifiable";
  // This is the existing explicitly approved HTTPS importer, not a separate
  // fetcher. It checks the exact HTML data-post and forbids redirects/cookies.
  const latest = await importLink(saved.sourceUrl as string, signal);
  if (!validTelegramTextObservation(latest.source, latest.textCoverage,
      latest.telegramObservation)) return "unverifiable";
  const old = saved.observation as {messageKey:string; textSha256:string; textLength:number};
  const observed = latest.telegramObservation!;
  if (old.messageKey.toLowerCase() !== observed.messageKey.toLowerCase()) return "unverifiable";
  return old.textSha256 === observed.textSha256 && old.textLength === observed.textLength
    ? "same_text" : "different_text";
}

export function telegramRecheckMessage(result: TelegramTextRecheckResult): string {
  if (result === "same_text")
    return "Повторно полученный текст совпадает с сохранённым снимком. Кэш на стороне сайта возможен; это не доказывает неизменность вложений или серверной версии Telegram.";
  if (result === "different_text")
    return "Полученный текст отличается от сохранённого снимка. Это не доказательство редактирования поста: измениться могла доступная разметка. Сохранённая заметка не изменена.";
  return "Новый текст именно этого сообщения подтвердить не удалось. Сохранённая заметка не изменена.";
}
