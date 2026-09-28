// The comparison with Power BI Desktop: DAX rebuilt from PBIR visuals and filters,
// value-by-value comparison, the Desktop engine discovery, the fix loop, and the
// served page's Refresh / Power BI check toolbar.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { visualDaxQuery, daxLiteral } from '../scripts/dax-query.mjs';
import { compareVisual, parityFixRequest, normalizeValue } from '../scripts/parity.mjs';
import { readPortFile, findDesktopInstances, runPowerBiQueries } from '../scripts/pbi-desktop.mjs';
import { startReportServer, withToolbar } from '../scripts/server.mjs';
import { readJson } from '../scripts/core.mjs';
import { createSandbox, fixturesDir, geminiDir } from '../selftest/sandbox.mjs';

const reportDir = path.join(fixturesDir, 'SalesCsvFull', 'SalesCsv.Report', 'definition');
const fakeCli = path.join(geminiDir, 'selftest', 'fake-gemini-cli.mjs');
const fakeRunner = path.join(geminiDir, 'selftest', 'fake-pbi-runner.mjs');

function pageOf(pageId) {
  const dir = path.join(reportDir, 'pages', pageId, 'visuals');
  const visuals = fs.readdirSync(dir).map(id => ({ id, json: readJson(path.join(dir, id, 'visual.json')) }));
  return { page: readJson(path.join(reportDir, 'pages', pageId, 'page.json')), visuals };
}

function query(pageId, visualId, extra = {}) {
  const { page, visuals } = pageOf(pageId);
  return visualDaxQuery({ visual: visuals.find(item => item.id === visualId).json, page, report: readJson(path.join(reportDir, 'report.json')), pageVisuals: visuals, ...extra });
}

// ---------- DAX from PBIR ----------

test('a chart query groups by its axis and applies report, page, visual filters and slicer selections', () => {
  const q = query('06ac133cdc7441821cad', '1107515c3289402ba465');
  assert.deepEqual(q.groupBy.map(item => item.queryRef), ['Product.Category']);
  assert.deepEqual(q.values.map(item => item.queryRef), ['Sales.Total Sales']);
  assert.equal(q.dax, `EVALUATE
  TOPN(2001, SUMMARIZECOLUMNS('Product'[Category], FILTER(ALL('Product'[Category]), NOT ('Product'[Category] IN {"Components"})), FILTER(ALL('Date'[Year]), 'Date'[Year] >= 2024), FILTER(ALL('Sales'[Channel]), 'Sales'[Channel] IN {"Online", "Retail"}), FILTER(ALL('Date'[Date]), ('Date'[Date] >= DATE(2024, 1, 1)) && ('Date'[Date] < DATE(2025, 7, 1))), "v0", 'Sales'[Total Sales]))`);
});

test('a slicer is not filtered by its own selection; a card has no grouping; drillthrough fields without a value are ignored', () => {
  const slicer = query('06ac133cdc7441821cad', 'd0641f8fbdf1ee7529c0');
  assert.doesNotMatch(slicer.dax, /'Date'\[Date\] >= DATE\(2024, 1, 1\)/);
  const card = query('06ac133cdc7441821cad', '568b673c59bca76bf6bf');
  assert.deepEqual(card.groupBy, []);
  assert.match(card.dax, /SUMMARIZECOLUMNS\(FILTER\(ALL\('Product'\[Category\]\)/);
  const drillthrough = query('deca0623f7ef3d0efae2', 'bec53002685d169e4c20');
  assert.equal(drillthrough.filters, 1, 'only the report filter; the drillthrough field has no saved value');
});

test('a Top N visual filter is evaluated under the visual\'s other filters', () => {
  const q = query('8f24fddaf545ef5e59c5', 'b5459f87d01c4be39f5d');
  assert.match(q.dax, /CALCULATETABLE\(TOPN\(5, VALUES\('Product'\[Product Name\]\), 'Sales'\[Total Sales\], DESC\), FILTER\(ALL\('Product'\[Category\]\), NOT \('Product'\[Category\] IN \{"Components"\}\)\), FILTER\(ALL\('Sales'\[Channel\]\), 'Sales'\[Channel\] IN \{"Online", "Retail"\}\)\)/);
  assert.deepEqual(q.values.map(item => item.queryRef), ['Sum(Sales.Quantity)', 'Sales.Total Sales', 'Sales.Margin %']);
  assert.match(q.dax, /"v0", SUM\('Sales'\[Quantity\]\)/);
});

test('relative date filters use today\'s date; week units and unknown conditions are never guessed', () => {
  const relative = {
    Version: 2, From: [{ Name: 'd', Entity: 'Date', Type: 0 }],
    Where: [{ Condition: { Between: { Expression: { Column: { Expression: { SourceRef: { Source: 'd' } }, Property: 'Date' } }, LowerBound: { DateSpan: { Expression: { DateAdd: { Expression: { DateAdd: { Expression: { Now: {} }, Amount: 1, TimeUnit: 0 } }, Amount: -3, TimeUnit: 2 } }, TimeUnit: 0 } }, UpperBound: { DateSpan: { Expression: { Now: {} }, TimeUnit: 0 } } } } }]
  };
  const visual = { name: 'x', visual: { query: { queryState: { Values: { projections: [{ field: { Measure: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Total' } }, queryRef: 'Sales.Total' }] } } } } };
  const q = visualDaxQuery({ visual, page: { filterConfig: { filters: [{ filter: relative }] } }, now: new Date(2026, 8, 28, 15, 0) });
  assert.match(q.dax, /'Date'\[Date\] >= DATE\(2026, 6, 29\) && 'Date'\[Date\] < DATE\(2026, 9, 29\)/, 'last 3 months including today');
  assert.deepEqual(q.relativeDates, ['page filter: from 2026-06-29, before 2026-09-29']);
  const weeks = JSON.parse(JSON.stringify(relative).replace('"Amount":-3,"TimeUnit":2', '"Amount":-3,"TimeUnit":1'));
  assert.equal(visualDaxQuery({ visual, page: { filterConfig: { filters: [{ filter: weeks }] } } }).dax, null);
  assert.equal(daxLiteral("'It''s'").dax, '"It\'s"');
  assert.equal(daxLiteral('12L').dax, '12');
  assert.equal(daxLiteral('2.5D').dax, '2.5');
  assert.equal(daxLiteral("datetime'2024-02-29T13:05:00'").dax, '(DATE(2024, 2, 29) + TIME(13, 5, 0))');
  assert.equal(daxLiteral('null').dax, 'BLANK()');
  assert.ok(daxLiteral('something').unsupported);
});

// ---------- comparison ----------

const spec = { visualId: 'v1', page: 'P', type: 'clusteredColumnChart', title: 'Sales', dax: 'EVALUATE ...', groupBy: [{ queryRef: 'Product.Category' }], values: [{ queryRef: 'Sales.Total Sales' }, { queryRef: 'Sales.Margin %' }], unsupported: [] };
const truth = { columns: ['Product[Category]', '[v0]', '[v1]'], rows: [['Bikes', 1200.5, 0.124], ['Caps', 30, null]] };

test('rows are matched by their grouping fields and values compared with a tolerance', () => {
  const same = compareVisual(spec, truth, { rows: [{ 'Product.Category': 'caps', 'Sales.Total Sales': '30', 'Sales.Margin %': null, label: 'x' }, { 'Product.Category': 'Bikes', 'Sales.Total Sales': 1200.5000000001, 'Sales.Margin %': 0.124 }, { 'Product.Category': 'Other', 'Sales.Total Sales': 0, 'Sales.Margin %': null }] });
  assert.equal(same.status, 'match', JSON.stringify(same));
  assert.equal(same.checkedValues, 4);
});

test('differences carry the likely cause: percent scale, zero for blank, text numbers, missing rows', () => {
  const result = compareVisual(spec, truth, { rows: [{ 'Product.Category': 'Bikes', 'Sales.Total Sales': 1200.5, 'Sales.Margin %': 12.4 }, { 'Product.Category': 'Caps', 'Sales.Total Sales': 30, 'Sales.Margin %': 0 }, { 'Product.Category': 'Helmets', 'Sales.Total Sales': 5, 'Sales.Margin %': 0.1 }] });
  assert.equal(result.status, 'mismatch');
  assert.match(result.differences[0].hint, /100 times Power BI's/);
  assert.match(result.differences[1].hint, /Power BI shows blank here/);
  assert.equal(result.extraRows.length, 1);
  const missing = compareVisual(spec, truth, { rows: [{ 'Product.Category': 'Bikes', 'Sales.Total Sales': 1200.5, 'Sales.Margin %': 0.124 }] });
  assert.equal(missing.missingRows.length, 1);
  const names = compareVisual(spec, truth, { rows: [{ category: 'Bikes', sales: 1200.5 }], columns: ['category', 'sales'] });
  assert.equal(names.kind, 'field-names');
  assert.deepEqual(names.missingColumns, ['Product.Category', 'Sales.Total Sales', 'Sales.Margin %']);
  const request = parityFixRequest([result, names]);
  assert.equal(request.visuals.length, 2);
  assert.deepEqual(request.visuals[0].powerBiRows[0], { 'Product.Category': 'Bikes', 'Sales.Total Sales': 1200.5, 'Sales.Margin %': 0.124 });
  assert.match(request.about, /ground truth/);
});

test('cards: Power BI returns no row for a blank measure, the report one row of nulls', () => {
  const card = { ...spec, groupBy: [], values: [{ queryRef: 'Sales.Margin %' }] };
  assert.equal(compareVisual(card, { columns: ['[v0]'], rows: [] }, { rows: [{ 'Sales.Margin %': null }] }).status, 'match');
  assert.equal(compareVisual(card, { columns: ['[v0]'], rows: [] }, { rows: [{ 'Sales.Margin %': 0 }] }).status, 'mismatch');
  assert.equal(compareVisual(card, { columns: ['[v0]'], rows: [[0.2]] }, { rows: [], placeholder: true, limitations: ['custom visual'] }).kind, 'placeholder');
  assert.equal(compareVisual({ ...card, dax: null, unsupported: ['x'] }, null, null).status, 'not-compared');
  assert.equal(compareVisual(card, { error: 'syntax' }, { rows: [] }).status, 'not-compared');
  assert.equal(normalizeValue('2024-01-31T00:00:00.000'), '2024-01-31');
  assert.equal(normalizeValue('2024-01-31T17:30:00.000'), '2024-01-31T17:30:00');
});

// ---------- Power BI Desktop discovery and the query runner ----------

test('Desktop instances are found from their UTF-16 port files, newest first', () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-pbi-local-'));
  try {
    const make = (name, port, age) => {
      const dir = path.join(local, 'Microsoft', 'Power BI Desktop', 'AnalysisServicesWorkspaces', name, 'Data');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'msmdsrv.port.txt');
      fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(port), 'utf16le')]));
      const time = new Date(Date.now() - age);
      fs.utimesSync(file, time, time);
      return file;
    };
    assert.equal(readPortFile(make('AnalysisServicesWorkspace_old', 51000, 60_000)), 51000);
    make('AnalysisServicesWorkspace_new', 52000, 0);
    assert.deepEqual(findDesktopInstances({ LOCALAPPDATA: local }).map(item => item.port), [52000, 51000]);
    assert.deepEqual(findDesktopInstances({ HC_PBI_PORT: '1234, 5678' }).map(item => item.port), [1234, 5678]);
  } finally { fs.rmSync(local, { recursive: true, force: true }); }
});

test('queries run through the runner process and come back as rows', async () => {
  const lines = [];
  const result = await runPowerBiQueries({ ports: [1], tables: ['Sales'], queries: [{ id: 'v1', dax: 'EVALUATE ...', groupBy: ['A.B'], values: ['S.M'] }], env: { HC_PBI_QUERY_RUNNER: fakeRunner }, onLine: line => lines.push(line) });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results[0].rows, [['A.B 0', 100], ['A.B 1', 101]]);
  assert.match(lines.join('\n'), /fake runner \(match\): 1 quer/);
  const failed = await runPowerBiQueries({ ports: [1], tables: [], queries: [], env: { HC_PBI_QUERY_RUNNER: path.join(os.tmpdir(), 'missing-runner.mjs') } });
  assert.equal(failed.ok, false);
});

test('the ADOMD query script parses, and writes culture-independent JSON', { skip: !hasPwsh() && 'pwsh is not installed' }, () => {
  const script = path.join(geminiDir, 'scripts', 'pbi-query.ps1');
  const errors = execFileSync('pwsh', ['-NoProfile', '-Command', `$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$t,[ref]$e)|Out-Null;$e.Count`], { encoding: 'utf8' }).trim();
  assert.equal(errors, '0');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-pbi-ps-'));
  try {
    // No ADOMD client here: the script must still write a result file that says so.
    fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ ports: [1], tables: ['Sales'], queries: [], toolsDir: path.join(dir, 'tools'), allowDownload: false }));
    const run = spawnSync('pwsh', ['-NoProfile', '-File', script, '-RequestFile', path.join(dir, 'request.json'), '-ResultFile', path.join(dir, 'result.json')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(run.stderr, '');
    const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
    assert.equal(result.ok, false);
    assert.match(result.error, /No usable ADOMD\.NET client library/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function hasPwsh() {
  try { execFileSync('pwsh', ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// ---------- end to end ----------

function convert(scenario, env = {}) {
  const sandbox = createSandbox();
  try {
    const result = spawnSync(process.execPath, [path.join(sandbox.dir, 'scripts', 'start-live-report.mjs'), '--page-limit', '2', '--no-serve'], {
      cwd: sandbox.dir, encoding: 'utf8',
      env: { ...process.env, HC_GEMINI_ENTRY: fakeCli, FAKE_GEMINI_STATE: path.join(sandbox.dir, 'state.json'), FAKE_GEMINI_SCENARIO: scenario, GEMINI_API_KEY: 'test-key', HC_PBI_PORT: '51234', HC_PBI_QUERY_RUNNER: fakeRunner, ...env }
    });
    const calls = fs.existsSync(path.join(sandbox.dir, 'state.json')) ? JSON.parse(fs.readFileSync(path.join(sandbox.dir, 'state.json'), 'utf8')).calls.map(call => call.phase) : [];
    const parity = readJson(path.join(sandbox.dir, 'work', 'scopes', 'first-2-pages', 'live-parity.json'));
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, calls, parity };
  } finally { sandbox.cleanup(); }
}

test('end to end: every visual matching Power BI is confirmed without extra Gemini calls', () => {
  const result = convert('parity-keys');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.calls, ['01', '02', '03']);
  assert.match(result.stdout, /\[parity\] MATCH card "Total sales" \(v1\) on "Overview": 1 value\(s\) in 1 row\(s\)\./);
  assert.match(result.stdout, /Power BI comparison: 5 match, 0 differ, 0 not compared/);
  assert.equal(result.parity.summary.match, 5);
  assert.equal(result.stderr, '');
});

test('end to end: values that differ from Power BI go back to Gemini with the true rows, then match', () => {
  const result = convert('parity-wrong');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.calls, ['01', '02', '03', '06']);
  assert.match(result.stdout, /DIFFERS card "Total sales" \(v1\) on "Overview": 1 value\(s\) differ; e\.g\. Sales\.Total Sales: Power BI 100, report 10000 \(the report value is 100 times Power BI's/);
  assert.match(result.stdout, /Asking Gemini to fix 4 visual\(s\) whose data differs from Power BI \(round 1 of 2\)/);
  assert.equal(result.parity.summary.mismatch, 0);
});

test('end to end: differences that remain after the fix rounds are served and named', () => {
  const result = convert('parity-unfixable');
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.calls, ['01', '02', '03', '06', '06']);
  assert.equal(result.parity.summary.mismatch, 4);
  assert.match(result.stdout, /round 2 of 2/);
});

test('end to end: without a usable Power BI client the report is still built, with a clear note', () => {
  const failed = convert('parity-keys', { FAKE_PBI_MODE: 'error' });
  assert.equal(failed.code, 0, failed.stdout);
  assert.match(failed.stdout, /Could not query Power BI Desktop, so the numbers were NOT compared: No usable ADOMD\.NET client library/);
  const rejected = convert('parity-keys', { FAKE_PBI_MODE: 'query-error' });
  assert.equal(rejected.code, 0, rejected.stdout);
  assert.match(rejected.stdout, /NOT COMPARED card "Total sales" \(v1\) on "Overview": Power BI Desktop could not run the rebuilt query/);
  assert.deepEqual(rejected.calls, ['01', '02', '03'], 'a query Power BI rejects is not sent to Gemini as a difference');
});

// ---------- the served page ----------

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => { let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body })); }).on('error', reject);
  });
}

test('the served page gets the Refresh / Power BI check toolbar; Refresh restarts the backend', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-toolbar-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><body><div data-visual-id="v1"></div></body>');
  let generation = 0;
  const makeBackend = () => { const id = ++generation; return { query: async () => ({ rows: [{ generation: id }], columns: ['generation'] }) }; };
  const inventory = { pages: [{ id: 'p', visuals: [{ id: 'v1', role: 'data' }] }] };
  const { url, close } = await startReportServer({
    dynamicDir: dir, backend: makeBackend(), inventory, port: 0,
    status: () => ({ parity: { checkedAt: '2026-09-28T10:00:00Z', summary: { match: 0, mismatch: 1, notCompared: 0, total: 1 }, visuals: [{ visualId: 'v1', status: 'mismatch', reason: '1 value(s) differ' }] } }),
    reloadBackend: async () => makeBackend()
  });
  try {
    const page = await get(url);
    assert.match(page.body, /<script data-html-converter="toolbar">[\s\S]*Refresh data[\s\S]*<\/script>\s*<\/body>/);
    assert.doesNotMatch(page.body.slice(page.body.indexOf('data-html-converter')), /<\/style>/, 'no raw </ inside the inline script');
    assert.doesNotMatch(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), /toolbar/, 'the saved file is unchanged');
    assert.match((await get(`${url}index.html`)).body, /data-html-converter="toolbar"/);
    const status = JSON.parse((await get(`${url}api/status`)).body);
    assert.equal(status.parity.summary.mismatch, 1);
    assert.equal(status.refreshable, true);
    assert.deepEqual(JSON.parse((await get(`${url}api/report?visual=v1`)).body).rows, [{ generation: 1 }]);
    const refresh = JSON.parse((await get(`${url}api/refresh`)).body);
    assert.equal(refresh.ok, true);
    assert.deepEqual(JSON.parse((await get(`${url}api/report?visual=v1`)).body).rows, [{ generation: 2 }], 'queries use the new backend');
    assert.equal(withToolbar('<p>no body tag</p>').endsWith('</script>\n'), true);
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
