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
  return {
    project: relative(pbip[0]), reportDefinitions: pbir.map(relative),
    pages, dataFiles: dataFiles.map(f => ({ path: relative(f), bytes: fs.statSync(f).size })),
    sourceFileCount: files.length,
    warnings: [
      ...(dataFiles.length ? [] : ['No local CSV/JSON data supplied. Output can only be a metadata/layout preview.']),
      ...(pages.length ? [] : ['No enhanced PBIR page.json files found. Legacy report.json requires agent interpretation.'])
    ]
  };
}

export function loadData(inventory) {
  return { datasets: inventory.dataFiles.map(info => {
    const file = path.join(root, info.path);
    const name = path.basename(file, path.extname(file));
    if (file.toLowerCase().endsWith('.csv')) return { name, source: info.path, ...parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
    const parsed = readJson(file);
    if (parsed === null) throw new Error(`Invalid JSON: ${info.path}`);
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : null;
    if (!rows) throw new Error(`JSON must be an array or have a rows array: ${info.path}`);
    const columns = [...new Set(rows.flatMap(x => x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x) : []))];
    return { name, source: info.path, columns, rows };
  }) };
}
