import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, workDir, dynamicDir, staticDir, discover, loadData, writeJson, readJson } from './core.mjs';
import { createPreview } from './preview.mjs';
import { makeSnapshot } from './snapshot.mjs';
import { validate } from './validate.mjs';

process.chdir(root);
const preflightOnly = process.argv.includes('--preflight');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

function fail(message) { throw new Error(message); }

function gemini(args) {
  // Arguments are fixed repository strings, not source-file content.
  return spawnSync('gemini', args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 20 * 60 * 1000,
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' }
  });
}

function runPhase(name, promptFile, expectedFile, runDir) {
  console.log(`\n[${name}] Starting fresh Gemini session...`);
  const prompt = `Read GEMINI.md and ${promptFile}. Follow that phase exactly. Read work/current-run.json. Write the required artifact. Do not run shell commands.`;
  const result = gemini(['--model', 'gemini-3.5-flash', '-e', 'none', '--approval-mode', 'auto_edit', '--output-format', 'json', '-p', prompt]);
  fs.writeFileSync(path.join(runDir, `${name}.stdout.json`), result.stdout ?? '');
  fs.writeFileSync(path.join(runDir, `${name}.stderr.log`), result.stderr ?? '');
  if (result.error) fail(`${name}: ${result.error.message}`);
  if (result.status !== 0) fail(`${name}: Gemini exited ${result.status}. Check work/runs/${path.basename(runDir)}/${name}.stderr.log`);
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
  const inventory = discover();
  const data = loadData(inventory);
  fs.mkdirSync(workDir, { recursive: true });
  writeJson(path.join(workDir, 'inventory.json'), inventory);
  console.log(`Project: ${inventory.project}`);
  console.log(`PBIR pages: ${inventory.pages.length}; visuals: ${inventory.pages.reduce((n, p) => n + p.visuals.length, 0)}; local datasets: ${data.datasets.length}`);
  inventory.warnings.forEach(x => console.warn(`Warning: ${x}`));
  if (preflightOnly) { console.log('Preflight passed. No Gemini call made.'); process.exit(0); }

  const version = gemini(['--version']);
  if (version.error || version.status !== 0) fail('Gemini CLI not found or unusable. Install/authenticate it, then rerun. Try: gemini --version');
  const runDir = path.join(workDir, 'runs', timestamp);
  fs.mkdirSync(runDir, { recursive: true });
  backupExisting(runDir);
  writeJson(path.join(workDir, 'current-run.json'), { startedAt: new Date().toISOString(), project: inventory.project, runLog: path.relative(root, runDir).replaceAll('\\', '/'), dataStatus: data.datasets.length ? 'local exports supplied' : 'metadata only — do not invent values' });
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
