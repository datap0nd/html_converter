import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { visualTitle, classifyVisual, visualType, pageIsHidden } from './pbir.mjs';
import { tmdlMExpressions, mParameterLiteral } from './tmdl.mjs';

// import.meta.dirname needs Node 20.11+; fileURLToPath works on every Node 20.
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const inputDir = path.join(root, 'input');
export const workDir = path.join(root, 'work');
export const dynamicDir = path.join(root, 'output', 'dynamic');
export const staticDir = path.join(root, 'output', 'static');

export function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  // Sorted so page order and scans never depend on the file system's listing order.
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else if (entry.isFile()) result.push(full);
    // Symlinks are intentionally skipped: nothing outside input should be read.
  }
  return result;
}

export function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

export function readJson(file) {
  // Some Windows tools save UTF-8 with a byte-order mark, which JSON.parse rejects.
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export function scriptJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

export function parseCsv(content, { delimiter = ',' } = {}) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '"') {
      if (quoted && content[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (c === delimiter && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && content[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { columns: [], rows: [] };
  const columns = rows.shift().map((c, i) => c.trim() || `column_${i + 1}`);
  return { columns, rows: rows.map(cells => Object.fromEntries(columns.map((name, i) => [name, cells[i] ?? '']))) };
}

// Windows code pages used by Csv.Document(..., [Encoding=...]).
const CODE_PAGES = { 65001: 'utf-8', 1200: 'utf-16le', 1201: 'utf-16be', 1252: 'windows-1252', 1250: 'windows-1250', 1251: 'windows-1251', 1253: 'windows-1253', 1254: 'windows-1254', 28591: 'iso-8859-1', 28605: 'iso-8859-15', 437: 'ibm866', 850: 'windows-1252', 20127: 'us-ascii' };

export function encodingForCodePage(codePage) {
  return CODE_PAGES[Number(codePage)] ?? 'utf-8';
}

// Reads a delimited text file the way Csv.Document does: delimiter and code
// page from the M options (see csvOptions in the digest), BOM removed.
export function readCsvFile(file, { delimiter = ',', encoding = 65001 } = {}) {
  const label = typeof encoding === 'number' || /^\d+$/.test(String(encoding)) ? encodingForCodePage(encoding) : encoding;
  const text = new TextDecoder(label).decode(fs.readFileSync(file)).replace(/^\uFEFF/, '');
  return parseCsv(text, { delimiter });
}

// ---------- Power Query (M) source scanning; nothing is executed ----------

// Decodes an M text literal body: "" and #(lf), #(cr), #(tab), #(#), #(0041).
export function mUnescape(body) {
  return String(body).replaceAll('""', '"').replace(/#\(([^)]*)\)/g, (all, code) => {
    const name = code.toLowerCase();
    if (name === 'lf') return '\n';
    if (name === 'cr') return '\r';
    if (name === 'tab') return '\t';
    if (name === 'cr,lf') return '\r\n';
    if (code === '#') return '#';
    if (/^[0-9a-f]{4}$/i.test(code)) return String.fromCharCode(parseInt(code, 16));
    if (/^[0-9a-f]{8}$/i.test(code)) return String.fromCodePoint(parseInt(code, 16));
    return all;
  });
}

// Removes // and /* */ comments while leaving text literals (such as URLs) intact.
export function stripMComments(text) {
  let result = '', index = 0, quoted = false;
  while (index < text.length) {
    const c = text[index], next = text[index + 1];
    if (quoted) { result += c; if (c === '"') { if (next === '"') { result += next; index += 2; continue; } quoted = false; } index++; continue; }
    if (c === '"') { quoted = true; result += c; index++; continue; }
    if (c === '/' && next === '/') { while (index < text.length && text[index] !== '\n') index++; continue; }
    if (c === '/' && next === '*') { const end = text.indexOf('*/', index + 2); index = end < 0 ? text.length : end + 2; result += ' '; continue; }
    result += c;
    index++;
  }
  return result;
}

// Top-level arguments of the call whose "(" is at openIndex.
export function callArguments(text, openIndex) {
  const args = [];
  let depth = 0, quoted = false, start = openIndex + 1;
  for (let index = openIndex; index < text.length; index++) {
    const c = text[index];
    if (quoted) { if (c === '"') { if (text[index + 1] === '"') index++; else quoted = false; } continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { const last = text.slice(start, index).trim(); if (last || args.length) args.push(last); return { args, end: index + 1 }; }
      continue;
    }
    if (c === ',' && depth === 1) { args.push(text.slice(start, index).trim()); start = index + 1; }
  }
  return null;
}

// Resolves "literal", Parameter, #"Parameter", and "a" & Parameter & "b" to text; null otherwise.
export function resolveMText(expression, parameters = new Map()) {
  const parts = [];
  let depth = 0, quoted = false, start = 0;
  const text = String(expression ?? '').trim();
  for (let index = 0; index <= text.length; index++) {
    const c = text[index];
    if (index < text.length) {
      if (quoted) { if (c === '"') { if (text[index + 1] === '"') index++; else quoted = false; } continue; }
      if (c === '"') { quoted = true; continue; }
      if (c === '(' || c === '[' || c === '{') { depth++; continue; }
      if (c === ')' || c === ']' || c === '}') { depth--; continue; }
      if (!(c === '&' && depth === 0)) continue;
    }
    parts.push(text.slice(start, index).trim());
    start = index + 1;
  }
  let result = '';
  for (const part of parts) {
    const literal = /^"((?:[^"]|"")*)"$/.exec(part);
    if (literal) { result += mUnescape(literal[1]); continue; }
    const name = /^#"((?:[^"]|"")*)"$/.exec(part)?.[1]?.replaceAll('""', '"') ?? (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(part) ? part : null);
    if (name === null || !parameters.has(name)) return null;
    result += parameters.get(name);
  }
  return parts.length ? result : null;
}

function modelSourceFiles(files) {
  return files.filter(f => /\.(tmdl|m|pq|bim)$/i.test(f) && !/[\\/](?:TMDLScripts|DAXQueries|cultures)[\\/]/i.test(f));
}

function bimExpressions(model) {
  const found = [];
  const text = value => Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : null;
  for (const table of model?.model?.tables ?? []) for (const partition of table.partitions ?? []) {
    const source = text(partition.source?.expression);
    if (source && partition.source?.type !== 'calculated') found.push({ kind: 'partition', name: table.name, text: source });
  }
  for (const expression of model?.model?.expressions ?? []) {
    const source = text(expression.expression);
    if (source) found.push({ kind: 'expression', name: expression.name, text: source });
  }
  return found;
}

// Each M expression of a model file, separately.
function mExpressions(file) {
  try {
    if (/\.bim$/i.test(file)) return bimExpressions(readJson(file));
    const text = fs.readFileSync(file, 'utf8');
    if (/\.tmdl$/i.test(file)) {
      const found = tmdlMExpressions(text);
      return found.length || !/\b(?:File\.Contents|PostgreSQL\.Database)\s*\(/.test(text) ? found : [{ kind: 'file', name: null, text }];
    }
    return [{ kind: 'file', name: null, text }];
  } catch { return []; }
}

// Literal M parameters (expression X = "value" meta [IsParameterQuery=true, ...]).
export function findMParameters(files) {
  const parameters = new Map();
  for (const file of modelSourceFiles(files)) {
    for (const expression of mExpressions(file)) {
      if (expression.kind !== 'expression') continue;
      const value = mParameterLiteral(expression.text);
      if (value !== null) parameters.set(expression.name, value);
    }
  }
  return parameters;
}

function parseLiteralList(value) {
  if (!value || value.toLowerCase() === 'null') return [];
  if (!value.startsWith('{') || !value.endsWith('}')) return null;
  const body = value.slice(1, -1).trim();
  if (!body) return [];
  const parts = [], current = [];
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '"' && quoted && body[i + 1] === '"') { current.push('""'); i++; }
    else if (char === '"') { quoted = !quoted; current.push(char); }
    else if (char === ',' && !quoted) { parts.push(current.join('')); current.length = 0; }
    else current.push(char);
  }
  if (quoted) return null;
  parts.push(current.join(''));
  return parts.map(part => {
    const item = part.trim();
    if (/^"(?:[^"]|"")*"$/.test(item)) return mUnescape(item.slice(1, -1));
    if (/^(true|false|null)$/i.test(item)) return ({ true: true, false: false, null: null })[item.toLowerCase()];
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(item)) return Number(item);
    return undefined;
  });
}

function statFile(sourcePath) {
  try {
    const stat = fs.statSync(sourcePath);
    return stat.isFile() ? { available: true, bytes: stat.size, error: null } : { available: false, bytes: null, error: 'Not a file' };
  } catch (e) { return { available: false, bytes: null, error: e.code ?? e.message }; }
}

const CONNECTOR_CALL = /\b(Sql\.Databases?|MySQL\.Database|Oracle\.Database|Odbc\.(?:DataSource|Query)|OleDb\.(?:DataSource|Query)|Web\.Contents|SharePoint\.(?:Files|Contents|Tables)|AzureStorage\.[A-Za-z]+|Folder\.(?:Files|Contents)|Excel\.Workbook|AnalysisServices\.Databases?|Snowflake\.Databases|GoogleBigQuery\.Database|Databricks\.Catalogs|PowerBI\.Dataflows|PowerPlatform\.Dataflows|Lakehouse\.Contents|Fabric\.[A-Za-z]+)\s*\(/g;

// One pass over every M expression in the model: PostgreSQL connections (with
// navigation and native SQL), file reads, other connectors, and anything whose
// target depends on something other than literal text or literal parameters.
export function scanModelSources(files) {
  const parameters = findMParameters(files);
  const postgres = new Map(), fileSources = new Map(), connectors = [], unresolved = [];
  for (const file of modelSourceFiles(files)) {
    const referencedBy = relative(file);
    for (const expression of mExpressions(file)) {
      const text = stripMComments(expression.text);
      const where = `${referencedBy}${expression.name ? ` (${expression.name})` : ''}`;
      for (const match of text.matchAll(CONNECTOR_CALL)) connectors.push({ connector: match[1], referencedBy, ...(expression.name ? { query: expression.name } : {}) });
      const nativeCalls = [];
      let nativeTotal = 0;
      for (const match of text.matchAll(/Value\.NativeQuery\s*\(/g)) {
        nativeTotal++;
        const call = callArguments(text, match.index + match[0].length - 1);
        const target = call?.args[0] ?? '';
        const connection = /^PostgreSQL\.Database\s*\(/.exec(target);
        if (!connection) continue;
        const inner = callArguments(target, connection[0].length - 1);
        const server = resolveMText(inner?.args[0], parameters), database = resolveMText(inner?.args[1], parameters);
        const sql = resolveMText(call.args[1], parameters);
        const values = parseLiteralList(call.args[2] ?? 'null');
        if (server === null || database === null || sql === null || !values || values.some(value => value === undefined)) continue;
        nativeCalls.push({ server, database, query: { sql, parameters: values, referencedBy } });
      }
      let databaseCalls = 0;
      for (const match of text.matchAll(/PostgreSQL\.Database\s*\(/g)) {
        databaseCalls++;
        const call = callArguments(text, match.index + match[0].length - 1);
        const server = resolveMText(call?.args[0], parameters), database = resolveMText(call?.args[1], parameters);
        if (server === null || database === null) { unresolved.push({ connector: 'PostgreSQL.Database', arguments: (call?.args ?? []).slice(0, 2).join(', '), referencedBy: where }); continue; }
        const key = `${server}\0${database}`;
        const existing = postgres.get(key) ?? { server, database, tables: [], nativeQueries: [], hasUnresolvedNativeQuery: false, referencedBy: [] };
        if (/^\s*[A-Za-z_]/.test(call.args[0]) || /^\s*[A-Za-z_]/.test(call.args[1])) existing.parameterised = true;
        for (const nav of text.matchAll(/\[\s*Schema\s*=\s*"((?:[^"]|"")*)"\s*,\s*Item\s*=\s*"((?:[^"]|"")*)"\s*\]/gi)) {
          const table = { schema: mUnescape(nav[1]), item: mUnescape(nav[2]) };
          if (!existing.tables.some(x => x.schema === table.schema && x.item === table.item)) existing.tables.push(table);
        }
        if (!existing.referencedBy.includes(referencedBy)) existing.referencedBy.push(referencedBy);
        postgres.set(key, existing);
      }
      for (const native of nativeCalls) {
        const existing = postgres.get(`${native.server}\0${native.database}`);
        if (existing && !existing.nativeQueries.some(x => x.sql === native.query.sql && JSON.stringify(x.parameters) === JSON.stringify(native.query.parameters))) existing.nativeQueries.push(native.query);
      }
      // Never silently omit a native query whose target or M parameters cannot be parsed.
      if (nativeTotal > nativeCalls.length && databaseCalls) {
        for (const existing of postgres.values()) if (existing.referencedBy.includes(referencedBy)) existing.hasUnresolvedNativeQuery = true;
      }
      for (const match of text.matchAll(/File\.Contents\s*\(/g)) {
        const call = callArguments(text, match.index + match[0].length - 1);
        const sourcePath = resolveMText(call?.args[0], parameters);
        if (sourcePath === null) { unresolved.push({ connector: 'File.Contents', arguments: call?.args[0] ?? '', referencedBy: where }); continue; }
        const reader = /([A-Za-z]+\.[A-Za-z]+)\s*\(\s*$/.exec(text.slice(Math.max(0, match.index - 60), match.index))?.[1] ?? null;
        const key = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath;
        if (fileSources.has(key)) continue;
        const record = { path: sourcePath, referencedBy, reader, absolute: path.isAbsolute(sourcePath) || path.win32.isAbsolute(sourcePath), ...statFile(sourcePath) };
        if (reader === 'Csv.Document') {
          const readerCall = /Csv\.Document\s*\(\s*$/.exec(text.slice(0, match.index));
          const options = readerCall ? callArguments(text, readerCall.index + readerCall[0].length - 1)?.args[1] ?? '' : '';
          const delimiter = /Delimiter\s*=\s*"((?:[^"]|"")*)"/.exec(options)?.[1];
          const encoding = /Encoding\s*=\s*(\d+)/.exec(options)?.[1];
          record.csvOptions = { delimiter: delimiter === undefined ? ',' : mUnescape(delimiter), encoding: encoding ? Number(encoding) : 65001 };
        }
        fileSources.set(key, record);
      }
    }
  }
  return { parameters: Object.fromEntries(parameters), postgresSources: [...postgres.values()], fileSources: [...fileSources.values()], connectors, unresolved };
}

export function findPostgresSources(files) {
  return scanModelSources(files).postgresSources;
}

// Legacy snapshot flow: absolute .csv files read with File.Contents.
export function findDirectCsvSources(files) {
  return scanModelSources(files).fileSources
    .filter(source => source.absolute && /\.csv$/i.test(source.path))
    .map(({ path: sourcePath, referencedBy, available, bytes, error }) => ({ path: sourcePath, referencedBy, available, bytes, error, kind: 'raw-file-source' }));
}

export function findUnsupportedConnectors(files) {
  return scanModelSources(files).connectors;
}

export function findReportModelReferences(pbirFiles) {
  return pbirFiles.map(file => {
    const reference = readJson(file)?.datasetReference;
    let kind = 'unknown';
    if (reference?.byConnection) kind = 'remote-connection';
    else if (typeof reference?.byPath?.path === 'string') {
      const target = path.resolve(path.dirname(file), reference.byPath.path);
      const insideInput = target.toLowerCase().startsWith((path.resolve(inputDir) + path.sep).toLowerCase());
      kind = insideInput && fs.existsSync(target) && fs.statSync(target).isDirectory() ? 'local-path' : 'missing-local-path';
    }
    return {
      report: relative(file),
      kind
    };
  });
}

export function discover() {
  const files = walk(inputDir);
  const pbip = files.filter(f => f.toLowerCase().endsWith('.pbip'));
  const pbir = files.filter(f => f.toLowerCase().endsWith('definition.pbir'));
  if (pbip.length !== 1) throw new Error(`Expected exactly one .pbip in input/; found ${pbip.length}${pbip.length ? `: ${pbip.map(relative).join(', ')}` : ''}. Put exactly one PBIP project (the .pbip file with its .Report and .SemanticModel folders) in gemini/input.`);
  if (!pbir.length) throw new Error('No definition.pbir found. Save the project in PBIP format with a report folder.');
  const problems = [];
  const pageFiles = files.filter(f => /[\\/]definition[\\/]pages[\\/][^\\/]+[\\/]page\.json$/i.test(f));
  const pages = pageFiles.map(f => {
    const j = readJson(f);
    if (!j) problems.push(`${relative(f)} is not valid JSON; the page name and page filters are unknown.`);
    const folder = path.dirname(f);
    const visuals = walk(path.join(folder, 'visuals')).filter(v => /[\\/]visual\.json$/i.test(v)).map(v => {
      const x = readJson(v);
      if (!x) problems.push(`${relative(v)} is not valid JSON; this visual cannot be reconstructed from its definition.`);
      return {
        id: path.basename(path.dirname(v)),
        source: relative(v),
        type: x ? visualType(x) : 'unreadable',
        title: x ? visualTitle(x) : null,
        position: x?.position ?? null,
        // Unreadable JSON is treated as data-bound so it is never silently skipped.
        role: x ? classifyVisual(x) : 'data',
        ...(x?.isHidden ? { hidden: true } : {})
      };
    });
    return { id: path.basename(folder), name: j?.displayName ?? j?.name ?? path.basename(folder), source: relative(f), ...(pageIsHidden(j) ? { hidden: true } : {}), visuals };
  });
  const orderFile = files.find(f => /[\\/]definition[\\/]pages[\\/]pages\.json$/i.test(f));
  const pageOrder = orderFile ? readJson(orderFile)?.pageOrder : null;
  // pages.json order first; pages it omits (or all pages without it) follow by display name.
  const order = Array.isArray(pageOrder) ? pageOrder : [];
  pages.sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi) || a.name.localeCompare(b.name);
  });
  const dataFiles = files.filter(f => {
    const rel = relative(f).toLowerCase();
    return rel.startsWith('input/data/') && /\.(csv|json)$/.test(rel);
  });
  const scan = scanModelSources(files);
  const fileSources = scan.fileSources;
  const directCsvSources = fileSources.filter(source => source.absolute && /\.csv$/i.test(source.path)).map(({ path: sourcePath, referencedBy, available, bytes, error }) => ({ path: sourcePath, referencedBy, available, bytes, error, kind: 'raw-file-source' }));
  const postgresSources = scan.postgresSources;
  const unsupportedConnectors = scan.connectors;
  const reportModelReferences = findReportModelReferences(pbir);
  for (const item of scan.unresolved) problems.push(`${item.connector}(${item.arguments}) in ${item.referencedBy} depends on something other than literal text or a literal parameter, so it cannot be checked before the run.`);
  const availableDataCount = dataFiles.length + directCsvSources.filter(x => x.available).length + postgresSources.reduce((n, x) => n + x.tables.length + x.nativeQueries.length, 0);
  return {
    project: relative(pbip[0]), reportDefinitions: pbir.map(relative),
    pages, dataFiles: dataFiles.map(f => ({ path: relative(f), bytes: fs.statSync(f).size })),
    directCsvSources,
    fileSources,
    postgresSources,
    unsupportedConnectors,
    unresolvedSources: scan.unresolved,
    mParameters: scan.parameters,
    reportModelReferences,
    sourceFileCount: files.length,
    problems,
    warnings: [
      ...(availableDataCount ? [] : ['No readable local CSV/JSON exports or direct File.Contents CSV sources found. Output can only be a metadata/layout preview.']),
      ...directCsvSources.filter(x => !x.available).map(x => `CSV source not readable: ${x.path} (${x.error}).`),
      ...(directCsvSources.some(x => x.available) ? ['Direct CSV source rows are raw; Power Query transformations and DAX have not been executed.'] : []),
      ...(postgresSources.length ? ['PostgreSQL sources found. A read-only login and npm install are required; raw tables/views do not include Power Query or DAX results.'] : []),
      ...postgresSources.filter(x => x.hasUnresolvedNativeQuery).map(x => `PostgreSQL source ${x.server}/${x.database} has a native query the parser cannot safely resolve; use a literal query with null parameters or provide a reviewed export.`),
      ...postgresSources.filter(x => x.nativeQueries.length).map(x => `PostgreSQL native query found for ${x.server}/${x.database}; explicit PG_ALLOW_NATIVE_QUERIES=true is required. Power Query steps after SQL, merges, and DAX are not applied automatically.`),
      ...postgresSources.filter(x => !x.tables.length && !x.nativeQueries.length && !x.hasUnresolvedNativeQuery).map(x => `PostgreSQL source ${x.server}/${x.database} has no simple schema/table navigation to read.`),
      ...unsupportedConnectors.map(x => `Unsupported connector ${x.connector} in ${x.referencedBy}; this run will not access it.`),
      ...(pages.length ? [] : ['No enhanced PBIR page.json files found. Legacy report.json requires agent interpretation.'])
    ]
  };
}

export function loadData(inventory) {
  const sources = [
    ...inventory.dataFiles.map(info => ({ file: path.join(root, info.path), source: info.path, kind: 'local-export' })),
    ...(inventory.directCsvSources ?? []).filter(info => info.available).map(info => ({ file: info.path, source: path.basename(info.path), kind: 'raw-file-source' }))
  ];
  return { datasets: sources.map(info => {
    const file = info.file;
    const name = path.basename(file, path.extname(file));
    if (file.toLowerCase().endsWith('.csv')) return { name, source: info.source, kind: info.kind, ...parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
    const parsed = readJson(file);
    if (parsed === null) throw new Error(`Invalid JSON: ${info.source}`);
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : null;
    if (!rows) throw new Error(`JSON must be an array or have a rows array: ${info.source}`);
    const columns = [...new Set(rows.flatMap(x => x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x) : []))];
    return { name, source: info.source, kind: info.kind, columns, rows };
  }) };
}
