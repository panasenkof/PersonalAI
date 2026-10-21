import { fetch as nativeFetch } from 'expo/fetch';
import { File, Directory, Paths, FileMode } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { mediaKind, type ImportFile } from './kinds';

export function publicImportUrl(raw: string): string {
  const u = new URL(raw.trim());
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || !host.includes('.') ||
      host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal') ||
      /^[\d.]+$/.test(host) || host.includes(':')) throw new Error('Нужна публичная HTTPS-ссылка без логина и пароля.');
  return u.toString();
}
export function pageText(html: string): string {
  return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|section)>/gi, '\n').replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim();
}
/** Explicit user action only; no cookies/keys; streaming bound before allocation. */
export async function importLink(raw: string, signal?: AbortSignal): Promise<{ file?: ImportFile; text?: string; source: string }> {
  const source = publicImportUrl(raw);
  const controller = new AbortController();
  const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel);
  const timer = setTimeout(cancel, 60_000);
  let file: File | undefined;
  try {
    if (signal?.aborted) throw new Error('Загрузка отменена.');
    const response = await nativeFetch(source, { signal: controller.signal, credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error('Не удалось скачать: HTTP ' + response.status);
    const mime = (response.headers.get('content-type') || '').split(';')[0];
    const text = mime === 'text/html' || mime.startsWith('text/') || mime === 'application/json';
    const limit = text ? 1024 * 1024 : 80 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Слишком большой материал по ссылке.');
    const name = decodeURIComponent(new URL(source).pathname.split('/').pop() || 'download');
    if (!text) mediaKind({ uri: source, name, mimeType: mime });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Сервис не вернул содержимое.');
    const dir = new Directory(Paths.cache, 'persai-incoming'); dir.create({ intermediates: true, idempotent: true });
    file = new File(dir, Crypto.randomUUID()); file.create();
    const handle = file.open(FileMode.WriteOnly); let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        total += value.length;
        if (total > limit || controller.signal.aborted) throw new Error('Загрузка остановлена или материал слишком большой.');
        handle.writeBytes(value);
      }
    } finally { handle.close(); await reader.cancel().catch(() => {}); }
    if (controller.signal.aborted) throw new Error('Загрузка отменена.');
    if (!total) throw new Error('Материал пуст.');
    if (text) {
      const rawText = await file.text();
      const content = mime === 'text/html' ? pageText(rawText) : rawText;
      if (!content.trim() || content.length > 60_000) throw new Error('Текст пуст или длиннее 60 000 символов. Сохраните нужный фрагмент вручную.');
      file.delete(); return { text: content, source };
    }
    return { file: { uri: file.uri, name, mimeType: mime }, source };
  } catch (e) { if (file?.exists) file.delete(); throw e; }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
