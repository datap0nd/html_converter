import path from 'node:path';
import { discover, dynamicDir, writeJson } from './core.mjs';
import { loadLocalEnv } from './env.mjs';
import { loadAllData } from './sources.mjs';
import { exportDesktopModel } from './desktop-model.mjs';
import { makeSnapshot } from './snapshot.mjs';

try {
  const env = loadLocalEnv();
  const inventory = discover();
  const data = (env.DATA_MODE || 'desktop') === 'desktop' ? exportDesktopModel(inventory, env).data : await loadAllData(inventory, env);
  writeJson(path.join(dynamicDir, 'report-data.json'), data);
  const target = makeSnapshot();
  console.log(`Refreshed ${target} from ${data.datasets.length} dataset(s).`);
} catch (error) {
  console.error(`Snapshot refresh failed: ${error.message}`);
  process.exitCode = 1;
}
