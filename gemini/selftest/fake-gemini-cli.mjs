#!/usr/bin/env node
// Imitates the Gemini CLI 0.61.0 headless interface (flags, stream-json events,
// json envelope, exit codes) for fast converter tests. Point the converter at it
// with HC_GEMINI_ENTRY. Behaviour is chosen with FAKE_GEMINI_SCENARIO switches;
// FAKE_GEMINI_STATE (a JSON file) counts calls per phase across processes.
import fs from 'node:fs';
import path from 'node:path';
import { phaseFiles, phaseFromPrompt } from './fake-model.mjs';

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const prompt = option('-p') ?? option('--prompt') ?? '';
const format = option('--output-format') ?? option('-o') ?? 'text';
const scenario = process.env.FAKE_GEMINI_SCENARIO ?? '';
const switches = new Set(scenario.split(',').map(value => value.trim()).filter(Boolean));
const cwd = process.cwd();

if (switches.has('old-cli') && format === 'stream-json') {
  process.stderr.write('Usage: gemini [options] [command]\n\nInvalid values:\n  Argument: output-format, Given: "stream-json", Choices: "text", "json"\n');
  process.exit(1);
}
if (switches.has('old-cli') && args.includes('--skip-trust')) {
  process.stderr.write('Unknown arguments: skip-trust, skipTrust\n');
  process.exit(1);
}

const { phase } = phaseFromPrompt(prompt);
const stateFile = process.env.FAKE_GEMINI_STATE;
const state = stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { counts: {}, calls: [] };
const count = state.counts[phase] ?? 0;
state.counts[phase] = count + 1;
const call = { phase, args: args.filter(value => value !== prompt), cwd };
if (switches.has('list-stage')) {
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.relative(cwd, path.join(dir, entry.name)).replaceAll('\\', '/')]);
  call.files = walk(cwd);
  call.contents = Object.fromEntries(call.files.filter(file => file.startsWith('work/') || file.startsWith('input/')).map(file => [file, fs.readFileSync(path.join(cwd, file), 'utf8')]));
}
state.calls.push(call);
if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

process.stderr.write('Warning: 256-color support not detected. Using a terminal with at least 256-color support is recommended for a better visual experience.\n');

if (switches.has('sign-in-prompt')) {
  process.stdout.write('Opening authentication page in your browser. Do you want to continue? [Y/n]: ');
  setInterval(() => {}, 1000);
} else if (switches.has(`stall-${phase}`) && count === 0) {
  emit({ type: 'init', session_id: 'fake', model: option('--model') });
  setInterval(() => {}, 1000);
} else {
  run();
}

function emit(event) {
  if (format === 'stream-json') process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n');
}

function run() {
  const started = Date.now();
  emit({ type: 'init', session_id: 'fake', model: option('--model') });
  emit({ type: 'message', role: 'user', content: prompt });
  emit({ type: 'tool_use', tool_name: 'read_file', tool_id: 'read-1', parameters: { file_path: path.join(cwd, 'work', 'report-digest.json') } });
  emit({ type: 'tool_result', tool_id: 'read-1', status: 'success', output: '' });
  if (switches.has(`quota-${phase}`) && count === 0) {
    const message = '[API Error: You exceeded your current quota. Please retry in 1s. RESOURCE_EXHAUSTED (429)]';
    emit({ type: 'result', status: 'error', error: { type: 'Error', message }, stats: stats(started) });
    if (format !== 'stream-json') process.stderr.write(message + '\n');
    process.exit(1);
  }
  const { files, text } = phaseFiles({ prompt, cwd, scenario, count });
  for (const [index, file] of files.entries()) {
    emit({ type: 'tool_use', tool_name: 'write_file', tool_id: `write-${index}`, parameters: { file_path: path.join(cwd, file.path), content: file.content } });
    fs.mkdirSync(path.dirname(path.join(cwd, file.path)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file.path), file.content);
    emit({ type: 'tool_result', tool_id: `write-${index}`, status: 'success', output: `Successfully wrote ${file.path}` });
  }
  emit({ type: 'message', role: 'assistant', content: text, delta: true });
  if (switches.has(`hang-after-write-${phase}`) && count === 0) { setInterval(() => {}, 1000); return; }
  emit({ type: 'result', status: 'success', stats: stats(started) });
  if (format === 'json') process.stdout.write(JSON.stringify({ session_id: 'fake', response: text, stats: {} }, null, 2) + '\n');
  if (format === 'text') process.stdout.write(text + '\n');
}

function stats(started) {
  return { total_tokens: 1200, input_tokens: 1000, output_tokens: 200, cached: 0, input: 1000, duration_ms: Date.now() - started, tool_calls: 2, models: {} };
}
