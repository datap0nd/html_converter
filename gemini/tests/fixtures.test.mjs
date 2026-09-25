// Regression tests over generic PBIP fixtures modelled on what Power BI Desktop
// saves (tests/fixtures/*, expected results in tests/fixtures/_expected).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createSandbox, fixturesDir, geminiDir } from './support/fixtures.mjs';
import { parseTmdl } from '../scripts/tmdl.mjs';
import { resolveMText, callArguments, stripMComments, mUnescape, readCsvFile, scanModelSources } from '../scripts/core.mjs';

const expected = name => JSON.parse(fs.readFileSync(path.join(fixturesDir, '_expected', `${name}.json`), 'utf8'));
const fakeCli = path.join(geminiDir, 'tests', 'support', 'fake-gemini-cli.mjs');

async function inSandbox(fixture, fn, env) {
  const sandbox = createSandbox({ fixture, env });
  try {
    const core = await import(pathToFileURL(path.join(sandbox.dir, 'scripts', 'core.mjs')).href);
    return await fn({ sandbox, core });
  } finally { sandbox.cleanup(); }
}

function preflight(sandbox, extraEnv = {}) {
  const result = spawnSync(process.execPath, [path.join(sandbox.dir, 'scripts', 'start-live-report.mjs'), '--preflight', '--page-limit', '2'], { cwd: sandbox.dir, encoding: 'utf8', env: { ...process.env, HC_GEMINI_ENTRY: fakeCli, ...extraEnv } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function comparePages(actual, wanted) {
  assert.deepEqual(actual.map(page => page.id), wanted.map(page => page.id), 'page order');
  for (const page of wanted) {
    const found = actual.find(item => item.id === page.id);
    assert.equal(found.name, page.name, `name of ${page.id}`);
    assert.equal(Boolean(found.hidden), Boolean(page.hidden), `hidden flag of ${page.id}`);
    const byId = new Map(found.visuals.map(visual => [visual.id, visual]));
    assert.deepEqual([...byId.keys()].sort(), page.visuals.map(visual => visual.id).sort(), `visuals of ${page.id}`);
    for (const visual of page.visuals) {
      const got = byId.get(visual.id);
      assert.equal(got.type, visual.type, `type of ${visual.id}`);
      assert.equal(got.role, visual.role, `role of ${visual.id} (${visual.type})`);
      assert.equal(got.title, visual.title, `title of ${visual.id}`);
    }
  }
}

for (const fixture of ['SalesCsvFull', 'SalesPostgres', 'EdgeCases']) {
  test(`${fixture}: pages, visual roles, and titles match what Desktop saved`, () => inSandbox(fixture, ({ core }) => {
    comparePages(core.discover().pages, expected(fixture).pages);
  }));
}

test('SalesPostgres: navigation tables and both native queries are found with their parameters', () => inSandbox('SalesPostgres', ({ core }) => {
  const [source] = core.discover().postgresSources;
  const wanted = expected('SalesPostgres').postgresSources[0];
  assert.equal(source.server, wanted.server);
  assert.equal(source.database, wanted.database);
  assert.deepEqual(source.tables, wanted.tables);
  assert.deepEqual(source.nativeQueries.map(query => ({ sql: query.sql, parameters: query.parameters })), wanted.nativeQueries);
  assert.equal(source.hasUnresolvedNativeQuery, false);
}));

test('SalesPostgres: missing credentials stop the run before Gemini with the .env fix', () => inSandbox('SalesPostgres', ({ sandbox }) => {
  const result = preflight(sandbox);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /CONVERSION STOPPED at preflight: The report reads PostgreSQL pg-host:5432\/analytics, but PG_USER\/PG_PASSWORD are empty/);
  assert.equal(result.stderr, '');
}));

test('SalesPostgres: an unreachable database is reported with a network hint', () => inSandbox('SalesPostgres', ({ sandbox }) => {
  const result = preflight(sandbox, { PG_HOST: '127.0.0.1', PG_PORT: '1', PG_USER: 'reader', PG_PASSWORD: 'secret-value', PG_SSL_MODE: 'disable' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Cannot connect to PostgreSQL/);
  assert.match(result.stdout, /Nothing is listening at that host\/port|did not answer in time/);
  assert.doesNotMatch(result.stdout, /secret-value/);
}, { PG_HOST: '127.0.0.1', PG_PORT: '1', PG_USER: 'reader', PG_PASSWORD: 'secret-value', PG_SSL_MODE: 'disable' }));

test('EdgeCases: parameterised sources resolve through literal M parameters', () => inSandbox('EdgeCases', ({ core, sandbox }) => {
  const inventory = core.discover();
  assert.deepEqual(inventory.postgresSources.map(source => [source.server, source.database, source.tables]), [['pg-host:5432', 'analytics', [{ schema: 'ref', item: 'customer_region' }]]]);
  const files = Object.fromEntries(inventory.fileSources.map(source => [path.basename(source.path), source]));
  assert.equal(files['returns.txt'].path, path.join(sandbox.sourceData, 'returns.txt'), 'DataFolder & "returns.txt" is resolved');
  assert.deepEqual(files['returns.txt'].csvOptions, { delimiter: '\t', encoding: 65001 });
  assert.deepEqual(files['stores_eu.csv'].csvOptions, { delimiter: ';', encoding: 1252 });
  assert.equal(files['targets.xlsx'].reader, 'Excel.Workbook');
  assert.deepEqual(inventory.unsupportedConnectors.map(item => item.connector).sort(), ['Excel.Workbook', 'Sql.Database', 'Web.Contents']);
  assert.deepEqual(inventory.problems, []);
}));

test('EdgeCases: the digest keeps calculation groups, report-level and formatting-only measures', () => inSandbox('EdgeCases', ({ sandbox }) => {
  preflight(sandbox);
  const digest = JSON.parse(fs.readFileSync(path.join(sandbox.dir, 'work', 'scopes', 'first-2-pages', 'report-digest.json'), 'utf8'));
  const tables = Object.fromEntries(digest.model.tables.map(table => [table.name, table]));
  assert.deepEqual(tables['Time Intelligence'].calculationGroup.items.map(item => item.name), ['Current', 'YTD', 'Prior Year']);
  assert.match(tables['Time Intelligence'].calculationGroup.items[1].expression, /DATESYTD/);
  assert.ok(tables['Fact Sales'].measures.some(measure => measure.name === 'Sales Label (report)' && measure.reportLevel), 'report-level measure from reportExtensions.json');
  assert.deepEqual(tables._Measures.measures.map(measure => measure.name).sort(), ['Button Text', 'Title Text'], 'measures bound to a title and button text');
  assert.ok(tables['LocalDateTable_5cb33fe7-583b-4a68-924e-fc66e315fc0e'].hidden);
  assert.deepEqual(digest.pages.map(page => page.name), ['Q&A <Ventes> "été"', 'Ünïcödé & "quotes" \'single\''], 'empty and hidden pages are not picked for the two-page test');
}));

test('EdgeCases: pages that need SQL Server or Excel stop in preflight instead of after Gemini', () => inSandbox('EdgeCases', ({ sandbox }) => {
  const result = preflight(sandbox);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /no driver for: Sql\.Database \(table Fact Sales\); Excel\.Workbook \(table Targets\)/);
}));

test('ThinReport and LegacyReport stop with the documented reason', async () => {
  for (const fixture of ['ThinReport', 'LegacyReport']) {
    await inSandbox(fixture, ({ sandbox }) => {
      const result = preflight(sandbox);
      assert.equal(result.code, 1, fixture);
      assert.match(result.stdout, new RegExp(expected(fixture).expectedPreflightError));
      assert.match(result.stdout, /What to do:/);
    });
  }
});

test('a report copied without its semantic model folder stops at once', () => inSandbox('SalesCsvFull', ({ sandbox }) => {
  fs.rmSync(path.join(sandbox.input, 'SalesCsv.SemanticModel'), { recursive: true });
  const result = preflight(sandbox);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /semantic model folder that is not in gemini\/input/);
}));

test('a corrupt page.json is reported instead of silently renamed', () => inSandbox('SalesCsvFull', ({ core, sandbox }) => {
  const page = path.join(sandbox.input, 'SalesCsv.Report', 'definition', 'pages', '8f24fddaf545ef5e59c5', 'page.json');
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').slice(0, 40));
  assert.match(core.discover().problems.join(' '), /8f24fddaf545ef5e59c5\/page\.json is not valid JSON/);
}));

test('without pages.json, pages are ordered by display name', () => inSandbox('SalesCsvFull', ({ core, sandbox }) => {
  fs.rmSync(path.join(sandbox.input, 'SalesCsv.Report', 'definition', 'pages', 'pages.json'));
  assert.deepEqual(core.discover().pages.map(page => page.name), ['Category Tooltip', 'Product Detail', 'Sales Overview']);
}));

test('two PostgreSQL connections in one file keep their own tables, and options records are accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const file = path.join(dir, 'expressions.tmdl');
    fs.writeFileSync(file, [
      'expression A =',
      '\t\tlet S = PostgreSQL.Database("pg-a", "sales"), T = S{[Schema="public",Item="orders"]}[Data] in T',
      '',
      'expression B =',
      '\t\tlet S = PostgreSQL.Database("pg-b", "hr", [CommandTimeout=#duration(0,0,5,0)]), T = S{[Schema="hr",Item="employees"]}[Data] in T',
      '',
      'expression C =',
      '\t\tValue.NativeQuery(PostgreSQL.Database("pg-b", "hr", [CommandTimeout=#duration(0,0,5,0)]), "select 1 as x", null, [EnableFolding=true])',
      ''
    ].join('\n'));
    const { postgresSources } = scanModelSources([file]);
    const byServer = Object.fromEntries(postgresSources.map(source => [source.server, source]));
    assert.deepEqual(byServer['pg-a'].tables, [{ schema: 'public', item: 'orders' }]);
    assert.deepEqual(byServer['pg-b'].tables, [{ schema: 'hr', item: 'employees' }]);
    assert.deepEqual(byServer['pg-b'].nativeQueries.map(query => query.sql), ['select 1 as x']);
    assert.equal(byServer['pg-b'].hasUnresolvedNativeQuery, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('M text helpers resolve parameters, escapes, comments, and nested arguments', () => {
  const parameters = new Map([['Folder', 'C:\\data\\'], ['Server', 'pg:5432']]);
  assert.equal(resolveMText('Folder & "returns.txt"', parameters), 'C:\\data\\returns.txt');
  assert.equal(resolveMText('#"Server"', parameters), 'pg:5432');
  assert.equal(resolveMText('Text.Combine({Folder, "x"})', parameters), null);
  assert.equal(mUnescape('a#(lf)b#(tab)c""d#(#)(e'), 'a\nb\tc"d#(e');
  assert.equal(stripMComments('Web.Contents("https://x/y") // note\n/* block */ 1'), 'Web.Contents("https://x/y") \n  1');
  const text = 'F(Csv.Document(File.Contents("a,b"), [Delimiter=";"]), {1, 2})';
  assert.deepEqual(callArguments(text, 1).args, ['Csv.Document(File.Contents("a,b"), [Delimiter=";"])', '{1, 2}']);
});

test('readCsvFile honours Csv.Document delimiter and Windows code page', () => {
  const stores = readCsvFile(path.join(fixturesDir, 'data', 'stores_eu.csv'), { delimiter: ';', encoding: 1252 });
  assert.deepEqual(stores.columns.slice(0, 2), ['Store', 'City']);
  assert.ok(stores.rows.some(row => /é/.test(Object.values(row).join(' '))), 'Windows-1252 accents decode correctly');
  const returns = readCsvFile(path.join(fixturesDir, 'data', 'returns.txt'), { delimiter: '\t' });
  assert.ok(returns.columns.length > 1);
});

test('TMDL parser: calculation groups, bare flags, and nameless format string definitions', () => {
  const nodes = parseTmdl("table T\n\tisHidden\n\tcalculationGroup\n\t\tprecedence: 2\n\n\t\tcalculationItem YTD =\n\t\t\t\t\tCALCULATE(SELECTEDMEASURE())\n\t\t\tordinal: 1\n\n\tmeasure M = 1\n\t\tformatStringDefinition = IF(1, \"0\", \"0.0\")\n");
  const table = nodes[0];
  assert.equal(table.props.isHidden, 'true');
  const group = table.children.find(child => child.kind === 'calculationGroup');
  assert.equal(group.props.precedence, '2');
  assert.equal(group.children[0].name, 'YTD');
  assert.equal(group.children[0].value, 'CALCULATE(SELECTEDMEASURE())');
  assert.equal(group.children[0].props.ordinal, '1');
  const measure = table.children.find(child => child.kind === 'measure');
  assert.equal(measure.children[0].kind, 'formatStringDefinition');
  assert.equal(measure.children[0].value, 'IF(1, "0", "0.0")');
});
