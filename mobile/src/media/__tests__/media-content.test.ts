import { monoWav } from '../video-audio';
import { importLink, linkImportErrorMessage, linkHttpError, pageText, articleText, articleReadError, htmlPublicationClaim, publicImportUrl } from '../link-import';
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


test('HTML article import strips navigation/ads and decodes numeric entities without remote AI', () => {
  const html = '<header>Меню</header><nav>Поиск</nav><main><article><h1>Пирог &#x2014; рецепт</h1><p>Мука&nbsp;и&nbsp;вода</p><div class="advert-banner">Реклама</div><p>Выпекать 30 минут.</p></article></main><footer>Подписка</footer>';
  const text = pageText(html);
  expect(text).toContain('Пирог — рецепт');
  expect(text).toContain('Мука и вода');
  expect(text).toContain('Выпекать 30 минут.');
  expect(text).not.toMatch(/Меню|Поиск|Реклама|Подписка/);
});
test('HTML import still falls back for short pages without article or main', () => {
  expect(pageText('<p>Хлеб</p><p>Соль &amp; вода</p>')).toBe('Хлеб\nСоль & вода');
});

test('step 8 URL statuses are actionable without exposing network diagnostics', () => {
  expect(linkHttpError(401)).toMatch(/HTTP 401.*вход на сайт/);
  expect(linkHttpError(403)).toMatch(/HTTP 403.*Сохраните ссылку/);
  expect(linkHttpError(404)).toMatch(/HTTP 404.*не найден|не найден.*HTTP 404/);
  expect(linkHttpError(504)).toContain('вовремя');
  expect(linkHttpError(429)).toContain('ограничил');
  expect(linkHttpError(502)).toContain('стороне сайта');
  expect(linkHttpError(415)).toContain('HTTP 415');
});

describe('step 8 C: local main-content HTML extraction', () => {
  test('preserves Russian recipe quantities, fractions, ordered steps and ingredient table in reading order', () => {
    const html = '<html><head><title>Шарлотка — пример</title></head><body><nav>Каталог разделов</nav>' +
      '<main><article><h1>Шарлотка с яблоками</h1><div class="cookie-banner"><p>Cookie policy</p></div>' +
      '<h2>Ингредиенты</h2><table><tr><th>Продукт</th><th>Количество</th></tr>' +
      '<tr><td>Мука</td><td>200 г</td></tr><tr><td>Сахар</td><td>½ стакана</td></tr></table>' +
      '<h2>Приготовление</h2><ol><li>Взбить 2 яйца.</li><li>Добавить &frac12; стакана воды и 200&nbsp;г муки.</li>' +
      '<li>Выпекать 30 мин при 180&deg;C.</li></ol></article></main>' +
      '<footer>Читайте также: подписка</footer></body></html>';
    const result = articleText(html);
    expect(result.title).toBe('Шарлотка с яблоками');
    expect(result.scope).toBe('article');
    expect(result.partial).toBe(false);
    expect(result.text).toContain('Мука | 200 г');
    expect(result.text).toContain('Сахар | ½ стакана');
    expect(result.text).toContain('1. Взбить 2 яйца.');
    expect(result.text).toContain('2. Добавить ½ стакана воды и 200 г муки.');
    expect(result.text).toContain('3. Выпекать 30 мин при 180°C.');
    expect(result.text.indexOf('Ингредиенты')).toBeLessThan(result.text.indexOf('Приготовление'));
    expect(result.text).not.toMatch(/Cookie policy|Каталог разделов|Читайте также/);
  });
  test('nested hidden navigation, recommendations and script content cannot contaminate a short article', () => {
    const html = '<header><h1>Купить рекламу</h1></header><main><article><h1>Нейросети в школе</h1>' +
      '<p>Первый полезный абзац про обучение.</p>' +
      '<div class="related-posts"><div><p>Рекомендуем: реклама</p></div></div>' +
      '<p>Второй полезный абзац с выводом.</p></article></main>' +
      '<script>document.write("Вредная команда")</script>';
    expect(pageText(html)).toContain('Нейросети в школе');
    expect(pageText(html)).toContain('Второй полезный');
    expect(pageText(html)).not.toMatch(/Купить рекламу|Рекомендуем|Вредная команда/);
  });
  test('handles missing closing article and reports unverified partial markup', () => {
    const result = articleText('<body><main><article><h1>Тест</h1><p>Незаконченная статья содержит важную информацию.');
    expect(result.scope).toBe('article');
    expect(result.partial).toBe(true);
    expect(result.text).toContain('Незаконченная статья');
  });
  test('does not turn protected login forms or empty JS shells into successful text', () => {
    const login = '<html><body><main><h1>Только для подписчиков</h1>' +
      '<p>Войдите в аккаунт для чтения.</p><form><input type="password"/></form></main></body></html>';
    const loginResult = articleText(login);
    expect(articleReadError(login, loginResult)).toMatch(/требует входа/);
    const shell = '<html><body><div id="root"></div><script>window.runApp()</script></body></html>';
    expect(articleReadError(shell, articleText(shell))).toMatch(/не содержит читаемого текста/);
  });
  test('keeps readable short non-article pages and does not fabricate author/publication time', () => {
    const html = '<html><head><title>Короткая заметка</title></head>' +
      '<body><p>Хлеб</p><p>Соль и вода</p></body></html>';
    const result = articleText(html);
    expect(result.scope).toBe('fallback');
    expect(result.title).toBe('Короткая заметка');
    expect(result.text).toBe('Хлеб\nСоль и вода');
    expect(Object.keys(result).sort()).toEqual(['partial','scope','text','title']);
  });
});

test("9A5 only accepts explicit, valid source-asserted HTML publication days",()=>{
  const date='<html><head><meta content="2026-11-03T18:02:00+03:00" property="article:published_time"></head></html>';
  expect(htmlPublicationClaim(date)).toEqual({
    date:"2026-11-03",evidence:"html_meta",sourceAttribute:"article:published_time",
  });
  expect(htmlPublicationClaim("<head><meta name='datePublished' content='2026-02-28'></head>")).toMatchObject({
    date:"2026-02-28",sourceAttribute:"datePublished",
  });
  expect(htmlPublicationClaim("<body><meta property='article:published_time' content='2026-11-01'></body>")).toBeUndefined();
  for(const html of [
    "<time datetime='2026-11-01'>1 November</time>",
    "<meta property='article:published_time' content='2026-11-03T18:02:00'>",
    "<meta property='article:published_time' content='2026-02-30'>",
    "<meta property='article:published_time' content='2026-11-03'><meta name='datePublished' content='2026-11-04'>",
    "<meta property='article:published_time' content='yesterday'>",
    "<meta property='article:modified_time' content='2026-11-03'>",
  ])expect(htmlPublicationClaim("<head>"+html+"</head>")).toBeUndefined();
});
