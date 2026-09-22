import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { dynamicDir } from './core.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/report-data.json', ['report-data.json', 'application/json; charset=utf-8']]
]);
http.createServer((req, res) => {
  const entry = files.get((req.url ?? '').split('?')[0]);
  if (!entry) { res.writeHead(404); res.end('Not found'); return; }
  const file = path.join(dynamicDir, entry[0]);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('Run npm start first'); return; }
  res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(8765, '127.0.0.1', () => console.log('Dynamic review: http://127.0.0.1:8765/ (Ctrl+C to stop)'));
