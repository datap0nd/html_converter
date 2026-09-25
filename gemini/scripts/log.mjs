import fs from 'node:fs';
import path from 'node:path';

// One run log shared by every module. Lines reach the console and the log file
// as they happen, so a stalled phase is visible immediately and the file can be
// sent as-is when something fails.
const startedAt = Date.now();
const secrets = new Set();
let logFile = null;
let echo = true;

export function startLogFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, '');
  logFile = file;
  return file;
}

export function currentLogFile() {
  return logFile;
}

export function setConsoleEcho(value) {
  echo = value !== false;
}

export function addSecret(value) {
  if (typeof value === 'string' && value.length > 3) secrets.add(value);
}

export function addSecretsFromEnv(env = {}) {
  for (const [key, value] of Object.entries(env)) {
    if (/(PASSWORD|SECRET|TOKEN|API_KEY|CONNECTION_STRING|CREDENTIAL)/i.test(key)) addSecret(value);
  }
}

export function redact(text) {
  let result = String(text ?? '');
  for (const secret of secrets) result = result.split(secret).join('[redacted]');
  return result;
}

// Windows PowerShell decodes piped child output with the OEM code page, which
// garbles UTF-8. Console lines stay ASCII; the log file keeps the original text.
export function consoleSafe(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?');
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function clock() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function write(level, scope, message, { consoleOnly = false, fileOnly = false } = {}) {
  const text = redact(message);
  const prefix = scope ? `[${scope}] ` : '';
  const marker = level === 'error' ? 'ERROR: ' : level === 'warn' ? 'WARNING: ' : '';
  const lines = text.split(/\r?\n/);
  if (logFile && !consoleOnly) {
    const stamp = `${new Date().toISOString()} +${formatDuration(Date.now() - startedAt)}`;
    try { fs.appendFileSync(logFile, lines.map(line => `${stamp} ${level.toUpperCase().padEnd(5)} ${prefix}${line}`).join('\n') + '\n'); }
    catch { /* A locked log file must never stop the conversion. */ }
  }
  // Everything goes to stdout: Windows PowerShell turns child stderr lines into
  // terminating errors when its output is redirected.
  if (echo && !fileOnly) process.stdout.write(lines.map(line => consoleSafe(`${clock()} ${prefix}${marker}${line}`)).join('\n') + '\n');
}

export const log = {
  info: (scope, message, options) => write('info', scope, message, options),
  warn: (scope, message, options) => write('warn', scope, message, options),
  error: (scope, message, options) => write('error', scope, message, options),
  // Detail that belongs in the file but would flood the console.
  detail: (scope, message) => write('debug', scope, message, { fileOnly: true })
};
