// Offline end-to-end self-test: runs the real converter, with this PC's Node.js
// and installed Gemini CLI, against a local mock of the Gemini API and a generic
// test PBIP. It needs no Gemini quota, no sign-in, and no report data, and it
// never touches input/, output/, work/, or your ~/.gemini settings.
//
//   node scripts/selftest.mjs                 real Gemini CLI + mock API
//   node scripts/selftest.mjs --fake-cli      built-in fake CLI (no Gemini CLI needed)
//   node scripts/selftest.mjs --scenario stall-01,broken-backend
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { geminiCliInfo } from './gemini.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const useFake = args.includes('--fake-cli');
const scenario = option('--scenario') ?? '';
const keep = args.includes('--keep');

const say = message => process.stdout.write(`[selftest] ${message}\n`);

async function main() {
  const { createSandbox } = await import('../tests/support/fixtures.mjs');
  const cli = useFake ? { found: true, entry: path.join(root, 'tests', 'support', 'fake-gemini-cli.mjs'), version: 'fake', source: 'built-in fake' } : geminiCliInfo();
  if (!cli.found) throw new Error('Gemini CLI was not found. Install it with: npm install -g @google/gemini-cli   (or run with --fake-cli to test everything else).');
  if (!useFake && !cli.prefix) throw new Error(`Gemini CLI was found only as a command shim (${cli.entry}); the self-test needs the npm package entry. Reinstall with: npm install -g @google/gemini-cli`);
  say(`Node ${process.version}; Gemini CLI ${cli.version ?? '(unknown version)'} at ${cli.entry}`);
  const sandbox = createSandbox();
  say(`Temporary converter copy: ${sandbox.dir}`);
  const home = path.join(sandbox.dir, 'gemini-home');
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  // API-key auth pointed at the local mock; the real ~/.gemini is never read.
  fs.writeFileSync(path.join(home, '.gemini', 'settings.json'), JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } }, privacy: { usageStatisticsEnabled: false }, ui: { showCompatibilityWarnings: false } }, null, 2));
  let mock = null, ok = false;
  try {
    const env = { ...process.env, HC_GEMINI_ENTRY: cli.entry, HC_NO_SERVE: 'true', FAKE_GEMINI_SCENARIO: scenario, FAKE_GEMINI_STATE: path.join(sandbox.dir, 'fake-state.json'), GEMINI_CLI_HOME: home, GEMINI_API_KEY: 'selftest-not-a-real-key' };
    if (!useFake) {
      mock = spawn(process.execPath, [path.join(root, 'tests', 'support', 'mock-gemini-api.mjs'), '--script', path.join(root, 'tests', 'support', 'converter-model-handler.mjs'), '--port', '0', '--quiet', '--log', path.join(sandbox.dir, 'mock-requests.jsonl')], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, FAKE_GEMINI_SCENARIO: scenario } });
      const url = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Mock Gemini API did not start.')), 15000);
        readline.createInterface({ input: mock.stdout }).once('line', line => { clearTimeout(timer); resolve(JSON.parse(line).url); });
      });
      Object.assign(env, { GOOGLE_GEMINI_BASE_URL: url, NO_PROXY: [env.NO_PROXY, env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(','), no_proxy: [env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',') });
      say(`Mock Gemini API: ${url}`);
    }
    say('Running the converter on the test report (first 2 pages)...');
    const code = await new Promise(resolve => {
      const child = spawn(process.execPath, ['--no-warnings', path.join(sandbox.dir, 'scripts', 'start-live-report.mjs'), '--page-limit', '2'], { cwd: sandbox.dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.on('data', chunk => process.stdout.write(chunk.toString().replace(/^(?=.)/gm, '  | ')));
      child.stderr.on('data', chunk => process.stdout.write(chunk.toString().replace(/^(?=.)/gm, '  ! ')));
      child.on('close', resolve);
    });
    ok = code === 0;
    const report = path.join(sandbox.dir, 'output', 'first-2-pages', 'dynamic', 'index.html');
    if (ok && !fs.existsSync(report)) { ok = false; say('The converter finished but produced no report.'); }
    if (ok) say('PASSED: Node, Gemini CLI, the converter phases, backend checks, and validation all work on this PC.');
    else say(`FAILED (exit ${code}). The lines above show where and why.`);
    return ok;
  } finally {
    if (mock) mock.kill();
    if (!ok || keep) {
      const saved = path.join(root, 'logs', `selftest-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      for (const folder of ['logs', 'work']) {
        try { fs.cpSync(path.join(sandbox.dir, folder), path.join(saved, folder), { recursive: true }); } catch { /* nothing to keep */ }
      }
      for (const file of ['mock-requests.jsonl', 'fake-state.json']) {
        try { fs.copyFileSync(path.join(sandbox.dir, file), path.join(saved, file)); } catch { /* optional */ }
      }
      say(`Logs kept in ${saved}`);
    }
    try { sandbox.cleanup(); } catch (error) { say(`Could not remove ${sandbox.dir}: ${error.message}`); }
  }
}

main().then(ok => { process.exitCode = ok ? 0 : 1; }).catch(error => {
  say(`FAILED: ${error.message}`);
  process.exitCode = 1;
});
