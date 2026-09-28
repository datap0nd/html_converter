// Power BI Desktop's local engine: every open report runs an Analysis Services
// instance on this PC (the one DAX Studio and other external tools use). Its port
// is written to msmdsrv.port.txt in Desktop's workspace folder. This module finds
// those instances and runs DAX queries on the right one through pbi-query.ps1.
//
//   findDesktopInstances(env)            -> [{ port, workspace, modified }]
//   runPowerBiQueries({ ports, tables, queries, ... }) -> result of pbi-query.ps1
//
// Settings: HC_PBI_PORT=<port>[,<port>] skips discovery; HC_PBI_COMPARE=false turns
// the comparison off; HC_PBI_QUERY_RUNNER=<node script> replaces PowerShell (tests).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root } from './core.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

export function desktopWorkspaceRoots(env = process.env) {
  const local = env.LOCALAPPDATA || (env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Local') : null);
  return [
    local && path.join(local, 'Microsoft', 'Power BI Desktop', 'AnalysisServicesWorkspaces'),
    env.USERPROFILE && path.join(env.USERPROFILE, 'Microsoft', 'Power BI Desktop Store App', 'AnalysisServicesWorkspaces'),
    local && path.join(local, 'Microsoft', 'Power BI Desktop SSRS', 'AnalysisServicesWorkspaces')
  ].filter(Boolean);
}

// msmdsrv.port.txt is UTF-16LE text such as "51234".
export function readPortFile(file) {
  const bytes = fs.readFileSync(file);
  const text = bytes.includes(0) ? bytes.toString('utf16le') : bytes.toString('utf8');
  const port = Number(text.replace(/^\uFEFF/, '').replace(/\0/g, '').trim());
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

export function findDesktopInstances(env = process.env) {
  if (env.HC_PBI_PORT) {
    return String(env.HC_PBI_PORT).split(/[,;\s]+/).map(Number).filter(port => Number.isInteger(port) && port > 0 && port < 65536).map(port => ({ port, workspace: 'HC_PBI_PORT', modified: Date.now() }));
  }
  const found = [];
  for (const base of desktopWorkspaceRoots(env)) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.filter(item => item.isDirectory())) {
      const file = path.join(base, entry.name, 'Data', 'msmdsrv.port.txt');
      try {
        const port = readPortFile(file);
        if (port) found.push({ port, workspace: path.join(base, entry.name), modified: fs.statSync(file).mtimeMs });
      } catch { /* a closed Desktop leaves no port file, or it is being written */ }
    }
  }
  // Newest first: the report opened last is the most likely one.
  return found.sort((a, b) => b.modified - a.modified);
}

// Port files of crashed Desktop sessions stay behind; keep only engines that answer.
export function portAnswers(port, timeoutMs = 1500) {
  return new Promise(resolve => {
    const socket = net.connect({ host: 'localhost', port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function powershellPath() {
  const system = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const windowsPowerShell = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return process.platform === 'win32' && fs.existsSync(windowsPowerShell) ? windowsPowerShell : process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
}

// Runs the queries on the open Desktop model that has this report's tables.
// queries: [{ id, dax }]; onLine(text) receives the runner's progress lines.
export async function runPowerBiQueries({ ports, tables, queries, timeoutMs = 10 * 60_000, perQuerySeconds = 120, onLine, env = process.env }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-pbi-'));
  const requestFile = path.join(dir, 'request.json'), resultFile = path.join(dir, 'result.json');
  fs.writeFileSync(requestFile, JSON.stringify({ ports, tables, queries, timeoutSeconds: perQuerySeconds, toolsDir: path.join(root, 'tools', 'adomd'), allowDownload: env.HC_PBI_DOWNLOAD_ADOMD !== 'false' }));
  const runner = env.HC_PBI_QUERY_RUNNER;
  const command = runner ? process.execPath : powershellPath();
  const args = runner ? [runner, requestFile, resultFile] : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(scriptsDir, 'pbi-query.ps1'), '-RequestFile', requestFile, '-ResultFile', resultFile];
  try {
    const exit = await new Promise(resolve => {
      let child;
      try { child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } }); }
      catch (error) { resolve({ error }); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ error: new Error(`the Power BI query runner did not finish within ${Math.round(timeoutMs / 60000)} minute(s)`) }); }, timeoutMs);
      let partial = '';
      const lines = chunk => {
        const parts = (partial + chunk).split(/\r?\n/);
        partial = parts.pop() ?? '';
        for (const line of parts) if (line.trim()) { try { onLine?.(line.trim()); } catch { /* reporting only */ } }
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', lines); child.stderr.on('data', lines);
      child.on('error', error => { clearTimeout(timer); resolve({ error }); });
      child.on('close', code => { clearTimeout(timer); if (partial.trim()) lines('\n'); resolve({ code }); });
    });
    if (exit.error) return { ok: false, error: exit.error.message };
    let result = null;
    try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8').replace(/^\uFEFF/, '')); } catch { /* no result written */ }
    return result ?? { ok: false, error: `the Power BI query runner ended (exit code ${exit.code}) without a result` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
