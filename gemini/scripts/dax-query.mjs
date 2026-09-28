// The DAX query Power BI runs for a visual, rebuilt from its PBIR definition:
// the visual's fields grouped the way the visual groups them, with the report,
// page and visual filters and the page's saved slicer selections applied.
// Used to ask Power BI Desktop's own engine for the true numbers.
//
// Only translations that are exact are produced. Anything else (relative-date
// filters, visual calculations, subqueries other than Top N, ...) is reported in
// `unsupported`, and the visual (or that one column) is not compared, because a
// wrong "truth" would make Gemini break correct code.
//
//   visualDaxQuery({ visual, page, report, pageVisuals, model, reportMeasures, limit })
//     visual/page/report: parsed visual.json, page.json, report.json
//     pageVisuals: [{ id, json }] of every visual on the page (for slicer selections)
//     model: digest.model (hierarchy levels), reportMeasures: [{ table, name, expression }]
//   -> { dax, groupBy: [{ queryRef }], values: [{ queryRef }], unsupported: [text], filters: n }
//      dax is null when the visual cannot be compared at all.

const AGGREGATE = { 0: 'SUM', 1: 'AVERAGE', 2: 'DISTINCTCOUNT', 3: 'MIN', 4: 'MAX', 5: 'COUNTA', 6: 'MEDIAN' };
const COMPARE = { 0: '==', 1: '>', 2: '>=', 3: '<', 4: '<=' };

export function daxTable(name) {
  return `'${String(name).replaceAll("'", "''")}'`;
}

export function daxColumn(table, column) {
  return `${daxTable(table)}[${String(column).replaceAll(']', ']]')}]`;
}

export function daxString(text) {
  return `"${String(text).replaceAll('"', '""')}"`;
}

// A PBIR literal ('text', 12L, 1.5D, 2.5M, true, null, datetime'...') as DAX.
export function daxLiteral(value) {
  const text = String(value ?? '');
  if (text === 'null') return { dax: 'BLANK()', blank: true };
  if (text === 'true' || text === 'false') return { dax: text === 'true' ? 'TRUE()' : 'FALSE()' };
  let match = /^'((?:[^']|'')*)'$/.exec(text);
  if (match) return { dax: daxString(match[1].replaceAll("''", "'")) };
  match = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[LDM]?$/.exec(text);
  if (match) return { dax: match[1] };
  match = /^datetime'(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?)?'$/.exec(text);
  if (match) {
    const [, y, m, d, hh = '00', mi = '00', ss = '00'] = match;
    const date = `DATE(${Number(y)}, ${Number(m)}, ${Number(d)})`;
    return { dax: hh === '00' && mi === '00' && ss === '00' ? date : `(${date} + TIME(${Number(hh)}, ${Number(mi)}, ${Number(ss)}))` };
  }
  return { unsupported: `literal ${text.slice(0, 40)}` };
}

function aliasesOf(query, inherited = {}) {
  const aliases = { ...inherited };
  for (const item of Array.isArray(query?.From) ? query.From : []) if (item?.Name && item?.Entity) aliases[item.Name] = item.Entity;
  return aliases;
}

function entityOf(expression, aliases) {
  const ref = expression?.SourceRef;
  if (ref?.Entity) return ref.Entity;
  if (ref?.Source) return aliases[ref.Source] ?? null;
  return null;
}

function hierarchyLevelColumn(model, table, hierarchy, level) {
  const found = (model?.tables ?? []).find(item => item.name === table)?.hierarchies?.find(item => item.name === hierarchy)?.levels?.find(item => item.name === level);
  return found?.column ?? null;
}

// A model field as DAX: { kind: 'group' | 'value', dax } or { unsupported }.
export function fieldDax(field, aliases = {}, model = null) {
  if (!field || typeof field !== 'object') return { unsupported: 'empty field' };
  if (field.Column) {
    const table = entityOf(field.Column.Expression, aliases);
    return table ? { kind: 'group', dax: daxColumn(table, field.Column.Property), table } : { unsupported: `column ${field.Column.Property} without a table` };
  }
  if (field.Measure) {
    const table = entityOf(field.Measure.Expression, aliases);
    return table ? { kind: 'value', dax: daxColumn(table, field.Measure.Property) } : { kind: 'value', dax: `[${String(field.Measure.Property).replaceAll(']', ']]')}]` };
  }
  if (field.Aggregation) {
    const inner = fieldDax(field.Aggregation.Expression, aliases, model);
    const fn = AGGREGATE[field.Aggregation.Function];
    if (inner.unsupported) return { ...inner, kind: 'value' };
    if (!fn) return { kind: 'value', unsupported: `aggregation function ${field.Aggregation.Function}` };
    if (inner.kind !== 'group') return { kind: 'value', unsupported: 'aggregation of a non-column' };
    return { kind: 'value', dax: `${fn}(${inner.dax})` };
  }
  if (field.HierarchyLevel) {
    const hierarchy = field.HierarchyLevel.Expression?.Hierarchy;
    const variation = hierarchy?.Expression?.PropertyVariationSource;
    const level = field.HierarchyLevel.Level;
    if (variation) {
      const table = entityOf(variation.Expression, aliases);
      if (!table || !variation.Property || !level) return { kind: 'group', unsupported: 'date hierarchy level' };
      // Auto date/time: the level is a column of the hidden LocalDateTable, as Power BI queries it;
      // without that table in the digest, the column's variation syntax 'Sales'[OrderDate].[Year].
      const target = (model?.tables ?? []).find(item => item.name === table)?.columns?.find(item => item.name === variation.Property)?.variation;
      const localColumn = target ? hierarchyLevelColumn(model, target.table, target.hierarchy, level) : null;
      if (localColumn) return { kind: 'group', dax: daxColumn(target.table, localColumn), table: target.table };
      return { kind: 'group', dax: `${daxColumn(table, variation.Property)}.[${String(level).replaceAll(']', ']]')}]`, table };
    }
    const table = entityOf(hierarchy?.Expression, aliases);
    const column = table ? hierarchyLevelColumn(model, table, hierarchy?.Hierarchy, level) ?? level : null;
    return table && column ? { kind: 'group', dax: daxColumn(table, column), table } : { kind: 'group', unsupported: `hierarchy level ${level}` };
  }
  // A visual calculation is computed on the visual's own rows: it adds a value, not a grouping.
  if (field.NativeVisualCalculation) return { kind: 'value', unsupported: `visual calculation ${field.NativeVisualCalculation.Name ?? ''}`.trim() };
  if (field.Hierarchy) return { kind: 'group', unsupported: 'a whole hierarchy' };
  // Arithmetic, ScopedEval and similar expressions compute a value per row.
  return { kind: 'value', unsupported: `${Object.keys(field)[0] ?? 'unknown'} expression` };
}

// ---------- relative dates ----------
//
// Relative date filters ("in the last 3 months") are stored as DateSpan / DateAdd /
// Now expressions and evaluated with today's local date, as Power BI does. Units:
// 0 day, 2 month, 3 year. Week-based ranges depend on the locale's first day of the
// week, so they are not translated.
const DATE_UNITS = { 0: 'day', 2: 'month', 3: 'year' };

function addUnits(date, amount, unit) {
  const next = new Date(date.getTime());
  if (unit === 'day') next.setDate(next.getDate() + amount);
  else if (unit === 'month') next.setMonth(next.getMonth() + amount);
  else if (unit === 'year') next.setFullYear(next.getFullYear() + amount);
  return next;
}

function startOf(date, unit) {
  if (unit === 'year') return new Date(date.getFullYear(), 0, 1);
  if (unit === 'month') return new Date(date.getFullYear(), date.getMonth(), 1);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dateExpression(expression, now) {
  if (!expression || typeof expression !== 'object') return { unsupported: 'a date expression' };
  if (expression.Now) return { date: new Date(now.getTime()) };
  if (expression.DateAdd) {
    const unit = DATE_UNITS[expression.DateAdd.TimeUnit];
    if (!unit) return { unsupported: `a relative date in unit ${expression.DateAdd.TimeUnit} (weeks or smaller)` };
    const inner = dateExpression(expression.DateAdd.Expression, now);
    return inner.unsupported ? inner : { date: addUnits(inner.date, Number(expression.DateAdd.Amount) || 0, unit) };
  }
  if (expression.DateSpan) {
    const unit = DATE_UNITS[expression.DateSpan.TimeUnit];
    if (!unit) return { unsupported: `a relative date in unit ${expression.DateSpan.TimeUnit} (weeks or smaller)` };
    const inner = dateExpression(expression.DateSpan.Expression, now);
    if (inner.unsupported) return inner;
    const start = startOf(inner.date, unit);
    return { date: start, end: addUnits(start, 1, unit) };
  }
  if (expression.Literal) return { literal: daxLiteral(expression.Literal.Value) };
  return { unsupported: `a ${Object.keys(expression)[0] ?? 'blank'} bound` };
}

function dateDax(date) {
  return `DATE(${date.getFullYear()}, ${date.getMonth() + 1}, ${date.getDate()})`;
}

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// A range bound as DAX: the start of a span for a lower bound, the end (exclusive) for an upper one.
function boundDax(bound, now, upper, relative) {
  if (bound?.Literal) { const literal = daxLiteral(bound.Literal.Value); return literal.unsupported ? literal : { dax: literal.dax, op: upper ? '<=' : '>=' }; }
  const value = dateExpression(bound, now);
  if (value.unsupported) return value;
  if (value.literal) return value.literal.unsupported ? value.literal : { dax: value.literal.dax, op: upper ? '<=' : '>=' };
  const date = upper && value.end ? value.end : value.date;
  relative.push(`${upper ? (value.end ? 'before' : 'up to') : 'from'} ${isoDate(date)}`);
  return { dax: dateDax(date), op: upper ? (value.end ? '<' : '<=') : '>=' };
}

// ---------- filter conditions ----------

// A PBIR filter condition as a DAX boolean over columns (or, for measure
// conditions, over the query's own computed columns [__fN]).
function conditionDax(condition, ctx) {
  const c = condition ?? {};
  if (c.And || c.Or) {
    const part = c.And ?? c.Or;
    const left = conditionDax(part.Left, ctx), right = conditionDax(part.Right, ctx);
    if (left.unsupported || right.unsupported) return { unsupported: left.unsupported ?? right.unsupported };
    return { dax: `(${left.dax}) ${c.And ? '&&' : '||'} (${right.dax})` };
  }
  if (c.Not) {
    const inner = conditionDax(c.Not.Expression, ctx);
    return inner.unsupported ? inner : { dax: `NOT (${inner.dax})` };
  }
  if (c.In) {
    if (!Array.isArray(c.In.Values)) return { unsupported: c.In.Table ? 'a subquery filter' : 'an In filter without values' };
    const fields = (c.In.Expressions ?? []).map(expression => operand(expression, ctx));
    const bad = fields.find(item => item.unsupported);
    if (bad) return bad;
    const rows = [];
    for (const tuple of c.In.Values) {
      const literals = tuple.map(item => item?.Literal ? daxLiteral(item.Literal.Value) : { unsupported: 'a non-literal value' });
      const wrong = literals.find(item => item.unsupported);
      if (wrong) return wrong;
      rows.push(literals.length === 1 ? literals[0].dax : `(${literals.map(item => item.dax).join(', ')})`);
    }
    if (!rows.length) return { dax: 'FALSE()' };
    const target = fields.length === 1 ? fields[0].dax : `(${fields.map(item => item.dax).join(', ')})`;
    return { dax: `${target} IN {${rows.join(', ')}}` };
  }
  if (c.Comparison) {
    const left = operand(c.Comparison.Left, ctx);
    if (left.unsupported) return left;
    const kind = c.Comparison.ComparisonKind;
    if (!c.Comparison.Right?.Literal && (kind === 2 || kind === 1 || kind === 3 || kind === 4)) {
      // A relative date bound: on or after / before a DateSpan.
      const lower = kind === 1 || kind === 2;
      const bound = boundDax(c.Comparison.Right, ctx.now, !lower, ctx.relative);
      if (bound.unsupported) return bound;
      const op = kind === 1 ? '>' : kind === 4 ? bound.op : kind === 3 ? '<' : '>=';
      return { dax: `${left.dax} ${op} ${bound.dax}` };
    }
    const right = c.Comparison.Right?.Literal ? daxLiteral(c.Comparison.Right.Literal.Value) : { unsupported: 'a comparison with a non-literal' };
    if (right.unsupported) return right;
    const op = COMPARE[c.Comparison.ComparisonKind];
    if (!op) return { unsupported: `comparison kind ${c.Comparison.ComparisonKind}` };
    if (right.blank) return op === '==' ? { dax: `ISBLANK(${left.dax})` } : { unsupported: 'an ordering comparison with blank' };
    return { dax: `${left.dax} ${op} ${right.dax}` };
  }
  for (const [key, template] of [['Contains', (l, r) => `CONTAINSSTRING(${l}, ${r})`], ['StartsWith', (l, r) => `LEFT(${l}, LEN(${r})) = ${r}`], ['EndsWith', (l, r) => `RIGHT(${l}, LEN(${r})) = ${r}`]]) {
    if (!c[key]) continue;
    const left = operand(c[key].Left, ctx);
    const right = c[key].Right?.Literal ? daxLiteral(c[key].Right.Literal.Value) : { unsupported: `${key} with a non-literal` };
    if (left.unsupported || right.unsupported) return { unsupported: left.unsupported ?? right.unsupported };
    return { dax: template(left.dax, right.dax) };
  }
  if (c.Between) {
    const value = operand(c.Between.Expression, ctx);
    const low = boundDax(c.Between.LowerBound, ctx.now, false, ctx.relative);
    const high = boundDax(c.Between.UpperBound, ctx.now, true, ctx.relative);
    const wrong = [value, low, high].find(item => item.unsupported);
    if (wrong) return wrong;
    return { dax: `${value.dax} ${low.op} ${low.dax} && ${value.dax} ${high.op} ${high.dax}` };
  }
  return { unsupported: `a ${Object.keys(c)[0] ?? 'blank'} condition` };
}

// A field used inside a condition: a column (grouped by the filter table) or a
// measure/aggregation (evaluated per result row through a hidden [__fN] column).
function operand(expression, ctx) {
  const field = fieldDax(expression, ctx.aliases, ctx.model);
  if (field.unsupported) return field;
  if (field.kind === 'group') { ctx.columns.push(field); return field; }
  ctx.measures = true;
  return { dax: ctx.measureRef(field.dax) };
}

// One filter (report, page, visual, or a slicer's saved selection) as a filter
// table for SUMMARIZECOLUMNS, or a post-filter on the result when it tests measures.
function compileFilter(filter, ctx) {
  const aliases = aliasesOf(filter);
  const where = Array.isArray(filter?.Where) ? filter.Where : [];
  if (!where.length) return null;
  const tables = [], post = [];
  for (const item of where) {
    const local = { aliases, model: ctx.model, columns: [], measures: false, measureRef: ctx.measureRef, now: ctx.now, relative: ctx.relative };
    const top = topNFilter(item.Condition, filter, ctx);
    if (top) { if (top.unsupported) return top; tables.push(top.dax); continue; }
    const condition = conditionDax(item.Condition, local);
    if (condition.unsupported) return condition;
    if (local.measures && local.columns.length) return { unsupported: 'a filter mixing columns and measures' };
    if (local.measures) { post.push(condition.dax); continue; }
    const unique = [...new Map(local.columns.map(column => [column.dax, column])).values()];
    if (!unique.length) continue;
    const tablesUsed = new Set(unique.map(column => column.table));
    const domain = tablesUsed.size === 1 ? `ALL(${unique.map(column => column.dax).join(', ')})` : unique.map(column => `ALL(${column.dax})`).reduce((a, b) => `CROSSJOIN(${a}, ${b})`);
    tables.push(`FILTER(${domain}, ${condition.dax})`);
  }
  return { tables, post };
}

// Top N filter: Where In { Expressions: [column], Table: <subquery> } with
// Subquery { Select: [column], OrderBy: [{ Direction, Expression }], Top: n }.
function topNFilter(condition, filter, ctx) {
  const table = condition?.In?.Table?.SourceRef?.Source;
  if (!table) return null;
  const from = (filter.From ?? []).find(item => item?.Name === table);
  const query = from?.Expression?.Subquery?.Query;
  if (!query) return { unsupported: 'a subquery filter' };
  if (Array.isArray(query.Where) && query.Where.length) return { unsupported: 'a Top N filter with its own conditions' };
  const aliases = aliasesOf(query);
  const selected = fieldDax(query.Select?.[0], aliases, ctx.model);
  const order = query.OrderBy?.[0];
  const by = order ? fieldDax(order.Expression, aliases, ctx.model) : { unsupported: 'Top N without an order' };
  const count = Number(query.Top);
  if (selected.unsupported || selected.kind !== 'group') return { unsupported: 'Top N over a non-column' };
  if (by.unsupported) return by;
  if (!Number.isInteger(count) || count < 1) return { unsupported: 'Top N without a count' };
  // Evaluated under every other filter of the visual, like Power BI does.
  return { dax: `CALCULATETABLE(TOPN(${count}, VALUES(${selected.dax}), ${by.dax}, ${order.Direction === 1 ? 'ASC' : 'DESC'})${ctx.otherFiltersToken})` };
}

// ---------- the visual query ----------

function selectedProjections(bucket) {
  const projections = Array.isArray(bucket?.projections) ? bucket.projections : [];
  // Drill state: when levels are marked, only the active ones are displayed.
  return projections.some(projection => projection && 'active' in projection) ? projections.filter(projection => projection?.active !== false) : projections;
}

function slicerSelection(json) {
  return json?.visual?.objects?.general?.[0]?.properties?.filter?.filter ?? null;
}

export function visualDaxQuery({ visual, page, report, pageVisuals = [], model = null, reportMeasures = [], limit = 2000, now = new Date() }) {
  const unsupported = [];
  const state = visual?.visual?.query?.queryState ?? {};
  const groupBy = [], values = [];
  const seen = new Set();
  for (const bucket of Object.values(state)) {
    for (const projection of selectedProjections(bucket)) {
      const queryRef = projection?.queryRef ?? null;
      if (!queryRef || seen.has(queryRef)) continue;
      seen.add(queryRef);
      const field = fieldDax(projection.field, {}, model);
      if (field.unsupported) {
        unsupported.push(`${queryRef}: ${field.unsupported} (not compared)`);
        // A grouping field that cannot be queried changes every row; a value column is just left out.
        if (field.kind === 'group') groupBy.push({ queryRef, unsupported: true });
        continue;
      }
      (field.kind === 'group' ? groupBy : values).push({ queryRef, dax: field.dax });
    }
  }
  const empty = { dax: null, groupBy, values, unsupported, filters: 0 };
  if (groupBy.some(item => item.unsupported)) return { ...empty, unsupported: [...unsupported, 'a grouping field cannot be translated, so the rows would differ'] };
  if (!groupBy.length && !values.length) return { ...empty, unsupported: [...unsupported, 'no fields to query'] };

  // Filters: report, page, visual, then the saved selections of the page's other slicers.
  const noFilter = new Set((page?.visualInteractions ?? []).filter(item => item?.type === 'NoFilter' && item.target === visual?.name).map(item => item.source));
  const filters = [
    ...(report?.filterConfig?.filters ?? []).map(item => ({ where: 'report filter', filter: item.filter })),
    ...(page?.filterConfig?.filters ?? []).map(item => ({ where: 'page filter', filter: item.filter })),
    ...(visual?.filterConfig?.filters ?? []).map(item => ({ where: `visual filter${item.type === 'TopN' ? ' (Top N)' : ''}`, filter: item.filter, topN: item.type === 'TopN' })),
    ...pageVisuals.filter(item => item.id !== visual?.name && !noFilter.has(item.id)).map(item => ({ where: `slicer ${item.id}`, filter: slicerSelection(item.json) }))
  ].filter(item => item.filter);

  const hidden = [];
  const measureRef = expression => {
    let index = hidden.findIndex(item => item.dax === expression);
    if (index < 0) { hidden.push({ dax: expression }); index = hidden.length - 1; }
    return `[__f${index}]`;
  };
  // Top N filters are evaluated under the visual's other filters, inserted where this token stands.
  const TOKEN = '\u0000OTHER\u0000';
  const compiled = [], relativeDates = [];
  for (const item of filters) {
    const relative = [];
    const result = compileFilter(item.filter, { model, measureRef, otherFiltersToken: TOKEN, now, relative });
    if (!result) continue;
    if (result.unsupported) return { ...empty, unsupported: [...unsupported, `${item.where}: ${result.unsupported}`] };
    compiled.push({ ...item, ...result });
    if (relative.length) relativeDates.push(`${item.where}: ${relative.join(', ')}`);
  }
  const tableArgs = compiled.flatMap(item => item.tables);
  const plainArgs = tableArgs.filter(arg => !arg.includes(TOKEN));
  const args = tableArgs.map(arg => arg.replace(TOKEN, plainArgs.length ? `, ${plainArgs.join(', ')}` : ''));
  const post = compiled.flatMap(item => item.post);

  // Report-level measures (reportExtensions.json) exist only in the report, so the query defines them.
  const lines = [];
  for (const measure of reportMeasures) {
    const ref = daxColumn(measure.table, measure.name);
    if (values.some(item => item.dax === ref) || hidden.some(item => item.dax === ref)) lines.push(`MEASURE ${ref} = ${measure.expression}`);
  }
  const columns = [
    ...groupBy.map(item => item.dax),
    ...args,
    ...values.map((item, index) => `"v${index}", ${item.dax}`),
    ...hidden.map((item, index) => `"__f${index}", ${item.dax}`)
  ];
  let table = `SUMMARIZECOLUMNS(${columns.join(', ')})`;
  if (post.length) table = `FILTER(${table}, ${post.map(item => `(${item})`).join(' && ')})`;
  const dax = `${lines.length ? `DEFINE\n  ${lines.join('\n  ')}\n` : ''}EVALUATE\n  TOPN(${limit + 1}, ${table})`;
  return {
    dax,
    groupBy: groupBy.map(({ queryRef }) => ({ queryRef })),
    values: values.map(({ queryRef }) => ({ queryRef })),
    hiddenColumns: hidden.length,
    unsupported,
    ...(relativeDates.length ? { relativeDates } : {}),
    filters: compiled.length
  };
}
