import fs from 'node:fs';
import path from 'node:path';
import { walk, writeJson } from './core.mjs';

// Keep each read below typical CLI tool-output limits without dropping evidence.
export function prepareSourceContext(stage, { maxBytes = 48_000, maxLines = 800 } = {}) {
  const directory = path.join(stage, 'work', 'source-context');
  fs.mkdirSync(directory, { recursive: true });
  const index = { packets: [], largeFiles: [], sourceFileCount: 0 };
  let packet = '', sources = [];
  const flush = () => {
    if (!sources.length) return;
    const relative = `work/source-context/part-${index.packets.length + 1}.txt`;
    fs.writeFileSync(path.join(stage, relative), packet);
    index.packets.push({ path: relative, bytes: Buffer.byteLength(packet), sources });
    packet = ''; sources = [];
  };
  for (const file of walk(path.join(stage, 'input')).sort()) {
    const source = path.relative(stage, file).replaceAll('\\', '/');
    const content = fs.readFileSync(file, 'utf8');
    const entry = `\n--- SOURCE DATA: ${source} ---\n${content}\n--- END SOURCE DATA ---\n`;
    index.sourceFileCount++;
    if (Buffer.byteLength(entry) > maxBytes || entry.split('\n').length > maxLines) {
      index.largeFiles.push({ path: source, bytes: Buffer.byteLength(content), instruction: 'Read this original in bounded ranges as needed; it is not included in a packet.' });
      continue;
    }
    if (Buffer.byteLength(packet + entry) > maxBytes || (packet + entry).split('\n').length > maxLines) flush();
    packet += entry; sources.push(source);
  }
  flush();
  writeJson(path.join(stage, 'work', 'source-context.json'), index);
  return index;
}
