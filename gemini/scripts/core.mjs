import fs from 'node:fs';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');
export const inputDir = path.join(root, 'input');
export const workDir = path.join(root, 'work');
export const dynamicDir = path.join(root, 'output', 'dynamic');
export const staticDir = path.join(root, 'output', 'static');

export function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
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

export function parseCsv(content) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '"') {
      if (quoted && content[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { row.push(field); field = ''; }
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

function mTextSources(file) {
  if (!/\.bim$/i.test(file)) return [fs.readFileSync(file, 'utf8')];
  const model = readJson(file);
  if (!model) return [];
  const found = [];
  function visit(value) {
    if (typeof value === 'string') { if (value.includes('File.Contents') || value.includes('PostgreSQL.Database')) found.push(value); }
    else if (Array.isArray(value) && value.every(x => typeof x === 'string')) {
      const joined = value.join('\n');
      if (joined.includes('File.Contents') || joined.includes('PostgreSQL.Database')) found.push(joined);
    }
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  visit(model);
  return found;
}

function modelSourceFiles(files) {
  return files.filter(f => /\.(tmdl|m|pq|bim)$/i.test(f) && !/[\\/](?:TMDLScripts|DAXQueries)[\\/]/i.test(f));
}

export function findPostgresSources(files) {
  const found = new Map();
  const quote = '"((?:[^\"]|\"\")*)"';
  const databaseCall = new RegExp(`PostgreSQL\\.Database\\s*\\(\\s*${quote}\\s*,\\s*${quote}`, 'gi');
  const nativeCall = new RegExp(`Value\\.NativeQuery\\s*\\(\\s*PostgreSQL\\.Database\\s*\\(\\s*${quote}\\s*,\\s*${quote}\\s*\\)\\s*,\\s*${quote}\\s*,\\s*null\\s*(?:,|\\))`, 'gi');
  const unquote = value => value.replaceAll('""', '"');
  for (const file of modelSourceFiles(files)) {
    for (const sourceText of mTextSources(file)) {
      const nativeByConnection = new Map();
      for (const match of sourceText.matchAll(nativeCall)) {
        const key = `${unquote(match[1])}\0${unquote(match[2])}`;
        const sql = unquote(match[3]).replace(/#\((lf|cr|tab)\)/gi, (_escape, name) => ({ lf: '\n', cr: '\r', tab: '\t' })[name.toLowerCase()]);
        const queries = nativeByConnection.get(key) ?? [];
        queries.push({ sql, referencedBy: relative(file) });
        nativeByConnection.set(key, queries);
      }
      for (const match of sourceText.matchAll(databaseCall)) {
        const server = unquote(match[1]);
        const database = unquote(match[2]);
        const tail = sourceText.slice(match.index + match[0].length);
        const tables = [];
        for (const nav of tail.matchAll(/\[\s*Schema\s*=\s*"((?:[^"]|"")*)"\s*,\s*Item\s*=\s*"((?:[^"]|"")*)"\s*\]/gi)) {
          tables.push({ schema: unquote(nav[1]), item: unquote(nav[2]) });
        }
        const key = `${server}\0${database}`;
        const existing = found.get(key) ?? { server, database, tables: [], nativeQueries: [], hasUnresolvedNativeQuery: false, referencedBy: [] };
        for (const table of tables) if (!existing.tables.some(x => x.schema === table.schema && x.item === table.item)) existing.tables.push(table);
        for (const query of nativeByConnection.get(key) ?? []) {
          if (!existing.nativeQueries.some(x => x.sql === query.sql)) existing.nativeQueries.push(query);
        }
        existing.hasUnresolvedNativeQuery ||= /Value\.NativeQuery\s*\(/i.test(sourceText) && !existing.nativeQueries.length;
        if (!existing.referencedBy.includes(relative(file))) existing.referencedBy.push(relative(file));
        found.set(key, existing);
      }
    }
  }
  return [...found.values()];
}

export function findDirectCsvSources(files) {
  const found = new Map();
  for (const file of modelSourceFiles(files)) {
    for (const sourceText of mTextSources(file)) {
      const matches = sourceText.matchAll(/File\.Contents\s*\(\s*"((?:[^"]|"")*)"\s*\)/gi);
      for (const match of matches) {
        const sourcePath = match[1].replaceAll('""', '"');
        if (!/\.csv$/i.test(sourcePath)) continue;
        if (!path.isAbsolute(sourcePath) && !path.win32.isAbsolute(sourcePath)) continue;
        const key = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath;
        if (found.has(key)) continue;
        let available = false, bytes = null, error = null;
        try {
          const stat = fs.statSync(sourcePath);
          available = stat.isFile();
          bytes = available ? stat.size : null;
          if (!available) error = 'Not a file';
        } catch (e) { error = e.code ?? e.message; }
        found.set(key, { path: sourcePath, referencedBy: relative(file), available, bytes, error, kind: 'raw-file-source' });
      }
    }
  }
  return [...found.values()];
}

export function findUnsupportedConnectors(files) {
  const connectors = ['Sql.Database', 'MySQL.Database', 'Oracle.Database', 'Odbc.DataSource', 'Odbc.Query', 'Web.Contents', 'SharePoint.Files', 'AzureStorage.Blobs', 'Folder.Files'];
  const found = [];
  for (const file of modelSourceFiles(files)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const connector of connectors) if (text.includes(connector)) found.push({ connector, referencedBy: relative(file) });
  }
  return found;
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
  if (pbip.length !== 1) throw new Error(`Expected exactly one .pbip in input/; found ${pbip.length}.`);
  if (!pbir.length) throw new Error('No definition.pbir found. Save the project in PBIP format with a report folder.');
  const pageFiles = files.filter(f => /[\\/]definition[\\/]pages[\\/][^\\/]+[\\/]page\.json$/i.test(f));
  const pages = pageFiles.map(f => {
    const j = readJson(f) ?? {};
    const folder = path.dirname(f);
    const visuals = walk(path.join(folder, 'visuals')).filter(v => /[\\/]visual\.json$/i.test(v)).map(v => {
      const x = readJson(v) ?? {};
      return {
        id: path.basename(path.dirname(v)),
        source: relative(v),
        type: x.visual?.visualType ?? x.visualType ?? 'unknown',
        title: x.visual?.objects?.title?.[0]?.properties?.text?.expr?.Literal?.Value ?? null,
        position: x.position ?? null
      };
    });
    return { id: path.basename(folder), name: j.displayName ?? j.name ?? path.basename(folder), source: relative(f), visuals };
  });
  const orderFile = files.find(f => /[\\/]definition[\\/]pages[\\/]pages\.json$/i.test(f));
  const pageOrder = orderFile ? readJson(orderFile)?.pageOrder : null;
  if (Array.isArray(pageOrder)) pages.sort((a, b) => {
    const ai = pageOrder.indexOf(a.id), bi = pageOrder.indexOf(b.id);
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi) || a.name.localeCompare(b.name);
  });
  const dataFiles = files.filter(f => {
    const rel = relative(f).toLowerCase();
    return rel.startsWith('input/data/') && /\.(csv|json)$/.test(rel);
  });
  const directCsvSources = findDirectCsvSources(files);
  const postgresSources = findPostgresSources(files);
  const unsupportedConnectors = findUnsupportedConnectors(files);
  const reportModelReferences = findReportModelReferences(pbir);
  const availableDataCount = dataFiles.length + directCsvSources.filter(x => x.available).length + postgresSources.reduce((n, x) => n + x.tables.length + x.nativeQueries.length, 0);
  return {
    project: relative(pbip[0]), reportDefinitions: pbir.map(relative),
    pages, dataFiles: dataFiles.map(f => ({ path: relative(f), bytes: fs.statSync(f).size })),
    directCsvSources,
    postgresSources,
    unsupportedConnectors,
    reportModelReferences,
    sourceFileCount: files.length,
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
