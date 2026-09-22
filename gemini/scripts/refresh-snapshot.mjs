import path from 'node:path';
import fs from 'node:fs';
import { discover, dynamicDir, writeJson } from './core.mjs';
import { loadLocalEnv } from './env.mjs';
import { loadAllData } from './sources.mjs';
import { exportDesktopModel } from './desktop-model.mjs';
import { makeSnapshot } from './snapshot.mjs';

try {
  const dynamicHtml = path.join(dynamicDir, 'index.html');
  if (!fs.existsSync(dynamicHtml) || !fs.readFileSync(dynamicHtml, 'utf8').includes('__EMBEDDED_REPORT_DATA__')) {
    throw new Error('The live preview cannot be snapshotted by this legacy command. Run npm run convert to create a snapshot-capable report first.');
  }
  const env = loadLocalEnv();
  const inventory = discover();
  const data = (env.DATA_MODE || 'desktop') === 'desktop' ? (await exportDesktopModel(inventory, env, { onProgress: message => console.log(`[desktop] ${message}`) })).data : await loadAllData(inventory, env);
  writeJson(path.join(dynamicDir, 'report-data.json'), data);
  const target = makeSnapshot();
  console.log(`Refreshed ${target} from ${data.datasets.length} dataset(s).`);
} catch (error) {
  console.error(`Snapshot refresh failed: ${error.message}`);
  process.exitCode = 1;
}
