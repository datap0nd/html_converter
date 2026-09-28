// PBIP scanner details: M name resolution, Enter Data, file/folder/web sources,
// encodings, the digest file format, and project folder resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { scanModelSources, decodeEnterData, readCsvFile, checkSourceAvailability } from '../scripts/core.mjs';
import { serializeDigest, digestText, scopeModel, DIGEST_LIMITS } from '../scripts/digest.mjs';
import { parseQualifiedColumn } from '../scripts/tmdl.mjs';
import { describeField, pageType, visualTitleShow } from '../scripts/pbir.mjs';

function withFiles(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-scan-'));
  try {
    const paths = Object.entries(files).map(([name, text]) => {
      const file = path.join(dir, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    });
    return fn(paths, dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('PostgreSQL connections are found through shared queries, let steps and parameters', () => withFiles({
  'expressions.tmdl': [
    'expression Server = "pg-host:5432" meta [IsParameterQuery=true, Type="Text", IsParameterQueryRequired=true]',
    '',
    'expression Warehouse =',
    '\t\tlet',
    '\t\t    Source = PostgreSQL.Database(Server, "analytics")',
    '\t\tin',
    '\t\t    Source',
    ''
  ].join('\n'),
  'tables/Orders.tmdl': [
    'table Orders',
    '\tpartition Orders = m',
    '\t\tmode: import',
    '\t\tsource =',
    '\t\t\t\tlet',
    '\t\t\t\t    Db = Warehouse,',
    '\t\t\t\t    Sql = "select * from sales.orders where status <> ""x""",',
    '\t\t\t\t    Result = Value.NativeQuery(Db, Sql, null, [EnableFolding=true])',
    '\t\t\t\tin',
    '\t\t\t\t    Result',
    ''
  ].join('\n'),
  'tables/Regions.tmdl': [
    'table Regions',
    '\tpartition Regions = m',
    '\t\tmode: import',
    '\t\tsource =',
    '\t\t\t\tlet',
    '\t\t\t\t    Source = Warehouse,',
    '\t\t\t\t    Nav = Source{[Schema="ref",Item="regions"]}[Data]',
    '\t\t\t\tin',
    '\t\t\t\t    Nav',
    ''
  ].join('\n'),
  'tables/Computed.tmdl': [
    'table Computed',
    '\tpartition Computed = m',
    '\t\tmode: import',
    '\t\tsource = Value.NativeQuery(Warehouse, Text.Combine({"select ", "1"}), null)',
    ''
  ].join('\n')
}, files => {
  const scan = scanModelSources(files, { checkFiles: false });
  assert.equal(scan.postgresSources.length, 1);
  const pg = scan.postgresSources[0];
  assert.equal(pg.server, 'pg-host:5432');
  assert.equal(pg.database, 'analytics');
  assert.equal(pg.parameterised, true);
  assert.deepEqual(pg.tables, [{ schema: 'ref', item: 'regions' }]);
  assert.deepEqual(pg.nativeQueries.map(item => item.sql), ['select * from sales.orders where status <> "x"']);
  assert.equal(pg.unresolvedNativeQueries, 1, 'computed SQL is counted, never dropped');
  assert.equal(pg.hasUnresolvedNativeQuery, true);
  assert.deepEqual(pg.queries.sort(), ['Computed', 'Orders', 'Regions', 'Warehouse']);
}));

test('File.Contents readers, Folder.Files and Web.Contents are recorded with their options', () => withFiles({
  'model.tmdl': [
    'expression Root = "C:\\Data\\" meta [IsParameterQuery=true, Type="Text"]',
    '',
    'table Stores',
    '\tpartition Stores = m',
    '\t\tmode: import',
    '\t\tsource =',
    '\t\t\t\tlet',
    '\t\t\t\t    Bin = Binary.Buffer(File.Contents(Root & "stores.csv")),',
    '\t\t\t\t    Csv = Csv.Document(Bin, 5, ";", ExtraValues.Ignore, 850)',
    '\t\t\t\tin',
    '\t\t\t\t    Csv',
    '',
    'table Monthly',
    '\tpartition Monthly = m',
    '\t\tmode: import',
    '\t\tsource = Folder.Files("\\\\server\\share\\monthly")',
    '',
    'table Rates',
    '\tpartition Rates = m',
    '\t\tmode: import',
    '\t\tsource = Json.Document(Web.Contents("https://api.example.com", [RelativePath="v1/rates"]))',
    ''
  ].join('\n')
}, files => {
  const scan = scanModelSources(files, { checkFiles: false });
  const byKind = Object.groupBy(scan.fileSources, source => source.kind);
  assert.equal(byKind.file[0].path, 'C:\\Data\\stores.csv');
  assert.equal(byKind.file[0].reader, 'Csv.Document', 'the reader is found through Binary.Buffer and a step');
  assert.deepEqual(byKind.file[0].csvOptions, { delimiter: ';', encoding: 850 }, 'positional Csv.Document arguments');
  assert.equal(byKind.file[0].available, null, 'not checked when checkFiles is false');
  assert.equal(byKind.folder[0].path, '\\\\server\\share\\monthly');
  assert.equal(byKind.folder[0].reader, 'Folder.Files');
  assert.deepEqual(scan.webSources.map(item => [item.url, item.relativePath, item.host]), [['https://api.example.com', 'v1/rates', 'api.example.com']]);
}));

test('Enter Data tables decode from their compressed base64 rows', () => {
  const rows = [['North', '10'], ['South', '20']];
  const base64 = zlib.deflateRawSync(Buffer.from(JSON.stringify(rows))).toString('base64');
  const m = `let
    Source = Table.FromRows(Json.Document(Binary.Decompress(Binary.FromText("${base64}", BinaryEncoding.Base64), Compression.Deflate)), let _t = ((type nullable text) meta [Serialized.Text = true]) in type table [Region = _t, #"Target Value" = _t]),
    Typed = Table.TransformColumnTypes(Source,{{"Target Value", Int64.Type}})
in
    Typed`;
  assert.deepEqual(decodeEnterData(m), { columns: ['Region', 'Target Value'], rows });
  assert.equal(decodeEnterData('let x = 1 in x'), null);
});

test('CSV files decode with the OEM and Windows code pages Power Query uses', () => withFiles({}, (_files, dir) => {
  const file = path.join(dir, 'oem.csv');
  fs.writeFileSync(file, Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x4d, 0x81, 0x6c, 0x6c, 0x65, 0x72, 0x0a]));
  assert.deepEqual(readCsvFile(file, { encoding: 850 }).rows, [{ Name: 'Müller' }]);
  fs.writeFileSync(file, Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x4d, 0xfc, 0x6c, 0x6c, 0x65, 0x72, 0x0a]));
  assert.deepEqual(readCsvFile(file, { encoding: 1252 }).rows, [{ Name: 'Müller' }]);
}));

test('source availability is checked asynchronously with a clear error', async () => {
  const inventory = { fileSources: [{ path: path.join(os.tmpdir(), 'hc-definitely-missing.csv'), kind: 'file', absolute: true, available: null }], postgresSources: [], pages: [{}] };
  const progress = [];
  await checkSourceAvailability(inventory, { timeoutMs: 2000, onProgress: item => progress.push(item) });
  assert.equal(inventory.fileSources[0].available, false);
  assert.equal(inventory.fileSources[0].error, 'ENOENT');
  assert.equal(inventory.directCsvSources.length, 1);
  assert.ok(inventory.warnings.some(warning => /CSV source not readable/.test(warning)));
  assert.equal(progress.length, 1);
});

test('the digest file keeps every line short and round-trips long text', () => {
  const longSql = `select ${Array.from({ length: 400 }, (_, index) => `column_${index}`).join(', ')} from t`;
  const digest = { pages: [{ id: 'p', name: 'Page' }], model: { tables: [{ name: 'T', partitions: [{ source: `let\n    Source = "${longSql}"\nin\n    Source` }] }] }, sources: { files: [] } };
  const text = serializeDigest(digest);
  assert.ok(text.split('\n').every(line => line.length <= DIGEST_LIMITS.maxLine), 'no line longer than the limit');
  const parsed = JSON.parse(text);
  assert.match(parsed.readingNote, /read_file shows at most 2000 lines/);
  assert.equal(digestText(parsed.model.tables[0].partitions[0].source), digest.model.tables[0].partitions[0].source);
  assert.equal(parsed.pages[0].name, 'Page');
});

test('qualified TMDL column names with quoted parts are split correctly', () => {
  assert.deepEqual(parseQualifiedColumn("Sales.'Order Date'"), { table: 'Sales', column: 'Order Date' });
  assert.deepEqual(parseQualifiedColumn("'Sales Table'.Amount"), { table: 'Sales Table', column: 'Amount' });
  assert.deepEqual(parseQualifiedColumn('Amount'), { table: null, column: 'Amount' });
});

test('PBIR details: nested expression fields, visual calculations, page types and title visibility', () => {
  const field = describeField({ Arithmetic: { Left: { Measure: { Expression: { SourceRef: { Entity: 'Sales' } }, Property: 'Total' } }, Right: { Column: { Expression: { SourceRef: { Entity: 'Date' } }, Property: 'Year' } }, Operator: 0 } });
  assert.equal(field.kind, 'expression');
  assert.equal(field.expressionKind, 'Arithmetic');
  assert.deepEqual(field.fields.map(item => [item.kind, item.table, item.name]), [['measure', 'Sales', 'Total'], ['column', 'Date', 'Year']]);
  assert.deepEqual(describeField({ NativeVisualCalculation: { Name: 'Running', Expression: 'RUNNINGSUM([Total])', Language: 'dax' } }), { kind: 'visualCalculation', name: 'Running', expression: 'RUNNINGSUM([Total])', language: 'dax' });
  assert.equal(pageType({ type: 'Tooltip' }), 'Tooltip');
  assert.equal(pageType({ pageBinding: { type: 'Drillthrough' } }), 'Drillthrough');
  assert.equal(pageType({}), null);
  assert.equal(visualTitleShow({ visual: { visualContainerObjects: { title: [{ properties: { show: { expr: { Literal: { Value: 'false' } } } } }] } } }), false);
});

test('model scoping follows DAX user-defined functions into the tables they read', () => {
  const model = {
    tables: [
      { name: 'Sales', columns: [{ name: 'Amount' }], measures: [{ name: 'Total', expression: 'Lib.SafeSum(Sales[Amount])' }], partitions: [], hierarchies: [] },
      { name: 'Rates', columns: [{ name: 'Rate' }], measures: [], partitions: [], hierarchies: [] },
      { name: 'Unused', columns: [], measures: [], partitions: [], hierarchies: [] }
    ],
    relationships: [], expressions: [],
    functions: [{ name: 'Lib.SafeSum', expression: '(x) => SUMX(Rates, Rates[Rate]) + x' }]
  };
  const scoped = scopeModel(model, [{ kind: 'measure', table: 'Sales', name: 'Total' }]);
  assert.deepEqual(scoped.tables.map(table => table.name).sort(), ['Rates', 'Sales']);
});

async function sandboxCore(prepare) {
  const { createSandbox } = await import('../selftest/sandbox.mjs');
  const { pathToFileURL } = await import('node:url');
  const sandbox = createSandbox();
  try {
    prepare(sandbox.input);
    const core = await import(`${pathToFileURL(path.join(sandbox.dir, 'scripts', 'core.mjs')).href}?t=${Date.now()}`);
    let result, error;
    try { result = core.discover({ checkFiles: false }); } catch (caught) { error = caught; }
    return { result, error };
  } finally { sandbox.cleanup(); }
}

test('a .pbix instead of a PBIP, or a PBIP copied without its .pbip file, gets a precise instruction', async () => {
  const pbix = await sandboxCore(input => {
    fs.rmSync(path.join(input, 'Demo.pbip'));
    for (const name of ['Demo.Report', 'Demo.SemanticModel']) fs.rmSync(path.join(input, name), { recursive: true });
    fs.writeFileSync(path.join(input, 'Sales.pbix'), 'PK');
  });
  assert.match(pbix.error?.message ?? '', /reads PBIP projects, not \.pbix files.*Save as > Power BI project/);
  const folders = await sandboxCore(input => fs.rmSync(path.join(input, 'Demo.pbip')));
  assert.match(folders.error?.message ?? '', /but no \.pbip file/);
});

test('leftover folders from another project are ignored and a renamed model folder is still found', async () => {
  const { result } = await sandboxCore(input => {
    fs.cpSync(path.join(input, 'Demo.Report'), path.join(input, 'Old.Report'), { recursive: true });
    fs.renameSync(path.join(input, 'Demo.SemanticModel'), path.join(input, 'Renamed.SemanticModel'));
  });
  assert.equal(result.reportFolder, 'input/Demo.Report');
  assert.equal(result.semanticModelFolder, 'input/Renamed.SemanticModel');
  assert.ok(result.problems.some(problem => /Ignored input\/Old\.Report: it is not the report or semantic model/.test(problem)), result.problems.join('\n'));
  assert.ok(result.problems.some(problem => /using input\/Renamed\.SemanticModel, the only semantic model folder/.test(problem)), result.problems.join('\n'));
  assert.ok(result.pages.every(page => typeof page.dataVisualCount === 'number'));
});
