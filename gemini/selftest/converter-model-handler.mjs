// Mock Gemini API handler that plays the fake model through the REAL Gemini CLI:
// turn 0 reads the digest with read_file, turn 1 writes the phase files with
// write_file, turn 2 finishes. Scenario switches come from FAKE_GEMINI_SCENARIO.
import { phaseFiles, phaseFromPrompt } from './fake-model.mjs';

const counts = {};
const served = {};

function promptText(contents) {
  for (const content of contents ?? []) {
    for (const part of content.parts ?? []) if (typeof part.text === 'string' && /prompts\/live-0\d-/.test(part.text)) return part.text;
  }
  return '';
}

export default async function handle(ctx) {
  if (ctx.kind === 'generateContent') return { text: '{}' };
  const prompt = promptText(ctx.contents);
  const { phase } = phaseFromPrompt(prompt);
  const scenario = process.env.FAKE_GEMINI_SCENARIO ?? '';
  const absolute = relative => ctx.cwd + ctx.sep + relative.split('/').join(ctx.sep);
  if (!phase) return { text: 'The mock model did not find a converter phase prompt.' };
  const switches = new Set(scenario.split(',').map(value => value.trim()));
  if (ctx.turn === 0) {
    // API-level failures, seen by the real CLI exactly as Google would send them (first request of the phase only).
    if (switches.has(`api-429-${phase}`) && (served[`429-${phase}`] = (served[`429-${phase}`] ?? 0) + 1) === 1) return { httpError: { code: 429, retryDelay: '1s', message: 'Resource has been exhausted (mock). Please retry in 1s.' } };
    if (switches.has(`api-hang-${phase}`) && (served[`hang-${phase}`] = (served[`hang-${phase}`] ?? 0) + 1) === 1) return { delayMs: 10 * 60 * 1000, text: 'late' };
  }
  if (ctx.turn === 0) return { text: `Starting phase ${phase}.`, functionCalls: [{ name: 'read_file', args: { file_path: absolute('work/report-digest.json') } }] };
  if (ctx.turn === 1) {
    const count = counts[phase] ?? 0;
    counts[phase] = count + 1;
    const { files, text } = phaseFiles({ prompt, cwd: ctx.cwd, scenario, count });
    if (!files.length) return { text };
    return { functionCalls: files.map(file => ({ name: 'write_file', args: { file_path: absolute(file.path), content: file.content } })) };
  }
  const failed = ctx.functionResponses.filter(response => response.response?.error);
  return { text: failed.length ? `Some writes failed: ${failed.map(item => item.response.error).join('; ')}` : `Phase ${phase} complete.` };
}
