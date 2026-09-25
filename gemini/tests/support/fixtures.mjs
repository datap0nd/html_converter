// Builds a throwaway copy of the converter folder with a fixture PBIP in input/,
// the way setup.ps1 leaves it on a user's PC.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const geminiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fixturesDir = path.join(geminiDir, 'tests', 'fixtures');

export function createSandbox({ fixture = 'SalesCsv', env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  for (const name of ['scripts', 'prompts', 'skills']) fs.cpSync(path.join(geminiDir, name), path.join(dir, name), { recursive: true });
  for (const name of ['GEMINI.md', 'GEMINI.live.md', 'package.json', '.env.example']) fs.copyFileSync(path.join(geminiDir, name), path.join(dir, name));
  if (fs.existsSync(path.join(geminiDir, 'node_modules'))) fs.symlinkSync(path.join(geminiDir, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  const sourceData = path.join(dir, 'source-data') + path.sep;
  const source = path.join(fixturesDir, fixture);
  fs.cpSync(path.join(source, 'data'), sourceData, { recursive: true });
  const input = path.join(dir, 'input');
  fs.cpSync(source, input, { recursive: true, filter: file => !path.relative(source, file).replaceAll('\\', '/').startsWith('data') && !file.endsWith('README.md') });
  for (const file of walk(input)) {
    if (!/\.(tmdl|json|pbir|pbism|pbip|bim)$/i.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('{{DATA_DIR}}')) fs.writeFileSync(file, text.replaceAll('{{DATA_DIR}}', /\.bim$|\.json$/i.test(file) ? sourceData.replaceAll('\\', '\\\\') : sourceData));
  }
  // Desktop leaves these next to the report; the converter must never stage them.
  const pbi = path.join(input, `${fixture}.Report`, '.pbi');
  fs.mkdirSync(pbi, { recursive: true });
  fs.writeFileSync(path.join(pbi, 'localSettings.json'), '{"version":"1.0","remoteArtifacts":[]}');
  fs.writeFileSync(path.join(pbi, 'cache.abf'), 'not a real cache');
  fs.writeFileSync(path.join(dir, '.env'), Object.entries({ PG_ALLOW_NATIVE_QUERIES: 'false', ...env }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  return {
    dir,
    input,
    sourceData,
    cleanup() {
      const resolved = path.resolve(dir);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }
  };
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
