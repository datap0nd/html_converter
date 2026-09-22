import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { root, inputDir, workDir, dynamicDir, discover, writeJson, readJson } from './core.mjs';
import { loadLocalEnv } from './env.mjs';
import { runGemini, runGeminiAsync } from './gemini.mjs';

const phases = [
  ['01-interpret', 'prompts/live-01-interpret.md', 'work/live-interpretation.json'],
  ['02-build', 'prompts/live-02-build.md', 'work/live-build.json'],
  ['03-review', 'prompts/live-03-review.md', 'work/live-review.json']
];

function createGeminiWorkspace(inventory) {
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
  fs.copyFileSync(path.join(workDir, 'live-run.json'), path.join(stage, 'work', 'live-run.json'));
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

async function runPhase([name, promptFile, expectedFile], model, runDir, stage, env) {
  const expected = path.join(stage, expectedFile);
  if (fs.existsSync(expected)) fs.unlinkSync(expected);
  console.log(`[${name}] Gemini ${model} starting...`);
  const prompt = `Read ${promptFile}, work/live-run.json, work/inventory.json, and the relevant PBIP files. Follow the phase instructions exactly. Do not read .env or run shell commands. Write ${expectedFile}.`;
  const result = await runGeminiAsync(['--model', model, '--skip-trust', '-e', 'none', '--approval-mode', 'auto_edit', '--output-format', 'json', '-p', prompt], {
    cwd: stage, onHeartbeat: message => console.log(`[${name}] ${message}`)
  });
  fs.writeFileSync(path.join(runDir, `${name}.stdout.json`), result.stdout ?? '');
  fs.writeFileSync(path.join(runDir, `${name}.stderr.log`), result.stderr ?? '');
  if (result.error || result.status !== 0) throw new Error(`${name}: Gemini failed (${result.error?.message ?? `exit ${result.status}`}). ${geminiFailureDetail(result, env)} Full logs: ${path.relative(root, runDir)}/${name}.stderr.log and .stdout.json.`);
  if (!fs.existsSync(expected) || !readJson(expected)) throw new Error(`${name}: expected valid JSON at ${expectedFile}. See run logs.`);
  fs.copyFileSync(expected, path.join(root, expectedFile));
  if (name === '02-build') {
    for (const file of ['index.html', 'backend.mjs']) {
      const source = path.join(stage, 'output', 'dynamic', file);
      if (!fs.existsSync(source)) throw new Error(`02-build did not produce output/dynamic/${file}.`);
      fs.copyFileSync(source, path.join(dynamicDir, file));
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

export async function runLiveReport({ preflightOnly = false, invokeGemini = true } = {}) {
  process.chdir(root);
  const env = loadLocalEnv();
  const inventory = discover();
  if (!inventory.pages.length || !inventory.pages.some(page => page.visuals.length)) throw new Error('No enhanced PBIR pages/visuals found; cannot verify a generated report against this PBIP format.');
  if (inventory.reportModelReferences.some(x => x.kind === 'remote-connection')) throw new Error('PBIR references a remote semantic model. This no-Fabric workflow requires a local model definition.');
  fs.mkdirSync(workDir, { recursive: true });
  writeJson(path.join(workDir, 'inventory.json'), inventory);
  console.log(`Found ${inventory.pages.length} page(s), ${inventory.pages.reduce((n, p) => n + p.visuals.length, 0)} visual(s), ${inventory.postgresSources.length} PostgreSQL source(s), ${inventory.directCsvSources.length} direct CSV source(s), and ${inventory.unsupportedConnectors.length} other connector reference(s).`);
  if (preflightOnly) { console.log('PBIP scan passed. No Gemini call or source access made.'); return { inventory }; }
  const runDir = fs.mkdtempSync(path.join(workDir, 'live-run-'));
  const model = env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash';
  writeJson(path.join(workDir, 'live-run.json'), { project: inventory.project, startedAt: new Date().toISOString(), model, runLog: path.relative(root, runDir).replaceAll('\\', '/') });
  const htmlFile = path.join(dynamicDir, 'index.html');
  const backendFile = path.join(dynamicDir, 'backend.mjs');
  fs.mkdirSync(dynamicDir, { recursive: true });
  for (const [file, name] of [[htmlFile, 'previous-index.html'], [backendFile, 'previous-backend.mjs']]) {
    if (fs.existsSync(file)) { fs.copyFileSync(file, path.join(runDir, name)); fs.unlinkSync(file); }
  }
  if (invokeGemini) {
    const version = runGemini(['--version'], { cwd: root, timeout: 15000 });
    if (version.error || version.status !== 0) throw new Error('Gemini CLI not found or not authenticated. Run gemini --version and sign in.');
    const stage = createGeminiWorkspace(inventory);
    try {
      await runPhase(phases[0], model, runDir, stage, env);
      await runPhase(phases[1], model, runDir, stage, env);
      await runPhase(phases[2], model, runDir, stage, env);
    } finally { removeGeminiWorkspace(stage); }
  }
  const review = readJson(path.join(workDir, 'live-review.json'));
  const issues = validateLiveReport(inventory, fs.readFileSync(htmlFile, 'utf8'), review, env);
  writeJson(path.join(workDir, 'live-validation.json'), { passed: issues.length === 0, issues, reviewStatus: review?.status });
  if (issues.length) throw new Error(`Generated report failed validation: ${issues.join(' ')} See work/live-validation.json and ${path.relative(root, runDir)}.`);
  const backend = await loadBackend(backendFile, env);
  let preflight;
  try { preflight = await checkBackend(backend, inventory); }
  catch (error) {
    writeJson(path.join(workDir, 'live-preflight.json'), { ok: false, issues: [error.message] });
    throw error;
  }
  writeJson(path.join(workDir, 'live-preflight.json'), preflight);
  console.log(`Gemini review: ${review.status}. ${review.limitations.length} limitation(s), ${review.unverified.length} unverified behavior(s). See work/live-review.json.`);
  return { inventory, review, server: startServer(htmlFile, backend, inventory) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runLiveReport({ preflightOnly: process.argv.includes('--preflight') }).catch(error => {
    console.error(`Report conversion stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
