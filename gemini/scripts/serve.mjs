import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { dynamicDir, discover } from './core.mjs';
import { loadLocalEnv } from './env.mjs';
import { loadAllData } from './sources.mjs';
import { exportDesktopModel } from './desktop-model.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/report-data.json', ['report-data.json', 'application/json; charset=utf-8']]
]);
http.createServer(async (req, res) => {
  const entry = files.get((req.url ?? '').split('?')[0]);
  if (!entry) { res.writeHead(404); res.end('Not found'); return; }
  if (entry[0] === 'report-data.json') {
    try {
      const env = loadLocalEnv();
      const inventory = discover();
      const data = (env.DATA_MODE || 'desktop') === 'desktop' ? exportDesktopModel(inventory, env).data : await loadAllData(inventory, env);
      res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    } catch (error) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`Unable to refresh local source: ${error.message}`);
    }
    return;
  }
  const file = path.join(dynamicDir, entry[0]);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('Run npm start first'); return; }
  res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(8765, '127.0.0.1', () => console.log('Dynamic review: http://127.0.0.1:8765/ (Ctrl+C to stop)'));
