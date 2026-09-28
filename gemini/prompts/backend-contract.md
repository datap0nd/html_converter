# Contract for the generated report files

The runner checks every point below by executing the files (in a separate checker process, then in the local report server). Anything that breaks the contract is sent back to you as a fix request.

## `output/dynamic/backend.mjs`

```js
export async function createBackend({ env, root, inputDir, helpers }) {
  return { healthcheck, query, close };   // close is optional
}
```

- `env`: the values from the user's private `.env` (for example `PG_USER`, `PG_PASSWORD`, `PG_SSL_MODE`, `PG_ALLOW_NATIVE_QUERIES`). Read settings only from `env`, never from `process.env` or files. Never put secret values in results, errors, or logs.
- `root` is the converter folder and `inputDir` its `input/` folder with the PBIP. Do not read anything under `work/` or `output/`; everything you need from the digest is in `helpers.digest`.
- `helpers` (use these instead of re-implementing them):
  - `helpers.digest`: the report digest (same content as `work/report-digest.json`, but long text such as M, DAX and SQL is a plain string here, not an array of lines).
  - `helpers.inventory`: `{ postgresSources, fileSources, webSources, mParameters }` found in the PBIP.
  - `helpers.postgres.connections`: the PostgreSQL connections of the PBIP. `helpers.postgres.createPool(connection, { max })` returns a `pg.Pool` configured exactly like the runner's successful connection test (host/port overrides from `.env`, TLS and the organization CA file, read-only sessions, timeouts, error handling). Always use it: never build a `pg` config yourself and never read certificate files. Create each pool once in `createBackend` and reuse it.
  - `helpers.loadPg()`: the `pg` module, already configured so NUMERIC/BIGINT arrive as JS numbers and DATE as `'YYYY-MM-DD'` strings.
  - `helpers.core.readCsvFile(path, { delimiter, encoding })` reads a text file the way `Csv.Document` does; take `delimiter` and `encoding` from `helpers.digest.sources.files[].csvOptions`. Also `helpers.core.parseCsv`, `readJson`, `mUnescape`, `resolveMText`, `decodeEnterData`.
  - `helpers.excel.read(path, { item, kind, useHeaders, inferSheetDimensions })` reads one Excel sheet (`kind: 'Sheet'`), table (`'Table'`) or named range (`'DefinedName'`) exactly like `Excel.Workbook` + navigation: `{ columns, rows, warnings }` with rows as objects, numbers as numbers, dates as `'YYYY-MM-DD'` (`'YYYY-MM-DDTHH:MM:SS'` with a time), blanks and error cells as `null`. Take `path` and the items from `helpers.inventory.fileSources[i].excel.items` (each item carries the `useHeaders` of its `Excel.Workbook` call; also pass `useHeaders: true` when the M code's next step is `Table.PromoteHeaders`). `fileSources[i].workbook.items` lists what the file really contains, with header rows. Parse the workbook with this helper only; never import an npm Excel package. The helper caches workbooks, so calling it in every query is cheap. It also accepts the bytes of a workbook (a Buffer) in place of the path, for a workbook downloaded from a plain web URL.
  - `helpers.core.listFolderFiles(folder, { recursive })` lists files the way `Folder.Files` does (`Name`, `Extension`, `Folder Path`, `Date modified`, plus the full `path`); use it for "Combine files" queries (`helpers.inventory.excelWorkbooks` with `origin.kind: 'folder'`), filter it the way the M code does, and read each file with `helpers.excel.read` or `helpers.core.readCsvFile`.
  - A file source with `originalPath` or `originalUrl` is a local copy the user mapped (for example a SharePoint file synced by OneDrive): read `path`, never the URL. `helpers.digest.sources.sourceMap` shows how PBIP locations map to local folders.
  - `helpers.enterData`: decoded "Enter Data" tables by table name, `{ columns, rows, rowCount, truncated }`, each row an array in column order (the digest file shows a placeholder instead of the base64 text).
  - `helpers.sources.postgresNativeQuery(sql, limit, params)` binds `$1..$n` native SQL safely.
- Only Node built-ins and `helpers` are available. Do not import any other npm package, and do not import the converter's scripts by relative path. Small modules of your own may sit next to `backend.mjs` in `output/dynamic/` and be imported as `./name.mjs`.
- `healthcheck()` returns `{ ok: true, sources: [...] }` only if every required source works; otherwise `{ ok: false, issues: ['one plain sentence per problem', ...] }` (missing credential names, unreachable host, unreadable file path, connector without a driver).
- `query({ visualId, filters, limit })` returns `{ rows, columns, placeholder, limitations }`:
  - `rows` is an array of plain objects whose keys are exactly the names in `columns` (an array of strings). Values are JSON-safe: numbers as numbers, dates as ISO strings, no `NaN` or `undefined`.
  - Key each value by the visual's field `queryRef` from the digest (`helpers.digest.pages[].visuals[].fields[<role>][].queryRef`, for example `"Product.Category"`, `"Sales.Total Sales"`, `"Sum(Sales.Quantity)"`): one row per combination of the visual's grouping fields (the columns and hierarchy levels in its Category/Axis/Rows/Columns/Legend/Values roles; for drill hierarchies the active level), one key per field. A card is one row of its measures. Extra keys (labels, sort keys) are allowed. The runner asks Power BI Desktop for the same visual and compares the rows value by value, so these names are required.
  - Values are raw, exactly as Power BI computes them: `0.124` for 12.4 %, numbers never as text, and a measure that is blank in Power BI (DIVIDE by zero, no rows, BLANK()) is `null`, not `0`. Rows whose measures are all blank are left out, as Power BI does. Format only in the HTML.
  - Honour `limit` (the server asks for up to 2000 rows).
  - `filters` is exactly the object your HTML sends. Define its shape once, use it in both files, and document it as `filtersContract` in `work/live-build.json`. `{}` means the report's default filter state (the PBIR filters and saved slicer selections).
  - Up to 4 visuals are queried at the same time. Use one pool (max 4 connections), not a connection per query. Use parameterized SQL, read-only access, bounded queries, and statement timeouts of at most 60 seconds.
  - An unknown `visualId` throws an `Error`. Unsupported semantics return `placeholder: true` with a precise explanation in `limitations`. Never fabricate values.
  - Visuals with role `decorative` need no query; `group` containers need no element.
- `close()` (optional) releases pools and timers.

## `output/dynamic/index.html`

- Inline CSS and JavaScript only; no CDN, remote URL, or telemetry. Plain `<script>` blocks (not modules) so the runner can syntax-check them.
- Every selected page container carries the literal attribute `data-page-id="<exact page id>"` and every visual with role `data` or `decorative` carries `data-visual-id="<exact visual id>"` in the HTML source text (the runner searches the file; attributes created only by JavaScript are not found). Do not add pages that are not in `work/inventory.json`.
- Data comes only from `GET /api/report?visual=<visual id>&filters=<URL-encoded JSON>`. Show a visible error inside a visual whose request fails.
- A visible element with `id="report-status"` says this is an AI reconstruction requiring comparison with Power BI and lists unsupported or unverified behavior.
