// Stand-in for pbi-query.ps1 in tests: answers every query with rows computed by
// the same formula the fake model's "parity" backends use (selftest/fake-model.mjs).
//   node fake-pbi-runner.mjs <request.json> <result.json>
// FAKE_PBI_MODE: match (default) | error (no Power BI client) | query-error (every query fails)
import fs from 'node:fs';
import { parityRows } from './fake-model.mjs';

const [requestFile, resultFile] = process.argv.slice(2);
const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
const mode = process.env.FAKE_PBI_MODE ?? 'match';
console.log(`[pbi] fake runner (${mode}): ${request.queries.length} quer(ies) on port(s) ${request.ports.join(', ')}`);
let result;
if (mode === 'error') {
  result = { ok: false, error: 'No usable ADOMD.NET client library (Microsoft.AnalysisServices.AdomdClient.dll) was found. (test)', instances: [] };
} else {
  result = {
    ok: true, adomd: 'fake', port: request.ports[0], instances: [{ port: request.ports[0], tables: request.tables, matched: request.tables.length }],
    results: request.queries.map(query => {
      if (mode === 'query-error') return { id: query.id, columns: [], rows: [], ms: 1, error: 'Query (1, 23) The syntax for ... is incorrect. (test)' };
      const rows = parityRows(query.groupBy, query.values);
      return { id: query.id, columns: [...query.groupBy, ...query.values], rows: rows.map(row => [...query.groupBy, ...query.values].map(ref => row[ref])), ms: 1, error: null };
    })
  };
}
fs.writeFileSync(resultFile, JSON.stringify(result));
