// Compares the generated report with Power BI itself: every data visual's query
// (dax-query.mjs) runs on Power BI Desktop's own engine, and the rows it returns
// are matched, value by value, with the rows the report's backend returns for the
// same visual in its default state (filters {}).
//
//   parityQueries(inventory, digest, { rootDir, limit })   -> [spec]
//   compareVisual(spec, truth, backendVisual, { limit })   -> { status: match | mismatch | not-compared, ... }
//   parityFixRequest(results)                              -> the "parity" part of work/fix-request.json
import path from 'node:path';
import { root, readJson } from './core.mjs';
import { visualDaxQuery } from './dax-query.mjs';

export const PARITY_ROW_LIMIT = 2000;

export function parityQueries(inventory, digest, { rootDir = root, limit = PARITY_ROW_LIMIT } = {}) {
  const reportDir = inventory.reportFolder ? path.join(rootDir, inventory.reportFolder, 'definition') : null;
  const report = reportDir ? readJson(path.join(reportDir, 'report.json')) : null;
  const extensions = reportDir ? readJson(path.join(reportDir, 'reportExtensions.json')) : null;
  const reportMeasures = (extensions?.entities ?? []).flatMap(entity => (entity.measures ?? []).filter(item => item?.name && item?.expression).map(item => ({ table: entity.name, name: item.name, expression: Array.isArray(item.expression) ? item.expression.join('\n') : item.expression })));
  const specs = [];
  for (const page of inventory.pages ?? []) {
    const pageJson = readJson(path.join(rootDir, page.source)) ?? {};
    const pageVisuals = (page.visuals ?? []).map(visual => ({ id: visual.id, json: visual.source ? readJson(path.join(rootDir, visual.source)) : null })).filter(item => item.json);
    for (const visual of (page.visuals ?? []).filter(item => item.role === 'data')) {
      const base = { visualId: visual.id, page: page.name, type: visual.type, title: visual.title ?? null };
      const json = pageVisuals.find(item => item.id === visual.id)?.json;
      if (!json) { specs.push({ ...base, dax: null, groupBy: [], values: [], unsupported: ['its visual.json cannot be read'] }); continue; }
      specs.push({ ...base, ...visualDaxQuery({ visual: json, page: pageJson, report, pageVisuals, model: digest?.model ?? null, reportMeasures, limit }) });
    }
  }
  return specs;
}

// ---------- value comparison ----------

export function normalizeValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  const text = String(value).trim();
  // Power BI writes dates as 2024-01-31T00:00:00.000; reports usually as 2024-01-31.
  const date = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?Z?)?$/.exec(text);
  if (date) return !date[2] || /^00:00(?::00)?$/.test(date[2]) ? date[1] : `${date[1]}T${date[2].length === 5 ? `${date[2]}:00` : date[2]}`;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return Number(text);
  return text;
}

function keyPart(value) {
  if (typeof value === 'string') return value.toLowerCase();
  if (typeof value === 'number') return Number(value.toPrecision(12));
  return value;
}

export function sameValue(a, b) {
  if (a === null || b === null) return a === b;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 + 1e-6 * Math.max(Math.abs(a), Math.abs(b));
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

// A likely cause for a difference that follows a pattern.
export function differenceHint(powerBI, report, rawReport) {
  if (powerBI === null && report === 0) return 'Power BI shows blank here (for example DIVIDE by zero or no rows); return null, not 0';
  if (powerBI !== null && report === null) return 'the report returns blank where Power BI has a value';
  if (typeof rawReport === 'string' && typeof powerBI === 'number') return 'the report sends this number as text; send a JS number';
  if (typeof powerBI === 'number' && typeof report === 'number' && powerBI !== 0 && report !== 0) {
    const ratio = report / powerBI;
    if (Math.abs(ratio - 100) < 1e-6 * 100) return 'the report value is 100 times Power BI\'s: send fractions (0.124), format as % only in the HTML';
    if (Math.abs(ratio - 0.01) < 1e-8) return 'the report value is 1/100 of Power BI\'s';
    if (Math.abs(ratio + 1) < 1e-6) return 'the sign is flipped';
  }
  return null;
}

function rowObject(refs, values) {
  return Object.fromEntries(refs.map((ref, index) => [ref, values[index]]));
}

// spec: from parityQueries; truth: { columns, rows, error } from Power BI;
// backend: { rows, columns, placeholder, limitations } the report's backend returned.
export function compareVisual(spec, truth, backend, { limit = PARITY_ROW_LIMIT } = {}) {
  const base = { visualId: spec.visualId, page: spec.page, type: spec.type, title: spec.title, ...(spec.unsupported?.length ? { notes: spec.unsupported } : {}) };
  if (!spec.dax) return { ...base, status: 'not-compared', reason: (spec.unsupported ?? []).join('; ') || 'no query' };
  if (!truth) return { ...base, status: 'not-compared', reason: 'Power BI returned no result for this visual', dax: spec.dax };
  if (truth.error) return { ...base, status: 'not-compared', reason: `Power BI Desktop could not run the rebuilt query: ${String(truth.error).slice(0, 300)}`, dax: spec.dax };
  if (!backend) return { ...base, status: 'not-compared', reason: 'the report did not answer this visual', dax: spec.dax };
  const groupRefs = spec.groupBy.map(item => item.queryRef), valueRefs = spec.values.map(item => item.queryRef);
  const refs = [...groupRefs, ...valueRefs];
  const truthRows = (truth.rows ?? []).map(row => rowObject(refs, refs.map((_ref, index) => normalizeValue(row[index]))));
  if (truthRows.length > limit) return { ...base, status: 'not-compared', reason: `Power BI returns more than ${limit} rows for this visual`, dax: spec.dax };
  const sample = rows => rows.slice(0, 30);
  const powerBiSample = sample(truthRows);
  if (backend.placeholder) return { ...base, status: 'mismatch', kind: 'placeholder', reason: `the report shows a placeholder (${(backend.limitations ?? []).join('; ') || 'no reason given'}) where Power BI shows ${truthRows.length} row(s)`, dax: spec.dax, powerBiRows: powerBiSample, fields: refs };
  const backendRows = Array.isArray(backend.rows) ? backend.rows.filter(row => row && typeof row === 'object' && !Array.isArray(row)) : [];
  const columns = new Set([...(Array.isArray(backend.columns) ? backend.columns.map(String) : []), ...backendRows.flatMap(row => Object.keys(row))]);
  const missingColumns = refs.filter(ref => !columns.has(ref));
  if (missingColumns.length) {
    return { ...base, status: 'mismatch', kind: 'field-names', reason: `the report's rows do not use Power BI's field names as keys (missing ${missingColumns.join(', ')}), so the values cannot be compared`, missingColumns, reportColumns: [...columns].slice(0, 30), dax: spec.dax, powerBiRows: powerBiSample, fields: refs };
  }
  const reportRows = backendRows.map(row => rowObject(refs, refs.map(ref => normalizeValue(row[ref]))));
  const rawByKey = new Map(backendRows.map((row, index) => [JSON.stringify(groupRefs.map(ref => keyPart(reportRows[index][ref]))), row]));
  // A visual without grouping fields (a card) is one row; Power BI returns none when every value is blank.
  const blankRow = () => rowObject(refs, refs.map(() => null));
  const truthList = !groupRefs.length && !truthRows.length ? [blankRow()] : truthRows;
  const reportList = !groupRefs.length && !reportRows.length ? [blankRow()] : reportRows;
  const keyOf = row => JSON.stringify(groupRefs.map(ref => keyPart(row[ref])));
  const truthByKey = new Map(truthList.map(row => [keyOf(row), row]));
  const reportByKey = new Map();
  let duplicates = 0;
  for (const row of reportList) { const key = keyOf(row); if (reportByKey.has(key)) duplicates++; else reportByKey.set(key, row); }
  const differences = [], missingRows = [], extraRows = [];
  let checkedValues = 0;
  for (const [key, expected] of truthByKey) {
    const actual = reportByKey.get(key);
    if (!actual) { missingRows.push(expected); continue; }
    for (const ref of valueRefs) {
      checkedValues++;
      if (sameValue(expected[ref], actual[ref])) continue;
      const hint = differenceHint(expected[ref], actual[ref], rawByKey.get(key)?.[ref]);
      differences.push({ row: rowObject(groupRefs, groupRefs.map(item => expected[item])), field: ref, powerBI: expected[ref], report: actual[ref], ...(hint ? { hint } : {}) });
    }
  }
  for (const [key, row] of reportByKey) {
    if (truthByKey.has(key)) continue;
    // Power BI leaves out rows whose values are all blank; a report row of blanks or zeros is not a difference.
    if (valueRefs.length && valueRefs.every(ref => row[ref] === null || row[ref] === 0)) continue;
    extraRows.push(row);
  }
  const status = differences.length || missingRows.length || extraRows.length || duplicates ? 'mismatch' : 'match';
  return {
    ...base, status, dax: spec.dax, fields: refs,
    powerBiRowCount: truthRows.length, reportRowCount: reportRows.length, checkedValues,
    ...(status === 'mismatch' ? {
      kind: 'values',
      reason: [
        differences.length ? `${differences.length} value(s) differ` : null,
        missingRows.length ? `${missingRows.length} row(s) missing from the report` : null,
        extraRows.length ? `${extraRows.length} row(s) that Power BI does not show` : null,
        duplicates ? `${duplicates} duplicate row(s) for the same ${groupRefs.join(' / ') || 'visual'}` : null
      ].filter(Boolean).join(', '),
      differences: differences.slice(0, 15),
      missingRows: missingRows.slice(0, 10),
      extraRows: extraRows.slice(0, 10),
      powerBiRows: powerBiSample
    } : {})
  };
}

export function paritySummary(results) {
  const count = status => results.filter(item => item.status === status).length;
  return { match: count('match'), mismatch: count('mismatch'), notCompared: count('not-compared'), total: results.length };
}

// What Gemini gets for a fix round: the Power BI rows (ground truth) next to the report's.
export function parityFixRequest(results) {
  return {
    about: 'Power BI Desktop computed these visuals with the report\'s own model and default filters (report, page and visual filters and saved slicer selections). Its rows are the ground truth. Make query() return exactly these rows for filters {}: one row per combination of the grouping fields, keyed by the field queryRefs listed in "fields", with raw values (numbers as numbers, 0.124 for 12.4 %, blank as null). dax is the query Power BI ran; use it to understand the filters and measure logic.',
    visuals: results.filter(item => item.status === 'mismatch').map(item => ({
      visualId: item.visualId, page: item.page, type: item.type, title: item.title,
      problem: item.reason, fields: item.fields, dax: item.dax,
      ...(item.missingColumns ? { missingColumns: item.missingColumns, reportColumns: item.reportColumns } : {}),
      ...(item.differences?.length ? { differences: item.differences } : {}),
      ...(item.missingRows?.length ? { missingRows: item.missingRows } : {}),
      ...(item.extraRows?.length ? { extraRows: item.extraRows } : {}),
      powerBiRows: item.powerBiRows ?? []
    }))
  };
}
