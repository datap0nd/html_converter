import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, scriptJson } from '../scripts/core.mjs';
import { createPreview } from '../scripts/preview.mjs';
import { makeSnapshot } from '../scripts/snapshot.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('CSV handles quoted commas and newlines', () => {
  const data = parseCsv('name,amount\r\n"A, B",12\r\n"Line\none",8\r\n');
  assert.deepEqual(data.columns, ['name', 'amount']);
  assert.deepEqual(data.rows, [{ name: 'A, B', amount: '12' }, { name: 'Line\none', amount: '8' }]);
});

test('embedded JSON cannot terminate its script element', () => {
  const encoded = scriptJson({ value: '</script><script>alert(1)</script>' });
  assert.equal(encoded.includes('</script>'), false);
  assert.deepEqual(JSON.parse(encoded), { value: '</script><script>alert(1)</script>' });
});

test('PBIP-only preview is explicit and static snapshot embeds the local data contract', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const dynamic = path.join(dir, 'dynamic');
    const stat = path.join(dir, 'static');
    createPreview({ project: 'input/Demo.pbip', pages: [{ name: 'Overview', visuals: [{ id: 'v1', title: 'Sales', type: 'barChart', source: 'input/Demo.Report/definition/pages/p1/visuals/v1/visual.json' }] }] }, { datasets: [] }, dynamic);
    const source = fs.readFileSync(path.join(dynamic, 'index.html'), 'utf8');
    assert.match(source, /no local data export supplied/i);
    assert.match(source, /barChart/);
    const target = makeSnapshot(dynamic, stat);
    const rendered = fs.readFileSync(target, 'utf8');
    assert.doesNotMatch(rendered, /<script type="application\/json" id="embedded-report-data">__EMBEDDED_REPORT_DATA__<\/script>/);
    assert.match(rendered, /"datasets":\[\]/);
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
