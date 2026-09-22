import fs from 'node:fs';
import path from 'node:path';
import { dynamicDir, staticDir, scriptJson } from './core.mjs';

export function makeSnapshot(sourceDir = dynamicDir, targetDir = staticDir) {
  const source = path.join(sourceDir, 'index.html');
  const dataPath = path.join(sourceDir, 'report-data.json');
  const html = fs.readFileSync(source, 'utf8');
  if (!html.includes('__EMBEDDED_REPORT_DATA__')) throw new Error('Dynamic HTML lost the embedded-data placeholder. Restore it before snapshot packaging.');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const embedded = html.replace('__EMBEDDED_REPORT_DATA__', scriptJson(data));
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, 'report.html');
  fs.writeFileSync(target, embedded);
  return target;
}
