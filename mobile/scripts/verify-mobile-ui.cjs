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
    build.onResolve({ filter: /^react-native-safe-area-context$/ }, () => ({ path: path.join(qa, 'safe-area.tsx') }));
    build.onResolve({ filter: /^\.\/conversations$/ }, args => args.importer.includes('/direct-agent/') ? ({ path: path.join(qa, 'conversations.ts') }) : undefined);
    // UI acceptance runs without SQLCipher: only the file-import screen gets
    // a browser-backed save implementation; native attachment code remains real.
    build.onResolve({ filter: /^\.\.\/media\/attachments$/ }, args =>
      args.importer.includes('/screens/MemoryImportScreen.') ? ({ path: path.join(qa, 'media-attachments.ts') }) : undefined);
    build.onResolve({ filter: /^\.\/storage$/ }, args => args.importer.includes('/local-memory/') ? ({ path: path.join(qa, 'adapters.tsx') }) : undefined);
    build.onResolve({ filter: /local-memory\/storage$/ }, () => ({ path: path.join(qa, 'adapters.tsx') }));
    build.onResolve({ filter: /local-memory\/repository$/ }, () => ({ path: path.join(qa, 'repository.ts') }));
    // expo-font's web build imports Node's AsyncLocalStorage for server rendering.
    build.onResolve({ filter: /^node:async_hooks$/ }, () => ({ path: path.join(qa, 'adapters.tsx') }));
    build.onResolve({ filter: /^react-native-(executorch|audio-api|blob-util)$/ }, () => ({ path: path.join(qa, 'adapters.tsx') }));
    build.onResolve({ filter: /^expo-(secure-store|local-authentication|constants|file-system(?:\/legacy)?|sharing|document-picker|video|image-manipulator|speech-recognition)$/ }, () => ({ path: path.join(qa, 'adapters.tsx') }));
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
    if (process.env.SCREENSHOT_DIR) fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
    for (const width of [320, 390, 768]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: width === 390 ? "dark" : "light" });
      const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('UI runtime:', error.message); if (process.env.GITHUB_ACTIONS) console.log('::warning title=UI runtime::' + String(error.message).slice(0, 500).replace(/\n/g, '%0A')); });
      let replyNumber = 0;
      let releaseReply;
      let normalizationCalls = 0;
      let normalizationMode = 'normal';
      let releaseNormalization;
      await page.route('**/v1/chat/completions', async route => {
        const body = route.request().postDataJSON();
        if (!body.messages?.[0]?.content?.includes('normalized_text')) {
          await route.fulfill({ json: { choices: [{ message: { content: '{"queries":[],"terms":[],"people":[]}' } }] } }); return;
        }
        normalizationCalls++;
        assert.equal(body.tools, undefined, 'Draft correction never receives tools');
        assert.equal(body.messages.length, 2, 'Draft correction never receives conversation history');
        const draft = JSON.parse(body.messages[1].content).draft;
        const mode = normalizationMode;
        if (mode === 'hold') await new Promise(resolve => { releaseNormalization = resolve; });
        if (mode === 'fail') {
          await route.fulfill({ status: 503, json: { error: { message: 'Temporarily unavailable' } } }); return;
        }
        const normalized = draft.trim().charAt(0).toUpperCase() + draft.trim().slice(1) + '.';
        await route.fulfill({ json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ normalized_text: normalized }) } }] } }).catch(() => {});
      });
      await page.route('**/v1/responses', async route => {
        replyNumber++;
        await new Promise(resolve => { releaseReply = resolve; });
        await route.fulfill({ json: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ответ ' + replyNumber }] }] } });
      });
      await page.clock.install();
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.getByLabel('Сообщение ассистенту', { exact: true }).waitFor({timeout:10000}).catch(async error => { console.error(await page.locator('body').innerText()); throw error; });
      assert.equal(await page.evaluate(() => window.__qa.auth), 1);
      assert.equal(await page.getByLabel('Вкладка Ассистент', { exact: true }).count(), 0);
      assert.equal(await page.getByLabel('Сообщение ассистенту', { exact: true }).isEditable(), true);
      // Use the ACTUAL tab navigator with no system bar, gesture navigation,
      // and three-button navigation metrics, including a live metrics change.
      for (const bottom of [0, 24, 48]) {
        await page.evaluate(value => window.__insets(value), bottom);
        await page.waitForFunction(value => {
          const box = document.querySelector('[aria-label="Вкладка Главная"]').getBoundingClientRect();
          return box.bottom <= innerHeight - value && box.height >= 44;
        }, bottom);
        for (const label of ['Вкладка Главная', 'Вкладка Память', 'Вкладка Настройки']) {
          const box = await page.getByLabel(label, { exact: true }).boundingBox();
          assert(box.height >= 44 && box.y + box.height <= 900 - bottom, `Tab ${label} must clear ${bottom}px system navigation`);
        }
      }
      await page.evaluate(() => window.__insets(24));
      for (let visit = 0; visit < 3; visit++) {
        await page.getByLabel('Вкладка Память', { exact: true }).click();
        await page.getByLabel('Новая заметка', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('Заголовок заметки', { exact: true }).count(), 0, 'The editor is separate from the memory overview');
        await page.getByLabel('Вкладка Главная', { exact: true }).click();
      }
      assert.equal(await page.evaluate(() => window.__qa.auth), 1);
      await page.getByLabel('Выбрать модель и подключение', { exact: true }).click();
      await page.getByLabel('Название модели', { exact: true }).waitFor();
      await page.clock.runFor(500);
      await page.getByLabel('API-ключ LLM', { exact: true }).fill('qa-key');
      await page.getByLabel('Название модели', { exact: true }).fill('gpt-4.1');
      await page.getByLabel('Подключение Anthropic', { exact: true }).click();
      await page.getByLabel('Адрес API LLM', { exact: true }).fill('https://gateway.example/v1');
      await page.getByLabel('API-ключ LLM', { exact: true }).fill('qa-anthropic');
      await page.getByLabel('Подключение OpenAI', { exact: true }).click();
      assert.equal(await page.getByLabel('Название модели', { exact: true }).inputValue(), 'gpt-4.1');
      assert.equal(await page.getByLabel('Разрешить чтение локальной памяти', { exact: true }).count(), 0);
      await page.getByText('Сохранить настройки', { exact: true }).click();
      await page.getByLabel('Сообщение ассистенту', { exact: true }).waitFor();
      const prompt = page.getByLabel('Сообщение ассистенту', { exact: true });
      assert.equal(await page.getByLabel('Очистить сообщение', { exact: true }).count(), 0);
      await prompt.fill('Длинный черновик\nВторая строка');
      await page.getByLabel('Очистить сообщение', { exact: true }).click();
      assert.equal(await prompt.inputValue(), '');
      assert.equal(await prompt.evaluate(el => document.activeElement === el), true, 'Clear keeps keyboard focus in the composer');
      assert.equal(await page.getByLabel('Очистить сообщение', { exact: true }).count(), 0);
      assert.equal(await page.getByLabel('Улучшить текст', { exact: true }).isDisabled(), true);
      const originalDraft = 'нужно купить молоко и хлеб';
      await prompt.fill(originalDraft);
      await page.getByLabel('Улучшить текст', { exact: true }).click();
      await page.getByLabel('Вернуть исходный текст', { exact: true }).waitFor();
      assert.equal(await prompt.inputValue(), 'Нужно купить молоко и хлеб.');
      assert.equal(replyNumber, 0, 'Improvement never sends a chat message');
      const improveButton = await page.getByLabel('Вернуть исходный текст', { exact: true }).boundingBox();
      const micButton = await page.getByLabel('Голосовой ввод', { exact: true }).boundingBox();
      assert(improveButton.x > micButton.x && improveButton.x - micButton.x - micButton.width < 12, 'Improvement is next to the microphone');
      assert(improveButton.x + improveButton.width <= width, 'Improvement fits on a narrow phone');
      await page.getByTestId('action-hint').waitFor();
      const improveHint = await page.getByTestId('action-hint').boundingBox();
      for (const label of ['Добавить сведения из файла', 'Сфотографировать и распознать', 'Голосовой ввод', 'Вернуть исходный текст', 'Отправить запрос']) {
        const box = await page.getByTestId('composer-actions').getByLabel(label, { exact: true }).boundingBox();
        assert(box.x >= 0 && box.x + box.width <= width, `Composer action ${label} stays inside the viewport`);
      }
      assert(improveHint.x >= 0 && improveHint.x + improveHint.width <= width, 'Improvement hint stays inside the viewport');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `draft-improved-${width}.png`) });
      await page.getByLabel('Вернуть исходный текст', { exact: true }).click();
      assert.equal(await prompt.inputValue(), originalDraft);
      await page.getByLabel('Улучшить текст', { exact: true }).click();
      assert.equal(await prompt.inputValue(), 'Нужно купить молоко и хлеб.');
      assert.equal(normalizationCalls, 1, 'Toggling two versions does not spend more model calls');

      normalizationMode = 'hold';
      await prompt.fill('старый черновик');
      await page.getByLabel('Улучшить текст', { exact: true }).click();
      await page.getByLabel('Отменить улучшение текста', { exact: true }).waitFor();
      await page.waitForFunction(() => document.body.textContent.includes('Улучшаю текст'));
      await prompt.fill('ручная правка');
      await page.getByLabel('Улучшить текст', { exact: true }).waitFor();
      releaseNormalization();
      await page.clock.runFor(100);
      assert.equal(await prompt.inputValue(), 'ручная правка', 'A late correction cannot overwrite manual edits');
      await page.getByLabel('Улучшить текст', { exact: true }).click();
      await page.getByLabel('Отменить улучшение текста', { exact: true }).waitFor();
      await page.getByLabel('Отменить улучшение текста', { exact: true }).click();
      releaseNormalization();
      await page.clock.runFor(100);
      assert.equal(await prompt.inputValue(), 'ручная правка', 'Cancellation keeps the original draft');

      normalizationMode = 'fail';
      await page.getByLabel('Улучшить текст', { exact: true }).click();
      await page.getByText(/Не удалось улучшить текст/).waitFor();
      assert.equal(await prompt.inputValue(), 'ручная правка', 'A failed service keeps the original');
      normalizationMode = 'normal';
      await page.getByLabel('Улучшить текст', { exact: true }).click();
      await page.getByLabel('Вернуть исходный текст', { exact: true }).waitFor();
      await page.getByLabel('Очистить сообщение', { exact: true }).click();
      // Clear an active recording, then deliver the service's stale callback.
      await page.evaluate(() => { window.__qa.holdSpeech = true; });
      await page.getByLabel('Голосовой ввод', { exact: true }).click();
      await page.getByLabel('Остановить диктовку', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Улучшить текст', { exact: true }).isDisabled(), true, 'An unfinished transcript cannot be improved');
      await page.evaluate(() => window.__speechEvent('result', { results: [{ transcript: 'Удалить эту диктовку' }], isFinal: false }));
      await page.getByLabel('Очистить сообщение', { exact: true }).click();
      await page.waitForFunction(() => window.__qa.speechAborts === 1);
      await page.evaluate(() => window.__speechEvent('result', { results: [{ transcript: 'Старый результат' }], isFinal: true }));
      assert.equal(await prompt.inputValue(), '', 'A late transcription must not refill a cleared draft');
      await page.evaluate(() => { window.__qa.holdSpeech = false; });
      await page.getByLabel('Голосовой ввод', { exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Сообщение ассистенту"]').value.includes('Купить молоко'));
      assert.equal(replyNumber, 0, 'Dictation never autosends');
      // Sending a draft also ends any still-active dictation for that draft.
      await page.evaluate(() => { window.__qa.holdSpeech = true; });
      await page.getByLabel('Голосовой ввод', { exact: true }).click();
      await page.getByLabel('Остановить диктовку', { exact: true }).waitFor();
      await page.getByLabel('Отправить запрос', { exact: true }).click();
      await page.waitForFunction(() => window.__qa.speechAborts === 2);
      await page.evaluate(() => { window.__qa.holdSpeech = false; window.__speechEvent('result', { results: [{ transcript: 'Запоздалый текст после отправки' }], isFinal: true }); });
      assert.equal(await prompt.inputValue(), '', 'A late transcript cannot refill an already sent draft');

      const sendHint = page.getByText('Отправить написанное сообщение выбранной модели.', { exact: true });
      await sendHint.waitFor();
      const hintBox = await sendHint.boundingBox();
      const buttonBox = await page.getByLabel('Остановить запрос', { exact: true }).boundingBox();
      assert(hintBox.x >= 0 && hintBox.x + hintBox.width <= width, 'Hint stays inside a narrow screen');
      assert(hintBox.y + hintBox.height < buttonBox.y && buttonBox.y - hintBox.y - hintBox.height < 30, 'Composer hint appears right above its button');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `composer-hint-${width}.png`) });

      await page.waitForFunction(() => document.body.textContent.includes('Запрос к LLM'));
      await page.getByLabel('Вкладка Память', { exact: true }).click();
      await page.getByLabel('Вкладка Настройки', { exact: true }).click();
      assert.equal(await page.getByText('Безопасность', { exact: true }).count(), 0);
      await page.getByLabel('Развернуть: Работа ИИ', { exact: true }).click();
      const limitInput = page.getByLabel('Лимит обращений к LLM на сообщение', { exact: true });
      assert.equal(await limitInput.inputValue(), '4');
      await limitInput.fill('0');
      await page.getByLabel('Сохранить лимит обращений к LLM', { exact: true }).click();
      await page.getByText('Укажите целое число обращений к LLM от 1 до 20.', { exact: true }).waitFor();
      await page.setViewportSize({ width, height: 580 });
      await limitInput.fill('6');
      await page.getByLabel('Сохранить лимит обращений к LLM', { exact: true }).click();
      await page.getByText('Лимит сохранён. Он действует для следующих сообщений.', { exact: true }).waitFor();
      await page.getByLabel('Сохранить лимит обращений к LLM', { exact: true }).scrollIntoViewIfNeeded();
      const saveLimitBox = await page.getByLabel('Сохранить лимит обращений к LLM', { exact: true }).boundingBox();
      const settingsTabBox = await page.getByLabel('Вкладка Настройки', { exact: true }).boundingBox();
      assert(saveLimitBox.y + saveLimitBox.height <= settingsTabBox.y, 'The save action can scroll above the tab bar in a reduced viewport');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `agent-limit-${width}.png`) });
      await page.setViewportSize({ width, height: 900 });
      await page.getByLabel('Свернуть: Работа ИИ', { exact: true }).click();
      // Settings groups are folded; the voice group opens and stays open after a reload.
      await page.getByLabel('Развернуть: Голосовой ввод', { exact: true }).click();
      await page.getByRole('radio', { name: 'Системное распознавание', exact: true }).click();
      await page.waitForFunction(() => localStorage.getItem('pia.voice.engine.v1') === 'system' && document.querySelector('[role="radio"][aria-label="Системное распознавание"]')?.getAttribute('aria-checked') === 'true');
      assert.equal(await page.getByRole('radio', { name: 'Системное распознавание', exact: true }).getAttribute('aria-checked'), 'true');
      // A web browser cannot run native Whisper; unsupported devices explain it.
      assert.equal(await page.getByRole('radio', { name: 'Whisper на телефоне', exact: true }).isDisabled(), true);
      assert.equal(await page.getByText('Голос без интернета', { exact: true }).count(), 0, 'Whisper settings are hidden for the system engine');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `voice-settings-${width}.png`) });

      await page.getByLabel('Вкладка Главная', { exact: true }).click();
      await page.getByLabel('Остановить запрос', { exact: true }).waitFor();
      assert.equal(replyNumber, 1, 'Changing tabs must not restart the request');
      await page.waitForFunction(() => document.body.textContent.includes('Запрос к LLM (1/4)'));
      releaseReply();
      await page.getByText('Ответ 1', { exact: true }).waitFor();
      await page.reload();
      await page.getByText('Ответ 1', { exact: true }).waitFor();
      await page.getByLabel('Вкладка Настройки', { exact: true }).click();
      await page.getByLabel('Развернуть: Работа ИИ', { exact: true }).click();
      assert.equal(await page.getByLabel('Лимит обращений к LLM на сообщение', { exact: true }).inputValue(), '6', 'The chosen limit survives a full app reload');
      await page.getByLabel('Увеличить лимит обращений к LLM', { exact: true }).click();
      await page.getByLabel('Сохранить лимит обращений к LLM', { exact: true }).click();
      await page.getByText('Лимит сохранён. Он действует для следующих сообщений.', { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('[role="radio"][aria-label="Системное распознавание"]')?.getAttribute('aria-checked') === 'true');
      assert.equal(await page.getByRole('radio', { name: 'Системное распознавание', exact: true }).getAttribute('aria-checked'), 'true', 'The selected engine survives a full application reload');
      await page.getByLabel('Вкладка Главная', { exact: true }).click();
      await page.getByLabel('Новый диалог', { exact: true }).click();
      await page.getByText('Начать пустой диалог. Предыдущие диалоги останутся в истории.', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Сообщение ассистенту', { exact: true }).inputValue(), '', 'New-chat action opens an empty usable conversation');
      await page.getByLabel('Сообщение ассистенту', { exact: true }).fill('Второй вопрос');
      await page.getByLabel('Отправить запрос', { exact: true }).click();
      await page.waitForFunction(() => document.body.textContent.includes('Запрос к LLM (1/7)'));
      await page.waitForFunction(() => document.body.textContent.includes('Запрос к LLM'));
      const beforeHistory = await page.evaluate(() => window.__qa.modalShows || 0);
      await page.getByLabel('История диалогов', { exact: true }).click();
      await page.getByLabel('Поиск диалогов', { exact: true }).waitFor();
      await page.clock.runFor(350);
      assert.equal(await page.evaluate(() => window.__qa.modalShows), beforeHistory + 1, 'History Dialog must remain mounted after Android blur');
      assert.equal(await page.getByText('PersAI · Защищено', { exact: true }).count(), 0);
      await page.getByLabel('Открыть диалог Купить молоко и хлеб', { exact: true }).click();
      await page.getByLabel('Поиск диалогов', { exact: true }).waitFor({ state: 'hidden' });
      await page.getByText('Ответ 1', { exact: true }).waitFor();
      releaseReply();
      await page.getByLabel('История диалогов', { exact: true }).click();
      await page.getByLabel('Открыть диалог Второй вопрос', { exact: true }).click();
      await page.getByLabel('Поиск диалогов', { exact: true }).waitFor({ state: 'hidden' });
      await page.getByText('Ответ 2', { exact: true }).waitFor();
      await page.getByLabel('Вкладка Память', { exact: true }).click();
      const beforeSection = await page.evaluate(() => window.__qa.modalShows || 0);
      await page.getByLabel('Новый раздел памяти', { exact: true }).click();
      await page.getByLabel('Название раздела памяти', { exact: true }).fill('Рецепты');
      await page.clock.runFor(350);
      assert.equal(await page.evaluate(() => window.__qa.modalShows), beforeSection + 1, 'Section Dialog must not oscillate on focus loss');
      await page.setViewportSize({ width, height: 470 }); await page.evaluate(() => window.__insets(48));
      await page.waitForFunction(() => document.querySelector('[aria-label="Создать раздел"]').getBoundingClientRect().bottom <= innerHeight - 48);
      const createBox = await page.getByLabel('Создать раздел', { exact: true }).boundingBox();
      assert(createBox.y + createBox.height <= 470 - 48, 'Section action clears a three-button system bar in a reduced viewport');
      if (process.env.SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `section-${width}.png`) });
      }
      await page.getByLabel('Создать раздел', { exact: true }).click();
      await page.getByLabel('Раздел Рецепты', { exact: true }).waitFor();
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => window.__insets(24));
      await page.getByLabel('Новая заметка', { exact: true }).click();
      await page.getByLabel('Заголовок заметки', { exact: true }).fill('Индейка');
      await page.getByLabel('Текст заметки', { exact: true }).fill('Чеснок и паприка');
      await page.getByLabel('Сохранить запись', { exact: true }).click();
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).waitFor();
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).click();
      await page.getByLabel('Текст заметки', { exact: true }).fill('Чеснок, паприка и перец');
      // Schema v3: the record type and other names are edited with the text.
      await page.getByLabel('Тип записи: Факт', { exact: true }).click();
      await page.getByLabel('Другие имена и прозвища', { exact: true }).fill('Индюшка, индюк');
      await page.getByLabel('Сохранить запись', { exact: true }).click();
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).click();
      assert.equal(await page.getByLabel('Другие имена и прозвища', { exact: true }).inputValue(), 'Индюшка, индюк');
      assert.equal(await page.getByLabel('Тип записи: Факт', { exact: true }).getAttribute('aria-selected'), 'true', 'The chosen record type is kept');
      await page.getByLabel('История, события и связи', { exact: true }).click();
      await page.getByText('История изменений · версия 3', { exact: true }).waitFor();
      await page.getByLabel('Архивировать запись', { exact: true }).click();
      assert.equal(await page.getByLabel('Открыть заметку Индейка', { exact: true }).count(), 0);
      await page.getByLabel('Открыть архив', { exact: true }).click();
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).click();
      await page.getByLabel('Вернуть запись из архива', { exact: true }).click();
      if (await page.getByLabel('Открыть текущие записи', { exact: true }).count()) await page.getByLabel('Открыть текущие записи', { exact: true }).click();
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).waitFor();
      await page.getByLabel('Поиск по заметкам', { exact: true }).fill('НичегоПодобного');
      await page.clock.runFor(300);
      await page.getByText('Ничего не найдено', { exact: true }).waitFor();
      await page.getByLabel('Поиск по заметкам', { exact: true }).fill(''); await page.clock.runFor(300);
      await page.getByRole('button', { name: 'Резервные копии', exact: true }).click();
      await page.getByLabel('Создать новый код восстановления', { exact: true }).waitFor();
      await page.getByLabel(/back/i).click();
      await page.getByLabel('Раздел Все записи', { exact: true }).click();
      await page.getByRole('button', { name: 'Добавить сведения из файла', exact: true }).click();
      const authenticationCount = await page.evaluate(() => window.__qa.auth);
      await page.getByLabel('Выбрать файл для памяти', { exact: true }).click();
      await page.getByText('note.txt', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__qa.auth), authenticationCount, 'A short file-picker switch must not ask for biometrics');
      await page.getByLabel('Извлечь сведения из файла', { exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Распознанное содержимое файла"]').value.includes('индейка'));
      await page.getByLabel('Сохранить сведения в память', { exact: true }).click();
      await page.getByLabel('Открыть заметку note.txt', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow at ${width}px`);
      if (process.env.SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `memory-${width}.png`) });
      }
      // Narrow available height approximates the resized viewport, while the
      // native IME and gesture/three-button navigation still need phone QA.
      await page.getByLabel('Вкладка Главная', { exact: true }).click();
      await page.setViewportSize({ width, height: 470 });
      await page.getByLabel('Сообщение ассистенту', { exact: true }).fill('Черновик');
      const clearBox = await page.getByLabel('Очистить сообщение', { exact: true }).boundingBox();
      assert(clearBox.x >= 0 && clearBox.x + clearBox.width <= width && clearBox.y + clearBox.height <= 470 - 24, 'Clear remains reachable with the keyboard viewport');
      const sendBox = await page.getByLabel('Отправить запрос', { exact: true }).boundingBox();
      assert(sendBox.y + sendBox.height <= 470 - 24, 'Composer leaves space for the system bottom inset');
      await page.getByLabel('История диалогов', { exact: true }).click();
      await page.getByLabel('Поиск диалогов', { exact: true }).fill('Второй');
      await page.evaluate(() => window.__insets(48));
      await page.waitForFunction(() => document.querySelector('[aria-label="Открыть диалог Второй вопрос"]').getBoundingClientRect().bottom <= innerHeight - 48);
      const historyBox = await page.getByLabel('Открыть диалог Второй вопрос', { exact: true }).boundingBox();
      assert(historyBox.y + historyBox.height <= 470 - 48, 'History row clears the system bar in a reduced viewport');
      await page.getByText('+ Новый диалог', { exact: true }).scrollIntoViewIfNeeded();
      const historyAction = await page.getByText('+ Новый диалог', { exact: true }).boundingBox();
      assert(historyAction.y + historyAction.height <= 470 - 48, 'The last sheet action is reachable above system navigation');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `history-${width}.png`) });
      await page.getByLabel('Открыть диалог Второй вопрос', { exact: true }).click();
      await page.getByLabel('Поиск диалогов', { exact: true }).waitFor({ state: 'hidden' });
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => window.__insets(24));
      await page.getByLabel('История диалогов', { exact: true }).click();
      await page.getByLabel('Поиск диалогов', { exact: true }).waitFor();
      await page.evaluate(() => window.__state('background'));
      await page.getByText('PersAI · Защищено', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Поиск диалогов', { exact: true }).count(), 0, 'Native modal must be removed above the privacy cover');
      assert.equal(await page.getByLabel('Разблокировать приложение', { exact: true }).count(), 0);
      await page.clock.fastForward(30000); await page.evaluate(() => window.__state('active'));
      await page.getByText('Ответ 2', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__qa.auth), authenticationCount);
      await page.evaluate(() => window.__state('background'));
      await page.clock.fastForward(5 * 60 * 1000);
      await page.getByLabel('Разблокировать приложение', { exact: true }).waitFor();
      await page.evaluate(() => window.__state('active'));
      await page.getByLabel('Разблокировать приложение', { exact: true }).click();
      await page.getByText('Ответ 2', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__qa.auth), authenticationCount + 1);
      await page.getByLabel('Закрыть панель Мои диалоги', { exact: true }).click();
      await page.getByLabel('Поиск диалогов', { exact: true }).waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `home-${width}.png`) });
      console.log(`PASS ${width}px: production app/navigation, 0/24/48px system insets, Android Modal focus events, named actions, persisted chats, work across tabs/dialogs, memory CRUD, profiles, picker, five-minute session and reduced viewport`);

      await page.close();
    }
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => {
  console.error(error);
  // In GitHub Actions this becomes an annotation, readable without the raw log.
  if (process.env.GITHUB_ACTIONS) console.log('::error title=Browser acceptance::' + String(error && (error.stack || error.message) || error).slice(0, 1800).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
  process.exitCode = 1;
});
