import type { Attachment } from "./attachments";

export type AttachmentPreviewKind = "image" | "audio" | "video" | "unsupported";

/** Metadata only: listing an attachment never decrypts or copies it. */
export function attachmentPreviewKind(attachment: Pick<Attachment, "mime" | "name">): AttachmentPreviewKind {
  const mime = (attachment.mime || "").toLowerCase();
  const extension = attachment.name.split(".").pop()?.toLowerCase() || "";
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif", "heic"].includes(extension)) return "image";
  if (mime.startsWith("audio/") || ["mp3", "m4a", "wav", "ogg", "flac", "aac"].includes(extension)) return "audio";
  if (mime.startsWith("video/") || ["mp4", "mov", "webm", "mkv"].includes(extension)) return "video";
  return "unsupported";
}

export function readableAttachmentSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "Размер неизвестен";
  if (size < 1024) return size + " Б";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " КБ";
  return (size / 1024 / 1024).toFixed(1) + " МБ";
}

export const attachmentKindLabel = (kind: AttachmentPreviewKind) => ({
  image: "Фото", audio: "Аудио", video: "Видео", unsupported: "Файл",
}[kind]);
