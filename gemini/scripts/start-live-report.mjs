import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { root, inputDir, workDir, dynamicDir, discover, writeJson, readJson } from './core.mjs';
import { loadLocalEnv } from './env.mjs';
import { runGeminiStream, geminiCliInfo, toolTarget, unsupportedFlag, formatBytes } from './gemini.mjs';
import { inputFingerprint, captureArtifacts, artifactsMatch, saveCheckpoint } from './checkpoints.mjs';
import { buildReportDigest, DIGEST_VERSION } from './digest.mjs';
import { testPostgresConnection, postgresHint, listLiveSources } from './sources.mjs';
import { log, startLogFile, currentLogFile, addSecretsFromEnv, redact, formatDuration } from './log.mjs';

const MODEL = 'gemini-3.8-flash';
const STATE_VERSION = 2;
const MAX_FIX_ROUNDS = 2;

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

export class ConversionError extends Error {
  constructor(message, { hint = null, phase = null } = {}) {
    super(message);
    this.hint = hint;
    this.phase = phase;
  }
}

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

// "First N pages" means the first N pages a report reader can navigate to.
// Hidden tooltip/drillthrough pages only fill in when there are too few visible ones.
export function selectPages(pages, pageLimit) {
  if (!pageLimit) return pages;
  const hasData = page => (page.dataVisualCount ?? (page.visuals ?? []).filter(visual => visual.role === 'data').length) > 0;
  const hasContent = page => (page.visuals ?? []).some(visual => visual.role !== 'group');
  const bound = page => /tooltip|drillthrough/i.test(String(page.pageType ?? ''));
  // Pages a reader navigates to that show data first; covers, tooltip/drillthrough and hidden pages only fill the rest.
  const tiers = [
    pages.filter(page => !page.hidden && !bound(page) && hasData(page)),
    pages.filter(page => !page.hidden && !bound(page) && !hasData(page) && hasContent(page)),
    pages.filter(page => !page.hidden),
    pages
  ];
  const chosen = [];
  for (const tier of tiers) for (const page of tier) if (chosen.length < pageLimit && !chosen.includes(page)) chosen.push(page);
  const ids = new Set(chosen.map(page => page.id));
  return pages.filter(page => ids.has(page.id));
}

export function phaseSettings(env = {}, scope = { pageLimit: null }) {
  const minutes = (key, fallback) => {
    const value = Number(env[key]);
    return (Number.isFinite(value) && value > 0 ? value : fallback) * 60 * 1000;
  };
  const test = Boolean(scope.pageLimit);
  return {
    attemptMs: minutes('GEMINI_ATTEMPT_TIMEOUT_MINUTES', test ? 20 : 35),
    idleMs: minutes('GEMINI_IDLE_TIMEOUT_MINUTES', test ? 8 : 10),
    phaseMs: minutes('GEMINI_PHASE_BUDGET_MINUTES', test ? 40 : 90),
    maxAttempts: 4
  };
}

function persistedPath(scope, canonical) {
  if (canonical.startsWith('work/')) return path.join(scope.workDir, canonical.slice('work/'.length));
  if (canonical.startsWith('output/dynamic/')) return path.join(scope.dynamicDir, canonical.slice('output/dynamic/'.length));
  throw new Error(`Unsupported scoped artifact path: ${canonical}`);
}

function phaseArtifacts(scope, name) {
  return canonicalPhaseArtifacts[name].map(canonical => path.relative(root, persistedPath(scope, canonical)).replaceAll('\\', '/'));
}

const rel = file => path.relative(root, file).replaceAll('\\', '/');

// Visuals that must appear in the HTML: everything except PBIR group containers.
export function requiredVisuals(page) {
  return page.visuals.filter(visual => visual.role !== 'group');
}

function hasMarker(markup, attribute, id) {
  return markup.includes(`${attribute}="${id}"`) || markup.includes(`${attribute}='${id}'`);
}

function reportCoverage(inventory, markup) {
  return inventory.pages.map(page => ({
    ...page,
    missingPage: !hasMarker(markup, 'data-page-id', page.id),
    missingVisuals: requiredVisuals(page).filter(visual => !hasMarker(markup, 'data-visual-id', visual.id))
  }));
}

export function reportPathIsInScope(relativePath, selectedPageIds) {
  const normalized = relativePath.replaceAll('\\', '/');
  const marker = '/definition/pages/';
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  if (markerIndex < 0) return true;
  const tail = normalized.slice(markerIndex + marker.length);
  if (!tail || tail.toLowerCase() === 'pages.json') return true;
  const pageId = tail.split('/')[0];
  return selectedPageIds.has(pageId);
}

// Files Gemini never needs: localized linguistic metadata (often megabytes),
// Desktop caches/settings, and diagram layouts.
export function stagedInputAllowed(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (/(^|\/)(?:\.pbi|cultures|TMDLScripts|DAXQueries|CustomVisuals)(\/|$)/i.test(normalized)) return false;
  // Custom report themes are useful styling input; images and the large built-in base themes are not.
  if (/(^|\/)StaticResources(\/|$)/i.test(normalized) && !/(^|\/)StaticResources\/RegisteredResources\/[^/]+\.json$/i.test(normalized) && !/(^|\/)StaticResources(\/RegisteredResources)?$/i.test(normalized)) return false;
  if (/(^|\/)(?:diagramLayout|semanticModelDiagramLayout)\.json$/i.test(normalized)) return false;
  return true;
}

const STAGE_PREFIX = 'html-converter-gemini-';

export const STAGE_SETTINGS = {
  tools: { core: ['list_directory', 'read_file', 'grep_search', 'search_file_content', 'glob', 'write_file', 'replace'], useRipgrep: false, sandbox: false },
  mcp: { allowed: ['html-converter-no-mcp-servers'] },
  general: { plan: { enabled: false }, checkpointing: { enabled: false } },
  ui: { showCompatibilityWarnings: false },
  privacy: { usageStatisticsEnabled: false },
  context: { fileFiltering: { respectGitIgnore: false, respectGeminiIgnore: true } }
};

function createGeminiWorkspace(inventory, scope) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), STAGE_PREFIX));
  for (const folder of ['input', 'work', 'prompts', 'skills', 'scripts', 'output/dynamic']) fs.mkdirSync(path.join(stage, folder), { recursive: true });
  // The legacy GEMINI.md describes the snapshot workflow; live phases get their own rules.
  fs.copyFileSync(path.join(root, 'GEMINI.live.md'), path.join(stage, 'GEMINI.md'));
  for (const folder of ['prompts', 'skills']) fs.cpSync(path.join(root, folder), path.join(stage, folder), { recursive: true });
  for (const name of ['core.mjs', 'sources.mjs', 'pbir.mjs']) fs.copyFileSync(path.join(root, 'scripts', name), path.join(stage, 'scripts', name));
  const selectedPageIds = new Set(inventory.pages.map(page => page.id));
  fs.cpSync(inputDir, path.join(stage, 'input'), {
    recursive: true,
    filter: source => {
      const relative = path.relative(inputDir, source).replaceAll('\\', '/');
      if (!relative) return true;
      if (fs.lstatSync(source).isSymbolicLink()) return false;
      if (/^data(?:\/|$)/i.test(relative)) return false;
      if (!stagedInputAllowed(relative)) return false;
      if (!reportPathIsInScope(`/${relative}`, selectedPageIds)) return false;
      return fs.statSync(source).isDirectory() || /\.(?:pbip|pbir|pbism|tmdl|m|pq|bim|json)$/i.test(relative);
    }
  });
  for (const name of ['inventory.json', 'report-digest.json', 'live-run.json']) fs.copyFileSync(path.join(scope.workDir, name), path.join(stage, 'work', name));
  // Applied because the child runs with GEMINI_CLI_TRUST_WORKSPACE=true. Only file tools are
  // offered, which also removes enter_plan_mode (after it every write is denied), web access,
  // subagents, and the user's MCP servers. Unknown keys are ignored by older CLI versions.
  fs.mkdirSync(path.join(stage, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(stage, '.gemini', 'settings.json'), JSON.stringify(STAGE_SETTINGS, null, 2) + '\n');
  for (const canonical of ['work/live-interpretation.json', 'work/live-build.json', 'work/live-review.json', 'work/live-final-review.json', 'output/dynamic/index.html', 'output/dynamic/backend.mjs']) {
    const source = persistedPath(scope, canonical);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(stage, canonical));
  }
  return stage;
}

function removeGeminiWorkspace(stage) {
  const resolved = path.resolve(stage);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(STAGE_PREFIX)) {
    log.warn('cleanup', `Refusing to delete unexpected workspace path ${resolved}.`);
    return;
  }
  try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 }); }
  catch (error) { log.warn('cleanup', `Could not delete the temporary Gemini workspace ${resolved} (${error.code ?? error.message}). It is safe to delete it manually.`); }
}

// Old workspaces hold a copy of the report definition; remove any left by a crash.
function removeStaleWorkspaces() {
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir(), { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGE_PREFIX)) continue;
    const full = path.join(os.tmpdir(), entry.name);
    try {
      if (Date.now() - fs.statSync(full).mtimeMs > 6 * 60 * 60 * 1000) fs.rmSync(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 500 });
    } catch { /* still in use by another run */ }
  }
}

// Gemini CLI writes gemini-client-error-*.json (with conversation history, i.e. report
// content) to the temp folder on API errors and never deletes them. Keep them with the run.
function collectClientErrorReports(since, runDir, label) {
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir()).filter(name => /^gemini-client-error-.*\.json$/.test(name)); } catch { return; }
  for (const name of entries) {
    const file = path.join(os.tmpdir(), name);
    try {
      if (fs.statSync(file).mtimeMs < since - 1000) continue;
      const target = path.join(runDir, `${label}.${name}`);
      fs.copyFileSync(file, target);
      fs.rmSync(file, { force: true });
      log.info('gemini', `Gemini API error report saved: ${rel(target)}`);
    } catch { /* another process may own it */ }
  }
}

function preserveStage(stage, runDir, name) {
  const target = path.join(runDir, `${name}-workspace`);
  for (const folder of ['work', 'output']) {
    try { fs.cpSync(path.join(stage, folder), path.join(target, folder), { recursive: true }); } catch { /* best effort */ }
  }
  return target;
}

// Text that describes a failed Gemini run: its error, error events, stderr, and plain stdout.
// Raw stream-json events are excluded: they carry the files the model writes, and words in
// generated code ("certificate", "oauth", "not found") must never decide the diagnosis.
function geminiFailureText(result) {
  let envelopeError = null;
  const stdout = result?.stdout ?? result?.stdoutTail ?? '';
  try { const parsed = JSON.parse(stdout); envelopeError = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.error?.details ?? null; } catch { /* not a json envelope */ }
  const plain = result?.plainStdout ?? (envelopeError === null && !/^\s*[{\[]/.test(stdout) ? stdout : '');
  return [result?.status, result?.error?.message, result?.finalResult?.error?.message, ...(result?.errorMessages ?? []), envelopeError, result?.stderr ?? result?.stderrTail, plain, result?.debugTail]
    .filter(value => value !== undefined && value !== null && value !== '').map(String).join('\n');
}

function cleanStderr(text) {
  return String(text ?? '').split(/\r?\n/).filter(line => line.trim() && !STDERR_NOISE.test(line) && !/^\s+at\s/.test(line)).join('\n').trim();
}

export function geminiFailureDetail(result, env = {}) {
  let parsed;
  try { parsed = JSON.parse(result.stdout ?? result.stdoutTail ?? ''); } catch {}
  const streamError = result.finalResult?.error?.message ?? result.errorMessages?.at(-1);
  const last = result.lastSummary ? `Last Gemini activity: ${result.lastSummary}.` : '';
  const stdout = String(result.stdout ?? result.stdoutTail ?? '');
  const plain = String(result.plainStdout ?? (/^\s*[{[]/.test(stdout) ? '' : stdout)).trim();
  const envelope = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message || parsed?.error?.details;
  const message = envelope || streamError || cleanStderr(result.stderr ?? result.stderrTail) || plain || last || result.error?.message || 'No diagnostic text from Gemini CLI.';
  let detail = typeof message === 'string' ? message : JSON.stringify(message);
  for (const [key, value] of Object.entries(env)) {
    if (/(PASSWORD|SECRET|TOKEN|API_KEY|CONNECTION_STRING)/i.test(key) && typeof value === 'string' && value.length > 3) detail = detail.replaceAll(value, '[redacted]');
  }
  return detail.length > 1800 ? `${detail.slice(0, 900)}\n... [truncated] ...\n${detail.slice(-900)}` : detail;
}

export function isTransientGeminiFailure(result) {
  const detail = geminiFailureText(result);
  return [429, 173, 500, 244, 502, 246, 503, 247, 504, 248].includes(Number(result?.status)) || /\b429\b|RESOURCE_EXHAUSTED|MODEL_CAPACITY_EXHAUSTED|rate[ -]?limit|too many requests|high demand|no capacity available|\b503\b|UNAVAILABLE|overloaded|\b500\b INTERNAL|ECONNRESET|socket hang up/i.test(detail);
}

export function geminiRetryDelayMs(result, failedAttempt) {
  const match = geminiFailureText(result).match(/retry(?:delay|[-_ ]after|\s+in)?[^0-9]{0,40}(\d+(?:\.\d+)?)\s*s/i);
  const requested = match ? Number(match[1]) * 1000 : 30_000 * (2 ** Math.max(0, failedAttempt - 1));
  return Math.min(300_000, Math.max(5_000, requested));
}

// What the user should do about a Gemini CLI failure, in plain words.
export function diagnoseGeminiFailure(result) {
  const text = geminiFailureText(result);
  const signIn = 'Open a new PowerShell window, run: gemini   Complete the Google sign-in in the browser (or set GEMINI_API_KEY), type /quit, then rerun .\\setup.ps1. Completed phases are kept.';
  if (result?.interactivePrompt) return { kind: 'sign-in', retry: false, hint: `Gemini CLI is waiting for an interactive answer (usually an expired Google sign-in). ${signIn}` };
  const network = /UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT|unable to verify the first certificate|certificate|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENETUNREACH|fetch failed|getaddrinfo|proxy/i;
  // Exit 41 can also mean the Google sign-in could not be refreshed through the network.
  if (Number(result?.status) === 41 && network.test(String(result?.debugTail ?? ''))) {
    const cause = String(result.debugTail).split(/\r?\n/).find(line => network.test(line))?.trim().slice(0, 300);
    return { kind: 'network', retry: false, hint: `Gemini CLI could not refresh your Google sign-in because the network or proxy failed (${cause}). Check VPN/Internet; behind a proxy set $env:HTTPS_PROXY in the PowerShell window; for TLS inspection ask IT for the root certificate and set $env:NODE_EXTRA_CA_CERTS.` };
  }
  if (result?.aborted) return { kind: 'network', retry: false, hint: `${result.aborted} Check VPN/Internet. Behind a proxy set $env:HTTPS_PROXY = "http://proxy:port" in the same PowerShell window; for TLS inspection set $env:NODE_EXTRA_CA_CERTS to the corporate root certificate (.pem) from IT. Then rerun .\\setup.ps1; completed phases are kept.` };
  if (result?.error?.code === 'ENOENT' || /is not recognized as an internal or external command|command not found/i.test(text)) return { kind: 'missing-cli', retry: false, hint: 'Gemini CLI is not installed or not on PATH. Run: npm install -g @google/gemini-cli   then open a new PowerShell window and rerun .\\setup.ps1.' };
  if (Number(result?.status) === 41 || /FatalAuthenticationError|UNAUTHENTICATED|API key not valid|invalid api key|Please set an Auth method|auth(?:entication)? (?:failed|required)|login required|oauth|PERMISSION_DENIED/i.test(text)) return { kind: 'auth', retry: false, hint: `Gemini CLI could not authenticate. ${signIn}` };
  if (/models\/[\w.-]+ is not found|model[^\n]{0,40}not found|NOT_FOUND|not supported for generateContent|Requested entity was not found/i.test(text)) return { kind: 'model', retry: false, hint: `The pinned model ${MODEL} is not available to this Google account or Gemini CLI version. Update the CLI with: npm install -g @google/gemini-cli@latest   and check the account has access to ${MODEL}.` };
  if (Number(result?.status) === 52 || /Please fix the configuration|is not valid JSON|Invalid configuration in/i.test(text)) return { kind: 'config', retry: false, hint: 'A Gemini CLI settings file is invalid. Open the file named above (usually %USERPROFILE%\\.gemini\\settings.json), fix the JSON error, and save it as UTF-8 WITHOUT a byte-order mark (Windows PowerShell 5.1 Set-Content -Encoding UTF8 adds one). Then rerun .\\setup.ps1.' };
  if (Number(result?.status) === 55 || /not running in a trusted directory/i.test(text)) return { kind: 'trust', retry: false, hint: 'Gemini CLI refused the temporary folder as untrusted. Update Gemini CLI (npm install -g @google/gemini-cli@latest); if your organization enforces folder trust, ask IT to allow the %TEMP% folder.' };
  if ([400, 144].includes(Number(result?.status)) || /INVALID_ARGUMENT/.test(text)) return { kind: 'request', retry: false, hint: 'The Gemini API rejected the request (HTTP 400). The message above says why; if it mentions the API key, set a valid GEMINI_API_KEY or sign in again with gemini.' };
  if ([403, 147].includes(Number(result?.status))) return { kind: 'auth', retry: false, hint: `The Gemini API refused access (HTTP 403): the account/project may lack access to ${MODEL} or the API is disabled. ${signIn}` };
  if (/UNABLE_TO_GET_ISSUER_CERT_LOCALLY|SELF_SIGNED_CERT|unable to verify the first certificate|certificate/i.test(text)) return { kind: 'network', retry: false, hint: 'Gemini CLI does not trust the corporate proxy certificate. Before running setup, in the same PowerShell window run: $env:NODE_EXTRA_CA_CERTS = "C:\\path\\to\\corporate-root-ca.pem"   (ask IT for the file).' };
  if (/PerDay|per day|daily limit|QUOTA_EXHAUSTED|TerminalQuotaError|limit: 0\b/i.test(text)) return { kind: 'quota-daily', retry: false, hint: 'The Gemini quota for today (or for this key/project) is used up. Retrying now cannot succeed. Rerun .\\setup.ps1 after the quota resets, or use another API key/project; completed phases are kept.' };
  // Gemini CLI already retried network errors ten times on its own; another attempt would repeat that.
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|fetch failed|getaddrinfo|proxy/i.test(text)) return { kind: 'network', retry: false, hint: 'Gemini CLI could not reach Google. Check VPN/Internet. Behind a proxy, set $env:HTTPS_PROXY = "http://proxy:port" in the same PowerShell window before running setup.' };
  if (isTransientGeminiFailure(result)) return { kind: 'quota', retry: true, hint: 'Gemini rate limit or capacity error. Wait a few minutes and rerun .\\setup.ps1; completed phases are kept.' };
  if (result?.stalled || result?.timedOut) return { kind: result.stalled ? 'stall' : 'timeout', retry: true, hint: 'Gemini stopped making progress. Rerun .\\setup.ps1 to resume from this phase. If it keeps happening, raise GEMINI_IDLE_TIMEOUT_MINUTES / GEMINI_ATTEMPT_TIMEOUT_MINUTES in gemini/.env and send the log file named below.' };
  return { kind: 'other', retry: true, hint: 'Rerun .\\setup.ps1 to retry from this phase. If it repeats, send the log file named below.' };
}

export function geminiResponseArtifact(stdout) {
  let envelope;
  try { envelope = JSON.parse(stdout ?? ''); } catch { return null; }
  const response = envelope?.response;
  if (response && typeof response === 'object' && !Array.isArray(response)) return response;
  if (typeof response !== 'string') return null;
  return responseTextArtifact(response);
}

// Gemini sometimes prints the JSON artifact instead of writing it.
export function responseTextArtifact(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const candidates = [text.trim(), ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim()).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* try the next block */ }
  }
  return null;
}

export function normalizeReviewStatus(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return 'missing';
  // "warnings (non-blocking)" is not a block; "not approved" and "incomplete" are.
  const blocked = /^block|\bblocked\b|not\s+approved|\bincomplete\b|\breject|\bfail/.test(text.replace(/\bnon[- ]?blocking\b/g, ''));
  if (blocked) return 'blocked';
  if (/warn/.test(text)) return 'warnings';
  if (/^pass|^approved|^ok$|^complete|^success/.test(text)) return 'pass';
  return 'unknown';
}

const asArray = value => Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value];

// Checks on the generated HTML that do not need a review: they run after every build and fix
// round, and failures go back to Gemini instead of stopping the run at the very end.
export function staticReportIssues(inventory, markup, env = {}, { coverage = true } = {}) {
  const issues = [];
  if (!/<html\b/i.test(markup) || !/<script\b/i.test(markup)) issues.push('Generated HTML is not an interactive report (no <html> or <script>).');
  if (!markup.includes('/api/report')) issues.push('Generated HTML does not call its live backend at /api/report.');
  if (!/id\s*=\s*["']report-status["']/.test(markup)) issues.push('Generated HTML lacks the visible element with id="report-status".');
  if (/Visual mapping pending|Visual reconstruction pending review|Live source data<\/h2>/i.test(markup)) issues.push('Generated HTML is still a source preview.');
  if (/<(?:script|link|img)\b[^>]+(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(markup)) issues.push('Generated HTML loads external assets (CDN or remote URL); inline them.');
  for (const [index, match] of [...markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].entries()) {
    const attributes = match[1];
    if (/\bsrc\s*=/.test(attributes) || /type\s*=\s*["'](?!text\/javascript|application\/javascript)[^"']+["']/i.test(attributes)) continue;
    try { new vm.Script(match[2], { filename: `index.html inline script ${index + 1}` }); }
    catch (error) { issues.push(`JavaScript syntax error in inline script ${index + 1} of index.html: ${error.message}`); }
  }
  if (coverage) for (const page of inventory.pages) {
    if (!hasMarker(markup, 'data-page-id', page.id)) issues.push(`Missing page ${page.id}.`);
    for (const visual of requiredVisuals(page)) if (!hasMarker(markup, 'data-visual-id', visual.id)) issues.push(`Missing visual ${visual.id}.`);
  }
  for (const [key, value] of Object.entries(env)) {
    if (/(PASSWORD|SECRET|TOKEN|API_KEY|CONNECTION_STRING)/i.test(key) && typeof value === 'string' && value.length > 4 && markup.includes(value)) issues.push(`Generated HTML contains the value of ${key}; credentials must stay in the backend.`);
  }
  return issues;
}

export function validateLiveReport(inventory, markup, review, env = {}) {
  const issues = staticReportIssues(inventory, markup, env);
  const status = normalizeReviewStatus(review?.status);
  if (!review || status === 'missing') issues.push('Independent Gemini review result is missing, not valid JSON, or has no status.');
  else if (status === 'blocked') issues.push('Independent Gemini review did not approve the output.');
  return issues;
}

// Gemini authentication and network settings a user may have put in gemini/.env.
// (Source credentials such as PG_* never reach the Gemini process.)
const GEMINI_DOTENV_KEYS = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS'];

export function geminiEnvFromDotenv(env = {}) {
  const result = {};
  for (const key of GEMINI_DOTENV_KEYS) if (typeof env[key] === 'string' && env[key].trim() && process.env[key] === undefined) result[key] = env[key].trim();
  return result;
}

// ---------- live narration of a Gemini phase ----------

const STDERR_NOISE = /256-color support not detected|terminal with at least 256-color|True color \(24-bit\) support|Windows 10 detected|Ripgrep is not available|^\[STARTUP\]|Loaded cached credentials|^\s*$|DeprecationWarning|ExperimentalWarning|--trace-deprecation|--trace-warnings|punycode/i;

function createNarrator(name, settings) {
  let text = '';
  let lastIdleNotice = 0;
  const flush = () => {
    const said = text.replace(/\s+/g, ' ').trim();
    text = '';
    if (!said) return;
    log.detail(name, `Gemini says: ${said}`);
    log.info(name, `Gemini: ${said.length > 240 ? `${said.slice(0, 237)}...` : said}`);
  };
  return {
    flush,
    onEvent(event) {
      if (event.type === 'message') {
        if (event.role === 'assistant') { text += event.content ?? ''; if (text.length > 4000) flush(); }
        return;
      }
      flush();
      lastIdleNotice = 0;
      if (event.type === 'init') log.info(name, `Gemini session started (model ${event.model ?? MODEL}).`);
      else if (event.type === 'tool_use') log.info(name, `${event.tool_name}${toolTarget(event.parameters)}`);
      else if (event.type === 'tool_result' && event.status === 'error') log.warn(name, `Gemini tool call failed: ${event.error?.message ?? 'unknown error'}`);
      else if (event.type === 'error') (event.severity === 'error' ? log.error : log.warn)(name, `Gemini reported: ${event.message}`);
      else if (event.type === 'result') {
        const stats = event.stats ?? {};
        const tokens = stats.input_tokens !== undefined ? `, ${Math.round((stats.input_tokens ?? 0) / 1000)}k input / ${Math.round((stats.output_tokens ?? 0) / 1000)}k output tokens` : '';
        const tools = stats.tool_calls !== undefined ? `, ${stats.tool_calls} tool call(s)` : '';
        log.info(name, `Gemini finished: ${event.status}${tools}${tokens}.${event.error?.message ? ` ${event.error.message}` : ''}`);
      }
    },
    onStderr(line) {
      if (STDERR_NOISE.test(line) || /^\s+at\s|^\s*[{}\]]|^\s+"/.test(line)) { log.detail(name, `Gemini CLI stderr: ${line}`); return; }
      log.detail(name, `Gemini CLI stderr: ${line}`);
      const retry = /^Attempt (\d+) failed(?: with status (\d+))?/.exec(line);
      if (retry) { log.warn(name, `Gemini API request failed${retry[2] ? ` (HTTP ${retry[2]})` : ''}; Gemini CLI is retrying on its own (attempt ${retry[1]} of up to 10).`); return; }
      log.info(name, `Gemini CLI: ${line.length > 300 ? `${line.slice(0, 297)}...` : line}`);
    },
    onText(line) {
      log.info(name, `Gemini CLI: ${line.length > 300 ? `${line.slice(0, 297)}...` : line}`);
    },
    onIdle(idleMs, lastSummary, elapsedMs) {
      if (idleMs < 60_000 || idleMs - lastIdleNotice < 60_000) return;
      lastIdleNotice = idleMs;
      flush();
      log.info(name, `Waiting for Gemini: no output for ${formatDuration(idleMs)} (last: ${lastSummary ?? 'startup'}; attempt running ${formatDuration(elapsedMs)}). Silence is normal while it writes a large file; it is stopped after ${formatDuration(settings.idleMs)} without output.`);
    }
  };
}

function outputsEdited(name) {
  return name === '02-build' || name.startsWith('04-page-') || name.startsWith('06-fix-');
}

function missingPhaseOutputs(name, expected, stage) {
  const missing = [];
  if (!readJson(expected)) missing.push(path.relative(stage, expected).replaceAll('\\', '/'));
  if (outputsEdited(name)) {
    for (const file of ['index.html', 'backend.mjs']) {
      const full = path.join(stage, 'output', 'dynamic', file);
      if (!fs.existsSync(full) || !fs.statSync(full).size) missing.push(`output/dynamic/${file}`);
    }
  }
  return missing;
}

async function runPhase([name, promptFile, expectedFile], ctx) {
  const { runDir, stage, env, scope, settings, cli } = ctx;
  const expected = path.join(stage, expectedFile);
  const prompt = `Read ${promptFile}, work/live-run.json, work/report-digest.json, and work/inventory.json first. Follow the phase instructions exactly. Do not read .env or run shell commands. You MUST use the file-writing tool to write ${expectedFile}; do not merely print its contents in your response.`;
  const phaseStarted = Date.now();
  let phaseDeadline = phaseStarted + settings.phaseMs;
  let result = null, missing = [], attempt = 0, flagRetries = 0, succeeded = false;
  log.info(name, `Starting (${promptFile}). Limits: ${formatDuration(settings.attemptMs)} per attempt, ${formatDuration(settings.idleMs)} without output, ${formatDuration(settings.phaseMs)} for the phase.`);
  while (attempt < settings.maxAttempts) {
    const remainingMs = phaseDeadline - Date.now();
    if (remainingMs < 60_000) break;
    attempt++;
    if (fs.existsSync(expected)) fs.unlinkSync(expected);
    if (name === '02-build') {
      // A fresh build starts empty; a retry keeps what the previous attempt already wrote.
      if (attempt === 1) for (const file of fs.readdirSync(path.join(stage, 'output', 'dynamic'))) fs.rmSync(path.join(stage, 'output', 'dynamic', file), { recursive: true, force: true });
    } else if (outputsEdited(name)) {
      for (const file of ['index.html', 'backend.mjs']) fs.copyFileSync(path.join(scope.dynamicDir, file), path.join(stage, 'output', 'dynamic', file));
    }
    // Quoted back to Gemini; characters cmd.exe treats specially are removed for the shim launcher.
    const lastProblem = result?.events?.filter(event => event.type === 'error' || (event.type === 'tool_result' && event.summary)).map(event => event.summary).at(-1)?.replace(/["%!&|<>()^\r\n]/g, ' ');
    const truncated = (result?.errorMessages ?? []).some(message => /MAX_TOKENS|token limit|maximum number of tokens|cut off/i.test(message));
    const kept = name === '02-build' && attempt > 1 ? ['index.html', 'backend.mjs'].filter(file => fs.existsSync(path.join(stage, 'output', 'dynamic', file))).map(file => `output/dynamic/${file}`) : [];
    const repairInstruction = attempt > 1 && missing.length ? ` A previous attempt ended without producing these required files: ${missing.join(', ')}${lastProblem ? `; it ended with: ${lastProblem.slice(0, 200)}` : ''}.${kept.length ? ` These files from that attempt are already written; keep them and edit them only if needed: ${kept.join(', ')}.` : ''}${truncated ? ' Your previous reply was cut off by the output token limit: write large files in parts (create the file with the first part using write_file, then add the remaining parts with replace).' : ''} Do not repeat identical tool calls and do not switch to plan mode. Write every required file now.` : '';
    const args = ['--model', MODEL, ...(cli.skipTrust ? ['--skip-trust'] : []), '-e', 'none', '--approval-mode', 'auto_edit', '--output-format', cli.outputFormat, '-p', prompt + repairInstruction];
    const label = `${name}.attempt-${attempt}`;
    log.info(name, `Attempt ${attempt} of ${settings.maxAttempts}: Gemini ${MODEL} running. Live transcript: ${rel(path.join(runDir, `${label}.events.jsonl`))}`);
    const narrator = createNarrator(name, settings);
    const attemptStarted = Date.now();
    const debugLog = path.join(runDir, `${label}.gemini-debug.log`);
    let networkFailures = 0;
    result = await runGeminiStream(args, {
      cwd: stage,
      env: { ...geminiEnvFromDotenv(env), GEMINI_DEBUG_LOG_FILE: debugLog },
      timeoutMs: Math.min(settings.attemptMs, remainingMs),
      // The json fallback prints nothing until the end, so only the attempt limit applies to it.
      idleTimeoutMs: cli.outputFormat === 'stream-json' ? settings.idleMs : 0,
      // Three failed API attempts in a row for network reasons: stop instead of ~15 minutes of retries.
      shouldAbort: line => {
        if (!/^Attempt \d+ failed/.test(line)) return null;
        if (!/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|certificate|UNABLE_TO|SELF_SIGNED|socket hang up|proxy/i.test(line)) { networkFailures = 0; return null; }
        return ++networkFailures >= 3 ? `Gemini CLI cannot reach the Gemini API: ${line.replace(/\s+/g, ' ').slice(0, 240)}` : null;
      },
      onPause: ms => { log.warn(name, `The PC was asleep or suspended for ${formatDuration(ms)}; the time limits were extended accordingly.`); },
      eventsFile: path.join(runDir, `${label}.events.jsonl`),
      stderrFile: path.join(runDir, `${label}.stderr.log`),
      onEvent: narrator.onEvent,
      onStderr: narrator.onStderr,
      onText: cli.outputFormat === 'stream-json' ? narrator.onText : line => log.detail(name, `stdout: ${line}`),
      onIdle: narrator.onIdle,
      onPrompt: text => log.error(name, `Gemini CLI is waiting for keyboard input that this unattended run cannot give: "${text}"`)
    });
    narrator.flush();
    collectClientErrorReports(attemptStarted, runDir, label);
    try { result.debugTail = fs.readFileSync(debugLog, 'utf8').slice(-20000); } catch { /* no debug log written */ }
    phaseDeadline += result.pausedMs ?? 0;
    log.info(name, `Attempt ${attempt} ended after ${formatDuration(result.durationMs)} (exit ${result.status ?? result.signal ?? 'none'}${result.error ? `: ${result.error.message}` : ''}).`);

    const flag = unsupportedFlag(result);
    if (flag && flagRetries < 3) {
      flagRetries++;
      attempt--;
      if (flag === '--skip-trust') cli.skipTrust = false;
      else if (flag === '--output-format') cli.outputFormat = 'json';
      else throw new ConversionError(`${name}: this Gemini CLI version does not support ${flag}.`, { phase: name, hint: 'Update Gemini CLI with: npm install -g @google/gemini-cli@latest' });
      log.warn(name, `This Gemini CLI version does not support ${flag}; retrying without it. Updating Gemini CLI (npm install -g @google/gemini-cli@latest) restores live progress.`);
      continue;
    }
    if (!readJson(expected)) {
      const recovered = responseTextArtifact(result.assistantText) ?? geminiResponseArtifact(result.stdoutTail);
      if (recovered) { writeJson(expected, recovered); log.warn(name, `Gemini printed ${expectedFile} instead of writing it; saved the printed JSON.`); }
    }
    missing = missingPhaseOutputs(name, expected, stage);
    if (!missing.length) {
      if (result.error || result.status !== 0) log.warn(name, `Gemini did not exit cleanly (${result.error?.message ?? `exit ${result.status}`}), but every required file was written. Using them.`);
      succeeded = true;
      break;
    }
    const diagnosis = diagnoseGeminiFailure(result);
    if (!result.error && result.status === 0) {
      log.warn(name, `Gemini finished without writing ${missing.join(', ')}. Retrying the phase.`);
      continue;
    }
    if (!diagnosis.retry) {
      preserveStage(stage, runDir, name);
      const detail = result.interactivePrompt ? '' : ` ${geminiFailureDetail(result, env)}`;
      throw new ConversionError(`${name}: ${result.error?.message ?? `Gemini exited ${result.status}`}.${detail}`, { phase: name, hint: diagnosis.hint });
    }
    if (attempt >= settings.maxAttempts) break;
    if (diagnosis.kind === 'quota') {
      const delayMs = geminiRetryDelayMs(result, attempt);
      if (Date.now() + delayMs >= phaseDeadline - 60_000) break;
      log.warn(name, `Gemini rate limit/capacity error. Waiting ${formatDuration(delayMs)} before retrying; saved progress is unchanged.`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    } else {
      log.warn(name, `${diagnosis.kind === 'stall' ? 'Gemini stalled' : diagnosis.kind === 'timeout' ? 'Attempt time limit reached' : 'Gemini failed'}; files still missing: ${missing.join(', ')}. Retrying.`);
    }
  }
  if (!succeeded) {
    const kept = preserveStage(stage, runDir, name);
    const detail = result ? geminiFailureDetail(result, env) : '';
    const diagnosis = result ? diagnoseGeminiFailure(result) : { hint: 'Rerun .\\setup.ps1 to retry from this phase.' };
    throw new ConversionError(`${name}: no usable result after ${attempt} attempt(s) in ${formatDuration(Date.now() - phaseStarted)}${missing.length ? `; missing ${missing.join(', ')}` : ''}. ${result?.error?.message ?? ''} ${detail}`.trim(), { phase: name, hint: `${diagnosis.hint} Partial files were kept in ${rel(kept)}.` });
  }
  const persistedExpected = persistedPath(scope, expectedFile);
  fs.mkdirSync(path.dirname(persistedExpected), { recursive: true });
  fs.copyFileSync(expected, persistedExpected);
  if (outputsEdited(name)) for (const file of ['index.html', 'backend.mjs']) fs.copyFileSync(path.join(stage, 'output', 'dynamic', file), path.join(scope.dynamicDir, file));
  log.info(name, `Complete in ${formatDuration(Date.now() - phaseStarted)}; wrote ${expectedFile} (${formatBytes(fs.statSync(expected).size)}).`);
}

// ---------- generated backend self-check ----------

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not finish within ${formatDuration(ms)}.`)), ms); })
  ]);
}

const ENVIRONMENT_ISSUE = /PG_USER|PG_PASSWORD|\.env|credential|password authentication failed|28P01|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|getaddrinfo|Connection terminated|timeout expired|self[- ]signed|unable to (?:get|verify) (?:local )?issuer|UNABLE_TO_VERIFY_LEAF_SIGNATURE|certificate|pg_hba\.conf|3D000|42501|permission denied|EACCES|EPERM|network (?:path|name)|VPN/i;

export function classifyBackendIssue(message) {
  const text = String(message ?? '');
  if (/SyntaxError|ReferenceError|TypeError|is not a function|is not defined|Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND|does not provide an export|Unexpected token|must export|must provide|did not return a rows array|42601|42703|42P01|42883|syntax error at or near|column .* does not exist|relation .* does not exist/i.test(text)) return 'code';
  if (ENVIRONMENT_ISSUE.test(text)) return 'environment';
  return 'code';
}

function issueText(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object') return value.message ?? value.issue ?? value.error ?? JSON.stringify(value);
  return String(value);
}

async function backendHelpers() {
  return {
    core: await import('./core.mjs'),
    sources: await import('./sources.mjs'),
    loadPg: async () => (await import('pg')).default
  };
}

export async function selfCheckBackend(backendFile, inventory, env, { timeoutMs = 90_000 } = {}) {
  const issues = [], placeholders = [], visuals = [];
  const add = (stage, message, visualId = null) => issues.push({ stage, ...(visualId ? { visualId } : {}), message: redact(message).slice(0, 2000), kind: classifyBackendIssue(message) });
  if (!fs.existsSync(backendFile)) { add('files', 'output/dynamic/backend.mjs is missing.'); return { ok: false, issues, placeholders, visuals }; }
  const syntax = spawnSync(process.execPath, ['--check', backendFile], { encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (syntax.status !== 0) { add('syntax', `SyntaxError in backend.mjs: ${(syntax.stderr || syntax.stdout || '').trim().split(/\r?\n/).slice(0, 8).join('\n')}`); return { ok: false, issues, placeholders, visuals }; }
  let backend;
  try {
    const module = await withTimeout(import(`${pathToFileURL(backendFile).href}?check=${Date.now()}`), 30_000, 'Importing backend.mjs');
    if (typeof module.createBackend !== 'function') throw new Error('backend.mjs must export createBackend({env, root, inputDir, helpers}).');
    backend = await withTimeout(module.createBackend({ env, root, inputDir, helpers: await backendHelpers() }), 60_000, 'createBackend()');
    if (!backend || typeof backend.query !== 'function' || typeof backend.healthcheck !== 'function') throw new Error('createBackend() must return an object with query() and healthcheck() functions.');
  } catch (error) {
    add('load', `${error.message}${error.code ? ` (${error.code})` : ''}`);
    return { ok: false, issues, placeholders, visuals };
  }
  let health;
  try { health = await withTimeout(backend.healthcheck(), timeoutMs, 'healthcheck()'); }
  catch (error) { add('healthcheck', `healthcheck() threw: ${error.message}`); return { ok: false, issues, placeholders, visuals, backend }; }
  if (!health || health.ok !== true) {
    const list = Array.isArray(health?.issues) && health.issues.length ? health.issues : ['healthcheck() did not return {ok:true}.'];
    for (const item of list) add('healthcheck', issueText(item));
    return { ok: false, issues, placeholders, visuals, backend, health };
  }
  for (const page of inventory.pages) for (const visual of page.visuals.filter(v => v.role === 'data')) {
    const started = Date.now();
    try {
      const result = await withTimeout(backend.query({ visualId: visual.id, filters: {}, limit: 200 }), timeoutMs, `query(${visual.id})`);
      if (!result || !Array.isArray(result.rows)) { add('query', `query() for ${visual.id} did not return a rows array.`, visual.id); continue; }
      if (result.placeholder === true) placeholders.push({ visualId: visual.id, page: page.name, type: visual.type, title: visual.title, limitations: (result.limitations ?? []).map(issueText) });
      visuals.push({ visualId: visual.id, rowCount: result.rows.length, placeholder: result.placeholder === true, ms: Date.now() - started });
    } catch (error) { add('query', `query() for ${visual.id} (${visual.type}${visual.title ? ` "${visual.title}"` : ''}) failed: ${error.message}`, visual.id); }
  }
  return { ok: issues.length === 0, issues, placeholders, visuals, backend, health };
}

// Generated backends may hold database pools; release one that is being replaced.
async function closeBackend(backend) {
  if (typeof backend?.close !== 'function') return;
  try { await withTimeout(backend.close(), 10_000, 'backend.close()'); } catch { /* best effort */ }
}

// ---------- serving ----------

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(server.address().port); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function startServer(htmlFile, backend, inventory, { port = 8765, attempts = 10 } = {}) {
  const visualIds = new Set(inventory.pages.flatMap(page => page.visuals.map(visual => visual.id)));
  let origins = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    if (req.method !== 'GET' || (req.headers.origin && !origins.has(req.headers.origin))) { res.writeHead(403, headers); res.end(); return; }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlFile).pipe(res);
      return;
    }
    if (url.pathname === '/api/report') {
      const started = Date.now();
      const visualId = url.searchParams.get('visual');
      try {
        if (!visualIds.has(visualId)) throw new Error('Unknown visual ID.');
        const filters = JSON.parse(url.searchParams.get('filters') ?? '{}');
        if (!filters || Array.isArray(filters) || typeof filters !== 'object') throw new Error('Filters must be an object.');
        const result = await withTimeout(backend.query({ visualId, filters, limit: 2000 }), 120_000, `query(${visualId})`);
        if (!result || !Array.isArray(result.rows)) throw new Error('Backend returned invalid data.');
        res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
        log.detail('server', `GET /api/report visual=${visualId} rows=${result.rows.length} ${Date.now() - started}ms`);
      } catch (error) {
        const message = redact(error.message);
        log.warn('server', `Visual ${visualId}: ${message}`);
        res.writeHead(400, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: message }));
      }
      return;
    }
    res.writeHead(404, headers); res.end('Not found');
  });
  let bound = null, lastError = null;
  for (let candidate = port; candidate < port + attempts; candidate++) {
    try { bound = await listen(server, candidate); break; }
    catch (error) {
      lastError = error;
      if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') break;
      log.warn('server', `Port ${candidate} is in use (probably an earlier report window still running); trying ${candidate + 1}.`);
    }
  }
  if (bound === null) throw new ConversionError(`Could not start the local report server: ${lastError?.message}`, { hint: 'Close other report windows (Ctrl+C) or set HC_PORT in gemini/.env to a free port.' });
  origins = new Set([`http://127.0.0.1:${bound}`, `http://localhost:${bound}`]);
  server.on('error', error => log.error('server', `Live server error: ${error.message}`));
  return { server, url: `http://127.0.0.1:${bound}/`, port: bound };
}

// ---------- one conversion per scope ----------

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Two setup windows converting the same pages would overwrite each other's files.
export function acquireScopeLock(scope) {
  const lock = path.join(scope.workDir, 'converter.lock');
  const existing = readJson(lock);
  const fresh = existing?.startedAt && Date.now() - Date.parse(existing.startedAt) < 12 * 60 * 60 * 1000;
  if (existing?.pid && existing.pid !== process.pid && fresh && processAlive(existing.pid)) {
    throw new ConversionError(`Another converter window is already working on this scope (process ${existing.pid}, started ${existing.startedAt}).`, { phase: 'lock', hint: 'Finish or close the other PowerShell window (Ctrl+C), then rerun .\\setup.ps1. If no other window is open, delete ' + rel(lock) + '.' });
  }
  writeJson(lock, { pid: process.pid, startedAt: new Date().toISOString() });
  process.on('exit', () => { try { if (readJson(lock)?.pid === process.pid) fs.rmSync(lock, { force: true }); } catch { /* best effort */ } });
}

// ---------- checkpoints ----------

function recordPhase(state, name, paths, stateFile) {
  const artifacts = captureArtifacts(root, paths);
  if (!artifacts) throw new ConversionError(`${name} completed but one or more required artifacts are missing.`, { phase: name });
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

export function scopeFingerprint(inputHash, inventory) {
  return createHash('sha256').update(JSON.stringify({ STATE_VERSION, DIGEST_VERSION, inputHash, pages: inventory.pages.map(page => [page.id, page.visuals.map(visual => [visual.id, visual.role])]) })).digest('hex');
}

// ---------- preflight ----------

const DRIVERLESS_CONNECTORS = /\b(Sql\.Databases?|Oracle\.Database|MySQL\.Database|Odbc\.(?:DataSource|Query)|OleDb\.(?:DataSource|Query)|Excel\.Workbook|AnalysisServices\.Databases?|PowerBI\.Dataflows|PowerPlatform\.Dataflows|Snowflake\.Databases|GoogleBigQuery\.Database|Databricks\.Catalogs|Lakehouse\.Contents|Fabric\.[A-Za-z]+|SharePoint\.(?:Files|Contents|Tables)|AzureStorage\.[A-Za-z]+)\s*\(/g;

export function scopedConnectors(digest) {
  const found = new Map();
  const scan = (text, where) => {
    const code = String(text ?? '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
    for (const match of code.matchAll(DRIVERLESS_CONNECTORS)) {
      const list = found.get(match[1]) ?? new Set();
      list.add(where);
      found.set(match[1], list);
    }
  };
  // Tables pulled in only by a relationship hop do not block: the selected visuals do not read them.
  for (const table of digest.model?.tables ?? []) {
    if (table.scope === 'related-by-relationship') continue;
    for (const partition of table.partitions ?? []) if (partition.type !== 'calculated') scan(Array.isArray(partition.source) ? partition.source.join('\n') : partition.source, `table ${table.name}`);
  }
  for (const expression of digest.model?.expressions ?? []) scan(Array.isArray(expression.expression) ? expression.expression.join('\n') : expression.expression, `query ${expression.name}`);
  return [...found.entries()].map(([connector, where]) => ({ connector, usedBy: [...where] }));
}

async function preflight(inventory, digest, env) {
  const cli = geminiCliInfo();
  if (!cli.found) throw new ConversionError('Gemini CLI was not found.', { phase: 'preflight', hint: 'Install it with: npm install -g @google/gemini-cli   then open a new PowerShell window, run gemini once to sign in, and rerun .\\setup.ps1.' });
  log.info('preflight', `Gemini CLI ${cli.version ?? '(version unknown)'} found via ${cli.source}: ${cli.entry}`);
  const home = process.env.GEMINI_CLI_HOME || os.homedir();
  const hasAuth = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_USE_VERTEXAI || fs.existsSync(path.join(home, '.gemini', 'oauth_creds.json')) || fs.existsSync(path.join(home, '.gemini', 'settings.json'));
  if (!hasAuth) log.warn('preflight', 'No Gemini sign-in was found (no GEMINI_API_KEY and no ~/.gemini credentials). If the first phase stops at a sign-in prompt, run gemini once in PowerShell to sign in.');

  const blocking = scopedConnectors(digest);
  for (const table of (digest.model?.tables ?? []).filter(item => item.scope === 'related-by-relationship')) {
    const text = (table.partitions ?? []).map(partition => Array.isArray(partition.source) ? partition.source.join('\n') : partition.source ?? '').join('\n');
    const connector = /\b(Sql\.Databases?|Oracle\.Database|MySQL\.Database|Odbc\.\w+|OleDb\.\w+|Excel\.Workbook|SharePoint\.\w+|AnalysisServices\.\w+)\s*\(/.exec(text)?.[1];
    if (connector) log.warn('preflight', `Table ${table.name} is related to the selected visuals but reads ${connector}, which cannot be read live; filters that flow through it may not be reproduced.`);
  }
  if (blocking.length && env.HC_ALLOW_UNSUPPORTED_CONNECTORS !== 'true') {
    throw new ConversionError(`The selected pages need data from connector(s) this converter has no driver for: ${blocking.map(item => `${item.connector} (${item.usedBy.slice(0, 3).join(', ')})`).join('; ')}.`, { phase: 'preflight', hint: 'Only PostgreSQL and local/network CSV/JSON files can be read live. Choose pages that use those sources, or set HC_ALLOW_UNSUPPORTED_CONNECTORS=true in gemini/.env to build anyway with labeled placeholders.' });
  }
  const scopedFiles = new Set((digest.model?.tables ?? []).map(table => table.source).concat((digest.model?.expressions ?? []).map(item => item.source)));
  for (const source of inventory.fileSources ?? []) {
    if (source.available) continue;
    const inScope = scopedFiles.has(source.referencedBy) || !scopedFiles.size;
    log.warn('preflight', `File source not readable from this PC: ${source.path} (${source.error})${inScope ? '' : ' - not used by the selected pages'}.`);
  }
  const needed = (inventory.fileSources ?? []).filter(source => !source.available && (scopedFiles.has(source.referencedBy) || !scopedFiles.size));
  if (needed.length) throw new ConversionError(`The selected pages read file(s) this PC cannot open: ${needed.map(source => source.path).join(', ')}.`, { phase: 'preflight', hint: 'Connect to VPN / the network share, check the path exists for your Windows account (and that the M parameter holding the folder is right), then rerun .\\setup.ps1.' });
  for (const item of inventory.unresolvedSources ?? []) {
    if (scopedFiles.size && ![...scopedFiles].some(file => item.referencedBy.startsWith(file))) continue;
    log.warn('preflight', `Cannot check ${item.connector}(${item.arguments}) in ${item.referencedBy} before the run: its target is computed. The generated backend's source healthcheck will test it.`);
  }
  // Only connections the selected pages read (per model file); a connection used elsewhere must not block.
  const scopedPostgres = (inventory.postgresSources ?? []).filter(source => !scopedFiles.size || source.referencedBy.some(file => scopedFiles.has(file)));
  for (const source of (inventory.postgresSources ?? []).filter(item => !scopedPostgres.includes(item))) log.info('preflight', `PostgreSQL ${source.server}/${source.database} is not used by the selected pages; not checked.`);
  for (const source of scopedPostgres) {
    if (!env.PG_USER || !env.PG_PASSWORD) throw new ConversionError(`The report reads PostgreSQL ${source.server}/${source.database}, but PG_USER/PG_PASSWORD are empty.`, { phase: 'preflight', hint: `Open ${rel(path.join(root, '.env'))} and fill PG_USER and PG_PASSWORD with a read-only login, then rerun .\\setup.ps1.` });
    if (!fs.existsSync(path.join(root, 'node_modules', 'pg', 'package.json'))) throw new ConversionError('The PostgreSQL driver (pg) is not installed.', { phase: 'preflight', hint: 'Run npm install in the gemini folder (or rerun .\\setup.ps1 with Internet/npm access).' });
    // Native SQL is opt-in even when the parser cannot read a query; parsed ones must have their $n values.
    const unresolved = source.unresolvedNativeQueries ?? (source.hasUnresolvedNativeQuery ? 1 : 0);
    if ((source.nativeQueries?.length || unresolved) && env.PG_ALLOW_NATIVE_QUERIES !== 'true') {
      throw new ConversionError(`PostgreSQL ${source.server}/${source.database}: the report runs its own SQL (Value.NativeQuery), which needs your explicit approval.`, { phase: 'preflight', hint: `${postgresHint('PG_ALLOW_NATIVE_QUERIES')} Nothing was sent to Gemini yet.` });
    }
    if (unresolved) log.warn('preflight', `PostgreSQL ${source.server}/${source.database}: ${unresolved} native query(ies) could not be read by the scanner (computed SQL or parameters). Gemini will implement them from the M code; the backend check tests them.`);
    try { listLiveSources({ postgresSources: [{ ...source, hasUnresolvedNativeQuery: false }] }, env); }
    catch (error) { if (!/No supported PostgreSQL table/.test(error.message)) throw new ConversionError(`PostgreSQL ${source.server}/${source.database}: ${error.message}`, { phase: 'preflight', hint: `${postgresHint(error)} Nothing was sent to Gemini yet.` }); }
    if (env.HC_SKIP_SOURCE_PREFLIGHT === 'true') { log.warn('preflight', `Skipping PostgreSQL connection test for ${source.server}/${source.database} (HC_SKIP_SOURCE_PREFLIGHT=true).`); continue; }
    try {
      const info = await testPostgresConnection(source, env);
      log.info('preflight', `PostgreSQL ${info.host}:${info.port}/${info.database} reachable as ${info.user} (${info.ms} ms).`);
    } catch (error) {
      throw new ConversionError(`Cannot connect to PostgreSQL ${source.server}/${source.database}: ${redact(error.message)}`, { phase: 'preflight', hint: `${postgresHint(error)} Nothing was sent to Gemini yet.` });
    }
  }
}

// ---------- main ----------

function scopeSummary(inventory, discovered) {
  const visuals = inventory.pages.flatMap(page => page.visuals);
  const count = role => visuals.filter(visual => visual.role === role).length;
  return `${inventory.pages.length} of ${discovered.pages.length} page(s): ${inventory.pages.map(page => `"${page.name}"${page.hidden ? ' (hidden)' : ''}`).join(', ')}. ${visuals.length} visual(s): ${count('data')} with data, ${count('decorative')} decorative, ${count('group')} group container(s).`;
}

export async function runLiveReport({ preflightOnly = false, invokeGemini = true, pageLimit = null, fresh = false, serve = true, port } = {}) {
  process.chdir(root);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const logFile = startLogFile(path.join(root, 'logs', `converter-${stamp}-${process.pid}.log`));
  try { fs.writeFileSync(path.join(root, 'logs', 'latest-converter-log.txt'), logFile + os.EOL); } catch { /* informational only */ }
  log.info(null, `html_converter live conversion. Log file (send this if anything fails): ${logFile}`);
  log.info(null, `Node ${process.version} on ${process.platform} ${os.release()}; folder ${root}`);
  if (Number(process.versions.node.split('.')[0]) < 20) throw new ConversionError(`Node.js ${process.version} is too old.`, { hint: 'Install Node.js 20 LTS or newer, open a new PowerShell window, and rerun .\\setup.ps1.' });
  const env = loadLocalEnv();
  addSecretsFromEnv(env);
  addSecretsFromEnv(process.env);
  const discovered = discover();
  const scope = createRunScope(pageLimit);
  const selected = selectPages(discovered.pages, pageLimit);
  const inventory = { ...discovered, pages: selected, pageScope: { mode: scope.key, selectedPages: selected.length, totalPages: discovered.pages.length, selectedPageIds: selected.map(page => page.id) } };
  if (!inventory.pages.length || !inventory.pages.some(page => page.visuals.length)) throw new ConversionError('No enhanced PBIR pages/visuals found; cannot verify a generated report against this PBIP format.', { hint: 'In Power BI Desktop enable File > Options > Preview features > "Store reports using enhanced metadata format (PBIR)", save the project as .pbip again, and copy the whole folder into gemini/input.' });
  if (inventory.reportModelReferences.some(x => x.kind === 'remote-connection')) throw new ConversionError('PBIR references a remote semantic model. This no-Fabric workflow requires a local model definition.', { hint: 'Save the report together with its local .SemanticModel folder as a PBIP project.' });
  if (inventory.reportModelReferences.some(x => x.kind === 'missing-local-path')) throw new ConversionError('The report points to a semantic model folder that is not in gemini/input.', { hint: 'Copy the whole PBIP project into gemini/input: the .pbip file plus BOTH the .Report and the .SemanticModel folders, keeping their names.' });
  for (const problem of discovered.problems ?? []) log.warn('scan', problem);
  log.info('scope', scopeSummary(inventory, discovered));
  const skippedHidden = pageLimit ? discovered.pages.slice(0, discovered.pages.indexOf(selected[selected.length - 1]) + 1).filter(page => page.hidden && !selected.includes(page)) : [];
  if (skippedHidden.length) log.info('scope', `Skipped hidden page(s) not visible to report readers: ${skippedHidden.map(page => `"${page.name}"`).join(', ')}.`);
  log.info('scope', `Sources: ${inventory.postgresSources.length} PostgreSQL, ${inventory.directCsvSources.length} direct CSV, ${inventory.unsupportedConnectors.length} other connector reference(s).`);
  fs.mkdirSync(scope.workDir, { recursive: true });
  const previousInventory = readJson(path.join(scope.workDir, 'inventory.json'));
  writeJson(path.join(scope.workDir, 'inventory.json'), inventory);
  const digest = buildReportDigest(inventory);
  writeJson(path.join(scope.workDir, 'report-digest.json'), digest);
  log.info('digest', `${rel(path.join(scope.workDir, 'report-digest.json'))}: ${digest.counts.includedTables} of ${digest.counts.modelTables} model table(s), ${digest.counts.includedMeasures} measure(s), ${digest.counts.relationships} relationship(s) in scope (${formatBytes(fs.statSync(path.join(scope.workDir, 'report-digest.json')).size)}).`);
  for (const warning of digest.warnings) log.warn('digest', warning);
  if (preflightOnly) {
    await preflight(inventory, digest, env);
    log.info('preflight', 'PBIP scan and source checks passed. No Gemini call made.');
    return { inventory, digest };
  }
  await preflight(inventory, digest, env);
  acquireScopeLock(scope);

  const stateFile = path.join(scope.workDir, 'live-state.json');
  const selectedIds = new Set(inventory.pages.map(page => page.id));
  const fingerprint = scopeFingerprint(inputFingerprint(inputDir, (relative, isDirectory) => isDirectory ? stagedInputAllowed(relative) : stagedInputAllowed(relative) && reportPathIsInScope(`/${relative}`, selectedIds)), inventory);
  let state = readJson(stateFile);
  const hadState = state !== null;
  if (fresh || state?.version !== STATE_VERSION || state?.fingerprint !== fingerprint) {
    if (hadState && !fresh) log.info('checkpoint', 'The PBIP, page selection, or converter version changed since the saved progress; starting this scope fresh.');
    state = { version: STATE_VERSION, project: inventory.project, scope: scope.key, fingerprint, createdAt: new Date().toISOString(), phases: {}, repairs: {}, fixRounds: 0, needsFinalReview: false };
    if (!fresh && !hadState && adoptPriorRun(state, inventory, previousInventory, scope)) log.info('checkpoint', 'Adopted completed artifacts from the previous converter run.');
    saveCheckpoint(stateFile, state);
  } else log.info('checkpoint', `Resuming saved progress: ${Object.keys(state.phases).join(', ') || 'no completed phases yet'}.`);
  const runDir = fs.mkdtempSync(path.join(scope.workDir, 'live-run-'));
  writeJson(path.join(scope.workDir, 'live-run.json'), { project: inventory.project, scope: scope.key, startedAt: new Date().toISOString(), model: MODEL, runLog: rel(runDir), converterLog: logFile });
  log.info(null, `Gemini transcripts for this run: ${rel(runDir)}`);
  const htmlFile = path.join(scope.dynamicDir, 'index.html');
  const backendFile = path.join(scope.dynamicDir, 'backend.mjs');
  fs.mkdirSync(scope.dynamicDir, { recursive: true });
  const settings = phaseSettings(env, scope);
  // Trust comes from GEMINI_CLI_TRUST_WORKSPACE; the --skip-trust flag does not load workspace settings.
  const cli = { outputFormat: 'stream-json', skipTrust: false };
  let checked = null;

  if (invokeGemini) {
    removeStaleWorkspaces();
    const stage = createGeminiWorkspace(inventory, scope);
    log.detail('workspace', `Temporary Gemini workspace: ${stage}`);
    const ctx = { runDir, stage, env, scope, settings, cli };
    let fixCounter = state.fixRounds ?? 0;
    const markOutputsChanged = () => {
      recordPhase(state, '02-build', phaseArtifacts(scope, '02-build'), stateFile);
      if (state.phases['03-review']) state.needsFinalReview = true;
      saveCheckpoint(stateFile, state);
    };
    const runFix = async request => {
      fixCounter++;
      state.fixRounds = fixCounter;
      writeJson(path.join(stage, 'work', 'fix-request.json'), { ...request, round: fixCounter, backendContract: 'createBackend({env, root, inputDir, helpers}) -> {healthcheck(), query({visualId, filters, limit})}' });
      await runPhase([`06-fix-${fixCounter}`, 'prompts/live-06-fix.md', `work/fix-result-${fixCounter}.json`], ctx);
      markOutputsChanged();
    };
    // A passing check is reused while backend.mjs is unchanged in this process.
    let lastCheck = null;
    const outputsHash = () => createHash('sha256').update(fs.existsSync(backendFile) ? fs.readFileSync(backendFile) : '').update(fs.existsSync(htmlFile) ? fs.readFileSync(htmlFile) : '').digest('hex');
    // coverage: also require every page/visual marker (after the batched page repairs have run).
    const ensureBackend = async (reason, { coverage = false } = {}) => {
      if (lastCheck?.ok && lastCheck.hash === outputsHash() && lastCheck.coverage === coverage && (!lastCheck.placeholders.length || state.placeholderFixDone)) return lastCheck;
      for (let round = 0; ; round++) {
        log.info('self-check', `Checking the generated report (${reason}): HTML, backend syntax and import, source healthcheck, and every data visual query...`);
        const check = await selfCheckBackend(backendFile, inventory, env);
        const htmlIssues = staticReportIssues(inventory, fs.existsSync(htmlFile) ? fs.readFileSync(htmlFile, 'utf8') : '', env, { coverage }).map(message => ({ stage: 'html', message, kind: 'code' }));
        check.issues.push(...htmlIssues);
        check.ok = check.ok && !htmlIssues.length;
        check.hash = outputsHash();
        check.coverage = coverage;
        await closeBackend(lastCheck?.backend);
        lastCheck = check;
        const selfcheckReport = { checkedAt: new Date().toISOString(), reason, ok: check.ok, issues: check.issues, placeholders: check.placeholders, suspicious: check.suspicious ?? [], visuals: check.visuals };
        writeJson(path.join(scope.workDir, 'live-selfcheck.json'), selfcheckReport);
        // Reviewers and fix phases read the real results from their workspace.
        writeJson(path.join(stage, 'work', 'live-selfcheck.json'), selfcheckReport);
        const environment = check.issues.filter(issue => issue.kind === 'environment');
        const code = check.issues.filter(issue => issue.kind === 'code');
        log.info('self-check', `${check.visuals.length} visual query(ies) answered, ${check.placeholders.length} placeholder(s), ${code.length} code issue(s), ${environment.length} source-access issue(s).`);
        for (const issue of check.issues.slice(0, 12)) log.warn('self-check', `${issue.stage}${issue.visualId ? ` ${issue.visualId}` : ''}: ${issue.message.split('\n')[0]}`);
        if (environment.length && !code.length) {
          throw new ConversionError(`The generated backend cannot reach the report's data: ${environment.map(issue => issue.message.split('\n')[0]).slice(0, 3).join(' | ')}`, { phase: 'self-check', hint: `${postgresHint(environment[0].message)} Gemini's work is saved; after fixing this, rerun .\\setup.ps1 and it resumes at this check.` });
        }
        // Placeholders get one fix round per build; afterwards they are served, labeled, and listed.
        const needsFix = code.length || (check.placeholders.length && !state.placeholderFixDone);
        if (!needsFix) return check;
        if (round >= MAX_FIX_ROUNDS) {
          if (code.length) throw new ConversionError(`The generated backend still fails after ${MAX_FIX_ROUNDS} automatic fix round(s): ${code.map(issue => issue.message.split('\n')[0]).slice(0, 3).join(' | ')}`, { phase: 'self-check', hint: `Details: ${rel(path.join(scope.workDir, 'live-selfcheck.json'))}. Rerun .\\setup.ps1 to try another fix round, or run with --fresh to rebuild.` });
          return check;
        }
        log.info('self-check', `Asking Gemini to fix ${code.length} issue(s)${check.placeholders.length && !state.placeholderFixDone ? ` and ${check.placeholders.length} placeholder visual(s)` : ''}.`);
        const placeholders = state.placeholderFixDone ? [] : check.placeholders;
        if (placeholders.length) state.placeholderFixDone = true;
        await runFix({ reason: 'backend-self-check', issues: code, placeholders, environmentIssues: environment });
      }
    };
    try {
      let upstreamChanged = false;
      for (const phase of phases) {
        const [name] = phase;
        const valid = !upstreamChanged && artifactsMatch(root, state.phases[name]?.artifacts);
        if (valid) { log.info(name, 'Reusing the completed result from saved progress.'); continue; }
        // On resume, prove the saved backend works before spending a review phase on it.
        if (name === '03-review' && !lastCheck) await ensureBackend('saved build');
        if (name === '02-build') {
          for (const [file, backup] of [[htmlFile, 'previous-index.html'], [backendFile, 'previous-backend.mjs']]) if (fs.existsSync(file)) fs.copyFileSync(file, path.join(runDir, backup));
          state.repairs = {};
          state.needsFinalReview = false;
          state.placeholderFixDone = false;
        }
        await runPhase(phase, ctx);
        recordPhase(state, name, phaseArtifacts(scope, name), stateFile);
        upstreamChanged = true;
        // Everything downstream of a rerun phase is stale.
        if (name !== '03-review') delete state.phases['03-review'];
        delete state.phases['05-final-review'];
        state.needsFinalReview = false;
        saveCheckpoint(stateFile, state);
        if (name === '02-build') await ensureBackend('after build');
      }
      const incomplete = reportCoverage(inventory, fs.readFileSync(htmlFile, 'utf8')).filter(page => page.missingPage || page.missingVisuals.length);
      if (incomplete.length) log.info('coverage', `${incomplete.length} page(s) are missing elements; repairing them in batches. Completed phases will not restart.`);
      for (const page of incomplete) {
        const safePageId = /^[A-Za-z0-9_-]+$/.test(page.id) ? page.id : createHash('sha256').update(page.id).digest('hex').slice(0, 16);
        let batchIndex = 0, failures = 0;
        for (;;) {
          const current = reportCoverage({ pages: [page] }, fs.readFileSync(htmlFile, 'utf8'))[0];
          if (!current.missingPage && !current.missingVisuals.length) break;
          const batch = current.missingVisuals.slice(0, 8);
          const currentPage = { id: page.id, name: page.name, source: page.source, missingPage: current.missingPage, missingVisuals: batch, remainingVisualCount: current.missingVisuals.length - batch.length, allVisuals: page.visuals };
          writeJson(path.join(stage, 'work', 'current-page.json'), currentPage);
          const name = `04-page-${safePageId}-${batchIndex++}`;
          const artifact = `work/page-repair-${safePageId}-${batchIndex}.json`;
          log.info(name, `Repairing ${current.missingPage ? 'the page container and ' : ''}${batch.length} visual(s) on "${page.name}"; ${currentPage.remainingVisualCount} more queued.`);
          await runPhase([name, 'prompts/live-04-page-repair.md', artifact], ctx);
          markOutputsChanged();
          const after = reportCoverage({ pages: [page] }, fs.readFileSync(htmlFile, 'utf8'))[0];
          const stillMissing = batch.filter(visual => after.missingVisuals.some(item => item.id === visual.id));
          const repair = readJson(persistedPath(scope, artifact));
          if (repair && !/^complete/i.test(String(repair.status ?? ''))) log.warn(name, `Gemini reported status "${repair.status}": ${asArray(repair.limitations).map(issueText).slice(0, 3).join('; ')}`);
          if (after.missingPage || stillMissing.length) {
            // Partial progress is progress: only a batch that added nothing counts as a failed attempt.
            const progressed = stillMissing.length < batch.length || (current.missingPage && !after.missingPage);
            if (progressed) { failures = 0; log.info(name, `${batch.length - stillMissing.length} of ${batch.length} visual(s) added; continuing with the rest.`); continue; }
            if (++failures >= 2) throw new ConversionError(`${name}: page "${page.name}" is still missing ${after.missingPage ? 'its page element and ' : ''}${stillMissing.length} visual element(s) after two repair attempts (${stillMissing.map(visual => visual.id).slice(0, 5).join(', ')}).`, { phase: name, hint: `Progress is saved; rerunning .\\setup.ps1 continues with this page. See ${rel(persistedPath(scope, artifact))}.` });
            log.warn(name, `${stillMissing.length} requested visual(s) are still missing from the HTML; retrying this batch once.`);
            continue;
          }
          failures = 0;
          state.repairs[page.id] = { completedAt: new Date().toISOString(), artifact: rel(persistedPath(scope, artifact)), remainingVisualCount: after.missingVisuals.length };
          saveCheckpoint(stateFile, state);
        }
      }
      let blockedRounds = 0, missingReviewRetried = false;
      for (;;) {
        checked = await ensureBackend(state.needsFinalReview ? 'after repairs' : 'before serving', { coverage: true });
        const finalValid = artifactsMatch(root, state.phases['05-final-review']?.artifacts);
        if (state.needsFinalReview || (Object.keys(state.repairs).length && !finalValid)) {
          await runPhase(['05-final-review', 'prompts/live-05-final-review.md', 'work/live-final-review.json'], ctx);
          recordPhase(state, '05-final-review', phaseArtifacts(scope, '05-final-review'), stateFile);
          state.needsFinalReview = false;
          saveCheckpoint(stateFile, state);
        }
        const review = currentReview(scope, state);
        const status = normalizeReviewStatus(review?.status);
        if (status === 'missing' && !missingReviewRetried) {
          missingReviewRetried = true;
          log.warn('review', 'The review result has no status (or is not valid JSON); running the independent review again.');
          state.needsFinalReview = true;
          saveCheckpoint(stateFile, state);
          continue;
        }
        if (status === 'missing') throw new ConversionError('The independent Gemini review twice produced no usable status.', { phase: 'review', hint: `Rerun .\\setup.ps1 to review again. The review files are in ${rel(scope.workDir)}.` });
        if (status !== 'blocked' || env.HC_ALLOW_BLOCKED_REVIEW === 'true') {
          if (status === 'blocked') log.warn('review', 'The review is blocked, but HC_ALLOW_BLOCKED_REVIEW=true: serving anyway.');
          if (status === 'unknown') log.warn('review', `Review status "${review?.status}" is not pass/warnings/blocked; treating it as warnings.`);
          break;
        }
        if (blockedRounds++ >= MAX_FIX_ROUNDS) {
          const findings = asArray(review.findings).map(issueText).slice(0, 5);
          throw new ConversionError(`The independent Gemini review still blocks the report after ${MAX_FIX_ROUNDS} fix round(s): ${findings.join(' | ') || 'no findings listed'}`, { phase: 'review', hint: `Read ${rel(path.join(scope.workDir, state.phases['05-final-review'] ? 'live-final-review.json' : 'live-review.json'))}. Rerun .\\setup.ps1 for another fix round, or set HC_ALLOW_BLOCKED_REVIEW=true in gemini/.env to open the report anyway for manual comparison.` });
        }
        log.warn('review', `The independent review marked the report blocked (${asArray(review.findings).length} finding(s)). Asking Gemini to fix them, then reviewing again.`);
        await runFix({ reason: 'review-blocked', findings: asArray(review.findings), limitations: asArray(review.limitations), unverified: asArray(review.unverified) });
        state.needsFinalReview = true;
        saveCheckpoint(stateFile, state);
      }
    } finally { removeGeminiWorkspace(stage); }
  }
  if (!checked) checked = await selfCheckBackend(backendFile, inventory, env);
  const review = currentReview(scope, state) ?? {};
  const issues = validateLiveReport(inventory, fs.readFileSync(htmlFile, 'utf8'), env.HC_ALLOW_BLOCKED_REVIEW === 'true' ? { ...review, status: 'warnings' } : review, env);
  writeJson(path.join(scope.workDir, 'live-validation.json'), { passed: issues.length === 0, issues, reviewStatus: review?.status });
  if (issues.length) throw new ConversionError(`Generated report failed validation: ${issues.slice(0, 5).join(' ')}`, { phase: 'validation', hint: `Progress is saved. See ${rel(path.join(scope.workDir, 'live-validation.json'))}; rerunning .\\setup.ps1 retries the repairs.` });
  if (!checked.ok) throw new ConversionError(`Generated backend check failed: ${checked.issues.map(issue => issue.message.split('\n')[0]).slice(0, 3).join(' | ')}`, { phase: 'self-check', hint: `See ${rel(path.join(scope.workDir, 'live-selfcheck.json'))}.` });
  writeJson(path.join(scope.workDir, 'live-preflight.json'), { ok: true, sources: checked.health?.sources ?? [], visuals: checked.visuals, placeholders: checked.placeholders });
  const limitations = asArray(review.limitations);
  const unverified = asArray(review.unverified);
  log.info('review', `Gemini review: ${review.status}. ${limitations.length} limitation(s), ${unverified.length} unverified behavior(s).`);
  for (const placeholder of checked.placeholders) log.warn('review', `Visual ${placeholder.visualId} (${placeholder.type}${placeholder.title ? ` "${placeholder.title}"` : ''}) on "${placeholder.page}" is an explicit placeholder: ${placeholder.limitations.join('; ') || 'no reason given'}`);
  if (!serve) return { inventory, review, backend: checked.backend };
  const requestedPort = Number(port ?? env.HC_PORT ?? 8765);
  const { server, url } = await startServer(htmlFile, checked.backend, inventory, { port: Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 8765 });
  log.info(null, '============================================================');
  log.info(null, `REPORT READY: ${url}`);
  log.info(null, `Open the address above in the browser; the HTML file alone cannot load data. Files: ${scope.dynamicDir}`);
  log.info(null, 'Credentials stay in this local server. Press Ctrl+C in this window to stop it.');
  log.info(null, '============================================================');
  return { inventory, review, server, url };
}

function currentReview(scope, state) {
  const finalValid = artifactsMatch(root, state.phases['05-final-review']?.artifacts) && !state.needsFinalReview;
  return finalValid ? readJson(path.join(scope.workDir, 'live-final-review.json')) : readJson(path.join(scope.workDir, 'live-review.json'));
}

export function reportFailure(error) {
  const message = redact(error?.message ?? String(error));
  log.error(error?.phase ?? null, '============================================================');
  log.error(error?.phase ?? null, `CONVERSION STOPPED${error?.phase ? ` at ${error.phase}` : ''}: ${message}`);
  if (error?.hint) log.error(error.phase ?? null, `What to do: ${redact(error.hint)}`);
  if (!(error instanceof ConversionError) && error?.stack) log.detail(null, redact(error.stack));
  if (currentLogFile()) log.error(error?.phase ?? null, `Full log: ${currentLogFile()}`);
  log.error(error?.phase ?? null, '============================================================');
}

// Windows paths differ in case, 8.3 short names, or symlinks between argv and import.meta.url;
// compare real paths case-insensitively so the converter never silently does nothing.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const invoked = fs.realpathSync(path.resolve(process.argv[1]));
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? invoked.toLowerCase() === self.toLowerCase() : invoked === self;
  } catch { return import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href; }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf('--port');
  Promise.resolve().then(() => runLiveReport({
    preflightOnly: args.includes('--preflight'),
    pageLimit: pageLimitFromArgs(args),
    fresh: args.includes('--fresh'),
    serve: !args.includes('--no-serve') && process.env.HC_NO_SERVE !== 'true',
    port: portIndex >= 0 ? Number(args[portIndex + 1]) : undefined
  })).then(result => {
    // Without a server nothing else should run; a generated backend's open pool or timer must not keep the window waiting.
    if (!result?.server) process.stdout.write('', () => process.exit(0));
  }).catch(error => {
    if (!currentLogFile()) {
      try { startLogFile(path.join(root, 'logs', `converter-failed-${process.pid}.log`)); } catch { /* console only */ }
    }
    reportFailure(error);
    process.stdout.write('', () => process.exit(1));
  });
}
