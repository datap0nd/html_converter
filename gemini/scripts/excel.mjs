// Reads .xlsx / .xlsm workbooks the way Power Query's Excel.Workbook does, with
// no npm package: the navigation items (sheets, tables, defined names), sheet
// data inside the saved <dimension> range (Power Query's rule; InferSheetDimensions
// reads every cell instead), optional header promotion, and dates from cell styles.
//
//   inspectWorkbook(file)                 -> { items: [{ name, kind, hidden, ref, rows, columns, header? }], date1904, warnings }
//   readExcel(file, { item, kind, name, index, useHeaders, inferSheetDimensions })
//                                         -> { item, kind, columns, rows: [{ column: value }], warnings }
//   excelErrorHint(error)                 -> plain advice for an ExcelError code
//
// Values: numbers as numbers, text as strings, booleans, dates as 'YYYY-MM-DD'
// ('YYYY-MM-DDTHH:MM:SS' with a time, 'HH:MM:SS' for a time alone), blanks and
// error cells (#N/A, #REF!, ...) as null.
import fs from 'node:fs';
import zlib from 'node:zlib';

export class ExcelError extends Error {
  constructor(message, code, file) {
    super(message);
    this.name = 'ExcelError';
    this.code = code;
    if (file) this.path = file;
  }
}

// An inflated XML part larger than this cannot be held as text safely.
const MAX_PART_BYTES = 768 * 1024 * 1024;
const CACHE_SIZE = 4;

// ---------- zip ----------

function readZip(buffer, file) {
  const bad = detail => new ExcelError(`${file} is not a readable .xlsx workbook (${detail}). Open it in Excel and save it again as .xlsx.`, 'HC_EXCEL_FORMAT', file);
  const min = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= min; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad('no zip directory; the file may be truncated or still being copied');
  let count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff || count === 0xffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buffer.readUInt32LE(locator) === 0x07064b50) {
      const zip64 = Number(buffer.readBigUInt64LE(locator + 8));
      if (zip64 + 56 <= buffer.length && buffer.readUInt32LE(zip64) === 0x06064b50) {
        count = Number(buffer.readBigUInt64LE(zip64 + 32));
        offset = Number(buffer.readBigUInt64LE(zip64 + 48));
      }
    }
  }
  const entries = new Map();
  let p = offset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw bad('damaged zip directory');
    const flags = buffer.readUInt16LE(p + 8), method = buffer.readUInt16LE(p + 10);
    let compressed = buffer.readUInt32LE(p + 20), size = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28), extraLength = buffer.readUInt16LE(p + 30), commentLength = buffer.readUInt16LE(p + 32);
    let local = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    const extraEnd = p + 46 + nameLength + extraLength;
    for (let e = p + 46 + nameLength; e + 4 <= extraEnd;) {
      const id = buffer.readUInt16LE(e), length = buffer.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(buffer.readBigUInt64LE(q)); q += 8; }
        if (compressed === 0xffffffff) { compressed = Number(buffer.readBigUInt64LE(q)); q += 8; }
        if (local === 0xffffffff) local = Number(buffer.readBigUInt64LE(q));
      }
      e += 4 + length;
    }
    // Part names are case-insensitive in Office files.
    entries.set(name.replaceAll('\\', '/').replace(/^\/+/, '').toLowerCase(), { name, flags, method, compressed, size, local });
    p = extraEnd + commentLength;
  }
  return entries;
}

function partBuffer(workbook, name, { prefixBytes = 0 } = {}) {
  const entry = workbook.entries.get(String(name).replace(/^\/+/, '').toLowerCase());
  if (!entry) return null;
  const { buffer, file } = workbook;
  const p = entry.local;
  if (p + 30 > buffer.length || buffer.readUInt32LE(p) !== 0x04034b50) throw new ExcelError(`${file} is damaged (part ${entry.name}). Open it in Excel and save it again.`, 'HC_EXCEL_FORMAT', file);
  if (entry.flags & 1) throw new ExcelError(`${file} is encrypted. Save a copy without a password and use that.`, 'HC_EXCEL_ENCRYPTED', file);
  const start = p + 30 + buffer.readUInt16LE(p + 26) + buffer.readUInt16LE(p + 28);
  const data = buffer.subarray(start, start + entry.compressed);
  if (entry.method === 0) return prefixBytes ? data.subarray(0, prefixBytes) : data;
  if (entry.method !== 8) throw new ExcelError(`${file} uses zip compression method ${entry.method}, which this reader does not support. Open it in Excel and save it again as .xlsx.`, 'HC_EXCEL_FORMAT', file);
  if (prefixBytes) {
    // The beginning of a large part only (sheet dimensions and header row), without inflating all of it.
    try { return zlib.inflateRawSync(data.subarray(0, Math.min(data.length, prefixBytes)), { finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
    catch { return Buffer.alloc(0); }
  }
  if (entry.size > MAX_PART_BYTES) throw new ExcelError(`${file} has a sheet with ${Math.round(entry.size / 1048576)} MB of cell data, more than this reader can hold. Reduce the workbook (or export the sheet to CSV) and point the PBIP at the smaller file.`, 'HC_EXCEL_TOO_LARGE', file);
  try { return zlib.inflateRawSync(data); }
  catch (error) { throw new ExcelError(`${file} is damaged (${entry.name}: ${error.message}). Open it in Excel and save it again.`, 'HC_EXCEL_FORMAT', file); }
}

function partText(workbook, name) {
  const buffer = partBuffer(workbook, name);
  return buffer ? buffer.toString('utf8').replace(/^﻿/, '') : null;
}

// ---------- XML helpers ----------

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(text) {
  if (typeof text === 'string' && !text.includes('&')) return text;
  return String(text ?? '').replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (all, dec, hex, name) => {
    if (name) return ENTITY[name];
    const code = dec ? Number(dec) : parseInt(hex, 16);
    try { return String.fromCodePoint(code); } catch { return all; }
  });
}

// Office escapes characters XML cannot hold as _xHHHH_ (and a literal "_x" as _x005F_x).
function decodeOfficeText(text) {
  if (!text.includes('&') && !text.includes('_x')) return text;
  return decodeXml(text).replace(/_x([0-9A-Fa-f]{4})_/g, (_all, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function attributes(tag) {
  const result = {};
  for (const match of String(tag).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) result[match[1]] = decodeXml(match[2] ?? match[3] ?? '');
  return result;
}

function attr(attrs, name) {
  if (attrs[name] !== undefined) return attrs[name];
  for (const [key, value] of Object.entries(attrs)) if (key.endsWith(`:${name}`)) return value;
  return undefined;
}

// Every <name ...>...</name> or <name .../> (any namespace prefix), as [attributeText, innerText].
const elementPatterns = new Map();
function elementPattern(name) {
  let patterns = elementPatterns.get(name);
  if (!patterns) {
    patterns = { open: new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*?)(\\/?)>`, 'g'), close: new RegExp(`<\\/(?:[\\w.-]+:)?${name}\\s*>`, 'g') };
    elementPatterns.set(name, patterns);
  }
  return { open: new RegExp(patterns.open), close: new RegExp(patterns.close) };
}

function* elements(text, name) {
  const { open: pattern, close } = elementPattern(name);
  let match;
  while ((match = pattern.exec(text))) {
    if (match[2] === '/') { yield [match[1], '']; continue; }
    close.lastIndex = pattern.lastIndex;
    const end = close.exec(text);
    if (!end) { yield [match[1], text.slice(pattern.lastIndex)]; return; }
    yield [match[1], text.slice(pattern.lastIndex, end.index)];
    pattern.lastIndex = close.lastIndex;
  }
}

const PLAIN_TEXT = /^\s*<(?:[\w.-]+:)?t(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?t>\s*$/;

function textOf(inner) {
  // The common case: one <t> element and nothing else.
  const plain1 = PLAIN_TEXT.exec(inner);
  if (plain1) return decodeOfficeText(plain1[1]);
  // Phonetic runs (<rPh>, used for Japanese readings) are not part of the value.
  const plain = inner.replace(/<(?:[\w.-]+:)?rPh\b[\s\S]*?<\/(?:[\w.-]+:)?rPh>/g, '');
  let text = '';
  for (const [, body] of elements(plain, 't')) text += body;
  return decodeOfficeText(text);
}

// Scans a large XML buffer element by element without turning it into one string.
function* bufferElements(buffer, name, from = 0, to = buffer.length) {
  const prefixMatch = new RegExp(`<([\\w.-]+:)?${name}[\\s>/]`).exec(buffer.toString('utf8', from, Math.min(to, from + 65536)));
  const prefix = prefixMatch?.[1] ?? '';
  const open = Buffer.from(`<${prefix}${name}`), close = Buffer.from(`</${prefix}${name}>`);
  let position = from;
  for (;;) {
    let start = buffer.indexOf(open, position);
    while (start >= 0 && start < to && !/[\s>/]/.test(String.fromCharCode(buffer[start + open.length]))) start = buffer.indexOf(open, start + 1);
    if (start < 0 || start >= to) return;
    const tagEnd = buffer.indexOf(0x3e, start);
    if (tagEnd < 0) return;
    if (buffer[tagEnd - 1] === 0x2f) {
      yield buffer.toString('utf8', start, tagEnd + 1);
      position = tagEnd + 1;
      continue;
    }
    const end = buffer.indexOf(close, tagEnd);
    const stop = end < 0 || end > to ? to : end + close.length;
    yield buffer.toString('utf8', start, stop);
    position = stop;
  }
}

// ---------- cell references ----------

export function columnIndex(letters) {
  let index = 0;
  for (const char of String(letters).toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

export function columnLetters(index) {
  let text = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) text = String.fromCharCode(65 + ((n - 1) % 26)) + text;
  return text;
}

// "B2:D10", "$A$1:$C$5", "A:C", "1:5", "A1" -> { top, left, bottom, right } (0-based, bottom/right may be Infinity).
export function parseRange(ref) {
  const parts = String(ref ?? '').replaceAll('$', '').trim().split(':');
  const cell = text => {
    const match = /^([A-Za-z]*)(\d*)$/.exec(text);
    if (!match || (!match[1] && !match[2])) return null;
    return { col: match[1] ? columnIndex(match[1]) : null, row: match[2] ? Number(match[2]) - 1 : null };
  };
  const a = cell(parts[0]), b = cell(parts[1] ?? parts[0]);
  if (!a || !b) return null;
  return {
    top: a.row ?? 0, left: a.col ?? 0,
    bottom: b.row ?? Infinity, right: b.col ?? Infinity
  };
}

function rangeText(range) {
  if (!range) return null;
  const first = `${columnLetters(range.left)}${range.top + 1}`;
  const last = `${Number.isFinite(range.right) ? columnLetters(range.right) : ''}${Number.isFinite(range.bottom) ? range.bottom + 1 : ''}`;
  return first === last ? first : `${first}:${last}`;
}

// ---------- values ----------

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

export function isDateFormat(id, code) {
  if (BUILTIN_DATE_FORMATS.has(Number(id))) return true;
  if (!code) return false;
  const section = String(code).split(';')[0]
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?:h+|m+|s+)\]/gi, 'h')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/General/gi, '');
  return /[dmyhs]/i.test(section) && !/^[#0.,%\s?Ee+-]*$/.test(section);
}

const DAY_MS = 86400000;

// Excel serial -> ISO text, as Power Query converts dates (OLE Automation dates, 1899-12-30 base).
export function excelDateText(serial, date1904 = false) {
  if (!Number.isFinite(serial) || serial < 0) return serial;
  const ms = Math.round((serial + (date1904 ? 1462 : 0)) * DAY_MS / 1000) * 1000;
  const date = new Date(Date.UTC(1899, 11, 30) + ms);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() > 9999) return serial;
  const iso = date.toISOString();
  if (!date1904 && serial < 1) return iso.slice(11, 19);
  return ms % DAY_MS === 0 ? iso.slice(0, 10) : iso.slice(0, 19);
}

// The three cell attributes that matter (r, s, t), scanned by hand: this runs once per cell.
function cellAttributes(text) {
  const attrs = {};
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && text.charCodeAt(i) <= 32) i++;
    const start = i;
    while (i < n && text[i] !== '=' && text.charCodeAt(i) > 32) i++;
    const nameLength = i - start;
    const name = text[start];
    while (i < n && text[i] !== '=') i++;
    i++;
    while (i < n && text.charCodeAt(i) <= 32) i++;
    const quote = text[i];
    if (quote !== '"' && quote !== "'") break;
    const end = text.indexOf(quote, i + 1);
    if (end < 0) break;
    if (nameLength === 1 && (name === 'r' || name === 's' || name === 't')) attrs[name] = text.slice(i + 1, end);
    i = end + 1;
  }
  return attrs;
}

// The cached value of a cell: <v>text</v> (any prefix). Values never hold a raw '<'.
const CELL_VALUE = /<(?:[\w.-]+:)?v(?:\s[^>]*)?>([^<]*)</;

function cellValue(attrs, inner, workbook) {
  const type = attrs.t ?? 'n';
  if (type === 'inlineStr') {
    const is = /<(?:[\w.-]+:)?is\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?is>/.exec(inner);
    return is ? textOf(is[1]) : null;
  }
  const v = CELL_VALUE.exec(inner);
  if (!v) return null;
  const raw = v[1];
  switch (type) {
    case 's': return workbook.strings[Number(raw)] ?? null;
    case 'str': return decodeOfficeText(raw);
    case 'b': return raw.trim() === '1' || raw.trim().toLowerCase() === 'true';
    case 'e': return null;
    case 'd': {
      const text = decodeXml(raw).trim();
      return /T00:00:00(?:\.0+)?Z?$/.test(text) ? text.slice(0, 10) : text.replace(/Z$/, '');
    }
    default: {
      const number = Number(raw);
      if (!Number.isFinite(number) || raw.trim() === '') return raw.trim() === '' ? null : decodeXml(raw);
      return workbook.dateStyles[Number(attrs.s ?? 0)] ? excelDateText(number, workbook.date1904) : number;
    }
  }
}

// ---------- workbook structure ----------

function resolveTarget(base, target) {
  if (!target) return null;
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment && segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

function relationships(workbook, part) {
  const folder = part.includes('/') ? part.slice(0, part.lastIndexOf('/')) : '';
  const file = part.slice(part.lastIndexOf('/') + 1);
  const text = partText(workbook, `${folder ? `${folder}/` : ''}_rels/${file}.rels`);
  const result = new Map();
  if (!text) return result;
  for (const [tag] of elements(text, 'Relationship')) {
    const attrs = attributes(tag);
    if (attrs.TargetMode === 'External') continue;
    result.set(attrs.Id, { type: String(attrs.Type ?? '').split('/').pop(), target: resolveTarget(part, attrs.Target) });
  }
  return result;
}

function loadStructure(workbook) {
  const rootRels = relationships(workbook, '');
  const officeDocument = [...rootRels.values()].find(rel => rel.type === 'officeDocument')?.target ?? 'xl/workbook.xml';
  const workbookXml = partText(workbook, officeDocument);
  if (!workbookXml) {
    if (workbook.entries.has('xl/workbook.bin')) throw new ExcelError(`${workbook.file} is an .xlsb (binary) workbook, which this reader cannot open. Open it in Excel, save a copy as .xlsx, and point the PBIP (or HC_SOURCE_MAP in gemini/.env) at the copy.`, 'HC_EXCEL_FORMAT', workbook.file);
    throw new ExcelError(`${workbook.file} has no workbook part; it is not an Excel workbook. Open it in Excel and save it as .xlsx.`, 'HC_EXCEL_FORMAT', workbook.file);
  }
  const rels = relationships(workbook, officeDocument);
  const properties = attributes(/<(?:[\w.-]+:)?workbookPr\b([^>]*)>/.exec(workbookXml)?.[1] ?? '');
  workbook.date1904 = properties.date1904 === '1' || properties.date1904 === 'true';
  workbook.sheets = [];
  for (const [tag] of elements(workbookXml, 'sheet')) {
    const attrs = attributes(tag);
    const rel = rels.get(attr(attrs, 'id'));
    // Chart sheets and dialog sheets hold no cells.
    if (!rel || rel.type !== 'worksheet') continue;
    workbook.sheets.push({ name: attrs.name, hidden: attrs.state === 'hidden' || attrs.state === 'veryHidden', part: rel.target });
  }
  workbook.definedNames = [];
  for (const [tag, body] of elements(workbookXml, 'definedName')) {
    const attrs = attributes(tag);
    if (!attrs.name || attrs.name.startsWith('_xlnm.') || attrs.hidden === '1') continue;
    workbook.definedNames.push({ name: attrs.name, localSheet: attrs.localSheetId !== undefined ? workbook.sheets[Number(attrs.localSheetId)]?.name ?? null : null, formula: decodeXml(body).trim() });
  }
  const sharedStrings = [...rels.values()].find(rel => rel.type === 'sharedStrings')?.target;
  workbook.strings = [];
  const stringsBuffer = sharedStrings ? partBuffer(workbook, sharedStrings) : null;
  if (stringsBuffer) for (const item of bufferElements(stringsBuffer, 'si')) workbook.strings.push(textOf(item));
  const styles = [...rels.values()].find(rel => rel.type === 'styles')?.target;
  const stylesXml = styles ? partText(workbook, styles) : null;
  workbook.dateStyles = [];
  if (stylesXml) {
    const formats = new Map();
    for (const [tag] of elements(stylesXml, 'numFmt')) {
      const attrs = attributes(tag);
      formats.set(Number(attrs.numFmtId), attrs.formatCode);
    }
    const cellXfs = /<(?:[\w.-]+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?cellXfs>/.exec(stylesXml)?.[1] ?? '';
    for (const [tag] of elements(cellXfs, 'xf')) {
      const id = Number(attributes(tag).numFmtId ?? 0);
      workbook.dateStyles.push(isDateFormat(id, formats.get(id)));
    }
  }
  workbook.tables = [];
  for (const sheet of workbook.sheets) {
    for (const rel of relationships(workbook, sheet.part).values()) {
      if (rel.type !== 'table') continue;
      const xml = partText(workbook, rel.target);
      if (!xml) continue;
      const tableTag = /<(?:[\w.-]+:)?table\b([^>]*)>/.exec(xml);
      if (!tableTag) continue;
      const attrs = attributes(tableTag[1]);
      const columns = [...elements(xml, 'tableColumn')].map(([tag]) => decodeOfficeText(attributes(tag).name ?? ''));
      workbook.tables.push({
        name: attrs.displayName ?? attrs.name, sheet: sheet.name, ref: attrs.ref,
        headerRows: attrs.headerRowCount === undefined ? 1 : Number(attrs.headerRowCount),
        totalsRows: attrs.totalsRowCount === undefined ? 0 : Number(attrs.totalsRowCount),
        columns
      });
    }
  }
}

// file: a path, or the bytes of a workbook (for example downloaded with fetch).
function openWorkbook(file) {
  if (Buffer.isBuffer(file) || file instanceof Uint8Array) {
    const bytes = Buffer.isBuffer(file) ? file : Buffer.from(file.buffer, file.byteOffset, file.byteLength);
    const known = bufferCache.get(file);
    if (known) return known;
    const workbook = parseWorkbook(bytes, '(workbook bytes)');
    bufferCache.set(file, workbook);
    return workbook;
  }
  let stat;
  try { stat = fs.statSync(file); } catch (error) { error.path ??= file; throw error; }
  const key = `${file}|${stat.size}|${stat.mtimeMs}`;
  const cached = cache.get(key);
  if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
  const workbook = parseWorkbook(fs.readFileSync(file), file);
  cache.set(key, workbook);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return workbook;
}

function parseWorkbook(buffer, file) {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0xd0cf11e0 && buffer.readUInt32BE(4) === 0xa1b11ae1) {
    throw new ExcelError(`${file} is not an .xlsx file: it is either an old .xls (Excel 97-2003) workbook, or a workbook protected with a password or an encrypting sensitivity label. This converter cannot open either. In Excel, save a copy as .xlsx without password or encryption (if your organization's policy allows), then add HC_SOURCE_MAP_1=${file} => <path of the copy> to gemini/.env.`, 'HC_EXCEL_ENCRYPTED', file);
  }
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new ExcelError(`${file} is not an .xlsx workbook (it does not start like one; it may be a CSV or HTML file renamed to .xlsx, or damaged). Open it in Excel and save it as .xlsx.`, 'HC_EXCEL_FORMAT', file);
  }
  const workbook = { file, buffer, entries: readZip(buffer, file), sheetData: new Map() };
  loadStructure(workbook);
  return workbook;
}

const cache = new Map();
const bufferCache = new WeakMap();

// ---------- sheet cells ----------

const CELL = /<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/g;

// Column index of a cell reference such as "AB12".
function cellColumn(ref) {
  let index = 0;
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i) & ~32;
    if (code < 65 || code > 90) break;
    index = index * 26 + (code - 64);
  }
  return index - 1;
}

// Sheet cells as a sparse grid: { dimension, used, rows: Map(row -> sparse array by column) }.
function sheetCells(workbook, sheet) {
  if (workbook.sheetData.has(sheet.part)) return workbook.sheetData.get(sheet.part);
  const buffer = partBuffer(workbook, sheet.part);
  if (!buffer) throw new ExcelError(`${workbook.file}: sheet "${sheet.name}" is missing its data part.`, 'HC_EXCEL_FORMAT', workbook.file);
  const head = buffer.toString('utf8', 0, Math.min(buffer.length, 65536));
  const dimension = parseRange(attributes(/<(?:[\w.-]+:)?dimension\b([^>]*)>/.exec(head)?.[1] ?? '').ref);
  const dataStart = Math.max(0, buffer.indexOf('sheetData'));
  const rows = new Map();
  const used = { top: Infinity, left: Infinity, bottom: -1, right: -1 };
  let errors = 0, rowNumber = -1;
  for (const rowText of bufferElements(buffer, 'row', dataStart)) {
    const rowAttrs = attributes(/^<[^>]*/.exec(rowText)[0]);
    rowNumber = rowAttrs.r ? Number(rowAttrs.r) - 1 : rowNumber + 1;
    let col = -1, count = 0;
    const cells = [];
    for (const match of rowText.matchAll(CELL)) {
      const attrs = cellAttributes(match[1]);
      col = attrs.r ? cellColumn(attrs.r) : col + 1;
      if (attrs.t === 'e') errors++;
      const value = match[2] === undefined ? null : cellValue(attrs, match[2], workbook);
      if (value === null || value === '') continue;
      cells[col] = value;
      count++;
      if (col < used.left) used.left = col;
      if (col > used.right) used.right = col;
    }
    if (count) {
      rows.set(rowNumber, cells);
      if (rowNumber < used.top) used.top = rowNumber;
      if (rowNumber > used.bottom) used.bottom = rowNumber;
    }
  }
  const data = { dimension, used: used.bottom < 0 ? null : used, rows, errors };
  workbook.sheetData.set(sheet.part, data);
  // Keep memory bounded: at most a few parsed sheets per workbook.
  while (workbook.sheetData.size > 6) workbook.sheetData.delete(workbook.sheetData.keys().next().value);
  return data;
}

function gridRows(cells, range) {
  const out = [];
  if (!range || range.bottom < range.top || range.right < range.left) return out;
  for (let r = range.top; r <= range.bottom; r++) {
    const source = cells.rows.get(r);
    const row = new Array(range.right - range.left + 1).fill(null);
    if (source) for (let c = range.left; c <= range.right && c < source.length; c++) if (source[c] !== undefined) row[c - range.left] = source[c];
    out.push(row);
  }
  return out;
}

function clampRange(range, cells) {
  const used = cells.used ?? { top: range.top, left: range.left, bottom: range.top - 1, right: range.left - 1 };
  return {
    top: range.top, left: range.left,
    bottom: Number.isFinite(range.bottom) ? range.bottom : used.bottom,
    right: Number.isFinite(range.right) ? range.right : used.right
  };
}

// The rectangle Power Query reads for a sheet: the saved <dimension>, or every used cell.
function sheetRange(cells, inferSheetDimensions) {
  if (!inferSheetDimensions && cells.dimension) return clampRange(cells.dimension, cells);
  return cells.used ? { ...cells.used } : null;
}

function outsideWarning(cells, range, sheet) {
  if (!cells.used || !range) return null;
  const outside = cells.used.top < range.top || cells.used.left < range.left || cells.used.bottom > range.bottom || cells.used.right > range.right;
  return outside ? `Sheet "${sheet}" has cells outside its saved dimensions ${rangeText(range)} (used ${rangeText(cells.used)}). Power BI reads only the saved dimensions unless the query sets InferSheetDimensions=true; this reader does the same.` : null;
}

// ---------- navigation ----------

function navigationItems(workbook) {
  const items = workbook.sheets.map(sheet => ({ name: sheet.name, kind: 'Sheet', hidden: sheet.hidden }));
  for (const table of workbook.tables) items.push({ name: table.name, kind: 'Table', hidden: false });
  for (const name of workbook.definedNames) items.push({ name: name.name, kind: 'DefinedName', hidden: false });
  return items;
}

function describeItems(workbook) {
  return navigationItems(workbook).map(item => `${item.name} (${item.kind})`).join(', ');
}

function findItem(workbook, { item, kind, name, index }) {
  const items = navigationItems(workbook);
  let found = null;
  if (Number.isInteger(index)) found = items[index] ?? null;
  else {
    const wanted = item ?? name;
    found = items.find(entry => entry.name === wanted && (!kind || entry.kind === kind))
      ?? items.find(entry => entry.name.toLowerCase() === String(wanted ?? '').toLowerCase() && (!kind || entry.kind === kind))
      ?? null;
  }
  if (!found) {
    const what = Number.isInteger(index) ? `item number ${index}` : `${kind ? `${kind.toLowerCase()} ` : ''}"${item ?? name}"`;
    throw new ExcelError(`${workbook.file} has no ${what}. It has: ${describeItems(workbook) || 'no sheets'}.`, 'HC_EXCEL_ITEM', workbook.file);
  }
  return found;
}

function definedNameRange(workbook, definition) {
  const match = /^(?:'((?:[^']|'')+)'|([^!'"]+))!(\$?[A-Za-z]*\$?\d*(?::\$?[A-Za-z]*\$?\d*)?)$/.exec(definition.formula);
  if (!match) return null;
  const sheetName = (match[1] ?? match[2]).replaceAll("''", "'");
  const sheet = workbook.sheets.find(entry => entry.name === sheetName);
  const range = parseRange(match[3]);
  return sheet && range ? { sheet, range } : null;
}

function uniqueHeaders(values) {
  const seen = new Map();
  return values.map((value, index) => {
    let name = value === null || value === undefined || value === '' ? `Column${index + 1}` : String(value);
    if (seen.has(name)) {
      let n = seen.get(name);
      while (seen.has(`${name}_${n}`)) n++;
      seen.set(name, n + 1);
      name = `${name}_${n}`;
    }
    seen.set(name, seen.get(name) ?? 1);
    return name;
  });
}

// One navigation item's data. options: { item, kind ('Sheet'|'Table'|'DefinedName'), name, index,
// useHeaders (Excel.Workbook's second argument / UseHeaders), inferSheetDimensions }.
export function readExcel(file, options = {}) {
  const workbook = openWorkbook(file);
  file = workbook.file;
  const found = findItem(workbook, options);
  const warnings = [];
  let columns, rows;
  if (found.kind === 'Table') {
    const table = workbook.tables.find(entry => entry.name === found.name);
    const sheet = workbook.sheets.find(entry => entry.name === table.sheet);
    const range = parseRange(table.ref);
    const cells = sheetCells(workbook, sheet);
    const body = { ...range, top: range.top + table.headerRows, bottom: range.bottom - table.totalsRows };
    columns = uniqueHeaders(table.columns.length ? table.columns : gridRows(cells, { ...range, bottom: range.top })[0] ?? []);
    rows = gridRows(cells, body);
  } else {
    let cells, range;
    if (found.kind === 'Sheet') {
      const sheet = workbook.sheets.find(entry => entry.name === found.name);
      cells = sheetCells(workbook, sheet);
      range = sheetRange(cells, options.inferSheetDimensions === true);
      const warning = outsideWarning(cells, range, sheet.name);
      if (warning) warnings.push(warning);
    } else {
      const target = definedNameRange(workbook, workbook.definedNames.find(entry => entry.name === found.name));
      if (!target) throw new ExcelError(`${file}: the defined name "${found.name}" does not refer to a single cell range (${workbook.definedNames.find(entry => entry.name === found.name)?.formula}).`, 'HC_EXCEL_ITEM', file);
      cells = sheetCells(workbook, target.sheet);
      range = clampRange(target.range, cells);
    }
    const grid = gridRows(cells, range);
    const width = grid[0]?.length ?? 0;
    if (options.useHeaders && grid.length) {
      columns = uniqueHeaders(grid.shift().map(value => value === null ? null : String(value)));
    } else columns = Array.from({ length: width }, (_, index) => `Column${index + 1}`);
    rows = grid;
    if (cells.errors) warnings.push(`${cells.errors} error cell(s) (#N/A, #REF!, ...) in the sheet behind "${found.name}" are read as null.`);
  }
  return {
    item: found.name, kind: found.kind, columns,
    rows: rows.map(values => Object.fromEntries(columns.map((column, index) => [column, values[index] ?? null]))),
    warnings
  };
}

// The workbook's navigation items with their size and first row, read cheaply
// (only the beginning of each sheet is decompressed). For preflight and the digest.
export function inspectWorkbook(file) {
  const workbook = openWorkbook(file);
  const items = [], warnings = [];
  for (const sheet of workbook.sheets) {
    const head = partBuffer(workbook, sheet.part, { prefixBytes: 256 * 1024 }) ?? Buffer.alloc(0);
    const text = head.toString('utf8');
    const dimension = parseRange(attributes(/<(?:[\w.-]+:)?dimension\b([^>]*)>/.exec(text)?.[1] ?? '').ref);
    let header = null;
    if (dimension) {
      for (const rowText of bufferElements(head, 'row', Math.max(0, head.indexOf('sheetData')))) {
        const rowAttrs = attributes(/^<[^>]*/.exec(rowText)[0]);
        if (!rowAttrs.r || Number(rowAttrs.r) - 1 !== dimension.top) continue;
        const values = new Map();
        let col = -1;
        for (const match of rowText.matchAll(/<(?:[\w.-]+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?c>)/g)) {
          const attrs = cellAttributes(match[1]);
          const ref = attrs.r ? /^([A-Za-z]+)(\d+)$/.exec(attrs.r) : null;
          col = ref ? columnIndex(ref[1]) : col + 1;
          if (match[2] !== undefined) values.set(col, cellValue(attrs, match[2], workbook));
        }
        header = [];
        for (let c = dimension.left; c <= Math.min(dimension.right, dimension.left + 49); c++) header.push(values.get(c) ?? null);
        break;
      }
    }
    items.push({
      name: sheet.name, kind: 'Sheet', hidden: sheet.hidden,
      ref: dimension ? rangeText(dimension) : null,
      rows: dimension && Number.isFinite(dimension.bottom) ? dimension.bottom - dimension.top + 1 : null,
      columns: dimension && Number.isFinite(dimension.right) ? dimension.right - dimension.left + 1 : null,
      ...(header ? { header } : {})
    });
    if (!dimension) warnings.push(`Sheet "${sheet.name}" has no saved dimensions; its size is only known after reading it.`);
    else if (dimension.top === dimension.bottom && dimension.left === dimension.right && workbook.entries.get(sheet.part.toLowerCase())?.size > 4096) warnings.push(`Sheet "${sheet.name}" says its data is only the cell ${rangeText(dimension)}, but it holds more. Power BI then reads only that cell unless the query sets InferSheetDimensions=true (files written by some tools have this problem; opening and saving them in Excel fixes it).`);
  }
  for (const table of workbook.tables) {
    const range = parseRange(table.ref);
    items.push({ name: table.name, kind: 'Table', hidden: false, sheet: table.sheet, ref: table.ref, rows: range ? range.bottom - range.top + 1 - table.headerRows - table.totalsRows : null, columns: table.columns.length, header: table.columns });
  }
  for (const name of workbook.definedNames) items.push({ name: name.name, kind: 'DefinedName', hidden: false, ref: name.formula, ...(name.localSheet ? { localSheet: name.localSheet } : {}) });
  return { items, date1904: workbook.date1904, warnings };
}

export function excelErrorHint(error) {
  switch (error?.code) {
    case 'HC_EXCEL_ENCRYPTED': return 'Save an unprotected .xlsx copy in Excel (if policy allows) and map the report to it with HC_SOURCE_MAP_1=<original path> => <copy path> in gemini/.env.';
    case 'HC_EXCEL_FORMAT': return 'Open the file in Excel and save it again as .xlsx (Excel Workbook). For .xls/.xlsb files save a copy as .xlsx and map the report to it with HC_SOURCE_MAP_1=<original path> => <copy path> in gemini/.env.';
    case 'HC_EXCEL_ITEM': return 'The workbook no longer has the sheet, table or named range the report reads (renamed or deleted?). Restore it, or use the workbook version the report was built on.';
    case 'HC_EXCEL_TOO_LARGE': return 'Reduce the workbook or export the sheet to CSV and point the PBIP at the smaller file.';
    default: return null;
  }
}
