import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function npmGeminiEntry(env) {
  const searchPath = env.PATH || env.Path || env.path || '';
  const directories = new Set(searchPath.split(path.delimiter).filter(Boolean));
  if (env.APPDATA) directories.add(path.join(env.APPDATA, 'npm'));
  if (env.npm_config_prefix) directories.add(env.npm_config_prefix);
  for (const directory of directories) {
    const shim = path.join(directory, 'gemini.cmd');
    if (!fs.existsSync(shim)) continue;
    const packageDir = path.join(directory, 'node_modules', '@google', 'gemini-cli');
    const packageFile = path.join(packageDir, 'package.json');
    if (!fs.existsSync(packageFile)) continue;
    try {
      const bin = JSON.parse(fs.readFileSync(packageFile, 'utf8')).bin?.gemini;
      if (typeof bin !== 'string') continue;
      const entry = path.resolve(packageDir, bin);
      if (entry.startsWith(path.resolve(packageDir) + path.sep) && fs.existsSync(entry)) return entry;
    } catch { /* This is not the standard npm Gemini CLI install. */ }
  }
  return null;
}

function invocation(args, options = {}) {
  const childEnv = { ...process.env, NO_COLOR: '1', ...options.env };
  // The model may need its own auth key, but must never inherit source credentials.
  for (const key of Object.keys(childEnv)) {
    if (/^(GEMINI_API_KEY|GOOGLE_API_KEY)$/.test(key)) continue;
    if (/^(PG_|SQL_|MYSQL_|ORACLE_|ODBC_|SOURCE_|AWS_|AZURE_)/.test(key) || /(PASSWORD|SECRET|TOKEN|CREDENTIAL|CONNECTION_STRING|API_KEY)/i.test(key)) delete childEnv[key];
  }
  const common = {
    cwd: options.cwd,
    encoding: 'utf8',
    timeout: options.timeout ?? 20 * 60 * 1000,
    maxBuffer: 50 * 1024 * 1024,
    env: childEnv
  };
  if (process.platform !== 'win32') return { command: 'gemini', args, common };
  const entry = npmGeminiEntry(childEnv);
  if (entry) return { command: process.execPath, args: [entry, ...args], common };
  // npm installs Gemini CLI as gemini.cmd on Windows. Invoke cmd explicitly;
  // Node 22+/24 deprecates passing an args array with shell:true.
  const encoded = args.map(value => {
    if (/["%!&|<>()^\r\n]/.test(value)) throw new Error('Unsafe Gemini launcher argument');
    return /^[A-Za-z0-9._/-]+$/.test(value) ? value : `"${value}"`;
  });
  const command = ['gemini', ...encoded].join(' ');
  return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command], common };
}

export function runGemini(args, options = {}) {
  const call = invocation(args, options);
  return spawnSync(call.command, call.args, call.common);
}

export function parseGeminiOutput(stdout = '') {
  if (typeof stdout !== 'string') return { response: '' };
  try {
    const parsed = JSON.parse(stdout);
    if (parsed && !parsed.type) return parsed;
  } catch { /* Streaming output contains one JSON object per line. */ }
  const parsed = { response: '' };
  for (const line of stdout.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'tool_use') parsed.response = '';
    if (event.type === 'message' && event.role === 'assistant') parsed.response += event.content ?? '';
    if (event.type === 'error' && event.severity === 'error') parsed.error = { message: event.message };
    if (event.type === 'result') {
      parsed.stats = event.stats;
      if (event.status === 'success') delete parsed.error;
      else parsed.error = event.error ?? { message: 'Gemini reported an unsuccessful result.' };
    }
  }
  return parsed;
}

export function runGeminiAsync(args, options = {}) {
  const call = invocation(args, options);
  return new Promise(resolve => {
    // Own the timeout: spawn's built-in timer can kill the shell before its child tree.
    const { timeout: callTimeout, ...spawnOptions } = call.common;
    const child = spawn(call.command, call.args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', error = null, settled = false, forceTimer, idleTimer, stopReason;
    let pending = '', toolCalls = 0, lastActivity = 'starting CLI', lastOutputAt = Date.now();
    const outputIndex = args.indexOf('--output-format');
    const streaming = outputIndex >= 0 && args[outputIndex + 1] === 'stream-json';
    const append = (current, chunk, limit) => (current + chunk).slice(-limit);
    const eventLine = line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (!event || typeof event !== 'object') return;
      if (event.type === 'tool_use') {
        toolCalls++;
        lastActivity = `tool ${String(event.tool_name).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)}`;
      } else if (event.type === 'message' && event.role === 'assistant') lastActivity = 'generating response';
      else if (['init', 'error', 'result'].includes(event.type)) lastActivity = event.type;
      options.onEvent?.(event);
    };
    const noteOutput = () => {
      lastOutputAt = Date.now();
      clearTimeout(idleTimer);
      if (options.idleTimeoutMs && !stopReason) idleTimer = setTimeout(() => stop(`Gemini produced no output for ${Math.round(options.idleTimeoutMs / 1000)} seconds; last activity: ${lastActivity}.`), options.idleTimeoutMs);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => {
      stdout = append(stdout, chunk, 50 * 1024 * 1024);
      options.onStdout?.(chunk);
      noteOutput();
      if (!streaming) return;
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        eventLine(pending.slice(0, newline)); pending = pending.slice(newline + 1);
      }
      if (pending.length > 50 * 1024 * 1024) pending = '';
    });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk, 10 * 1024 * 1024); options.onStderr?.(chunk); noteOutput(); });
    child.on('error', value => { error = value; });
    const started = Date.now();
    const heartbeat = setInterval(() => options.onHeartbeat?.(`Gemini ${Math.round((Date.now() - started) / 1000)}s; ${toolCalls} tool calls; ${lastActivity}; last output ${Math.round((Date.now() - lastOutputAt) / 1000)}s ago.`), 30000);
    const finish = status => {
      if (settled) return;
      settled = true;
      clearInterval(heartbeat);
      clearTimeout(timeout);
      clearTimeout(forceTimer);
      clearTimeout(idleTimer);
      if (streaming && pending) eventLine(pending);
      if (stopReason) error = new Error(stopReason);
      resolve({ status, stdout, stderr, error, metrics: { elapsedMs: Date.now() - started, toolCalls, lastActivity, stopped: Boolean(stopReason) } });
    };
    const stop = reason => {
      if (settled || stopReason) return;
      stopReason = reason;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.unref();
      } else child.kill('SIGKILL');
      forceTimer = setTimeout(() => {
        child.kill('SIGKILL');
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, 5000);
    };
    const timeout = setTimeout(() => stop(`Gemini phase timed out after ${Math.round(callTimeout / 1000)} seconds; last activity: ${lastActivity}.`), callTimeout);
    noteOutput();
    child.on('close', finish);
  });
}
