import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Dependency-free preview of the included production build, including SPA routes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const port = Number(process.argv[2] || 5184);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.jpg':'image/jpeg', '.woff2':'font/woff2', '.woff':'font/woff', '.ico':'image/x-icon', '.pdf':'application/pdf' };
try { await stat(path.join(root, 'index.html')); } catch { console.error('No compiled build. Run pnpm install, then pnpm build.'); process.exit(1); }
const server = http.createServer(async (req, res) => {
  try {
    if (!['GET','HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let target = path.resolve(root, '.' + pathname);
    if (!target.startsWith(root + path.sep) && target !== root) { res.writeHead(403); res.end(); return; }
    try { if (!(await stat(target)).isFile()) target = path.join(root, 'index.html'); }
    catch { if (path.extname(pathname)) { res.writeHead(404); res.end('Not found'); return; } target = path.join(root, 'index.html'); }
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type':types[path.extname(target)] || 'application/octet-stream', 'Content-Length':body.length, 'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(400); res.end('Bad request'); }
});
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is occupied. Try: node scripts/serve.mjs ${port + 1}` : e.message); process.exit(1); });
server.listen(port, '127.0.0.1', () => console.log(`ZKdesk preview: http://127.0.0.1:${port}`));
