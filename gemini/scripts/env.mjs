import fs from 'node:fs';
import path from 'node:path';
import { root } from './core.mjs';

const envFile = path.join(root, '.env');
const template = path.join(root, '.env.example');

export function loadLocalEnv() {
  if (!fs.existsSync(envFile)) {
    fs.copyFileSync(template, envFile, fs.constants.COPYFILE_EXCL);
    console.log('Created gemini/.env. Fill PostgreSQL credentials there if this report uses PostgreSQL.');
  }
  const values = {};
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  // An explicitly set process variable wins, without exposing it to Gemini prompts.
  for (const key of Object.keys(values)) if (Object.hasOwn(process.env, key)) values[key] = process.env[key];
  return values;
}
