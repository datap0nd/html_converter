import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { visualTitle, classifyVisual, visualType, pageIsHidden, pageType } from './pbir.mjs';
import { tmdlMExpressions, mParameterLiteral } from './tmdl.mjs';

// import.meta.dirname needs Node 20.11+; fileURLToPath works on every Node 20.
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const inputDir = path.join(root, 'input');
export const workDir = path.join(root, 'work');
export const dynamicDir = path.join(root, 'output', 'dynamic');
export const staticDir = path.join(root, 'output', 'static');

export function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  // Sorted so page order and scans never depend on the file system's listing order.
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walk(full));
    else if (entry.isFile()) result.push(full);
    // Symlinks are intentionally skipped: nothing outside input should be read.
  }
  return result;
}

export function relative(file) {
  return path.relative(root, file).replaceAll('\\', '/');
}

export function readJson(file) {
  // Some Windows tools save UTF-8 with a byte-order mark, which JSON.parse rejects.
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return null; }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function html(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

export function scriptJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

export function parseCsv(content, { delimiter = ',' } = {}) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (c === '"') {
      if (quoted && content[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (c === delimiter && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && content[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { columns: [], rows: [] };
  const columns = rows.shift().map((c, i) => c.trim() || `column_${i + 1}`);
  return { columns, rows: rows.map(cells => Object.fromEntries(columns.map((name, i) => [name, cells[i] ?? '']))) };
}

// Windows code pages used by Csv.Document(..., [Encoding=...]) mapped to WHATWG
// TextDecoder labels (Node ships full ICU, so all of these decode).
const CODE_PAGES = {
  65001: 'utf-8', 1200: 'utf-16le', 1201: 'utf-16be',
  874: 'windows-874', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258',
  28591: 'iso-8859-1', 28592: 'iso-8859-2', 28593: 'iso-8859-3', 28594: 'iso-8859-4', 28595: 'iso-8859-5', 28596: 'iso-8859-6', 28597: 'iso-8859-7', 28598: 'iso-8859-8', 28603: 'iso-8859-13', 28605: 'iso-8859-15',
  866: 'ibm866', 20866: 'koi8-r', 21866: 'koi8-u', 10000: 'macintosh', 10007: 'x-mac-cyrillic',
  932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 54936: 'gb18030', 20932: 'euc-jp', 51932: 'euc-jp', 50220: 'iso-2022-jp',
  20127: 'us-ascii',
  // OEM code pages 437 (US) and 850 (Western Europe, "File origin: 850 (OEM)")
  // have no TextDecoder label. The closest supported label is windows-1252: it
  // agrees on ASCII but not on accented letters or box drawing (0x80-0xFF), so
  // readCsvFile decodes these two exactly with the built-in tables below instead.
  437: 'windows-1252', 850: 'windows-1252'
};

// Characters 0x80-0xFF of the OEM code pages (0x00-0x7F are ASCII).
const OEM_HIGH_HALF = {
  437: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ',
  850: 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ '
};

export function encodingForCodePage(codePage) {
  return CODE_PAGES[Number(codePage)] ?? 'utf-8';
}

// M's TextEncoding.* values as code pages.
const TEXT_ENCODINGS = { utf8: 65001, utf16: 1200, unicode: 1200, bigendianunicode: 1201, windows: 1252, ascii: 20127 };

function codePageOf(expression) {
  const text = String(expression ?? '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const named = /^TextEncoding\.([A-Za-z0-9]+)$/.exec(text);
  return named ? TEXT_ENCODINGS[named[1].toLowerCase()] ?? null : null;
}

function decodeBytes(bytes, encoding) {
  const numeric = typeof encoding === 'number' || /^\d+$/.test(String(encoding));
  const table = numeric ? OEM_HIGH_HALF[Number(encoding)] : null;
  if (table) {
    const parts = [];
    for (let start = 0; start < bytes.length; start += 65536) {
      let chunk = '';
      for (const byte of bytes.subarray(start, start + 65536)) chunk += byte < 128 ? String.fromCharCode(byte) : table[byte - 128];
      parts.push(chunk);
    }
    return parts.join('');
  }
  return new TextDecoder(numeric ? encodingForCodePage(encoding) : encoding).decode(bytes);
}

// Reads a delimited text file the way Csv.Document does: delimiter and code
// page from the M options (see csvOptions in the digest), BOM removed.
export function readCsvFile(file, { delimiter = ',', encoding = 65001 } = {}) {
  const text = decodeBytes(fs.readFileSync(file), encoding).replace(/^\uFEFF/, '');
  return parseCsv(text, { delimiter });
}

// ---------- Power Query (M) source scanning; nothing is executed ----------

// Decodes an M text literal body: "" and #(lf), #(cr), #(tab), #(#), #(0041).
export function mUnescape(body) {
  return String(body).replaceAll('""', '"').replace(/#\(([^)]*)\)/g, (all, code) => {
    const name = code.toLowerCase();
    if (name === 'lf') return '\n';
    if (name === 'cr') return '\r';
    if (name === 'tab') return '\t';
    if (name === 'cr,lf') return '\r\n';
    if (code === '#') return '#';
    if (/^[0-9a-f]{4}$/i.test(code)) return String.fromCharCode(parseInt(code, 16));
    if (/^[0-9a-f]{8}$/i.test(code)) return String.fromCodePoint(parseInt(code, 16));
    return all;
  });
}

// Removes // and /* */ comments while leaving text literals (such as URLs) intact.
export function stripMComments(text) {
  let result = '', index = 0, quoted = false;
  while (index < text.length) {
    const c = text[index], next = text[index + 1];
    if (quoted) { result += c; if (c === '"') { if (next === '"') { result += next; index += 2; continue; } quoted = false; } index++; continue; }
    if (c === '"') { quoted = true; result += c; index++; continue; }
    if (c === '/' && next === '/') { while (index < text.length && text[index] !== '\n') index++; continue; }
    if (c === '/' && next === '*') { const end = text.indexOf('*/', index + 2); index = end < 0 ? text.length : end + 2; result += ' '; continue; }
    result += c;
    index++;
  }
  return result;
}

// Top-level arguments of the call whose "(" is at openIndex.
export function callArguments(text, openIndex) {
  const args = [];
  let depth = 0, quoted = false, start = openIndex + 1;
  for (let index = openIndex; index < text.length; index++) {
    const c = text[index];
    if (quoted) { if (c === '"') { if (text[index + 1] === '"') index++; else quoted = false; } continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { const last = text.slice(start, index).trim(); if (last || args.length) args.push(last); return { args, end: index + 1 }; }
      continue;
    }
    if (c === ',' && depth === 1) { args.push(text.slice(start, index).trim()); start = index + 1; }
  }
  return null;
}

// Resolves "literal", Parameter, #"Parameter", and "a" & Parameter & "b" to text; null otherwise.
export function resolveMText(expression, parameters = new Map()) {
  const parts = [];
  let depth = 0, quoted = false, start = 0;
  const text = String(expression ?? '').trim();
  for (let index = 0; index <= text.length; index++) {
    const c = text[index];
    if (index < text.length) {
      if (quoted) { if (c === '"') { if (text[index + 1] === '"') index++; else quoted = false; } continue; }
      if (c === '"') { quoted = true; continue; }
      if (c === '(' || c === '[' || c === '{') { depth++; continue; }
      if (c === ')' || c === ']' || c === '}') { depth--; continue; }
      if (!(c === '&' && depth === 0)) continue;
    }
    parts.push(text.slice(start, index).trim());
    start = index + 1;
  }
  let result = '';
  for (const part of parts) {
    const literal = /^"((?:[^"]|"")*)"$/.exec(part);
    if (literal) { result += mUnescape(literal[1]); continue; }
    const name = /^#"((?:[^"]|"")*)"$/.exec(part)?.[1]?.replaceAll('""', '"') ?? (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(part) ? part : null);
    if (name === null || !parameters.has(name)) return null;
    result += parameters.get(name);
  }
  return parts.length ? result : null;
}

// ---------- M structure: tokens, let steps, and name resolution ----------

const M_KEYWORDS = new Set(['let', 'in', 'each', 'if', 'then', 'else', 'try', 'otherwise', 'catch', 'meta', 'type', 'and', 'or', 'not', 'as', 'is', 'error', 'section', 'shared']);
const ID_START = /[\p{L}_]/u;
const ID_PART = /[\p{L}\p{N}_.]/u;
const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

// Tokens with character offsets; brackets carry the index of their partner in `match`.
function mTokenize(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i], next = text[i + 1];
    if (/\s/.test(c) || c === '\uFEFF') { i++; continue; }
    if (c === '/' && next === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && next === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? n : end + 2; continue; }
    if (c === '"' || (c === '#' && next === '"')) {
      const open = c === '#' ? i + 1 : i;
      let j = open + 1, closed = false;
      while (j < n) {
        if (text[j] === '"') { if (text[j + 1] === '"') { j += 2; continue; } closed = true; j++; break; }
        j++;
      }
      const body = text.slice(open + 1, closed ? j - 1 : j);
      tokens.push(c === '#' ? { t: 'id', v: body.replaceAll('""', '"'), start: i, end: j, quoted: true } : { t: 'str', v: body, start: i, end: j });
      i = j;
      continue;
    }
    if (c === '#' && /[A-Za-z]/.test(next ?? '')) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
      tokens.push({ t: 'kw', v: text.slice(i, j), start: i, end: j });
      i = j;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(text[j]) && !(text[j] === '.' && text[j + 1] === '.')) j++;
      while (j > i + 1 && text[j - 1] === '.') j--;
      const v = text.slice(i, j);
      tokens.push({ t: M_KEYWORDS.has(v) ? 'kw' : 'id', v, start: i, end: j });
      i = j;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(next ?? ''))) {
      const number = /^(?:0[xX][0-9A-Fa-f]+|(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(text.slice(i, i + 80));
      const length = number ? number[0].length : 1;
      tokens.push({ t: 'num', v: text.slice(i, i + length), start: i, end: i + length });
      i += length;
      continue;
    }
    const three = text.slice(i, i + 3), two = text.slice(i, i + 2);
    const op = three === '...' ? three : ['=>', '<=', '>=', '<>', '..', '??'].includes(two) ? two : c;
    tokens.push({ t: 'p', v: op, start: i, end: i + op.length });
    i += op.length;
  }
  const stack = [];
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.t !== 'p') continue;
    if (OPENERS.has(token.v)) stack.push(k);
    else if (CLOSERS.has(token.v) && stack.length) { const open = stack.pop(); tokens[open].match = k; token.match = open; }
  }
  return tokens;
}

const isP = (token, value) => token?.t === 'p' && token.v === value;
const isKeyword = (token, value) => token?.t === 'kw' && token.v === value;

// Every let expression with its steps (name -> character range) and body range.
// A let's steps are visible from its "let" to the end of its body.
function mLetScopes(tokens, textLength) {
  const lets = [];
  // End (exclusive token index) of an expression starting at i: a comma or
  // closing bracket at depth 0, or (for step values) the let's own "in".
  function expressionEnd(i, stop, stopAtIn) {
    let depth = 0, nested = 0;
    for (; i < stop; i++) {
      const token = tokens[i];
      if (token.t === 'p') {
        if (OPENERS.has(token.v)) depth++;
        else if (CLOSERS.has(token.v)) { if (depth === 0) return i; depth--; }
        else if (token.v === ',' && depth === 0 && nested === 0) return i;
      } else if (token.t === 'kw' && depth === 0) {
        if (token.v === 'let') nested++;
        else if (token.v === 'in') { if (nested > 0) nested--; else if (stopAtIn) return i; }
      }
    }
    return stop;
  }
  function scan(i, stop) {
    while (i < stop) i = isKeyword(tokens[i], 'let') ? parseLet(i, stop) : i + 1;
  }
  function parseLet(i, stop) {
    const letToken = tokens[i];
    const bindings = new Map(), values = [];
    let j = i + 1, complete = false;
    while (j < stop) {
      const name = tokens[j];
      if (name?.t !== 'id' || !isP(tokens[j + 1], '=')) break;
      const first = j + 2, end = expressionEnd(first, stop, true);
      if (end > first && !bindings.has(name.v)) bindings.set(name.v, { start: tokens[first].start, end: tokens[end - 1].end });
      values.push([first, end]);
      j = end;
      if (isP(tokens[j], ',')) { j++; continue; }
      if (isKeyword(tokens[j], 'in')) { complete = true; j++; }
      break;
    }
    for (const [first, end] of values) scan(first, end);
    if (!complete) return Math.max(j, i + 1);
    const bodyEnd = expressionEnd(j, stop, false);
    const end = bodyEnd > j ? tokens[bodyEnd - 1].end : (tokens[j - 1]?.end ?? textLength);
    lets.push({ start: letToken.start, end, bindings, body: { start: j < bodyEnd ? tokens[j].start : end, end } });
    scan(j, bodyEnd);
    return Math.max(bodyEnd, j);
  }
  scan(0, tokens.length);
  return lets;
}

function analyzeM(text) {
  const tokens = mTokenize(text);
  return { text, tokens, lets: mLetScopes(tokens, text.length) };
}

// Token index range [a, b) of the tokens inside characters [start, end).
function tokenRange(tokens, start, end) {
  let lo = 0, hi = tokens.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (tokens[mid].start < start) lo = mid + 1; else hi = mid; }
  let a = lo;
  hi = tokens.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (tokens[mid].end <= end) lo = mid + 1; else hi = mid; }
  return [a, Math.max(a, lo)];
}

// Top-level items between the bracket at `open` and its partner: call
// arguments, list items, or record fields.
function bracketItems(q, open) {
  const tokens = q.tokens, close = tokens[open]?.match;
  if (close === undefined || close < open) return null;
  const items = [];
  let depth = 0, nested = 0, first = open + 1;
  for (let k = open + 1; k <= close; k++) {
    const token = tokens[k];
    if (k === close || (isP(token, ',') && depth === 0 && nested === 0)) {
      items.push(first < k ? { a: first, b: k, start: tokens[first].start, end: tokens[k - 1].end } : { a: first, b: k, start: token.start, end: token.start });
      first = k + 1;
      continue;
    }
    if (token.t === 'p' && OPENERS.has(token.v)) depth++;
    else if (token.t === 'p' && CLOSERS.has(token.v)) depth--;
    else if (depth === 0 && isKeyword(token, 'let')) nested++;
    else if (depth === 0 && isKeyword(token, 'in') && nested > 0) nested--;
  }
  return items.length === 1 && items[0].a === items[0].b ? [] : items;
}

// [Name = value, ...] written in `range` -> Map(name -> value range), or null.
function recordFields(q, range) {
  if (!range || !isP(q.tokens[range.a], '[') || q.tokens[range.a].match !== range.b - 1) return null;
  const fields = new Map();
  for (const item of bracketItems(q, range.a) ?? []) {
    const name = q.tokens[item.a];
    if (!name || (name.t !== 'id' && name.t !== 'kw') || !isP(q.tokens[item.a + 1], '=') || item.a + 2 >= item.b) continue;
    if (!fields.has(name.v)) fields.set(name.v, { a: item.a + 2, b: item.b, start: q.tokens[item.a + 2].start, end: q.tokens[item.b - 1].end });
  }
  return fields;
}

function localBinding(q, name, position) {
  let best = null;
  for (const scope of q.lets) if (scope.start <= position && position < scope.end && scope.bindings.has(name) && (!best || scope.start > best.start)) best = scope;
  return best ? best.bindings.get(name) : null;
}

// Index of the function name of the call directly enclosing token k, or -1.
function enclosingCall(tokens, k) {
  let depth = 0;
  for (let i = k - 1; i >= 0; i--) {
    const token = tokens[i];
    if (token.t !== 'p') continue;
    if (CLOSERS.has(token.v)) depth++;
    else if (OPENERS.has(token.v)) {
      if (depth > 0) { depth--; continue; }
      return token.v === '(' && tokens[i - 1]?.t === 'id' ? i - 1 : -1;
    }
  }
  return -1;
}

const CONNECTOR_NAMES = 'Sql\\.Databases?|MySQL\\.Database|Oracle\\.Database|Odbc\\.(?:DataSource|Query)|OleDb\\.(?:DataSource|Query)|Web\\.Contents|SharePoint\\.(?:Files|Contents|Tables)|AzureStorage\\.[A-Za-z]+|Folder\\.(?:Files|Contents)|AnalysisServices\\.Databases?|Snowflake\\.Databases|GoogleBigQuery\\.Database|Databricks\\.Catalogs|PowerBI\\.Dataflows|PowerPlatform\\.Dataflows|Lakehouse\\.Contents|Fabric\\.[A-Za-z]+|OData\\.Feed|SapHana\\.Database|SapBusinessWarehouse\\.Cubes|Teradata\\.Database|DB2\\.Database|AmazonRedshift\\.Database|Access\\.Database|CommonDataService\\.Database|AzureDataExplorer\\.Contents|Salesforce\\.(?:Data|Reports)|Sybase\\.Database|Informix\\.Database|Impala\\.Database|Spark\\.Tables|Hdfs\\.(?:Files|Contents)';
const CONNECTOR_CALL = new RegExp(`\\b(${CONNECTOR_NAMES})\\s*\\(`, 'g');
const CONNECTOR_NAME = new RegExp(`^(?:${CONNECTOR_NAMES}|PostgreSQL\\.Database)$`);

// Resolves names the way M does: let steps of the enclosing let expressions
// first, then other queries (shared expressions, table queries, parameters).
// Recursion is bounded and cycles resolve to null.
function createMResolver(queries, parameters) {
  const byName = new Map();
  for (const q of queries) if (q.name != null && !byName.has(q.name)) byName.set(q.name, q);
  const cache = new Map(), active = new Set();
  const MAX_DEPTH = 40;
  const memo = (kind, q, start, end, depth, compute) => {
    const key = `${kind}${q.index}:${start}:${end}`;
    if (cache.has(key)) return cache.get(key);
    if (active.has(key) || depth > MAX_DEPTH) return null;
    active.add(key);
    let result = null;
    try { result = compute(); } finally { active.delete(key); }
    cache.set(key, result);
    return result;
  };
  const unwrap = (q, start, end) => {
    let [a, b] = tokenRange(q.tokens, start, end);
    while (b - a >= 2 && isP(q.tokens[a], '(') && q.tokens[a].match === b - 1) { a++; b--; }
    return [a, b];
  };
  const letBody = (q, token) => q.lets.find(scope => scope.start === token.start)?.body ?? null;

  // What an expression evaluates to, as far as sources are concerned:
  // { type: 'pg', server, database, parameterised, query }, { type: 'pg-unresolved', arguments },
  // { type: 'text', value }, { type: 'call', name }, or null (unknown).
  function value(q, start, end, depth = 0) {
    return memo('v', q, start, end, depth, () => {
      const [a, b] = unwrap(q, start, end);
      if (a >= b) return null;
      const first = q.tokens[a];
      if (isKeyword(first, 'let')) { const body = letBody(q, first); return body ? value(q, body.start, body.end, depth + 1) : null; }
      if (b - a === 1 && first.t === 'str') return { type: 'text', value: mUnescape(first.v) };
      if (b - a === 1 && first.t === 'id') {
        const local = localBinding(q, first.v, first.start);
        if (local) return value(q, local.start, local.end, depth + 1);
        if (parameters.has(first.v)) return { type: 'text', value: parameters.get(first.v) };
        const other = byName.get(first.v);
        return other ? value(other, 0, other.text.length, depth + 1) : null;
      }
      if (first.t === 'id' && isP(q.tokens[a + 1], '(') && q.tokens[a + 1].match === b - 1) return call(q, a, depth);
      return null;
    });
  }

  function call(q, a, depth) {
    const name = q.tokens[a].v;
    // q and a let callers read the call's own arguments (Excel.Workbook's file, ...).
    if (name !== 'PostgreSQL.Database') return { type: 'call', name, q, a };
    const args = bracketItems(q, a + 1) ?? [];
    const server = args[0] ? text(q, args[0].start, args[0].end, depth + 1) : null;
    const database = args[1] ? text(q, args[1].start, args[1].end, depth + 1) : null;
    if (server === null || database === null) return { type: 'pg-unresolved', arguments: args.slice(0, 2).map(arg => q.text.slice(arg.start, arg.end)).join(', ') };
    // PostgreSQL.Database(server, db, [Query="select ..."]) is itself a native query.
    const options = args[2] ? recordFields(q, args[2]) : null;
    return { type: 'pg', server, database, parameterised: args.slice(0, 2).some(arg => q.tokens[arg.a]?.t === 'id'), query: options?.get('Query') ? { q, range: options.get('Query') } : null };
  }

  // Text of an expression built from literals, parameters, and text-valued steps/queries.
  function text(q, start, end, depth = 0) {
    return memo('t', q, start, end, depth, () => {
      const [a, b] = unwrap(q, start, end);
      if (a >= b) return null;
      if (isKeyword(q.tokens[a], 'let')) { const body = letBody(q, q.tokens[a]); return body ? text(q, body.start, body.end, depth + 1) : null; }
      const resolved = new Map();
      const lookup = name => {
        if (resolved.has(name)) return resolved.get(name);
        let result = null;
        const local = localBinding(q, name, start);
        if (local) result = text(q, local.start, local.end, depth + 1);
        else if (parameters.has(name)) result = parameters.get(name);
        else { const other = byName.get(name); if (other) result = text(other, 0, other.text.length, depth + 1); }
        resolved.set(name, result);
        return result;
      };
      return resolveMText(q.text.slice(q.tokens[a].start, q.tokens[b - 1].end), { has: name => lookup(name) !== null, get: lookup });
    });
  }

  return { value, text, byName };
}

function modelSourceFiles(files) {
  const candidates = files.filter(f => /\.(tmdl|m|pq|bim)$/i.test(f) && !/[\\/](?:TMDLScripts|DAXQueries|cultures|\.pbi)[\\/]/i.test(f));
  // A TMDL definition folder is authoritative; a leftover model.bim beside it (from an older copy) is not the model.
  return candidates.some(f => /\.tmdl$/i.test(f)) ? candidates.filter(f => !/\.bim$/i.test(f)) : candidates;
}

function bimExpressions(model) {
  const found = [];
  const text = value => Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : null;
  for (const table of model?.model?.tables ?? []) for (const partition of table.partitions ?? []) {
    const source = text(partition.source?.expression);
    if (source && partition.source?.type !== 'calculated') found.push({ kind: 'partition', name: table.name, text: source });
  }
  for (const expression of model?.model?.expressions ?? []) {
    const source = text(expression.expression);
    if (source) found.push({ kind: 'expression', name: expression.name, text: source });
  }
  return found;
}

// Each M expression of a model file, separately.
function mExpressions(file) {
  try {
    if (/\.bim$/i.test(file)) return bimExpressions(readJson(file));
    const text = fs.readFileSync(file, 'utf8');
    if (/\.tmdl$/i.test(file)) {
      const found = tmdlMExpressions(text);
      return found.length || !/\b(?:File\.Contents|Folder\.(?:Files|Contents)|Web\.Contents|PostgreSQL\.Database)\s*\(/.test(text) ? found : [{ kind: 'file', name: null, text }];
    }
    return [{ kind: 'file', name: null, text }];
  } catch { return []; }
}

// Literal M parameters (expression X = "value" meta [IsParameterQuery=true, ...]).
export function findMParameters(files) {
  const parameters = new Map();
  for (const file of modelSourceFiles(files)) {
    for (const expression of mExpressions(file)) {
      if (expression.kind !== 'expression') continue;
      const value = mParameterLiteral(expression.text);
      if (value !== null) parameters.set(expression.name, value);
    }
  }
  return parameters;
}

function parseLiteralList(value) {
  if (!value || value.toLowerCase() === 'null') return [];
  if (!value.startsWith('{') || !value.endsWith('}')) return null;
  const body = value.slice(1, -1).trim();
  if (!body) return [];
  const parts = [], current = [];
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '"' && quoted && body[i + 1] === '"') { current.push('""'); i++; }
    else if (char === '"') { quoted = !quoted; current.push(char); }
    else if (char === ',' && !quoted) { parts.push(current.join('')); current.length = 0; }
    else current.push(char);
  }
  if (quoted) return null;
  parts.push(current.join(''));
  return parts.map(part => {
    const item = part.trim();
    if (/^"(?:[^"]|"")*"$/.test(item)) return mUnescape(item.slice(1, -1));
    if (/^(true|false|null)$/i.test(item)) return ({ true: true, false: false, null: null })[item.toLowerCase()];
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(item)) return Number(item);
    return undefined;
  });
}

const UNCHECKED = Object.freeze({ available: null, bytes: null, error: null });

function statResult(stat, folder) {
  if (folder) return stat.isDirectory() ? { available: true, bytes: null, error: null } : { available: false, bytes: null, error: 'Not a folder' };
  return stat.isFile() ? { available: true, bytes: stat.size, error: null } : { available: false, bytes: null, error: 'Not a file' };
}

function statSource(sourcePath, folder = false) {
  try { return statResult(fs.statSync(sourcePath), folder); }
  catch (e) { return { available: false, bytes: null, error: e.code ?? e.message }; }
}

const FILE_READERS = new Set(['File.Contents', 'Folder.Files', 'Folder.Contents']);
// Calls that pass the file's bytes through unchanged, so the real reader is the next call out.
const BINARY_WRAPPERS = new Set(['Binary.Buffer', 'Binary.Decompress']);

// The reader of File.Contents at token k: Csv.Document(File.Contents(p), ...),
// also through Binary.Buffer, or through a step (Bin = File.Contents(p), T = Csv.Document(Bin)).
function fileReader(q, k) {
  const tokens = q.tokens;
  let node = k;
  for (;;) {
    const parent = enclosingCall(tokens, node);
    if (parent < 0) break;
    if (!BINARY_WRAPPERS.has(tokens[parent].v)) return parent;
    node = parent;
  }
  const start = tokens[node].start, end = tokens[tokens[node + 1].match]?.end;
  for (const scope of q.lets) for (const [name, range] of scope.bindings) {
    if (range.start !== start || range.end !== end) continue;
    for (let i = 2; i < tokens.length - 1; i++) {
      const token = tokens[i];
      if (token.t === 'id' && token.v === name && isP(tokens[i - 1], '(') && tokens[i - 2].t === 'id' && !BINARY_WRAPPERS.has(tokens[i - 2].v) && (isP(tokens[i + 1], ',') || isP(tokens[i + 1], ')'))) return i - 2;
    }
  }
  return -1;
}

// Csv.Document(source, [Delimiter=..., Encoding=...]) or the positional form
// Csv.Document(source, columns, delimiter, extraValues, encoding).
function csvOptions(q, readerIndex, resolver) {
  const args = bracketItems(q, readerIndex + 1) ?? [];
  const record = args[1] ? recordFields(q, args[1]) : null;
  const delimiterRange = record ? record.get('Delimiter') : args[2];
  const encodingRange = record ? record.get('Encoding') : args[4];
  let delimiter = ',', encoding = 65001;
  if (delimiterRange && delimiterRange.a < delimiterRange.b) {
    const value = resolver.text(q, delimiterRange.start, delimiterRange.end);
    if (value) delimiter = value;
  }
  if (encodingRange && encodingRange.a < encodingRange.b) encoding = codePageOf(q.text.slice(encodingRange.start, encodingRange.end)) ?? encoding;
  return { delimiter, encoding };
}

// Where the bytes of a binary reader (Excel.Workbook, Csv.Document, ...) come from:
// { kind: 'file', path } | { kind: 'remote', connector, url } | { kind: 'folder' } (a file
// of a Folder.Files listing, as in "Combine files") | { kind: 'unknown' }.
const REMOTE_CONNECTOR = /^(?:Web\.Contents|SharePoint\.(?:Files|Contents)|OneDrive\.\w+|AzureStorage\.\w+|AzureDataLakeStorage\.\w+|Hdfs\.(?:Files|Contents))$/;
const LISTING_CONNECTOR = /^(?:Folder\.(?:Files|Contents)|SharePoint\.(?:Files|Contents)|AzureStorage\.\w+|AzureDataLakeStorage\.\w+|Hdfs\.(?:Files|Contents))$/;

function binaryOrigin(q, range, resolver, depth = 0, seen = new Set()) {
  if (!range || range.a >= range.b) return { kind: 'unknown' };
  const key = `${q.index}:${range.start}:${range.end}`;
  if (depth > 10 || seen.has(key)) return { kind: 'unknown' };
  seen.add(key);
  const tokens = q.tokens;
  // A parameter query: "value" meta [IsParameterQuery=true, ...] -> the value before meta.
  let b = range.b;
  for (let k = range.a; k < b; k++) if (isKeyword(tokens[k], 'meta')) { b = k; break; }
  const end = b > range.a ? tokens[b - 1].end : range.end;
  const whole = { a: range.a, b, start: range.start, end };
  const found = resolver.value(q, whole.start, whole.end);
  if (found?.type === 'call' && found.q) {
    const args = bracketItems(found.q, found.a + 1) ?? [];
    const textOf = arg => arg && arg.a < arg.b ? resolver.text(found.q, arg.start, arg.end) : null;
    if (found.name === 'File.Contents') { const file = textOf(args[0]); return file === null ? { kind: 'unknown' } : { kind: 'file', path: file }; }
    if (BINARY_WRAPPERS.has(found.name)) return binaryOrigin(found.q, args[0], resolver, depth + 1, seen);
    if (found.name === 'Web.Contents') {
      const url = textOf(args[0]);
      const options = args[1] ? recordFields(found.q, args[1]) : null;
      const relativePath = options?.has('RelativePath') ? resolver.text(found.q, options.get('RelativePath').start, options.get('RelativePath').end) : null;
      return { kind: 'remote', connector: 'Web.Contents', url: url && relativePath ? `${url.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '')}` : url, ...(found.q.name != null ? { originQuery: found.q.name } : {}) };
    }
    if (REMOTE_CONNECTOR.test(found.name)) return { kind: 'remote', connector: found.name, url: textOf(args[0]), ...(found.q.name != null ? { originQuery: found.q.name } : {}) };
  }
  // A let expression (a whole query): its result.
  if (isKeyword(tokens[whole.a], 'let')) {
    const body = q.lets.find(scope => scope.start === tokens[whole.a].start)?.body;
    if (body) { const [a2, b2] = tokenRange(tokens, body.start, body.end); return binaryOrigin(q, { a: a2, b: b2, start: body.start, end: body.end }, resolver, depth + 1, seen); }
  }
  // Listing{[Name="file.xlsx", #"Folder Path"="..."]}[Content] or Listing{0}[Content].
  const first = tokens[whole.a];
  if (first?.t === 'id' && isP(tokens[whole.a + 1], '{') && tokens[whole.a + 1].match !== undefined) {
    const close = tokens[whole.a + 1].match;
    if (isP(tokens[close + 1], '[') && tokens[close + 2]?.v === 'Content') {
      const fields = isP(tokens[whole.a + 2], '[') && tokens[whole.a + 2].match !== undefined ? recordFields(q, { a: whole.a + 2, b: tokens[whole.a + 2].match + 1 }) : null;
      const fileName = fields?.has('Name') ? resolver.text(q, fields.get('Name').start, fields.get('Name').end) : null;
      const folderPath = fields?.has('Folder Path') ? resolver.text(q, fields.get('Folder Path').start, fields.get('Folder Path').end) : null;
      let listing = resolver.value(q, first.start, first.end);
      // Through Table.SelectRows / Table.Sort / ... steps to the listing itself.
      for (let guard = 0; listing?.type === 'call' && listing.q && /^Table\./.test(listing.name) && guard < 20; guard++) {
        const inner = (bracketItems(listing.q, listing.a + 1) ?? [])[0];
        listing = inner ? resolver.value(listing.q, inner.start, inner.end) : null;
      }
      if (listing?.type === 'call' && listing.q && LISTING_CONNECTOR.test(listing.name)) {
        const root = (() => { const arg = (bracketItems(listing.q, listing.a + 1) ?? [])[0]; return arg && arg.a < arg.b ? resolver.text(listing.q, arg.start, arg.end) : null; })();
        const joined = fileName ? `${folderPath ?? (root ? `${root.replace(/[\\/]+$/, '')}${/^[a-z]+:\/\//i.test(root) ? '/' : '\\'}` : '')}${fileName}` : null;
        if (/^Folder\./.test(listing.name)) return joined ? { kind: 'file', path: joined, listing: root } : { kind: 'folder', path: root };
        return { kind: 'remote', connector: listing.name, url: joined ?? root, ...(joined ? {} : { fileUnknown: true }), ...(listing.q.name != null ? { originQuery: listing.q.name } : {}) };
      }
    }
  }
  // A single name: a step, another query, or a parameter.
  if (whole.b - whole.a === 1 && first?.t === 'id') {
    const local = localBinding(q, first.v, first.start);
    if (local) { const [a2, b2] = tokenRange(tokens, local.start, local.end); return binaryOrigin(q, { a: a2, b: b2, start: local.start, end: local.end }, resolver, depth + 1, seen); }
    const other = resolver.byName.get(first.v);
    if (other) return binaryOrigin(other, { a: 0, b: other.tokens.length, start: 0, end: other.text.length }, resolver, depth + 1, seen);
  }
  // Anything else ([Content] of combined files, a function parameter): judged by its text.
  const text = q.text.slice(whole.start, whole.end);
  const remote = /\b(Web\.Contents|SharePoint\.(?:Files|Contents)|OneDrive\.\w+|AzureStorage\.\w+|AzureDataLakeStorage\.\w+)\s*\(/.exec(text);
  if (remote) return { kind: 'remote', connector: remote[1], url: null, ...(q.name != null ? { originQuery: q.name } : {}) };
  return /\bFolder\.(?:Files|Contents)\s*\(/.test(text) ? { kind: 'folder' } : { kind: 'unknown' };
}

// Excel.Workbook(workbook, useHeaders, delayTypes) or Excel.Workbook(workbook, [UseHeaders=..., InferSheetDimensions=...]).
function excelOptions(q, args) {
  const second = args[1];
  const literal = range => range && range.a < range.b ? q.text.slice(range.start, range.end).trim().toLowerCase() : '';
  if (second && isP(q.tokens[second.a], '[')) {
    const fields = recordFields(q, second);
    return { useHeaders: literal(fields?.get('UseHeaders')) === 'true', inferSheetDimensions: literal(fields?.get('InferSheetDimensions')) === 'true' };
  }
  return { useHeaders: literal(second) === 'true', inferSheetDimensions: false };
}

// Records on a file source which sheets/tables/names an Excel.Workbook read navigates to.
// Each item keeps the options of the call that reads it (useHeaders, inferSheetDimensions).
function attachExcelItems(record, read) {
  record.excel ??= { items: [] };
  const options = { useHeaders: Boolean(read.useHeaders), ...(read.inferSheetDimensions ? { inferSheetDimensions: true } : {}) };
  const same = (a, b) => a.item === b.item && a.kind === b.kind && a.index === b.index && a.unknown === b.unknown && a.useHeaders === b.useHeaders && !a.inferSheetDimensions === !b.inferSheetDimensions;
  for (const item of read.items?.length ? read.items : [{ unknown: true }]) {
    const entry = { ...item, ...options };
    if (!record.excel.items.some(existing => same(existing, entry))) record.excel.items.push({ ...entry, ...(read.query != null ? { query: read.query } : {}) });
  }
}

// Readers whose first argument is the bytes of a file.
const BINARY_READERS = new Set(['Excel.Workbook', 'Csv.Document', 'Json.Document', 'Xml.Tables', 'Xml.Document', 'Lines.FromBinary', 'Parquet.Document', 'Pdf.Tables']);

export function sourceKey(sourcePath, kind = 'file') {
  return `${kind === 'folder' ? 'folder' : 'file'}\0${process.platform === 'win32' || path.win32.isAbsolute(String(sourcePath)) ? String(sourcePath).toLowerCase() : sourcePath}`;
}

function hostOf(url) {
  try { return new URL(url).host || null; } catch { return null; }
}

function collectMQueries(files) {
  const queries = [];
  for (const file of modelSourceFiles(files)) {
    for (const expression of mExpressions(file)) {
      const text = stripMComments(expression.text);
      queries.push({ index: queries.length, file: relative(file), kind: expression.kind, name: expression.name, rawText: expression.text, ...analyzeM(text) });
    }
  }
  return queries;
}

// One pass over every M expression in the model: PostgreSQL connections (with
// navigation and native SQL, also through let steps and shared queries), file
// and folder reads, web requests, other connectors, and anything whose target
// depends on something other than literal text or literal parameters.
export function scanModelSources(files, { checkFiles = true } = {}) {
  const queries = collectMQueries(files);
  const parameters = new Map();
  for (const q of queries) {
    if (q.kind !== 'expression') continue;
    const value = mParameterLiteral(q.rawText);
    if (value !== null) parameters.set(q.name, value);
  }
  const resolver = createMResolver(queries, parameters);
  const postgres = new Map(), fileSources = new Map(), webSources = [], connectors = [], unresolved = [];
  const connectionFor = found => {
    const key = `${found.server}\0${found.database}`;
    let existing = postgres.get(key);
    if (!existing) { existing = { server: found.server, database: found.database, tables: [], nativeQueries: [], hasUnresolvedNativeQuery: false, unresolvedNativeQueries: 0, referencedBy: [], queries: [] }; postgres.set(key, existing); }
    if (found.parameterised) existing.parameterised = true;
    return existing;
  };
  const use = (connection, q) => {
    if (!connection.referencedBy.includes(q.file)) connection.referencedBy.push(q.file);
    if (q.name != null && !connection.queries.includes(q.name)) connection.queries.push(q.name);
  };
  // Never silently omit a native query whose target, SQL, or parameters cannot be parsed.
  const unparsedNative = (connection, q) => { connection.hasUnresolvedNativeQuery = true; connection.unresolvedNativeQueries++; use(connection, q); };
  const addNative = (connection, q, sql, values) => {
    use(connection, q);
    if (!connection.nativeQueries.some(x => x.sql === sql && JSON.stringify(x.parameters) === JSON.stringify(values))) connection.nativeQueries.push({ sql, parameters: values, referencedBy: q.file, ...(q.name != null ? { query: q.name } : {}) });
  };
  const isConnection = found => found?.type === 'pg' && !found.query;
  // Every binary reader call (Excel.Workbook, Csv.Document, ...) and where its bytes come from.
  const binaryReads = new Map();
  for (const q of queries) {
    for (let k = 0; k < q.tokens.length - 1; k++) {
      const token = q.tokens[k];
      if (token.t !== 'id' || !BINARY_READERS.has(token.v) || !isP(q.tokens[k + 1], '(') || q.tokens[k + 1].match === undefined) continue;
      const args = bracketItems(q, k + 1) ?? [];
      const origin = binaryOrigin(q, args[0], resolver);
      binaryReads.set(`${q.index}:${token.start}`, {
        reader: token.v, query: q.name ?? null, referencedBy: q.file, origin,
        ...(token.v === 'Excel.Workbook' ? { ...excelOptions(q, args), items: [] } : {})
      });
    }
  }
  const excelReadFor = found => found?.type === 'call' && found.name === 'Excel.Workbook' && found.q ? binaryReads.get(`${found.q.index}:${found.q.tokens[found.a].start}`) ?? null : null;

  for (const q of queries) {
    const where = `${q.file}${q.name ? ` (${q.name})` : ''}`;
    const tokens = q.tokens;
    const source = range => range ? q.text.slice(range.start, range.end) : '';
    for (const match of q.text.matchAll(CONNECTOR_CALL)) connectors.push({ connector: match[1], referencedBy: q.file, ...(q.name ? { query: q.name } : {}) });
    const calls = [];
    for (let k = 0; k < tokens.length - 1; k++) if (tokens[k].t === 'id' && isP(tokens[k + 1], '(') && tokens[k + 1].match !== undefined) calls.push(k);
    const reachable = new Map();
    const reach = found => { const connection = connectionFor(found); use(connection, q); reachable.set(`${found.server}\0${found.database}`, connection); return connection; };

    // 1. PostgreSQL.Database calls written in this query.
    for (const k of calls) {
      if (tokens[k].v !== 'PostgreSQL.Database') continue;
      const found = resolver.value(q, tokens[k].start, tokens[tokens[k + 1].match].end);
      if (found?.type !== 'pg') { unresolved.push({ connector: 'PostgreSQL.Database', arguments: found?.arguments ?? source({ start: tokens[k + 1].end, end: tokens[tokens[k + 1].match].start }), referencedBy: where }); continue; }
      if (!found.query) { reach(found); continue; }
      const connection = connectionFor(found);
      use(connection, q);
      const sql = resolver.text(found.query.q, found.query.range.start, found.query.range.end);
      if (sql === null) unparsedNative(connection, q); else addNative(connection, q, sql, []);
    }
    // 2. Steps that evaluate to a connection: Db = PostgreSQL.Database(...), Source = PG (a shared query).
    for (const scope of q.lets) for (const range of scope.bindings.values()) {
      const found = resolver.value(q, range.start, range.end);
      if (isConnection(found)) reach(found);
    }
    // 3. Navigation: X{[Schema="s",Item="t"]}[Data] where X resolves to a connection;
    //    Excel: Wb{[Item="Sheet1",Kind="Sheet"]}[Data], Wb{[Name="Sales"]}[Data], Wb{0}[Data].
    const navigationTarget = k => {
      const before = tokens[k - 1];
      if (before?.t === 'id') return { start: before.start, end: before.end };
      if (isP(before, ')') && before.match !== undefined) return { start: tokens[before.match - 1]?.t === 'id' ? tokens[before.match - 1].start : tokens[before.match].start, end: before.end };
      return null;
    };
    for (let k = 1; k < tokens.length - 2; k++) {
      if (!isP(tokens[k], '{') || tokens[k].match === undefined) continue;
      const positional = tokens[k + 1].t === 'num' && tokens[k].match === k + 2;
      const record = isP(tokens[k + 1], '[') && tokens[k + 1].match !== undefined && tokens[k + 1].match + 1 === tokens[k].match;
      if (!positional && !record) continue;
      const fields = record ? recordFields(q, { a: k + 1, b: tokens[k + 1].match + 1 }) : null;
      if (fields?.has('Schema')) continue;
      const target = navigationTarget(k);
      const workbook = target ? excelReadFor(resolver.value(q, target.start, target.end)) : null;
      if (!workbook) continue;
      const item = positional ? { index: Number(tokens[k + 1].v) } : (() => {
        const read = field => fields?.has(field) ? resolver.text(q, fields.get(field).start, fields.get(field).end) : null;
        const name = read('Item') ?? read('Name');
        return name === null ? null : { item: name, ...(read('Kind') ? { kind: read('Kind') } : {}) };
      })();
      if (item && !workbook.items.some(existing => JSON.stringify(existing) === JSON.stringify(item))) workbook.items.push(item);
    }
    for (let k = 1; k < tokens.length - 1; k++) {
      const brace = tokens[k], open = tokens[k + 1];
      if (!isP(brace, '{') || !isP(open, '[') || open.match === undefined || open.match + 1 !== brace.match) continue;
      const fields = recordFields(q, { a: k + 1, b: open.match + 1 });
      if (!fields?.has('Schema') || !fields.has('Item')) continue;
      const schema = resolver.text(q, fields.get('Schema').start, fields.get('Schema').end);
      const item = resolver.text(q, fields.get('Item').start, fields.get('Item').end);
      if (schema === null || item === null) continue;
      const before = tokens[k - 1];
      let target = null;
      if (before.t === 'id') target = { start: before.start, end: before.end };
      else if (isP(before, ')') && before.match !== undefined) target = { start: tokens[before.match - 1]?.t === 'id' ? tokens[before.match - 1].start : tokens[before.match].start, end: before.end };
      const found = target ? resolver.value(q, target.start, target.end) : null;
      let connection = null;
      if (isConnection(found)) connection = connectionFor(found);
      else if ((!found || found.type === 'call') && reachable.size === 1) connection = [...reachable.values()][0];
      if (!connection) continue;
      use(connection, q);
      if (!connection.tables.some(x => x.schema === schema && x.item === item)) connection.tables.push({ schema, item });
    }
    // 4. Native SQL: Value.NativeQuery(target, sql, params, options).
    for (const k of calls) {
      if (tokens[k].v !== 'Value.NativeQuery') continue;
      const args = bracketItems(q, k + 1) ?? [];
      const found = args[0] ? resolver.value(q, args[0].start, args[0].end) : null;
      if (found?.type === 'pg-unresolved') continue; // reported with its PostgreSQL.Database call
      if (isConnection(found)) {
        const connection = connectionFor(found);
        const sql = args[1] && args[1].a < args[1].b ? resolver.text(q, args[1].start, args[1].end) : null;
        const values = parseLiteralList(args[2] && args[2].a < args[2].b ? source(args[2]) : 'null');
        if (sql === null || !values || values.some(value => value === undefined)) unparsedNative(connection, q);
        else addNative(connection, q, sql, values);
        continue;
      }
      if (found?.type === 'call' && CONNECTOR_NAME.test(found.name)) continue; // another connector's SQL
      if (reachable.size) for (const connection of reachable.values()) unparsedNative(connection, q);
      else unresolved.push({ connector: 'Value.NativeQuery', arguments: source(args[0]).slice(0, 300), referencedBy: where });
    }
    // 5. File.Contents / Folder.Files / Folder.Contents paths.
    for (const k of calls) {
      const name = tokens[k].v;
      if (!FILE_READERS.has(name)) continue;
      const args = bracketItems(q, k + 1) ?? [];
      const sourcePath = args[0] && args[0].a < args[0].b ? resolver.text(q, args[0].start, args[0].end) : null;
      if (sourcePath === null) { unresolved.push({ connector: name, arguments: source(args[0]), referencedBy: where }); continue; }
      const folder = name !== 'File.Contents';
      const key = sourceKey(sourcePath, folder ? 'folder' : 'file');
      if (fileSources.has(key)) {
        const existing = fileSources.get(key);
        if (existing.referencedBy !== q.file) existing.alsoReferencedBy = [...new Set([...(existing.alsoReferencedBy ?? []), q.file])];
        continue;
      }
      const readerIndex = folder ? -1 : fileReader(q, k);
      const reader = folder ? name : readerIndex >= 0 ? tokens[readerIndex].v : null;
      const record = {
        path: sourcePath, referencedBy: q.file, ...(q.name != null ? { query: q.name } : {}),
        kind: folder ? 'folder' : 'file', reader,
        absolute: path.isAbsolute(sourcePath) || path.win32.isAbsolute(sourcePath),
        ...(checkFiles ? statSource(sourcePath, folder) : UNCHECKED)
      };
      if (reader === 'Csv.Document') record.csvOptions = csvOptions(q, readerIndex, resolver);
      fileSources.set(key, record);
    }
    // 6. Web.Contents targets (recorded only; nothing is requested).
    for (const k of calls) {
      if (tokens[k].v !== 'Web.Contents') continue;
      const args = bracketItems(q, k + 1) ?? [];
      const url = args[0] && args[0].a < args[0].b ? resolver.text(q, args[0].start, args[0].end) : null;
      const options = args[1] ? recordFields(q, args[1]) : null;
      const relativePath = options?.has('RelativePath') ? resolver.text(q, options.get('RelativePath').start, options.get('RelativePath').end) : null;
      const record = { url, ...(relativePath !== null ? { relativePath } : {}), host: hostOf(url), ...(url === null ? { expression: source(args[0]).slice(0, 300) } : {}), referencedBy: q.file, ...(q.name != null ? { query: q.name } : {}) };
      if (!webSources.some(x => JSON.stringify(x) === JSON.stringify(record))) webSources.push(record);
    }
  }
  // Excel workbooks read from files: which items the report navigates to, and the reader options.
  const excelWorkbooks = [], remoteReads = [];
  for (const read of binaryReads.values()) {
    if (read.origin.kind === 'remote') remoteReads.push({ reader: read.reader, connector: read.origin.connector, url: read.origin.url ?? null, ...(read.origin.fileUnknown ? { fileUnknown: true } : {}), referencedBy: read.referencedBy, query: read.query, ...(read.origin.originQuery ? { originQuery: read.origin.originQuery } : {}) });
    if (read.reader !== 'Excel.Workbook') continue;
    excelWorkbooks.push({ query: read.query, referencedBy: read.referencedBy, origin: read.origin, useHeaders: read.useHeaders, inferSheetDimensions: read.inferSheetDimensions, items: read.items });
    if (read.origin.kind !== 'file') continue;
    const key = sourceKey(read.origin.path);
    let record = fileSources.get(key);
    if (!record) {
      // The path comes through a Folder.Files listing, not a File.Contents call.
      record = { path: read.origin.path, referencedBy: read.referencedBy, ...(read.query != null ? { query: read.query } : {}), kind: 'file', reader: 'Excel.Workbook', absolute: path.isAbsolute(read.origin.path) || path.win32.isAbsolute(read.origin.path), ...(checkFiles ? statSource(read.origin.path) : UNCHECKED) };
      fileSources.set(key, record);
    }
    if (!record.reader || BINARY_WRAPPERS.has(record.reader)) record.reader = 'Excel.Workbook';
    if (record.referencedBy !== read.referencedBy) record.alsoReferencedBy = [...new Set([...(record.alsoReferencedBy ?? []), read.referencedBy])];
    attachExcelItems(record, read);
  }
  return { parameters: Object.fromEntries(parameters), postgresSources: [...postgres.values()], fileSources: [...fileSources.values()], webSources, excelWorkbooks, remoteReads, connectors, unresolved };
}

export function findPostgresSources(files) {
  return scanModelSources(files).postgresSources;
}

function directCsv(fileSources) {
  return fileSources
    .filter(source => source.kind !== 'folder' && source.absolute && /\.csv$/i.test(source.path))
    .map(({ path: sourcePath, referencedBy, available, bytes, error }) => ({ path: sourcePath, referencedBy, available, bytes, error, kind: 'raw-file-source' }));
}

// Legacy snapshot flow: absolute .csv files read with File.Contents.
export function findDirectCsvSources(files) {
  return directCsv(scanModelSources(files).fileSources);
}

export function findUnsupportedConnectors(files) {
  return scanModelSources(files).connectors;
}

export function findReportModelReferences(pbirFiles) {
  return pbirFiles.map(file => {
    const reference = readJson(file)?.datasetReference;
    let kind = 'unknown';
    if (reference?.byConnection) kind = 'remote-connection';
    else if (typeof reference?.byPath?.path === 'string') {
      const target = path.resolve(path.dirname(file), reference.byPath.path);
      const insideInput = target.toLowerCase().startsWith((path.resolve(inputDir) + path.sep).toLowerCase());
      kind = insideInput && fs.existsSync(target) && fs.statSync(target).isDirectory() ? 'local-path' : 'missing-local-path';
    }
    return {
      report: relative(file),
      kind
    };
  });
}

// ---------- Folder.Files for generated backends ----------

// The files Folder.Files lists (recursive) or Folder.Contents lists (this folder only), with
// Power Query's column names plus the full `path`: [{ Name, Extension, "Date modified",
// "Date created", "Folder Path", path, size }], sorted by folder then name. Hidden
// Office lock files (~$*.xlsx) are left out like Power BI users filter them.
export function listFolderFiles(folder, { recursive = true, includeLockFiles = false } = {}) {
  const out = [];
  const visit = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (dir === folder) throw error; return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (recursive) visit(full); continue; }
      if (!entry.isFile() || (!includeLockFiles && entry.name.startsWith('~$'))) continue;
      let stat = null;
      try { stat = fs.statSync(full); } catch { /* vanished */ }
      out.push({ Name: entry.name, Extension: path.extname(entry.name), 'Date modified': stat?.mtime.toISOString() ?? null, 'Date created': stat?.birthtime.toISOString() ?? null, 'Folder Path': dir.endsWith(path.sep) ? dir : dir + path.sep, path: full, size: stat?.size ?? null });
    }
  };
  visit(folder);
  return out;
}

// ---------- source map (HC_SOURCE_MAP_* in .env) ----------
//
// HC_SOURCE_MAP_1=<path or URL as written in the PBIP> => <path on this PC>
// maps a file, or everything below a folder/URL prefix, to a local copy: a
// SharePoint/OneDrive library synced by OneDrive, a downloaded file, or an .xlsx
// saved from an .xls or password-protected workbook.

export function parseSourceMap(env = {}) {
  const entries = [], problems = [];
  const keys = Object.keys(env).filter(key => /^HC_SOURCE_MAP(?:_[A-Z0-9_]+)?$/.test(key)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const unquote = text => text.trim().replace(/^(["'])(.*)\1$/, '$2').trim();
  for (const key of keys) {
    const value = String(env[key] ?? '').trim();
    if (!value) continue;
    const at = value.indexOf('=>');
    const from = at < 0 ? '' : unquote(value.slice(0, at)), to = at < 0 ? '' : unquote(value.slice(at + 2));
    if (!from || !to) { problems.push(`${key} in gemini/.env must look like: ${key}=<path or URL used in the PBIP> => <path on this PC>`); continue; }
    entries.push({ key, from, to });
  }
  return { entries, problems };
}

function decodedPath(text) {
  let value = String(text ?? '');
  try { value = decodeURI(value); } catch { /* a literal % in a path */ }
  return value.replaceAll('\\', '/');
}

// The local path for a PBIP path/URL, or null. A mapping also covers everything below it.
export function mapSourcePath(value, entries) {
  if (value === null || value === undefined || !entries?.length) return null;
  const decoded = decodedPath(value).replace(/\/+$/, '');
  const lower = decoded.toLowerCase();
  for (const entry of entries) {
    const from = decodedPath(entry.from).replace(/\/+$/, '').toLowerCase();
    if (!from) continue;
    if (lower === from) return { to: entry.to, entry };
    if (lower.startsWith(`${from}/`)) {
      const separator = /^[A-Za-z]:|^\\\\|\\/.test(entry.to) ? '\\' : '/';
      const rest = decoded.slice(from.length + 1).split('/').join(separator);
      return { to: `${entry.to.replace(/[\\/]+$/, '')}${separator}${rest}`, entry };
    }
  }
  return null;
}

const isAbsolutePath = file => path.isAbsolute(file) || path.win32.isAbsolute(file);

// Applies the source map to a discover() result before its sources are checked.
// Returns [{ key, from, to, used }]; mapped sources keep originalPath / originalUrl.
export function applySourceMap(inventory, entries) {
  const used = new Map();
  const note = entry => used.set(entry.key, (used.get(entry.key) ?? 0) + 1);
  if (entries.length) {
    for (const source of inventory.fileSources ?? []) {
      const mapped = mapSourcePath(source.path, entries);
      if (!mapped) continue;
      Object.assign(source, { originalPath: source.path, path: mapped.to, absolute: isAbsolutePath(mapped.to), mappedBy: mapped.entry.key });
      note(mapped.entry);
    }
    for (const workbook of inventory.excelWorkbooks ?? []) {
      const where = workbook.origin.kind === 'file' ? workbook.origin.path : workbook.origin.kind === 'remote' ? workbook.origin.url : null;
      const mapped = mapSourcePath(where, entries);
      if (mapped) workbook.origin = { kind: 'file', path: mapped.to, ...(workbook.origin.kind === 'remote' ? { originalUrl: where, connector: workbook.origin.connector } : { originalPath: where }) };
    }
    const mappedQueries = new Set();
    for (const read of inventory.remoteReads ?? []) {
      const mapped = mapSourcePath(read.url, entries);
      if (!mapped) continue;
      note(mapped.entry);
      read.mappedTo = mapped.to;
      for (const name of [read.query, read.originQuery]) if (name != null) mappedQueries.add(name);
      const kind = read.fileUnknown ? 'folder' : 'file';
      const key = sourceKey(mapped.to, kind);
      let record = (inventory.fileSources ?? []).find(source => sourceKey(source.path, source.kind) === key);
      if (!record) {
        record = { path: mapped.to, originalUrl: read.url, referencedBy: read.referencedBy, ...(read.query != null ? { query: read.query } : {}), kind, reader: kind === 'folder' ? 'Folder.Files' : read.reader, absolute: isAbsolutePath(mapped.to), mappedBy: mapped.entry.key, available: null, bytes: null, error: null };
        inventory.fileSources.push(record);
      }
      if (read.reader === 'Excel.Workbook' && kind === 'file') {
        const workbook = (inventory.excelWorkbooks ?? []).find(item => item.query === read.query && item.origin.kind === 'file' && item.origin.path === mapped.to);
        attachExcelItems(record, workbook ?? { items: [], query: read.query });
      }
    }
    // Remote connectors whose every read now comes from a local copy no longer block the run.
    for (const connector of inventory.unsupportedConnectors ?? []) {
      if (connector.query != null && mappedQueries.has(connector.query) && REMOTE_CONNECTOR.test(connector.connector)) connector.mappedTo = 'local copy (HC_SOURCE_MAP)';
    }
    inventory.directCsvSources = directCsv(inventory.fileSources ?? []);
  }
  inventory.sourceMap = entries.map(entry => ({ key: entry.key, from: entry.from, to: entry.to, used: used.get(entry.key) ?? 0 }));
  inventory.warnings = inventoryWarnings(inventory);
  return inventory.sourceMap;
}

// ---------- "Enter Data" tables ----------

// Rows embedded by Power BI's "Enter data":
//   Table.FromRows(Json.Document(Binary.Decompress(Binary.FromText("<base64>", BinaryEncoding.Base64), Compression.Deflate)),
//     let _t = ((type nullable text) meta [Serialized.Text = true]) in type table [A = _t, B = _t])
// Returns { columns, rows } (rows are arrays in column order) or null.
export function decodeEnterData(mText) {
  const q = analyzeM(stripMComments(String(mText ?? '')));
  const tokens = q.tokens;
  const callAt = (name, from, to) => { for (let k = from; k < to; k++) if (tokens[k].t === 'id' && tokens[k].v === name && isP(tokens[k + 1], '(') && tokens[k + 1].match !== undefined) return k; return -1; };
  for (let fromRows = callAt('Table.FromRows', 0, tokens.length); fromRows >= 0; fromRows = callAt('Table.FromRows', fromRows + 1, tokens.length)) {
    const close = tokens[fromRows + 1].match;
    const fromText = callAt('Binary.FromText', fromRows + 2, close);
    if (fromText < 0) continue;
    const textArgs = bracketItems(q, fromText + 1) ?? [];
    const literal = tokens[textArgs[0]?.a];
    if (!literal || literal.t !== 'str' || textArgs[0].b - textArgs[0].a !== 1) continue;
    if (textArgs[1] && !/^BinaryEncoding\.Base64$/i.test(q.text.slice(textArgs[1].start, textArgs[1].end).trim())) continue;
    let rows;
    try {
      let bytes = Buffer.from(literal.v.replace(/\s+/g, ''), 'base64');
      const decompress = enclosingCall(tokens, fromText);
      if (decompress >= 0 && tokens[decompress].v === 'Binary.Decompress') {
        const mode = bracketItems(q, decompress + 1)?.[1];
        bytes = /GZip/i.test(mode ? q.text.slice(mode.start, mode.end) : '') ? zlib.gunzipSync(bytes) : zlib.inflateRawSync(bytes);
      }
      rows = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    } catch { continue; }
    if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row))) continue;
    let columns = null;
    const fromRowsArgs = bracketItems(q, fromRows + 1) ?? [];
    const second = fromRowsArgs[1];
    if (second && isP(tokens[second.a], '{')) {
      const names = parseLiteralList(q.text.slice(second.start, second.end));
      if (names && names.every(name => typeof name === 'string')) columns = names;
    }
    for (let k = fromRows + 2; !columns && k < close - 2; k++) {
      if (isKeyword(tokens[k], 'type') && tokens[k + 1].t === 'id' && tokens[k + 1].v === 'table' && isP(tokens[k + 2], '[') && tokens[k + 2].match !== undefined) {
        const fields = recordFields(q, { a: k + 2, b: tokens[k + 2].match + 1 });
        if (fields?.size) columns = [...fields.keys()];
      }
    }
    if (!columns) {
      const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
      columns = Array.from({ length: width }, (_, index) => `Column${index + 1}`);
    }
    return { columns, rows };
  }
  return null;
}

// ---------- project discovery ----------

function isInside(file, dir) {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isDirectory(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

// .pbip -> artifacts[].report.path -> definition.pbir datasetReference.byPath -> semantic model folder.
function resolveProject(files, problems) {
  const inputRoot = path.resolve(inputDir);
  const pbip = files.filter(f => /\.pbip$/i.test(f));
  const pbix = files.filter(f => /\.pbix$/i.test(f));
  const artifactFolders = new Set();
  for (const file of files) {
    for (let dir = path.dirname(file); dir !== inputRoot && isInside(dir, inputRoot); dir = path.dirname(dir)) {
      if (/\.(?:Report|SemanticModel|Dataset)$/i.test(path.basename(dir))) artifactFolders.add(dir);
    }
    if (/^definition\.(?:pbir|pbism)$/i.test(path.basename(file))) artifactFolders.add(path.dirname(file));
  }
  if (!pbip.length) {
    if (pbix.length) throw new Error(`Found ${pbix.map(relative).join(', ')} in gemini/input, but this converter reads PBIP projects, not .pbix files. Open the .pbix in Power BI Desktop and save it as a PBIP project: File > Save as > Power BI project (*.pbip). Then copy the new .pbip file together with its .Report and .SemanticModel folders into gemini/input and remove the .pbix.`);
    if (artifactFolders.size) throw new Error(`Found ${[...artifactFolders].map(relative).join(', ')} in gemini/input but no .pbip file. Copy the whole PBIP project exactly as Power BI Desktop saved it: the .pbip file plus its .Report and .SemanticModel folders (in Desktop: File > Save as > Power BI project (*.pbip)).`);
    let entries = [];
    try { entries = fs.readdirSync(inputDir).filter(name => !name.startsWith('.')); } catch { /* no input folder */ }
    throw new Error(`Expected exactly one .pbip in input/; found 0${entries.length ? ` (gemini/input contains: ${entries.slice(0, 10).join(', ')}${entries.length > 10 ? ', ...' : ''})` : ' (gemini/input is empty)'}. Put exactly one PBIP project (the .pbip file with its .Report and .SemanticModel folders) in gemini/input.`);
  }
  if (pbip.length !== 1) throw new Error(`Expected exactly one .pbip in input/; found ${pbip.length}: ${pbip.map(relative).join(', ')}. Put exactly one PBIP project (the .pbip file with its .Report and .SemanticModel folders) in gemini/input.`);
  const project = pbip[0];
  const projectDir = path.dirname(project);
  for (const file of pbix) problems.push(`Ignored ${relative(file)}: only the PBIP project ${relative(project)} is converted.`);
  const pbipJson = readJson(project);
  if (!pbipJson) problems.push(`${relative(project)} is not valid JSON; using the .Report folder next to it.`);
  let reportDir = null;
  const declared = (Array.isArray(pbipJson?.artifacts) ? pbipJson.artifacts : []).map(item => item?.report?.path).find(value => typeof value === 'string' && value.trim());
  if (declared) {
    const candidate = path.resolve(projectDir, declared);
    if (isInside(candidate, inputRoot) && isDirectory(candidate)) reportDir = candidate;
    else problems.push(`${relative(project)} names the report folder "${declared}", which is not in gemini/input; using the .Report folder next to the .pbip instead.`);
  }
  if (!reportDir) {
    let siblings = [];
    try { siblings = fs.readdirSync(projectDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && /\.Report$/i.test(entry.name)).map(entry => path.join(projectDir, entry.name)); } catch { /* unreadable */ }
    const own = `${path.basename(project, path.extname(project))}.Report`.toLowerCase();
    reportDir = siblings.find(dir => path.basename(dir).toLowerCase() === own) ?? (siblings.length === 1 ? siblings[0] : null);
    if (!reportDir) throw new Error(siblings.length ? `${relative(project)} does not say which report folder it uses, and there are several: ${siblings.map(relative).join(', ')}. Keep only the project's own .Report folder in gemini/input.` : `No definition.pbir found: there is no .Report folder next to ${relative(project)}. Copy the whole PBIP project into gemini/input: the .pbip file plus its .Report and .SemanticModel folders.`);
  }
  const pbirFile = files.find(file => path.dirname(file) === reportDir && path.basename(file).toLowerCase() === 'definition.pbir');
  if (!pbirFile) throw new Error(`No definition.pbir found in ${relative(reportDir)}. Save the project in PBIP format with a report folder.`);
  const reference = readJson(pbirFile)?.datasetReference;
  let modelDir = null;
  if (typeof reference?.byPath?.path === 'string') {
    const candidate = path.resolve(reportDir, reference.byPath.path.replaceAll('\\', '/'));
    if (isInside(candidate, inputRoot) && isDirectory(candidate)) modelDir = candidate;
  }
  // A local model the report points to but that was renamed or not found: use the
  // only semantic model folder next to the .pbip. A live connection (byConnection)
  // has no local model, so nothing is guessed for it.
  if (!modelDir && !reference?.byConnection) {
    let models = [];
    try { models = fs.readdirSync(projectDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && /\.(?:SemanticModel|Dataset)$/i.test(entry.name)).map(entry => path.join(projectDir, entry.name)); } catch { /* unreadable */ }
    if (models.length === 1) {
      modelDir = models[0];
      problems.push(`${relative(pbirFile)} ${reference?.byPath?.path ? `points to the semantic model "${reference.byPath.path}", which is not in gemini/input` : 'names no semantic model'}; using ${relative(modelDir)}, the only semantic model folder next to the .pbip.`);
    }
  }
  const ignored = [...artifactFolders]
    .filter(dir => !isInside(dir, reportDir) && !isInside(reportDir, dir) && !(modelDir && (isInside(dir, modelDir) || isInside(modelDir, dir))))
    .filter((dir, _index, all) => !all.some(other => other !== dir && isInside(dir, other)));
  for (const dir of ignored) problems.push(`Ignored ${relative(dir)}: it is not the report or semantic model of ${relative(project)} (a leftover from another project or an older copy?). Remove it from gemini/input.`);
  return { project, reportDir, pbirFile, modelDir, ignored };
}

function inventoryWarnings(inventory) {
  const { dataFiles = [], directCsvSources = [], fileSources = [], webSources = [], postgresSources = [], unsupportedConnectors = [], pages = [] } = inventory;
  // Sources not checked yet (available: null) are not counted as missing.
  const availableDataCount = dataFiles.length + directCsvSources.filter(x => x.available !== false).length + postgresSources.reduce((n, x) => n + x.tables.length + x.nativeQueries.length, 0);
  return [
    ...(availableDataCount ? [] : ['No readable local CSV/JSON exports or direct File.Contents CSV sources found. Output can only be a metadata/layout preview.']),
    ...directCsvSources.filter(x => x.available === false).map(x => `CSV source not readable: ${x.path} (${x.error}).`),
    ...fileSources.filter(x => x.kind === 'folder' && x.available === false).map(x => `Folder source not readable: ${x.path} (${x.error}).`),
    ...(directCsvSources.some(x => x.available) ? ['Direct CSV source rows are raw; Power Query transformations and DAX have not been executed.'] : []),
    ...(postgresSources.length ? ['PostgreSQL sources found. A read-only login and npm install are required; raw tables/views do not include Power Query or DAX results.'] : []),
    ...postgresSources.filter(x => x.hasUnresolvedNativeQuery).map(x => `PostgreSQL source ${x.server}/${x.database} has ${x.unresolvedNativeQueries || 'a'} native quer${x.unresolvedNativeQueries > 1 ? 'ies' : 'y'} the parser cannot safely resolve; use a literal query with null parameters or provide a reviewed export.`),
    ...postgresSources.filter(x => x.nativeQueries.length).map(x => `PostgreSQL native query found for ${x.server}/${x.database}; explicit PG_ALLOW_NATIVE_QUERIES=true is required. Power Query steps after SQL, merges, and DAX are not applied automatically.`),
    ...postgresSources.filter(x => !x.tables.length && !x.nativeQueries.length && !x.hasUnresolvedNativeQuery).map(x => `PostgreSQL source ${x.server}/${x.database} has no simple schema/table navigation to read.`),
    ...(webSources.length ? [`Web.Contents source(s) found (${[...new Set(webSources.map(x => x.host ?? x.url ?? 'computed URL'))].join(', ')}); they are not checked before the run and may need sign-in or a proxy.`] : []),
    ...(inventory.remoteReads ?? []).filter(x => !x.mappedTo).map(x => `${x.reader} reads ${x.url ?? 'a file'} through ${x.connector}; map it to a local copy with HC_SOURCE_MAP_1=<URL> => <local path> in gemini/.env.`),
    ...unsupportedConnectors.filter(x => !x.mappedTo).map(x => `Unsupported connector ${x.connector} in ${x.referencedBy}; this run will not access it.`),
    ...(pages.length ? [] : ['No enhanced PBIR page.json files found. Legacy report.json requires agent interpretation.'])
  ];
}

// checkFiles: true stats every File.Contents/Folder.* path synchronously (the
// legacy flow). false records the paths with available: null; call
// checkSourceAvailability(inventory) afterwards to check them with a timeout.
export function discover({ checkFiles = true } = {}) {
  const files = walk(inputDir);
  const problems = [];
  const { project, reportDir, pbirFile, modelDir, ignored } = resolveProject(files, problems);
  const reportFiles = files.filter(file => isInside(file, reportDir));
  const modelFiles = modelDir ? files.filter(file => isInside(file, modelDir)) : [];
  const pageFiles = reportFiles.filter(f => /[\\/]definition[\\/]pages[\\/][^\\/]+[\\/]page\.json$/i.test(f));
  const pages = pageFiles.map(f => {
    const j = readJson(f);
    if (!j) problems.push(`${relative(f)} is not valid JSON; the page name and page filters are unknown.`);
    const folder = path.dirname(f);
    const visuals = walk(path.join(folder, 'visuals')).filter(v => /[\\/]visual\.json$/i.test(v)).map(v => {
      const x = readJson(v);
      if (!x) problems.push(`${relative(v)} is not valid JSON; this visual cannot be reconstructed from its definition.`);
      return {
        id: path.basename(path.dirname(v)),
        source: relative(v),
        type: x ? visualType(x) : 'unreadable',
        title: x ? visualTitle(x) : null,
        position: x?.position ?? null,
        // Unreadable JSON is treated as data-bound so it is never silently skipped.
        role: x ? classifyVisual(x) : 'data',
        ...(x?.isHidden ? { hidden: true } : {})
      };
    });
    return {
      id: path.basename(folder), name: j?.displayName ?? j?.name ?? path.basename(folder), source: relative(f),
      ...(pageIsHidden(j) ? { hidden: true } : {}),
      pageType: pageType(j),
      dataVisualCount: visuals.filter(visual => visual.role === 'data').length,
      visuals
    };
  });
  const orderFile = reportFiles.find(f => /[\\/]definition[\\/]pages[\\/]pages\.json$/i.test(f));
  const pageOrder = orderFile ? readJson(orderFile)?.pageOrder : null;
  // pages.json order first; pages it omits (or all pages without it) follow by display name.
  const order = Array.isArray(pageOrder) ? pageOrder : [];
  pages.sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi) || a.name.localeCompare(b.name);
  });
  if (Array.isArray(pageOrder)) {
    for (const page of pages.filter(item => !order.includes(item.id))) problems.push(`Page folder ${page.id} ("${page.name}") is not listed in pages.json; it is placed after the listed pages. If it is left over from copying a newer version of the project over an older one, clear gemini/input before copying the new version.`);
  }
  const definitionTmdl = modelFiles.some(file => /\.tmdl$/i.test(file) && !/[\\/](?:TMDLScripts|DAXQueries|cultures)[\\/]/i.test(file));
  for (const file of modelFiles.filter(f => /\.bim$/i.test(f))) if (definitionTmdl) problems.push(`Ignored ${relative(file)}: the TMDL definition folder is the semantic model; this model.bim is probably left over from an older copy. Clear gemini/input before copying a new version.`);
  const dataFiles = files.filter(f => {
    const rel = relative(f).toLowerCase();
    return rel.startsWith('input/data/') && /\.(csv|json)$/.test(rel);
  });
  const scan = scanModelSources(modelFiles, { checkFiles });
  for (const item of scan.unresolved) problems.push(`${item.connector}(${item.arguments}) in ${item.referencedBy} depends on something other than literal text or a literal parameter, so it cannot be checked before the run.`);
  const inventory = {
    project: relative(project),
    reportFolder: relative(reportDir),
    semanticModelFolder: modelDir ? relative(modelDir) : null,
    reportDefinitions: [relative(pbirFile)],
    pages, dataFiles: dataFiles.map(f => ({ path: relative(f), bytes: fs.statSync(f).size })),
    directCsvSources: directCsv(scan.fileSources),
    fileSources: scan.fileSources,
    webSources: scan.webSources,
    excelWorkbooks: scan.excelWorkbooks,
    remoteReads: scan.remoteReads,
    sourcesChecked: checkFiles,
    postgresSources: scan.postgresSources,
    unsupportedConnectors: scan.connectors,
    unresolvedSources: scan.unresolved,
    mParameters: scan.parameters,
    reportModelReferences: findReportModelReferences([pbirFile]),
    ignoredFolders: ignored.map(relative),
    sourceFileCount: files.length,
    problems,
    warnings: []
  };
  inventory.warnings = inventoryWarnings(inventory);
  return inventory;
}

// Checks every file/folder source of an inventory in parallel without blocking
// the event loop: an unreachable network share cannot freeze the console.
// Fills available/bytes/error on each fileSources entry (error 'TIMEOUT' when
// the path did not answer within timeoutMs), then recomputes directCsvSources
// and warnings. onProgress({ done, total, source, ms }) runs after each check.
export async function checkSourceAvailability(inventory, { timeoutMs = 15000, onProgress } = {}) {
  const sources = inventory.fileSources ?? [];
  let done = 0;
  await Promise.all(sources.map(async source => {
    const started = Date.now();
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs); timer.unref?.(); });
    let result;
    try {
      const stat = await Promise.race([fs.promises.stat(source.path), timeout]);
      result = stat === 'TIMEOUT' ? { available: false, bytes: null, error: 'TIMEOUT' } : statResult(stat, source.kind === 'folder');
    } catch (error) {
      result = { available: false, bytes: null, error: error.code ?? error.message };
    } finally { clearTimeout(timer); }
    Object.assign(source, result);
    done++;
    try { onProgress?.({ done, total: sources.length, source, ms: Date.now() - started }); } catch { /* progress reporting must not stop the check */ }
  }));
  inventory.directCsvSources = directCsv(sources);
  inventory.sourcesChecked = true;
  inventory.warnings = inventoryWarnings(inventory);
  return inventory;
}

export function loadData(inventory) {
  const sources = [
    ...inventory.dataFiles.map(info => ({ file: path.join(root, info.path), source: info.path, kind: 'local-export' })),
    ...(inventory.directCsvSources ?? []).filter(info => info.available).map(info => ({ file: info.path, source: path.basename(info.path), kind: 'raw-file-source' }))
  ];
  return { datasets: sources.map(info => {
    const file = info.file;
    const name = path.basename(file, path.extname(file));
    if (file.toLowerCase().endsWith('.csv')) return { name, source: info.source, kind: info.kind, ...parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
    const parsed = readJson(file);
    if (parsed === null) throw new Error(`Invalid JSON: ${info.source}`);
    const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.rows) ? parsed.rows : null;
    if (!rows) throw new Error(`JSON must be an array or have a rows array: ${info.source}`);
    const columns = [...new Set(rows.flatMap(x => x && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x) : []))];
    return { name, source: info.source, kind: info.kind, columns, rows };
  }) };
}
