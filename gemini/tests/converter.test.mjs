import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createSandbox, geminiDir, fixturesDir } from './support/fixtures.mjs';
import { parseTmdl, loadSemanticModel, scopeModel, daxReferences, mReferences, parseQualifiedColumn } from '../scripts/digest.mjs';
import { classifyVisual, visualTitle, describeField } from '../scripts/pbir.mjs';
import { runGeminiStream, unsupportedFlag, toolTarget, shimTarget } from '../scripts/gemini.mjs';
import { selectPages, classifyBackendIssue, diagnoseGeminiFailure, normalizeReviewStatus, validateLiveReport, stagedInputAllowed, scopedConnectors, responseTextArtifact, phaseSettings } from '../scripts/start-live-report.mjs';
import { consoleSafe, redact, addSecret } from '../scripts/log.mjs';

const fakeCli = path.join(geminiDir, 'tests', 'support', 'fake-gemini-cli.mjs');

function runConverter(sandbox, { scenario = '', args = ['--page-limit', '2', '--no-serve'], env = {}, onLine } = {}) {
  return new Promise(resolve => {
    const state = path.join(sandbox.dir, 'fake-state.json');
    const child = spawn(process.execPath, [path.join(sandbox.dir, 'scripts', 'start-live-report.mjs'), ...args], {
      cwd: sandbox.dir,
      env: { ...process.env, HC_GEMINI_ENTRY: fakeCli, FAKE_GEMINI_SCENARIO: scenario, FAKE_GEMINI_STATE: state, GEMINI_API_KEY: 'test-key', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; onLine?.(stdout, child); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      const calls = fs.existsSync(state) ? JSON.parse(fs.readFileSync(state, 'utf8')).calls.map(call => call.phase) : [];
      resolve({ code, stdout, stderr, calls });
    });
  });
}

function withSandbox(fn) {
  return async () => {
    const sandbox = createSandbox();
    try { await fn(sandbox); } finally { sandbox.cleanup(); }
  };
}

// ---------- PBIR / TMDL digest ----------

test('TMDL parser reads multi-line measures, fenced and calculated partitions, and quoted names', () => {
  const nodes = parseTmdl(fs.readFileSync(path.join(fixturesDir, 'SalesCsv/SalesCsv.SemanticModel/definition/tables/Sales.tmdl'), 'utf8'));
  const table = nodes[0];
  assert.equal(table.kind, 'table');
  assert.equal(table.name, 'Sales');
  const yoy = table.children.find(child => child.name === 'Sales YoY %');
  assert.match(yoy.value, /^VAR CurrentSales = \[Total Sales\]\nVAR PriorSales = CALCULATE/);
  assert.equal(yoy.props.formatString, '0.0%');
  assert.equal(table.children.find(child => child.name === 'Total Sales').description, 'Sum of order amounts');
  const partition = table.children.find(child => child.kind === 'partition');
  assert.equal(partition.value, 'm');
  assert.match(partition.props.source, /^let\n {4}Source = Csv\.Document/);
  assert.deepEqual(parseQualifiedColumn("'Date'.Date"), { table: 'Date', column: 'Date' });
  assert.deepEqual(parseQualifiedColumn("'Sales Table'.'Order ''Key'''"), { table: 'Sales Table', column: "Order 'Key'" });
  const fenced = parseTmdl("table T\n\tpartition T = m\n\t\tsource = ```\n\t\t\t\tlet a = 1 in a\n\t\t\t\t```\n\t\tmode: import\n");
  assert.equal(fenced[0].children[0].props.source, 'let a = 1 in a');
  assert.equal(fenced[0].children[0].props.mode, 'import');
});

test('model scoping follows DAX and M references and drops unused measures', () => {
  const files = fs.readdirSync(path.join(fixturesDir, 'SalesCsv/SalesCsv.SemanticModel/definition'), { recursive: true }).map(file => path.join(fixturesDir, 'SalesCsv/SalesCsv.SemanticModel/definition', file)).filter(file => fs.statSync(file).isFile());
  const model = loadSemanticModel(files, fixturesDir);
  assert.equal(model.format, 'tmdl');
  assert.deepEqual(model.tables.map(table => table.name).sort(), ['Date', 'Product', 'Sales']);
  assert.equal(model.relationships.length, 2);
  assert.deepEqual(model.relationships[1], { name: '1e6d8f22-cccc-4c4d-8e9f-2a3b4c5d6e7f', source: 'SalesCsv/SalesCsv.SemanticModel/definition/relationships.tmdl', fromTable: 'Sales', fromColumn: 'OrderDate', toTable: 'Date', toColumn: 'Date', crossFilteringBehavior: 'oneDirection', active: true });
  const scoped = scopeModel(model, [{ kind: 'measure', table: 'Sales', name: 'Sales YoY %' }]);
  const sales = scoped.tables.find(table => table.name === 'Sales');
  assert.deepEqual(sales.measures.map(measure => measure.name).sort(), ['Sales YoY %', 'Total Sales']);
  assert.equal(sales.omittedMeasureCount, 2);
  assert.ok(scoped.tables.some(table => table.name === 'Date'), 'DAX reference to Date table is followed');
  assert.deepEqual(daxReferences('SUMX(Sales, Sales[Qty]) + DATE(2020,1,1) + [Total Sales]', ['Sales', 'Date']).tables, ['Sales']);
  assert.deepEqual(mReferences('let a = Date.From(x), b = Sales, c = #"Color Lookup" in b', ['Sales', 'Date', 'Color Lookup']).sort(), ['Color Lookup', 'Sales']);
});

test('PBIR visuals are classified and titled from current and older locations', () => {
  const read = (page, visual) => JSON.parse(fs.readFileSync(path.join(fixturesDir, `SalesCsv/SalesCsv.Report/definition/pages/${page}/visuals/${visual}/visual.json`), 'utf8'));
  assert.equal(classifyVisual(read('a1b2c3d4e5f6a7b8c9d0', 'c0ffee00000000000002')), 'data');
  assert.equal(classifyVisual(read('a1b2c3d4e5f6a7b8c9d0', 'c0ffee00000000000004')), 'decorative');
  assert.equal(classifyVisual(read('a1b2c3d4e5f6a7b8c9d0', 'c0ffee000000000group1')), 'group');
  assert.equal(visualTitle(read('a1b2c3d4e5f6a7b8c9d0', 'c0ffee00000000000002')), 'Sales by category');
  assert.equal(visualTitle({ visual: { objects: { title: [{ properties: { text: { expr: { Literal: { Value: "'It''s old'" } } } } }] } } }), "It's old");
  assert.deepEqual(describeField({ Aggregation: { Expression: { Column: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Amount' } }, Function: 0 } }), { kind: 'aggregation', table: 'Sales', name: 'Amount', of: 'column', aggregation: 'Sum' });
});

test('first-N-pages scope skips hidden tooltip pages but keeps order', () => {
  const v = [{ id: 'x', role: 'data' }];
  const pages = [{ id: 'a', visuals: v }, { id: 'tip', hidden: true, visuals: v }, { id: 'empty', visuals: [] }, { id: 'b', visuals: v }, { id: 'c', visuals: v }];
  assert.deepEqual(selectPages(pages, 2).map(page => page.id), ['a', 'b']);
  assert.deepEqual(selectPages([{ id: 'tip', hidden: true, visuals: v }, { id: 'a', visuals: v }], 2).map(page => page.id), ['tip', 'a']);
  assert.deepEqual(selectPages([{ id: 'empty', visuals: [] }, { id: 'a', visuals: v }], 2).map(page => page.id), ['empty', 'a']);
  assert.deepEqual(selectPages([{ id: 'a' }, { id: 'b' }], 1).map(page => page.id), ['a']);
  assert.equal(selectPages(pages, null).length, 5);
});

test('staged Gemini input excludes caches, cultures, and diagram layouts', () => {
  assert.equal(stagedInputAllowed('X.SemanticModel/definition/cultures/en-US.tmdl'), false);
  assert.equal(stagedInputAllowed('X.Report/.pbi/localSettings.json'), false);
  assert.equal(stagedInputAllowed('X.SemanticModel/diagramLayout.json'), false);
  assert.equal(stagedInputAllowed('X.SemanticModel/definition/tables/Sales.tmdl'), true);
});

test('driverless connectors are detected only in scoped M code', () => {
  const digest = { model: { tables: [{ name: 'A', partitions: [{ type: 'm', source: 'let S = Sql.Database("srv", "db") in S' }] }, { name: 'B', partitions: [{ type: 'm', source: '// Sql.Database("old")\nlet S = Csv.Document(File.Contents("c:\\\\a.csv")) in S' }] }], expressions: [] } };
  assert.deepEqual(scopedConnectors(digest), [{ connector: 'Sql.Database', usedBy: ['table A'] }]);
});

// ---------- Gemini process handling ----------

function fakeScript(dir, body) {
  const file = path.join(dir, 'fake.mjs');
  fs.writeFileSync(file, body);
  return file;
}

test('streaming runner stops at an interactive sign-in prompt immediately', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const entry = fakeScript(dir, "process.stderr.write('Warning: 256-color support not detected.\\n'); process.stdout.write('Opening authentication page in your browser. Do you want to continue? [Y/n]: '); setInterval(() => {}, 1000);");
    const started = Date.now();
    const result = await runGeminiStream([], { cwd: dir, env: { HC_GEMINI_ENTRY: entry }, cli: { command: process.execPath, prefix: [entry] }, timeoutMs: 60_000 });
    assert.ok(Date.now() - started < 10_000);
    assert.match(result.interactivePrompt, /Do you want to continue/);
    assert.equal(diagnoseGeminiFailure(result).kind, 'sign-in');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('streaming runner stops a silent process and its child processes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const marker = path.join(dir, 'grandchild.pid');
    const entry = fakeScript(dir, `import { spawn } from 'node:child_process'; import fs from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(marker)}, String(child.pid));
process.stdout.write(JSON.stringify({ type: 'init', model: 'm' }) + '\\n');
setInterval(() => {}, 1000);`);
    const events = [];
    const result = await runGeminiStream([], { cwd: dir, cli: { command: process.execPath, prefix: [entry] }, timeoutMs: 60_000, idleTimeoutMs: 1500, onEvent: event => events.push(event.type), eventsFile: path.join(dir, 'events.jsonl') });
    assert.equal(result.stalled, true);
    assert.deepEqual(events, ['init']);
    assert.match(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8'), /"init"/);
    const grandchild = Number(fs.readFileSync(marker, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 300));
    let alive = true;
    try { process.kill(grandchild, 0); } catch { alive = false; }
    // A killed orphan can linger as an unreaped zombie in containers whose init does not reap.
    try { if (alive && fs.readFileSync(`/proc/${grandchild}/stat`, 'utf8').split(' ')[2] === 'Z') alive = false; } catch { /* not Linux */ }
    if (alive) process.kill(grandchild, 'SIGKILL');
    assert.equal(alive, false, 'relaunched Gemini child process must be killed with the parent');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('older Gemini CLI flag rejections are recognised', () => {
  assert.equal(unsupportedFlag({ stderrTail: 'Invalid values:\n  Argument: output-format, Given: "stream-json", Choices: "text", "json"' }), '--output-format');
  assert.equal(unsupportedFlag({ stderrTail: 'Unknown arguments: skip-trust, skipTrust' }), '--skip-trust');
  assert.equal(unsupportedFlag({ stderrTail: 'Warning: 256-color support not detected.' }), null);
  assert.equal(toolTarget({ file_path: '/tmp/html-converter-gemini-AbC123/work/x.json', content: 'abc' }), ' work/x.json (3 B)');
});

test('an npm gemini.cmd shim resolves to its JavaScript entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const entry = path.join(dir, 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '');
    fs.writeFileSync(path.join(dir, 'gemini.cmd'), '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js" %*\r\n');
    assert.equal(shimTarget(path.join(dir, 'gemini.cmd')), entry);
    assert.equal(shimTarget(path.join(dir, 'missing.cmd')), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failure diagnosis gives an actionable hint for each common cause', () => {
  assert.equal(diagnoseGeminiFailure({ status: 41, stderrTail: 'Please set an Auth method in your settings.json' }).kind, 'auth');
  assert.equal(diagnoseGeminiFailure({ status: 1, stderrTail: 'models/gemini-3.8-flash is not found for API version v1beta' }).kind, 'model');
  assert.equal(diagnoseGeminiFailure({ status: 1, stderrTail: 'request to https://generativelanguage.googleapis.com failed, reason: unable to get local issuer certificate UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }).kind, 'network');
  assert.equal(diagnoseGeminiFailure({ status: 1, stderrTail: 'RESOURCE_EXHAUSTED' }).kind, 'quota');
  assert.equal(diagnoseGeminiFailure({ status: null, stalled: true, stderrTail: 'Warning: 256-color support not detected.' }).kind, 'stall');
  assert.equal(diagnoseGeminiFailure({ status: null, error: Object.assign(new Error('spawn gemini ENOENT'), { code: 'ENOENT' }) }).kind, 'missing-cli');
});

test('backend issues are split into code bugs and source access problems', () => {
  assert.equal(classifyBackendIssue('SyntaxError: Unexpected token'), 'code');
  assert.equal(classifyBackendIssue("Cannot find package 'mssql' imported from backend.mjs"), 'code');
  assert.equal(classifyBackendIssue('relation "public.sales" does not exist'), 'code');
  assert.equal(classifyBackendIssue('password authentication failed for user "reader"'), 'environment');
  assert.equal(classifyBackendIssue('connect ECONNREFUSED 10.0.0.5:5432'), 'environment');
  assert.equal(classifyBackendIssue('self-signed certificate in certificate chain'), 'environment');
});

test('review status and coverage validation are tolerant of wording but strict on blocks', () => {
  assert.equal(normalizeReviewStatus('PASS_WITH_WARNINGS'), 'warnings');
  assert.equal(normalizeReviewStatus('Blocked'), 'blocked');
  assert.equal(normalizeReviewStatus('approved'), 'pass');
  const inventory = { pages: [{ id: 'p', visuals: [{ id: 'v', role: 'data' }, { id: 'g', role: 'group' }, { id: 't', role: 'decorative' }] }] };
  const html = "<html><div id='report-status'></div><section data-page-id='p'><div data-visual-id=\"v\"></div><div data-visual-id='t'></div></section><script>fetch('/api/report')</script></html>";
  assert.deepEqual(validateLiveReport(inventory, html, { status: 'warnings' }), []);
  assert.match(validateLiveReport(inventory, html.replace("data-visual-id='t'", ''), { status: 'warnings' }).join(' '), /Missing visual t/);
  assert.match(validateLiveReport(inventory, html, null).join(' '), /missing or not valid JSON/);
});

test('printed JSON artifacts are recovered from prose and code fences', () => {
  assert.deepEqual(responseTextArtifact('Here it is:\n```json\n{"status":"pass"}\n```\nDone.'), { status: 'pass' });
  assert.deepEqual(responseTextArtifact('{"a":1}'), { a: 1 });
  assert.equal(responseTextArtifact('No JSON here.'), null);
});

test('phase limits can be raised from .env or the PowerShell session', () => {
  assert.equal(phaseSettings({}, { pageLimit: 2 }).idleMs, 8 * 60_000);
  assert.equal(phaseSettings({ GEMINI_IDLE_TIMEOUT_MINUTES: '15' }, { pageLimit: 2 }).idleMs, 15 * 60_000);
  assert.equal(phaseSettings({ GEMINI_ATTEMPT_TIMEOUT_MINUTES: 'nonsense' }, { pageLimit: null }).attemptMs, 35 * 60_000);
});

test('console lines are ASCII and secrets are redacted everywhere', () => {
  assert.equal(consoleSafe('Ventes \u00e9t\u00e9 \u2014 Q\u2019s \u2026 \u2713'), "Ventes ete - Q's ... ?");
  addSecret('hunter2-secret');
  assert.equal(redact('password=hunter2-secret'), 'password=[redacted]');
});

// ---------- end to end through the real entry point with a fake Gemini CLI ----------

test('end to end: two-page conversion serves the report and answers visual queries', withSandbox(async sandbox => {
  let checked = null;
  const result = await runConverter(sandbox, {
    args: ['--page-limit', '2', '--port', '0'],
    onLine: (stdout, child) => {
      const match = /REPORT READY: (\S+)/.exec(stdout);
      if (!match || checked) return;
      checked = (async () => {
        const page = await fetch(match[1]);
        const html = await page.text();
        const api = await fetch(`${match[1]}api/report?visual=c0ffee00000000000002&filters=%7B%7D`);
        const unknown = await fetch(`${match[1]}api/report?visual=nope`);
        const foreign = await fetch(`${match[1]}api/report?visual=c0ffee00000000000002`, { headers: { Origin: 'http://evil.example' } });
        child.kill();
        return { html, api: { status: api.status, body: await api.json() }, unknown: unknown.status, foreign: foreign.status };
      })();
    }
  });
  const served = await checked;
  assert.ok(served, `server never became ready:\n${result.stdout}`);
  assert.match(served.html, /data-page-id="a1b2c3d4e5f6a7b8c9d0"/);
  assert.equal(served.api.status, 200);
  assert.ok(served.api.body.rows.length > 0);
  assert.equal(served.unknown, 400);
  assert.equal(served.foreign, 403);
  assert.deepEqual(result.calls, ['01', '02', '03']);
  assert.equal(result.stderr, '', 'nothing may be written to stderr (Windows PowerShell treats it as fatal)');
  assert.match(result.stdout, /Skipped hidden page\(s\).*Sales tooltip/);
  assert.match(result.stdout, /\[01-interpret\] read_file work\/report-digest\.json/);
  const digest = JSON.parse(fs.readFileSync(path.join(sandbox.dir, 'work/scopes/first-2-pages/report-digest.json'), 'utf8'));
  assert.deepEqual(digest.pages.map(page => page.name), ['Overview', 'Details']);
  const allMeasures = digest.model.tables.flatMap(table => table.measures.map(measure => measure.name));
  assert.ok(!allMeasures.includes('Order Count'), 'measure only used on the skipped hidden page is out of scope');
  assert.ok(!allMeasures.includes('Unused Measure'));
  const logFile = fs.readFileSync(path.join(sandbox.dir, 'logs', 'latest-converter-log.txt'), 'utf8').trim();
  assert.match(fs.readFileSync(logFile, 'utf8'), /REPORT READY/);
}));

test('end to end: a rerun reuses completed phases and --fresh starts over', withSandbox(async sandbox => {
  assert.equal((await runConverter(sandbox)).code, 0);
  const again = await runConverter(sandbox);
  assert.equal(again.code, 0, again.stdout);
  assert.deepEqual(again.calls, ['01', '02', '03'], 'no new Gemini calls on an unchanged rerun');
  assert.match(again.stdout, /Reusing the completed result/);
  const fresh = await runConverter(sandbox, { args: ['--page-limit', '2', '--no-serve', '--fresh'] });
  assert.equal(fresh.code, 0);
  assert.deepEqual(fresh.calls, ['01', '02', '03', '01', '02', '03']);
}));

const recoveries = [
  ['broken generated backend is fixed automatically', 'broken-backend', ['01', '02', '06', '03'], /Asking Gemini to fix 1 issue/],
  ['missing visual markup is repaired, then re-reviewed', 'missing-visual', ['01', '02', '03', '04', '05'], /Repairing 1 visual/],
  ['a blocked review triggers a fix and a final review', 'review-blocked', ['01', '02', '03', '06', '05'], /marked the report blocked/],
  ['a phase that forgets its file is retried', 'omit-01', ['01', '01', '02', '03'], /finished without writing work\/live-interpretation\.json/],
  ['an older CLI without stream-json or --skip-trust still works', 'old-cli', ['01', '02', '03'], /does not support --output-format/],
  ['a rate limit waits and retries', 'quota-02', ['01', '02', '02', '03'], /rate limit\/capacity error\. Waiting/],
  ['a stalled attempt is stopped and retried', 'stall-01', ['01', '01', '02', '03'], /stopped as stalled/],
  ['files written before a hang are accepted', 'hang-after-write-01', ['01', '02', '03'], /every required file was written\. Using them/]
];
for (const [name, scenario, calls, message] of recoveries) {
  test(`end to end: ${name}`, withSandbox(async sandbox => {
    const result = await runConverter(sandbox, { scenario, env: { GEMINI_IDLE_TIMEOUT_MINUTES: '0.04' } });
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(result.calls, calls);
    assert.match(result.stdout, message);
    assert.equal(result.stderr, '');
  }));
}

test('end to end: an expired Gemini sign-in stops at once with instructions', withSandbox(async sandbox => {
  const started = Date.now();
  const result = await runConverter(sandbox, { scenario: 'sign-in-prompt' });
  assert.equal(result.code, 1);
  assert.ok(Date.now() - started < 30_000);
  assert.match(result.stdout, /CONVERSION STOPPED at 01-interpret/);
  assert.match(result.stdout, /What to do: .*run: gemini/);
  assert.equal(result.stderr, '');
}));

test('end to end: unreachable data stops before review, and the rerun resumes at the check', withSandbox(async sandbox => {
  const first = await runConverter(sandbox, { scenario: 'environment-issue' });
  assert.equal(first.code, 1);
  assert.match(first.stdout, /cannot reach the report's data: PG_PASSWORD is empty/);
  assert.deepEqual(first.calls, ['01', '02']);
  const second = await runConverter(sandbox, { scenario: 'environment-issue' });
  assert.equal(second.code, 1);
  assert.deepEqual(second.calls, ['01', '02'], 'no Gemini phase is spent while the data source is unreachable');
  assert.match(second.stdout, /Checking the generated backend \(saved build\)/);
}));

test('end to end: missing CSV source fails in preflight before Gemini runs', withSandbox(async sandbox => {
  fs.rmSync(path.join(sandbox.sourceData, 'sales.csv'));
  const result = await runConverter(sandbox);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /CONVERSION STOPPED at preflight: The selected pages read file\(s\) this PC cannot open: .*sales\.csv/);
  assert.deepEqual(result.calls, []);
}));

test('end to end: a missing Gemini CLI is reported with the install command', withSandbox(async sandbox => {
  const result = await runConverter(sandbox, { env: { HC_GEMINI_ENTRY: path.join(sandbox.dir, 'missing', 'gemini.js') } });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Gemini CLI was not found[\s\S]*npm install -g @google\/gemini-cli/);
}));

test('end to end: the report server moves to the next port when 8765-style ports are taken', withSandbox(async sandbox => {
  const blocker = (await import('node:http')).createServer(() => {});
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const busy = blocker.address().port;
  let url = null;
  const result = await runConverter(sandbox, {
    args: ['--page-limit', '2', '--port', String(busy)],
    onLine: (stdout, child) => { const match = /REPORT READY: (\S+)/.exec(stdout); if (match && !url) { url = match[1]; child.kill(); } }
  });
  blocker.close();
  assert.ok(url, result.stdout);
  assert.notEqual(new URL(url).port, String(busy));
  assert.match(result.stdout, new RegExp(`Port ${busy} is in use`));
}));

test('staged workspace never contains .env, data exports, caches, or cultures', withSandbox(async sandbox => {
  fs.mkdirSync(path.join(sandbox.input, 'data'), { recursive: true });
  fs.writeFileSync(path.join(sandbox.input, 'data', 'export.csv'), 'a\n1\n');
  fs.writeFileSync(path.join(sandbox.dir, '.env'), fs.readFileSync(path.join(sandbox.dir, '.env'), 'utf8') + 'PG_PASSWORD=never-share-this\n');
  const result = await runConverter(sandbox, { scenario: 'list-stage' });
  assert.equal(result.code, 0, result.stdout);
  const state = JSON.parse(fs.readFileSync(path.join(sandbox.dir, 'fake-state.json'), 'utf8'));
  const { cwd: stage, files } = state.calls[0];
  assert.ok(files.includes('work/report-digest.json') && files.includes('GEMINI.md'));
  assert.ok(files.some(file => file.endsWith('tables/Sales.tmdl')));
  for (const file of files) assert.doesNotMatch(file, /(^|\/)(\.env|data\/|\.pbi\/|cultures\/|diagramLayout\.json)/, `${file} must not be staged`);
  const stagedText = files.filter(file => !file.startsWith('prompts/') && !file.startsWith('skills/')).map(file => state.calls[0].contents?.[file] ?? '').join('');
  assert.doesNotMatch(stagedText, /never-share-this/);
  assert.equal(fs.existsSync(stage), false, 'temporary workspace is removed after the run');
  const log = fs.readFileSync(fs.readFileSync(path.join(sandbox.dir, 'logs', 'latest-converter-log.txt'), 'utf8').trim(), 'utf8');
  assert.match(log, /Temporary Gemini workspace/);
}));

function runSelftest(extraArgs, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(geminiDir, 'scripts', 'selftest.mjs'), ...extraArgs], { cwd: geminiDir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('close', code => resolve({ code, output }));
  });
}

test('self-test passes with the built-in fake CLI', async () => {
  const result = await runSelftest(['--fake-cli']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /PASSED/);
});

// Set HC_TEST_GEMINI_BUNDLE to an installed @google/gemini-cli bundle/gemini.js to run the REAL CLI offline.
test('self-test passes with the real Gemini CLI against the mock API', { skip: !process.env.HC_TEST_GEMINI_BUNDLE }, async () => {
  const result = await runSelftest(['--scenario', 'api-429-02,broken-backend'], { HC_GEMINI_ENTRY: process.env.HC_TEST_GEMINI_BUNDLE });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Gemini CLI is retrying on its own/);
  assert.match(result.output, /Asking Gemini to fix 1 issue/);
  assert.match(result.output, /PASSED/);
});

test('Windows-only: PowerShell setup scripts parse', { skip: !hasPwsh() }, () => {
  for (const file of ['setup.ps1', 'live-setup.ps1', 'tests/setup.test.ps1']) {
    const output = execFileSync('pwsh', ['-NoProfile', '-Command', `$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('${path.join(geminiDir, file)}',[ref]$t,[ref]$e)|Out-Null;$e.Count`], { encoding: 'utf8' }).trim();
    assert.equal(output, '0', `${file} has PowerShell syntax errors`);
  }
});

function hasPwsh() {
  try { execFileSync('pwsh', ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }); return true; } catch { return false; }
}

