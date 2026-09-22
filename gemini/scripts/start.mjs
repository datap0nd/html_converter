import fs from 'node:fs';
import path from 'node:path';
import { root, workDir, dynamicDir, staticDir, discover, writeJson, readJson } from './core.mjs';
import { runGemini } from './gemini.mjs';
import { loadLocalEnv } from './env.mjs';
import { loadAllData } from './sources.mjs';
import { ensurePostgresDriver } from './deps.mjs';
import { exportDesktopModel } from './desktop-model.mjs';
import { createPreview } from './preview.mjs';
import { makeSnapshot } from './snapshot.mjs';
import { validate } from './validate.mjs';

process.chdir(root);
const preflightOnly = process.argv.includes('--preflight');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const geminiModel = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash';

function fail(message) { throw new Error(message); }

function runPhase(name, promptFile, expectedFile, runDir) {
  console.log(`\n[${name}] Starting fresh Gemini session...`);
  const prompt = `Read GEMINI.md and ${promptFile}. Follow that phase exactly. Read work/current-run.json. Write the required artifact. Do not run shell commands.`;
  const result = runGemini(['--model', geminiModel, '-e', 'none', '--approval-mode', 'auto_edit', '--output-format', 'json', '-p', prompt], { cwd: root });
  fs.writeFileSync(path.join(runDir, `${name}.stdout.json`), result.stdout ?? '');
  fs.writeFileSync(path.join(runDir, `${name}.stderr.log`), result.stderr ?? '');
  if (result.error) fail(`${name}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(-1500);
    fail(`${name}: Gemini exited ${result.status}. ${detail || 'No error text returned.'} Full log: work/runs/${path.basename(runDir)}/${name}.stderr.log`);
  }
  const parsed = (() => { try { return JSON.parse(result.stdout); } catch { return null; } })();
  if (parsed?.error) fail(`${name}: Gemini reported ${JSON.stringify(parsed.error)}`);
  if (!fs.existsSync(path.join(root, expectedFile))) fail(`${name}: missing required ${expectedFile}. See work/runs/${path.basename(runDir)}/${name}.stdout.json`);
  console.log(`[${name}] Completed.`);
}

function backupExisting(runDir) {
  for (const [source, name] of [[dynamicDir, 'dynamic'], [staticDir, 'static']]) {
    const files = fs.existsSync(source) ? fs.readdirSync(source).filter(x => x !== '.gitkeep') : [];
    if (files.length) fs.cpSync(source, path.join(runDir, 'previous-output', name), { recursive: true });
  }
  const priorWork = ['interpretation.json', 'interpretation-review.json', 'build-notes.json', 'build-review.json', 'final-review.json', 'dynamic-checks.json', 'final-checks.json'];
  for (const name of priorWork) {
    const source = path.join(workDir, name);
    if (!fs.existsSync(source)) continue;
    const archive = path.join(runDir, 'previous-work', name);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.copyFileSync(source, archive);
    fs.unlinkSync(source);
  }
}

try {
  const env = loadLocalEnv();
  const inventory = discover();
  fs.mkdirSync(workDir, { recursive: true });
  writeJson(path.join(workDir, 'inventory.json'), inventory);
  const dataMode = env.DATA_MODE || 'desktop';
  if (!['desktop', 'raw'].includes(dataMode)) throw new Error('DATA_MODE must be desktop or raw.');
  let data;
  if (dataMode === 'desktop') {
    if (inventory.reportModelReferences.some(x => x.kind !== 'local-path')) throw new Error('This PBIR does not clearly reference a local semantic model byPath. Desktop export might contact a remote model, contrary to the no-Fabric requirement. Supply a PBIP with a local semantic model.');
    const exported = exportDesktopModel(inventory, env);
    data = exported.data;
    inventory.dataMode = 'desktop-model-export';
    inventory.modelExportFiles = exported.files;
    inventory.warnings = [
      'Data was exported from the loaded Power BI Desktop model, including Power Query transformations and calculated columns. Import-mode data is only as fresh as the last Desktop refresh.',
      'DAX measures, RLS behavior, custom visuals, and interactive report logic still require reconstruction and validation.'
    ];
  } else {
    if (inventory.unsupportedConnectors?.length) {
      const names = [...new Set(inventory.unsupportedConnectors.map(x => x.connector))].join(', ');
      throw new Error(`Unsupported source connector(s): ${names}. This run stopped rather than silently omit their data. See work/inventory.json after using npm run preflight, or provide approved exports in input/data and remove the unsupported model source.`);
    }
    if (inventory.directCsvSources?.some(x => !x.available)) {
      throw new Error('A PBIP-referenced CSV path is not readable on this PC. Check work/inventory.json, network/VPN access, and the account running npm start.');
    }
    if (inventory.postgresSources?.length && (!env.PG_USER || !env.PG_PASSWORD)) {
      throw new Error('PostgreSQL source found. Fill PG_USER and PG_PASSWORD in gemini/.env with a read-only login, then rerun npm start.');
    }
    ensurePostgresDriver(inventory);
    data = await loadAllData(inventory, env);
    inventory.dataMode = 'raw-direct-source';
  }
  writeJson(path.join(workDir, 'inventory.json'), inventory);
  console.log(`Project: ${inventory.project}`);
  console.log(`PBIR pages: ${inventory.pages.length}; visuals: ${inventory.pages.reduce((n, p) => n + p.visuals.length, 0)}; local datasets: ${data.datasets.length}`);
  inventory.warnings.forEach(x => console.warn(`Warning: ${x}`));
  if (preflightOnly) { console.log('Preflight passed. No Gemini call made.'); process.exit(0); }

  const version = runGemini(['--version'], { cwd: root });
  if (version.error || version.status !== 0) fail('Gemini CLI not found or unusable. Install/authenticate it, then rerun. Try: gemini --version');
  const runDir = path.join(workDir, 'runs', timestamp);
  fs.mkdirSync(runDir, { recursive: true });
  backupExisting(runDir);
  writeJson(path.join(workDir, 'current-run.json'), { startedAt: new Date().toISOString(), project: inventory.project, runLog: path.relative(root, runDir).replaceAll('\\', '/'), dataStatus: dataMode === 'desktop' ? 'Desktop model tables exported — Power Query applied; verify DAX measures and visual parity' : data.datasets.length ? 'raw source rows loaded — verify Power Query and DAX parity' : 'metadata only — do not invent values' });
  createPreview(inventory, data);

  runPhase('01-interpret', 'prompts/01-interpret.md', 'work/interpretation.json', runDir);
  runPhase('02-audit', 'prompts/02-audit.md', 'work/interpretation-review.json', runDir);
  const interpretationReview = readJson(path.join(workDir, 'interpretation-review.json'));
  if (!interpretationReview || !['pass', 'warnings'].includes(interpretationReview.status)) fail('Interpretation audit blocked or invalid. See work/interpretation-review.json');

  runPhase('03-build', 'prompts/03-build.md', 'work/build-notes.json', runDir);
  runPhase('04-repair', 'prompts/04-repair.md', 'work/build-review.json', runDir);
  const buildReview = readJson(path.join(workDir, 'build-review.json'));
  if (!buildReview || !['pass', 'warnings'].includes(buildReview.status)) fail('Build review blocked or invalid. See work/build-review.json');
  const dynamicChecks = validate();
  if (!dynamicChecks.passed) fail(`Dynamic checks failed: ${dynamicChecks.issues.join('; ')}`);

  const snapshot = makeSnapshot();
  console.log(`Snapshot: ${path.relative(root, snapshot)}`);
  runPhase('05-final-review', 'prompts/05-final-review.md', 'work/final-review.json', runDir);
  const finalChecks = validate({ final: true });
  if (!finalChecks.passed) fail(`Final checks failed: ${finalChecks.issues.join('; ')}`);
  console.log('\nDone. Review output/dynamic/index.html, output/static/report.html, and work/final-review.json.');
} catch (error) {
  console.error(`\nConversion stopped: ${error.message}`);
  process.exitCode = 1;
}
