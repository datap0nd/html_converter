// Deterministic stand-in for the Gemini model used by the end-to-end tests.
// Given a converter phase prompt and the staged workspace, it returns the files
// a well-behaved model would write. Scenario switches inject the failures the
// orchestrator must survive.
import fs from 'node:fs';
import path from 'node:path';

export function phaseFromPrompt(prompt = '') {
  const phase = /prompts\/live-(0\d)-[\w-]+\.md/.exec(prompt)?.[1] ?? null;
  const artifact = /to write (work\/[\w./-]+\.json)/.exec(prompt)?.[1] ?? null;
  return { phase, artifact };
}

function readJson(cwd, file) {
  try { return JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8')); } catch { return null; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function reportHtml(inventory, { omitVisualIds = [] } = {}) {
  const pages = inventory.pages.map(page => {
    const visuals = page.visuals.filter(visual => visual.role !== 'group' && !omitVisualIds.includes(visual.id)).map(visual =>
      `<article data-visual-id="${escapeHtml(visual.id)}" data-role="${visual.role}"><h3>${escapeHtml(visual.title ?? visual.type)}</h3><div class="body"></div></article>`).join('\n');
    return `<section data-page-id="${escapeHtml(page.id)}"><h2>${escapeHtml(page.name)}</h2>\n${visuals}\n</section>`;
  }).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Test reconstruction</title></head><body>
<div id="report-status">AI reconstruction produced by the test model. Compare with Power BI before relying on it.</div>
${pages}
<script>
for (const element of document.querySelectorAll('[data-role="data"]')) {
  fetch('/api/report?visual=' + encodeURIComponent(element.dataset.visualId) + '&filters=' + encodeURIComponent('{}'))
    .then(response => response.json())
    .then(result => { element.querySelector('.body').textContent = result.error || (result.rows.length + ' row(s)'); });
}
</script></body></html>
`;
}

// The rows the fake Power BI runner (fake-pbi-runner.mjs) returns for a visual, so
// "parity" backends can match (or deliberately miss) Power BI.
export function parityRows(groupRefs, valueRefs, scale = 1) {
  const count = groupRefs.length ? 2 : 1;
  return Array.from({ length: count }, (_, i) => ({
    ...Object.fromEntries(groupRefs.map(ref => [ref, `${ref} ${i}`])),
    ...Object.fromEntries(valueRefs.map((ref, j) => [ref, (100 + j * 10 + i) * scale]))
  }));
}

// Grouping and value fields of each data visual, split the way dax-query.mjs splits them.
export function visualFieldSpecs(digest) {
  const specs = {};
  for (const page of digest?.pages ?? []) for (const visual of page.visuals ?? []) {
    if (visual.role !== 'data') continue;
    const groupRefs = [], valueRefs = [], seen = new Set();
    for (const projections of Object.values(visual.fields ?? {})) {
      const active = projections.some(item => 'active' in item) ? projections.filter(item => item.active !== false) : projections;
      for (const field of active) {
        if (!field.queryRef || seen.has(field.queryRef)) continue;
        seen.add(field.queryRef);
        if (field.kind === 'column' || field.kind === 'hierarchyLevel') groupRefs.push(field.queryRef);
        else if (field.kind === 'measure' || field.kind === 'aggregation') valueRefs.push(field.queryRef);
      }
    }
    specs[visual.id] = { groupRefs, valueRefs };
  }
  return specs;
}

export function backendSource(inventory, digest, { broken = false, environmentIssue = false, leakTimer = false, placeholder = false, blockingQuery = false, parity = null, parityFixed = null } = {}) {
  const csv = (digest?.sources?.directCsv ?? []).map(source => source.path);
  // The first Excel sheet/table the report navigates to (headers promoted, as Power BI's generated M does).
  const excel = (digest?.sources?.files ?? []).filter(source => source.reader === 'Excel.Workbook' && source.kind === 'file').flatMap(source => (source.excel?.items ?? []).filter(item => item.item).map(item => ({ path: source.path, item: item.item, kind: item.kind ?? 'Sheet', useHeaders: true })))[0] ?? null;
  const dataVisuals = inventory.pages.flatMap(page => page.visuals.filter(visual => visual.role === 'data').map(visual => visual.id));
  return `import fs from 'node:fs';
import { tableRows } from './rows.mjs';
const CSV_FILES = ${JSON.stringify(csv)};
const PARITY = ${JSON.stringify(parity ? { specs: visualFieldSpecs(digest), scale: parity === 'wrong' ? 100 : 1 } : null)};
const PARITY_FIXED = ${JSON.stringify(parityFixed ?? {})};
${parity ? `const parityRows = ${parityRows.toString()};` : ''}
const EXCEL = ${JSON.stringify(excel)};
const DATA_VISUALS = new Set(${JSON.stringify(dataVisuals)});
export async function createBackend({ env, helpers }) {
  ${broken ? 'const broken = ;' : ''}
  ${leakTimer ? 'setInterval(() => {}, 1000);' : ''}
  const connections = helpers.postgres.connections;
  const sources = connections.length ? helpers.sources.listLiveSources({ postgresSources: connections }, env) : [];
  const pool = connections.length ? helpers.postgres.createPool(connections[0]) : null;
  return {
    async healthcheck() {
      ${environmentIssue ? "return { ok: false, issues: ['PG_PASSWORD is empty in .env (test scenario).'] };" : ''}
      const issues = [...CSV_FILES, ...(EXCEL ? [EXCEL.path] : [])].filter(file => !fs.existsSync(file)).map(file => 'Cannot read ' + file);
      if (pool) {
        try { await pool.query('SELECT 1'); }
        catch (error) { issues.push('PostgreSQL ' + connections[0].server + ': ' + error.message); }
      }
      return issues.length ? { ok: false, issues } : { ok: true, sources: [...CSV_FILES, ...connections.map(item => item.server + '/' + item.database)] };
    },
    async query({ visualId, limit = 2000 }) {
      if (!DATA_VISUALS.has(visualId)) throw new Error('Unknown visual ' + visualId);
      if (PARITY_FIXED[visualId]) return { rows: PARITY_FIXED[visualId], columns: Object.keys(PARITY_FIXED[visualId][0] ?? {}), placeholder: false, limitations: [] };
      if (PARITY && PARITY.specs[visualId]) {
        const spec = PARITY.specs[visualId];
        const rows = parityRows(spec.groupRefs, spec.valueRefs, PARITY.scale);
        return { rows, columns: [...spec.groupRefs, ...spec.valueRefs], placeholder: false, limitations: [] };
      }
      ${blockingQuery ? "if (visualId === [...DATA_VISUALS].at(-1)) { for (;;) {} }" : ''}
      ${placeholder ? "if (visualId === [...DATA_VISUALS][0]) return { rows: [], columns: [], placeholder: true, limitations: ['Custom visual runtime is not available (test scenario).'] };" : ''}
      if (sources.length) {
        const source = sources[0];
        const request = source.type === 'table' ? helpers.sources.postgresQuery(source.table.schema, source.table.item, limit) : helpers.sources.postgresNativeQuery(source.query.sql, limit, source.parameters);
        const result = await pool.query(request);
        return { rows: result.rows.slice(0, limit), columns: result.fields.map(field => field.name), placeholder: false, limitations: ['Test model output.'] };
      }
      if (!CSV_FILES.length && EXCEL) {
        const table = helpers.excel.read(EXCEL.path, { item: EXCEL.item, kind: EXCEL.kind, useHeaders: EXCEL.useHeaders });
        return { ...tableRows(table, limit), placeholder: false, limitations: ['Test model output.'] };
      }
      if (!CSV_FILES.length) return { rows: [], columns: [], placeholder: true, limitations: ['No CSV source in this fixture.'] };
      return { ...tableRows(helpers.core.readCsvFile(CSV_FILES[0]), limit), placeholder: false, limitations: ['Test model output.'] };
    },
    async close() { await pool?.end(); }
  };
}
`;
}

// A module of the model's own next to backend.mjs; it must travel with the report.
export const rowsModule = `export function tableRows(parsed, limit) {
  return { rows: parsed.rows.slice(0, limit), columns: parsed.columns };
}
`;

// scenario: comma-separated switches, e.g. "broken-backend,review-blocked".
// counts: how many times each phase ran before this call (0 on the first call).
export function phaseFiles({ prompt, cwd, scenario = '', count = 0 }) {
  const { phase, artifact } = phaseFromPrompt(prompt);
  const switches = new Set(scenario.split(',').map(value => value.trim()).filter(Boolean));
  const inventory = readJson(cwd, 'work/inventory.json');
  const digest = readJson(cwd, 'work/report-digest.json');
  if (!phase || !artifact || !inventory) return { files: [], text: `The test model did not recognise this request.` };
  const files = [];
  const add = (file, content) => files.push({ path: file, content: typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n' });
  const firstRun = count === 0;
  if (switches.has(`omit-${phase}`) && firstRun) return { files: [], text: 'I have analysed the files.' };
  const dataVisuals = inventory.pages.flatMap(page => page.visuals.filter(visual => visual.role === 'data'));
  const lastData = dataVisuals.at(-1);
  switch (phase) {
    case '01':
      add(artifact, { pages: inventory.pages.map(page => ({ id: page.id, name: page.name })), visuals: dataVisuals.map(visual => ({ id: visual.id, source: visual.source })), sources: digest?.sources ?? {}, transformations: [], measures: [], relationships: [], filters: [], interactions: [], sourcePaths: [], unsupported: [], verificationNeeded: ['Test model'] });
      break;
    case '02':
      add('output/dynamic/index.html', reportHtml(inventory, { omitVisualIds: switches.has('missing-visual') && lastData ? [lastData.id] : [] }));
      add('output/dynamic/backend.mjs', backendSource(inventory, digest, { broken: switches.has('broken-backend'), environmentIssue: switches.has('environment-issue'), leakTimer: switches.has('leak-timer'), placeholder: switches.has('placeholder'), blockingQuery: switches.has('blocking-query'), parity: switches.has('parity-wrong') || switches.has('parity-unfixable') ? 'wrong' : switches.has('parity-keys') ? 'keys' : null }));
      add('output/dynamic/rows.mjs', rowsModule);
      add(artifact, { implemented: dataVisuals.map(visual => visual.id), placeholders: [], limitations: [], sourcePaths: [], credentialsNeeded: [], filtersContract: {} });
      break;
    case '03':
    case '05': {
      const blocked = switches.has('review-blocked') && phase === '03';
      add(artifact, { status: blocked ? 'blocked' : 'warnings', findings: blocked ? [{ severity: 'high', file: 'output/dynamic/backend.mjs', description: 'Test finding', fix: 'Test fix' }] : [], limitations: ['Test limitation'], unverified: ['Power BI parity'], pageCoverage: {}, visualCoverage: {}, sourceCoverage: {} });
      break;
    }
    case '04': {
      const current = readJson(cwd, 'work/current-page.json');
      add('output/dynamic/index.html', reportHtml(inventory));
      add('output/dynamic/backend.mjs', fs.readFileSync(path.join(cwd, 'output/dynamic/backend.mjs'), 'utf8'));
      add(artifact, { status: 'complete', pageId: current?.id, implementedVisualIds: (current?.missingVisuals ?? []).map(visual => visual.id), remainingVisualIds: [], limitations: [], sourcePaths: [] });
      break;
    }
    case '06': {
      // A parity fix request carries Power BI's rows; a well-behaved model makes the backend return them.
      const request = readJson(cwd, 'work/fix-request.json');
      const fixed = request?.parity ? Object.fromEntries(request.parity.visuals.map(visual => [visual.visualId, visual.powerBiRows])) : null;
      add('output/dynamic/index.html', reportHtml(inventory));
      add('output/dynamic/backend.mjs', backendSource(inventory, digest, { placeholder: switches.has('placeholder'), parity: switches.has('parity-unfixable') ? 'wrong' : switches.has('parity-wrong') || switches.has('parity-keys') ? 'keys' : null, parityFixed: switches.has('parity-unfixable') ? null : fixed }));
      add(artifact, { status: 'fixed', fixed: ['test fix'], remaining: [], changedFiles: ['output/dynamic/backend.mjs'] });
      break;
    }
    default:
      return { files: [], text: 'Unknown phase.' };
  }
  return { files, text: `Phase ${phase} written.` };
}
