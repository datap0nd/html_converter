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

export function inputFingerprint(inputDir) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const rel = path.relative(inputDir, file).replaceAll('\\', '/');
      if (entry.isSymbolicLink() || /^data(?:\/|$)/i.test(rel)) continue;
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && /\.(?:pbip|pbir|tmdl|m|pq|bim|json)$/i.test(rel)) files.push([rel, fileHash(file)]);
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
  fs.writeFileSync(temp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  fs.renameSync(temp, file);
}
