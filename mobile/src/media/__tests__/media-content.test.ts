import { monoWav } from '../video-audio';
import { pageText, publicImportUrl } from '../link-import';
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
