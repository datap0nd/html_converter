// The generated backend's runtime contract: the helpers it receives, how its
// failures are classified, and an isolated self-check of backend.mjs.
//
// Exported API (details at each function):
//   QUERY_ROW_LIMIT, QUERY_CONCURRENCY, BACKEND_CONTRACT
//   backendHelpers({ env, inventory, digest, onPoolError })      -> helpers for createBackend
//   classifyBackendIssue(messageOrError, context)                -> 'environment' | 'code'
//   diagnoseBackendIssue(issue, context)                         -> { kind, rule, hint?, note?, probe? }
//   checkBackend(options)                                        -> Promise<CheckResult> (child process)
//   loadBackend(options)                                         -> Promise<backend> (in-process, for serving)
//   closeBackend(backend, { timeoutMs })                         -> Promise<void>
//   scanBackendSource(text)                                      -> { issues, warnings }
//   createRedactor(env), withTimeout(promise, ms, label), toList(value), issueText(value)
//
// checkBackend never runs generated code in the calling process: it starts
// `node backend-check.mjs --html-converter-backend-check-child`, sends the inputs
// (including .env values) over the IPC channel, and watches the child. A
// synchronous loop, process.exit(), an unhandled 'error' event or rejection, or a
// crash in backend.mjs only ends or disturbs that child.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as core from './core.mjs';
import * as sources from './sources.mjs';
import { loadPg, postgresConfig, createPostgresPool, postgresHint, testPostgresConnection } from './sources.mjs';
import { killProcessTree } from './gemini.mjs';
import { readExcel, inspectWorkbook, excelErrorHint } from './excel.mjs';
import { formatDuration } from './log.mjs';

const thisFile = fileURLToPath(import.meta.url);
const CHILD_FLAG = '--html-converter-backend-check-child';

// The report server and the self-check ask for exactly this many rows per visual.
export const QUERY_ROW_LIMIT = 2000;
// Browsers load up to 6 visuals at once; the server and the check run 4 queries at a time.
export const QUERY_CONCURRENCY = 4;
export const SECRET_ENV_KEY = /PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CLIENT_?KEY|ACCESS_?KEY|CONNECTION_?STRING|CREDENTIAL|(?:^|_)PASS(?:_|$)/i;

// One-paragraph contract for fix requests (work/fix-request.json backendContract).
export const BACKEND_CONTRACT = [
  'export async function createBackend({ env, root, inputDir, helpers }) returning { healthcheck(), query({ visualId, filters, limit }), close() }.',
  'healthcheck() -> { ok: true, sources: string[] } or { ok: false, issues: (string | { kind: "environment"|"code", message, path? })[] }.',
  `query() -> { rows: object[] (at most limit = ${QUERY_ROW_LIMIT}), columns: string[] naming every row key, placeholder: boolean, limitations: string[] }; numbers are JS numbers, dates "YYYY-MM-DD" strings, blanks null.`,
  'PostgreSQL only through helpers.postgres.createPool(helpers.postgres.connections[i]) (same settings as the converter preflight, read-only, 60 s statement timeout, errors handled); files only at the exact paths in helpers.inventory.fileSources / helpers.digest.sources.files; Excel only through helpers.excel.read(path, { item, kind, useHeaders }) with the items listed in fileSources[].excel.items (no npm Excel package); close() ends pools and timers.',
  'No process.env, no imports outside output/dynamic (own modules next to backend.mjs are fine), no npm packages other than pg, no reads of work/ or output/ files at runtime (use helpers.digest / helpers.inventory).'
].join(' ');

// ---------- small utilities ----------

export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`${label} did not finish within ${formatDuration(ms)}.`);
        error.code = 'HC_TIMEOUT';
        reject(error);
      }, ms);
    })
  ]);
}

export function toList(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === '' ? [] : [value];
}

// Plain text for a limitation, issue or error of any shape the model may produce.
export function issueText(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.name && value.name !== 'Error' && !value.message.startsWith(value.name) ? `${value.name}: ${value.message}` : value.message;
  if (value && typeof value === 'object') {
    const text = value.message ?? value.issue ?? value.error ?? value.description ?? value.detail ?? value.reason ?? value.text;
    if (typeof text === 'string') return text;
    if (text && typeof text === 'object') return issueText(text);
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

export function secretValues(env = {}) {
  const values = new Set();
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!SECRET_ENV_KEY.test(key) || typeof value !== 'string' || value.length <= 3) continue;
    values.add(value);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) values.add(encoded);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

// Replaces the values of secret-looking .env keys with [redacted].
export function createRedactor(env = {}) {
  const secrets = secretValues(env);
  return text => {
    let result = String(text ?? '');
    for (const secret of secrets) result = result.split(secret).join('[redacted]');
    return result;
  };
}

function describeType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

function fmtMs(ms) {
  return ms < 10_000 ? `${ms} ms` : formatDuration(ms);
}

function oneLine(text, max = 240) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

// Serializable details of any thrown value (IPC and classification use this shape).
function errorInfo(error) {
  if (error === null || error === undefined || typeof error !== 'object') return { name: 'Error', message: String(error) };
  const info = { name: typeof error.name === 'string' && error.name ? error.name : 'Error', message: typeof error.message === 'string' ? error.message : issueText(error) };
  for (const key of ['code', 'errno', 'syscall', 'path', 'address', 'port', 'hostname', 'severity', 'routine']) {
    if (typeof error[key] === 'string' || typeof error[key] === 'number') info[key] = error[key];
  }
  // fetch() failures carry the network code on their cause.
  if (!info.code && error.cause && typeof error.cause === 'object' && typeof error.cause.code === 'string') {
    info.code = error.cause.code;
    for (const key of ['address', 'port', 'hostname', 'syscall']) if (info[key] === undefined && (typeof error.cause[key] === 'string' || typeof error.cause[key] === 'number')) info[key] = error.cause[key];
  }
  if (typeof error.stack === 'string') info.stack = error.stack.split('\n').slice(0, 12).join('\n');
  return info;
}

function redactInfo(info, redact) {
  if (!info) return info;
  const copy = { ...info };
  for (const key of ['message', 'stack', 'path', 'hostname']) if (typeof copy[key] === 'string') copy[key] = redact(copy[key]);
  return copy;
}

function errorText(info) {
  if (!info) return 'unknown error';
  const message = String(info.message ?? '');
  const name = info.name && info.name !== 'Error' && !message.startsWith(info.name) ? `${info.name}: ` : '';
  const code = info.code && !message.includes(String(info.code)) ? ` (${info.code})` : '';
  return `${name}${message}${code}`;
}

// " [backend.mjs line 42]" from the first stack frame inside backend.mjs.
function backendLocation(info, backendFile) {
  if (!info?.stack || !backendFile) return '';
  const base = path.basename(backendFile);
  for (const line of info.stack.split('\n').slice(1)) {
    const match = /(?:file:\/\/\/?)?([^()\s]+?)(?:\?[^:()\s]*)?:(\d+):\d+\)?\s*$/.exec(line.trim());
    if (!match) continue;
    let file = match[1];
    try { file = decodeURIComponent(file); } catch { /* keep as is */ }
    if (file.split(/[\\/]/).pop() === base) return ` [${base} line ${match[2]}]`;
  }
  return '';
}

// ---------- helpers given to createBackend ----------

const poolsByHelpers = new WeakMap();
const helpersByBackend = new WeakMap();

// The `helpers` argument of createBackend({ env, root, inputDir, helpers }):
//   core, sources, loadPg                 the converter modules and the configured pg driver
//   postgres.connections                  the report's PostgreSQL sources (inventory.postgresSources)
//   postgres.config(connection)           postgresConfig(connection, env) (same as preflight)
//   postgres.createPool(connection, opts) createPostgresPool(connection, env, opts); connection may be
//                                         an entry, its index, or omitted for the first one
//   digest, inventory                     the scoped report digest and { postgresSources, fileSources,
//                                         webSources, mParameters }
//   enterData                             digest.enterData (decoded "Enter Data" tables) or {}
//   excel.read(path, options)             one sheet/table/defined name as { columns, rows, warnings } (excel.mjs readExcel)
//   excel.inspect(path)                   the workbook's items (excel.mjs inspectWorkbook)
// onPoolError(error, { connection }) receives pool connection errors (they never crash the process).
export function backendHelpers({ env = {}, inventory = {}, digest = null, onPoolError } = {}) {
  const inv = inventory && typeof inventory === 'object' ? inventory : {};
  const found = digest?.sources && typeof digest.sources === 'object' ? digest.sources : {};
  const firstArray = (...values) => values.find(Array.isArray) ?? [];
  const postgresSources = firstArray(inv.postgresSources, found.postgres);
  const fileSources = firstArray(inv.fileSources, found.files);
  const webSources = firstArray(inv.webSources, found.web, found.webSources);
  const mParameters = [inv.mParameters, found.mParameters].find(value => value && typeof value === 'object' && !Array.isArray(value)) ?? {};
  const excelWorkbooks = firstArray(inv.excelWorkbooks, found.excelWorkbooks);
  const pools = new Set();
  const resolveConnection = connection => {
    if (connection === undefined || connection === null) {
      if (postgresSources.length) return postgresSources[0];
      throw new Error('This report has no PostgreSQL source (helpers.postgres.connections is empty).');
    }
    if (Number.isInteger(connection)) {
      if (!postgresSources[connection]) throw new Error(`helpers.postgres.connections has no entry ${connection}.`);
      return postgresSources[connection];
    }
    return connection;
  };
  const helpers = {
    core,
    sources,
    loadPg,
    postgres: {
      connections: postgresSources,
      config: connection => postgresConfig(resolveConnection(connection), env),
      createPool: (connection, options = {}) => {
        const own = options?.onError;
        const pool = createPostgresPool(resolveConnection(connection), env, {
          ...(options ?? {}),
          onError: (error, info) => {
            try { own?.(error, info); } catch { /* ignore */ }
            try { onPoolError?.(error, info); } catch { /* ignore */ }
          }
        });
        pools.add(pool);
        return pool;
      }
    },
    digest: digest ?? null,
    inventory: { postgresSources, fileSources, webSources, mParameters, excelWorkbooks },
    enterData: digest?.enterData && typeof digest.enterData === 'object' ? digest.enterData : {},
    excel: { read: (file, options) => readExcel(file, options ?? {}), inspect: file => inspectWorkbook(file) }
  };
  poolsByHelpers.set(helpers, pools);
  return helpers;
}

async function endPools(helpers, timeoutMs = 5000) {
  const pools = poolsByHelpers.get(helpers);
  if (!pools) return;
  await Promise.all([...pools].map(async pool => {
    if (pool.ending || pool.ended) return;
    try { await withTimeout(pool.end(), timeoutMs, 'pool.end()'); } catch { /* best effort */ }
  }));
}

// ---------- issue classification ----------
//
// diagnoseBackendIssue decides whether a failure is the generated code's fault
// ('code': worth an automatic Gemini fix round) or the PC/network/source's
// ('environment': the user must act; a fix round cannot help). Rules, in order:
//  1. Stages 'syntax', 'static', 'unhandled' and 'files' are code.
//  2. PostgreSQL SQLSTATE codes: 57014 (statement timeout) follows rule 7;
//     08xxx connection, 28xxx authentication, 3D000 unknown database, 42501
//     permission, 53xxx resources (too many connections), 57P0x shutdown, 58xxx
//     are environment; 42xxx/22xxx/25006/0A000... (SQL written wrong) are code.
//     When the converter's own connection test with the same .env succeeds
//     (context.probes.postgres), 08/28/3D000 errors are code: the backend's
//     connection settings differ from the converter's.
//  3. Network (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, EHOSTUNREACH, ECONNRESET...)
//     and TLS/certificate errors are environment, except: code when the backend
//     connected to a host/port that is not the report's PostgreSQL target
//     (PBIP server with PG_HOST/PG_PORT applied), or when the converter's own
//     probe of the same source succeeds.
//  4. File errors (ENOENT, EACCES, EPERM, EBUSY, ENOTDIR, UNKNOWN...) on a known
//     PBIP source path (inventory/digest file sources, their folders, paths set in
//     .env) are environment, unless the converter can open that path itself
//     (then code). On any other path they are code: the backend guessed a path.
//     A missing file inside a known source folder is environment only when the
//     folder itself is unreachable.
//  5. JavaScript errors (TypeError, ReferenceError, SyntaxError, RangeError,
//     ERR_MODULE_NOT_FOUND, "is not a function", contract messages) are code;
//     a missing pg driver is environment.
//  6. Messages naming a .env key as missing/empty: environment when that key is
//     required and empty in .env (the user must fill it); code when the key is
//     optional (PG_HOST, PG_PORT, PG_DATABASE, PG_SSL_*...) or already set.
//  7. Timeouts (a check or server time limit, a statement timeout) are code
//     unless the healthcheck failed on connectivity or a probe of the report's
//     sources fails.
//  8. Plain-language health issues: a known source path or host plus an
//     access problem is environment (subject to the probes above); "no driver
//     / unsupported connector" is environment; otherwise the backend's own
//     { kind } is used when given, else code.
//
// context: { stage, env, inventory, digest, root, healthConnectivityFailed,
//            probes: { postgres: [{ ok, target?, error? }], files: { [normalizedPath]: { ok, code? } } } }
// The result's `probe` asks the caller to run probes that could change the verdict.

const NETWORK_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EHOSTDOWN', 'ENETDOWN', 'ECONNABORTED', 'EPIPE']);
const TLS_CODE = /^(?:SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|CERT_[A-Z_]+|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+|EPROTO)$/;
const FILE_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'ENOTDIR', 'EISDIR', 'ELOOP', 'UNKNOWN', 'ENAMETOOLONG', 'EMFILE', 'ENFILE']);
const PG_TIMEOUT_SQLSTATE = /^57014$/;
const PG_ENV_SQLSTATE = /^(?:08[0-9A-Z]{3}|28[0-9A-Z]{3}|3D000|42501|53[0-9A-Z]{3}|57P0[1-4]|58[0-9A-Z]{3}|55P03)$/;
const PG_CODE_SQLSTATE = /^(?:42[0-9A-Z]{3}|22[0-9A-Z]{3}|0A000|21000|25006|2BP01|3F000|44000|23[0-9A-Z]{3}|0LP01|2F[0-9A-Z]{3})$/;
const CODE_ERROR_NAMES = /^(?:SyntaxError|ReferenceError|TypeError|RangeError|URIError|EvalError|AggregateError|ContractError)$/;
const CODE_ERROR_CODES = /^(?:ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_UNSUPPORTED_DIR_IMPORT|ERR_UNKNOWN_FILE_EXTENSION|ERR_REQUIRE_ESM|ERR_INVALID_ARG_TYPE|ERR_INVALID_ARG_VALUE|ERR_INVALID_URL|ERR_IMPORT_ATTRIBUTE_MISSING|HC_CONTRACT|HC_STATIC|HC_PROCESS_EXIT)$/;
const CODE_TEXT = /\b(?:SyntaxError|ReferenceError|TypeError|RangeError)\b|is not a (?:function|constructor)|is not defined|is not iterable|Cannot read propert(?:y|ies) of|Cannot (?:set|destructure) propert|Cannot access '[^']+' before initialization|Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND|does not provide an export|Unexpected (?:token|identifier|end of)|must export|must return|did not return|returned rows as|instead of an object|cannot be sent as JSON|Maximum call stack|circular structure|called process\.exit|Invalid array length|heap out of memory|syntax error at or near|column "[^"]*" does not exist|relation "[^"]*" does not exist|function [^\s]+ does not exist|operator does not exist|invalid input syntax|division by zero|must appear in the GROUP BY|is ambiguous|read-only transaction/i;
const PG_DRIVER_TEXT = /Cannot find (?:package|module) '(?:pg|pg-[a-z-]+)'|PostgreSQL driver missing|PG_DRIVER_MISSING/i;
const PG_ENV_TEXT = /password authentication failed|no pg_hba\.conf entry|database "[^"]*" does not exist|permission denied for|role "[^"]*" does not exist|too many (?:connections|clients)|remaining connection slots are reserved|terminating connection due to|the database system is (?:starting up|shutting down|in recovery)|unsupported startup parameter/i;
const TLS_TEXT = /self[- ]signed certificate|unable to (?:get|verify) (?:local )?issuer|unable to verify the first certificate|certificate has expired|certificate is not yet valid|does not match certificate's altnames|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|ERR_TLS_CERT|does not support SSL|secure TLS connection/i;
const NETWORK_TEXT = /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EHOSTDOWN|ENETDOWN)\b|getaddrinfo|Connection terminated|timeout expired|socket hang up|network (?:path|name) (?:was not found|cannot be found)|Client network socket disconnected/i;
const TIMEOUT_TEXT = /did not finish within|statement timeout|Query read timeout|canceling statement due to|kept the process busy/i;
const FILE_CODE_TEXT = /\b(ENOENT|EACCES|EPERM|EBUSY|ENOTDIR|EISDIR|ELOOP)\b|\b(UNKNOWN): unknown error/;
const FS_PATH_TEXT = /\b(?:open|stat|lstat|scandir|opendir|access|readdir|realpath|readlink|copyfile|mkdir|rmdir|unlink|rename|watch)\s+'([^']+)'/;
const UNSUPPORTED_TEXT = /driver[^.\n]{0,60}not (?:available|installed)|no (?:driver|connector)[^.\n]{0,30}available|not supported by (?:this|the) converter|unsupported (?:connector|source)/i;
const CONNECT_WORDS = /unreachable|not reachable|cannot connect|could not connect|can't connect|unable to connect|connection (?:refused|timed out|failed)|\bVPN\b|\boffline\b|network (?:error|path|share)/i;
const ACCESS_WORDS = /cannot (?:read|open|access)|can't (?:read|open|access)|could not (?:read|open|access)|unable to (?:read|open|access)|not readable|unreadable|does not exist|doesn't exist|not found|no such file|missing|locked|in use|permission|access denied|unavailable/i;
const OPTIONAL_ENV_KEYS = new Set(['PG_HOST', 'PG_PORT', 'PG_DATABASE', 'PG_SSL_MODE', 'PG_SSL_CA_FILE', 'PG_MAX_ROWS', 'PG_NATIVE_QUERY_PARAMS_JSON']);
const CONNECTIVITY_RULES = new Set(['network', 'tls', 'database-access', 'source-file-unavailable', 'source-folder-unavailable', 'source-unreachable']);

function verdict(kind, rule, hint, note, probe) {
  return { kind, rule, ...(hint ? { hint } : {}), ...(note ? { note } : {}), ...(probe ? { probe } : {}) };
}

export function normalizeSourcePath(value) {
  let text = String(value ?? '').trim().replace(/^file:\/\/\/?/i, '').replaceAll('\\', '/');
  const unc = text.startsWith('//');
  text = text.replace(/\/{2,}/g, '/');
  if (unc) text = `/${text}`;
  return text.replace(/\/+$/, '').toLowerCase();
}

const knownCache = new WeakMap();

function knownPaths(context) {
  if (context && typeof context === 'object' && knownCache.has(context)) return knownCache.get(context);
  const files = new Map(), dirs = new Map();
  const addFile = file => {
    if (typeof file !== 'string' || !file.trim()) return;
    files.set(normalizeSourcePath(file), file);
    const dir = file.replace(/[\\/]+[^\\/]*$/, '');
    if (dir && dir !== file) dirs.set(normalizeSourcePath(dir), dir);
  };
  const addDir = dir => { if (typeof dir === 'string' && dir.trim()) dirs.set(normalizeSourcePath(dir), dir); };
  const inventory = context?.inventory ?? {}, found = context?.digest?.sources ?? {};
  for (const list of [inventory.fileSources, inventory.directCsvSources, found.files, found.directCsv]) for (const item of toList(list)) addFile(item?.path);
  for (const item of toList(inventory.folderSources ?? found.folders)) addDir(item?.path ?? item?.folder);
  for (const item of toList(inventory.dataFiles)) if (item?.path) addFile(context?.root ? path.join(context.root, item.path) : item.path);
  for (const [key, value] of Object.entries(context?.env ?? {})) {
    if (typeof value !== 'string' || !value.trim() || !/(?:_FILE|_DIR|_PATH|_FOLDER|_SHARE)$/i.test(key)) continue;
    if (/\.[A-Za-z0-9]{1,5}$/.test(value)) addFile(value); else addDir(value);
  }
  const result = { files, dirs };
  if (context && typeof context === 'object') knownCache.set(context, result);
  return result;
}

function knownPathIn(text, context) {
  const haystack = normalizeSourcePath(text);
  const { files, dirs } = knownPaths(context);
  let best = null;
  for (const map of [files, dirs]) for (const [normalized, original] of map) {
    if (normalized.length >= 4 && haystack.includes(normalized) && (!best || normalized.length > best.normalized.length)) best = { normalized, original };
  }
  return best?.original ?? null;
}

function postgresConnections(context) {
  const list = context?.inventory?.postgresSources ?? context?.digest?.sources?.postgres;
  return Array.isArray(list) ? list : [];
}

function webHosts(context) {
  const hosts = new Set();
  for (const item of toList(context?.inventory?.webSources ?? context?.digest?.sources?.web)) {
    const url = typeof item === 'string' ? item : item?.url ?? item?.host;
    if (!url) continue;
    try { hosts.add(new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase()); } catch { /* not a URL */ }
  }
  return hosts;
}

function expectedTargets(context) {
  const env = context?.env ?? {};
  const hosts = new Set(), ports = new Set(), targets = new Set();
  for (const connection of postgresConnections(context)) {
    try {
      // Placeholders only so the host/port logic runs; nothing connects here.
      const config = postgresConfig(connection, { ...env, PG_USER: env.PG_USER || 'user', PG_PASSWORD: env.PG_PASSWORD || 'password', PG_SSL_MODE: 'disable' });
      hosts.add(String(config.host).toLowerCase());
      ports.add(Number(config.port));
      targets.add(`${config.host}:${config.port}/${config.database}`);
    } catch { /* an unusable server string: no expectation */ }
  }
  const web = webHosts(context);
  return { hosts, ports, targets, web, postgresOnly: hosts.size > 0 && web.size === 0 };
}

const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function connectionTarget(info, text) {
  if (info?.address || info?.port) return { address: info.address ? String(info.address) : null, port: info.port ? Number(info.port) : null, hostname: info.hostname ?? null };
  if (info?.hostname) return { hostname: String(info.hostname), address: null, port: null };
  const connect = /\bconnect (?:ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET) (\[[^\]]+\]|[^\s:]+):(\d+)/.exec(text);
  if (connect) return { address: connect[1].replace(/^\[|\]$/g, ''), port: Number(connect[2]), hostname: null };
  const lookup = /getaddrinfo (?:ENOTFOUND|EAI_AGAIN) (\S+)/.exec(text);
  if (lookup) return { hostname: lookup[1], address: null, port: null };
  return null;
}

function isIpLiteral(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || value.includes(':');
}

function wrongTarget(target, expected) {
  if (!target || !expected.hosts.size) return false;
  if (target.port && expected.ports.size && !expected.ports.has(Number(target.port))) return true;
  const hosts = expected.hosts;
  const matches = name => {
    const lower = String(name).toLowerCase();
    return hosts.has(lower) || (LOCAL_NAMES.has(lower) && [...hosts].some(host => LOCAL_NAMES.has(host)));
  };
  if (target.hostname && !matches(target.hostname)) return true;
  if (target.address && [...hosts].every(host => isIpLiteral(host) || LOCAL_NAMES.has(host)) && !matches(target.address)) return true;
  return false;
}

function describeTarget(target) {
  if (target.hostname && !target.address) return target.hostname;
  return `${target.address ?? target.hostname}${target.port ? `:${target.port}` : ''}`;
}

function postgresProbe(context) {
  const list = context?.probes?.postgres;
  if (!Array.isArray(list) || !list.length) return { state: 'none' };
  const failed = list.find(item => !item.ok);
  if (failed) return { state: 'failed', error: failed.error ?? {} };
  return { state: 'ok', targets: list.map(item => item.target).filter(Boolean) };
}

function failedProbe(context) {
  const pg = postgresProbe(context);
  if (pg.state === 'failed') return { hint: postgresHint(pg.error) };
  for (const [file, probe] of Object.entries(context?.probes?.files ?? {})) {
    if (!probe.ok) return { hint: fileHint(probe.code, file) };
  }
  return null;
}

function converterConnectedNote(targets) {
  return `[The converter's own connection test with the same .env settings succeeded${targets?.length ? ` (${targets.join(', ')})` : ''}, so the backend's connection settings differ: build connections with helpers.postgres.createPool(helpers.postgres.connections[i]) instead of your own pg configuration.]`;
}

function fileHint(code, file) {
  const where = file ? ` (${file})` : '';
  if (code === 'EBUSY') return `A source file is locked by another program${where}. Close it in Excel (or the program using it) and rerun.`;
  if (code === 'EACCES' || code === 'EPERM') return `Your Windows account cannot read a source file${where}. Ask for read access or copy it to a readable folder and update the PBIP path.`;
  return `A source file or folder is not reachable from this PC${where}. Connect to VPN or map the network share, check that the path in the PBIP (or its M parameter) exists, then rerun.`;
}

function fileVerdict(filePath, code, context, { plain = false } = {}) {
  const normalized = normalizeSourcePath(filePath);
  const { files, dirs } = knownPaths(context);
  const probe = context?.probes?.files?.[normalized];
  if (files.has(normalized) || dirs.has(normalized)) {
    if (probe?.ok) return verdict('code', 'converter-can-read', null, `[The converter itself can open ${filePath}, so the backend builds or opens this path incorrectly; use the exact path from helpers.inventory.fileSources (with its csvOptions).]`);
    if (probe && !probe.ok) return verdict('environment', 'source-file-unavailable', fileHint(probe.code ?? code, filePath));
    return verdict('environment', 'source-file-unavailable', fileHint(code, filePath), null, { file: filePath });
  }
  const parent = [...dirs.keys()].filter(dir => normalized.startsWith(`${dir}/`)).sort((a, b) => b.length - a.length)[0];
  if (parent) {
    const folderProbe = context?.probes?.files?.[parent];
    if (folderProbe && !folderProbe.ok) return verdict('environment', 'source-folder-unavailable', fileHint(folderProbe.code, dirs.get(parent)));
    if (!folderProbe) return verdict('code', 'unknown-path', null, `[${filePath} is not one of the report's source files; use the exact paths from helpers.inventory.fileSources.]`, { file: dirs.get(parent) });
  }
  if (plain) return verdict('code', 'unknown-path');
  const list = [...files.values()].slice(0, 5);
  return verdict('code', 'unknown-path', null, `[${filePath} is not one of the report's source files${list.length ? ` (${list.join(', ')}${files.size > 5 ? ', ...' : ''})` : ''}; use the exact paths from helpers.inventory.fileSources / helpers.digest.sources.files.]`);
}

function connectivityVerdict(info, text, context, family) {
  const expected = expectedTargets(context);
  const target = connectionTarget(info, text);
  if (expected.postgresOnly && wrongTarget(target, expected)) {
    return verdict('code', 'wrong-target', null, `[The backend connected to ${describeTarget(target)}, but this report's PostgreSQL source is ${[...expected.targets].join(', ')} (PBIP server with PG_HOST/PG_PORT from .env applied). Build connections with helpers.postgres.createPool(helpers.postgres.connections[i]).]`);
  }
  const postgresRelated = expected.hosts.size > 0 && (expected.postgresOnly || /postgres|\bpg\b|sqlstate|:5432\b/i.test(text) || (target?.hostname && expected.hosts.has(String(target.hostname).toLowerCase())));
  if (postgresRelated) {
    const probe = postgresProbe(context);
    if (probe.state === 'ok') return verdict('code', 'converter-can-connect', null, converterConnectedNote(probe.targets));
    if (probe.state === 'failed') return verdict('environment', family, postgresHint(probe.error));
    return verdict('environment', family, postgresHint({ code: info?.code, message: text }), null, 'postgres');
  }
  if (family === 'tls') return verdict('environment', 'tls', 'The source server certificate is not trusted by this PC. Ask IT for the organization root CA and install it, or set NODE_EXTRA_CA_CERTS before running setup.');
  return verdict('environment', 'network', 'A data source host cannot be reached from this PC. Connect to VPN or check network/firewall access, then rerun.');
}

function databaseVerdict(code, text, context) {
  const probe = postgresProbe(context);
  const settingsLike = /^(?:08|28|3D000)/.test(code ?? '') || /password authentication failed|no pg_hba\.conf entry|database "[^"]*" does not exist|role "[^"]*" does not exist/i.test(text);
  if (probe.state === 'ok' && settingsLike) return verdict('code', 'converter-can-connect', null, converterConnectedNote(probe.targets));
  if (probe.state === 'failed') return verdict('environment', 'database-access', postgresHint(probe.error));
  return verdict('environment', 'database-access', postgresHint({ code, message: text }), null, settingsLike && postgresConnections(context).length ? 'postgres' : undefined);
}

function timeoutVerdict(context) {
  if (context?.healthConnectivityFailed) return verdict('environment', 'source-unreachable', 'The report\'s data source did not answer (see the healthcheck problems). Check VPN/network access, then rerun.');
  const failed = failedProbe(context);
  if (failed) return verdict('environment', 'source-unreachable', failed.hint);
  const hasSources = postgresConnections(context).length > 0 || knownPaths(context).files.size > 0;
  if (!context?.probes && hasSources) return verdict('code', 'slow-or-stuck', null, null, 'all');
  return verdict('code', 'slow-or-stuck', null, context?.probes && hasSources ? '[The report\'s sources answered the converter\'s own quick test, so this query is too slow or never finishes: aggregate in SQL, filter early, avoid per-row queries, and do not read large files synchronously.]' : null);
}

function envKeyVerdict(text, context) {
  if (!/\.env|missing|empty|not set|required|undefined|blank|fill/i.test(text)) return null;
  const keys = [...new Set([...text.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g)].map(match => match[1]))]
    .filter(key => !/^(?:ERR_|HC_TIMEOUT|HC_BLOCKED|HC_CONTRACT|UNABLE_TO|SELF_SIGNED|DEPTH_ZERO|CERT_)/.test(key));
  if (!keys.length) return null;
  const env = context?.env ?? {};
  if (keys.includes('PG_ALLOW_NATIVE_QUERIES') && env.PG_ALLOW_NATIVE_QUERIES !== 'true') return verdict('environment', 'native-sql-opt-in', postgresHint('PG_ALLOW_NATIVE_QUERIES'));
  const missing = keys.filter(key => !OPTIONAL_ENV_KEYS.has(key) && !String(env[key] ?? '').trim());
  if (missing.length) return verdict('environment', 'missing-env-value', `Fill ${missing.join(', ')} in gemini/.env, then rerun.`);
  const optional = keys.filter(key => OPTIONAL_ENV_KEYS.has(key) && !String(env[key] ?? '').trim());
  if (optional.length) return verdict('code', 'optional-env-key', null, `[${optional.join(', ')} is optional and empty in .env: the PBIP supplies that value, and helpers.postgres.config()/createPool() already apply it.]`);
  return verdict('code', 'env-value-present', null, `[${keys.join(', ')} is set in .env; read it from the env argument, not process.env.]`);
}

function issueInput(issue, context) {
  if (issue && typeof issue === 'object' && !(issue instanceof Error) && ('stage' in issue || 'error' in issue || 'declaredKind' in issue)) {
    const error = issue.error instanceof Error ? errorInfo(issue.error) : issue.error && typeof issue.error === 'object' ? issue.error : null;
    return { stage: issue.stage ?? context.stage, message: issueText(issue.message ?? error?.message ?? ''), error, declaredKind: issue.declaredKind, path: issue.path };
  }
  if (issue instanceof Error || (issue && typeof issue === 'object' && (typeof issue.code === 'string' || typeof issue.name === 'string'))) {
    const info = errorInfo(issue);
    return { stage: context.stage, message: errorText(info), error: info };
  }
  return { stage: context.stage, message: issueText(issue ?? ''), error: context.error ? errorInfo(context.error) : null, declaredKind: context.declaredKind };
}

export function diagnoseBackendIssue(issue, context = {}) {
  const ctx = context && typeof context === 'object' ? context : {};
  const input = issueInput(issue, ctx);
  const info = input.error ?? {};
  const code = typeof info.code === 'string' ? info.code : info.code !== undefined ? String(info.code) : '';
  const text = [input.message, info.message !== input.message ? info.message : '', code].filter(Boolean).join(' ');
  if (['syntax', 'static', 'unhandled', 'files'].includes(input.stage)) return verdict('code', input.stage === 'unhandled' ? 'unhandled-async-error' : input.stage);
  if (/^[0-9A-Z]{5}$/.test(code) && !FILE_CODES.has(code) && !NETWORK_CODES.has(code)) {
    if (PG_TIMEOUT_SQLSTATE.test(code)) return timeoutVerdict(ctx);
    if (PG_ENV_SQLSTATE.test(code)) return databaseVerdict(code, text, ctx);
    if (PG_CODE_SQLSTATE.test(code)) return verdict('code', 'sql-error');
  }
  if (code === 'HC_TIMEOUT' || code === 'HC_BLOCKED') return timeoutVerdict(ctx);
  // The converter's Excel reader: a sheet/table the backend asked for that does not exist is a code
  // problem (preflight already checked the ones the report navigates to); an unreadable file is not.
  if (code === 'HC_EXCEL_ITEM') return verdict('code', 'excel-item', null, '[Use the exact item and kind listed in helpers.inventory.fileSources[].excel.items (and useHeaders), not a guessed sheet name.]');
  if (/^HC_EXCEL_(?:ENCRYPTED|FORMAT|TOO_LARGE)$/.test(code)) return verdict('environment', 'excel-file', excelErrorHint({ code }));
  if (code === 'PG_DRIVER_MISSING' || PG_DRIVER_TEXT.test(text)) return verdict('environment', 'driver-missing', postgresHint('driver missing'));
  if (NETWORK_CODES.has(code)) return connectivityVerdict(info, text, ctx, 'network');
  if (TLS_CODE.test(code)) return connectivityVerdict(info, text, ctx, 'tls');
  const filePath = info.path ?? input.path ?? FS_PATH_TEXT.exec(text)?.[1] ?? null;
  if (FILE_CODES.has(code) && filePath) return fileVerdict(filePath, code, ctx);
  if (CODE_ERROR_NAMES.test(info.name ?? '') || CODE_ERROR_CODES.test(code) || CODE_TEXT.test(text)) return verdict('code', 'code-error');
  if (PG_ENV_TEXT.test(text)) return databaseVerdict(null, text, ctx);
  if (TLS_TEXT.test(text)) return connectivityVerdict(info, text, ctx, 'tls');
  if (NETWORK_TEXT.test(text)) return connectivityVerdict(info, text, ctx, 'network');
  if (TIMEOUT_TEXT.test(text)) return timeoutVerdict(ctx);
  const textFileCode = FILE_CODE_TEXT.exec(text);
  if (textFileCode && filePath) return fileVerdict(filePath, textFileCode[1] ?? textFileCode[2], ctx);
  const envKey = envKeyVerdict(text, ctx);
  if (envKey) return envKey;
  if (UNSUPPORTED_TEXT.test(text)) return verdict('environment', 'unsupported-source', 'This report uses a source type the converter cannot read. Choose pages that do not use it, or set HC_ALLOW_UNSUPPORTED_CONNECTORS=true in gemini/.env to build it as a labeled placeholder.');
  const known = knownPathIn(text, ctx);
  if (known && (ACCESS_WORDS.test(text) || CONNECT_WORDS.test(text) || textFileCode)) return fileVerdict(known, textFileCode?.[1] ?? 'ENOENT', ctx, { plain: true });
  if (CONNECT_WORDS.test(text)) return connectivityVerdict(info, text, ctx, 'network');
  if (input.declaredKind === 'environment' || input.declaredKind === 'code') return verdict(input.declaredKind, 'declared-by-backend');
  return verdict('code', 'default');
}

// 'environment' (the user must fix the PC, network, .env or source) or 'code'
// (the generated backend is wrong). `message` may be a string, an Error, or an
// issue { stage, message, error, declaredKind, path }. See diagnoseBackendIssue.
export function classifyBackendIssue(message, context = {}) {
  return diagnoseBackendIssue(message, context).kind;
}

// ---------- source probes ----------

async function probePath(file, timeoutMs) {
  try {
    const stat = await withTimeout(fs.promises.stat(file), timeoutMs, `Checking ${file}`);
    if (stat.isDirectory()) {
      const dir = await withTimeout(fs.promises.opendir(file), timeoutMs, `Listing ${file}`);
      await dir.close();
    } else {
      const handle = await withTimeout(fs.promises.open(file, 'r'), timeoutMs, `Opening ${file}`);
      await handle.close();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.code === 'HC_TIMEOUT' ? 'ETIMEDOUT' : error.code ?? 'UNKNOWN', message: error.message };
  }
}

// Tests the report's own sources with the converter's code, to tell a broken
// backend from an unreachable source. requests: { postgres, all, files: Set }.
export async function probeReportSources(requests, context, { timeoutMs = 15_000, deadline = Date.now() + 60_000 } = {}) {
  const probes = { files: {} };
  const budget = () => Math.max(1000, Math.min(timeoutMs, deadline - Date.now()));
  const jobs = [];
  const connections = postgresConnections(context);
  if ((requests.postgres || requests.all) && connections.length) {
    const unique = [...new Map(connections.map(item => [`${item?.server}\0${item?.database}`, item])).values()];
    jobs.push(Promise.all(unique.map(async connection => {
      try {
        const info = await withTimeout(testPostgresConnection(connection, context.env ?? {}, { timeoutMs: budget() }), budget() + 2000, 'PostgreSQL connection test');
        return { server: connection?.server, database: connection?.database, ok: true, target: `${info.host}:${info.port}/${info.database}` };
      } catch (error) {
        return { server: connection?.server, database: connection?.database, ok: false, error: errorInfo(error) };
      }
    })).then(list => { probes.postgres = list; }));
  }
  const files = new Set(requests.files ?? []);
  if (requests.all) for (const file of [...knownPaths(context).files.values()].slice(0, 20)) files.add(file);
  for (const file of files) jobs.push(probePath(file, budget()).then(result => { probes.files[normalizeSourcePath(file)] = result; }));
  await Promise.all(jobs);
  return probes;
}

// ---------- static reading of backend.mjs ----------

// Contract problems visible in the source text, with line numbers. Issues are
// code problems; warnings are listed as suspicious.
export function scanBackendSource(text) {
  const issues = [], warnings = [];
  let inBlock = false;
  String(text ?? '').split(/\r?\n/).forEach((raw, index) => {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) return;
      line = line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\/\*.*?\*\//g, ' ');
    const open = line.indexOf('/*');
    if (open >= 0) { line = line.slice(0, open); inBlock = true; }
    if (/^\s*\/\//.test(line)) return;
    const n = index + 1;
    for (const match of line.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(['"`])([^'"`]+)\1/g)) {
      const spec = match[2];
      if (/^\.\.?\//.test(spec) || /^[a-zA-Z]:[\\/]|^\/|^file:/i.test(spec)) {
        // Modules next to backend.mjs travel with it; anything else breaks once the report folder moves.
        if (/^\.\/[^./\\][^\\]*$/.test(spec) && !spec.includes('..')) continue;
        issues.push({ line: n, rule: 'relative-import', message: `backend.mjs line ${n} imports ${spec}, a path outside output/dynamic. The report folder is moved after the build, so this import breaks; use helpers (helpers.core, helpers.sources, helpers.postgres) instead.` });
        continue;
      }
      const bare = spec.replace(/^node:/, '').split('/')[0];
      if (!spec.startsWith('node:') && !builtinModules.includes(bare) && spec !== 'pg') warnings.push({ line: n, rule: 'package-import', message: `line ${n}: imports the npm package ${spec}; only Node built-ins and pg are installed.` });
      if (/^(?:child_process|cluster|worker_threads)$/.test(bare)) warnings.push({ line: n, rule: 'process-spawn', message: `line ${n}: imports ${spec}; a backend must not start other processes.` });
    }
    if (/['"`][^'"`\n]*\b(?:report-digest|inventory|live-(?:build|interpretation|run|review|final-review|selfcheck))\.json\b/.test(line)) {
      issues.push({ line: n, rule: 'runtime-work-file', message: `backend.mjs line ${n} reads a work/ file at runtime. At runtime the scoped copy lives elsewhere (work/scopes/<scope>/), so this reads a missing or wrong file; use helpers.digest and helpers.inventory instead.` });
    }
    if (/\bprocess\.env\b/.test(line)) warnings.push({ line: n, rule: 'process-env', message: `line ${n}: reads process.env; read settings only from the env argument.` });
  });
  return { issues, warnings };
}

// ---------- result inspection (runs in the check child) ----------

function columnName(column) {
  if (typeof column === 'string') return column;
  if (typeof column === 'number') return String(column);
  if (column && typeof column === 'object') {
    const name = column.name ?? column.field ?? column.key ?? column.id ?? column.column;
    return name === undefined || name === null ? null : String(name);
  }
  return null;
}

function jsonReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function valueProblem(value) {
  if (typeof value === 'bigint') return 'BigInt values (sent as strings)';
  if (typeof value === 'function' || typeof value === 'symbol') return `${typeof value} values (dropped from JSON)`;
  if (typeof value === 'number' && !Number.isFinite(value)) return 'NaN/Infinity (sent as null)';
  if (value instanceof Date) return 'Date objects (sent as UTC timestamps; send dates as "YYYY-MM-DD" strings)';
  if (value instanceof Map || value instanceof Set) return 'Map/Set values (sent as {})';
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return 'binary values';
  return null;
}

function isBlank(value) {
  return value === null || value === undefined || value === '' || (typeof value === 'number' && Number.isNaN(value));
}

// Contract errors, warnings, a short sample and counts for one query() result.
export function analyzeQueryResult(result, limit = QUERY_ROW_LIMIT) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { contractError: `returned ${describeType(result)} instead of an object { rows, columns, placeholder, limitations }` };
  if (!Array.isArray(result.rows)) return { contractError: `returned rows as ${describeType(result.rows)}; the contract requires rows to be an array` };
  let json;
  try { json = JSON.stringify(result, jsonReplacer); } catch (error) { return { contractError: `returned a value that cannot be sent as JSON (${error.message})` }; }
  const placeholder = result.placeholder === true || result.placeholder === 'true';
  const limitations = toList(result.limitations).map(issueText);
  const suspicious = [];
  if (result.placeholder !== undefined && typeof result.placeholder !== 'boolean') suspicious.push({ kind: 'shape', message: `placeholder is ${describeType(result.placeholder)}; use true or false` });
  if (result.limitations !== undefined && !Array.isArray(result.limitations)) suspicious.push({ kind: 'shape', message: 'limitations should be an array of strings' });
  const rows = result.rows;
  const declared = Array.isArray(result.columns) ? result.columns.map(columnName).filter(name => name !== null) : null;
  const keys = new Map();
  const scanned = rows.slice(0, 5000);
  let primitiveRows = 0;
  for (const row of scanned) {
    let entries;
    if (Array.isArray(row)) entries = row.map((value, index) => [declared?.[index] ?? String(index), value]);
    else if (row && typeof row === 'object') entries = Object.keys(row).map(key => [key, row[key]]);
    else { primitiveRows++; continue; }
    for (const [key, value] of entries) {
      const stats = keys.get(key) ?? { present: 0, blank: 0, decimalStrings: 0, nonBlank: 0, problems: new Set(), example: undefined };
      stats.present++;
      if (isBlank(value)) stats.blank++;
      else {
        stats.nonBlank++;
        if (typeof value === 'string' && /^[+-]?\d+\.\d+$/.test(value.trim())) { stats.decimalStrings++; stats.example ??= value; }
      }
      const problem = valueProblem(value);
      if (problem) stats.problems.add(problem);
      keys.set(key, stats);
    }
  }
  if (!placeholder) {
    if (!Array.isArray(result.columns)) suspicious.push({ kind: 'shape', message: 'no columns array; list the column names of the rows' });
    if (!rows.length) suspicious.push({ kind: 'empty', message: '0 rows with the default filters ({}); check the source path, CSV options, joins and filters' });
    if (rows.length > limit) suspicious.push({ kind: 'over-limit', message: `${rows.length} rows, more than the requested limit ${limit}` });
    if (primitiveRows) suspicious.push({ kind: 'shape', message: `${primitiveRows} row(s) are not objects` });
    const objectRows = scanned.length - primitiveRows;
    if (objectRows > 0) {
      for (const name of new Set([...(declared ?? []), ...keys.keys()])) {
        const stats = keys.get(name);
        if (stats && stats.present === objectRows && stats.blank === objectRows) suspicious.push({ kind: 'all-null-column', column: name, message: `column ${name} is null/empty/NaN in every row` });
        if (stats && stats.nonBlank && stats.decimalStrings === stats.nonBlank) suspicious.push({ kind: 'numeric-strings', column: name, message: `column ${name} holds numbers as text (e.g. "${stats.example}"); send JS numbers so the page can add and sort them` });
        for (const problem of stats?.problems ?? []) suspicious.push({ kind: 'non-json-values', column: name, message: `column ${name} has ${problem}` });
      }
      if (declared) {
        const extra = [...keys.keys()].filter(key => !declared.includes(key));
        const missing = declared.filter(name => !keys.has(name));
        if (extra.length) suspicious.push({ kind: 'extra-keys', message: `row keys not listed in columns: ${extra.slice(0, 10).join(', ')}` });
        if (missing.length) suspicious.push({ kind: 'missing-columns', message: `declared columns missing from every row: ${missing.slice(0, 10).join(', ')}` });
      }
    }
  }
  let sample = JSON.stringify(rows.slice(0, 3), jsonReplacer) ?? '[]';
  if (sample.length > 300) sample = `${sample.slice(0, 297)}...`;
  return { placeholder, limitations, rowCount: rows.length, columns: (declared ?? [...keys.keys()]).slice(0, 50), sample, suspicious, bytes: json.length };
}

function normalizeHealth(value) {
  const contract = { name: 'ContractError', code: 'HC_CONTRACT', message: 'healthcheck() result shape' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, sources: [], issues: [{ message: `healthcheck() returned ${describeType(value)} instead of { ok: true, sources: [...] }.`, error: contract }], warnings: [] };
  }
  const issues = toList(value.issues).map(item => ({
    message: issueText(item),
    ...(item && typeof item === 'object' && (item.kind === 'environment' || item.kind === 'code') ? { declaredKind: item.kind } : {}),
    ...(item && typeof item === 'object' && typeof item.path === 'string' ? { path: item.path } : {})
  }));
  const sourcesList = toList(value.sources).map(issueText);
  const warnings = [];
  if (value.issues !== undefined && !Array.isArray(value.issues)) warnings.push('healthcheck() issues should be an array');
  if (value.ok === true || value.ok === 'true') {
    if (value.ok !== true) warnings.push('healthcheck() ok should be the boolean true');
    return { ok: true, sources: sourcesList, issues, warnings };
  }
  if (!issues.length) issues.push({ message: 'healthcheck() did not return { ok: true } and listed no issues.', error: contract });
  return { ok: false, sources: sourcesList, issues, warnings };
}

// ---------- the check child ----------

async function runPool(items, size, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

async function childChecks(input, { send, redact, inFlight }) {
  const { backendFile, root, inputDir, env, inventory, digest, limit, concurrency, timeouts, tasks, isolate, first, collectRows } = input;
  const issue = (stage, message, error, extra = {}) => send({ type: 'issue', issue: { stage, message: redact(message), ...(error ? { error: redactInfo(error, redact) } : {}), ...extra } });
  const progress = (text, level = 'info') => send({ type: 'progress', text: redact(text), level });
  let counter = 0;
  const op = async (stage, label, timeoutMs, fn, extra = {}) => {
    const key = `${stage}:${++counter}`;
    // Delivered before the call starts, so the parent can blame a call that blocks.
    await send({ type: 'op-start', key, stage, label, timeoutMs, ...extra });
    try { return await withTimeout(Promise.resolve().then(fn), timeoutMs, label); }
    finally { send({ type: 'op-end', key }); }
  };
  const where = error => backendLocation(error, backendFile);
  if (first) {
    const syntax = await op('syntax', 'node --check backend.mjs', timeouts.syntaxMs, () => spawnSync(process.execPath, ['--check', backendFile], { encoding: 'utf8', timeout: timeouts.syntaxMs, windowsHide: true }));
    if (syntax.error || syntax.status !== 0) {
      const detail = `${syntax.stderr || ''}${syntax.stdout || ''}`.trim().split(/\r?\n/).filter(line => line.trim() && !/^\s+at\s|^Node\.js v\d/.test(line)).slice(0, 8).join('\n') || syntax.error?.message || `exit ${syntax.status}`;
      await issue('syntax', `SyntaxError in backend.mjs: ${detail}`, { name: 'SyntaxError', message: detail });
      return true;
    }
    let text = '';
    try { text = fs.readFileSync(backendFile, 'utf8'); } catch { /* reported by the import */ }
    const scan = scanBackendSource(text);
    for (const item of scan.issues) await issue('static', item.message, { name: 'ContractError', code: 'HC_STATIC', message: item.message });
    for (const item of scan.warnings) await send({ type: 'warning', warning: { kind: item.rule, message: redact(item.message) } });
    await progress(`Syntax OK${scan.issues.length ? `; ${scan.issues.length} contract problem(s) found in the code` : ''}.`, scan.issues.length ? 'warn' : 'info');
  }
  // Report value types (numbers, 'YYYY-MM-DD' dates) apply even to a hand-built pg Pool.
  try { await loadPg(); } catch { /* the backend's healthcheck reports a missing driver */ }
  const loadStarted = Date.now();
  let module;
  try { module = await op('load', 'importing backend.mjs', timeouts.importMs, () => import(pathToFileURL(backendFile).href)); }
  catch (error) {
    const info = errorInfo(error);
    await issue('load', `Importing backend.mjs failed: ${errorText(info)}${where(info)}`, info);
    return true;
  }
  if (typeof module?.createBackend !== 'function') {
    await issue('load', 'backend.mjs must export async function createBackend({ env, root, inputDir, helpers }).', { name: 'ContractError', code: 'HC_CONTRACT', message: 'missing createBackend export' });
    return true;
  }
  const helpers = backendHelpers({ env, inventory, digest, onPoolError: error => send({ type: 'pool-error', error: redactInfo(errorInfo(error), redact) }) });
  let backend;
  try { backend = await op('load', 'createBackend()', timeouts.createMs, () => module.createBackend({ env, root, inputDir, helpers })); }
  catch (error) {
    const info = errorInfo(error);
    await issue('load', `createBackend() failed: ${errorText(info)}${where(info)}`, info);
    await endPools(helpers);
    return true;
  }
  if (!backend || typeof backend.query !== 'function' || typeof backend.healthcheck !== 'function') {
    await issue('load', 'createBackend() must return an object with query() and healthcheck() functions (and optionally close()).', { name: 'ContractError', code: 'HC_CONTRACT', message: 'backend shape' });
    await endPools(helpers);
    return true;
  }
  const finish = async () => {
    if (typeof backend.close === 'function') {
      try { await op('close', 'close()', timeouts.closeMs, () => backend.close()); }
      catch (error) { await send({ type: 'warning', warning: { kind: 'close', message: redact(`close() failed: ${errorText(errorInfo(error))}`) } }); }
    }
    await endPools(helpers);
  };
  await progress(`backend.mjs imported and createBackend() finished in ${fmtMs(Date.now() - loadStarted)}.`);
  if (first) {
    const started = Date.now();
    let raw;
    try { raw = await op('healthcheck', 'healthcheck()', timeouts.healthMs, () => backend.healthcheck()); }
    catch (error) {
      const info = errorInfo(error);
      await issue('healthcheck', `healthcheck() threw: ${errorText(info)}${where(info)}`, info);
      await finish();
      return true;
    }
    const health = normalizeHealth(raw);
    const ms = Date.now() - started;
    await send({ type: 'health', health: { ok: health.ok, ms, sources: health.sources.map(redact), issues: health.issues.map(item => redact(item.message)) } });
    for (const warning of health.warnings) await send({ type: 'warning', warning: { kind: 'shape', message: warning } });
    if (!health.ok) {
      for (const item of health.issues) await issue('healthcheck', item.message, item.error ?? null, { ...(item.declaredKind ? { declaredKind: item.declaredKind } : {}), ...(item.path ? { path: redact(item.path) } : {}) });
      await finish();
      return true;
    }
    await progress(`healthcheck() passed in ${fmtMs(ms)}${health.sources.length ? `: ${oneLine(health.sources.join('; '), 200)}` : ''}.`);
  }
  await send({ type: 'setup-done' });
  const isolated = new Set(isolate ?? []);
  const runTask = async task => {
    inFlight.set(task.key, task.visualId);
    const started = Date.now();
    let result;
    try {
      result = await op('query', `query(${task.visualId})`, timeouts.queryMs, () => backend.query({ visualId: task.visualId, filters: JSON.parse(JSON.stringify(task.filters ?? {})), limit }), { taskKey: task.key, visualId: task.visualId });
    } catch (error) {
      inFlight.delete(task.key);
      await send({ type: 'query-failed', key: task.key, ms: Date.now() - started, error: redactInfo(errorInfo(error), redact) });
      return;
    }
    inFlight.delete(task.key);
    const ms = Date.now() - started;
    let analysis;
    try { analysis = analyzeQueryResult(result, limit); } catch (error) { analysis = { contractError: `returned a result that could not be inspected (${error.message})` }; }
    if (analysis.sample) analysis.sample = redact(analysis.sample);
    // The rows themselves, for the comparison with Power BI (default-state queries only).
    if (collectRows && !task.filters && Array.isArray(result?.rows) && !analysis.contractError) {
      try { analysis.rows = JSON.parse(JSON.stringify(result.rows.slice(0, limit), jsonReplacer)); } catch { /* reported as a contract error above */ }
    }
    if (analysis.limitations) analysis.limitations = analysis.limitations.map(redact);
    if (analysis.suspicious) analysis.suspicious = analysis.suspicious.map(item => ({ ...item, message: redact(item.message) }));
    await send({ type: 'query-done', key: task.key, ms, analysis });
  };
  // Queries suspected of blocking or crashing run alone first, so the culprit is identified.
  for (const task of tasks.filter(item => isolated.has(item.key))) await runTask(task);
  await runPool(tasks.filter(item => !isolated.has(item.key)), Math.max(1, concurrency), runTask);
  await finish();
  return false;
}

async function childMain() {
  const realExit = process.exit.bind(process);
  const send = message => new Promise(resolve => {
    if (!process.connected) { resolve(); return; }
    try { process.send(message, () => resolve()); } catch { resolve(); }
  });
  process.on('disconnect', () => realExit(0));
  const input = await new Promise(resolve => process.once('message', resolve));
  const redact = createRedactor(input.env);
  const inFlight = new Map();
  const reported = new Set();
  const onEscaped = origin => error => {
    const info = redactInfo(errorInfo(error), redact);
    const key = `${origin}:${info.message}`;
    if (reported.has(key) || reported.size > 20) return;
    reported.add(key);
    send({ type: 'unhandled', origin, error: info, inFlight: [...new Set(inFlight.values())] });
  };
  process.on('uncaughtException', onEscaped('uncaughtException'));
  process.on('unhandledRejection', onEscaped('unhandledRejection'));
  // A backend must never end the process; make the call fail inside that query instead.
  process.exit = code => {
    const error = new Error(`backend.mjs called process.exit(${code ?? ''}); a backend must never end the process.`);
    error.code = 'HC_PROCESS_EXIT';
    throw error;
  };
  let fatal = true;
  try { fatal = await childChecks(input, { send, redact, inFlight }); }
  catch (error) { await send({ type: 'issue', issue: { stage: 'crash', message: redact(`The check itself failed: ${errorText(errorInfo(error))}`) } }); }
  await send({ type: 'done', fatal });
  realExit(0);
}

// ---------- the parent side ----------

const activeChildren = new Set();
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => { for (const child of activeChildren) killProcessTree(child); });
}

function readLines(stream, onLine) {
  if (!stream) return;
  let partial = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    const lines = (partial + chunk).split(/\r?\n/);
    partial = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onLine(line.slice(0, 2000));
    if (partial.length > 64 * 1024) { onLine(partial.slice(0, 2000)); partial = ''; }
  });
  stream.on('end', () => { if (partial.trim()) onLine(partial.slice(0, 2000)); });
}

// Certificate and memory flags the converter was started with (setup adds --use-system-ca
// where Node supports it), so the check reaches TLS sources exactly like preflight and the server.
function inheritedNodeFlags() {
  return process.execArgv.filter(arg => /^--(?:use-system-ca|use-openssl-ca|use-bundled-ca|no-warnings|max-old-space-size=\d+|dns-result-order=[\w-]+|tls-[\w-]+(?:=\S+)?|openssl-[\w-]+(?:=\S+)?)$/.test(arg));
}

function childEnvironment() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runCheckChild({ input, cwd, deadline, graceMs, noticeMs, onMessage, onLine, onNotice }) {
  return new Promise(resolve => {
    const ops = new Map();
    const stderrTail = [];
    let killReason = null, settled = false, lingerTimer = null, child;
    try {
      child = spawn(process.execPath, [...inheritedNodeFlags(), thisFile, CHILD_FLAG], { cwd, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, env: childEnvironment() });
    } catch (error) {
      resolve({ spawnError: error, inFlight: [], stderrTail, killReason });
      return;
    }
    activeChildren.add(child);
    installExitHook();
    let timer = null;
    const finish = extra => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(lingerTimer);
      activeChildren.delete(child);
      resolve({ inFlight: [...ops.values()], stderrTail, killReason, ...extra });
    };
    const kill = reason => {
      if (!killReason) killReason = reason;
      killProcessTree(child);
    };
    readLines(child.stdout, line => onLine(line, 'stdout'));
    readLines(child.stderr, line => {
      stderrTail.push(line);
      if (stderrTail.length > 40) stderrTail.shift();
      onLine(line, 'stderr');
    });
    child.on('message', message => {
      if (message?.type === 'op-start') { ops.set(message.key, { ...message, startedAt: Date.now(), lastNotice: Date.now() }); return; }
      if (message?.type === 'op-end') { ops.delete(message.key); return; }
      if (message?.type === 'done') lingerTimer = setTimeout(() => kill('lingering'), 5000);
      onMessage(message);
    });
    child.on('error', error => { if (!child.pid) finish({ spawnError: error }); });
    child.on('close', (code, signal) => finish({ code, signal }));
    timer = setInterval(() => {
      const now = Date.now();
      if (now >= deadline) { kill('total-timeout'); return; }
      for (const op of ops.values()) {
        const elapsed = now - op.startedAt;
        // The child's own timer would have fired by now unless its event loop is blocked.
        if (elapsed > op.timeoutMs + graceMs) { kill('blocked'); return; }
        if (elapsed >= noticeMs && now - op.lastNotice >= noticeMs) {
          op.lastNotice = now;
          onNotice(op, elapsed);
        }
      }
    }, 200);
    child.send(input, error => { if (error) kill('send-failed'); });
  });
}

function visualTasks(inventory, filterCases) {
  const tasks = [], seen = new Set();
  for (const page of toList(inventory?.pages)) {
    for (const visual of toList(page?.visuals)) {
      if (visual?.role !== 'data' || typeof visual.id !== 'string' || seen.has(visual.id)) continue;
      seen.add(visual.id);
      tasks.push({ key: `default:${visual.id}`, visualId: visual.id, page: page.name ?? page.id ?? null, type: visual.type ?? 'visual', title: visual.title ?? null });
    }
  }
  const base = [...tasks];
  for (const [index, item] of toList(filterCases).entries()) {
    if (!item || !item.filters || typeof item.filters !== 'object' || Array.isArray(item.filters)) continue;
    const name = String(item.name ?? `filter case ${index + 1}`);
    for (const task of base) tasks.push({ ...task, key: `filter${index}:${task.visualId}`, caseName: name, filters: item.filters });
  }
  return { tasks, base };
}

function describeTask(task) {
  return `${task.visualId} (${task.type}${task.title ? ` "${task.title}"` : ''}${task.page ? ` on page "${task.page}"` : ''})`;
}

// Runs every check of backend.mjs in a child process and returns
// {
//   ok,                      // no issues (placeholders and suspicious results do not fail the check)
//   issues: [{ stage, visualId?, message, kind: 'code'|'environment', rule, hint? }],
//            stage: files | syntax | static | load | healthcheck | query | filters | unhandled | crash | timeout
//   placeholders: [{ visualId, page, type, title, limitations: string[] }],
//   visuals: [{ visualId, page, type, title, rowCount, ms, placeholder, columns, sample, suspicious: [{ kind, column?, message }] }],
//   suspicious: [{ visualId?, kind, column?, message }],   // warnings, not failures
//   health: { ok, ms, sources: string[], issues: string[] } | null,
//   filterChecks: [{ visualId, case, rowCount, ms, unchanged }],
//   checkedVisuals, totalVisuals, restarts, durationMs, output: string[] (last child output lines)
// }
// Options: backendFile (required), root, inputDir, env (.env values; never on a command
// line), inventory, digest, limit (2000), concurrency (4), perQueryTimeoutMs (90 s),
// totalTimeoutMs (15 min), importTimeoutMs (30 s), createTimeoutMs (60 s), healthTimeoutMs
// (= perQueryTimeoutMs), closeTimeoutMs (10 s), graceMs (5 s), noticeMs (15 s),
// maxRestarts (3), probeSources (true), probeTimeoutMs (15 s),
// filterCases ([{ name, filters }]: every data visual is also queried with these),
// onProgress(text, { level: 'info'|'warn', visualId?, stage? }), onOutput(line, 'stdout'|'stderr').
export async function checkBackend(options = {}) {
  const {
    backendFile, root = core.root, inputDir = core.inputDir, env = {}, inventory = {}, digest = null,
    limit = QUERY_ROW_LIMIT, concurrency = QUERY_CONCURRENCY, perQueryTimeoutMs = 90_000, totalTimeoutMs = 15 * 60_000,
    importTimeoutMs = 30_000, createTimeoutMs = 60_000, healthTimeoutMs = perQueryTimeoutMs, closeTimeoutMs = 10_000, syntaxTimeoutMs = 60_000,
    graceMs = 5_000, noticeMs = 15_000, maxRestarts = 3, probeSources = true, probeTimeoutMs = 15_000, filterCases = [],
    collectRows = false, onProgress, onOutput
  } = options;
  const started = Date.now();
  const deadline = started + totalTimeoutMs;
  const redact = createRedactor(env);
  const progress = (text, meta = {}) => { try { onProgress?.(redact(text), { level: 'info', ...meta }); } catch { /* a reporter must not break the check */ } };
  const raw = [], visuals = [], placeholders = [], suspicious = [], filterChecks = [], output = [];
  const escaped = new Set();
  let health = null;
  const { tasks, base } = visualTasks(inventory, filterCases);
  const byKey = new Map(tasks.map(task => [task.key, task]));
  const completed = new Set();
  let answered = 0;
  const total = tasks.length;
  const file = backendFile ? path.resolve(backendFile) : '';
  let restartsUsed = 0;

  const addQueryIssue = (task, message, error) => raw.push({ stage: task.caseName ? 'filters' : 'query', visualId: task.visualId, message, ...(error ? { error } : {}) });
  let setupDone = false, done = false;
  const onMessage = message => {
    switch (message?.type) {
      case 'progress': progress(message.text, { level: message.level ?? 'info' }); break;
      case 'issue': raw.push(message.issue); if (message.issue?.stage !== 'healthcheck') progress(`${message.issue.stage}: ${oneLine(message.issue.message)}`, { level: 'warn', stage: message.issue.stage }); break;
      case 'warning': suspicious.push(message.warning); break;
      case 'health':
        health = message.health;
        if (!health.ok) progress(`healthcheck() reported ${health.issues.length} problem(s): ${oneLine(health.issues.join(' | '))}`, { level: 'warn', stage: 'healthcheck' });
        break;
      case 'pool-error': {
        const text = `A PostgreSQL pool connection failed and was dropped (handled): ${errorText(message.error)}`;
        suspicious.push({ kind: 'pool-error', message: text });
        progress(text, { level: 'warn' });
        break;
      }
      case 'unhandled': {
        const info = message.error ?? {};
        const key = `${message.origin}:${info.message}`;
        if (escaped.has(key)) break;
        escaped.add(key);
        const ids = toList(message.inFlight);
        const text = `${message.origin === 'unhandledRejection' ? 'A rejected promise was never handled' : 'An error escaped the backend\'s awaited code'} ${ids.length ? `while query(${ids.join(', ')}) ran` : 'outside any backend call'}: ${errorText(info)}${backendLocation(info, file)}. Await every promise and handle 'error' events (for example use helpers.postgres.createPool, which does); in the served report this error is only logged and the request may never answer.`;
        raw.push({ stage: 'unhandled', ...(ids.length === 1 ? { visualId: ids[0] } : {}), message: text, error: info });
        progress(`unhandled error: ${oneLine(text)}`, { level: 'warn', stage: 'unhandled' });
        break;
      }
      case 'setup-done': setupDone = true; break;
      case 'query-done': {
        const task = byKey.get(message.key);
        if (!task || completed.has(task.key)) break;
        completed.add(task.key);
        const index = ++answered;
        const analysis = message.analysis ?? {};
        const label = `[${index}/${total}] ${describeTask(task)}${task.caseName ? ` with ${task.caseName}` : ''}`;
        if (analysis.contractError) {
          addQueryIssue(task, `query() for ${describeTask(task)}${task.caseName ? ` with ${task.caseName}` : ''} ${analysis.contractError}.`, { name: 'ContractError', code: 'HC_CONTRACT', message: analysis.contractError });
          progress(`${label}: FAILED: ${analysis.contractError}`, { level: 'warn', visualId: task.visualId });
          break;
        }
        if (task.caseName) {
          filterChecks.push({ visualId: task.visualId, case: task.caseName, rowCount: analysis.rowCount, ms: message.ms, sample: analysis.sample });
          progress(`${label}: ${analysis.rowCount} row(s) in ${fmtMs(message.ms)}`, { visualId: task.visualId });
          break;
        }
        const warnings = analysis.suspicious ?? [];
        visuals.push({ visualId: task.visualId, page: task.page, type: task.type, title: task.title, rowCount: analysis.rowCount, ms: message.ms, placeholder: analysis.placeholder === true, columns: analysis.columns ?? [], sample: analysis.sample ?? '[]', suspicious: warnings, ...(analysis.rows ? { rows: analysis.rows, limitations: analysis.limitations ?? [] } : {}) });
        for (const warning of warnings) suspicious.push({ visualId: task.visualId, ...warning, message: `${describeTask(task)}: ${warning.message}` });
        if (analysis.placeholder) placeholders.push({ visualId: task.visualId, page: task.page, type: task.type, title: task.title, limitations: analysis.limitations ?? [] });
        const note = analysis.placeholder ? ` - placeholder: ${oneLine((analysis.limitations ?? []).join('; ') || 'no reason given', 160)}` : warnings.length ? ` - warning: ${oneLine(warnings.map(item => item.message).join('; '), 160)}` : '';
        progress(`${label}: ${analysis.rowCount} row(s) in ${fmtMs(message.ms)}${note}`, { level: warnings.length ? 'warn' : 'info', visualId: task.visualId });
        break;
      }
      case 'query-failed': {
        const task = byKey.get(message.key);
        if (!task || completed.has(task.key)) break;
        completed.add(task.key);
        const index = ++answered;
        const text = `query() for ${describeTask(task)}${task.caseName ? ` with ${task.caseName}` : ''} failed after ${fmtMs(message.ms)}: ${errorText(message.error)}${backendLocation(message.error, file)}`;
        addQueryIssue(task, text, message.error);
        progress(`[${index}/${total}] ${describeTask(task)}: FAILED after ${fmtMs(message.ms)}: ${oneLine(errorText(message.error), 200)}`, { level: 'warn', visualId: task.visualId });
        break;
      }
      case 'done': done = true; break;
      default: break;
    }
  };

  if (!file || !fs.existsSync(file)) {
    raw.push({ stage: 'files', message: `${file ? path.basename(file) : 'backend.mjs'} is missing.` });
  } else {
    progress(`Checking ${path.basename(file)} in a separate process: syntax, import, createBackend(), healthcheck(), then ${base.length} data visual query(ies)${tasks.length > base.length ? ` plus ${tasks.length - base.length} filtered one(s)` : ''} with limit ${limit}, ${concurrency} at a time.`);
    const timeouts = { syntaxMs: syntaxTimeoutMs, importMs: importTimeoutMs, createMs: createTimeoutMs, healthMs: healthTimeoutMs, queryMs: perQueryTimeoutMs, closeMs: closeTimeoutMs };
    const isolated = new Set();
    let isolateNext = [], first = true, restarts = 0;
    const notChecked = () => {
      const left = tasks.filter(task => !completed.has(task.key));
      return left.length ? ` Not checked: ${left.slice(0, 10).map(task => task.visualId).join(', ')}${left.length > 10 ? `, and ${left.length - 10} more` : ''}.` : '';
    };
    for (;;) {
      const pending = tasks.filter(task => !completed.has(task.key));
      const ordered = [...pending.filter(task => isolateNext.includes(task.key)), ...pending.filter(task => !isolateNext.includes(task.key))];
      setupDone = false;
      done = false;
      const run = await runCheckChild({
        input: { backendFile: file, root, inputDir, env, inventory, digest, limit, concurrency, timeouts, tasks: ordered.map(({ key, visualId, filters }) => ({ key, visualId, filters })), isolate: isolateNext, first, collectRows },
        cwd: fs.existsSync(root) ? root : process.cwd(),
        deadline, graceMs, noticeMs,
        onMessage,
        onLine: (line, stream) => {
          const text = redact(line);
          output.push(`${stream}: ${text}`);
          if (output.length > 40) output.shift();
          try { onOutput?.(text, stream); } catch { /* ignore */ }
        },
        onNotice: (op, elapsed) => progress(`Still waiting for ${op.taskKey && byKey.get(op.taskKey) ? `query() for ${describeTask(byKey.get(op.taskKey))}` : op.label}: ${formatDuration(elapsed)} of ${formatDuration(op.timeoutMs)}.`, { visualId: op.visualId })
      });
      const wasFirst = first;
      first = false;
      isolateNext = [];
      if (done) break;
      if (run.spawnError) { raw.push({ stage: 'crash', message: `Could not start the check process: ${run.spawnError.message}` }); break; }
      const tail = run.stderrTail.slice(-6).map(redact).join(' | ');
      const exit = run.signal ? `signal ${run.signal}` : `exit code ${run.code}`;
      if (run.killReason === 'total-timeout') {
        raw.push({ stage: 'timeout', message: `The backend check did not finish within ${formatDuration(totalTimeoutMs)}${run.inFlight.length ? `; still waiting for ${run.inFlight.map(op => op.label).join(', ')}` : ''}.${notChecked()}`, error: { name: 'Error', code: 'HC_TIMEOUT', message: 'total check time limit' } });
        progress(`Stopped the backend check after ${formatDuration(totalTimeoutMs)}.${notChecked()}`, { level: 'warn', stage: 'timeout' });
        break;
      }
      const queryOps = run.inFlight.filter(op => op.taskKey && byKey.has(op.taskKey));
      if (!setupDone || !queryOps.length) {
        const op = run.inFlight.find(item => !item.taskKey) ?? run.inFlight[0];
        if (op?.stage === 'close') {
          suspicious.push({ kind: 'close', message: run.killReason === 'blocked' ? `close() did not finish within ${formatDuration(op.timeoutMs)} and kept the process busy.` : `The check process ended during close() (${exit}).` });
          break;
        }
        if (run.killReason === 'blocked' && op) {
          raw.push({ stage: op.stage === 'syntax' ? 'syntax' : op.stage, message: `${op.label} did not finish within ${formatDuration(op.timeoutMs)} and kept the process busy, so the check process was stopped (a loop that never ends, or heavy synchronous work such as reading a huge file with readFileSync${op.stage === 'load' ? ' at module load' : ''}).`, error: { name: 'Error', code: 'HC_BLOCKED', message: 'blocked' } });
        } else if (run.killReason !== 'lingering') {
          raw.push({ stage: 'crash', message: `The check process ended unexpectedly${op ? ` during ${op.label}` : ''} (${exit}).${tail ? ` Last output: ${tail}` : ''}` });
        }
        if (!setupDone && !wasFirst) progress('The backend could not be started again after a restart.', { level: 'warn' });
        if (!setupDone) break;
      } else {
        const suspects = queryOps.map(op => op.taskKey);
        if (suspects.length === 1 || suspects.every(key => isolated.has(key))) {
          for (const op of queryOps) {
            const task = byKey.get(op.taskKey);
            if (completed.has(task.key)) continue;
            completed.add(task.key);
            const index = ++answered;
            if (run.killReason === 'blocked') {
              addQueryIssue(task, `query() for ${describeTask(task)} did not finish within ${formatDuration(op.timeoutMs)} and kept the process busy, so the check process was stopped. Look for a loop that never ends or heavy synchronous work (for example parsing a large file with readFileSync) on this visual's code path.`, { name: 'Error', code: 'HC_BLOCKED', message: 'blocked' });
              progress(`[${index}/${total}] ${describeTask(task)}: BLOCKED the process for over ${formatDuration(op.timeoutMs)}; stopped it.`, { level: 'warn', visualId: task.visualId });
            } else {
              raw.push({ stage: 'crash', visualId: task.visualId, message: `The check process ended (${exit}) while query() for ${describeTask(task)} was running.${tail ? ` Last output: ${tail}` : ''}` });
              progress(`[${index}/${total}] ${describeTask(task)}: the check process ended (${exit}).`, { level: 'warn', visualId: task.visualId });
            }
          }
        } else {
          for (const key of suspects) isolated.add(key);
          isolateNext = suspects;
          progress(`The check process ${run.killReason === 'blocked' ? 'was blocked' : `ended (${exit})`} while ${suspects.length} queries ran; running those again one at a time to find the cause.`, { level: 'warn' });
        }
      }
      if (tasks.every(task => completed.has(task.key))) break;
      if (++restarts > maxRestarts) {
        raw.push({ stage: 'crash', message: `The check process had to be restarted ${maxRestarts} times; stopped.${notChecked()}` });
        break;
      }
      if (Date.now() >= deadline) {
        raw.push({ stage: 'timeout', message: `The backend check did not finish within ${formatDuration(totalTimeoutMs)}.${notChecked()}`, error: { name: 'Error', code: 'HC_TIMEOUT', message: 'total check time limit' } });
        break;
      }
      progress(`Restarting the check process for ${tasks.filter(task => !completed.has(task.key)).length} remaining query(ies).`, { level: 'warn' });
    }
    restartsUsed = restarts;
  }

  // Filtered queries that return exactly the default result for every visual suggest ignored filters.
  const defaults = new Map(visuals.map(item => [item.visualId, item]));
  for (const check of filterChecks) {
    const base = defaults.get(check.visualId);
    check.unchanged = Boolean(base) && base.rowCount === check.rowCount && base.sample === check.sample;
    delete check.sample;
  }
  for (const name of new Set(filterChecks.map(check => check.case))) {
    const list = filterChecks.filter(check => check.case === name);
    if (list.length && list.every(check => check.unchanged)) suspicious.push({ kind: 'filter-ignored', message: `Every visual returned exactly its default result with ${name}; the filters may be ignored or use a different shape than the page sends.` });
  }

  // Rows keyed by the visual's field queryRefs can be compared with Power BI; warn when none are used.
  const fieldRefs = new Map((digest?.pages ?? []).flatMap(page => (page.visuals ?? []).map(visual => [visual.id, Object.values(visual.fields ?? {}).flat().map(field => field?.queryRef).filter(Boolean)])));
  for (const visual of visuals) {
    const refs = fieldRefs.get(visual.visualId) ?? [];
    if (!refs.length || visual.placeholder || refs.some(ref => visual.columns.includes(ref))) continue;
    suspicious.push({ visualId: visual.visualId, kind: 'field-names', message: `${visual.visualId}: rows are not keyed by the visual's field names (${refs.slice(0, 4).join(', ')}${refs.length > 4 ? ', ...' : ''}), so they cannot be compared with Power BI.` });
  }

  const context = { env, inventory, digest, root };
  let prelim = raw.map(issue => diagnoseBackendIssue(issue, context));
  context.healthConnectivityFailed = raw.some((issue, index) => issue.stage === 'healthcheck' && prelim[index].kind === 'environment' && CONNECTIVITY_RULES.has(prelim[index].rule));
  prelim = raw.map(issue => diagnoseBackendIssue(issue, context));
  if (probeSources) {
    const requests = { postgres: false, all: false, files: new Set() };
    for (const item of prelim) {
      if (item.probe === 'postgres') requests.postgres = true;
      else if (item.probe === 'all') requests.all = true;
      else if (item.probe?.file) requests.files.add(item.probe.file);
    }
    if (requests.postgres || requests.all || requests.files.size) {
      progress('Testing the report\'s sources with the converter\'s own code to tell source problems from backend bugs...');
      context.probes = await probeReportSources(requests, context, { timeoutMs: probeTimeoutMs, deadline: Math.max(deadline, Date.now() + probeTimeoutMs) });
    }
  }
  const issues = raw.map(issue => {
    const diagnosis = diagnoseBackendIssue(issue, context);
    const message = redact(`${issue.message}${diagnosis.note ? ` ${diagnosis.note}` : ''}`);
    return {
      stage: issue.stage,
      ...(issue.visualId ? { visualId: issue.visualId } : {}),
      message: message.length > 2000 ? `${message.slice(0, 1997)}...` : message,
      kind: diagnosis.kind,
      rule: diagnosis.rule,
      ...(diagnosis.kind === 'environment' && diagnosis.hint ? { hint: redact(diagnosis.hint) } : {})
    };
  });
  const durationMs = Date.now() - started;
  const code = issues.filter(issue => issue.kind === 'code').length;
  progress(`Backend check finished in ${formatDuration(durationMs)}: ${visuals.length} of ${base.length} visual query(ies) answered, ${placeholders.length} placeholder(s), ${code} code issue(s), ${issues.length - code} source-access issue(s), ${suspicious.length} warning(s).`, { level: issues.length ? 'warn' : 'info' });
  return {
    ok: issues.length === 0,
    issues, placeholders, visuals, suspicious, health, filterChecks,
    checkedVisuals: visuals.length, totalVisuals: base.length,
    restarts: restartsUsed, durationMs, output
  };
}
// ---------- in-process loading for the report server ----------

// Imports backend.mjs (cache-busted), runs createBackend with timeouts and
// returns the backend object. Throws an Error with .stage ('load') and .kind.
// Use only after checkBackend passed: generated code then runs in this process.
export async function loadBackend({ backendFile, root = core.root, inputDir = core.inputDir, env = {}, inventory = {}, digest = null, importTimeoutMs = 30_000, createTimeoutMs = 60_000, onPoolError } = {}) {
  const fail = (error, prefix) => {
    const info = errorInfo(error);
    const wrapped = new Error(createRedactor(env)(`${prefix}${errorText(info)}${backendLocation(info, backendFile)}`));
    wrapped.stage = 'load';
    wrapped.kind = classifyBackendIssue({ stage: 'load', message: wrapped.message, error: info }, { env, inventory, digest, root });
    wrapped.cause = error;
    return wrapped;
  };
  try { await loadPg(); } catch { /* the backend reports a missing driver itself */ }
  let module;
  try {
    const stamp = fs.existsSync(backendFile) ? fs.statSync(backendFile).mtimeMs : 0;
    module = await withTimeout(import(`${pathToFileURL(path.resolve(backendFile)).href}?load=${stamp}-${Date.now()}`), importTimeoutMs, 'Importing backend.mjs');
  } catch (error) { throw fail(error, 'Importing backend.mjs failed: '); }
  if (typeof module?.createBackend !== 'function') throw fail({ name: 'ContractError', code: 'HC_CONTRACT', message: 'backend.mjs must export async function createBackend({ env, root, inputDir, helpers }).' }, '');
  const helpers = backendHelpers({ env, inventory, digest, onPoolError });
  let backend;
  try { backend = await withTimeout(module.createBackend({ env, root, inputDir, helpers }), createTimeoutMs, 'createBackend()'); }
  catch (error) { await endPools(helpers); throw fail(error, 'createBackend() failed: '); }
  if (!backend || typeof backend.query !== 'function' || typeof backend.healthcheck !== 'function') {
    await endPools(helpers);
    throw fail({ name: 'ContractError', code: 'HC_CONTRACT', message: 'createBackend() must return an object with query() and healthcheck() functions.' }, '');
  }
  if (typeof backend === 'object' || typeof backend === 'function') helpersByBackend.set(backend, helpers);
  return backend;
}

// Calls the backend's optional close() (bounded) and ends pools it made with helpers.postgres.createPool.
export async function closeBackend(backend, { timeoutMs = 10_000 } = {}) {
  if (!backend) return;
  if (typeof backend.close === 'function') {
    try { await withTimeout(Promise.resolve().then(() => backend.close()), timeoutMs, 'backend.close()'); } catch { /* best effort */ }
  }
  const helpers = helpersByBackend.get(backend);
  if (helpers) await endPools(helpers, timeoutMs);
}

if (process.argv[2] === CHILD_FLAG && typeof process.send === 'function') childMain();
