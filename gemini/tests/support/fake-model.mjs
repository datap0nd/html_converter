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

export function backendSource(inventory, digest, { broken = false, environmentIssue = false } = {}) {
  const csv = (digest?.sources?.directCsv ?? []).map(source => source.path);
  const dataVisuals = inventory.pages.flatMap(page => page.visuals.filter(visual => visual.role === 'data').map(visual => visual.id));
  return `import fs from 'node:fs';
const CSV_FILES = ${JSON.stringify(csv)};
const DATA_VISUALS = new Set(${JSON.stringify(dataVisuals)});
export async function createBackend({ env, helpers }) {
  ${broken ? 'const broken = ;' : ''}
  return {
    async healthcheck() {
      ${environmentIssue ? "return { ok: false, issues: ['PG_PASSWORD is empty in .env (test scenario).'] };" : ''}
      const issues = CSV_FILES.filter(file => !fs.existsSync(file)).map(file => 'Cannot read ' + file);
      return issues.length ? { ok: false, issues } : { ok: true, sources: CSV_FILES };
    },
    async query({ visualId, limit = 200 }) {
      if (!DATA_VISUALS.has(visualId)) throw new Error('Unknown visual ' + visualId);
      if (!CSV_FILES.length) return { rows: [], columns: [], placeholder: true, limitations: ['No CSV source in this fixture.'] };
      const parsed = helpers.core.parseCsv(fs.readFileSync(CSV_FILES[0], 'utf8').replace(/^\\uFEFF/, ''));
      return { rows: parsed.rows.slice(0, limit), columns: parsed.columns, placeholder: false, limitations: ['Test model output.'] };
    }
  };
}
`;
}

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
      add('output/dynamic/backend.mjs', backendSource(inventory, digest, { broken: switches.has('broken-backend'), environmentIssue: switches.has('environment-issue') }));
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
    case '06':
      add('output/dynamic/index.html', reportHtml(inventory));
      add('output/dynamic/backend.mjs', backendSource(inventory, digest));
      add(artifact, { status: 'fixed', fixed: ['test fix'], remaining: [], changedFiles: ['output/dynamic/backend.mjs'] });
      break;
    default:
      return { files: [], text: 'Unknown phase.' };
  }
  return { files, text: `Phase ${phase} written.` };
}
