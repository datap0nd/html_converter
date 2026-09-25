// Runs against a real PostgreSQL seeded with tests/fixtures/data/salespostgres-seed.sql.
// Set HC_TEST_PG=host:port:user:password (a read-only login on database "analytics").
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSandbox, geminiDir } from '../selftest/sandbox.mjs';

const [host, port, user, password] = (process.env.HC_TEST_PG ?? '').split(':');
const skip = !process.env.HC_TEST_PG && 'set HC_TEST_PG=host:port:user:password to run against a real PostgreSQL';
const base = { PG_HOST: host, PG_PORT: port, PG_USER: user, PG_PASSWORD: password, PG_SSL_MODE: 'disable', PG_ALLOW_NATIVE_QUERIES: 'true' };

function convert(env) {
  const sandbox = createSandbox({ fixture: 'SalesPostgres', env });
  try {
    const result = spawnSync(process.execPath, [path.join(sandbox.dir, 'scripts', 'start-live-report.mjs'), '--page-limit', '2', '--no-serve'], { cwd: sandbox.dir, encoding: 'utf8', env: { ...process.env, HC_GEMINI_ENTRY: path.join(geminiDir, 'selftest', 'fake-gemini-cli.mjs'), FAKE_GEMINI_STATE: path.join(sandbox.dir, 'state.json') } });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally { sandbox.cleanup(); }
}

test('PostgreSQL report converts end to end through the pg driver helpers', { skip }, () => {
  const result = convert(base);
  assert.equal(result.code, 0, result.stdout);
  assert.match(result.stdout, /PostgreSQL .* reachable as /);
  assert.match(result.stdout, /8 visual query\(ies\) answered, 0 placeholder/);
  assert.equal(result.stderr, '');
});

test('PostgreSQL problems stop in preflight with the right fix and no secret in the output', { skip }, () => {
  const cases = [
    [{ PG_PASSWORD: 'definitely-wrong-password' }, /rejected PG_USER\/PG_PASSWORD/],
    [{ PG_SSL_MODE: 'verify-full' }, /does not accept TLS|certificate/],
    [{ PG_ALLOW_NATIVE_QUERIES: 'false' }, /set PG_ALLOW_NATIVE_QUERIES=true/]
  ];
  for (const [change, hint] of cases) {
    const result = convert({ ...base, ...change });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /CONVERSION STOPPED at preflight/);
    assert.match(result.stdout, hint);
    assert.doesNotMatch(result.stdout, /Attempt 1 of 4/, 'no Gemini phase ran');
    assert.doesNotMatch(result.stdout, new RegExp(password));
    assert.doesNotMatch(result.stdout, /definitely-wrong-password/);
  }
});
