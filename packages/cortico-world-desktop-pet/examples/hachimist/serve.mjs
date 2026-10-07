// Local visual smoke test. No model service, microphone or desktop-control permissions are used.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
export function createPreviewServer() {
  return createServer(async (req, res) => {
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400).end('bad path'); return; }
    if (path === '/') path = '/examples/hachimist/index.html';
    if (path === '/figure-frame') {
      path = '/web/figure-frame.html';
      const self = `http://${req.headers.host}`;
      res.setHeader('Content-Security-Policy', `sandbox allow-scripts; default-src 'none'; script-src ${self}; img-src ${self} data: blob:; style-src 'unsafe-inline'; connect-src 'none'; frame-ancestors ${self}`);
    }
    const file = normalize(join(root, path));
    if (!file.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404).end('not found'); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || 4319);
  const server = createPreviewServer();
  server.listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${server.address().port}`));
}
