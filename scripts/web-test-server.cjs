// Test-only server: mirror FastAPI's /app/ static mount on an ephemeral port.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '../backend/app/web');
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript',
  '.css':'text/css','.svg':'image/svg+xml','.png':'image/png',
  '.webmanifest':'application/manifest+json'};

async function startWebTestServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (!pathname.startsWith('/app/')) { response.writeHead(404).end(); return; }
      const filename = path.resolve(root, pathname.slice(5) || 'index.html');
      if (!filename.startsWith(root + path.sep)) { response.writeHead(404).end(); return; }
      const body = await fs.readFile(filename);
      response.writeHead(200, {'Content-Type':types[path.extname(filename)] || 'application/octet-stream'}).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {baseURL:`http://127.0.0.1:${server.address().port}/app/`,
    close:() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))};
}
module.exports = {startWebTestServer};
