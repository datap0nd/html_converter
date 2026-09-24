import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, writeJson } from '../scripts/core.mjs';
import { createGeminiWorkspace, runPhase, geminiResponseArtifact, geminiFailureDetail, isTransientGeminiFailure } from '../scripts/start-live-report.mjs';
import { prepareSourceContext } from '../scripts/context.mjs';
import { parseGeminiOutput, runGeminiAsync } from '../scripts/gemini.mjs';
import { captureArtifacts, inputFingerprint, saveCheckpoint } from '../scripts/checkpoints.mjs';

function cleanup(directory) {
  const resolved = path.resolve(directory);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.match(path.basename(resolved), /^html-converter-(test|gemini)-/);
  fs.rmSync(resolved, { recursive: true, force: true });
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  t.after(() => cleanup(directory));
  const stage = path.join(directory, 'stage');
  const runDir = path.join(directory, 'logs');
  const scope = { pageLimit: 2, workDir: path.join(directory, 'saved/work'), dynamicDir: path.join(directory, 'saved/output') };
  for (const dir of [stage, runDir, scope.workDir, scope.dynamicDir, path.join(stage, 'work'), path.join(stage, 'output/dynamic'), path.join(stage, 'input')]) fs.mkdirSync(dir, { recursive: true });
  const write = (file, content) => { const target = path.join(stage, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content); };
  const read = file => fs.readFileSync(path.join(stage, file), 'utf8');
  return { directory, stage, runDir, scope, write, read };
}

const buildPhase = ['02-build', 'prompts/live-02-build.md', 'work/live-build.json'];
const success = { status: 0, stdout: '{"response":"Done"}', stderr: '' };

test('staged workspace includes CLI controls and source packets, excludes other pages and data', t => {
  const f = fixture(t);
  f.write('input/Demo.Report/definition/pages/one/page.json', '{"name":"one"}');
  f.write('input/Demo.Report/definition/pages/two/page.json', '{"name":"two"}');
  f.write('input/Demo.SemanticModel/definition/tables/Sales.tmdl', 'table Sales');
  f.write('input/data/export.json', '[{"private":1}]');
  f.write('input/.env', 'PG_PASSWORD=private');
  f.write('input/Demo.SemanticModel/.pbi/localSettings.json', '{"private":true}');
  writeJson(path.join(f.scope.workDir, 'live-run.json'), { scope: 'first-1-pages' });
  const stage = createGeminiWorkspace({ pages: [{ id: 'one' }] }, f.scope, { sourceInput: path.join(f.stage, 'input') });
  t.after(() => cleanup(stage));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stage, '.gemini/settings.json'))), JSON.parse(fs.readFileSync(path.join(root, '.gemini/settings.json'))));
  assert.equal(fs.readFileSync(path.join(stage, '.geminiignore'), 'utf8'), fs.readFileSync(path.join(root, '.geminiignore'), 'utf8'));
  const context = JSON.parse(fs.readFileSync(path.join(stage, 'work/source-context.json')));
  assert.equal(context.sourceFileCount, 2);
  for (const excluded of ['input/.env', 'input/data/export.json', 'input/Demo.Report/definition/pages/two', 'input/Demo.SemanticModel/.pbi']) assert.equal(fs.existsSync(path.join(stage, excluded)), false);
});

test('source packets batch many small files and retain oversized original references without truncation', t => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) f.write(`input/visual-${i}.json`, JSON.stringify({ visual: i, title: 'Sales Δ' }));
  f.write('input/large.tmdl', 'x'.repeat(50_000));
  const context = prepareSourceContext(f.stage);
  assert.equal(context.sourceFileCount, 101);
  assert.ok(context.packets.length < 5, '100 reads should become a handful');
  assert.deepEqual(context.largeFiles.map(file => file.path), ['input/large.tmdl']);
  const contents = context.packets.map(packet => {
    assert.ok(packet.bytes <= 48_000);
    const content = f.read(packet.path);
    assert.ok(content.split('\n').length <= 800);
    return content;
  }).join('\n');
  for (let i = 0; i < 100; i++) assert.ok(contents.includes(f.read(`input/visual-${i}.json`)));
});

test('missing summary continuation preserves generated code, rolls back a failed capacity attempt', async t => {
  const f = fixture(t);
  let calls = 0;
  await runPhase(buildPhase, 'gemini-3.8-flash', f.runDir, f.stage, {}, f.scope, {
    sleep: async () => {},
    invoke: async args => {
      calls++;
      assert.ok(args.includes('stream-json'));
      if (calls === 1) {
        f.write('output/dynamic/index.html', '<html>completed</html>');
        f.write('output/dynamic/backend.mjs', 'export const completed = true;');
      } else {
        assert.equal(f.read('output/dynamic/index.html'), '<html>completed</html>');
        assert.equal(f.read('output/dynamic/backend.mjs'), 'export const completed = true;');
        assert.match(args.at(-1), /continuation/);
        if (calls === 2) {
          f.write('output/dynamic/index.html', 'corrupted by failed attempt');
          return { status: 1, stderr: 'RESOURCE_EXHAUSTED', stdout: '' };
        }
        f.write('work/live-build.json', '{"implemented":["visual-1"]}');
      }
      return { ...success };
    }
  });
  assert.equal(calls, 3);
  assert.equal(fs.readFileSync(path.join(f.scope.dynamicDir, 'index.html'), 'utf8'), '<html>completed</html>');
  assert.ok(fs.existsSync(path.join(f.runDir, '02-build.attempt-3.metrics.json')));
});

test('persistent missing artifacts stop after one continuation and retain unapproved partial files', async t => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(runPhase(buildPhase, 'gemini-3.8-flash', f.runDir, f.stage, {}, f.scope, {
    invoke: async () => { calls++; f.write('output/dynamic/index.html', '<html>partial</html>'); return { ...success }; }
  }), /missing work\/live-build.json, output\/dynamic\/backend.mjs after 2 attempt/);
  assert.equal(calls, 2);
  assert.equal(fs.existsSync(path.join(f.scope.dynamicDir, 'index.html')), false);
  assert.equal(fs.readFileSync(path.join(f.runDir, '02-build.partial/output/dynamic/index.html'), 'utf8'), '<html>partial</html>');
});

test('structured streaming errors cannot be checkpointed even when the CLI exits zero', async t => {
  const f = fixture(t);
  await assert.rejects(runPhase(buildPhase, 'gemini-3.8-flash', f.runDir, f.stage, { PG_PASSWORD: 'secret-value' }, f.scope, {
    invoke: async () => {
      f.write('work/live-build.json', '{}');
      f.write('output/dynamic/index.html', '<html>unapproved</html>');
      f.write('output/dynamic/backend.mjs', 'export {};');
      return { status: 0, stdout: JSON.stringify({ type: 'result', status: 'error', error: { message: 'bad secret-value' } }) };
    }
  }), error => /bad \[redacted\]/.test(error.message) && !error.message.includes('secret-value'));
  assert.equal(fs.existsSync(path.join(f.scope.dynamicDir, 'index.html')), false);
});

test('budget failure explains the provider error instead of claiming all 15 minutes elapsed', async t => {
  const f = fixture(t);
  let clock = 0;
  await assert.rejects(runPhase(buildPhase, 'gemini-3.8-flash', f.runDir, f.stage, {}, f.scope, {
    now: () => clock,
    invoke: async () => { clock = 890_000; return { status: 1, stderr: '429 capacity unavailable; retryDelay: 30s' }; }
  }), /cannot retry within the 15-minute phase budget after 1 attempt\(s\), 890s\. 429 capacity/);
});

test('streaming parser recovers final JSON, ignores warning events and preserves provider errors', () => {
  assert.equal(geminiResponseArtifact('null'), null);
  assert.equal(geminiResponseArtifact(null), null);
  const lines = [
    { type: 'message', role: 'assistant', content: 'Reading sources.' },
    { type: 'tool_use', tool_name: 'read_file' },
    { type: 'error', severity: 'warning', message: 'cosmetic warning' },
    { type: 'message', role: 'assistant', content: '{"status":' },
    { type: 'message', role: 'assistant', content: '"complete"}' },
    { type: 'result', status: 'success', stats: { tool_calls: 1 } }
  ].map(event => JSON.stringify(event)).join('\n');
  assert.deepEqual(geminiResponseArtifact(lines), { status: 'complete' });
  assert.equal(parseGeminiOutput(lines).stats.tool_calls, 1);
  assert.equal(geminiFailureDetail({ stdout: JSON.stringify({ type: 'result', status: 'error', error: { message: 'quota exhausted' } }) }), 'quota exhausted');
  assert.equal(isTransientGeminiFailure({ status: 1, stderr: 'permission denied', stdout: JSON.stringify({ type: 'tool_result', output: 'This source contains 429 rows' }) }), false);
});

function fakeCli(f, code) {
  const packageDir = path.join(f.directory, 'node_modules/@google/gemini-cli');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(f.directory, 'gemini.cmd'), '@echo off\r\nexit /b 9\r\n');
  writeJson(path.join(packageDir, 'package.json'), { bin: { gemini: 'index.mjs' } });
  fs.writeFileSync(path.join(packageDir, 'index.mjs'), code);
  return { PATH: f.directory + path.delimiter + process.env.PATH };
}

test('Windows launcher streams split UTF-8 events and records activity before exit', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const env = fakeCli(f, `const data = Buffer.from(JSON.stringify({type:'message', role:'assistant', content:'Δ'})+'\\n'); const split = data.indexOf(Buffer.from('Δ'))+1; process.stdout.write(data.subarray(0,split)); setTimeout(()=>process.stdout.write(data.subarray(split)), 20); setTimeout(()=>process.stdout.write(JSON.stringify({type:'tool_use',tool_name:'write_file'})+'\\n'), 40);`);
  let output = '';
  const events = [];
  const result = await runGeminiAsync(['--output-format', 'stream-json'], { cwd: f.stage, env, onStdout: chunk => { output += chunk; }, onEvent: event => events.push(event) });
  assert.equal(result.status, 0);
  assert.equal(output, result.stdout);
  assert.equal(events[0].content, 'Δ');
  assert.equal(result.metrics.toolCalls, 1);
});

test('Windows launcher stops a silent CLI before the overall phase deadline', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const env = fakeCli(f, 'setInterval(() => {}, 1000);');
  const result = await runGeminiAsync(['--output-format', 'stream-json'], { cwd: f.stage, env, timeout: 20_000, idleTimeoutMs: 100 });
  assert.match(result.error.message, /produced no output/);
  assert.ok(result.metrics.elapsedMs < 6000);
});

test('Windows timeout terminates descendants that hold the output pipes open', { skip: process.platform !== 'win32' }, async t => {
  const f = fixture(t);
  const env = fakeCli(f, `import {spawn} from 'node:child_process'; const child = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {stdio:['ignore',process.stdout,process.stderr],windowsHide:true}); console.log(JSON.stringify({type:'init',childPid:child.pid})); setInterval(()=>{},1000);`);
  let descendant;
  t.after(() => { if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch {} } });
  const result = await runGeminiAsync(['--output-format', 'stream-json'], {
    cwd: f.stage, env, timeout: 5000, idleTimeoutMs: 500,
    onEvent: event => { descendant = event.childPid; }
  });
  assert.ok(descendant, 'fake CLI must start its child');
  assert.match(result.error.message, /produced no output/);
  assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
  descendant = null;
});

function reportFixture(t) {
  const f = fixture(t);
  for (const folder of ['scripts', 'prompts', 'skills', '.gemini']) fs.cpSync(path.join(root, folder), path.join(f.stage, folder), { recursive: true });
  for (const file of ['GEMINI.md', '.geminiignore']) fs.copyFileSync(path.join(root, file), path.join(f.stage, file));
  f.write('.env', '');
  f.write('input/Report.pbip', '{}');
  f.write('input/Demo.Report/definition.pbir', '{"datasetReference":{"byPath":{"path":"../Demo.SemanticModel"}}}');
  f.write('input/Demo.Report/definition/pages/one/page.json', '{"name":"one"}');
  f.write('input/Demo.Report/definition/pages/one/visuals/v1/visual.json', '{"visual":{"visualType":"card"}}');
  f.write('input/Demo.SemanticModel/definition/model.tmdl', 'model Model');
  return f;
}

test('restart after an upstream change and failed build cannot reuse an old build or review', { skip: process.platform !== 'win32' }, t => {
  const f = reportFixture(t);
  f.write('work/live-interpretation.json', '{}');
  f.write('work/live-build.json', '{}');
  f.write('work/live-review.json', '{"status":"pass","limitations":[],"unverified":[]}');
  f.write('output/dynamic/index.html', 'old HTML');
  f.write('output/dynamic/backend.mjs', 'old backend');
  const stateFile = path.join(f.stage, 'work/live-state.json');
  saveCheckpoint(stateFile, {
    version: 1, inputFingerprint: inputFingerprint(path.join(f.stage, 'input')), repairs: {}, phases: {
      '01-interpret': { artifacts: { 'work/live-interpretation.json': 'changed' } },
      '02-build': { artifacts: captureArtifacts(f.stage, ['work/live-build.json', 'output/dynamic/index.html', 'output/dynamic/backend.mjs']) },
      '03-review': { artifacts: captureArtifacts(f.stage, ['work/live-review.json']) }
    }
  });
  const env = fakeCli(f, `import fs from 'node:fs'; const phase = process.argv.at(-1).includes('live-01-interpret') ? 'interpret' : 'build'; fs.appendFileSync(process.env.HC_TEST_LOG,phase+'\\n'); if(phase==='interpret'){fs.writeFileSync('work/live-interpretation.json','{"pages":[]}'); console.log(JSON.stringify({type:'result',status:'success'}));}else{console.error('intentional build failure');process.exitCode=1;}`);
  const log = path.join(f.directory, 'calls.txt');
  for (let run = 0; run < 2; run++) {
    const result = spawnSync(process.execPath, ['scripts/start-live-report.mjs'], { cwd: f.stage, env: { ...process.env, ...env, HC_TEST_LOG: log }, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /intentional build failure/);
    const state = JSON.parse(fs.readFileSync(stateFile));
    assert.ok(state.phases['01-interpret']);
    assert.equal(state.phases['02-build'], undefined);
    assert.equal(state.phases['03-review'], undefined);
  }
  assert.equal(fs.readFileSync(log, 'utf8'), 'interpret\nbuild\nbuild\n');
  assert.equal(f.read('output/dynamic/index.html'), 'old HTML', 'failed build must not publish output');
});

test('coverage repairs precede the only independent review and a failed review resumes without rebuilding', { skip: process.platform !== 'win32' }, t => {
  const f = reportFixture(t);
  const env = fakeCli(f, `
    import fs from 'node:fs';
    const prompt = process.argv.at(-1);
    const phase = prompt.includes('live-01-interpret') ? 'interpret' : prompt.includes('live-02-build') ? 'build' : prompt.includes('live-04-page-repair') ? 'repair' : prompt.includes('live-05-final-review') ? 'final' : 'review';
    fs.appendFileSync(process.env.HC_TEST_LOG, phase+'\\n');
    if (phase === 'interpret') fs.writeFileSync('work/live-interpretation.json', '{}');
    if (phase === 'build') {
      fs.writeFileSync('work/live-build.json', '{}');
      fs.writeFileSync('output/dynamic/index.html', '<html><div id="report-status"></div><section data-page-id="one"></section><script>fetch("/api/report")</script></html>');
      fs.writeFileSync('output/dynamic/backend.mjs', 'export {};');
    }
    if (phase === 'repair') {
      const html = fs.readFileSync('output/dynamic/index.html','utf8').replace('</section>', '<article data-visual-id="v1">Visual</article></section>');
      fs.writeFileSync('output/dynamic/index.html', html);
      fs.writeFileSync(prompt.match(/work\\/page-repair-[a-zA-Z0-9_-]+\\.json/)[0], '{"status":"complete"}');
    }
    if (phase === 'final') {
      if (!fs.existsSync(process.env.HC_TEST_REVIEW_MARKER)) {
        fs.writeFileSync(process.env.HC_TEST_REVIEW_MARKER, 'attempted');
        console.error('intentional review failure'); process.exit(1);
      }
      fs.writeFileSync('work/live-final-review.json', '{"status":"blocked","limitations":[],"unverified":[]}');
    }
    console.log(JSON.stringify({type:'result',status:'success'}));
  `);
  const log = path.join(f.directory, 'calls.txt');
  const marker = path.join(f.directory, 'review-attempt.txt');
  for (let run = 0; run < 2; run++) {
    const result = spawnSync(process.execPath, ['scripts/start-live-report.mjs'], { cwd: f.stage, env: { ...process.env, ...env, HC_TEST_LOG: log, HC_TEST_REVIEW_MARKER: marker }, encoding: 'utf8', timeout: 15_000, windowsHide: true });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, run === 0 ? /intentional review failure/ : /Independent Gemini review did not approve/);
    const state = JSON.parse(f.read('work/live-state.json'));
    assert.equal(state.reviewPending, run === 0);
  }
  assert.equal(fs.readFileSync(log, 'utf8'), 'interpret\nbuild\nrepair\nfinal\nfinal\n');
});
