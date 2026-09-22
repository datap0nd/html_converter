import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root } from './core.mjs';

export function ensurePostgresDriver(inventory) {
  if (!(inventory.postgresSources ?? []).length) return;
  if (fs.existsSync(path.join(root, 'node_modules', 'pg', 'package.json'))) return;
  console.log('Installing the PostgreSQL driver once from npm...');
  const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm install --no-audit --no-fund --ignore-scripts']
    : ['install', '--no-audit', '--no-fund', '--ignore-scripts'];
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 5 * 60 * 1000, maxBuffer: 5 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`PostgreSQL driver install failed. Check your npm/proxy access, then run npm install in gemini/. ${(result.stderr || result.stdout || '').slice(-1000)}`);
}
