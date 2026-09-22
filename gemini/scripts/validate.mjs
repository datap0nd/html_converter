import fs from 'node:fs';
import path from 'node:path';
import { dynamicDir, staticDir, workDir, readJson, writeJson } from './core.mjs';

export function validate({ final = false } = {}) {
  const issues = [];
  const dynamicHtml = path.join(dynamicDir, 'index.html');
  const staticHtml = path.join(staticDir, 'report.html');
  const dataFile = path.join(dynamicDir, 'report-data.json');
  for (const file of [dynamicHtml, dataFile, ...(final ? [staticHtml] : [])]) if (!fs.existsSync(file)) issues.push(`Missing ${file}`);
  if (!issues.length) {
    const dynamic = fs.readFileSync(dynamicHtml, 'utf8');
    const data = readJson(dataFile);
    if (!data || !Array.isArray(data.datasets)) issues.push('Invalid report-data.json.');
    if (!dynamic.includes('__EMBEDDED_REPORT_DATA__')) issues.push('Dynamic HTML lacks snapshot placeholder.');
    if (!dynamic.includes('id="embedded-report-data"')) issues.push('Dynamic HTML lacks embedded-data script element.');
    if (final) {
      const stat = fs.readFileSync(staticHtml, 'utf8');
      if (stat.includes('__EMBEDDED_REPORT_DATA__')) issues.push('Static snapshot still has placeholder.');
      if (!stat.includes('id="embedded-report-data"')) issues.push('Static snapshot lacks embedded data.');
      if (/(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(stat) || /(?:fetch|import)\s*\(\s*["']https?:/i.test(stat)) issues.push('Static HTML appears to reference a remote asset.');
      if (/<(?:script|link|img)\b[^>]+(?:src|href)\s*=\s*["'](?!data:|#)/i.test(stat)) issues.push('Static HTML appears to reference an external/local asset. Inline it.');
      const review = readJson(path.join(workDir, 'final-review.json'));
      if (!review || !['pass', 'warnings', 'blocked'].includes(review.status)) issues.push('Missing/invalid final-review.json status.');
      else if (review.status === 'blocked') issues.push('Final reviewer marked output blocked.');
    }
  }
  const result = { checkedAt: new Date().toISOString(), passed: issues.length === 0, issues };
  writeJson(path.join(workDir, final ? 'final-checks.json' : 'dynamic-checks.json'), result);
  return result;
}
