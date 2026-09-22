import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, scriptJson, findDirectCsvSources, findPostgresSources, loadData } from '../scripts/core.mjs';
import { createPreview } from '../scripts/preview.mjs';
import { makeSnapshot } from '../scripts/snapshot.mjs';
import { runGemini } from '../scripts/gemini.mjs';
import { loadAllData, postgresQuery } from '../scripts/sources.mjs';
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
