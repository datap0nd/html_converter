import http from 'node:http';
import fs from 'node:fs';
import { discover, dynamicDir } from './core.mjs';
import { loadLocalEnv } from './env.mjs';
import { ensurePostgresDriver } from './deps.mjs';
import { listLiveSources, fetchLivePage } from './sources.mjs';
import { createLivePreview } from './live-preview.mjs';

try {
  const env = loadLocalEnv();
  const inventory = discover();
  const sources = listLiveSources(inventory, env);
  if (!env.PG_USER || !env.PG_PASSWORD) throw new Error('Fill PG_USER and PG_PASSWORD in gemini/.env with a read-only PostgreSQL login.');
  ensurePostgresDriver(inventory);
  if (process.argv.includes('--preflight')) {
    for (const source of sources) {
      const page = await fetchLivePage(source, env, { limit: 1, offset: 0 });
      console.log(`${source.name}: connected; ${page.columns.length} column(s); ${page.rows.length ? 'sample row returned' : 'no rows'}.`);
    }
    console.log('Live PostgreSQL preflight passed. No Gemini call or data export made.');
    process.exit(0);
  }
  const htmlFile = createLivePreview(inventory, sources);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1:8765');
    const origin = req.headers.origin;
    if (origin && origin !== 'http://127.0.0.1:8765') { res.writeHead(403); res.end(); return; }
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlFile).pipe(res);
      return;
    }
    if (url.pathname === '/api/rows') {
      try {
        const source = sources.find(x => x.id === url.searchParams.get('source'));
        if (!source) throw new Error('Unknown source.');
        const offset = Number(url.searchParams.get('offset') ?? '0');
        const data = await fetchLivePage(source, env, { limit: 100, offset });
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(data));
      } catch (error) {
        res.writeHead(400, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    res.writeHead(404, headers); res.end('Not found');
  });
  server.listen(8765, '127.0.0.1', () => {
    console.log(`Live preview: http://127.0.0.1:8765/`);
    console.log(`HTML: ${htmlFile}`);
    console.log('PostgreSQL credentials remain server-side. Ctrl+C stops the local server.');
  });
} catch (error) {
  console.error(`Live preview stopped: ${error.message}`);
  process.exitCode = 1;
}
