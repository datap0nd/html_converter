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

function inspectNativeSql(sql) {
  const semicolons = [], placeholders = new Set();
  let state = 'code', tag = '', depth = 0, escapeSingle = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], next = sql[i + 1];
    if (state === 'line') { if (c === '\n') state = 'code'; continue; }
    if (state === 'block') {
      if (c === '/' && next === '*') { depth++; i++; }
      else if (c === '*' && next === '/') { if (--depth === 0) state = 'code'; i++; }
      continue;
    }
    if (state === 'dollar') { if (sql.startsWith(tag, i)) { i += tag.length - 1; state = 'code'; } continue; }
    if (state === 'single' || state === 'double') {
      const q = state === 'single' ? "'" : '"';
      if (c === q && next === q) i++;
      else if (c === q) state = 'code';
      else if (c === '\\' && state === 'single' && escapeSingle && next) i++;
      continue;
    }
    if (c === '-' && next === '-') { state = 'line'; i++; }
    else if (c === '/' && next === '*') { state = 'block'; depth = 1; i++; }
    else if (c === "'") { state = 'single'; escapeSingle = /[eE]/.test(sql[i - 1] ?? '') && !/[\w]/.test(sql[i - 2] ?? ''); }
    else if (c === '"') state = 'double';
    else if (c === '$') {
      const dollar = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(i));
      if (dollar) { tag = dollar[0]; state = 'dollar'; i += tag.length - 1; }
      else {
        const placeholder = /^\$([1-9]\d*)(?![\w$])/.exec(sql.slice(i));
        if (placeholder) { placeholders.add(Number(placeholder[1])); i += placeholder[0].length - 1; }
      }
    } else if (c === ';') semicolons.push(i);
  }
  const trimmed = sql.trim();
  const trailingSemicolon = semicolons.length === 1 && semicolons[0] === sql.lastIndexOf(';') && trimmed.endsWith(';');
  if (semicolons.length && !trailingSemicolon) throw new Error('Native PostgreSQL query must contain only one statement.');
  return { statement: trailingSemicolon ? trimmed.slice(0, -1).trim() : trimmed, placeholders };
}

function nativeSql(sql, params) {
  const { statement, placeholders } = inspectNativeSql(sql);
  if (!/^(?:select|with)\b/i.test(statement)) throw new Error('Native PostgreSQL query must start with SELECT or WITH.');
  if (!Array.isArray(params) || params.some(x => x !== null && !['string', 'number', 'boolean'].includes(typeof x) || typeof x === 'number' && !Number.isFinite(x))) {
    throw new Error('Native PostgreSQL parameters must be a JSON array of strings, finite numbers, booleans or null.');
  }
  const count = Math.max(0, ...placeholders);
  if (count > 1000) throw new Error('Native PostgreSQL query has an unreasonable positional parameter number.');
  if (params.length !== count || Array.from({ length: count }, (_, i) => i + 1).some(i => !placeholders.has(i))) {
    throw new Error(`Native PostgreSQL query requires ${count} positional value(s) ($1…$${count}); found ${params.length}. Set PG_NATIVE_QUERY_PARAMS_JSON in gemini/.env for source-# if the PBIP supplies no literal list.`);
  }
  return { statement, values: params };
}

function nativeParameters(query, env, id) {
  let configured;
  if (env.PG_NATIVE_QUERY_PARAMS_JSON) {
    try { configured = JSON.parse(env.PG_NATIVE_QUERY_PARAMS_JSON); }
    catch { throw new Error('PG_NATIVE_QUERY_PARAMS_JSON must be valid JSON.'); }
    if (!configured || Array.isArray(configured) || typeof configured !== 'object') throw new Error('PG_NATIVE_QUERY_PARAMS_JSON must be an object mapping source IDs to arrays.');
  }
  return Object.hasOwn(configured ?? {}, id) ? configured[id] : (query.parameters ?? []);
}

export function postgresNativeQuery(sql, limit, params = []) {
  const { statement, values } = nativeSql(sql, params);
  return { text: `SELECT * FROM (${statement}\n) AS html_converter_source LIMIT $${values.length + 1}`, values: [...values, limit + 1] };
}

function postgresNativePageQuery(sql, limit, offset, params = []) {
  const { statement, values } = nativeSql(sql, params);
  return { text: `SELECT * FROM (${statement}\n) AS html_converter_source LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, values: [...values, limit + 1, offset] };
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

// Actionable advice for the PostgreSQL failures seen on corporate networks.
export function postgresHint(error) {
  const text = `${error?.code ?? ''} ${error?.message ?? error ?? ''}`;
  if (/PG_ALLOW_NATIVE_QUERIES/.test(text)) return 'The report runs its own SQL (Value.NativeQuery). Review that SQL (listed in work/inventory.json under postgresSources), then set PG_ALLOW_NATIVE_QUERIES=true in gemini/.env. It runs read-only.';
  if (/PG_NATIVE_QUERY_PARAMS_JSON/.test(text)) return 'A native SQL query uses $1, $2 ... but the PBIP gives no literal values. Set PG_NATIVE_QUERY_PARAMS_JSON in gemini/.env as shown in .env.example.';
  if (/PG_USER|PG_PASSWORD/.test(text)) return 'Fill PG_USER and PG_PASSWORD in gemini/.env with a read-only login.';
  if (/28P01|password authentication failed/i.test(text)) return 'The database rejected PG_USER/PG_PASSWORD. Check them in gemini/.env (no quotes needed).';
  if (/self[- ]signed|unable to (?:get|verify) (?:local )?issuer|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|CERT_|certificate/i.test(text)) return 'TLS certificate not trusted. Set PG_SSL_CA_FILE in gemini/.env to your organization root CA (.pem/.crt). Use PG_SSL_MODE=disable only if your DBA approves unencrypted connections.';
  if (/does not support SSL|server does not support SSL/i.test(text)) return 'The server does not accept TLS. Set PG_SSL_MODE=disable in gemini/.env only if your DBA approves this.';
  if (/no pg_hba\.conf entry/i.test(text)) return 'The server refused this PC/user (pg_hba.conf). Ask the DBA to allow your login, or check PG_SSL_MODE.';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return 'The database host name could not be resolved. Connect to VPN, or set PG_HOST in gemini/.env.';
  if (/ECONNREFUSED/i.test(text)) return 'Nothing is listening at that host/port. Check PG_HOST/PG_PORT (or the PBIP server name) and VPN.';
  if (/ETIMEDOUT|timeout|ENETUNREACH|EHOSTUNREACH|Connection terminated/i.test(text)) return 'The database did not answer in time. Connect to VPN or check firewall access to the PostgreSQL port.';
  if (/3D000|database .* does not exist/i.test(text)) return 'That database name does not exist. Check PG_DATABASE in gemini/.env or the PBIP source.';
  if (/42501|permission denied/i.test(text)) return 'The login lacks read permission on a required table. Ask the DBA for SELECT access.';
  if (/driver missing|Cannot find (?:package|module) 'pg'/i.test(text)) return 'Run npm install in the gemini folder (setup.ps1 normally does this).';
  return 'Check gemini/.env PostgreSQL settings, VPN, and firewall access.';
}

export async function testPostgresConnection(source, env = {}, options = {}) {
  let Client = options.Client;
  if (!Client) {
    try { Client = (await import('pg')).default.Client; }
    catch { throw new Error('PostgreSQL driver missing. Run npm install in gemini/.'); }
  }
  const config = connectionConfig(source, env);
  const client = new Client({ ...config, connectionTimeoutMillis: options.timeoutMs ?? 15000, query_timeout: options.timeoutMs ?? 15000 });
  const started = Date.now();
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT 1');
    await client.query('COMMIT');
    return { host: config.host, port: config.port, database: config.database, user: config.user, ms: Date.now() - started };
  } catch (error) {
    const wrapped = new Error(`${config.host}:${config.port}/${config.database} as ${config.user}: ${error.message}`);
    wrapped.code = error.code;
    throw wrapped;
  } finally { try { await client.end(); } catch { /* already closed */ } }
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
      const id = `source-${sources.length}`;
      const parameters = nativeParameters(query, env, id);
      try { postgresNativeQuery(query.sql, 1, parameters); }
      catch (error) { throw new Error(`${id} (${query.referencedBy}): ${error.message}`); }
      sources.push({ id, name: `Native query ${index + 1}`, type: 'native', connection, query, parameters });
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
    const request = source.type === 'table'
      ? { text: `SELECT * FROM ${quoteIdentifier(source.table.schema)}.${quoteIdentifier(source.table.item)} LIMIT $1 OFFSET $2`, values: [limit + 1, offset] }
      : postgresNativePageQuery(source.query.sql, limit, offset, source.parameters ?? nativeParameters(source.query, env, source.id));
    const result = await client.query(request);
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
  let sourceIndex = 0;
  for (const source of sources) {
    if (source.hasUnresolvedNativeQuery) throw new Error(`PostgreSQL source ${source.server}/${source.database} has a native query whose target or M parameters cannot be parsed safely. It was not run.`);
    if (!source.tables.length && !source.nativeQueries?.length) throw new Error(`PostgreSQL source ${source.server}/${source.database} has no readable table/view navigation or supported literal native query.`);
    if (source.nativeQueries?.length && env.PG_ALLOW_NATIVE_QUERIES !== 'true') throw new Error(`PostgreSQL source ${source.server}/${source.database} uses native SQL. Review it, then set PG_ALLOW_NATIVE_QUERIES=true in gemini/.env to run it using a read-only login. Later Power Query steps are still not applied.`);
    const client = new Client(connectionConfig(source, env));
    try {
      await client.connect();
      await client.query('BEGIN READ ONLY');
      for (const table of source.tables) {
        sourceIndex++;
        const result = await client.query(postgresQuery(table.schema, table.item, limit));
        if (result.rows.length > limit) throw new Error(`PostgreSQL ${table.schema}.${table.item} exceeds PG_MAX_ROWS=${limit}; stopped instead of producing an incomplete snapshot.`);
        const rows = JSON.parse(JSON.stringify(result.rows, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
        data.datasets.push({
          name: `${table.schema}.${table.item}`, source: `PostgreSQL ${table.schema}.${table.item}`,
          kind: 'raw-postgres-source', columns: result.fields.map(x => x.name), rows
        });
      }
      for (const [index, query] of (source.nativeQueries ?? []).entries()) {
        const params = nativeParameters(query, env, `source-${sourceIndex++}`);
        const result = await client.query(postgresNativeQuery(query.sql, limit, params));
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
