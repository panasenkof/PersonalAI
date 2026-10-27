export type ImportFile = { uri: string; name: string; mimeType?: string | null; size?: number; duration?: number };
export type MediaKind = "image" | "audio" | "video" | "text" | "document";
export function mediaKind(file: ImportFile): MediaKind {
  const mime = file.mimeType || "";
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (mime === "application/pdf" || ext === "pdf") return "document";
  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "webp", "gif"].includes(ext || "")) return "image";
  if (mime.startsWith("audio/") || ["mp3", "m4a", "wav", "ogg", "flac", "aac"].includes(ext || "")) return "audio";
  if (mime.startsWith("video/") || ["mp4", "mov", "webm", "mkv"].includes(ext || "")) return "video";
  if (mime.startsWith("text/") || ["txt", "md", "csv", "json", "log", "srt", "vtt"].includes(ext || "")) return "text";
  throw new Error("Выберите изображение, PDF, аудио, видео или текстовый файл.");
}
