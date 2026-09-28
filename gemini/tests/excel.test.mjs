// Excel.Workbook support: the dependency-free .xlsx reader, Excel navigation in the
// scanner, SharePoint/OneDrive files mapped to local copies, and preflight checks.
// Workbooks are made by tests/fixtures/data/make_workbooks.py (openpyxl, plus one
// written the way Excel and the Open XML SDK write it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { readExcel, inspectWorkbook, isDateFormat, excelDateText, columnIndex, columnLetters, parseRange } from '../scripts/excel.mjs';
import { mapSourcePath, parseSourceMap } from '../scripts/core.mjs';
import { createSandbox, fixturesDir, geminiDir } from '../selftest/sandbox.mjs';

const data = path.join(fixturesDir, 'data');
const salesBook = path.join(data, 'sales.xlsx');
const excelStyle = path.join(data, 'excel-style.xlsx');
const fakeCli = path.join(geminiDir, 'selftest', 'fake-gemini-cli.mjs');

function tempFile(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-xlsx-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

// A minimal stored (uncompressed) zip, enough for format-detection tests.
function zipOf(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buffer => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text), nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc(body), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc(body), 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// ---------- reader ----------

test('sheets, tables and named ranges read like Power Query, with dates and header promotion', () => {
  const items = inspectWorkbook(salesBook).items;
  assert.deepEqual(items.map(item => `${item.name}|${item.kind}|${item.hidden}`), ['Sales|Sheet|false', 'Product List|Sheet|false', 'Notes|Sheet|true', 'Targets|Sheet|false', 'Products|Table|false', 'RegionTargets|DefinedName|false']);
  assert.deepEqual(items.find(item => item.name === 'Sales').header.slice(0, 3), ['OrderID', 'OrderDate', 'ProductKey']);

  const sales = readExcel(salesBook, { item: 'Sales', kind: 'Sheet', useHeaders: true });
  assert.equal(sales.rows.length, 48);
  assert.deepEqual(sales.rows[0], { OrderID: 10031, OrderDate: '2023-11-11', ProductKey: 7, Channel: 'Online', Region: 'West', Quantity: 1, UnitPrice: 3.14, Discount: 0.1 });
  const raw = readExcel(salesBook, { item: 'Sales', kind: 'Sheet' });
  assert.deepEqual(raw.columns.slice(0, 2), ['Column1', 'Column2'], 'without useHeaders the header row is data, as in Power Query');
  assert.equal(raw.rows.length, 49);

  const products = readExcel(salesBook, { item: 'Products', kind: 'Table' });
  assert.deepEqual(products.columns, ['ProductKey', 'Product Name', 'Category', 'Subcategory', 'Color', 'StandardCost']);
  assert.equal(products.rows.length, 12, 'the totals row is not data');
  assert.equal(products.rows.at(-1)['Product Name'], 'Café Racer Cap');

  const targets = readExcel(salesBook, { item: 'Targets', useHeaders: true }).rows;
  assert.deepEqual(targets.map(row => row.Updated), ['2024-01-31T17:30:00', '2024-01-31', '08:15:00']);
  assert.equal(targets[2].Target, null, 'a formula without a cached value is blank');
  assert.deepEqual(readExcel(salesBook, { item: 'RegionTargets', kind: 'DefinedName' }).rows.at(-1), { Column1: 'North', Column2: null });
});

test('Excel-style XML: shared rich text, phonetic runs, prefixes, 1904 dates, errors and saved dimensions', () => {
  const info = inspectWorkbook(excelStyle);
  assert.equal(info.date1904, true);
  assert.equal(info.items[0].name, 'Regions & Owners');
  assert.equal(info.items[0].ref, 'B2:E5');
  const result = readExcel(excelStyle, { item: 'Regions & Owners', kind: 'Sheet', useHeaders: true });
  assert.deepEqual(result.columns, ['Region', 'Owner', 'Since', 'Amount']);
  assert.deepEqual(result.rows[0], { Region: 'West Coast', Owner: 'Ann', Since: '2024-01-02', Amount: 1234.5 });
  assert.deepEqual(result.rows[1], { Region: '東京', Owner: true, Since: '2024-02-29', Amount: null });
  assert.equal(result.rows.length, 3, 'only the saved dimensions B2:E5, like Power BI');
  assert.ok(result.warnings.some(warning => /outside its saved dimensions B2:E5/.test(warning)));
  const inferred = readExcel(excelStyle, { item: 'Regions & Owners', useHeaders: true, inferSheetDimensions: true });
  assert.equal(inferred.rows.at(-1).Region, 'A\r\nB <tag>', 'InferSheetDimensions reads every cell; _x000D_ escapes are decoded');
});

test('unreadable workbooks fail with a precise reason and code', () => {
  const ole = tempFile('protected.xlsx', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]));
  assert.throws(() => inspectWorkbook(ole), error => error.code === 'HC_EXCEL_ENCRYPTED' && /old \.xls .* password .*sensitivity label.*HC_SOURCE_MAP_1=/s.test(error.message));
  const csv = tempFile('renamed.xlsx', 'a,b\n1,2\n');
  assert.throws(() => inspectWorkbook(csv), error => error.code === 'HC_EXCEL_FORMAT' && /CSV or HTML file renamed/.test(error.message));
  const xlsb = tempFile('binary.xlsx', zipOf({ 'xl/workbook.bin': 'x', '[Content_Types].xml': '<Types/>' }));
  assert.throws(() => inspectWorkbook(xlsb), error => error.code === 'HC_EXCEL_FORMAT' && /\.xlsb/.test(error.message));
  const truncated = tempFile('cut.xlsx', fs.readFileSync(salesBook).subarray(0, 4000));
  assert.throws(() => inspectWorkbook(truncated), error => error.code === 'HC_EXCEL_FORMAT' && /truncated or still being copied/.test(error.message));
  assert.throws(() => readExcel(salesBook, { item: 'Sheet1', kind: 'Sheet' }), error => error.code === 'HC_EXCEL_ITEM' && /It has: Sales \(Sheet\), Product List \(Sheet\)/.test(error.message));
  assert.throws(() => inspectWorkbook(path.join(data, 'missing.xlsx')), error => error.code === 'ENOENT');
});

test('a stored and a deflated workbook part both decode', () => {
  const sheet = '<worksheet><dimension ref="A1:A2"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row><row r="2"><c r="A2"><v>5</v></c></row></sheetData></worksheet>';
  const file = tempFile('stored.xlsx', zipOf({
    '_rels/.rels': '<Relationships><Relationship Id="r" Type="http://x/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://x/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet
  }));
  assert.deepEqual(readExcel(file, { item: 'S', useHeaders: true }).rows, [{ x: 5 }]);
  assert.deepEqual(readExcel(fs.readFileSync(file), { item: 'S', useHeaders: true }).rows, [{ x: 5 }], 'workbook bytes work like a path');
  assert.ok(zlib.inflateRawSync(zlib.deflateRawSync(Buffer.from(sheet))).equals(Buffer.from(sheet)));
});

test('date formats, serials and cell references', () => {
  for (const [id, code, expected] of [[14, null, true], [0, null, false], [164, 'dd/mm/yyyy', true], [165, '[$-409]mmmm d, yyyy;@', true], [166, '#,##0.00', false], [167, '0.0%', false], [168, '"Q"0', false], [169, '[h]:mm:ss', true], [170, '[Red]0.00;[Blue]-0.00', false], [171, 'yyyy"年"m"月"d"日"', true]]) {
    assert.equal(isDateFormat(id, code), expected, `${id} ${code}`);
  }
  assert.equal(excelDateText(45292), '2024-01-01');
  assert.equal(excelDateText(45292.5), '2024-01-01T12:00:00');
  assert.equal(excelDateText(0.25), '06:00:00');
  assert.equal(excelDateText(0, true), '1904-01-01');
  for (const letters of ['A', 'Z', 'AA', 'AZ', 'XFD']) assert.equal(columnLetters(columnIndex(letters)), letters);
  assert.deepEqual(parseRange('$B$2:$D$10'), { top: 1, left: 1, bottom: 9, right: 3 });
  assert.deepEqual(parseRange('A:C'), { top: 0, left: 0, bottom: Infinity, right: 2 });
});

test('source map lines map files and folders, including URL-encoded SharePoint paths', () => {
  const { entries, problems } = parseSourceMap({
    HC_SOURCE_MAP_1: 'https://contoso.sharepoint.com/sites/Finance/Shared Documents/Plans => C:\\Users\\ann\\Contoso\\Finance - Documents\\Plans',
    HC_SOURCE_MAP_2: '"\\\\oldserver\\share\\Targets.xls" => "C:\\data\\Targets.xlsx"',
    HC_SOURCE_MAP_3: 'no arrow here'
  });
  assert.equal(entries.length, 2);
  assert.match(problems[0], /HC_SOURCE_MAP_3 in gemini\/\.env must look like/);
  assert.equal(mapSourcePath('https://contoso.sharepoint.com/sites/Finance/Shared%20Documents/Plans/2024/Budget.xlsx', entries).to, 'C:\\Users\\ann\\Contoso\\Finance - Documents\\Plans\\2024\\Budget.xlsx');
  assert.equal(mapSourcePath('\\\\OLDSERVER\\share\\targets.xls', entries).to, 'C:\\data\\Targets.xlsx', 'Windows paths compare case-insensitively');
  assert.equal(mapSourcePath('https://contoso.sharepoint.com/sites/Finance/Shared Documents/PlansArchive/x.xlsx', entries), null, 'a prefix matches whole folder names only');
});

// ---------- the SalesExcel fixture through the converter ----------

function withExcelSandbox(prepare, fn) {
  const sandbox = createSandbox({ fixture: 'SalesExcel' });
  try {
    prepare?.(sandbox);
    return fn(sandbox);
  } finally { sandbox.cleanup(); }
}

function converter(sandbox, args, env = {}) {
  const result = spawnSync(process.execPath, [path.join(sandbox.dir, 'scripts', 'start-live-report.mjs'), ...args], { cwd: sandbox.dir, encoding: 'utf8', env: { ...process.env, HC_GEMINI_ENTRY: fakeCli, FAKE_GEMINI_STATE: path.join(sandbox.dir, 'state.json'), GEMINI_API_KEY: 'test-key', ...env } });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const salesTmdl = sandbox => path.join(sandbox.input, 'SalesExcel.SemanticModel', 'definition', 'tables', 'Sales.tmdl');

test('SalesExcel: an Excel report converts end to end and every visual reads the workbook', () => withExcelSandbox(null, sandbox => {
  const result = converter(sandbox, ['--page-limit', '2', '--no-serve']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /Sources: 0 PostgreSQL, 0 direct CSV, 1 Excel workbook\(s\)/);
  assert.match(result.stdout, /6 item\(s\) in \d+ ms: Sales \(Sheet A1:H49\), Product List \(Sheet A1:F15\), Notes \(Sheet A1, hidden\).* The report reads: Products \(Table\), Sales \(Sheet\)\./);
  assert.match(result.stdout, /10 of 10 visual query\(ies\) answered, 0 placeholder/);
  const digest = JSON.parse(fs.readFileSync(path.join(sandbox.dir, 'work', 'scopes', 'first-2-pages', 'report-digest.json'), 'utf8'));
  const workbook = digest.sources.files.find(source => source.reader === 'Excel.Workbook');
  assert.deepEqual(workbook.workbook.items.find(item => item.kind === 'Table').header, ['ProductKey', 'Product Name', 'Category', 'Subcategory', 'Color', 'StandardCost']);
}));

test('SalesExcel: a renamed sheet stops in preflight and lists what the workbook has', () => withExcelSandbox(sandbox => {
  fs.writeFileSync(salesTmdl(sandbox), fs.readFileSync(salesTmdl(sandbox), 'utf8').replace('Item="Sales",Kind="Sheet"', 'Item="Sales 2024",Kind="Sheet"'));
}, sandbox => {
  const result = converter(sandbox, ['--preflight', '--page-limit', '2']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /CONVERSION STOPPED at preflight: The Excel workbook .*sales\.xlsx has no sheet "Sales 2024" \(read by Sales\)\. It has: Sales \(Sheet\), Product List \(Sheet\), Notes \(Sheet\), Targets \(Sheet\), Products \(Table\), RegionTargets \(DefinedName\)/);
  assert.match(result.stdout, /renamed or deleted since the report was built/);
}));

test('SalesExcel: a protected or legacy workbook stops in preflight with the way out', () => withExcelSandbox(sandbox => {
  fs.writeFileSync(path.join(sandbox.sourceData, 'sales.xlsx'), Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(1024)]));
}, sandbox => {
  const result = converter(sandbox, ['--preflight', '--page-limit', '2']);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /which cannot be opened: .*password or an encrypting sensitivity label/);
  assert.match(result.stdout, /What to do: Save an unprotected \.xlsx copy/);
}));

const sharePointSales = text => text.replace(
  /Source = Excel\.Workbook\(File\.Contents\("[^"]*"\), null, true\),\n(\s*)Sales_Sheet = Source\{/,
  (_all, indent) => `Site = SharePoint.Files("https://contoso.sharepoint.com/sites/Finance", [ApiVersion = 15]),\n${indent}File = Site{[Name="sales.xlsx",#"Folder Path"="https://contoso.sharepoint.com/sites/Finance/Shared Documents/Reports/"]}[Content],\n${indent}Source = Excel.Workbook(File, null, true),\n${indent}Sales_Sheet = Source{`
);

test('SalesExcel on SharePoint: stops with the exact HC_SOURCE_MAP line, then converts from the synced copy', () => withExcelSandbox(sandbox => {
  const text = sharePointSales(fs.readFileSync(salesTmdl(sandbox), 'utf8'));
  assert.match(text, /SharePoint\.Files/);
  fs.writeFileSync(salesTmdl(sandbox), text);
}, sandbox => {
  const blocked = converter(sandbox, ['--preflight', '--page-limit', '2']);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stdout, /read a file from SharePoint\/OneDrive or cloud storage, which this converter cannot sign in to: Excel\.Workbook of https:\/\/contoso\.sharepoint\.com\/sites\/Finance\/Shared Documents\/Reports\/sales\.xlsx \(Sales\)/);
  assert.match(blocked.stdout, /HC_SOURCE_MAP_1=https:\/\/contoso\.sharepoint\.com\/sites\/Finance\/Shared Documents\/Reports\/sales\.xlsx => C:\\Users\\<you>\\<synced folder>\\sales\.xlsx/);
  // The library as OneDrive syncs it to this PC.
  const synced = path.join(sandbox.dir, 'OneDrive - Contoso', 'Finance - Documents', 'Reports');
  fs.mkdirSync(synced, { recursive: true });
  fs.copyFileSync(path.join(sandbox.sourceData, 'sales.xlsx'), path.join(synced, 'sales.xlsx'));
  const mapping = { HC_SOURCE_MAP_1: `https://contoso.sharepoint.com/sites/Finance/Shared%20Documents/Reports => ${synced}` };
  const mapped = converter(sandbox, ['--page-limit', '2', '--no-serve'], mapping);
  assert.equal(mapped.code, 0, mapped.stdout);
  assert.match(mapped.stdout, /HC_SOURCE_MAP_1: https:\/\/contoso\.sharepoint\.com\/sites\/Finance\/Shared%20Documents\/Reports is read from .* \(1 source\(s\)\)/);
  assert.match(mapped.stdout, /10 of 10 visual query\(ies\) answered/);
  const digest = JSON.parse(fs.readFileSync(path.join(sandbox.dir, 'work', 'scopes', 'first-2-pages', 'report-digest.json'), 'utf8'));
  const local = digest.sources.files.find(source => source.originalUrl);
  assert.equal(local.originalUrl, 'https://contoso.sharepoint.com/sites/Finance/Shared Documents/Reports/sales.xlsx');
  assert.equal(local.path, path.join(synced, 'sales.xlsx'));
  assert.deepEqual(local.excel.items.map(item => item.item), ['Sales']);
  const unused = converter(sandbox, ['--preflight', '--page-limit', '2'], { ...mapping, HC_SOURCE_MAP_2: 'C:\\nothing\\here.xlsx => C:\\x.xlsx' });
  assert.match(unused.stdout, /HC_SOURCE_MAP_2 in gemini\/\.env matches no file, folder or URL in the PBIP/);
}));
