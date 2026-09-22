import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseCsv, root, walk, workDir } from './core.mjs';

function commandPath(env) {
  if (env.DSCMD_PATH) {
    if (!fs.existsSync(env.DSCMD_PATH)) throw new Error(`DSCMD_PATH does not exist: ${env.DSCMD_PATH}`);
    return env.DSCMD_PATH;
  }
  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'DAX Studio', 'dscmd.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'DAX Studio', 'dscmd.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DAX Studio', 'dscmd.exe')
  ].filter(Boolean);
  return candidates.find(file => fs.existsSync(file)) || 'dscmd.exe';
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 600000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...options });
}

function errorTail(result) {
  return (result.stderr || result.stdout || result.error?.message || '').trim().slice(-1600);
}

function openDesktop(pbipPath) {
  if (process.platform !== 'win32') throw new Error('Desktop-model export requires Windows and Power BI Desktop.');
  const escaped = pbipPath.replaceAll("'", "''");
  const fallback = run('powershell.exe', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop'; Start-Process -FilePath '${escaped}'`], { timeout: 30000 });
  if (fallback.error || fallback.status !== 0) throw new Error(`Could not open PBIP in Power BI Desktop. ${errorTail(fallback)}`);
}

function exportedCsvFiles(dir) {
  return walk(dir).filter(file => file.toLowerCase().endsWith('.csv'));
}

export function modelExportData(files, maxBytes = 200 * 1024 * 1024) {
  if (!files.length) throw new Error('Power BI Desktop model export produced no CSV tables. Check that the model has loaded data.');
  const bytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
  if (bytes > maxBytes) throw new Error(`Desktop model export is ${(bytes / 1024 / 1024).toFixed(1)} MB, above the configured ${Math.round(maxBytes / 1024 / 1024)} MB HTML data limit. Refusing to silently truncate it.`);
  return { datasets: files.map(file => ({
    name: path.basename(file, path.extname(file)),
    source: `Power BI Desktop model: ${path.basename(file)}`,
    kind: 'desktop-model-export',
    ...parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  })) };
}

export function exportDesktopModel(inventory, env = {}, options = {}) {
  if (inventory.reportModelReferences?.some(x => x.kind !== 'local-path')) throw new Error('PBIR does not clearly reference a local semantic model; refusing Desktop export under the no-Fabric requirement.');
  if (process.platform !== 'win32' && !options.run) throw new Error('Desktop-model export requires Windows and Power BI Desktop.');
  const command = commandPath(env);
  const execute = options.run || run;
  const modelName = path.basename(inventory.project);
  const pbipPath = options.pbipPath || path.join(root, inventory.project);
  if (!fs.existsSync(pbipPath)) throw new Error(`PBIP not found: ${pbipPath}`);
  const destination = options.workDir || workDir;
  fs.mkdirSync(destination, { recursive: true });
  let exportDir;
  const attemptExport = () => {
    exportDir = fs.mkdtempSync(path.join(destination, 'desktop-model-'));
    return execute(command, ['export', 'csv', exportDir, '--server', modelName], { cwd: root, encoding: 'utf8', timeout: 600000, windowsHide: true });
  };
  let result = attemptExport();
  if (result.error?.code === 'ENOENT') throw new Error('DAX Studio CLI (dscmd.exe) is not installed or not found. Install DAX Studio, or set DSCMD_PATH in gemini/.env to its dscmd.exe path.');
  if ((result.error || result.status !== 0) && env.PBI_DESKTOP_AUTO_OPEN !== 'false') {
    (options.open || openDesktop)(pbipPath);
    for (let attempt = 0; attempt < 12; attempt++) {
      if (attempt) (options.pause || (ms => { const signal = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(signal), 0, 0, ms); }))(5000);
      result = attemptExport();
      if (!result.error && result.status === 0) break;
    }
  }
  if (result.error || result.status !== 0) throw new Error(`DAX Studio could not export the loaded Desktop model (${modelName}). Install DAX Studio, open the PBIP in Power BI Desktop, resolve any credential prompts, and ensure the model is loaded. ${errorTail(result)}`);
  const maxMb = Number(env.MODEL_EXPORT_MAX_MB || 200);
  if (!Number.isFinite(maxMb) || maxMb <= 0 || maxMb > 1000) throw new Error('MODEL_EXPORT_MAX_MB must be between 1 and 1000.');
  const files = exportedCsvFiles(exportDir);
  const data = modelExportData(files, maxMb * 1024 * 1024);
  return { data, exportDir, files: files.map(file => path.relative(root, file).replaceAll('\\', '/')) };
}
