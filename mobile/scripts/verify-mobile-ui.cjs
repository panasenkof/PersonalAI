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
    build.onResolve({ filter: /^\.\/attachments$/ }, args => /media\/(MemoryCover|AttachmentView|AppendNoteAttachments)\./.test(args.importer) ? ({ path: path.join(qa, 'memory-previews.ts') }) : undefined);
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
  let currentPage;
  try {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] });
    if (process.env.SCREENSHOT_DIR) fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
    for (const width of process.env.UI_WIDTHS ? process.env.UI_WIDTHS.split(",").map(Number) : [320, 360, 390, 430, 768]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: width === 390 ? "dark" : "light" });
      currentPage = page;
      const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error('UI runtime:', error.message); if (process.env.GITHUB_ACTIONS) console.log('::warning title=UI runtime::' + String(error.message).slice(0, 500).replace(/\n/g, '%0A')); });
      // Browser layout check for enlarged text; native font scaling and TalkBack remain device checks.
      async function captureAction(name, label) {
        if (!process.env.SCREENSHOT_DIR) return;
        const button = page.getByLabel(label, {exact:true}).first();
        await button.click({trial:true});
        const capture = suffix => page.screenshot({animations:"disabled", path:path.join(process.env.SCREENSHOT_DIR, name+"-"+width+suffix+".png")});
        await capture("");
        if (width > 360) return;
        await page.evaluate(() => {
          const texts = [...document.querySelectorAll('div,span,textarea')].filter(el =>
            [...el.childNodes].some(node => node.nodeType === 3 && node.textContent.trim()) || el.tagName === "TEXTAREA");
          window.__qaRestoreText = texts.map(el => [el, el.style.fontSize, el.style.lineHeight]);
          const sizes = texts.map(el => [parseFloat(getComputedStyle(el).fontSize), parseFloat(getComputedStyle(el).lineHeight)]);
          texts.forEach((el,i) => { el.style.fontSize = sizes[i][0]*1.5+"px"; if (sizes[i][1]) el.style.lineHeight = sizes[i][1]*1.5+"px"; });
        });
        try {
          await button.click({trial:true});
          const box = await button.boundingBox();
          assert(box && box.x >= -1 && box.x + box.width <= width + 1, name+" enlarged action exceeds viewport");
          await capture("-large");
        } finally {
          await page.evaluate(() => {
            for (const [el,size,height] of window.__qaRestoreText) { el.style.fontSize=size; el.style.lineHeight=height; }
            delete window.__qaRestoreText;
          });
        }
      }
      let replyNumber = 0;
      let releaseReply;
      let normalizationCalls = 0;
      let normalizationMode = 'normal';
      let releaseNormalization;
      await page.route('**/v1/chat/completions', async route => {
        const body = route.request().postDataJSON();
        if (body.messages?.[0]?.content?.includes('Ты редактор одной личной заметки')) {
          const input = JSON.parse(body.messages[1].content);
          assert.equal(body.tools, undefined);
          assert.deepEqual(Object.keys(input).sort(), ['instruction', 'note']);
          await route.fulfill({ json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ title: input.note.title, body: 'Чеснок, паприка и перец' }) } }] } }); return;
        }
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
        if (replyNumber === 1) {
          const body = route.request().postDataJSON();
          assert(JSON.stringify(body.input).includes('Рецепт: индейка'), 'Real Responses transport receives the attached text');
        }
        await new Promise(resolve => { releaseReply = resolve; });
        await route.fulfill({ json: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Ответ ' + replyNumber }] }] } });
      });
      // Browser speech fixture simulates a prior explicit Settings consent.
      // Consent UI/denial paths have separate Jest tests; never grant in app code.
      await page.addInitScript(() => localStorage.setItem('pia.voice.system-online-consent.v1', 'true'));
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
        await page.getByLabel('Добавить в память', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('Заголовок заметки', { exact: true }).count(), 0, 'The editor is separate from the memory overview');
        await page.getByLabel('Вкладка Главная', { exact: true }).click();
      }
      assert.equal(await page.evaluate(() => window.__qa.auth), 1);
      // Connection settings live in Settings, not the status header.
      assert.equal(await page.getByLabel('Выбрать модель и подключение', { exact: true }).count(), 0);
      await page.getByTestId('nebula-home-status').waitFor();
      await page.getByLabel('Вкладка Настройки', { exact: true }).click();
      await page.getByLabel('Модели и подключения', { exact: true }).click();
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
      // The contextual connection action is a real Nebula button. A cancelled
      // removal must preserve the selected model and cannot persist anything.
      await page.getByLabel('Удалить подключение', { exact: true }).click();
      await page.getByText('Убрать подключение?', { exact: true }).waitFor();
      const removeBox = await page.getByLabel('Убрать из списка', { exact: true }).boundingBox();
      assert(removeBox && removeBox.height >= 48 && removeBox.x >= 0 && removeBox.x + removeBox.width <= width,
        'Connection removal confirmation must be a reachable 48dp Nebula button');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({animations:'disabled',path:path.join(process.env.SCREENSHOT_DIR,`connections-remove-${width}.png`)});
      await page.getByLabel('Оставить подключение', { exact: true }).click();
      assert.equal(await page.getByLabel('Название модели', { exact: true }).inputValue(), 'gpt-4.1',
        'Cancel connection removal keeps the edited model');
      await page.getByText('Сохранить настройки', { exact: true }).click();
      await page.getByLabel('Вкладка Главная', { exact: true }).click();
      await page.getByLabel('Сообщение ассистенту', { exact: true }).waitFor();
      const prompt = page.getByLabel('Сообщение ассистенту', { exact: true });
      assert.equal(await page.getByLabel('Очистить сообщение', { exact: true }).count(), 0);
      // A photo description is a normal LLM message. No extra hidden
      // local-search shortcut or paid request occurs until the user taps Send.
      await prompt.fill('фото красного велосипеда');
      assert.equal(await page.getByLabel('Поискать в моих фото', {exact:true}).count(),0,
        'There must be no duplicate direct local photo-search button');
      const agentSend=page.getByLabel('Отправить запрос', {exact:true});
      const sendPhotoBox=await agentSend.boundingBox();
      assert(sendPhotoBox && sendPhotoBox.height >= 44 &&
        sendPhotoBox.x >= 0 && sendPhotoBox.x + sendPhotoBox.width <= width,
        'Photo intent uses the same accessible chat Send button');
      assert.equal(await agentSend.isDisabled(),false,
        'Configured LLM should accept a photo-search description');
      assert.equal(replyNumber,0,'Typing a photo description never silently sends a paid model request');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({animations:'disabled',
        path:path.join(process.env.SCREENSHOT_DIR,`chat-photo-agent-route-${width}.png`)});
      await prompt.fill('');

      const showShare = async payloads => {
        await page.evaluate(payloads => { window.__incoming=payloads;window.__qa.androidShare=true;window.__state('active'); },payloads);
        await page.clock.runFor(600);
        await page.getByText('Куда добавить?',{exact:true}).waitFor();
        await page.evaluate(()=>{window.__qa.androidShare=false;});
      };
      await prompt.fill('Мой черновик');
      await showShare([{shareType:'url',value:'https://example.org/shared'}, {shareType:'file',value:'content://provider/shared.txt',mimeType:'text/plain'}]);
      await page.getByLabel('Добавить входящее в чат',{exact:true}).waitFor();
      await page.waitForFunction(()=>!document.querySelector('[aria-label="Добавить входящее в чат"]').disabled);
      const shareCancel = page.getByLabel('Отменить приём материала', {exact:true});
      const shareCancelBox = await shareCancel.boundingBox();
      const shareCancelBorder = await shareCancel.evaluate(el => parseFloat(getComputedStyle(el).borderTopWidth));
      assert(shareCancelBox && shareCancelBox.height >= 22 && shareCancelBox.height <= 30 &&
        shareCancelBorder >= 1 && shareCancelBox.x >= 0 &&
        shareCancelBox.x + shareCancelBox.width <= width,
        'Share Cancel is a visible, framed half-height secondary button inside the viewport');
      if(process.env.SCREENSHOT_DIR) await page.screenshot({animations:'disabled',path:path.join(process.env.SCREENSHOT_DIR,`share-choice-${width}.png`)});
      assert.equal(replyNumber,0,'Share preview does not send');
      await page.getByLabel('Добавить входящее в чат',{exact:true}).click();
      await page.getByLabel('Убрать вложение shared.txt',{exact:true}).waitFor();
      assert.equal(await prompt.inputValue(),'Мой черновик\n\nhttps://example.org/shared','Share appends to existing draft');
      assert.equal(replyNumber,0,'Choosing chat only prepares a draft');
      await page.getByLabel('Убрать вложение shared.txt',{exact:true}).click();
      await showShare([{shareType:'audio',value:'content://provider/voice.mp3',mimeType:'audio/mpeg'}]);
      assert.equal(await page.getByLabel('Добавить входящее в чат',{exact:true}).isDisabled(),true);
      await page.getByLabel('Отменить приём материала',{exact:true}).click();
      assert.equal(await prompt.inputValue(),'Мой черновик\n\nhttps://example.org/shared','Cancel preserves draft');
      await showShare([{shareType:'text',value:'Тестовая входящая заметка'}]);
      const notesBeforeShare=await page.evaluate(()=>localStorage.getItem('qa.notes'));
      await page.getByLabel('Добавить входящее в память',{exact:true}).click();
      await page.getByLabel('Сведения из файла',{exact:true}).waitFor();
      assert.equal(await page.getByLabel('Сведения из файла',{exact:true}).inputValue(),'Тестовая входящая заметка');
      assert.equal(await page.evaluate(()=>localStorage.getItem('qa.notes')),notesBeforeShare,'Choosing memory does not autosave');
      await page.getByLabel(/back/i).click();
      await page.getByLabel('Продолжить редактирование', { exact: true }).waitFor();
      assert.equal(await page.evaluate(()=>localStorage.getItem('qa.notes')), notesBeforeShare,
        'Back to an unsaved import cannot silently save');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ animations:'disabled',
        path:path.join(process.env.SCREENSHOT_DIR,`import-leave-confirm-${width}.png`) });
      await page.getByLabel('Продолжить редактирование', { exact: true }).click();
      assert.equal(await page.getByLabel('Сведения из файла', { exact: true }).inputValue(), 'Тестовая входящая заметка',
        'Cancelling Back retains the imported draft');
      await page.getByLabel(/back/i).click();
      await page.getByLabel('Закрыть без сохранения', { exact: true }).click();
      await prompt.waitFor();
      await prompt.fill('Длинный черновик\nВторая строка');
      await page.getByLabel('Очистить сообщение', { exact: true }).click();
      assert.equal(await prompt.inputValue(), '');
      // Native/web focus restoration occurs after React removes the clear
      // control and may settle in the next frame when the artwork reflows.
      // Still fail if focus isn't restored: never mask lost IME focus.
      await page.waitForFunction(() => {
        const input = document.querySelector('[aria-label="Сообщение ассистенту"]');
        return input && document.activeElement === input;
      }, null, { timeout: 2500 });
      // A transient focus() is not enough: clear remounts VoiceInput and
      // resizes Nebula's empty state. Focus must survive the next UI frames.
      await page.clock.runFor(120);
      assert.equal(await prompt.evaluate(el => document.activeElement === el), true, 'Clear keeps keyboard focus in the composer after layout settles');
      assert.equal(await page.getByLabel('Очистить сообщение', { exact: true }).count(), 0);
      // The default/system engine must not expose the Whisper-only cleanup
      // control, even after typing. Its normalization request budget stays zero.
      assert.equal(await page.getByLabel('Улучшить текст', { exact: true }).count(), 0,
        'Google/system dictation hides Whisper-only improvement');
      const originalDraft = 'нужно купить молоко и хлеб';
      await prompt.fill(originalDraft);
      assert.equal(await page.getByLabel('Улучшить текст', { exact: true }).count(), 0);
      assert.equal(normalizationCalls, 0, 'Google does not run a cleanup LLM request');
      const micButton = await page.getByTestId('composer-actions').getByLabel('Голосовой ввод', { exact: true }).boundingBox();
      assert(micButton && micButton.width >= 44, 'Microphone remains tappable without improvement');
      let composerRowY = null;
      for (const label of ['Прикрепить файл к сообщению', 'Сделать снимок', 'Голосовой ввод', 'Отправить запрос']) {
        const box = await page.getByTestId('composer-actions').getByLabel(label, { exact: true }).boundingBox();
        assert(box.x >= 0 && box.x + box.width <= width, `Composer action ${label} stays inside the viewport`);
        assert(box.height >= 44, `Composer action ${label} has a usable touch target`);
        if (composerRowY === null) composerRowY = box.y;
        assert(Math.abs(box.y - composerRowY) <= 3, `Composer action ${label} remains in one row at ${width}px`);
      }
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `draft-google-no-improve-${width}.png`) });
      await page.getByLabel('Очистить сообщение', { exact: true }).click();
      // Clear an active recording, then deliver the service's stale callback.
      await page.evaluate(() => { window.__qa.holdSpeech = true; });
      await page.getByTestId('composer-actions').getByLabel('Голосовой ввод', { exact: true }).click();
      await page.getByLabel('Остановить диктовку', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Улучшить текст', { exact: true }).count(), 0, 'Google has no cleanup button during dictation');
      await page.evaluate(() => window.__speechEvent('result', { results: [{ transcript: 'Удалить эту диктовку' }], isFinal: false }));
      await page.getByLabel('Очистить сообщение', { exact: true }).click();
      await page.waitForFunction(() => window.__qa.speechAborts === 1);
      await page.evaluate(() => window.__speechEvent('result', { results: [{ transcript: 'Старый результат' }], isFinal: true }));
      assert.equal(await prompt.inputValue(), '', 'A late transcription must not refill a cleared draft');
      await page.evaluate(() => { window.__qa.holdSpeech = false; });
      await page.getByTestId('composer-actions').getByLabel('Голосовой ввод', { exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Сообщение ассистенту"]').value.includes('Купить молоко'));
      assert.equal(replyNumber, 0, 'Dictation never autosends');
      await page.getByLabel('Прикрепить файл к сообщению', { exact: true }).click();
      await page.clock.runFor(100);
      await page.getByLabel('Убрать вложение note.txt', { exact: true }).waitFor();
      assert.equal(replyNumber, 0, 'Picking never sends to the model');
      await page.getByLabel('Убрать вложение note.txt', { exact: true }).click();
      await page.getByLabel('Прикрепить файл к сообщению', { exact: true }).click();
      await page.clock.runFor(100);
      await page.getByLabel('Убрать вложение note.txt', { exact: true }).waitFor();
      const removeButton = page.getByLabel('Убрать вложение note.txt', { exact: true });
      const attachmentRemoveBox = await removeButton.boundingBox();
      const removeBorder = await removeButton.evaluate(el => parseFloat(getComputedStyle(el).borderTopWidth));
      assert(attachmentRemoveBox && attachmentRemoveBox.height >= 22 && attachmentRemoveBox.height <= 30 &&
        removeBorder >= 1 && attachmentRemoveBox.x >= 0 &&
        attachmentRemoveBox.x + attachmentRemoveBox.width <= width,
        'Attachment Remove is a framed half-height secondary button inside the viewport');
      await page.clock.runFor(6000);
      if (process.env.SCREENSHOT_DIR) await page.screenshot({animations:'disabled', path:path.join(process.env.SCREENSHOT_DIR, `chat-attachment-${width}.png`)});

      // Sending a draft also ends any still-active dictation for that draft.
      await page.evaluate(() => { window.__qa.holdSpeech = true; });
      await page.getByTestId('composer-actions').getByLabel('Голосовой ввод', { exact: true }).click();
      await page.getByLabel('Остановить диктовку', { exact: true }).waitFor();
      await page.getByLabel('Отправить запрос', { exact: true }).click();
      await page.waitForFunction(() => window.__qa.speechAborts === 2);
      await page.evaluate(() => { window.__qa.holdSpeech = false; window.__speechEvent('result', { results: [{ transcript: 'Запоздалый текст после отправки' }], isFinal: true }); });
      assert.equal(await prompt.inputValue(), '', 'A late transcript cannot refill an already sent draft');

      // Real production rows (not a mocked chat layout) must keep the submitted
      // bubble visible above the composer while the LLM request is pending.
      const userBubble = page.getByTestId('chat-message-user').last();
      await userBubble.waitFor();
      const userBox = await userBubble.boundingBox();
      const promptBox = await prompt.boundingBox();
      assert(userBox && promptBox && userBox.y >= 0 &&
        userBox.y + userBox.height <= promptBox.y, 'Sent question remains visible above the composer');

      // A tap must send immediately without a bubble obscuring the composer.
      // When Send changes to Stop, the old action must not remain visible.
      const stopButton = page.getByLabel('Остановить запрос', { exact: true });
      await stopButton.waitFor();
      assert.equal(await page.getByText('Отправить написанное сообщение выбранной модели.', { exact: true }).count(), 0,
        'No stale Send hint is visible once the action becomes Stop');
      const buttonBox = await stopButton.boundingBox();
      assert(buttonBox && buttonBox.width >= 48 && buttonBox.height >= 48 &&
        buttonBox.x >= 0 && buttonBox.x + buttonBox.width <= width,
        'Stop remains a reachable 48dp button even on narrow screens');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `composer-stop-${width}.png`) });

      await page.waitForFunction(() => /Подключаюсь|Думаю|Обрабатываю|Пишу ответ/.test(document.querySelector('[data-testid="nebula-home-status"]')?.textContent || ''));
      await page.getByLabel('Вкладка Память', { exact: true }).click();
      await page.getByLabel('Вкладка Настройки', { exact: true }).click();
      assert.equal(await page.getByText('Безопасность', { exact: true }).count(), 0);
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `settings-overview-${width}.png`) });
      const settingsCanvas = await page.getByTestId('settings-overview').evaluate(el => getComputedStyle(el).backgroundColor);
      assert.equal(settingsCanvas, 'rgb(7, 13, 32)', 'Working screens use the approved dark theme regardless of OS appearance');
      assert(await page.getByLabel('Модели и подключения', { exact: true }).count());
      // Settings is now an index of real screen-sized actions. A detail is
      // immediately expanded and Back returns to the same index, not the chat.
      await page.getByLabel('Распознавание файлов', { exact: true }).click();
      await page.getByTestId('settings-detail').waitFor();
      const photoProvider = page.getByLabel('Изображения и кадры видео: Anthropic', { exact: true });
      await photoProvider.waitFor();
      await photoProvider.click();
      await page.getByText('Выбор для медиа сохранён.', { exact: true }).waitFor();
      assert.equal(await photoProvider.getAttribute('aria-checked'), 'true', 'The media choice uses one canonical writer');
      assert.equal(await page.getByText('Сохранить выбор для медиа', { exact: true }).count(), 0, 'There is no duplicate Save');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `settings-media-${width}.png`) });
      await page.getByLabel(/back/i).click();
      await page.getByTestId('settings-overview').waitFor();

      await page.getByLabel('Работа ИИ', { exact: true }).click();
      const limitInput = page.getByLabel('Лимит обращений к LLM на сообщение', { exact: true });
      await limitInput.waitFor();
      assert.equal(await limitInput.inputValue(), '5', 'New profiles start with the five-call default');
      await limitInput.fill('0');
      await page.getByLabel('Сохранить лимит обращений к LLM', { exact: true }).click();
      await page.getByText('Укажите целое число обращений к LLM от 1 до 20.', { exact: true }).waitFor();
      await page.setViewportSize({ width, height: 580 });
      await limitInput.fill('6');
      await page.getByLabel('Сохранить лимит обращений к LLM', { exact: true }).click();
      await page.getByText('Лимит сохранён. Он действует для следующих сообщений.', { exact: true }).waitFor();
      // Scroll to the end of the actual detail container, so the user can
      // fully reveal Save above the navigation gesture/three-button inset.
      // scrollIntoViewIfNeeded alone may align it flush with the unsafe bottom.
      await page.getByTestId('settings-detail').evaluate(el => { el.scrollTop = el.scrollHeight; });
      const saveLimitBox = await page.getByLabel('Сохранить лимит обращений к LLM', { exact: true }).boundingBox();
      assert(saveLimitBox && saveLimitBox.y >= 0 && saveLimitBox.y + saveLimitBox.height <= 580 - 24,
        'The detail Save clears the system inset in a reduced viewport');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `agent-limit-${width}.png`) });
      await page.setViewportSize({ width, height: 900 });
      await page.getByLabel(/back/i).click();
      await page.getByTestId('settings-overview').waitFor();

      await page.getByTestId('settings-overview').getByLabel('Голосовой ввод', { exact: true }).click();
      await page.getByRole('radio', { name: 'Системное распознавание', exact: true }).waitFor();
      await page.getByRole('radio', { name: 'Системное распознавание', exact: true }).click();
      await page.waitForFunction(() => localStorage.getItem('pia.voice.engine.v1') === 'system' &&
        document.querySelector('[role="radio"][aria-label="Системное распознавание"]')?.getAttribute('aria-checked') === 'true');
      assert.equal(await page.getByRole('radio', { name: 'Whisper на телефоне', exact: true }).isDisabled(), true);
      assert.equal(await page.getByText('Голос без интернета', { exact: true }).count(), 0, 'Whisper settings are hidden for system mode');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `voice-settings-${width}.png`) });
      await page.getByLabel(/back/i).click();
      await page.getByTestId('settings-overview').waitFor();

      await page.getByLabel('Вкладка Главная', { exact: true }).click();
      await page.getByLabel('Остановить запрос', { exact: true }).waitFor();
      assert.equal(replyNumber, 1, 'Changing tabs must not restart the request');
      // Stages are shown to the person; agent-loop counters stay out of the UI.
      await page.waitForFunction(() => {
        const text = (document.querySelector('[data-testid="nebula-home-status"]')?.textContent || '').trim();
        // Any real stage is fine; the invariant is that a stage is shown and no
        // agent-loop counter leaks into it.
        return text.length > 0 && text !== 'Готов' && text !== 'Ошибка' && !text.includes('(');
      });
      releaseReply();
      await page.getByText('Ответ 1', { exact: true }).waitFor();
      const answerBubble = await page.getByTestId('chat-message-assistant').last().boundingBox();
      const sentBubble = await page.getByTestId('chat-message-user').last().boundingBox();
      assert(answerBubble && sentBubble && answerBubble.y >= sentBubble.y + sentBubble.height,
        'Assistant reply starts directly after the user turn');
      await page.reload();
      await page.getByText('Ответ 1', { exact: true }).waitFor();
      await page.getByLabel('Вкладка Настройки', { exact: true }).click();
      await page.getByLabel('Распознавание файлов', { exact: true }).click();
      await page.getByLabel('Изображения и кадры видео: Anthropic', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Изображения и кадры видео: Anthropic', { exact: true }).getAttribute('aria-checked'), 'true',
        'Media selection persists after app reload');
      await page.getByLabel(/back/i).click();
      await page.getByTestId('settings-overview').waitFor();
      await page.getByLabel('Работа ИИ', { exact: true }).click();
      assert.equal(await page.getByLabel('Лимит обращений к LLM на сообщение', { exact: true }).inputValue(), '6',
        'The chosen limit survives a full app reload');
      await page.getByLabel('Увеличить лимит обращений к LLM', { exact: true }).click();
      await page.getByLabel('Сохранить лимит обращений к LLM', { exact: true }).click();
      await page.getByText('Лимит сохранён. Он действует для следующих сообщений.', { exact: true }).waitFor();
      await page.getByLabel(/back/i).click();
      await page.getByTestId('settings-overview').waitFor();
      await page.getByTestId('settings-overview').getByLabel('Голосовой ввод', { exact: true }).click();
      await page.getByRole('radio', { name: 'Системное распознавание', exact: true }).waitFor();
      assert.equal(await page.getByRole('radio', { name: 'Системное распознавание', exact: true }).getAttribute('aria-checked'), 'true',
        'Selected engine survives full application reload');
      await page.getByLabel(/back/i).click();
      await page.getByTestId('settings-overview').waitFor();
      await page.getByLabel('Вкладка Главная', { exact: true }).click();
      await page.getByLabel('Новый диалог', { exact: true }).click();
      await page.getByText('Начать пустой диалог. Предыдущие диалоги останутся в истории.', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Сообщение ассистенту', { exact: true }).inputValue(), '', 'New-chat action opens an empty usable conversation');
      await page.getByLabel('Сообщение ассистенту', { exact: true }).fill('Второй вопрос');
      await page.getByLabel('Отправить запрос', { exact: true }).click();
      await page.waitForFunction(() => /Подключаюсь|Думаю|Обрабатываю|Пишу ответ/.test(document.querySelector('[data-testid="nebula-home-status"]')?.textContent || ''));
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
      await page.getByTestId('chat-message-list').getByText('Ответ 2', { exact: true }).waitFor();
      await page.getByLabel('Вкладка Память', { exact: true }).click();
      // Vivo report 06.11: helpers must be roughly HALF the screenshot buttons,
      // not merely a few dp smaller than the previous PR. Regular CTAs stay 48dp.
      await page.getByLabel('Открыть архив', { exact: true }).waitFor();
      for (const [label, maxWidth] of [
        ['Открыть архив', 80], ['Открыть корзину', 90], ['Все разделы', 110],
      ]) {
        const bounds = await page.getByLabel(label, {exact:true}).boundingBox();
        assert(bounds && bounds.height >= 22 && bounds.height <= 30 && bounds.width < maxWidth,
          `Half-size secondary action ${label} fits 24dp visual and expected short width`);
      }
      if (process.env.SCREENSHOT_DIR) await page.screenshot({animations:'disabled',
        path:path.join(process.env.SCREENSHOT_DIR,`memory-small-actions-${width}.png`)});
      // List/grid is a labelled real button only when two columns can actually fit.
      if (width >= 350) {
        const viewSwitch = page.getByLabel('Показать списком', { exact: true });
        await viewSwitch.waitFor();
        assert.equal(await viewSwitch.getByText('Список', { exact: true }).count(), 1);
        await viewSwitch.click();
        await page.waitForFunction(() => Object.entries(localStorage).some(([key, value]) =>
          key.startsWith('persai.memory-library-view.v1.') && value === 'list'));
        const gridSwitch = page.getByLabel('Показать плитками', { exact: true });
        await gridSwitch.waitFor();
        assert.equal(await gridSwitch.getByText('Плитки', { exact: true }).count(), 1);
        await gridSwitch.click();
        await page.waitForFunction(() => Object.entries(localStorage).some(([key, value]) =>
          key.startsWith('persai.memory-library-view.v1.') && value === 'grid'));
      } else {
        assert.equal(await page.getByLabel('Показать списком', { exact: true }).count(), 0);
      }
      await page.getByLabel('Все разделы', { exact: true }).click();

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
      await page.getByRole('heading', { name: 'Рецепты', exact: true }).waitFor();
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => window.__insets(24));
      await page.getByLabel('Добавить в память', { exact: true }).click();
      await page.getByLabel('Текст или голос', { exact: true }).click();
      assert.equal(await page.getByLabel('Сохранить запись', { exact: true }).isDisabled(), true, 'Empty drafts cannot save');
      assert.equal(await page.getByLabel('Изменить заметку с ИИ', { exact: true }).isDisabled(), true, 'Empty drafts cannot request an edit');
      await page.getByLabel('Заголовок заметки', { exact: true }).fill('Индейка');
      await page.getByLabel('Текст заметки', { exact: true }).fill('Чеснок и паприка');
      // On a short keyboard-sized viewport the Save action stays outside the scrolling form.
      await page.setViewportSize({ width, height: 470 }); await page.evaluate(() => window.__insets(48));
      await page.waitForFunction(() => document.querySelector('[aria-label="Сохранить запись"]').getBoundingClientRect().bottom <= innerHeight - 48);
      const saveBox = await page.getByTestId('note-save-button').boundingBox();
      assert(saveBox && saveBox.y + saveBox.height <= 470 - 48, 'Note Save clears the 48px system bar on the short viewport');
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => window.__insets(24));
      await page.getByLabel('Сохранить запись', { exact: true }).click();
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).waitFor();
      if (width >= 350) {
        const tile = page.getByLabel('Открыть заметку Индейка', { exact: true });
        const media = tile.getByTestId('memory-grid-media-slot');
        const box = await media.boundingBox();
        assert(box && Math.abs(box.height - 108) <= 1, 'Text and image tiles reserve the same 108dp preview footprint');
        const actions = page.getByLabel('Действия с заметкой Индейка', { exact: true });
        const actionBox = await actions.boundingBox();
        assert(actionBox && actionBox.width >= 48 && actionBox.height >= 48,
          'Tile overflow has its own reachable 48dp touch target');
        if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `memory-tile-${width}.png`) });
      }
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).click();
      assert.equal(await page.getByLabel('Текст заметки', { exact: true }).count(), 0, 'Opening a saved note shows reading, not a form');
      // Reader actions belong above the body/attachments, not below a long document.
      const quickActions = page.getByTestId('note-edit-action');
      await quickActions.waitFor();
      assert.equal(await page.getByLabel('Редактировать запись', { exact: true }).count(), 1, 'Reader has one Edit action');
      assert.equal(await page.getByLabel('Изменить заметку с ИИ', { exact: true }).count(), 1, 'Reader has one AI edit action');
      const editAction=page.getByLabel('Изменить заметку с ИИ', { exact: true });
      const editBorder=await editAction.evaluate(el=>parseFloat(getComputedStyle(el).borderTopWidth));
      assert(editBorder >= 1, 'AI edit must be a visible bordered action, not plain text');
      await page.setViewportSize({ width, height: 470 }); await page.evaluate(() => window.__insets(48));
      const quickBox = await quickActions.boundingBox();
      assert(quickBox && quickBox.y >= 0 && quickBox.y + quickBox.height <= 470 - 48,
        'Reader actions are visible before scrolling even on a short screen');
      await page.setViewportSize({ width, height: 900 }); await page.evaluate(() => window.__insets(24));
      await page.clock.runFor(500);
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `note-reading-${width}.png`) });
      await page.getByLabel('Добавить файлы к заметке', { exact: true }).click();
      await page.clock.runFor(100);
      await page.getByLabel('Сохранить новые вложения', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('qa.notes')).find(n => n.title === 'Индейка').payload.source_file), undefined, 'Picking does not persist');
      await page.getByLabel('Отменить добавление файлов', { exact: true }).click();
      await page.evaluate(() => {window.__pickPdf = true;});
      await page.getByLabel('Добавить файлы к заметке', { exact: true }).click();
      await page.clock.runFor(100);
      await page.getByLabel('Сохранить новые вложения', { exact: true }).waitFor();
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ animations: "disabled", path: path.join(process.env.SCREENSHOT_DIR, `append-files-${width}.png`) });
      await page.getByLabel('Сохранить новые вложения', { exact: true }).click();
      await page.getByText('Вложения · 1', { exact: true }).waitFor();
      await page.getByLabel('Распознать заново recipe.pdf', {exact:true}).scrollIntoViewIfNeeded();
      await page.getByLabel('Открыть PDF recipe.pdf', {exact:true}).waitFor();
      await captureAction('pdf-actions', 'Распознать заново recipe.pdf');
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('qa.notes')).find(n => n.title === 'Индейка').payload.body), 'Чеснок и паприка', 'Appending preserves note text');
      await page.getByLabel('Изменить заметку с ИИ', { exact: true }).click();
      await page.getByLabel('Команда для редактирования заметки', { exact: true }).click();
      await page.getByLabel('Команда для редактирования заметки', { exact: true }).fill('Добавь перец');
      await page.getByLabel('Запросить правку ИИ', { exact: true }).click();
      await page.getByTestId('note-ai-preview').waitFor();
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `note-ai-${width}.png`) });
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('qa.notes')).find(n => n.title === 'Индейка').payload.body), 'Чеснок и паприка', 'LLM preview never persists itself');
      await page.getByText('Сравнить с исходным', { exact: true }).click();
      assert.equal(await page.getByTestId('note-ai-preview').innerText(), 'Чеснок и паприка');
      await page.getByLabel('Применить правку ИИ', { exact: true }).click();
      assert.equal(await page.getByLabel('Текст заметки', { exact: true }).inputValue(), 'Чеснок, паприка и перец');
      await page.getByLabel('Вернуть текст до правки ИИ', { exact: true }).click();
      assert.equal(await page.getByLabel('Текст заметки', { exact: true }).inputValue(), 'Чеснок и паприка');
      await page.getByLabel('Текст заметки', { exact: true }).fill('Чеснок, паприка и перец');
      // Schema v3: advanced fields are accessible without crowding the text editor.
      assert.equal(await page.getByLabel('Тип записи: Факт', { exact: true }).count(), 0, 'Metadata starts collapsed');
      await page.getByLabel('Дополнительно', { exact: true }).click();
      assert.equal(await page.getByLabel('Дополнительно', { exact: true }).getAttribute('aria-expanded'), 'true');
      await page.getByLabel('Тип записи: Факт', { exact: true }).click();
      await page.getByLabel('Другие имена и прозвища', { exact: true }).fill('Индюшка, индюк');
      // Assert the field using its accessible locator. The real persistence
      // contract is checked after reopening; polling the transient DOM input
      // here caused intermittent 30-second timeouts on wider viewports.
      assert.equal(await page.getByLabel('Другие имена и прозвища', { exact: true }).inputValue(), 'Индюшка, индюк');
      await page.getByLabel('Сохранить запись', { exact: true }).click();
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).click();
      await page.getByLabel('Редактировать запись', { exact: true }).click();
      await page.getByLabel('Дополнительно', { exact: true }).click();
      // Aliases arrive asynchronously after opening a note. Poll through the
      // accessible Playwright locator, which works for RN Web input AND
      // textarea; the old raw CSS selector was browser-implementation-specific.
      // This still fails if the persisted alias is actually missing.
      const aliasInput = page.getByLabel('Другие имена и прозвища', { exact: true });
      let persistedAliases = '';
      for (let attempt = 0; attempt < 50; attempt++) {
        persistedAliases = await aliasInput.inputValue();
        if (persistedAliases === 'Индюшка, индюк') break;
        await page.waitForTimeout(100);
      }
      assert.equal(persistedAliases, 'Индюшка, индюк', 'Aliases persist after save and reopen');
      assert.equal(await page.getByLabel('Тип записи: Факт', { exact: true }).getAttribute('aria-selected'), 'true', 'The chosen record type is kept');
      await page.getByLabel('История, события и связи', { exact: true }).click();
      // Text, type and names now share one revision (the former sequential Save added two).
      await page.getByText('История изменений · версия 3', { exact: true }).waitFor();
      // Rejecting an unsaved edit must return to the list without overwriting the saved record.
      await page.getByLabel('Текст заметки', { exact: true }).fill('Черновик — НЕ СОХРАНЯТЬ');
      await page.getByLabel(/back/i).click();
      await page.getByLabel('Продолжить редактирование', { exact: true }).click();
      assert.equal(await page.getByLabel('Текст заметки', { exact: true }).inputValue(),
        'Черновик — НЕ СОХРАНЯТЬ', 'Cancelling the Nebula exit confirmation keeps the draft');
      await page.getByLabel(/back/i).click();
      await page.getByLabel('Выйти без сохранения', { exact: true }).click();
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).waitFor();
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).click();
      await page.getByLabel('Редактировать запись', { exact: true }).click();
      assert.equal(await page.getByLabel('Текст заметки', { exact: true }).inputValue(), 'Чеснок, паприка и перец');
      await page.getByLabel('Архивировать запись', { exact: true }).click();
      assert.equal(await page.getByLabel('Открыть заметку Индейка', { exact: true }).count(), 0);
      // This note belongs to the «Рецепты» collection. Return to the root first:
      // archive/trash are global sections, not unrelated actions of that collection.
      await page.getByLabel('Ко всем записям', { exact: true }).click();
      await page.getByLabel('Открыть архив', { exact: true }).click();
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).click();
      await page.getByLabel('Редактировать запись', { exact: true }).click();
      await page.getByLabel('Вернуть запись из архива', { exact: true }).click();
      await page.getByLabel('Ко всем записям', { exact: true }).click();
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).waitFor();
      await page.getByLabel('Поиск по заметкам', { exact: true }).fill('НичегоПодобного');
      await page.clock.runFor(300);
      await page.getByText('Ничего не найдено', { exact: true }).waitFor();
      // Search belongs to its field and never requires the global memory menu.
      await page.getByLabel('Очистить поиск по памяти', { exact: true }).click();
      await page.clock.runFor(500);
      assert.equal(await page.getByLabel('Поиск по заметкам', { exact: true }).inputValue(), '', 'Clearing search returns to all records');
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).waitFor();
      // Backup has one canonical entry in Settings → Data.
      await page.getByLabel('Вкладка Настройки', { exact: true }).click();
      await page.getByRole('button', { name: 'Резервные копии', exact: true }).click();
      await page.getByLabel('Создать новый код восстановления', { exact: true }).waitFor();
      await page.getByLabel('Код восстановления для импорта', { exact: true }).fill('Z'.repeat(64));
      assert.equal(await page.getByLabel('Восстановить зашифрованную копию', { exact: true }).isDisabled(), true, 'A non-hex code cannot open restore');
      await page.getByLabel('Код восстановления для импорта', { exact: true }).fill('A'.repeat(64));
      assert.equal(await page.getByLabel('Восстановить зашифрованную копию', { exact: true }).isDisabled(), false, 'Valid uppercase code is normalized');
      await page.getByLabel('Код восстановления для импорта', { exact: true }).fill('');
      await page.clock.runFor(500);
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `memory-backup-${width}.png`) });
      await page.getByLabel(/back/i).click();
      await page.getByLabel('Вкладка Память', { exact: true }).click();
      await page.getByLabel('Добавить в память', { exact: true }).click();
      const authenticationCount = await page.evaluate(() => window.__qa.auth);
      await page.getByLabel('Файл', { exact: true }).click();
      await page.getByText('note.txt', { exact: true }).waitFor();
      // Visible selected privacy cards: a change of classification never uploads
      // a file or silently grants provider access.
      const personal = page.getByRole('radio', { name: 'Личные — только на телефоне', exact: true });
      const ordinary = page.getByRole('radio', { name: 'Обычные — доступны агенту и разбору у провайдера', exact: true });
      assert.equal(await ordinary.getAttribute('aria-checked'), 'true', 'Standard is selected initially');
      await personal.click();
      assert.equal(await personal.getAttribute('aria-checked'), 'true', 'Personal selection is explicit');
      assert.equal(await ordinary.getAttribute('aria-checked'), 'false');
      await ordinary.click();
      assert.equal(await ordinary.getAttribute('aria-checked'), 'true', 'Returning to standard remains explicit');
      assert.equal(await page.evaluate(() => window.__qa.auth), authenticationCount, 'A short file-picker switch must not ask for biometrics');
      assert.equal(await page.getByLabel('Извлечь сведения из файла', { exact: true }).count(), 0, 'Recognition is optional and collapsed');
      assert.equal(await page.getByLabel('Название импортируемой заметки', { exact: true }).count(), 0, 'Metadata is collapsed');
      for (const bottom of [0, 24, 48]) {
        await page.evaluate(value => window.__insets(value), bottom);
        await page.setViewportSize({ width, height: 470 });
        // A native inset / viewport change is committed by React on the next
        // layout frame. Do not measure the stale previous frame: await the
        // required safe-area geometry, then assert the SAME visibility rule.
        await page.waitForFunction((safeBottom) => {
          const save = document.querySelector('[aria-label="Сохранить сведения в память"]');
          const bounds = save?.getBoundingClientRect();
          return bounds && bounds.y >= 0 && bounds.bottom <= innerHeight - safeBottom + 1;
        }, bottom, { timeout: 5000 });
        const save = await page.getByLabel('Сохранить сведения в память', { exact: true }).boundingBox();
        assert(save && save.y >= 0 && save.y + save.height <= 470 - bottom + 1, 'Import save remains above system bars in a reduced viewport');
      }
      await page.evaluate(() => window.__insets(24));
      await page.setViewportSize({ width, height: 900 });
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `import-compact-${width}.png`) });
      await page.getByLabel('Распознавание', { exact: true }).click();
      await page.getByLabel('Извлечь сведения из файла', { exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Распознанное содержимое файла"]').value.includes('индейка'));
      const resultBox = await page.getByLabel('Распознанное содержимое файла', { exact: true }).boundingBox();
      assert(resultBox && resultBox.height <= 190, 'Recognized text field must not expand the import form without bound');
      await page.getByLabel('Распознанное содержимое файла', { exact: true }).fill('Исправлено вручную');
      await page.getByLabel('Распознать заново', { exact: true }).click();
      await page.getByLabel('Применить новый', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Распознанное содержимое файла', { exact: true }).inputValue(), 'Исправлено вручную');
      await page.getByLabel('Оставить текущий', { exact: true }).click();
      assert.equal(await page.getByLabel('Распознанное содержимое файла', { exact: true }).inputValue(), 'Исправлено вручную');
      await page.getByLabel('Распознать заново', { exact: true }).click();
      await page.getByLabel('Применить новый', { exact: true }).waitFor();
      await page.clock.runFor(600);
      await captureAction('import-replace-confirm', 'Применить новый');
      const replaceBox = await page.getByLabel('Применить новый', { exact: true }).boundingBox();
      assert(replaceBox && replaceBox.height >= 48 && replaceBox.x >= 0 && replaceBox.x + replaceBox.width <= width,
        'Import destructive confirmation has a real reachable 48dp Nebula button');
      await page.getByLabel('Применить новый', { exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Распознанное содержимое файла"]').value.includes('индейка'));
      await page.getByLabel('Сохранить сведения в память', { exact: true }).click();
      await page.getByLabel(/Открыть заметку Рецепт: индейка/).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Overflow at ${width}px`);
      if (process.env.SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `memory-${width}.png`) });
      }
      await page.getByLabel('Действия с заметкой Индейка', { exact: true }).click();
      await page.getByText('В архив', { exact: true }).waitFor();
      const archiveAction = page.getByRole('button', { name: 'В архив', exact: true });
      const archiveBox = await archiveAction.boundingBox();
      assert(archiveBox && archiveBox.height >= 48 && archiveBox.width >= 48,
        'Card action is a full-size labelled Nebula button, not a plain text row');
      assert.equal(await page.getByTestId('memory-selection-toolbar').count(), 0, 'Single-note menu does not select');
      await page.getByLabel('Закрыть панель Действия с записью', { exact: true }).click();
      await page.getByLabel('Выбрать записи', { exact: true }).click();
      assert.equal(await page.getByLabel('Действия с выбранными записями', { exact: true }).isDisabled(), true);
      await page.getByLabel('Выбрать заметку Индейка', { exact: true }).click();
      await page.getByLabel('Действия с выбранными записями', { exact: true }).click();
      await page.getByRole('button', { name: 'Редактировать', exact: true }).waitFor();
      assert.equal(await page.getByText('Объединить записи', { exact: true }).count(), 0, 'One record cannot be merged');
      await page.clock.runFor(500);
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `selection-menu-${width}.png`), animations: "disabled" });
      await page.getByText('В корзину', { exact: true }).click();
      await page.getByLabel('Подтвердить перемещение в корзину', { exact: true }).waitFor();
      const dangerous = await page.getByLabel('Подтвердить перемещение в корзину', { exact: true }).boundingBox();
      assert(dangerous && dangerous.height >= 48, 'Destructive confirmation uses a full-size named button');
      assert.equal(await page.getByLabel('Закрыть панель Действия с записью', { exact: true }).count(), 0, 'Confirmation replaces actions without stacking another modal');
      await page.getByLabel('Закрыть панель В корзину?', { exact: true }).click();
      await page.getByText('Выбрано: 1', { exact: true }).waitFor();
      const selectedActionBox = await page.getByRole('button', { name: 'Редактировать', exact: true }).boundingBox();
      assert(selectedActionBox && selectedActionBox.y >= 0 && selectedActionBox.y + selectedActionBox.height <= 876, 'Selection actions are inside the visible screen');
      await page.getByLabel('Закрыть панель Действия с записью', { exact: true }).click();
      await page.getByLabel('Отменить выбор записей', { exact: true }).click();
      await page.getByLabel('Действия с заметкой Индейка', { exact: true }).click();
      await page.getByText('Выбрать несколько', { exact: true }).click();
      await page.getByLabel('Выбрать заметку Индейка', { exact: true }).click();
      assert.equal(await page.getByTestId('memory-selection-toolbar').count(), 0, 'Last deselection exits');
      assert.equal(await page.getByText('Выбрать все', { exact: true }).count(), 0);
      // UI-3/6: check the actual merge preview on every phone/tablet width.
      // A reversible DRY preview must have the correct primary row, show
      // consequences, and never commit before explicit confirmation.
      await page.getByLabel('Выбрать записи', { exact: true }).click();
      await page.getByLabel('Выбрать заметку Индейка', { exact: true }).click();
      await page.getByLabel(/Выбрать заметку Рецепт: индейка/).click();
      await page.getByLabel('Действия с выбранными записями', { exact: true }).click();
      await page.getByText('Объединить записи', { exact: true }).click();
      await page.getByText('Основная · Индейка', { exact: true }).waitFor();
      await page.getByText(/Будет объединена · Рецепт: индейка/).waitFor();
      assert.equal(await page.getByText(/получит тексты и вложения остальных/i).count(), 1,
        'Merge preview states the effect on source attachments without changing notes');
      if (process.env.SCREENSHOT_DIR) {
        await page.screenshot({animations:'disabled',
          path:path.join(process.env.SCREENSHOT_DIR,`merge-preview-${width}.png`)});
      }
      const confirmMerge = page.getByLabel('Подтвердить объединение', { exact:true });
      const cancelMerge = page.getByLabel('Отмена', { exact:true });
      const initialConfirmBox = await confirmMerge.boundingBox();
      const initialCancelBox = await cancelMerge.boundingBox();
      assert(initialConfirmBox && initialCancelBox &&
        initialConfirmBox.y >= 0 && initialConfirmBox.y + initialConfirmBox.height <= 900 &&
        initialCancelBox.y >= 0 && initialCancelBox.y + initialCancelBox.height <= 900,
        'Merge Confirm and Cancel are BOTH visible without scrolling at the narrowest width');
      await confirmMerge.click({trial:true});
      const mergeBox = await confirmMerge.boundingBox();
      assert(mergeBox && mergeBox.width >= 48 && mergeBox.x >= 0 && mergeBox.x + mergeBox.width <= width,
        'Merge confirmation is a framed reachable button on narrow screens');
      await page.getByLabel('Проверить полный текст', {exact:true}).click();
      await page.getByLabel('Свернуть предпросмотр', {exact:true}).waitFor();
      await page.getByLabel('Свернуть предпросмотр', {exact:true}).click();
      await cancelMerge.click();
      await page.getByLabel('Отменить выбор записей', { exact:true }).click();
      // Contextual restore is available immediately in the opened trashed note.
      // Reuse the existing version-checked writer, not a parallel delete/restore path.
      await page.getByLabel('Действия с заметкой Индейка', { exact: true }).click();
      await page.getByText('В корзину', { exact: true }).click();
      await page.getByLabel('Подтвердить перемещение в корзину', { exact: true }).click();
      await page.getByLabel('Открыть корзину', { exact: true }).click();
      // The global command is contextual; the count covers the whole trash,
      // while the two-step confirmation must never purge without the final tap.
      await page.getByLabel('Очистить всю корзину', { exact: true }).waitFor();
      if (width < 560) {
        const counterBox = await page.getByTestId('trash-total-counter').boundingBox();
        const buttonBox = await page.getByLabel('Очистить всю корзину', { exact: true }).boundingBox();
        assert(buttonBox && buttonBox.height >= 22 && buttonBox.height <= 30,
          'Trash clear shows a half-height visual action; final irreversible confirmation stays full-size');
        assert(counterBox && buttonBox && buttonBox.y >= counterBox.y + counterBox.height - 1,
          'The full-trash button is below the readable count on a narrow screen');
        assert(buttonBox.x >= 0 && buttonBox.x + buttonBox.width <= width,
          'The full-trash action stays inside the viewport');
      }
      await page.getByLabel('Очистить всю корзину', { exact: true }).click();
      await page.getByLabel('Проверить последствия очистки корзины', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Подтвердить очистку всей корзины', { exact: true }).count(), 0,
        'Preview never exposes the irreversible action before the extra review step');
      await page.getByLabel('Проверить последствия очистки корзины', { exact: true }).click();
      await page.getByLabel('Подтвердить очистку всей корзины', { exact: true }).waitFor();
      if (process.env.SCREENSHOT_DIR) await page.screenshot({
        path: path.join(process.env.SCREENSHOT_DIR, `trash-preview-${width}.png`),
      });
      await page.getByLabel('Отменить очистку корзины', { exact: true }).click();
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).click();
      await page.getByLabel('Восстановить запись из корзины', { exact: true }).waitFor();
      assert.equal(await page.getByLabel('Редактировать запись', { exact: true }).count(), 0,
        'Trashed note shows Restore, not an edit action');
      await page.getByLabel('Восстановить запись из корзины', { exact: true }).click();
      await page.getByLabel('Ко всем записям', { exact: true }).click();
      await page.getByLabel('Открыть заметку Индейка', { exact: true }).waitFor();
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
      const historyNewAction = page.getByLabel('Создать новый диалог', { exact: true });
      await historyNewAction.scrollIntoViewIfNeeded();
      const historyAction = await historyNewAction.boundingBox();
      const historyActionBorder = await historyNewAction.evaluate(el => parseFloat(getComputedStyle(el).borderTopWidth));
      assert(historyAction && historyAction.height >= 48 && historyActionBorder >= 1 &&
        historyAction.y + historyAction.height <= 470 - 48,
        'The last sheet action is a visible framed Nebula button above system navigation');
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `history-${width}.png`) });
      await page.getByLabel('Сохранить итог диалога Второй вопрос', {exact:true}).click();
      await page.getByLabel('Создать итог', {exact:true}).waitFor();
      assert.equal(await page.getByLabel('Выбрать весь диалог', {exact:true}).count(), 0);
      await page.setViewportSize({width, height:900});
      await page.getByLabel('Создать итог', {exact:true}).click({trial:true});
      await captureAction('summary', 'Создать итог');
      await page.getByLabel('Отмена', {exact:true}).click();
      await page.getByLabel('Сохранить ответ в заметки', {exact:true}).first().waitFor();
      await page.clock.runFor(600);
      await captureAction('reply-save', 'Сохранить ответ в заметки');
      assert.equal(await page.getByLabel('Закрыть панель Действия с ответом', {exact:true}).count(), 0,
        'Saving one reply does not require a redundant actions sheet');
      await page.getByLabel('История диалогов', {exact:true}).click();
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
      await page.getByTestId('chat-message-list').getByText('Ответ 2', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__qa.auth), authenticationCount);
      await page.evaluate(() => window.__state('background'));
      await page.clock.fastForward(5 * 60 * 1000);
      await page.getByLabel('Разблокировать приложение', { exact: true }).waitFor();
      await page.evaluate(() => window.__state('active'));
      await page.getByLabel('Разблокировать приложение', { exact: true }).click();
      await page.getByTestId('chat-message-list').getByText('Ответ 2', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__qa.auth), authenticationCount + 1);
      await page.getByLabel('Закрыть панель Мои диалоги', { exact: true }).click();
      await page.getByLabel('Поиск диалогов', { exact: true }).waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `home-${width}.png`) });
      await page.getByLabel('Сохранить ответ в заметки', {exact:true}).first().click();
      await page.getByText(/Черновик из ответа ИИ/).waitFor();
      await page.getByLabel('Сохранить запись', {exact:true}).waitFor();
      // No write occurs until the user explicitly saves the editable draft.
      console.log(`PASS ${width}px: production app/navigation, 0/24/48px system insets, Android Modal focus events, named actions, persisted chats, work across tabs/dialogs, memory CRUD, profiles, picker, five-minute session and reduced viewport`);

      await page.close();
    }
  } catch (error) {
    // Synthetic QA data only; capture the actual failing production screen.
    if (process.env.SCREENSHOT_DIR && currentPage && !currentPage.isClosed()) {
      await currentPage.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'failure.png') }).catch(() => {});
    }
    throw error;
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => {
  console.error(error);
  // In GitHub Actions this becomes an annotation, readable without the raw log.
  if (process.env.GITHUB_ACTIONS) console.log('::error title=Browser acceptance::' + String(error && (error.stack || error.message) || error).slice(0, 1800).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A'));
  process.exitCode = 1;
});


