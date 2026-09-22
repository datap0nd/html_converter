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
    if (source.hasNativeQuery) throw new Error(`PostgreSQL source ${source.server}/${source.database} uses a native query. It is not auto-executed; provide a reviewed export or a supported table/view mapping.`);
    if (!source.tables.length) throw new Error(`PostgreSQL source ${source.server}/${source.database} has no simple table/view navigation. Native queries or parameterized paths are not auto-run; provide a supported mapping or export.`);
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
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw new Error(`PostgreSQL read failed for ${source.server}/${source.database}: ${error.message}`);
    } finally { try { await client.end(); } catch {} }
  }
  return data;
}
