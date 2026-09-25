// Pure helpers for reading PBIR visual/page JSON. No file access, no imports,
// so core.mjs and digest.mjs can both depend on them.

const AGGREGATIONS = ['Sum', 'Avg', 'Count', 'Min', 'Max', 'CountNonNull', 'Median', 'StandardDeviation', 'Variance'];

export function literalText(value) {
  if (typeof value !== 'string') return value ?? null;
  const match = /^'([\s\S]*)'$/.exec(value);
  return match ? match[1].replaceAll("''", "'") : value;
}

function sourceEntity(expression, aliases) {
  const ref = expression?.SourceRef;
  if (ref?.Entity) return ref.Entity;
  if (ref?.Source) return aliases?.[ref.Source] ?? ref.Source;
  return null;
}

export function describeField(field, aliases = {}) {
  if (!field || typeof field !== 'object') return null;
  if (field.Column) return { kind: 'column', table: sourceEntity(field.Column.Expression, aliases), name: field.Column.Property };
  if (field.Measure) return { kind: 'measure', table: sourceEntity(field.Measure.Expression, aliases), name: field.Measure.Property };
  if (field.Aggregation) {
    const inner = describeField(field.Aggregation.Expression, aliases) ?? {};
    const code = field.Aggregation.Function;
    return { ...inner, kind: 'aggregation', of: inner.kind ?? null, aggregation: AGGREGATIONS[code] ?? code };
  }
  if (field.HierarchyLevel) {
    const hierarchy = field.HierarchyLevel.Expression?.Hierarchy;
    const variation = hierarchy?.Expression?.PropertyVariationSource;
    const table = sourceEntity(hierarchy?.Expression, aliases) ?? sourceEntity(variation?.Expression, aliases);
    return { kind: 'hierarchyLevel', table, hierarchy: hierarchy?.Hierarchy ?? null, level: field.HierarchyLevel.Level ?? null, ...(variation?.Property ? { name: variation.Property, autoDateHierarchy: true } : {}) };
  }
  if (field.Hierarchy) return { kind: 'hierarchy', table: sourceEntity(field.Hierarchy.Expression, aliases), hierarchy: field.Hierarchy.Hierarchy ?? null };
  const text = JSON.stringify(field);
  return { kind: 'expression', raw: text.length > 1200 ? `${text.slice(0, 1200)}... [truncated; see source file]` : field };
}

export function visualTitle(json) {
  const visual = json?.visual ?? {};
  for (const entry of [visual.visualContainerObjects?.title, visual.objects?.title]) {
    const value = entry?.[0]?.properties?.text?.expr?.Literal?.Value;
    if (typeof value === 'string' && literalText(value)) return literalText(value);
  }
  return json?.visualGroup?.displayName ?? null;
}

export function visualProjections(json) {
  const state = json?.visual?.query?.queryState;
  if (!state || typeof state !== 'object') return {};
  const roles = {};
  for (const [role, bucket] of Object.entries(state)) {
    const projections = Array.isArray(bucket?.projections) ? bucket.projections : [];
    if (!projections.length) continue;
    roles[role] = projections.map(projection => ({
      ...describeField(projection?.field),
      queryRef: projection?.queryRef ?? null,
      ...(projection?.displayName ? { displayName: projection.displayName } : {}),
      ...(projection?.active === false ? { active: false } : {})
    }));
  }
  return roles;
}

// data: bound to model fields, so the backend must answer a query for it.
// decorative: renders without data (textbox, image, shape, button, navigator).
// group: a PBIR visualGroup container; its children are separate visuals.
export function classifyVisual(json) {
  if (json?.visualGroup && !json?.visual) return 'group';
  return Object.keys(visualProjections(json)).length ? 'data' : 'decorative';
}

export function visualType(json) {
  return json?.visual?.visualType ?? json?.visualType ?? (json?.visualGroup ? 'visualGroup' : 'unknown');
}

export function pageIsHidden(json) {
  return json?.visibility === 'HiddenInViewMode';
}
