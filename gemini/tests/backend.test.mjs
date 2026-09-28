// The generated backend's isolated check (backend-check.mjs) and the local report server (server.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { checkBackend, loadBackend, closeBackend, classifyBackendIssue, diagnoseBackendIssue, analyzeQueryResult, scanBackendSource, createRedactor } from '../scripts/backend-check.mjs';
import { startReportServer, staticFile, createLimiter } from '../scripts/server.mjs';
import { createPostgresPool, parsePgNumeric, parsePgInt8, parsePgTimestamp } from '../scripts/sources.mjs';

const inventory = {
  pages: [{
    id: 'p1', name: 'Overview', visuals: [
      { id: 'v1', type: 'card', title: 'Total', role: 'data' },
      { id: 'v2', type: 'tableEx', title: 'Detail', role: 'data' },
      { id: 'v3', type: 'textbox', role: 'decorative' }
    ]
  }]
};

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hc-backend-'));
}

function writeBackend(dir, source, extra = {}) {
  fs.writeFileSync(path.join(dir, 'backend.mjs'), source);
  for (const [name, text] of Object.entries(extra)) fs.writeFileSync(path.join(dir, name), text);
  return path.join(dir, 'backend.mjs');
}

const goodBackend = `
export async function createBackend({ env, helpers }) {
  return {
    async healthcheck() { return { ok: true, sources: ['memory'] }; },
    async query({ visualId, filters, limit }) {
      if (visualId === 'v1') return { rows: [{ total: 42 }], columns: ['total'], placeholder: false, limitations: [] };
      if (visualId === 'v2') return { rows: [{ name: 'a', value: 1 }, { name: 'b', value: 2 }].slice(0, limit), columns: ['name', 'value'], placeholder: false, limitations: [] };
      throw new Error('Unknown visual ' + visualId);
    }
  };
}
`;

const fast = { perQueryTimeoutMs: 2000, graceMs: 1500, noticeMs: 60_000, totalTimeoutMs: 60_000, probeSources: false };

test('a working backend passes the isolated check and reports every data visual', async () => {
  const dir = tempDir();
  try {
    const progress = [];
    const result = await checkBackend({ backendFile: writeBackend(dir, goodBackend), inventory, root: dir, inputDir: dir, ...fast, onProgress: text => progress.push(text) });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.deepEqual(result.visuals.map(visual => [visual.visualId, visual.rowCount]).sort(), [['v1', 1], ['v2', 2]]);
    assert.equal(result.totalVisuals, 2, 'decorative visuals are not queried');
    assert.ok(progress.some(line => /healthcheck\(\) passed/.test(line)));
    assert.ok(progress.some(line => /\[2\/2\]/.test(line)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('syntax errors, relative imports and wrong exports are code issues with a location', async () => {
  const dir = tempDir();
  try {
    let result = await checkBackend({ backendFile: writeBackend(dir, 'export async function createBackend() { const = 1; }'), inventory, root: dir, ...fast });
    assert.equal(result.ok, false);
    assert.equal(result.issues[0].stage, 'syntax');
    assert.equal(result.issues[0].kind, 'code');

    result = await checkBackend({ backendFile: writeBackend(dir, `import { root } from '../../scripts/core.mjs';\n${goodBackend}`), inventory, root: dir, ...fast });
    assert.ok(result.issues.some(issue => issue.stage === 'static' && /line 1 imports \.\.\/\.\.\/scripts\/core\.mjs/.test(issue.message)), JSON.stringify(result.issues));

    result = await checkBackend({ backendFile: writeBackend(dir, 'export const nothing = 1;'), inventory, root: dir, ...fast });
    assert.match(result.issues[0].message, /must export async function createBackend/);
    assert.equal(result.issues[0].kind, 'code');

    result = await checkBackend({ backendFile: path.join(dir, 'missing.mjs'), inventory, root: dir, ...fast });
    assert.equal(result.issues[0].stage, 'files');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a module next to backend.mjs is allowed', async () => {
  const dir = tempDir();
  try {
    const backend = writeBackend(dir, `import { rowsFor } from './rows.mjs';
export async function createBackend() {
  return { async healthcheck() { return { ok: true, sources: [] }; }, async query({ visualId }) { return { rows: rowsFor(visualId), columns: ['x'], placeholder: false, limitations: [] }; } };
}`, { 'rows.mjs': 'export const rowsFor = id => [{ x: id }];\n' });
    const result = await checkBackend({ backendFile: backend, inventory, root: dir, ...fast });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(scanBackendSource("import x from './rows.mjs';").issues.length, 0);
    assert.equal(scanBackendSource("import x from '../rows.mjs';").issues.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a query that blocks the event loop, exits the process or leaks a rejection is pinned to its visual', async () => {
  const dir = tempDir();
  try {
    const backend = writeBackend(dir, `
export async function createBackend() {
  return {
    async healthcheck() { return { ok: true, sources: [] }; },
    async query({ visualId }) {
      if (visualId === 'v1') { for (;;) {} }
      if (visualId === 'v2') { Promise.reject(new Error('stray failure')); process.exit(3); }
      return { rows: [], columns: [], placeholder: true, limitations: ['none'] };
    }
  };
}`);
    const result = await checkBackend({ backendFile: backend, inventory, root: dir, ...fast });
    assert.equal(result.ok, false);
    const byVisual = Object.groupBy(result.issues, issue => issue.visualId ?? '-');
    assert.match(byVisual.v1?.[0]?.message ?? '', /kept the process busy/, JSON.stringify(result.issues));
    assert.ok(byVisual.v2?.some(issue => /process\.exit/.test(issue.message)), JSON.stringify(result.issues));
    assert.ok(result.issues.every(issue => issue.kind === 'code'), JSON.stringify(result.issues));
    assert.ok(result.restarts >= 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('healthcheck problems are classified: a missing .env value is the user\'s, a crash is code', async () => {
  const dir = tempDir();
  try {
    const backend = writeBackend(dir, `
export async function createBackend({ env }) {
  return {
    async healthcheck() { return { ok: false, issues: ['PG_PASSWORD is empty in .env.'] }; },
    async query() { return { rows: [], columns: [] }; }
  };
}`);
    const result = await checkBackend({ backendFile: backend, inventory, env: { PG_USER: 'reader', PG_PASSWORD: '' }, root: dir, ...fast });
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].kind, 'environment');
    assert.match(result.issues[0].hint, /Fill PG_PASSWORD in gemini\/\.env/);
    assert.equal(result.checkedVisuals, 0);

    writeBackend(dir, `
export async function createBackend() {
  return { async healthcheck() { return undefined.ok; }, async query() { return { rows: [] }; } };
}`);
    const crash = await checkBackend({ backendFile: backend, inventory, root: dir, ...fast });
    assert.equal(crash.issues[0].stage, 'healthcheck');
    assert.equal(crash.issues[0].kind, 'code');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('secrets from .env never appear in check results', async () => {
  const dir = tempDir();
  try {
    const backend = writeBackend(dir, `
export async function createBackend({ env }) {
  return {
    async healthcheck() { return { ok: true, sources: ['login ' + env.PG_PASSWORD] }; },
    async query() { throw new Error('failed with password ' + env.PG_PASSWORD); }
  };
}`);
    const result = await checkBackend({ backendFile: backend, inventory, env: { PG_PASSWORD: 'Sup3r-Secret!' }, root: dir, ...fast });
    assert.doesNotMatch(JSON.stringify(result), /Sup3r-Secret!/);
    assert.match(JSON.stringify(result), /\[redacted\]/);
    assert.equal(createRedactor({ API_TOKEN: 'abcd1234' })('x abcd1234 y'), 'x [redacted] y');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('result inspection flags text numbers, empty columns and missing arrays', () => {
  const analysis = analyzeQueryResult({ rows: [{ amount: '12.50', blank: null }, { amount: '3.10', blank: null }], columns: ['amount', 'blank'], placeholder: false, limitations: [] });
  const kinds = analysis.suspicious.map(item => item.kind).sort();
  assert.deepEqual(kinds, ['all-null-column', 'numeric-strings']);
  assert.match(analyzeQueryResult({ data: [] }).contractError, /rows as undefined/);
  assert.match(analyzeQueryResult([]).contractError, /an array instead of an object/);
});

test('failure classification separates source access from generated-code bugs', () => {
  const context = { env: { PG_USER: 'u', PG_PASSWORD: 'p' }, inventory: { postgresSources: [{ server: 'db.corp:5432', database: 'analytics' }], fileSources: [{ path: 'C:\\Data\\sales.csv' }] } };
  assert.equal(classifyBackendIssue({ stage: 'query', message: 'getaddrinfo ENOTFOUND localhost-db', error: { code: 'ENOTFOUND', hostname: 'localhost-db' } }, context), 'code', 'looked up a host that is not the report\'s');
  const byAddress = { ...context, inventory: { postgresSources: [{ server: '10.0.0.5:5432', database: 'analytics' }] } };
  assert.equal(classifyBackendIssue({ stage: 'query', message: 'connect ECONNREFUSED 127.0.0.1:5432', error: { code: 'ECONNREFUSED', address: '127.0.0.1', port: 5432 } }, byAddress), 'code', 'connected to the wrong address');
  assert.equal(classifyBackendIssue({ stage: 'query', message: 'connect ECONNREFUSED 10.0.0.5:5432', error: { code: 'ECONNREFUSED', address: '10.0.0.5', port: 5432 } }, byAddress), 'environment');
  assert.equal(classifyBackendIssue({ stage: 'query', message: 'getaddrinfo ENOTFOUND db.corp', error: { code: 'ENOTFOUND', hostname: 'db.corp' } }, context), 'environment');
  assert.equal(diagnoseBackendIssue({ stage: 'query', message: 'x', error: { code: 'ENOTFOUND', hostname: 'db.corp' } }, { ...context, probes: { postgres: [{ ok: true, target: 'db.corp:5432/analytics' }] } }).rule, 'converter-can-connect');
  assert.equal(classifyBackendIssue({ stage: 'query', message: "ENOENT: no such file or directory, open 'C:\\Data\\sales.csv'", error: { code: 'ENOENT', path: 'C:\\Data\\sales.csv' } }, context), 'environment');
  assert.equal(classifyBackendIssue({ stage: 'query', message: "ENOENT: no such file or directory, open 'work/report-digest.json'", error: { code: 'ENOENT', path: 'work/report-digest.json' } }, context), 'code');
  assert.equal(classifyBackendIssue({ stage: 'query', message: 'column "amount_x" does not exist', error: { code: '42703' } }, context), 'code');
  assert.equal(classifyBackendIssue({ stage: 'query', message: 'password authentication failed', error: { code: '28P01' } }, context), 'environment');
  assert.equal(classifyBackendIssue({ stage: 'query', message: 'x is not a function', error: { name: 'TypeError', message: 'x is not a function' } }, context), 'code');
});

test('loadBackend runs a checked backend in-process and closeBackend releases it', async () => {
  const dir = tempDir();
  try {
    const backend = await loadBackend({ backendFile: writeBackend(dir, `
let closed = false;
export async function createBackend() {
  return { async healthcheck() { return { ok: true }; }, async query() { return { rows: [{ closed }], columns: ['closed'] }; }, async close() { closed = true; globalThis.__hcClosed = true; } };
}`), root: dir });
    assert.deepEqual((await backend.query({ visualId: 'v1', filters: {}, limit: 10 })).rows, [{ closed: false }]);
    await closeBackend(backend);
    assert.equal(globalThis.__hcClosed, true);
    await assert.rejects(loadBackend({ backendFile: writeBackend(dir, 'export const x = 1;'), root: dir }), error => error.stage === 'load' && error.kind === 'code');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function request(url, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the report server serves the page and assets, never backend code, and guards origin and host', async () => {
  const dir = tempDir();
  const logs = [];
  const log = { info: text => logs.push(text), warn: (_s, text) => logs.push(text), error: (_s, text) => logs.push(text), detail: () => {} };
  let running = 0, peak = 0;
  const backend = {
    async query({ visualId, limit }) {
      running++; peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 30));
      running--;
      if (visualId === 'v2') throw new Error('database said no to secret-pass');
      return { rows: Array.from({ length: limit + 5 }, (_, index) => ({ index, big: 10n })), columns: ['index', 'big'] };
    }
  };
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>report</p>');
  fs.writeFileSync(path.join(dir, 'style.css'), 'p{}');
  fs.writeFileSync(path.join(dir, '.env'), 'PG_PASSWORD=x');
  writeBackend(dir, goodBackend);
  const { url, close, port } = await startReportServer({ dynamicDir: dir, backend, inventory, port: 0, attempts: 1, limit: 10, concurrency: 2, log, redact: text => text.replaceAll('secret-pass', '[redacted]') });
  try {
    assert.match((await request(url)).body, /^<!doctype html><p>report<\/p>\n<script data-html-converter="toolbar">/, 'the page, plus the converter toolbar');
    assert.equal((await request(`${url}style.css`)).status, 200);
    for (const blocked of ['backend.mjs', '.env', '..%2Fbackend.mjs', '%2e%2e/%2e%2e/package.json']) assert.equal((await request(`${url}${blocked}`)).status, 404, blocked);
    const ok = await request(`${url}api/report?visual=v1&filters=%7B%7D`);
    const body = JSON.parse(ok.body);
    assert.equal(ok.status, 200);
    assert.equal(body.rows.length, 10);
    assert.equal(body.truncated, true);
    assert.equal(body.rows[0].big, 10);
    const failed = await request(`${url}api/report?visual=v2`);
    assert.equal(failed.status, 500);
    assert.match(JSON.parse(failed.body).error, /\[redacted\]/);
    assert.equal((await request(`${url}api/report?visual=nope`)).status, 400);
    assert.equal((await request(`${url}api/report?visual=v1&filters=%5B%5D`)).status, 400);
    assert.equal((await request(`${url}api/report?visual=v1`, { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await request(`${url}api/report?visual=v1`, { headers: { Host: `evil.example:${port}` } })).status, 403, 'DNS rebinding');
    assert.equal((await request(`${url}api/report?visual=v1`, { method: 'POST' })).status, 403);
    await Promise.all(Array.from({ length: 6 }, () => request(`${url}api/report?visual=v1`)));
    assert.equal(peak, 2, 'concurrency limit');
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the report server moves to the next free port', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'index.html'), 'x');
  const first = await startReportServer({ dynamicDir: dir, backend: { query: async () => ({ rows: [] }) }, inventory, port: 0 });
  const second = await startReportServer({ dynamicDir: dir, backend: { query: async () => ({ rows: [] }) }, inventory, port: first.port, attempts: 2 });
  try { assert.notEqual(second.port, first.port); }
  finally { await first.close(); await second.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('static paths and the limiter are safe on their own', async () => {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, 'a.json'), '{}');
    assert.ok(staticFile(dir, '/a.json'));
    assert.equal(staticFile(dir, '/a.mjs'), null);
    assert.equal(staticFile(dir, '/%00a.json'), null);
    assert.equal(staticFile(dir, '/%E0%A4%A.json'), null);
    const run = createLimiter(1);
    const order = [];
    await Promise.all([1, 2, 3].map(n => run(async () => { order.push(n); })));
    assert.deepEqual(order, [1, 2, 3]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pg values arrive as report-ready numbers and dates', () => {
  assert.equal(parsePgNumeric('125.50'), 125.5);
  assert.equal(parsePgNumeric('123456789012345678901234'), '123456789012345678901234');
  assert.equal(parsePgInt8('42'), 42);
  assert.equal(parsePgInt8('9223372036854775807'), '9223372036854775807');
  assert.equal(parsePgTimestamp('2025-01-02 03:04:05.5'), '2025-01-02T03:04:05.5');
});

const [pgHost, pgPort, pgUser, pgPassword] = (process.env.HC_TEST_PG ?? '').split(':');
const skipPg = !process.env.HC_TEST_PG && 'set HC_TEST_PG=host:port:user:password to run against a real PostgreSQL';

test('helpers.postgres pools return numbers and plain dates and are read-only', { skip: skipPg }, async () => {
  const env = { PG_HOST: pgHost, PG_PORT: pgPort, PG_USER: pgUser, PG_PASSWORD: pgPassword, PG_SSL_MODE: 'disable' };
  const pool = createPostgresPool({ server: 'ignored:5432', database: 'analytics' }, env);
  try {
    const { rows } = await pool.query('SELECT sum(amount) AS total, count(*) AS n, min(order_date) AS first FROM sales.orders');
    assert.equal(typeof rows[0].total, 'number');
    assert.equal(typeof rows[0].n, 'number');
    assert.match(rows[0].first, /^\d{4}-\d{2}-\d{2}$/);
    await assert.rejects(pool.query('CREATE TABLE public.hc_should_fail (x int)'), /read-only/);
  } finally { await pool.end(); }
});

test('a backend with a wrong PostgreSQL target is sent back as code when the converter itself can connect', { skip: skipPg }, async () => {
  const dir = tempDir();
  try {
    const env = { PG_HOST: pgHost, PG_PORT: pgPort, PG_USER: pgUser, PG_PASSWORD: pgPassword, PG_SSL_MODE: 'disable' };
    const pgInventory = { ...inventory, postgresSources: [{ server: 'ignored:5432', database: 'analytics', tables: [] }] };
    const backend = writeBackend(dir, `
export async function createBackend({ env, helpers }) {
  const { Pool } = await helpers.loadPg();
  const pool = new Pool({ host: '127.0.0.1', port: 1, user: env.PG_USER, password: env.PG_PASSWORD, database: 'analytics', connectionTimeoutMillis: 2000 });
  pool.on('error', () => {});
  return {
    async healthcheck() { return { ok: true, sources: [] }; },
    async query() { const { rows } = await pool.query('SELECT 1 AS x'); return { rows, columns: ['x'] }; },
    async close() { await pool.end(); }
  };
}`);
    const result = await checkBackend({ backendFile: backend, inventory: pgInventory, env, root: dir, ...fast, probeSources: true });
    assert.equal(result.ok, false);
    assert.ok(result.issues.every(issue => issue.kind === 'code'), JSON.stringify(result.issues, null, 2));
    assert.match(result.issues[0].message, /helpers\.postgres\.createPool/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
