import fs from 'node:fs';
import { loadData } from './core.mjs';

function positiveLimit(value) {
  const limit = Number(value || 50000);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000000) throw new Error('PG_MAX_ROWS must be an integer from 1 to 1000000.');
  return limit;
}

function quoteIdentifier(value) {
  if (!value || value.includes('\0')) throw new Error('Invalid PostgreSQL schema/table name in PBIP.');
  return `"${value.replaceAll('"', '""')}"`;
}

export function postgresQuery(schema, table, limit) {
  return { text: `SELECT * FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)} LIMIT $1`, values: [limit + 1] };
}

export function postgresNativeQuery(sql, limit) {
  const statement = sql.trim().replace(/;\s*$/, '').trim();
  if (!/^(?:select|with)\b/i.test(statement)) throw new Error('Native PostgreSQL query must start with SELECT or WITH.');
  if (statement.includes(';')) throw new Error('Native PostgreSQL query must contain only one statement.');
  if (/\$\d+\b/.test(statement)) throw new Error('Parameterized native PostgreSQL queries are not supported.');
  return { text: `SELECT * FROM (${statement}) AS html_converter_source LIMIT $1`, values: [limit + 1] };
}

function connectionConfig(source, env) {
  if (!env.PG_USER || !env.PG_PASSWORD) throw new Error('PostgreSQL source found. Fill PG_USER and PG_PASSWORD in gemini/.env with a read-only login.');
  const server = env.PG_HOST || source.server;
  const portMatch = /^(.*?):(\d+)$/.exec(server);
  const host = portMatch ? portMatch[1] : server;
  const port = Number(env.PG_PORT || (portMatch ? portMatch[2] : 5432));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PostgreSQL host/port. Check PBIP and gemini/.env.');
  const mode = env.PG_SSL_MODE || 'verify-full';
  if (!['verify-full', 'disable'].includes(mode)) throw new Error('PG_SSL_MODE must be verify-full or disable.');
  const ssl = mode === 'disable' ? false : { rejectUnauthorized: true };
  if (ssl && env.PG_SSL_CA_FILE) ssl.ca = fs.readFileSync(env.PG_SSL_CA_FILE, 'utf8');
  return {
    host, port, database: env.PG_DATABASE || source.database,
    user: env.PG_USER, password: env.PG_PASSWORD, ssl,
    connectionTimeoutMillis: 10000, query_timeout: 60000,
    application_name: 'html_converter_readonly'
  };
}

export function listLiveSources(inventory, env = {}) {
  if (inventory.unsupportedConnectors?.length) {
    throw new Error(`Unsupported connector(s): ${[...new Set(inventory.unsupportedConnectors.map(x => x.connector))].join(', ')}. A live run cannot silently omit them.`);
  }
  const sources = [];
  for (const connection of inventory.postgresSources ?? []) {
    if (connection.hasUnresolvedNativeQuery) throw new Error(`Cannot safely parse a native query in ${connection.server}/${connection.database}.`);
    for (const table of connection.tables) sources.push({ id: `source-${sources.length}`, name: `${table.schema}.${table.item}`, type: 'table', connection, table });
    for (const [index, query] of (connection.nativeQueries ?? []).entries()) {
      if (env.PG_ALLOW_NATIVE_QUERIES !== 'true') throw new Error('PBIP contains native PostgreSQL SQL. Review it and set PG_ALLOW_NATIVE_QUERIES=true in gemini/.env.');
      postgresNativeQuery(query.sql, 1);
      sources.push({ id: `source-${sources.length}`, name: `Native query ${index + 1}`, type: 'native', connection, query });
    }
  }
  if (!sources.length) throw new Error('No supported PostgreSQL table or literal native query found in the PBIP. This live path currently supports PostgreSQL only.');
  return sources;
}

export async function fetchLivePage(source, env = {}, { limit = 100, offset = 0 } = {}, options = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Live page limit must be 1–200.');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000000) throw new Error('Invalid live page offset.');
  let Client = options.Client;
  if (!Client) {
    try { Client = (await import('pg')).default.Client; }
    catch { throw new Error('PostgreSQL driver missing. Run npm install in gemini/.'); }
  }
  const client = new Client(connectionConfig(source.connection, env));
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    const base = source.type === 'table'
      ? `${quoteIdentifier(source.table.schema)}.${quoteIdentifier(source.table.item)}`
      : `(${source.query.sql.trim().replace(/;\s*$/, '').trim()}) AS html_converter_source`;
    const result = await client.query({ text: `SELECT * FROM ${base} LIMIT $1 OFFSET $2`, values: [limit + 1, offset] });
    await client.query('COMMIT');
    const rows = JSON.parse(JSON.stringify(result.rows.slice(0, limit), (_key, value) => typeof value === 'bigint' ? value.toString() : value));
    return { id: source.id, name: source.name, columns: result.fields.map(x => x.name), rows, offset, limit, hasMore: result.rows.length > limit, fidelity: 'raw-source-not-power-query-or-dax' };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw new Error(`Live PostgreSQL read failed for ${source.name}: ${error.message}`);
  } finally { try { await client.end(); } catch {} }
}

export async function loadAllData(inventory, env = {}, options = {}) {
  if (inventory.unsupportedConnectors?.length) {
    const names = [...new Set(inventory.unsupportedConnectors.map(x => x.connector))].join(', ');
    throw new Error(`Unsupported source connector(s): ${names}. Refusing a partial data refresh.`);
  }
  if (inventory.directCsvSources?.some(x => !x.available)) throw new Error('A PBIP-referenced CSV path is no longer readable; refusing a partial data refresh.');
  const data = loadData(inventory);
  const sources = inventory.postgresSources ?? [];
  if (!sources.length) return data;
  let Client = options.Client;
  if (!Client) {
    try { Client = (await import('pg')).default.Client; }
    catch { throw new Error('PostgreSQL source found but the pg driver is missing. Run npm install once in gemini/.'); }
  }
  const limit = positiveLimit(env.PG_MAX_ROWS);
  for (const source of sources) {
    if (source.hasUnresolvedNativeQuery) throw new Error(`PostgreSQL source ${source.server}/${source.database} has a native query that cannot be parsed as literal SQL with null parameters. It was not run.`);
    if (!source.tables.length && !source.nativeQueries?.length) throw new Error(`PostgreSQL source ${source.server}/${source.database} has no readable table/view navigation or supported literal native query.`);
    if (source.nativeQueries?.length && env.PG_ALLOW_NATIVE_QUERIES !== 'true') throw new Error(`PostgreSQL source ${source.server}/${source.database} uses native SQL. Review it, then set PG_ALLOW_NATIVE_QUERIES=true in gemini/.env to run it using a read-only login. Later Power Query steps are still not applied.`);
    const client = new Client(connectionConfig(source, env));
    try {
      await client.connect();
      await client.query('BEGIN READ ONLY');
      for (const table of source.tables) {
        const result = await client.query(postgresQuery(table.schema, table.item, limit));
        if (result.rows.length > limit) throw new Error(`PostgreSQL ${table.schema}.${table.item} exceeds PG_MAX_ROWS=${limit}; stopped instead of producing an incomplete snapshot.`);
        const rows = JSON.parse(JSON.stringify(result.rows, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
        data.datasets.push({
          name: `${table.schema}.${table.item}`, source: `PostgreSQL ${table.schema}.${table.item}`,
          kind: 'raw-postgres-source', columns: result.fields.map(x => x.name), rows
        });
      }
      for (const [index, query] of (source.nativeQueries ?? []).entries()) {
        const result = await client.query(postgresNativeQuery(query.sql, limit));
        if (result.rows.length > limit) throw new Error(`PostgreSQL native query ${index + 1} exceeds PG_MAX_ROWS=${limit}; stopped instead of producing an incomplete snapshot.`);
        const rows = JSON.parse(JSON.stringify(result.rows, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
        data.datasets.push({
          name: `Native query ${index + 1}`, source: `PostgreSQL native query in ${query.referencedBy}`,
          kind: 'raw-postgres-native-query', columns: result.fields.map(x => x.name), rows
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw new Error(`PostgreSQL read failed for ${source.server}/${source.database}: ${error.message}`);
    } finally { try { await client.end(); } catch {} }
  }
  return data;
}
