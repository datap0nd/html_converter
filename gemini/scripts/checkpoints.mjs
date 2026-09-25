import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function fileHash(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

// include(relativePath) limits the hash to the files that matter, so Desktop-local files
// (.pbi settings, caches, diagram layouts) or unselected pages do not discard progress.
export function inputFingerprint(inputDir, include = () => true) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      const rel = path.relative(inputDir, file).replaceAll('\\', '/');
      if (entry.isSymbolicLink() || /^data(?:\/|$)/i.test(rel)) continue;
      if (entry.isDirectory()) { if (include(rel, true)) visit(file); }
      else if (entry.isFile() && /\.(?:pbip|pbir|pbism|tmdl|m|pq|bim|json)$/i.test(rel) && include(rel, false)) files.push([rel, fileHash(file)]);
    }
  }
  visit(inputDir);
  files.sort((a, b) => a[0].localeCompare(b[0]));
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

export function captureArtifacts(root, paths) {
  const hashes = {};
  for (const relative of paths) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    hashes[relative] = fileHash(file);
  }
  return hashes;
}

export function artifactsMatch(root, hashes) {
  if (!hashes || !Object.keys(hashes).length) return false;
  return Object.entries(hashes).every(([relative, expected]) => {
    const full = path.resolve(root, relative);
    if (!full.startsWith(path.resolve(root) + path.sep)) return false;
    return fs.existsSync(full) && fs.statSync(full).isFile() && fileHash(full) === expected;
  });
}

export function saveCheckpoint(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const text = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + '\n';
  fs.writeFileSync(temp, text);
  // Antivirus, OneDrive, or an open editor can briefly lock the file on Windows.
  for (let attempt = 1; ; attempt++) {
    try { fs.renameSync(temp, file); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      if (attempt >= 20) { fs.writeFileSync(file, text); try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ } return; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt);
    }
  }
}
