const test = require('node:test');
const assert = require('node:assert/strict');
const {startWebTestServer} = require('./web-test-server.cjs');

test('serves the actual login page and its assets at the production mount', async () => {
  const server = await startWebTestServer();
  try {
    const page = await fetch(server.baseURL);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="email"/);
    for (const [file, type] of [['app.js','text/javascript'], ['styles.css','text/css'],
      ['manifest.webmanifest','application/manifest+json'], ['access.html','text/html']]) {
      const response = await fetch(server.baseURL + file);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type').startsWith(type));
    }
    for (const file of ['missing.html','%2e%2e%2f%2e%2e%2fconfig.py','%ZZ']) {
      assert.equal((await fetch(server.baseURL + file)).status, 404);
    }
    assert.equal((await fetch(new URL('/v1/auth/me', server.baseURL))).status, 404);
  } finally { await server.close(); }
});

test('web privacy controls are present and wired to settings', async () => {
  const server = await startWebTestServer();
  try {
    const page = await fetch(server.baseURL);
    const html = await page.text();
    for (const id of ['privacyPanel', 'privacyCollections', 'privacyHistory',
      'privacySTT', 'privacyMCP', 'btnSavePrivacyGlobal']) {
      assert.match(html, new RegExp('id="' + id + '"'));
    }
    const js = await (await fetch(server.baseURL + 'app.js')).text();
    assert.match(js, /loadPrivacySettings\(\)/);
    assert.match(js, /saveGlobalPrivacySettings/);
    assert.match(js, /\/v1\/privacy\/collections/);
    assert.match(js, /\/v1\/privacy\/integrations/);
  } finally { await server.close(); }
});
