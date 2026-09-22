import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, scriptJson, findDirectCsvSources, findPostgresSources, findReportModelReferences, loadData } from '../scripts/core.mjs';
import { createPreview } from '../scripts/preview.mjs';
import { makeSnapshot } from '../scripts/snapshot.mjs';
import { runGemini, runGeminiAsync } from '../scripts/gemini.mjs';
import { loadAllData, postgresQuery, postgresNativeQuery } from '../scripts/sources.mjs';
import { exportDesktopModel, modelExportData } from '../scripts/desktop-model.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

test('native SQL wrapper rejects writes, parameters, and extra statements', () => {
  assert.throws(() => postgresNativeQuery('DELETE FROM sales', 10), /SELECT or WITH/);
  assert.throws(() => postgresNativeQuery('SELECT * FROM sales WHERE id = $1', 10), /Parameterized/);
  assert.throws(() => postgresNativeQuery('SELECT 1; DROP TABLE sales', 10), /only one statement/);
  assert.deepEqual(postgresNativeQuery('SELECT 1;', 10).values, [11]);
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
