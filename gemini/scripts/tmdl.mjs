// Minimal TMDL (Tabular Model Definition Language) reader. It understands the
// structure Power BI Desktop writes: indentation-scoped declarations
// ("table Sales", "measure 'Total' = ..."), nameless blocks ("calculationGroup"),
// properties ("dataType: int64"), bare flags ("isHidden"), multi-line and
// ``` fenced expressions, and /// descriptions. Nothing is executed.

export function lineIndent(line) {
  let depth = 0, index = 0;
  while (index < line.length) {
    if (line[index] === '\t') { depth++; index++; }
    else if (line.startsWith('    ', index)) { depth++; index += 4; }
    else break;
  }
  return { depth, rest: line.slice(index) };
}

const DECLARATIONS = new Set(['model', 'database', 'table', 'column', 'measure', 'partition', 'hierarchy', 'level', 'relationship', 'expression', 'calculationGroup', 'calculationItem', 'annotation', 'extendedProperty', 'variation', 'perspective', 'perspectiveTable', 'perspectiveColumn', 'perspectiveMeasure', 'perspectiveHierarchy', 'role', 'tablePermission', 'columnPermission', 'culture', 'cultureInfo', 'linguisticMetadata', 'dataSource', 'queryGroup', 'formatStringDefinition', 'detailRowsDefinition', 'changedProperty', 'dataAccessOptions', 'function', 'calendar', 'alternateOf', 'refreshPolicy']);

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
  return match ? { name: match[1], rest: match[2] } : { name: '', rest: source };
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
      const opening = inline.slice(3);
      const close = opening.indexOf('```');
      if (close >= 0) return opening.slice(0, close).trim();
      const block = [opening];
      while (cursor < lines.length) {
        const line = lines[cursor++];
        const end = line.indexOf('```');
        if (end >= 0) { block.push(line.slice(0, end)); break; }
        block.push(line);
      }
      return dedent(block);
    }
    const block = [];
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
      const declaration = /^(ref\s+)?([A-Za-z][A-Za-z0-9]*)(?:\s+([\s\S]+))?$/.exec(rest.trimEnd());
      if (declaration && DECLARATIONS.has(declaration[2]) && !/^\s*:/.test(declaration[3] ?? '')) {
        cursor++;
        const { name, rest: after } = declaration[3] ? parseTmdlName(declaration[3]) : { name: '', rest: '' };
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
      cursor++;
      // A bare word is a boolean flag such as isHidden or isKey.
      if (/^[A-Za-z][A-Za-z0-9]*$/.test(rest.trim())) { props[rest.trim()] = 'true'; continue; }
      const property = /^([A-Za-z][A-Za-z0-9]*)\s*(:|=)\s*([\s\S]*)$/.exec(rest);
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

// Every Power Query (M) expression in a TMDL file, one entry per partition or
// shared expression, so connector scans never mix two queries' text.
export function tmdlMExpressions(text) {
  const found = [];
  const visit = (nodes, owner) => {
    for (const node of nodes) {
      if (node.kind === 'partition') {
        const source = node.props.source ?? node.props.expression ?? node.props.query;
        const type = String(node.value ?? '').trim().toLowerCase();
        if (source && type !== 'calculated' && type !== 'calculationgroup') found.push({ kind: 'partition', name: owner ?? node.name, text: source });
      } else if (node.kind === 'expression' && node.value) {
        found.push({ kind: 'expression', name: node.name, text: node.value });
      }
      if (node.children?.length) visit(node.children, node.kind === 'table' ? node.name : owner);
    }
  };
  visit(parseTmdl(text), null);
  return found;
}

// Literal text of an M parameter such as: "pg-host:5432" meta [IsParameterQuery=true, ...]
export function mParameterLiteral(expression) {
  const match = /^\s*"((?:[^"]|"")*)"\s*(?:meta\s*\[[\s\S]*\])?\s*$/.exec(String(expression ?? ''));
  return match ? match[1].replaceAll('""', '"') : null;
}
