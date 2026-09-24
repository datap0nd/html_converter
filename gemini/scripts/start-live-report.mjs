import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { root, inputDir, workDir, dynamicDir, discover, writeJson, readJson } from './core.mjs';
import { loadLocalEnv } from './env.mjs';
import { runGeminiAsync } from './gemini.mjs';
import { inputFingerprint, captureArtifacts, artifactsMatch, saveCheckpoint } from './checkpoints.mjs';

const phases = [
  ['01-interpret', 'prompts/live-01-interpret.md', 'work/live-interpretation.json'],
  ['02-build', 'prompts/live-02-build.md', 'work/live-build.json'],
  ['03-review', 'prompts/live-03-review.md', 'work/live-review.json']
];

const canonicalPhaseArtifacts = {
  '01-interpret': ['work/live-interpretation.json'],
  '02-build': ['work/live-build.json', 'output/dynamic/index.html', 'output/dynamic/backend.mjs'],
  '03-review': ['work/live-review.json'],
  '05-final-review': ['work/live-final-review.json']
};

export function createRunScope(pageLimit = null) {
  if (pageLimit !== null && (!Number.isInteger(pageLimit) || pageLimit < 1)) throw new Error('Page limit must be a positive integer.');
  const key = pageLimit ? `first-${pageLimit}-pages` : 'all-pages';
  return {
    key,
    pageLimit,
    workDir: pageLimit ? path.join(workDir, 'scopes', key) : workDir,
    dynamicDir: pageLimit ? path.join(root, 'output', key, 'dynamic') : dynamicDir
  };
}

export function pageLimitFromArgs(args) {
  const index = args.indexOf('--page-limit');
  if (index < 0) return null;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1) throw new Error('--page-limit requires a positive integer.');
  return value;
}

function persistedPath(scope, canonical) {
  if (canonical.startsWith('work/')) return path.join(scope.workDir, canonical.slice('work/'.length));
  if (canonical.startsWith('output/dynamic/')) return path.join(scope.dynamicDir, canonical.slice('output/dynamic/'.length));
  throw new Error(`Unsupported scoped artifact path: ${canonical}`);
}

function phaseArtifacts(scope, name) {
  return canonicalPhaseArtifacts[name].map(canonical => path.relative(root, persistedPath(scope, canonical)).replaceAll('\\', '/'));
}

function reportCoverage(inventory, markup) {
  return inventory.pages.map(page => ({
    ...page,
    missingPage: !markup.includes(`data-page-id="${page.id}"`),
    missingVisuals: page.visuals.filter(visual => !markup.includes(`data-visual-id="${visual.id}"`))
  }));
}

function createGeminiWorkspace(inventory, scope) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-gemini-'));
  for (const folder of ['input', 'work', 'prompts', 'skills', 'scripts', 'output/dynamic']) fs.mkdirSync(path.join(stage, folder), { recursive: true });
  for (const name of ['GEMINI.md']) fs.copyFileSync(path.join(root, name), path.join(stage, name));
  for (const folder of ['prompts', 'skills']) fs.cpSync(path.join(root, folder), path.join(stage, folder), { recursive: true });
  for (const name of ['core.mjs', 'sources.mjs']) fs.copyFileSync(path.join(root, 'scripts', name), path.join(stage, 'scripts', name));
  fs.cpSync(inputDir, path.join(stage, 'input'), {
    recursive: true,
    filter: source => {
      const rel = path.relative(inputDir, source).replaceAll('\\', '/');
      if (!rel) return true;
      if (fs.lstatSync(source).isSymbolicLink()) return false;
      if (/^data(?:\/|$)/i.test(rel)) return false;
      return fs.statSync(source).isDirectory() || /\.(?:pbip|pbir|tmdl|m|pq|bim|json)$/i.test(rel);
    }
  });
  writeJson(path.join(stage, 'work', 'inventory.json'), inventory);
  fs.copyFileSync(path.join(scope.workDir, 'live-run.json'), path.join(stage, 'work', 'live-run.json'));
  for (const rel of ['work/live-interpretation.json', 'work/live-build.json', 'work/live-review.json', 'work/live-final-review.json', 'output/dynamic/index.html', 'output/dynamic/backend.mjs']) {
    const source = persistedPath(scope, rel);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(stage, rel));
  }
  return stage;
}

function removeGeminiWorkspace(stage) {
  const resolved = path.resolve(stage);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-gemini-')) throw new Error('Unsafe Gemini workspace cleanup path.');
  fs.rmSync(resolved, { recursive: true, force: true });
}

export function geminiFailureDetail(result, env = {}) {
  let parsed;
  try { parsed = JSON.parse(result.stdout ?? ''); } catch {}
  const message = parsed?.error?.message || parsed?.error?.details || result.stderr?.trim() || result.stdout?.trim() || result.error?.message || 'No diagnostic text from Gemini CLI.';
  let detail = typeof message === 'string' ? message : JSON.stringify(message);
  for (const [key, value] of Object.entries(env)) {
    if (/(PASSWORD|SECRET|TOKEN|API_KEY|CONNECTION_STRING)/i.test(key) && typeof value === 'string' && value.length > 3) detail = detail.replaceAll(value, '[redacted]');
  }
  return detail.length > 1800 ? `${detail.slice(0, 900)}\n... [truncated] ...\n${detail.slice(-900)}` : detail;
}

function geminiFailureText(result) {
  return [result?.status, result?.error?.message, result?.stderr, result?.stdout].filter(value => value !== undefined && value !== null).join('\n');
}

export function isTransientGeminiFailure(result) {
  const detail = geminiFailureText(result);
  return Number(result?.status) === 429 || /\b429\b|RESOURCE_EXHAUSTED|MODEL_CAPACITY_EXHAUSTED|rate[ -]?limit|too many requests|high demand|no capacity available/i.test(detail);
}

export function geminiRetryDelayMs(result, failedAttempt) {
  const match = geminiFailureText(result).match(/retry(?:delay|[-_ ]after|\s+in)?[^0-9]{0,40}(\d+(?:\.\d+)?)\s*s/i);
  const requested = match ? Number(match[1]) * 1000 : 30_000 * (2 ** Math.max(0, failedAttempt - 1));
  return Math.min(300_000, Math.max(5_000, requested));
}

export function geminiResponseArtifact(stdout) {
  let envelope;
  try { envelope = JSON.parse(stdout ?? ''); } catch { return null; }
  const response = envelope?.response;
  if (response && typeof response === 'object' && !Array.isArray(response)) return response;
  if (typeof response !== 'string') return null;
  const candidate = response.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function missingPhaseOutputs(name, expected, stage) {
  const missing = [];
  if (!readJson(expected)) missing.push(path.relative(stage, expected).replaceAll('\\', '/'));
  if (name === '02-build' || name.startsWith('04-page-')) {
    for (const file of ['index.html', 'backend.mjs']) if (!fs.existsSync(path.join(stage, 'output', 'dynamic', file))) missing.push(`output/dynamic/${file}`);
  }
  return missing;
}

export function validateLiveReport(inventory, markup, review, env = {}) {
  const issues = [];
  if (!/<html\b/i.test(markup) || !/<script\b/i.test(markup)) issues.push('Generated HTML is not an interactive report.');
  if (!markup.includes('/api/report')) issues.push('Generated HTML does not call its live backend.');
  if (!markup.includes('id="report-status"')) issues.push('Generated HTML lacks a visible report status.');
  if (/Visual mapping pending|Visual reconstruction pending review|Live source data<\/h2>/i.test(markup)) issues.push('Generated HTML is still a source preview.');
  if (/<(?:script|link|img)\b[^>]+(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(markup)) issues.push('Generated HTML loads external assets.');
  for (const page of inventory.pages) {
    if (!markup.includes(`data-page-id="${page.id}"`)) issues.push(`Missing page ${page.id}.`);
    for (const visual of page.visuals) if (!markup.includes(`data-visual-id="${visual.id}"`)) issues.push(`Missing visual ${visual.id}.`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (/(PASSWORD|SECRET|TOKEN|API_KEY|CONNECTION_STRING)/i.test(key) && typeof value === 'string' && value.length > 4 && markup.includes(value)) issues.push(`Generated HTML contains ${key}.`);
  }
  if (!review || !['pass', 'warnings'].includes(review.status)) issues.push('Independent Gemini review did not approve the output.');
  if (!Array.isArray(review?.limitations) || !Array.isArray(review?.unverified)) issues.push('Review must list limitations and unverified behavior.');
  return issues;
}

async function runPhase([name, promptFile, expectedFile], model, runDir, stage, env, scope) {
  const expected = path.join(stage, expectedFile);
  console.log(`[${name}] Gemini ${model} starting...`);
  const prompt = `Read ${promptFile}, work/live-run.json, work/inventory.json, and the relevant PBIP files. Follow the phase instructions exactly. Do not read .env or run shell commands. You MUST use the file-editing capability to write ${expectedFile}; do not merely print its contents in your response.`;
  const maxAttempts = 5;
  let result;
  let missing = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (fs.existsSync(expected)) fs.unlinkSync(expected);
    if (name === '02-build') {
      for (const file of ['index.html', 'backend.mjs']) {
        const staged = path.join(stage, 'output', 'dynamic', file);
        if (fs.existsSync(staged)) fs.unlinkSync(staged);
      }
    } else if (name.startsWith('04-page-')) {
      for (const file of ['index.html', 'backend.mjs']) fs.copyFileSync(path.join(scope.dynamicDir, file), path.join(stage, 'output', 'dynamic', file));
    }
    if (attempt > 1) console.log(`[${name}] Gemini retry ${attempt} of ${maxAttempts}...`);
    const repairInstruction = attempt > 1 && missing.length ? ` Previous attempt ${attempt - 1} exited without producing these required files: ${missing.join(', ')}. Complete the phase and write every required file now.` : '';
    result = await runGeminiAsync(['--model', model, '--skip-trust', '-e', 'none', '--approval-mode', 'auto_edit', '--output-format', 'json', '-p', prompt + repairInstruction], {
      cwd: stage, onHeartbeat: message => console.log(`[${name}] ${message}`)
    });
    const suffix = attempt === 1 ? '' : `.attempt-${attempt}`;
    fs.writeFileSync(path.join(runDir, `${name}${suffix}.stdout.json`), result.stdout ?? '');
    fs.writeFileSync(path.join(runDir, `${name}${suffix}.stderr.log`), result.stderr ?? '');
    if (!result.error && result.status === 0) {
      if (!readJson(expected)) {
        const recovered = geminiResponseArtifact(result.stdout);
        if (recovered) writeJson(expected, recovered);
      }
      missing = missingPhaseOutputs(name, expected, stage);
      if (!missing.length) break;
      if (attempt < maxAttempts) {
        console.log(`[${name}] Gemini exited successfully but omitted ${missing.join(', ')}. Retrying the incomplete phase without checkpointing it.`);
        continue;
      }
      break;
    }
    if (!isTransientGeminiFailure(result) || attempt === maxAttempts) break;
    const delayMs = geminiRetryDelayMs(result, attempt);
    console.log(`[${name}] Gemini returned a transient 429/capacity error. Retrying in ${Math.round(delayMs / 1000)} seconds; saved converter checkpoints are unchanged.`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  if (result.error || result.status !== 0) throw new Error(`${name}: Gemini failed${isTransientGeminiFailure(result) ? ' after rate-limit retries' : ''} (${result.error?.message ?? `exit ${result.status}`}). ${geminiFailureDetail(result, env)} Full logs: ${path.relative(root, runDir)}/${name}*.stderr.log and .stdout.json.`);
  missing = missingPhaseOutputs(name, expected, stage);
  if (missing.length) throw new Error(`${name}: Gemini completed ${maxAttempts} attempts without producing ${missing.join(', ')}. Progress before this phase is saved. See ${path.relative(root, runDir)}.`);
  const persistedExpected = persistedPath(scope, expectedFile);
  fs.mkdirSync(path.dirname(persistedExpected), { recursive: true });
  fs.copyFileSync(expected, persistedExpected);
  if (name === '02-build' || name.startsWith('04-page-')) {
    for (const file of ['index.html', 'backend.mjs']) {
      if (!fs.existsSync(path.join(stage, 'output', 'dynamic', file))) throw new Error(`${name} did not produce output/dynamic/${file}.`);
    }
    for (const file of ['index.html', 'backend.mjs']) {
      const source = path.join(stage, 'output', 'dynamic', file);
      fs.copyFileSync(source, path.join(scope.dynamicDir, file));
    }
  }
  console.log(`[${name}] Complete.`);
}

async function loadBackend(file, env) {
  if (!fs.existsSync(file)) throw new Error('Gemini did not produce output/dynamic/backend.mjs.');
  const module = await import(`${pathToFileURL(file).href}?run=${Date.now()}`);
  if (typeof module.createBackend !== 'function') throw new Error('Generated backend must export createBackend({env, root, inputDir}).');
  const backend = await module.createBackend({ env, root, inputDir });
  if (!backend || typeof backend.query !== 'function' || typeof backend.healthcheck !== 'function') throw new Error('Generated backend must provide query() and healthcheck().');
  return backend;
}

async function checkBackend(backend, inventory) {
  const health = await backend.healthcheck();
  if (!health || health.ok !== true) throw new Error(`Source healthcheck failed: ${JSON.stringify(health?.issues ?? 'no detail')}`);
  const checked = [];
  for (const page of inventory.pages) for (const visual of page.visuals) {
    const result = await backend.query({ visualId: visual.id, filters: {}, limit: 200 });
    if (!result || !Array.isArray(result.rows)) throw new Error(`Visual ${visual.id} did not return a rows array.`);
    if (result.placeholder === true) throw new Error(`Visual ${visual.id} is still a placeholder: ${(result.limitations ?? []).join('; ')}`);
    checked.push({ visualId: visual.id, rowCount: result.rows.length, placeholder: result.placeholder === true });
  }
  return { ok: true, sources: health.sources ?? [], visuals: checked };
}

function startServer(htmlFile, backend, inventory) {
  const visualIds = new Set(inventory.pages.flatMap(page => page.visuals.map(visual => visual.id)));
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1:8765');
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (req.method !== 'GET' || (req.headers.origin && req.headers.origin !== 'http://127.0.0.1:8765')) { res.writeHead(403, headers); res.end(); return; }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlFile).pipe(res);
      return;
    }
    if (url.pathname === '/api/report') {
      try {
        const visualId = url.searchParams.get('visual');
        if (!visualIds.has(visualId)) throw new Error('Unknown visual ID.');
        const filters = JSON.parse(url.searchParams.get('filters') ?? '{}');
        if (!filters || Array.isArray(filters) || typeof filters !== 'object') throw new Error('Filters must be an object.');
        const result = await backend.query({ visualId, filters, limit: 2000 });
        if (!result || !Array.isArray(result.rows)) throw new Error('Backend returned invalid data.');
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
      } catch (error) {
        res.writeHead(400, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    res.writeHead(404, headers); res.end('Not found');
  });
  server.listen(8765, '127.0.0.1', () => {
    console.log('Gemini-built live HTML report: http://127.0.0.1:8765/');
    console.log(`Generated file: ${htmlFile}`);
    console.log('Credentials remain in the local backend. Ctrl+C stops the server.');
  });
  server.on('error', error => { console.error(`Live server failed: ${error.message}`); process.exitCode = 1; });
  return server;
}

function summarizeValidation(issues) {
  const pages = issues.filter(issue => issue.startsWith('Missing page ')).length;
  const visuals = issues.filter(issue => issue.startsWith('Missing visual ')).length;
  const other = issues.filter(issue => !issue.startsWith('Missing page ') && !issue.startsWith('Missing visual '));
  return [`${pages} missing page(s), ${visuals} missing visual(s)`, ...other.slice(0, 3)].join('; ');
}

function recordPhase(state, name, paths, stateFile) {
  const artifacts = captureArtifacts(root, paths);
  if (!artifacts) throw new Error(`${name} completed but one or more required artifacts are missing.`);
  state.phases[name] = { completedAt: new Date().toISOString(), artifacts };
  saveCheckpoint(stateFile, state);
}

function priorInventoryMatches(previous, current) {
  return previous?.project === current.project && JSON.stringify(previous) === JSON.stringify(current);
}

function adoptPriorRun(state, inventory, previousInventory, scope) {
  if (scope.pageLimit || !priorInventoryMatches(previousInventory, inventory) || !readJson(path.join(scope.workDir, 'live-validation.json'))) return false;
  let adopted = false;
  for (const name of Object.keys(canonicalPhaseArtifacts)) {
    const artifacts = captureArtifacts(root, phaseArtifacts(scope, name));
    if (artifacts) { state.phases[name] = { completedAt: null, artifacts, adopted: true }; adopted = true; }
  }
  return adopted;
}

export async function runLiveReport({ preflightOnly = false, invokeGemini = true, pageLimit = null } = {}) {
  process.chdir(root);
  const env = loadLocalEnv();
  const discovered = discover();
  const scope = createRunScope(pageLimit);
  const inventory = pageLimit ? { ...discovered, pages: discovered.pages.slice(0, pageLimit), pageScope: { mode: scope.key, selectedPages: Math.min(pageLimit, discovered.pages.length), totalPages: discovered.pages.length } } : { ...discovered, pageScope: { mode: scope.key, selectedPages: discovered.pages.length, totalPages: discovered.pages.length } };
  if (!inventory.pages.length || !inventory.pages.some(page => page.visuals.length)) throw new Error('No enhanced PBIR pages/visuals found; cannot verify a generated report against this PBIP format.');
  if (inventory.reportModelReferences.some(x => x.kind === 'remote-connection')) throw new Error('PBIR references a remote semantic model. This no-Fabric workflow requires a local model definition.');
  fs.mkdirSync(scope.workDir, { recursive: true });
  const previousInventory = readJson(path.join(scope.workDir, 'inventory.json'));
  writeJson(path.join(scope.workDir, 'inventory.json'), inventory);
  console.log(`Scope: ${pageLimit ? `first ${inventory.pages.length} of ${discovered.pages.length} page(s)` : `all ${inventory.pages.length} page(s)`}. Found ${inventory.pages.reduce((n, p) => n + p.visuals.length, 0)} selected visual(s), ${inventory.postgresSources.length} PostgreSQL source(s), ${inventory.directCsvSources.length} direct CSV source(s), and ${inventory.unsupportedConnectors.length} other connector reference(s).`);
  if (preflightOnly) { console.log('PBIP scan passed. No Gemini call or source access made.'); return { inventory }; }
  const stateFile = path.join(scope.workDir, 'live-state.json');
  const fingerprint = inputFingerprint(inputDir);
  let state = readJson(stateFile);
  const hadState = state !== null;
  const fresh = process.argv.includes('--fresh');
  if (fresh || state?.version !== 1 || state?.inputFingerprint !== fingerprint) {
    state = { version: 1, project: inventory.project, scope: scope.key, inputFingerprint: fingerprint, createdAt: new Date().toISOString(), phases: {}, repairs: {} };
    if (!fresh && !hadState && adoptPriorRun(state, inventory, previousInventory, scope)) console.log('Adopted completed artifacts from the previous converter run.');
    saveCheckpoint(stateFile, state);
  } else console.log('Resuming saved converter progress for the unchanged PBIP.');
  const runDir = fs.mkdtempSync(path.join(scope.workDir, 'live-run-'));
  const model = 'gemini-3.8-flash';
  writeJson(path.join(scope.workDir, 'live-run.json'), { project: inventory.project, scope: scope.key, startedAt: new Date().toISOString(), model, runLog: path.relative(root, runDir).replaceAll('\\', '/') });
  const htmlFile = path.join(scope.dynamicDir, 'index.html');
  const backendFile = path.join(scope.dynamicDir, 'backend.mjs');
  fs.mkdirSync(scope.dynamicDir, { recursive: true });
  if (invokeGemini) {
    const stage = createGeminiWorkspace(inventory, scope);
    try {
      let upstreamChanged = false;
      for (const phase of phases) {
        const [name] = phase;
        const valid = !upstreamChanged && artifactsMatch(root, state.phases[name]?.artifacts);
        if (valid) { console.log(`[${name}] Reusing completed artifact.`); continue; }
        if (name === '02-build') {
          for (const [file, backup] of [[htmlFile, 'previous-index.html'], [backendFile, 'previous-backend.mjs']]) {
            if (fs.existsSync(file)) fs.copyFileSync(file, path.join(runDir, backup));
            const staged = path.join(stage, 'output', 'dynamic', path.basename(file));
            if (fs.existsSync(staged)) fs.unlinkSync(staged);
          }
          state.repairs = {};
        }
        await runPhase(phase, model, runDir, stage, env, scope);
        recordPhase(state, name, phaseArtifacts(scope, name), stateFile);
        upstreamChanged = true;
        if (name !== '03-review') delete state.phases['05-final-review'];
      }
      let review = readJson(path.join(scope.workDir, 'live-review.json'));
      let markup = fs.readFileSync(htmlFile, 'utf8');
      let issues = validateLiveReport(inventory, markup, review, env);
      writeJson(path.join(scope.workDir, 'live-validation.json'), { passed: issues.length === 0, issues, reviewStatus: review?.status });
      const incomplete = reportCoverage(inventory, markup).filter(page => page.missingPage || page.missingVisuals.length);
      if (incomplete.length) {
        console.log(`Coverage incomplete: ${incomplete.length} page(s) need focused repair. Completed phases will not restart.`);
        for (const page of incomplete) {
          const safePageId = /^[A-Za-z0-9_-]+$/.test(page.id) ? page.id : createHash('sha256').update(page.id).digest('hex').slice(0, 16);
          let batchIndex = 0;
          for (;;) {
            markup = fs.readFileSync(htmlFile, 'utf8');
            const current = reportCoverage({ pages: [page] }, markup)[0];
            if (!current.missingPage && !current.missingVisuals.length) break;
            const batch = current.missingVisuals.slice(0, 8);
            const currentPage = { id: page.id, name: page.name, source: page.source, missingPage: current.missingPage, missingVisuals: batch, remainingVisualCount: current.missingVisuals.length - batch.length, allVisuals: page.visuals };
            writeJson(path.join(stage, 'work', 'current-page.json'), currentPage);
            const name = `04-page-${safePageId}-${batchIndex++}`;
            const artifact = `work/page-repair-${safePageId}-${batchIndex}.json`;
            console.log(`[${name}] Repairing ${batch.length} visual(s) on ${page.name}; ${currentPage.remainingVisualCount} queued.`);
            await runPhase([name, 'prompts/live-04-page-repair.md', artifact], model, runDir, stage, env, scope);
            const persistedArtifact = persistedPath(scope, artifact);
            const repair = readJson(persistedArtifact);
            recordPhase(state, '02-build', phaseArtifacts(scope, '02-build'), stateFile);
            delete state.phases['05-final-review'];
            saveCheckpoint(stateFile, state);
            const after = reportCoverage({ pages: [page] }, fs.readFileSync(htmlFile, 'utf8'))[0];
            const stillMissing = new Set(after.missingVisuals.map(visual => visual.id));
            if (repair?.status !== 'complete' || after.missingPage || batch.some(visual => stillMissing.has(visual.id))) {
              throw new Error(`${name} remains incomplete. Progress is saved; the next setup run resumes this page. See ${artifact}.`);
            }
            state.repairs[page.id] = { completedAt: new Date().toISOString(), artifact: path.relative(root, persistedArtifact).replaceAll('\\', '/'), remainingVisualCount: after.missingVisuals.length };
            saveCheckpoint(stateFile, state);
          }
        }
      }
      if (Object.keys(state.repairs).length && !artifactsMatch(root, state.phases['05-final-review']?.artifacts)) {
        const finalPhase = ['05-final-review', 'prompts/live-05-final-review.md', 'work/live-final-review.json'];
        await runPhase(finalPhase, model, runDir, stage, env, scope);
        recordPhase(state, '05-final-review', phaseArtifacts(scope, '05-final-review'), stateFile);
      }
    } finally { removeGeminiWorkspace(stage); }
  }
  const finalReviewValid = artifactsMatch(root, state.phases['05-final-review']?.artifacts);
  const review = finalReviewValid ? readJson(path.join(scope.workDir, 'live-final-review.json')) : readJson(path.join(scope.workDir, 'live-review.json'));
  const issues = validateLiveReport(inventory, fs.readFileSync(htmlFile, 'utf8'), review, env);
  writeJson(path.join(scope.workDir, 'live-validation.json'), { passed: issues.length === 0, issues, reviewStatus: review?.status });
  if (issues.length) throw new Error(`Generated report failed validation: ${summarizeValidation(issues)}. Progress is saved. See ${path.relative(root, path.join(scope.workDir, 'live-validation.json'))} and ${path.relative(root, runDir)}.`);
  const backend = await loadBackend(backendFile, env);
  let preflight;
  try { preflight = await checkBackend(backend, inventory); }
  catch (error) {
    writeJson(path.join(scope.workDir, 'live-preflight.json'), { ok: false, issues: [error.message] });
    throw error;
  }
  writeJson(path.join(scope.workDir, 'live-preflight.json'), preflight);
  console.log(`Gemini review: ${review.status}. ${review.limitations.length} limitation(s), ${review.unverified.length} unverified behavior(s). See ${path.relative(root, path.join(scope.workDir, finalReviewValid ? 'live-final-review.json' : 'live-review.json'))}.`);
  return { inventory, review, server: startServer(htmlFile, backend, inventory) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  Promise.resolve().then(() => runLiveReport({ preflightOnly: process.argv.includes('--preflight'), pageLimit: pageLimitFromArgs(process.argv.slice(2)) })).catch(error => {
    console.error(`Report conversion stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
