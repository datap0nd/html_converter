import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, scriptJson, findDirectCsvSources, loadData } from '../scripts/core.mjs';
import { createPreview } from '../scripts/preview.mjs';
import { makeSnapshot } from '../scripts/snapshot.mjs';
import { runGemini } from '../scripts/gemini.mjs';
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

test('literal File.Contents CSV source is discovered without executing M', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const csv = path.join(dir, 'sales.csv');
    const tmdl = path.join(dir, 'sales.tmdl');
    fs.writeFileSync(csv, 'item,total\nA,10\n');
    fs.writeFileSync(tmdl, `partition Sales = m\n source = Csv.Document(File.Contents("${csv}"))\n`);
    const found = findDirectCsvSources([tmdl]);
    assert.equal(found.length, 1);
    assert.equal(found[0].available, true);
    assert.equal(found[0].path, csv);
    const data = loadData({ dataFiles: [], directCsvSources: found });
    assert.deepEqual(data.datasets[0].rows, [{ item: 'A', total: '10' }]);
    assert.equal(data.datasets[0].source, 'sales.csv');
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('Windows Gemini launcher passes arguments without shell:true warning', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'gemini.cmd'), '@echo off\r\necho %*\r\n');
    const result = runGemini(['-p', 'Read GEMINI.md'], { cwd: dir, env: { PATH: dir + path.delimiter + process.env.PATH } });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Read GEMINI\.md/);
    assert.doesNotMatch(result.stderr, /Passing args.*shell/i);
  } finally {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('html-converter-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('PBIP-only preview is explicit and static snapshot embeds the local data contract', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-converter-test-'));
  try {
    const dynamic = path.join(dir, 'dynamic');
    const stat = path.join(dir, 'static');
    createPreview({ project: 'input/Demo.pbip', pages: [{ name: 'Overview', visuals: [{ id: 'v1', title: 'Sales', type: 'barChart', source: 'input/Demo.Report/definition/pages/p1/visuals/v1/visual.json' }] }] }, { datasets: [] }, dynamic);
    const source = fs.readFileSync(path.join(dynamic, 'index.html'), 'utf8');
    assert.match(source, /no readable CSV\/JSON data found/i);
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
