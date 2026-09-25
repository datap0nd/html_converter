import fs from 'node:fs';
import path from 'node:path';
import { root as defaultRoot, inputDir as defaultInputDir, walk, relative, readJson } from './core.mjs';
import { literalText, describeField, visualTitle, visualProjections, classifyVisual, visualType } from './pbir.mjs';

export { literalText, describeField, visualTitle, visualProjections, classifyVisual };

// A deterministic, compact extraction of what the selected report pages need,
// so Gemini can start from one file instead of crawling every PBIR/TMDL file
// with a tool call each. Nothing here executes M or DAX.

export const DIGEST_VERSION = 1;

const MAX_RAW = 4000;

function compact(value, limit = MAX_RAW) {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}... [truncated ${text.length - limit} chars; see source file]` : JSON.parse(text);
}

function fromAliases(filter) {
  const aliases = {};
  for (const item of filter?.From ?? []) if (item?.Name && item?.Entity) aliases[item.Name] = item.Entity;
  return aliases;
}

function filterDigest(filters) {
  if (!Array.isArray(filters)) return [];
  return filters.map(item => ({
    name: item?.name ?? null,
    type: item?.type ?? null,
    field: describeField(item?.field, fromAliases(item?.filter)),
    ...(item?.filter ? { condition: compact(item.filter) } : {}),
    ...(item?.isHiddenInViewMode ? { hiddenInViewMode: true } : {}),
    ...(item?.isLockedInViewMode ? { lockedInViewMode: true } : {}),
    ...(item?.displayName ? { displayName: item.displayName } : {})
  }));
}

function sortDigest(json) {
  const sort = json?.visual?.query?.sortDefinition?.sort;
  if (!Array.isArray(sort)) return undefined;
  return sort.map(item => ({ field: describeField(item?.field), direction: item?.direction ?? null }));
}

export function visualDigest(json, meta = {}) {
  const visual = json?.visual ?? {};
  const role = classifyVisual(json);
  const slicerSelection = visual.objects?.general?.[0]?.properties?.filter?.filter;
  return {
    id: meta.id ?? json?.name ?? null,
    source: meta.source ?? null,
    type: visualType(json),
    role,
    title: visualTitle(json),
    position: json?.position ?? null,
    ...(json?.parentGroupName ? { parentGroup: json.parentGroupName } : {}),
    ...(json?.isHidden ? { hidden: true } : {}),
    ...(json?.visualGroup ? { group: { displayName: json.visualGroup.displayName ?? null, mode: json.visualGroup.groupMode ?? null } } : {}),
    fields: visualProjections(json),
    ...(sortDigest(json) ? { sort: sortDigest(json) } : {}),
    filters: filterDigest(json?.filterConfig?.filters),
    ...(slicerSelection ? { savedSlicerSelection: compact(slicerSelection) } : {}),
    ...(visual.objects?.data ? { slicerMode: compact(visual.objects.data, 600) } : {}),
    ...(visual.drillFilterOtherVisuals !== undefined ? { drillFilterOtherVisuals: visual.drillFilterOtherVisuals } : {}),
    formattingObjects: Object.keys(visual.objects ?? {}),
    containerObjects: Object.keys(visual.visualContainerObjects ?? {})
  };
}

// ---------- TMDL ----------

function lineIndent(line) {
  let depth = 0, index = 0;
  while (index < line.length) {
    if (line[index] === '\t') { depth++; index++; }
    else if (line.startsWith('    ', index)) { depth++; index += 4; }
    else break;
  }
  return { depth, rest: line.slice(index) };
}

const DECLARATIONS = new Set(['model', 'database', 'table', 'column', 'measure', 'partition', 'hierarchy', 'level', 'relationship', 'expression', 'calculationGroup', 'calculationItem', 'annotation', 'extendedProperty', 'variation', 'perspective', 'perspectiveTable', 'perspectiveColumn', 'perspectiveMeasure', 'perspectiveHierarchy', 'role', 'tablePermission', 'columnPermission', 'culture', 'linguisticMetadata', 'dataSource', 'queryGroup', 'formatStringDefinition', 'detailRowsDefinition', 'changedProperty', 'dataAccessOptions', 'function', 'calendar', 'alternateOf', 'refreshPolicy']);

export function parseTmdlName(text) {
  const source = text.trimStart();
  if (source.startsWith("'")) {
    let index = 1, name = '';
    while (index < source.length) {
      if (source[index] === "'") {
        if (source[index + 1] === "'") { name += "'"; index += 2; continue; }
        index++;
        break;
      }
      name += source[index++];
    }
    return { name, rest: source.slice(index) };
  }
  const match = /^([^\s=:]+)([\s\S]*)$/.exec(source);
  return match ? { name: match[1], rest: match[2] } : { name: '', rest: '' };
}

export function parseQualifiedColumn(text) {
  const first = parseTmdlName(text ?? '');
  const rest = first.rest.trimStart();
  if (rest.startsWith('.')) return { table: first.name, column: parseTmdlName(rest.slice(1)).name };
  // Unquoted Table.Column is a single token.
  const dot = first.name.indexOf('.');
  if (dot > 0) return { table: first.name.slice(0, dot), column: first.name.slice(dot + 1) };
  return { table: null, column: first.name };
}

export function parseTmdl(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  let cursor = 0;

  function dedent(block) {
    while (block.length && !block[block.length - 1].trim()) block.pop();
    while (block.length && !block[0].trim()) block.shift();
    const depths = block.filter(line => line.trim()).map(line => lineIndent(line).depth);
    const min = depths.length ? Math.min(...depths) : 0;
    return block.map(line => {
      let result = line;
      for (let level = 0; level < min; level++) result = result.startsWith('\t') ? result.slice(1) : result.startsWith('    ') ? result.slice(4) : result;
      return result;
    }).join('\n');
  }

  function readExpression(depth, first) {
    const inline = first.trim();
    if (inline.startsWith('```')) {
      const block = [inline.slice(3)];
      while (cursor < lines.length) {
        const line = lines[cursor++];
        const end = line.indexOf('```');
        if (end >= 0) { block.push(line.slice(0, end)); break; }
        block.push(line);
      }
      return dedent(block);
    }
    const block = inline ? [] : [];
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (line.trim() && lineIndent(line).depth < depth + 2) break;
      block.push(line);
      cursor++;
    }
    const continuation = dedent(block);
    return inline ? (continuation ? `${inline}\n${continuation}` : inline) : continuation;
  }

  function parseBlock(depth) {
    const nodes = [], props = {};
    let description = [];
    while (cursor < lines.length) {
      const line = lines[cursor];
      if (!line.trim()) { cursor++; continue; }
      const { depth: current, rest } = lineIndent(line);
      if (current < depth) break;
      if (current > depth) { cursor++; continue; }
      if (rest.startsWith('///')) { description.push(rest.slice(3).trim()); cursor++; continue; }
      const declaration = /^(ref\s+)?([A-Za-z][A-Za-z0-9]*)\s+(.+)$/.exec(rest);
      if (declaration && DECLARATIONS.has(declaration[2]) && !/^\s*:/.test(declaration[3])) {
        cursor++;
        const { name, rest: after } = parseTmdlName(declaration[3]);
        const node = { kind: declaration[2], name, props: {}, children: [] };
        if (declaration[1]) node.ref = true;
        if (description.length) node.description = description.join('\n');
        description = [];
        const assignment = /^\s*=([\s\S]*)$/.exec(after);
        if (assignment) node.value = readExpression(current, assignment[1]);
        const body = parseBlock(current + 1);
        node.props = body.props;
        node.children = body.nodes;
        nodes.push(node);
        continue;
      }
      description = [];
      const property = /^([A-Za-z][A-Za-z0-9]*)\s*(:|=)\s*([\s\S]*)$/.exec(rest);
      cursor++;
      if (!property) continue;
      props[property[1]] = property[2] === '=' ? readExpression(current, property[3]) : property[3].trim();
      if (property[2] === ':' && !property[3].trim()) {
        // A property whose value continues on deeper lines (rare, e.g. JSON).
        const extra = readExpression(current, '');
        if (extra) props[property[1]] = extra;
      }
    }
    return { nodes, props };
  }

  const result = [];
  while (cursor < lines.length) {
    const before = cursor;
    result.push(...parseBlock(0).nodes);
    if (cursor === before) cursor++;
  }
  return result;
}

function tmdlTable(node, file) {
  const table = { name: node.name, source: file, columns: [], measures: [], partitions: [], hierarchies: [] };
  if (node.description) table.description = node.description;
  if (node.props.isHidden !== undefined) table.hidden = true;
  if (node.kind === 'calculationGroup') table.calculationGroup = true;
  for (const child of node.children) {
    if (child.kind === 'column') {
      table.columns.push({
        name: child.name,
        ...(child.value ? { expression: child.value } : {}),
        ...(child.props.dataType ? { dataType: child.props.dataType } : {}),
        ...(child.props.sourceColumn ? { sourceColumn: literalQuoted(child.props.sourceColumn) } : {}),
        ...(child.props.formatString ? { formatString: child.props.formatString } : {}),
        ...(child.props.summarizeBy ? { summarizeBy: child.props.summarizeBy } : {}),
        ...(child.props.sortByColumn ? { sortByColumn: child.props.sortByColumn } : {}),
        ...(child.props.isHidden !== undefined ? { hidden: true } : {})
      });
    } else if (child.kind === 'measure') {
      table.measures.push({
        name: child.name,
        expression: child.value ?? '',
        ...(child.props.formatString ? { formatString: child.props.formatString } : {}),
        ...(child.children.find(x => x.kind === 'formatStringDefinition') ? { formatStringExpression: child.children.find(x => x.kind === 'formatStringDefinition').value } : {}),
        ...(child.props.displayFolder ? { displayFolder: child.props.displayFolder } : {}),
        ...(child.description ? { description: child.description } : {})
      });
    } else if (child.kind === 'partition') {
      table.partitions.push({ name: child.name, type: (child.value ?? '').trim() || null, mode: child.props.mode ?? null, source: child.props.source ?? child.props.expression ?? child.props.query ?? null, ...(child.props.expressionSource ? { expressionSource: child.props.expressionSource } : {}) });
    } else if (child.kind === 'hierarchy') {
      table.hierarchies.push({ name: child.name, levels: child.children.filter(x => x.kind === 'level').map(level => ({ name: level.name, column: level.props.column ?? null })) });
    } else if (child.kind === 'calculationItem') {
      table.measures.push({ name: child.name, expression: child.value ?? '', calculationItem: true });
    }
  }
  return table;
}

function literalQuoted(value) {
  const match = /^"([\s\S]*)"$/.exec(value ?? '');
  return match ? match[1].replaceAll('""', '"') : value;
}

function tmdlRelationship(node, file) {
  const from = parseQualifiedColumn(node.props.fromColumn);
  const to = parseQualifiedColumn(node.props.toColumn);
  return {
    name: node.name, source: file,
    fromTable: from.table, fromColumn: from.column, toTable: to.table, toColumn: to.column,
    ...(node.props.fromCardinality ? { fromCardinality: node.props.fromCardinality } : {}),
    ...(node.props.toCardinality ? { toCardinality: node.props.toCardinality } : {}),
    crossFilteringBehavior: node.props.crossFilteringBehavior ?? 'oneDirection',
    active: node.props.isActive !== 'false'
  };
}

function bimText(value) {
  return Array.isArray(value) ? value.join('\n') : typeof value === 'string' ? value : value == null ? null : JSON.stringify(value);
}

function bimModel(json, file) {
  const model = json?.model ?? {};
  const tables = (model.tables ?? []).map(table => ({
    name: table.name, source: file,
    columns: (table.columns ?? []).map(column => ({ name: column.name, ...(column.expression ? { expression: bimText(column.expression) } : {}), ...(column.dataType ? { dataType: column.dataType } : {}), ...(column.sourceColumn ? { sourceColumn: column.sourceColumn } : {}), ...(column.formatString ? { formatString: column.formatString } : {}) })),
    measures: (table.measures ?? []).map(measure => ({ name: measure.name, expression: bimText(measure.expression) ?? '', ...(measure.formatString ? { formatString: measure.formatString } : {}) })),
    partitions: (table.partitions ?? []).map(partition => ({ name: partition.name, type: partition.source?.type ?? null, mode: partition.mode ?? null, source: bimText(partition.source?.expression ?? partition.source?.query) })),
    hierarchies: (table.hierarchies ?? []).map(hierarchy => ({ name: hierarchy.name, levels: (hierarchy.levels ?? []).map(level => ({ name: level.name, column: level.column })) }))
  }));
  const relationships = (model.relationships ?? []).map(item => ({ name: item.name, source: file, fromTable: item.fromTable, fromColumn: item.fromColumn, toTable: item.toTable, toColumn: item.toColumn, crossFilteringBehavior: item.crossFilteringBehavior ?? 'oneDirection', active: item.isActive !== false }));
  const expressions = (model.expressions ?? []).map(item => ({ name: item.name, kind: item.kind ?? 'm', expression: bimText(item.expression) ?? '', source: file }));
  return { tables, relationships, expressions };
}

export function isModelDefinitionFile(file) {
  const normalized = file.replaceAll('\\', '/');
  if (/\/(?:TMDLScripts|DAXQueries|cultures|\.pbi)\//i.test(normalized)) return false;
  return /\.(tmdl|bim)$/i.test(normalized);
}

export function loadSemanticModel(files, rootDir = defaultRoot) {
  const model = { format: null, tables: [], relationships: [], expressions: [], parseErrors: [] };
  const rel = file => path.relative(rootDir, file).replaceAll('\\', '/');
  for (const file of files.filter(isModelDefinitionFile)) {
    try {
      if (/\.bim$/i.test(file)) {
        const json = readJson(file);
        if (!json) throw new Error('Invalid JSON');
        const part = bimModel(json, rel(file));
        model.format ??= 'bim';
        model.tables.push(...part.tables);
        model.relationships.push(...part.relationships);
        model.expressions.push(...part.expressions);
        continue;
      }
      model.format ??= 'tmdl';
      for (const node of parseTmdl(fs.readFileSync(file, 'utf8'))) {
        if (node.ref) continue;
        if (node.kind === 'table' || node.kind === 'calculationGroup') model.tables.push(tmdlTable(node, rel(file)));
        else if (node.kind === 'relationship') model.relationships.push(tmdlRelationship(node, rel(file)));
        else if (node.kind === 'expression') model.expressions.push({ name: node.name, kind: 'm', expression: node.value ?? '', ...(node.props.queryGroup ? { queryGroup: node.props.queryGroup } : {}), source: rel(file) });
        else if (node.kind === 'model') {
          for (const child of node.children) {
            if (child.kind === 'table') model.tables.push(tmdlTable(child, rel(file)));
            else if (child.kind === 'relationship') model.relationships.push(tmdlRelationship(child, rel(file)));
            else if (child.kind === 'expression') model.expressions.push({ name: child.name, kind: 'm', expression: child.value ?? '', source: rel(file) });
          }
        }
      }
    } catch (error) {
      model.parseErrors.push(`${rel(file)}: ${error.message}`);
    }
  }
  return model;
}

// ---------- reference scanning (deliberately over-inclusive) ----------

function stripDax(text) {
  return String(text ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(?:\/\/|--)[^\n]*/g, ' ')
    .replace(/"(?:[^"]|"")*"/g, '""');
}

export function daxReferences(expression, tableNames = []) {
  const text = stripDax(expression);
  const qualified = [], unqualified = [], tables = new Set();
  for (const match of text.matchAll(/\[([^\]]+)\]/g)) {
    let index = match.index - 1;
    while (index >= 0 && text[index] === ' ') index--;
    if (index >= 0 && text[index] === "'") {
      const start = text.lastIndexOf("'", index - 1);
      if (start >= 0) {
        const table = text.slice(start + 1, index).replaceAll("''", "'");
        qualified.push({ table, name: match[1] });
        tables.add(table);
        continue;
      }
    }
    const word = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(text.slice(0, index + 1));
    if (word && index >= 0 && /[A-Za-z0-9_]/.test(text[index])) {
      qualified.push({ table: word[1], name: match[1] });
      tables.add(word[1]);
    } else unqualified.push(match[1]);
  }
  const lower = text.toLowerCase();
  const bare = text.replace(/\[[^\]]*\]/g, '[]').replace(/'(?:[^']|'')*'/g, "''");
  for (const name of tableNames) {
    if (lower.includes(`'${name.toLowerCase().replaceAll("'", "''")}'`)) tables.add(name);
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && new RegExp(`(^|[^A-Za-z0-9_'\\[.])${name}(?![A-Za-z0-9_\\[])(?!\\s*\\()`, 'i').test(bare)) tables.add(name);
  }
  return { qualified, unqualified, tables: [...tables] };
}

export function mReferences(expression, names = []) {
  const text = String(expression ?? '');
  const found = new Set();
  const quoted = new Set([...text.matchAll(/#"((?:[^"]|"")*)"/g)].map(match => match[1].replaceAll('""', '"')));
  const bare = text.replace(/#?"(?:[^"]|"")*"/g, '""').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  for (const name of names) {
    if (quoted.has(name)) found.add(name);
    else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && new RegExp(`(^|[^A-Za-z0-9_.#"])${name}(?![A-Za-z0-9_.(])`).test(bare)) found.add(name);
  }
  return [...found];
}

// ---------- digest ----------

function readPageJson(file) {
  return readJson(file) ?? {};
}

function fieldsOf(value, into) {
  if (!value || typeof value !== 'object') return into;
  if (Array.isArray(value)) { value.forEach(item => fieldsOf(item, into)); return into; }
  if (value.kind && (value.table || value.name)) into.push(value);
  for (const item of Object.values(value)) if (item && typeof item === 'object') fieldsOf(item, into);
  return into;
}

function findReportJson(inventory, rootDir) {
  const pbir = inventory.reportDefinitions?.[0];
  if (!pbir) return null;
  const file = path.join(rootDir, path.dirname(pbir), 'definition', 'report.json');
  return fs.existsSync(file) ? { file, json: readJson(file) } : null;
}

export function scopeModel(model, seeds) {
  const tableNames = model.tables.map(table => table.name);
  const byName = new Map(model.tables.map(table => [table.name.toLowerCase(), table]));
  const measureOwner = new Map();
  for (const table of model.tables) for (const measure of table.measures) if (!measureOwner.has(measure.name.toLowerCase())) measureOwner.set(measure.name.toLowerCase(), table);
  const expressionNames = model.expressions.map(item => item.name);
  const tables = new Set(), measures = new Set(), expressions = new Set();
  const queue = [];
  const addTable = name => { const table = byName.get(String(name ?? '').toLowerCase()); if (table && !tables.has(table.name)) { tables.add(table.name); queue.push({ type: 'table', table }); } };
  const addMeasure = (tableName, name) => {
    const key = String(name ?? '').toLowerCase();
    const owner = (tableName && byName.get(tableName.toLowerCase())?.measures.some(m => m.name.toLowerCase() === key)) ? byName.get(tableName.toLowerCase()) : measureOwner.get(key);
    if (!owner) return false;
    const id = `${owner.name}\u0000${owner.measures.find(m => m.name.toLowerCase() === key).name}`;
    if (!measures.has(id)) { measures.add(id); queue.push({ type: 'measure', owner, measure: owner.measures.find(m => m.name.toLowerCase() === key) }); }
    return true;
  };
  const addExpression = name => { const item = model.expressions.find(x => x.name === name); if (item && !expressions.has(item.name)) { expressions.add(item.name); queue.push({ type: 'expression', item }); } };
  const scanDax = text => {
    const refs = daxReferences(text, tableNames);
    for (const ref of refs.qualified) if (!addMeasure(ref.table, ref.name)) addTable(ref.table);
    for (const name of refs.unqualified) addMeasure(null, name);
    refs.tables.forEach(addTable);
  };
  const scanM = text => {
    for (const name of mReferences(text, [...tableNames, ...expressionNames])) {
      if (expressionNames.includes(name)) addExpression(name);
      else addTable(name);
    }
  };
  for (const field of seeds) {
    if (field.kind === 'measure' || (field.kind === 'aggregation' && field.of === 'measure')) { if (!addMeasure(field.table, field.name)) addTable(field.table); }
    else if (field.table) addTable(field.table);
  }
  while (queue.length) {
    const next = queue.shift();
    if (next.type === 'measure') scanDax(next.measure.expression);
    else if (next.type === 'expression') scanM(next.item.expression);
    else {
      for (const column of next.table.columns) if (column.expression) scanDax(column.expression);
      for (const partition of next.table.partitions) {
        if (partition.type === 'calculated') scanDax(partition.source);
        else scanM(partition.source);
        if (partition.expressionSource) addExpression(literalQuoted(partition.expressionSource));
      }
      for (const measure of next.table.measures.filter(m => m.calculationItem)) scanDax(measure.expression);
    }
  }
  // One relationship hop keeps bridge/dimension tables needed for filter propagation.
  const direct = new Set(tables);
  const related = new Set();
  for (const relationship of model.relationships) {
    const fromIn = direct.has(relationship.fromTable), toIn = direct.has(relationship.toTable);
    if (fromIn && !toIn && byName.has(String(relationship.toTable).toLowerCase())) related.add(relationship.toTable);
    if (toIn && !fromIn && byName.has(String(relationship.fromTable).toLowerCase())) related.add(relationship.fromTable);
  }
  const included = new Set([...direct, ...related]);
  const measureIds = measures;
  const relatedDetails = new Set();
  for (const name of related) {
    const table = byName.get(name.toLowerCase());
    for (const partition of table.partitions) for (const ref of mReferences(partition.source, expressionNames)) relatedDetails.add(ref);
  }
  relatedDetails.forEach(addExpression);
  while (queue.length) {
    const next = queue.shift();
    if (next.type === 'expression') for (const name of mReferences(next.item.expression, expressionNames)) if (!expressions.has(name)) { expressions.add(name); queue.push({ type: 'expression', item: model.expressions.find(x => x.name === name) }); }
  }
  const tablesOut = model.tables.filter(table => included.has(table.name)).map(table => ({
    ...table,
    scope: direct.has(table.name) ? 'referenced' : 'related-by-relationship',
    measures: table.measures.filter(measure => measure.calculationItem || measureIds.has(`${table.name}\u0000${measure.name}`)),
    omittedMeasureCount: table.measures.filter(measure => !measure.calculationItem && !measureIds.has(`${table.name}\u0000${measure.name}`)).length
  }));
  for (const table of model.tables) {
    if (included.has(table.name)) continue;
    const hosted = table.measures.filter(measure => measureIds.has(`${table.name}\u0000${measure.name}`));
    if (hosted.length) tablesOut.push({ name: table.name, source: table.source, scope: 'measure-host', columns: [], partitions: [], hierarchies: [], measures: hosted, omittedMeasureCount: table.measures.length - hosted.length });
  }
  return {
    tables: tablesOut,
    relationships: model.relationships.filter(item => included.has(item.fromTable) && included.has(item.toTable)),
    expressions: model.expressions.filter(item => expressions.has(item.name)),
    otherTables: model.tables.filter(table => !tablesOut.some(x => x.name === table.name)).map(table => ({ name: table.name, source: table.source, columns: table.columns.length, measures: table.measures.length }))
  };
}

export function buildReportDigest(inventory, { rootDir = defaultRoot, inputDir = defaultInputDir } = {}) {
  const warnings = [];
  const pages = inventory.pages.map(page => {
    const pageFile = path.join(rootDir, page.source);
    const pageJson = readPageJson(pageFile);
    const visuals = page.visuals.map(meta => {
      const json = readJson(path.join(rootDir, meta.source));
      if (!json) { warnings.push(`Could not parse ${meta.source}; open it directly.`); return { id: meta.id, source: meta.source, type: meta.type, role: meta.role ?? 'data', unreadable: true }; }
      return visualDigest(json, meta);
    });
    return {
      id: page.id, name: page.name, source: page.source,
      width: pageJson.width ?? null, height: pageJson.height ?? null,
      displayOption: pageJson.displayOption ?? null,
      ...(pageJson.visibility ? { visibility: pageJson.visibility } : {}),
      ...(pageJson.pageBinding ? { pageBinding: compact(pageJson.pageBinding, 1500) } : {}),
      filters: filterDigest(pageJson.filterConfig?.filters),
      visuals
    };
  });
  const report = findReportJson(inventory, rootDir);
  const reportFilters = filterDigest(report?.json?.filterConfig?.filters);
  const seeds = fieldsOf([pages, reportFilters], []);
  const files = walk(inputDir);
  const model = loadSemanticModel(files, rootDir);
  if (!model.format) warnings.push('No TMDL or model.bim semantic model definition found under input/.');
  warnings.push(...model.parseErrors.map(error => `Model parse issue (read the file directly): ${error}`));
  const scoped = scopeModel(model, seeds);
  const knownTables = new Set(model.tables.map(table => table.name.toLowerCase()));
  const unresolved = [...new Set(seeds.filter(field => field.table && !knownTables.has(field.table.toLowerCase())).map(field => field.table))];
  if (unresolved.length && model.format) warnings.push(`Visual fields reference tables not found in the model definition: ${unresolved.join(', ')}.`);
  const visualCount = pages.reduce((sum, page) => sum + page.visuals.length, 0);
  return {
    digestVersion: DIGEST_VERSION,
    purpose: 'Deterministic extraction of the selected report scope. Start here; open the cited source files only for details not captured (formatting objects, full filter JSON).',
    project: inventory.project,
    scope: inventory.pageScope ?? null,
    counts: {
      pages: pages.length,
      visuals: visualCount,
      dataVisuals: pages.reduce((sum, page) => sum + page.visuals.filter(v => v.role === 'data').length, 0),
      decorativeVisuals: pages.reduce((sum, page) => sum + page.visuals.filter(v => v.role === 'decorative').length, 0),
      groups: pages.reduce((sum, page) => sum + page.visuals.filter(v => v.role === 'group').length, 0),
      modelTables: model.tables.length,
      includedTables: scoped.tables.length,
      includedMeasures: scoped.tables.reduce((sum, table) => sum + table.measures.length, 0),
      relationships: scoped.relationships.length
    },
    reportFilters,
    ...(report ? { reportDefinition: relative(report.file) } : {}),
    pages,
    model: { format: model.format, ...scoped },
    sources: {
      postgres: inventory.postgresSources ?? [],
      directCsv: (inventory.directCsvSources ?? []).map(({ path: file, referencedBy, available, error }) => ({ path: file, referencedBy, available, ...(error ? { error } : {}) })),
      otherConnectors: inventory.unsupportedConnectors ?? []
    },
    warnings
  };
}
