const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const qa = path.join(root, 'qa');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'persai-mobile-ui-'));
(async () => {
  await esbuild.build({ entryPoints: [path.join(qa, 'entry.tsx')], bundle: true, jsx: 'automatic', outdir: output, platform: 'browser', format: 'iife', define: { global: 'globalThis', __DEV__: 'false', 'process.env.NODE_ENV': '"production"' }, mainFields: ['browser', 'module', 'main'], resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.tsx', '.ts', '.jsx', '.js'], loader: { '.js': 'jsx', '.png': 'file', '.ttf': 'file' }, plugins: [{ name: 'native-fixtures', setup(build) {
    build.onResolve({ filter: /^react-native$/ }, () => ({ path: path.join(qa, 'native.ts') }));
    build.onResolve({ filter: /^@react-navigation\/native$/ }, () => ({ path: path.join(qa, 'navigation.tsx') }));
    build.onResolve({ filter: /auth\/AuthContext$/ }, () => ({ path: path.join(qa, 'auth.tsx') }));
    build.onResolve({ filter: /^\.\/storage$/ }, args => args.importer.includes('/local-memory/') ? ({ path: path.join(qa, 'adapters.tsx') }) : undefined);
    build.onResolve({ filter: /local-memory\/storage$/ }, () => ({ path: path.join(qa, 'adapters.tsx') }));
    build.onResolve({ filter: /local-memory\/repository$/ }, () => ({ path: path.join(qa, 'repository.ts') }));
    build.onResolve({ filter: /^expo-(secure-store|local-authentication|constants|file-system\/legacy|document-picker|video|video-thumbnails|speech-recognition)$/ }, () => ({ path: path.join(qa, 'adapters.tsx') }));
  } }] });
  fs.writeFileSync(path.join(output, 'index.html'), '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}*{box-sizing:border-box}body{font-family:Arial,sans-serif}</style></head><body><div id="root"></div><script>window.process={env:{NODE_ENV:"production",EXPO_OS:"web"}}</script><script src="entry.js"></script></body></html>');
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(output, name === '/' ? 'index.html' : path.basename(name));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream'); fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
    for (const width of [320, 390, 768]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: width === 390 ? "dark" : "light" });
      const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('UI runtime:', error.message); });
      await page.route('**/v1/responses', route => route.fulfill({ json: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'План готов.' }] }] } }));
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByLabel('Спросить ассистента', { exact: true }).waitFor({timeout:10000}).catch(async error => { console.error(await page.locator('body').innerText()); throw error; });
      assert.equal(await page.evaluate(() => window.__qa.auth), 1);
      for (let visit = 0; visit < 3; visit++) {
        await page.getByLabel('Вкладка Память', { exact: true }).click();
        await page.getByLabel('Заголовок заметки', { exact: true }).waitFor();
        await page.getByLabel('Вкладка Ассистент', { exact: true }).click();
      }
      assert.equal(await page.evaluate(() => window.__qa.auth), 1, 'Memory must not ask for separate authentication');
      await page.getByLabel('Настроить подключение ИИ', { exact: true }).click();
      await page.getByLabel('API-ключ LLM', { exact: true }).fill('qa-key');
      await page.getByLabel('Название модели', { exact: true }).fill('gpt-4.1');
      await page.getByLabel('Подключение Anthropic', { exact: true }).click();
      await page.getByLabel('Адрес API LLM', { exact: true }).fill('https://gateway.example/v1');
      await page.getByLabel('API-ключ LLM', { exact: true }).fill('qa-anthropic');
      await page.getByLabel('Подключение OpenAI', { exact: true }).click();
      assert.equal(await page.getByLabel('Название модели', { exact: true }).inputValue(), 'gpt-4.1');
      await page.getByText('Сохранить настройки', { exact: true }).click();
      await page.getByLabel('Сообщение локальному агенту', { exact: true }).waitFor();
      await page.getByLabel('Голосовой ввод', { exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Сообщение локальному агенту"]').value.includes('Купить молоко'));
      assert.equal(await page.getByText('План готов.', { exact: true }).count(), 0, 'Dictation must never autosend');
      await page.getByLabel('Отправить запрос', { exact: true }).click();
      await page.getByText('План готов.', { exact: true }).waitFor();
      await page.getByLabel('Вкладка Память', { exact: true }).click();
      await page.getByLabel('Заголовок заметки', { exact: true }).fill('Покупки');
      await page.getByLabel('Текст заметки', { exact: true }).fill('Молоко и хлеб');
      await page.getByText('Сохранить локально', { exact: true }).click();
      await page.getByLabel('Открыть заметку Покупки', { exact: true }).waitFor();
      await page.getByLabel('Резервная копия и восстановление', { exact: true }).click();
      await page.getByLabel('Создать новый код восстановления', { exact: true }).waitFor();
      await page.getByLabel('Резервная копия и восстановление', { exact: true }).click();
      assert.equal(await page.getByLabel('Создать новый код восстановления', { exact: true }).count(), 0);
      await page.getByLabel('Добавить сведения из файла', { exact: true }).click();
      await page.getByLabel('Выбрать файл для памяти', { exact: true }).click();
      await page.getByText('note.txt', { exact: true }).waitFor();
      await page.getByLabel('Извлечь сведения из файла', { exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Сведения из файла"]').value.includes('индейка'));
      await page.getByLabel('Сохранить сведения в память', { exact: true }).click();
      await page.getByLabel('Открыть заметку note.txt', { exact: true }).waitFor();
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
        console.error(await page.evaluate(() => [...document.querySelectorAll('*')].map(el => ({ tag:el.tagName, label:el.getAttribute('aria-label'), text:el.textContent?.slice(0,80), right:el.getBoundingClientRect().right, width:el.getBoundingClientRect().width })).filter(e=>e.right>innerWidth+1).slice(-12)));
        if(process.env.SCREENSHOT_DIR) { fs.mkdirSync(process.env.SCREENSHOT_DIR,{recursive:true}); await page.screenshot({path:path.join(process.env.SCREENSHOT_DIR,'overflow.png')}); }
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow at ${width}px`);
      await page.evaluate(() => window.__state('background'));
      await page.getByLabel('Разблокировать приложение', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Текст заметки', { exact: true }).count(), 0);
      await page.evaluate(() => window.__state('active'));
      await page.getByLabel('Разблокировать приложение', { exact: true }).click();
      await page.getByLabel('Спросить ассистента', { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      if (process.env.SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `mobile-${width}.png`) });
      }
      console.log(`PASS ${width}px: app lock, repeated memory visits, profiles, save/back, dictation, chat, notes, backup disclosure, file import, background/reunlock, no overflow`);
      await page.close();
    }
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
