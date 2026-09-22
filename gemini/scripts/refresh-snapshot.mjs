import path from 'node:path';
import { discover, loadData, dynamicDir, writeJson } from './core.mjs';
import { makeSnapshot } from './snapshot.mjs';

try {
  const data = loadData(discover());
  writeJson(path.join(dynamicDir, 'report-data.json'), data);
  const target = makeSnapshot();
  console.log(`Refreshed ${target} from ${data.datasets.length} dataset(s).`);
} catch (error) {
  console.error(`Snapshot refresh failed: ${error.message}`);
  process.exitCode = 1;
}
