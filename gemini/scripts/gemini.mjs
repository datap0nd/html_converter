import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Environment names Gemini CLI itself may need for authentication or routing.
const GEMINI_ENV = /^(GEMINI_[A-Z0-9_]*|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_[A-Z0-9_]*|GOOGLE_GENAI_[A-Z0-9_]*|GOOGLE_GEMINI_BASE_URL|GOOGLE_VERTEX_BASE_URL)$/;

function npmGeminiEntry(env) {
  const searchPath = env.PATH || env.Path || env.path || '';
  const directories = new Set(searchPath.split(path.delimiter).filter(Boolean));
  if (env.APPDATA) directories.add(path.join(env.APPDATA, 'npm'));
  for (const prefix of [env.npm_config_prefix, env.NPM_CONFIG_PREFIX]) if (prefix) directories.add(prefix);
  for (const directory of directories) {
    const shim = path.join(directory, 'gemini.cmd');
    if (!fs.existsSync(shim)) continue;
    const packageDir = path.join(directory, 'node_modules', '@google', 'gemini-cli');
    const entry = packageEntry(packageDir);
    if (entry) return entry;
  }
  return null;
}

function packageEntry(packageDir) {
  const packageFile = path.join(packageDir, 'package.json');
  if (!fs.existsSync(packageFile)) return null;
  try {
    const bin = JSON.parse(fs.readFileSync(packageFile, 'utf8')).bin?.gemini;
    if (typeof bin !== 'string') return null;
    const entry = path.resolve(packageDir, bin);
    if (entry.startsWith(path.resolve(packageDir) + path.sep) && fs.existsSync(entry)) return entry;
  } catch { /* This is not the standard npm Gemini CLI install. */ }
  return null;
}

function onPath(name, env) {
  const searchPath = env.PATH || env.Path || env.path || '';
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  return null;
}

// Where the Gemini CLI would be launched from, without executing it.
// HC_GEMINI_ENTRY points at a JavaScript entry (tests, or a pinned install).
export function geminiCliInfo(env = process.env) {
  if (env.HC_GEMINI_ENTRY) {
    const entry = path.resolve(env.HC_GEMINI_ENTRY);
    return { found: fs.existsSync(entry), entry, command: process.execPath, prefix: [entry], version: packageVersion(entry), source: 'HC_GEMINI_ENTRY' };
  }
  if (process.platform === 'win32') {
    const entry = npmGeminiEntry(env);
    if (entry) return { found: true, entry, command: process.execPath, prefix: [entry], version: packageVersion(entry), source: 'npm global install' };
    const shim = onPath('gemini.cmd', env) || onPath('gemini.exe', env) || onPath('gemini.bat', env);
    return { found: Boolean(shim), entry: shim, command: env.ComSpec || process.env.ComSpec || 'cmd.exe', prefix: null, version: null, source: shim ? 'PATH shim' : null };
  }
  const bin = onPath('gemini', env);
  let entry = bin;
  try { if (bin) entry = fs.realpathSync(bin); } catch { /* keep the PATH entry */ }
  return { found: Boolean(bin), entry, command: bin || 'gemini', prefix: [], version: entry ? packageVersion(entry) : null, source: bin ? 'PATH' : null };
}

function packageVersion(entry) {
  if (!entry) return null;
  let directory = path.dirname(entry);
  for (let depth = 0; depth < 5; depth++) {
    const file = path.join(directory, 'package.json');
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (json.name === '@google/gemini-cli' || json.bin?.gemini) return json.version ?? null;
    } catch { /* not a package root */ }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

export function geminiChildEnv(extra = {}, base = process.env) {
  const childEnv = { ...base, NO_COLOR: '1', ...extra };
  // The model may need its own auth, but must never inherit source credentials.
  for (const key of Object.keys(childEnv)) {
    if (GEMINI_ENV.test(key)) continue;
    if (/^(PG_|SQL_|MYSQL_|ORACLE_|ODBC_|SOURCE_|AWS_|AZURE_)/.test(key) || /(PASSWORD|SECRET|TOKEN|CREDENTIAL|CONNECTION_STRING|API_KEY)/i.test(key)) delete childEnv[key];
  }
  return childEnv;
}

function invocation(args, options = {}) {
  const env = geminiChildEnv(options.env);
  const info = options.cli ?? geminiCliInfo(env);
  const common = { cwd: options.cwd, env, windowsHide: true };
  if (info.prefix) return { command: info.command, args: [...info.prefix, ...args], common, info };
  // npm installs Gemini CLI as gemini.cmd on Windows. Invoke cmd explicitly;
  // Node 22+/24 deprecates passing an args array with shell:true.
  const encoded = args.map(value => {
    if (/["%!&|<>()^\r\n]/.test(value)) throw new Error('Unsafe Gemini launcher argument');
    return /^[A-Za-z0-9._/-]+$/.test(value) ? value : `"${value}"`;
  });
  return { command: info.command, args: ['/d', '/s', '/c', ['gemini', ...encoded].join(' ')], common, info };
}

export function runGemini(args, options = {}) {
  const call = invocation(args, options);
  return spawnSync(call.command, call.args, { ...call.common, encoding: 'utf8', timeout: options.timeout ?? 20 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });
}

const activeChildren = new Set();

export function killProcessTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Gemini CLI can relaunch itself in a child node process; kill the whole tree.
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => { for (const child of activeChildren) killProcessTree(child); });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      for (const child of activeChildren) killProcessTree(child);
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

// Prompts that can never be answered in headless mode (stdin is closed).
const INTERACTIVE_PROMPT = /Do you want to continue\?\s*\[[Yy]\/[Nn]\]|Opening authentication page in your browser|Enter the authori[sz]ation code|Please visit the following URL|\[[Yy]\/[Nn]\]\s*:?\s*$|Press (?:any key|enter) to/i;

export function summarizeStreamEvent(event) {
  if (!event || typeof event !== 'object') return null;
  switch (event.type) {
    case 'init': return `session started (model ${event.model ?? 'unknown'})`;
    case 'tool_use': return `${event.tool_name}${toolTarget(event.parameters)}`;
    case 'tool_result': return event.status === 'error' ? `tool failed: ${event.error?.message ?? 'unknown error'}` : null;
    case 'error': return `${event.severity === 'warning' ? 'warning' : 'error'}: ${event.message}`;
    case 'result': return `finished: ${event.status}${event.error?.message ? ` - ${event.error.message}` : ''}`;
    default: return null;
  }
}

export function toolTarget(parameters = {}) {
  if (!parameters || typeof parameters !== 'object') return '';
  const target = parameters.file_path ?? parameters.absolute_path ?? parameters.path ?? parameters.dir_path ?? parameters.pattern ?? (Array.isArray(parameters.paths) ? parameters.paths.join(', ') : parameters.paths) ?? parameters.include ?? '';
  const text = String(target).replaceAll('\\', '/');
  const shortened = text.replace(/^.*?\/html-converter-gemini-[^/]+\//, '');
  const size = typeof parameters.content === 'string' ? ` (${formatBytes(Buffer.byteLength(parameters.content))})` : '';
  return shortened ? ` ${shortened.length > 160 ? `${shortened.slice(0, 157)}...` : shortened}${size}` : size;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Streams one Gemini CLI run. Every stdout/stderr line is written to disk as it
// arrives and handed to callbacks, so progress (and a stuck prompt) is visible
// immediately instead of only after the process exits.
export function runGeminiStream(args, options = {}) {
  const call = invocation(args, options);
  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 0;
  const eventsFd = options.eventsFile ? fs.openSync(options.eventsFile, 'a') : null;
  const stderrFd = options.stderrFile ? fs.openSync(options.stderrFile, 'a') : null;
  installExitHook();
  return new Promise(resolve => {
    const started = Date.now();
    let lastActivity = started;
    let child;
    try {
      child = spawn(call.command, call.args, { ...call.common, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    } catch (error) {
      for (const fd of [eventsFd, stderrFd]) if (fd !== null) fs.closeSync(fd);
      resolve({ status: null, error, events: [], assistantText: '', stdoutTail: '', stderrTail: '', durationMs: 0, cli: call.info });
      return;
    }
    activeChildren.add(child);
    const events = [];
    let assistantText = '', stdoutTail = '', stderrTail = '', stdoutPartial = '', stderrPartial = '';
    let error = null, timedOut = false, stalled = false, interactivePrompt = null, finalResult = null, settled = false, lastSummary = null;
    const keepTail = (current, text) => (current + text).slice(-64 * 1024);
    const stop = () => killProcessTree(child);
    const checkPrompt = text => {
      if (interactivePrompt || !INTERACTIVE_PROMPT.test(text)) return;
      interactivePrompt = text.trim().slice(-300);
      options.onPrompt?.(interactivePrompt);
      stop();
    };
    const handleStdoutLine = line => {
      if (eventsFd !== null) fs.writeSync(eventsFd, line + '\n');
      const trimmed = line.trim();
      if (!trimmed) return;
      let event = null;
      if (trimmed.startsWith('{')) { try { event = JSON.parse(trimmed); } catch { /* plain text */ } }
      if (!event || typeof event.type !== 'string') {
        checkPrompt(trimmed);
        options.onText?.(trimmed);
        return;
      }
      if (event.type === 'message' && event.role === 'assistant') assistantText += event.content ?? '';
      if (event.type === 'result') finalResult = event;
      const summary = summarizeStreamEvent(event);
      if (summary) lastSummary = summary;
      if (event.type !== 'message' || event.role === 'assistant') events.push({ type: event.type, at: Date.now() - started, summary, tool: event.tool_name, parameters: event.type === 'tool_use' ? { ...event.parameters, content: undefined } : undefined });
      if (events.length > 500) events.splice(0, events.length - 500);
      options.onEvent?.(event);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      lastActivity = Date.now();
      stdoutTail = keepTail(stdoutTail, chunk);
      stdoutPartial += chunk;
      const lines = stdoutPartial.split(/\r?\n/);
      stdoutPartial = lines.pop();
      for (const line of lines) handleStdoutLine(line);
      // Prompts are printed without a trailing newline.
      if (stdoutPartial) checkPrompt(stdoutPartial);
    });
    child.stderr.on('data', chunk => {
      lastActivity = Date.now();
      stderrTail = keepTail(stderrTail, chunk);
      if (stderrFd !== null) fs.writeSync(stderrFd, chunk);
      stderrPartial += chunk;
      const lines = stderrPartial.split(/\r?\n/);
      stderrPartial = lines.pop();
      for (const line of lines) if (line.trim()) { checkPrompt(line); options.onStderr?.(line); }
      if (stderrPartial) checkPrompt(stderrPartial);
    });
    child.on('error', value => { error = value; });
    const watchdog = setInterval(() => {
      const now = Date.now();
      if (now - started >= timeoutMs) { timedOut = true; stop(); return; }
      if (idleTimeoutMs && now - lastActivity >= idleTimeoutMs) { stalled = true; stop(); return; }
      options.onIdle?.(now - lastActivity, lastSummary, now - started);
    }, Math.min(5000, Math.max(50, Math.floor(Math.min(timeoutMs, idleTimeoutMs || timeoutMs) / 4))));
    let forceTimer = null;
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(watchdog);
      clearTimeout(forceTimer);
      activeChildren.delete(child);
      if (stdoutPartial) handleStdoutLine(stdoutPartial);
      if (stderrPartial.trim()) options.onStderr?.(stderrPartial);
      for (const fd of [eventsFd, stderrFd]) if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
      const minutes = value => value < 60000 ? `${Math.round(value / 1000)} second(s)` : `${Math.round(value / 60000 * 10) / 10} minute(s)`;
      if (interactivePrompt) error = new Error(`Gemini CLI stopped at an interactive prompt that cannot be answered in this unattended run: "${interactivePrompt}"`);
      else if (timedOut) error = new Error(`Gemini phase timed out after ${minutes(timeoutMs)}.`);
      else if (stalled) error = new Error(`Gemini produced no output for ${minutes(idleTimeoutMs)} and was stopped as stalled.`);
      resolve({ status, signal, error, timedOut, stalled, interactivePrompt, finalResult, events, assistantText, stdoutTail, stderrTail, durationMs: Date.now() - started, lastSummary, cli: call.info });
    };
    // 'close' waits for stdio to end; a grandchild holding the pipes open must not hang us.
    child.on('exit', (status, signal) => { forceTimer = setTimeout(() => finish(status, signal), 5000); });
    child.on('close', (status, signal) => finish(status, signal));
  });
}

// Compatibility wrapper for callers that only need the buffered result.
export async function runGeminiAsync(args, options = {}) {
  const result = await runGeminiStream(args, { ...options, timeoutMs: options.timeout ?? options.timeoutMs, onIdle: options.onHeartbeat ? (() => { let last = 0; return (_idle, _summary, elapsed) => { if (elapsed - last >= 30000) { last = elapsed; options.onHeartbeat(`Gemini phase still running (${Math.round(elapsed / 1000)}s).`); } }; })() : undefined });
  return { status: result.status, stdout: result.stdoutTail, stderr: result.stderrTail, error: result.error };
}

// Older Gemini CLI builds reject newer flags immediately; say which one to drop.
export function unsupportedFlag(result) {
  const text = `${result?.stderrTail ?? result?.stderr ?? ''}\n${result?.stdoutTail ?? result?.stdout ?? ''}`;
  if (/Unknown arguments?:[^\n]*skip-trust/i.test(text)) return '--skip-trust';
  if (/Invalid values?:[\s\S]{0,200}output-format[\s\S]{0,200}stream-json/i.test(text) || /Unknown arguments?:[^\n]*output-format/i.test(text)) return '--output-format';
  if (/Invalid values?:[\s\S]{0,200}approval-mode/i.test(text) || /Unknown arguments?:[^\n]*approval-mode/i.test(text)) return '--approval-mode';
  return null;
}
