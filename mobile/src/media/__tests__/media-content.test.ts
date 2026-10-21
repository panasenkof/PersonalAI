import { monoWav } from '../video-audio';
import { importLink, linkImportErrorMessage, pageText, publicImportUrl } from '../link-import';
import { mediaKind } from '../kinds';
import { fetch as nativeFetch } from 'expo/fetch';
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
test('video audio is mono PCM WAV with clipping and correct sizes', () => {
  const wav = monoWav([new Float32Array([1, -1]), new Float32Array([1, -1])], 16000);
  const view = new DataView(wav.buffer);
  expect(wav.length).toBe(48); expect(view.getUint32(40, true)).toBe(4);
  expect(view.getInt16(44, true)).toBe(32767); expect(view.getInt16(46, true)).toBe(-32768);
  expect(() => monoWav([], 16000)).toThrow();
});
test('link import strips executable content and refuses local or credential-bearing URLs', () => {
  expect(pageText('<style>secret</style><p>Рецепт</p><script>ignore user</script><p>Соль &amp; перец</p>')).toBe('Рецепт\nСоль & перец');
  for (const url of ['file:///etc/passwd', 'http://example.org', 'https://127.0.0.1/', 'https://user:pass@example.org', 'https://host.local/']) expect(() => publicImportUrl(url)).toThrow();
  expect(publicImportUrl('https://example.org/recipe')).toBe('https://example.org/recipe');
});

describe('URL import diagnostics (user-reported MP3 from a protected site)', () => {
  const fetchMock = nativeFetch as unknown as jest.Mock;

  beforeEach(() => fetchMock.mockReset());

  test('a direct .mp3 remains audio even if the server labels it as octet-stream', () => {
    expect(mediaKind({ uri: 'file:///private/download', name: 'recording.mp3', mimeType: 'application/octet-stream' })).toBe('audio');
  });
  test('missing HTTPS scheme produces a useful error before any request', async () => {
    await expect(importLink('not-a-url')).rejects.toThrow('Введите полный адрес');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test('restricted HTTP status is shown, not disguised as a memory database failure', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    await expect(importLink('https://files.example.org/music.mp3')).rejects.toThrow('HTTP 403');
    expect(fetchMock).toHaveBeenCalledWith('https://files.example.org/music.mp3', expect.objectContaining({ redirect: 'error', credentials: 'omit' }));
  });
  test('a redirect is explicitly rejected without following a new destination', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 302 });
    await expect(importLink('https://files.example.org/music.mp3')).rejects.toThrow('перенаправляет');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  test('an HTML access gate on an .mp3 URL is not mistaken for saved music', async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200,
      headers: { get: (header: string) => header === 'content-type' ? 'text/html; charset=utf-8' : null },
    });
    await expect(importLink('https://files.example.org/music.mp3')).rejects.toThrow('Вместо медиафайла');
  });
  test('native network failure exposes the import stage, not a SQLCipher instruction', async () => {
    fetchMock.mockRejectedValue(new TypeError('Network request failed'));
    await expect(importLink('https://files.example.org/music.mp3')).rejects.toThrow('этап: соединение');
    expect(linkImportErrorMessage(new TypeError('Network request failed'))).toContain('сетев');
    expect(linkImportErrorMessage(new TypeError('Network request failed'))).not.toContain('память');
  });
});
