import { fetch as nativeFetch } from 'expo/fetch';
import { File, Directory, Paths, FileMode } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { mediaKind, type ImportFile } from './kinds';

export function publicImportUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); }
  catch { throw new Error('Введите полный адрес публичной HTTPS-ссылки.'); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || !host.includes('.') ||
      host.endsWith('.local') || host.endsWith('.localhost') || host.endsWith('.internal') ||
      /^[\d.]+$/.test(host) || host.includes(':')) throw new Error('Нужна публичная HTTPS-ссылка без логина и пароля.');
  return u.toString();
}
/** Do not pass raw native network errors to memoryErrorMessage: it describes
 * a failed import as a damaged/locked SQLite database and hides the cause.
 * Only app-authored, safe messages may be shown (no signed URLs or headers).
 */
export function linkImportErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^[А-ЯЁ]/u.test(message) && message.length <= 500 && !/[a-f0-9]{64}/i.test(message)) return message;
  return 'Не удалось загрузить ссылку: сетевая ошибка или ограничения сайта. Проверьте соединение, доступность адреса в браузере и попробуйте другой публичный файл.';
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
  let stage: 'соединение' | 'получение ответа' | 'чтение файла' | 'обработка содержимого' = 'соединение';
  try {
    if (signal?.aborted) throw new Error('Загрузка отменена.');
    // Deliberately reject HTTP redirects: native URL following could reach a
    // private host or send a user-selected URL to an unexpected endpoint.
    // Do not add cookies, Referer spoofing or site-specific VPN workarounds.
    const response = await nativeFetch(source, { signal: controller.signal, credentials: 'omit', redirect: 'error' });
    stage = 'получение ответа';
    if (response.status >= 300 && response.status < 400 || response.status === 0)
      throw new Error('Сайт перенаправляет запрос на другой адрес. Автоматические перенаправления для импорта отключены.');
    if (!response.ok) throw new Error('Сайт отказал в загрузке: HTTP ' + response.status + '. Проверьте доступ к файлу в браузере.');
    const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const looksLikeMediaFile = /\\.(mp3|m4a|wav|ogg|flac|aac|mp4|mov|webm|mkv)$/i.test(new URL(source).pathname);
    if (looksLikeMediaFile && (mime === 'text/html' || mime === 'application/xhtml+xml' || mime === 'text/plain'))
      throw new Error('Вместо медиафайла сайт вернул страницу или текст. Возможна проверка VPN, авторизация или недействительная прямая ссылка.');
    const text = mime === 'text/html' || mime.startsWith('text/') || mime === 'application/json';
    const limit = text ? 1024 * 1024 : 80 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) throw new Error('Слишком большой материал по ссылке.');
    const name = decodeURIComponent(new URL(source).pathname.split('/').pop() || 'download');
    if (!text) mediaKind({ uri: source, name, mimeType: mime });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Сервис не вернул содержимое.');
    const dir = new Directory(Paths.cache, 'persai-incoming'); dir.create({ intermediates: true, idempotent: true });
    file = new File(dir, Crypto.randomUUID()); file.create();
    stage = 'чтение файла';
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
      stage = 'обработка содержимого';
      const rawText = await file.text();
      const content = mime === 'text/html' ? pageText(rawText) : rawText;
      if (!content.trim() || content.length > 60_000) throw new Error('Текст пуст или длиннее 60 000 символов. Сохраните нужный фрагмент вручную.');
      file.delete(); return { text: content, source };
    }
    return { file: { uri: file.uri, name, mimeType: mime }, source };
  } catch (error) {
    if (file?.exists) file.delete();
    if (controller.signal.aborted) throw new Error(signal?.aborted ? 'Загрузка отменена.' : 'Загрузка превысила 60 секунд и была остановлена.');
    const safe = linkImportErrorMessage(error);
    if (safe !== linkImportErrorMessage(null)) throw new Error(safe);
    throw new Error('Не удалось загрузить ссылку (этап: ' + stage + '). Возможно, сайт блокирует запрос, перенаправляет его или произошла сетевая ошибка.');
  }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}
