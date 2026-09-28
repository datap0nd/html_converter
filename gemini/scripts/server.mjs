// The local report server: serves output/dynamic/index.html (plus static assets
// next to it) and answers GET /api/report?visual=<id>&filters=<json> through the
// generated backend. Credentials never leave this process.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { QUERY_ROW_LIMIT, QUERY_CONCURRENCY, withTimeout, toList, issueText } from './backend-check.mjs';

// Static files the page may load from its own folder. Never backend modules
// (.mjs) and never dotfiles.
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};
const MAX_FILTERS_LENGTH = 64 * 1024;
const MAX_QUEUED = 200;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Runs at most `size` tasks at once; the rest wait in order.
export function createLimiter(size) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= size || !queue.length) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve().then(task).then(resolve, reject).finally(() => { active--; next(); });
  };
  const run = task => new Promise((resolve, reject) => {
    if (queue.length >= MAX_QUEUED) { reject(new RequestError(503, 'Too many report requests are waiting; reload the page.')); return; }
    queue.push({ task, resolve, reject });
    next();
  });
  run.stats = () => ({ active, queued: queue.length });
  return run;
}

// Resolves a request path to a servable file inside dynamicDir, or null.
export function staticFile(dynamicDir, pathname) {
  let relative;
  try { relative = decodeURIComponent(pathname).replace(/^\/+/, ''); } catch { return null; }
  if (!relative || relative.includes('\0')) return null;
  const parts = relative.split(/[\\/]+/);
  if (parts.some(part => !part || part === '..' || part.startsWith('.'))) return null;
  const type = STATIC_TYPES[path.extname(relative).toLowerCase()];
  if (!type) return null;
  const base = path.resolve(dynamicDir);
  const file = path.resolve(base, ...parts);
  if (!file.startsWith(base + path.sep)) return null;
  try {
    const real = fs.realpathSync(file);
    const realBase = fs.realpathSync(base);
    if (!real.startsWith(realBase + path.sep) || !fs.statSync(real).isFile()) return null;
    return { file: real, type };
  } catch { return null; }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function jsonText(value) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? (Number.isSafeInteger(Number(item)) ? Number(item) : item.toString()) : item);
}

let guardsInstalled = false;

// A generated backend's stray timer or socket error must not end the report
// server; it is logged, and the visual whose request it breaks shows an error.
function installCrashGuards(log) {
  if (guardsInstalled) return;
  guardsInstalled = true;
  process.on('uncaughtException', error => log.error('server', `Unhandled error in the report backend (the server keeps running): ${error?.stack ?? error}`));
  process.on('unhandledRejection', error => log.error('server', `Unhandled promise rejection in the report backend (the server keeps running): ${error?.stack ?? error}`));
}

// options: dynamicDir, backend ({ query }), inventory (pages -> visuals), port
// (first port to try), attempts (ports tried before a random free one), limit,
// concurrency, queryTimeoutMs, log ({ info, warn, error, detail }), redact(text).
// Returns { server, url, port, close() }.
export async function startReportServer({
  dynamicDir, backend, inventory, port = 8765, attempts = 10,
  limit = QUERY_ROW_LIMIT, concurrency = QUERY_CONCURRENCY, queryTimeoutMs = 120_000,
  log, redact = text => String(text)
}) {
  const logger = log ?? { info() {}, warn() {}, error() {}, detail() {} };
  const htmlFile = path.join(dynamicDir, 'index.html');
  const visualIds = new Set(toList(inventory?.pages).flatMap(page => toList(page?.visuals).map(visual => visual?.id)).filter(Boolean));
  const limiter = createLimiter(Math.max(1, concurrency));
  let bound = null;
  let hosts = new Set();
  let origins = new Set();
  const server = http.createServer({ maxHeaderSize: 64 * 1024 }, async (req, res) => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(status, { ...headers, 'Content-Type': type });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    let url;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); } catch { send(400, jsonText({ error: 'Bad request URL.' })); return; }
    // Only this machine's browser, addressed by this server's own name: blocks other
    // sites (Origin) and DNS-rebinding pages (Host) from reading report data.
    if (!['GET', 'HEAD'].includes(req.method) || (req.headers.origin && !origins.has(req.headers.origin)) || (req.headers.host && !hosts.has(String(req.headers.host).toLowerCase()))) {
      send(403, jsonText({ error: 'Forbidden.' }));
      return;
    }
    if (url.pathname === '/api/report') {
      const started = Date.now();
      const visualId = url.searchParams.get('visual') ?? '';
      try {
        if (!visualIds.has(visualId)) throw new RequestError(400, `Unknown visual ID "${visualId.slice(0, 100)}".`);
        const rawFilters = url.searchParams.get('filters') ?? '{}';
        if (rawFilters.length > MAX_FILTERS_LENGTH) throw new RequestError(400, 'The filters parameter is too large.');
        let filters;
        try { filters = JSON.parse(rawFilters || '{}'); } catch { throw new RequestError(400, 'The filters parameter is not valid JSON.'); }
        if (!filters || Array.isArray(filters) || typeof filters !== 'object') throw new RequestError(400, 'The filters parameter must be a JSON object.');
        const result = await limiter(() => withTimeout(Promise.resolve().then(() => backend.query({ visualId, filters, limit })), queryTimeoutMs, `query(${visualId})`));
        if (!result || typeof result !== 'object' || !Array.isArray(result.rows)) throw new Error('The backend returned no rows array for this visual.');
        const body = { ...result, limitations: toList(result.limitations).map(issueText) };
        if (result.rows.length > limit) {
          body.rows = result.rows.slice(0, limit);
          body.truncated = true;
          body.limitations.push(`Only the first ${limit} of ${result.rows.length} rows are shown.`);
        }
        send(200, jsonText(body));
        logger.detail('server', `GET /api/report visual=${visualId} rows=${body.rows.length}${body.placeholder ? ' (placeholder)' : ''} ${Date.now() - started} ms`);
      } catch (error) {
        const status = error instanceof RequestError ? error.status : 500;
        const message = redact(issueText(error)).slice(0, 2000);
        (status >= 500 ? logger.warn : logger.detail)('server', `Visual ${visualId || '(none)'} failed after ${Date.now() - started} ms: ${message}`);
        send(status, jsonText({ error: message }));
      }
      return;
    }
    const file = url.pathname === '/' ? { file: htmlFile, type: STATIC_TYPES['.html'] } : staticFile(dynamicDir, url.pathname);
    if (!file || !fs.existsSync(file.file)) { send(404, 'Not found', 'text/plain; charset=utf-8'); return; }
    res.writeHead(200, { ...headers, 'Content-Type': file.type });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file.file);
    stream.on('error', error => { logger.warn('server', `Could not read ${path.basename(file.file)}: ${error.message}`); res.destroy(); });
    stream.pipe(res);
  });
  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end(error.code === 'HPE_HEADER_OVERFLOW' ? 'HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n' : 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  let lastError = null;
  const candidates = [];
  for (let candidate = port; candidate < port + attempts && candidate <= 65535; candidate++) candidates.push(candidate);
  candidates.push(0);
  for (const candidate of candidates) {
    try { bound = await listen(server, candidate); break; }
    catch (error) {
      lastError = error;
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') break;
      logger.warn('server', candidate === 0 ? 'No free port found in the usual range.' : `Port ${candidate} is in use (probably an earlier report window still running); trying ${candidates[candidates.indexOf(candidate) + 1] || 'a random free port'}.`);
    }
  }
  if (bound === null) {
    const error = new Error(`Could not start the local report server: ${lastError?.message ?? 'no port available'}`);
    error.code = lastError?.code;
    throw error;
  }
  hosts = new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);
  origins = new Set([`http://127.0.0.1:${bound}`, `http://localhost:${bound}`]);
  server.on('error', error => logger.error('server', `Report server error: ${error.message}`));
  installCrashGuards(logger);
  const close = () => new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
  return { server, url: `http://127.0.0.1:${bound}/`, port: bound, close };
}
