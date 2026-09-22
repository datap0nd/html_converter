import path from 'node:path';
import { discover, dynamicDir, writeJson } from './core.mjs';
import { loadLocalEnv } from './env.mjs';
import { loadAllData } from './sources.mjs';
import { makeSnapshot } from './snapshot.mjs';

try {
  const data = await loadAllData(discover(), loadLocalEnv());
  writeJson(path.join(dynamicDir, 'report-data.json'), data);
  const target = makeSnapshot();
  console.log(`Refreshed ${target} from ${data.datasets.length} dataset(s).`);
} catch (error) {
  console.error(`Snapshot refresh failed: ${error.message}`);
  process.exitCode = 1;
}
