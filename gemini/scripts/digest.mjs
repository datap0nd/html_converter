import fs from 'node:fs';
import path from 'node:path';
import { root as defaultRoot, inputDir as defaultInputDir, walk, relative, readJson } from './core.mjs';
import { literalText, describeField, visualTitle, visualProjections, classifyVisual, visualType, formattingFields } from './pbir.mjs';
import { parseTmdl, parseTmdlName, parseQualifiedColumn } from './tmdl.mjs';

export { parseTmdl, parseTmdlName, parseQualifiedColumn };

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
    ...(formattingFields(json).length ? { formattingFields: formattingFields(json) } : {}),
    ...(sortDigest(json) ? { sort: sortDigest(json) } : {}),
    filters: filterDigest(json?.filterConfig?.filters),
    ...(slicerSelection ? { savedSlicerSelection: compact(slicerSelection) } : {}),
    ...(visual.objects?.data ? { slicerMode: compact(visual.objects.data, 600) } : {}),
    ...(visual.drillFilterOtherVisuals !== undefined ? { drillFilterOtherVisuals: visual.drillFilterOtherVisuals } : {}),
    formattingObjects: Object.keys(visual.objects ?? {}),
    containerObjects: Object.keys(visual.visualContainerObjects ?? {})
  };
}

function tmdlMeasure(child) {
  const formatDefinition = child.children.find(x => x.kind === 'formatStringDefinition');
  return {
    name: child.name,
    expression: child.value ?? '',
    ...(child.props.formatString ? { formatString: child.props.formatString } : {}),
    ...(formatDefinition?.value ? { formatStringExpression: formatDefinition.value } : {}),
    ...(child.props.displayFolder ? { displayFolder: child.props.displayFolder } : {}),
    ...(child.props.isHidden ? { hidden: true } : {}),
    ...(child.description ? { description: child.description } : {})
  };
}

function tmdlTable(node, file) {
  const table = { name: node.name, source: file, columns: [], measures: [], partitions: [], hierarchies: [] };
  if (node.description) table.description = node.description;
  if (node.props.isHidden) table.hidden = true;
  if (node.props.showAsVariationsOnly) table.autoDateTable = true;
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
        ...(child.props.isHidden ? { hidden: true } : {}),
        ...(child.props.isKey ? { key: true } : {})
      });
    } else if (child.kind === 'measure') {
      table.measures.push(tmdlMeasure(child));
    } else if (child.kind === 'partition') {
      table.partitions.push({ name: child.name, type: (child.value ?? '').trim() || null, mode: child.props.mode ?? null, source: child.props.source ?? child.props.expression ?? child.props.query ?? null, ...(child.props.expressionSource ? { expressionSource: child.props.expressionSource } : {}) });
    } else if (child.kind === 'hierarchy') {
      table.hierarchies.push({ name: child.name, levels: child.children.filter(x => x.kind === 'level').map(level => ({ name: level.name, column: level.props.column ?? null })) });
    } else if (child.kind === 'calculationGroup') {
      table.calculationGroup = { precedence: child.props.precedence ? Number(child.props.precedence) : null, items: child.children.filter(x => x.kind === 'calculationItem').map(item => ({ name: item.name, expression: item.value ?? '', ...(item.props.ordinal ? { ordinal: Number(item.props.ordinal) } : {}), ...(item.children.find(x => x.kind === 'formatStringDefinition')?.value ? { formatStringExpression: item.children.find(x => x.kind === 'formatStringDefinition').value } : {}) })) };
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
    hierarchies: (table.hierarchies ?? []).map(hierarchy => ({ name: hierarchy.name, levels: (hierarchy.levels ?? []).map(level => ({ name: level.name, column: level.column })) })),
    ...(table.isHidden ? { hidden: true } : {}),
    ...(table.calculationGroup ? { calculationGroup: { precedence: table.calculationGroup.precedence ?? null, items: (table.calculationGroup.calculationItems ?? []).map(item => ({ name: item.name, expression: bimText(item.expression) ?? '', ...(item.ordinal !== undefined ? { ordinal: item.ordinal } : {}) })) } } : {})
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
  const model = { format: null, tables: [], relationships: [], expressions: [], parseErrors: [], ignored: [] };
  const rel = file => path.relative(rootDir, file).replaceAll('\\', '/');
  const definitions = files.filter(isModelDefinitionFile);
  // A TMDL definition folder is authoritative; a leftover model.bim beside it would duplicate every table.
  const hasTmdl = definitions.some(file => /\.tmdl$/i.test(file));
  for (const file of definitions) {
    if (hasTmdl && /\.bim$/i.test(file)) { model.ignored.push(rel(file)); continue; }
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
  const qualified = [], unqualified = [], tables = new Set(), words = [];
  const known = new Map(tableNames.map(name => [name.toLowerCase(), name]));
  const skipSpaces = index => { while (index < text.length && (text[index] === ' ' || text[index] === '\t')) index++; return index; };
  const readBracket = index => { const end = text.indexOf(']', index + 1); return end < 0 ? null : { name: text.slice(index + 1, end), next: end + 1 }; };
  for (let index = 0; index < text.length;) {
    const c = text[index];
    if (c === "'") {
      let end = index + 1, name = '';
      while (end < text.length) {
        if (text[end] === "'" && text[end + 1] === "'") { name += "'"; end += 2; continue; }
        if (text[end] === "'") break;
        name += text[end++];
      }
      const after = skipSpaces(end + 1);
      if (text[after] === '[') { const bracket = readBracket(after); if (bracket) { qualified.push({ table: name, name: bracket.name }); index = bracket.next; } else index = after + 1; }
      else index = end + 1;
      tables.add(known.get(name.toLowerCase()) ?? name);
      continue;
    }
    if (c === '[') {
      const bracket = readBracket(index);
      if (!bracket) break;
      unqualified.push(bracket.name);
      index = bracket.next;
      continue;
    }
    if (/[A-Za-z_]/.test(c) && (index === 0 || !/[A-Za-z0-9_.]/.test(text[index - 1]))) {
      const word = /^[A-Za-z_][A-Za-z0-9_\-]*/.exec(text.slice(index))[0];
      const after = skipSpaces(index + word.length);
      if (text[after] === '[') {
        const bracket = readBracket(after);
        if (bracket) { qualified.push({ table: word, name: bracket.name }); tables.add(known.get(word.toLowerCase()) ?? word); index = bracket.next; continue; }
      }
      if (text[after] !== '(' && known.has(word.toLowerCase())) tables.add(known.get(word.toLowerCase()));
      words.push(word);
      index += word.length;
      continue;
    }
    index++;
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

function findReportExtensions(inventory, rootDir) {
  const pbir = inventory.reportDefinitions?.[0];
  if (!pbir) return null;
  const file = path.join(rootDir, path.dirname(pbir), 'definition', 'reportExtensions.json');
  return fs.existsSync(file) ? { file, json: readJson(file) } : null;
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
      for (const item of next.table.calculationGroup?.items ?? []) scanDax(item.expression);
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
    measures: table.measures.filter(measure => measureIds.has(`${table.name}\u0000${measure.name}`)),
    omittedMeasureCount: table.measures.filter(measure => !measureIds.has(`${table.name}\u0000${measure.name}`)).length
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
  const extensions = findReportExtensions(inventory, rootDir);
  const reportFilters = filterDigest(report?.json?.filterConfig?.filters);
  const seeds = fieldsOf([pages, reportFilters], []);
  const files = walk(inputDir);
  const model = loadSemanticModel(files, rootDir);
  if (!model.format) warnings.push('No TMDL or model.bim semantic model definition found under input/.');
  if (model.ignored.length) warnings.push(`Ignored ${model.ignored.join(', ')} because the TMDL definition folder is authoritative.`);
  // Report-level measures (reportExtensions.json) behave like model measures on their entity.
  for (const entity of extensions?.json?.entities ?? []) {
    let table = model.tables.find(item => item.name.toLowerCase() === String(entity.name ?? '').toLowerCase());
    if (!table) { table = { name: entity.name, source: relative(extensions.file), columns: [], measures: [], partitions: [], hierarchies: [], reportLevelOnly: true }; model.tables.push(table); }
    for (const measure of entity.measures ?? []) table.measures.push({ name: measure.name, expression: typeof measure.expression === 'string' ? measure.expression : JSON.stringify(measure.expression ?? ''), ...(measure.formatString ? { formatString: measure.formatString } : {}), reportLevel: true, source: relative(extensions.file) });
  }
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
      // Every File.Contents target; csvOptions mirror Csv.Document (read with helpers.core.readCsvFile).
      files: (inventory.fileSources ?? []).map(({ path: file, referencedBy, reader, available, error, csvOptions }) => ({ path: file, referencedBy, reader, available, ...(error ? { error } : {}), ...(csvOptions ? { csvOptions } : {}) })),
      mParameters: inventory.mParameters ?? {},
      unresolved: inventory.unresolvedSources ?? [],
      otherConnectors: inventory.unsupportedConnectors ?? []
    },
    warnings
  };
}
