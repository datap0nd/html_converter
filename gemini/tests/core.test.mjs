import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, scriptJson, findDirectCsvSources, findPostgresSources, findReportModelReferences, loadData } from '../scripts/core.mjs';
import { createPreview } from '../scripts/preview.mjs';
import { makeSnapshot } from '../scripts/snapshot.mjs';
import { runGemini, runGeminiAsync } from '../scripts/gemini.mjs';
import { loadAllData, postgresQuery, postgresNativeQuery, listLiveSources, fetchLivePage } from '../scripts/sources.mjs';
import { createLivePreview } from '../scripts/live-preview.mjs';
import { validateLiveReport, geminiFailureDetail, isTransientGeminiFailure, geminiRetryDelayMs, createRunScope, pageLimitFromArgs } from '../scripts/start-live-report.mjs';
import { inputFingerprint, captureArtifacts, artifactsMatch, saveCheckpoint } from '../scripts/checkpoints.mjs';
import { exportDesktopModel, modelExportData } from '../scripts/desktop-model.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

test('CSV handles quoted commas and newlines', () => {
  const data = parseCsv('name,amount\r\n"A, B",12\r\n"Line\none",8\r\n');
  assert.deepEqual(data.columns, ['name', 'amount']);
  assert.deepEqual(data.rows, [{ name: 'A, B', amount: '12' }, { name: 'Line\none', amount: '8' }]);
});

test('embedded JSON cannot terminate its script element', () => {
  const encoded = scriptJson({ value: '</script><script>alert(1)</script>' });
  assert.equal(encoded.includes('</script>'), false);
  assert.deepEqual(JSON.parse(encoded), { value: '</script><script>alert(1)</script>' });
});

test('literal File.Contents CSV source is discovered without executing M', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const csv = path.join(dir, 'sales.csv');
    const tmdl = path.join(dir, 'sales.tmdl');
    fs.writeFileSync(csv, 'item,total\nA,10\n');
    fs.writeFileSync(tmdl, `partition Sales = m\n source = Csv.Document(File.Contents("${csv}"))\n`);
    const found = findDirectCsvSources([tmdl]);
    assert.equal(found.length, 1);
    assert.equal(found[0].available, true);
    assert.equal(found[0].path, csv);
    const data = loadData({ dataFiles: [], directCsvSources: found });
    assert.deepEqual(data.datasets[0].rows, [{ item: 'A', total: '10' }]);
    assert.equal(data.datasets[0].source, 'sales.csv');
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('Windows Gemini launcher passes arguments without shell:true warning', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'gemini.cmd'), '@echo off\r\necho %*\r\n');
    const result = runGemini(['-p', 'Read GEMINI.md'], { cwd: dir, env: { PATH: dir + path.delimiter + process.env.PATH } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Read GEMINI\.md/);
    assert.doesNotMatch(result.stderr, /Passing args.*shell/i);
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('Windows npm Gemini launcher bypasses cmd and preserves complex prompt arguments', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const packageDir = path.join(dir, 'node_modules', '@google', 'gemini-cli');
    fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'gemini.cmd'), '@echo off\r\nexit /b 9\r\n');
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ bin: { gemini: 'dist/index.mjs' } }));
    fs.writeFileSync(path.join(packageDir, 'dist', 'index.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const args = ['--model', 'gemini-3.5-flash', '--skip-trust', '-p', 'Read "file" (and keep $1 & #date)'];
    const result = runGemini(args, { cwd: dir, env: { PATH: dir + path.delimiter + process.env.PATH } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), args);
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('Windows launcher finds an existing global npm Gemini CLI through APPDATA', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const npmDir = path.join(dir, 'npm');
    const packageDir = path.join(npmDir, 'node_modules', '@google', 'gemini-cli');
    fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(npmDir, 'gemini.cmd'), '@echo off\r\nexit /b 9\r\n');
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ bin: { gemini: 'dist/index.mjs' } }));
    fs.writeFileSync(path.join(packageDir, 'dist', 'index.mjs'), 'process.stdout.write("existing-global-cli")');
    const result = runGemini(['--version'], { cwd: dir, env: { PATH: '', APPDATA: dir } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'existing-global-cli');
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('Windows asynchronous Gemini launcher returns phase output', { skip: process.platform !== 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'gemini.cmd'), '@echo off\r\necho ready\r\n');
    const result = await runGeminiAsync(['--version'], { cwd: dir, env: { PATH: dir + path.delimiter + process.env.PATH } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /ready/);
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('PostgreSQL source is discovered and queried read-only without exposing credentials in data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const tmdl = path.join(dir, 'sales.tmdl');
    fs.writeFileSync(tmdl, 'partition Sales = m\n source = let Source = PostgreSQL.Database("dbhost:5433", "analytics"), Nav = Source{[Schema="public",Item="Sales"]}[Data] in Nav\n');
    const sources = findPostgresSources([tmdl]);
    assert.equal(sources.length, 1);
    assert.deepEqual(sources[0].tables, [{ schema: 'public', item: 'Sales' }]);
    const statements = [];
    class FakeClient {
      constructor(config) { assert.equal(config.user, 'reader'); assert.equal(config.password, 'secret'); assert.equal(config.port, 5433); }
      async connect() {}
      async query(query) {
        statements.push(query);
        if (typeof query === 'string') return {};
        return { rows: [{ amount: '42' }], fields: [{ name: 'amount' }] };
      }
      async end() {}
    }
    const data = await loadAllData({ dataFiles: [], directCsvSources: [], postgresSources: sources }, { PG_USER: 'reader', PG_PASSWORD: 'secret', PG_SSL_MODE: 'disable' }, { Client: FakeClient });
    assert.equal(statements[0], 'BEGIN READ ONLY');
    assert.match(statements[1].text, /SELECT \* FROM "public"\."Sales" LIMIT \$1/);
    assert.deepEqual(data.datasets[0].rows, [{ amount: '42' }]);
    assert.equal(JSON.stringify(data).includes('secret'), false);
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('PostgreSQL identifiers are quoted and row limit is parameterized', () => {
  const query = postgresQuery('pub"lic', 'sale;drop', 10);
  assert.equal(query.text, 'SELECT * FROM "pub""lic"."sale;drop" LIMIT $1');
  assert.deepEqual(query.values, [11]);
});

test('literal Value.NativeQuery is opt-in, bounded, and run in a read-only transaction', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const tmdl = path.join(dir, 'report.tmdl');
    fs.writeFileSync(tmdl, 'partition Report = m\n source = let Source = Value.NativeQuery(PostgreSQL.Database("dbhost", "analytics"), "with x as (select 1 as ""Value"") select ""Value"" from x", null, [EnableFolding=true]), Next = Table.AddColumn(Source, "New", each 1) in Next\n');
    const sources = findPostgresSources([tmdl]);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].nativeQueries.length, 1);
    assert.equal(sources[0].nativeQueries[0].sql, 'with x as (select 1 as "Value") select "Value" from x');
    class FakeClient {
      constructor() { this.statements = []; }
      async connect() {}
      async query(query) {
        this.statements.push(query);
        if (typeof query === 'string') return {};
        assert.match(query.text, /^SELECT \* FROM \(with x as /i);
        assert.deepEqual(query.values, [11]);
        return { rows: [{ Value: 1 }], fields: [{ name: 'Value' }] };
      }
      async end() { assert.deepEqual(this.statements.filter(x => typeof x === 'string'), ['BEGIN READ ONLY', 'COMMIT']); }
    }
    const inventory = { dataFiles: [], directCsvSources: [], postgresSources: sources };
    const env = { PG_USER: 'reader', PG_PASSWORD: 'secret', PG_SSL_MODE: 'disable', PG_MAX_ROWS: '10' };
    await assert.rejects(loadAllData(inventory, env, { Client: FakeClient }), /PG_ALLOW_NATIVE_QUERIES=true/);
    const data = await loadAllData(inventory, { ...env, PG_ALLOW_NATIVE_QUERIES: 'true' }, { Client: FakeClient });
    assert.deepEqual(data.datasets[0].rows, [{ Value: 1 }]);
    assert.equal(data.datasets[0].kind, 'raw-postgres-native-query');
    assert.equal(JSON.stringify(data).includes('secret'), false);
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('native SQL wrapper binds positional parameters, rejects missing values, writes and extra statements', () => {
  assert.throws(() => postgresNativeQuery('DELETE FROM sales', 10), /SELECT or WITH/);
  assert.throws(() => postgresNativeQuery('SELECT * FROM sales WHERE id = $1', 10), /requires 1 positional value/);
  assert.deepEqual(postgresNativeQuery('SELECT * FROM sales WHERE a=$1 AND b=$2', 10, ['MENA', 2025]), {
    text: 'SELECT * FROM (SELECT * FROM sales WHERE a=$1 AND b=$2\n) AS html_converter_source LIMIT $3',
    values: ['MENA', 2025, 11]
  });
  assert.deepEqual(postgresNativeQuery("SELECT '$1;' -- comment", 10).values, [11]);
  assert.deepEqual(postgresNativeQuery('SELECT $$ $1; $$', 10).values, [11]);
  assert.throws(() => postgresNativeQuery('SELECT 1; DROP TABLE sales', 10), /only one statement/);
  assert.deepEqual(postgresNativeQuery('SELECT 1;', 10).values, [11]);
});

test('literal M positional parameters bind automatically for live and snapshot paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const tmdl = path.join(dir, 'parameterized.tmdl');
    fs.writeFileSync(tmdl, 'partition Report = m\n source = Value.NativeQuery(PostgreSQL.Database("dbhost", "analytics"), "select $1::text as name, $2::int as amount", {"MENA", 42}, [EnableFolding=true])\n');
    const inventory = { dataFiles: [], directCsvSources: [], postgresSources: findPostgresSources([tmdl]) };
    assert.deepEqual(inventory.postgresSources[0].nativeQueries[0].parameters, ['MENA', 42]);
    const env = { PG_USER: 'reader', PG_PASSWORD: 'secret', PG_SSL_MODE: 'disable', PG_ALLOW_NATIVE_QUERIES: 'true', PG_MAX_ROWS: '10' };
    const [source] = listLiveSources(inventory, env);
    const requests = [];
    class FakeClient {
      async connect() {}
      async query(query) {
        if (typeof query === 'string') return {};
        requests.push(query);
        return { rows: [{ name: 'MENA', amount: 42 }], fields: [{ name: 'name' }, { name: 'amount' }] };
      }
      async end() {}
    }
    await fetchLivePage(source, env, { limit: 2, offset: 3 }, { Client: FakeClient });
    assert.match(requests[0].text, /LIMIT \$3 OFFSET \$4$/);
    assert.deepEqual(requests[0].values, ['MENA', 42, 3, 3]);
    await loadAllData(inventory, env, { Client: FakeClient });
    assert.deepEqual(requests[1].values, ['MENA', 42, 11]);
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('parameters missing from M can be supplied per source in local environment only', async () => {
  const connection = { server: 'dbhost', database: 'analytics', tables: [{ schema: 'public', item: 'regions' }], nativeQueries: [{ sql: 'select $1::text as region', parameters: [], referencedBy: 'input/report.tmdl' }] };
  const env = { PG_USER: 'reader', PG_PASSWORD: 'secret', PG_SSL_MODE: 'disable', PG_ALLOW_NATIVE_QUERIES: 'true' };
  assert.throws(() => listLiveSources({ postgresSources: [connection] }, env), /PG_NATIVE_QUERY_PARAMS_JSON/);
  const [, source] = listLiveSources({ postgresSources: [connection] }, { ...env, PG_NATIVE_QUERY_PARAMS_JSON: '{"source-1":["MENA"]}' });
  assert.deepEqual(source.parameters, ['MENA']);
  assert.throws(() => listLiveSources({ postgresSources: [connection] }, { ...env, PG_NATIVE_QUERY_PARAMS_JSON: '{"source-1":{"region":"MENA"}}' }), /JSON array/);
});

test('live PostgreSQL path pages native SQL without embedding credentials or all rows', async () => {
  const connection = { server: 'dbhost', database: 'analytics', tables: [], nativeQueries: [{ sql: 'with x as (select 1 as value) select value from x', referencedBy: 'input/report.tmdl' }] };
  const env = { PG_USER: 'reader', PG_PASSWORD: 'private-password', PG_SSL_MODE: 'disable', PG_ALLOW_NATIVE_QUERIES: 'true' };
  assert.throws(() => listLiveSources({ postgresSources: [connection] }, { ...env, PG_ALLOW_NATIVE_QUERIES: 'false' }), /PG_ALLOW_NATIVE_QUERIES=true/);
  const [source] = listLiveSources({ postgresSources: [connection] }, env);
  const statements = [];
  class FakeClient {
    constructor(config) { assert.equal(config.password, 'private-password'); }
    async connect() {}
    async query(query) {
      statements.push(query);
      if (typeof query === 'string') return {};
      return { rows: [{ value: 1 }, { value: 2 }, { value: 3 }], fields: [{ name: 'value' }] };
    }
    async end() {}
  }
  const page = await fetchLivePage(source, env, { limit: 2, offset: 200 }, { Client: FakeClient });
  assert.equal(statements[0], 'BEGIN READ ONLY');
  assert.match(statements[1].text, /^SELECT \* FROM \(with x as /i);
  assert.deepEqual(statements[1].values, [3, 200]);
  assert.equal(statements[2], 'COMMIT');
  assert.deepEqual(page.rows, [{ value: 1 }, { value: 2 }]);
  assert.equal(page.hasMore, true);
  assert.equal(JSON.stringify(page).includes('private-password'), false);
  await assert.rejects(fetchLivePage(source, env, { limit: 1000 }, { Client: FakeClient }), /1–200/);
});

test('live preview writes source browser but no credentials or data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const file = createLivePreview({ project: 'input/Demo.pbip', pages: [{ name: 'Overview', visuals: [{ id: 'v1', type: 'barChart', title: 'Sales' }] }] }, [{ id: 'source-0', name: 'Native query 1' }], dir);
    const markup = fs.readFileSync(file, 'utf8');
    assert.match(markup, /\/api\/rows/);
    assert.match(markup, /Power Query steps after source SQL/);
    assert.match(markup, /barChart/);
    assert.doesNotMatch(markup, /PG_PASSWORD|private-password/);
    new vm.Script(markup.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? 'syntax error');
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('live report validation requires generated visual coverage, a backend call, and no embedded secret', () => {
  const inventory = { pages: [{ id: 'page-a', visuals: [{ id: 'visual-a' }] }] };
  const review = { status: 'warnings', limitations: [], unverified: ['Power BI parity'] };
  const valid = '<html><div id="report-status"></div><section data-page-id="page-a"><article data-visual-id="visual-a"></article></section><script>fetch("/api/report?visual=visual-a")</script></html>';
  assert.deepEqual(validateLiveReport(inventory, valid, review, { PG_PASSWORD: 'secret-password' }), []);
  assert.match(validateLiveReport(inventory, valid.replace('visual-a', 'missing'), review).join(' '), /Missing visual/);
  assert.match(validateLiveReport(inventory, valid + 'secret-password', review, { PG_PASSWORD: 'secret-password' }).join(' '), /contains PG_PASSWORD/);
  assert.match(validateLiveReport(inventory, valid, { ...review, status: 'blocked' }).join(' '), /did not approve/);
});

test('Gemini CLI failure detail surfaces JSON errors while redacting source passwords', () => {
  assert.equal(geminiFailureDetail({ stdout: JSON.stringify({ error: { message: 'Bad password secret-value' } }), stderr: '' }, { PG_PASSWORD: 'secret-value' }), 'Bad password [redacted]');
  assert.equal(geminiFailureDetail({ stdout: 'model unavailable', stderr: '' }), 'model unavailable');
});

test('Gemini rate limits and capacity errors use bounded exponential retry delays', () => {
  assert.equal(isTransientGeminiFailure({ status: 429, stdout: '', stderr: '' }), true);
  assert.equal(isTransientGeminiFailure({ status: 1, stdout: '{"error":"RESOURCE_EXHAUSTED"}', stderr: '' }), true);
  assert.equal(isTransientGeminiFailure({ status: 1, stdout: '', stderr: 'No capacity available for model' }), true);
  assert.equal(isTransientGeminiFailure({ status: 1, stdout: '', stderr: '256-color support not detected' }), false);
  assert.equal(geminiRetryDelayMs({ stderr: 'retryDelay: 12s' }, 1), 12_000);
  assert.equal(geminiRetryDelayMs({}, 1), 30_000);
  assert.equal(geminiRetryDelayMs({}, 5), 300_000);
});

test('two-page test scope is isolated from the all-pages conversion', () => {
  const full = createRunScope();
  const testScope = createRunScope(2);
  assert.notEqual(testScope.workDir, full.workDir);
  assert.notEqual(testScope.dynamicDir, full.dynamicDir);
  assert.match(testScope.workDir.replaceAll('\\', '/'), /work\/scopes\/first-2-pages$/);
  assert.match(testScope.dynamicDir.replaceAll('\\', '/'), /output\/first-2-pages\/dynamic$/);
  assert.equal(pageLimitFromArgs(['--page-limit', '2']), 2);
  assert.equal(pageLimitFromArgs([]), null);
  assert.throws(() => pageLimitFromArgs(['--page-limit', 'none']), /positive integer/);
});

test('converter checkpoints survive restarts and invalidate when PBIP or artifacts change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const input = path.join(dir, 'input');
    const work = path.join(dir, 'work');
    fs.mkdirSync(input);
    fs.mkdirSync(work);
    fs.writeFileSync(path.join(input, 'report.pbip'), '{"version":1}');
    fs.writeFileSync(path.join(work, 'phase.json'), '{"status":"complete"}');
    const fingerprint = inputFingerprint(input);
    const artifacts = captureArtifacts(dir, ['work/phase.json']);
    const stateFile = path.join(work, 'live-state.json');
    saveCheckpoint(stateFile, { version: 1, inputFingerprint: fingerprint, phases: { phase: { artifacts } } });
    assert.equal(artifactsMatch(dir, JSON.parse(fs.readFileSync(stateFile, 'utf8')).phases.phase.artifacts), true);
    saveCheckpoint(stateFile, { version: 1, inputFingerprint: fingerprint, phases: { phase: { artifacts } }, resumed: true });
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).resumed, true);
    fs.writeFileSync(path.join(work, 'phase.json'), '{"status":"stale"}');
    assert.equal(artifactsMatch(dir, artifacts), false);
    fs.writeFileSync(path.join(input, 'report.pbip'), '{"version":2}');
    assert.notEqual(inputFingerprint(input), fingerprint);
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('Desktop model export uses DAX Studio result tables without inspecting SQL connectors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const pbipPath = path.join(dir, 'Example.pbip');
    fs.writeFileSync(pbipPath, '{}');
    const calls = [];
    const run = (command, args) => {
      calls.push({ command, args });
      fs.writeFileSync(path.join(args[2], 'Sales.csv'), 'Region,Amount\nNorth,42\n');
      return { status: 0, stdout: '', stderr: '' };
    };
    const result = await exportDesktopModel({ project: 'input/Example.pbip' }, {}, { run, pbipPath, workDir: dir });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 2), ['export', 'csv']);
    assert.deepEqual(calls[0].args.slice(-2), ['--server', 'Example.pbip']);
    assert.equal(result.data.datasets[0].kind, 'desktop-model-export');
    assert.deepEqual(result.data.datasets[0].rows, [{ Region: 'North', Amount: '42' }]);
    assert.throws(() => modelExportData([path.join(result.exportDir, 'Sales.csv')], 3), /above the configured/);
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('remote PBIR semantic-model references are rejected for no-Fabric Desktop mode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const pbir = path.join(dir, 'definition.pbir');
    fs.writeFileSync(pbir, JSON.stringify({ datasetReference: { byConnection: { connectionString: 'remote' } } }));
    const references = findReportModelReferences([pbir]);
    assert.equal(references[0].kind, 'remote-connection');
    await assert.rejects(exportDesktopModel({ project: 'input/Example.pbip', reportModelReferences: references }, {}, { run() {} }), /does not clearly reference a local semantic model/);
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('unsupported connectors and unreadable referenced CSVs stop refresh', async () => {
  await assert.rejects(loadAllData({ dataFiles: [], unsupportedConnectors: [{ connector: 'Odbc.Query' }] }), /Unsupported source connector/);
  await assert.rejects(loadAllData({ dataFiles: [], directCsvSources: [{ path: 'missing.csv', available: false }] }), /no longer readable/);
});

test('PBIP-only preview is explicit and static snapshot embeds the local data contract', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const dynamic = path.join(dir, 'dynamic');
    const stat = path.join(dir, 'static');
    createPreview({ project: 'input/Demo.pbip', pages: [{ name: 'Overview', visuals: [{ id: 'v1', title: 'Sales', type: 'barChart', source: 'input/Demo.Report/definition/pages/p1/visuals/v1/visual.json' }] }] }, { datasets: [] }, dynamic);
    const source = fs.readFileSync(path.join(dynamic, 'index.html'), 'utf8');
    assert.match(source, /no readable data source found/i);
    assert.match(source, /barChart/);
    const target = makeSnapshot(dynamic, stat);
    const rendered = fs.readFileSync(target, 'utf8');
    assert.doesNotMatch(rendered, /<script type="application\/json" id="embedded-report-data">__EMBEDDED_REPORT_DATA__<\/script>/);
    assert.match(rendered, /"datasets":\[\]/);
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
