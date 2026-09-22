# html_converter — live first

Put one complete PBIP project (`*.pbip` plus its `.Report` and `.SemanticModel` folders) in `input/`. From this `gemini/` directory, use the updater/launcher:

```powershell
.\setup.ps1
```

`setup.ps1` is a stable launcher. It fetches the current `live-setup.ps1` from GitHub and executes it; the launcher itself is excluded from future code merges. An older installed `setup.ps1` may replace itself **once** to migrate to this design. After that, routine updates change only the live script and other code. `live-setup.ps1` downloads the latest repo archive using the data-governance public-repo method (commit lookup, ten PowerShell retries, then Edge), merges it into `gemini/`, installs Node dependencies only when needed, and runs `npm start`. Stop any previous converter server with Ctrl+C before running setup again. It preserves `.env`, `input/`, `output/`, `work/`, `logs/`, and `node_modules/`, without requiring Administrator. If archive downloads are blocked, obtain a repo ZIP through an approved route and run `.\setup.ps1 -ArchivePath C:\path\to\html_converter.zip`. For update only, use `-NoRun`.

Every invocation writes a persistent log in `gemini/logs/`. `gemini/logs/latest.txt` contains the full path to the newest log. The launcher shows the log path and waits for Enter before closing, even if setup fails; use `-NoPause` only for unattended runs. If it has already closed, open that log instead of rerunning blindly. Logs are local and Git-ignored; check them before sharing because they may contain internal hostnames or error details.

On first run, the tool creates `.env` and may stop for credentials. Fill `PG_USER` and `PG_PASSWORD` with a **read-only PostgreSQL login**. If the PBIP contains `Value.NativeQuery`, inspect that query and set `PG_ALLOW_NATIVE_QUERIES=true`. Then rerun `.\setup.ps1` and open `http://127.0.0.1:8765/`. Node.js 20+ and access to your PostgreSQL server are required. `npm run preflight` tests each detected source with a one-row query and does not invoke Gemini. You can run `npm start` directly after setup when you do not need to check for updates.

Native SQL `$1`, `$2`, … placeholders are now bound safely. A literal Power Query M positional list such as `Value.NativeQuery(..., "select $1::text", {"MENA"}, ...)` is picked up automatically. If the PBIP has placeholders but passes `null` instead, the values are *not* recoverable from the PBIP; set `PG_NATIVE_QUERY_PARAMS_JSON='{"source-0":["MENA"]}'` in the private `.env`, using the actual `source-#` ID shown by the error/source picker. Never put SQL parameter values in the public repository or HTML. Computed M parameter expressions and record/named parameters are not yet supported. The converter stops rather than inventing values.

The live page is written to `output/dynamic/index.html`, but **open it through the local server**, not as a `file://` page. The browser requests 100 rows at a time from a local Node server. The server reads `.env`, connects to PostgreSQL, and sends only the requested page of results. Passwords are never embedded in HTML or sent to the browser. Refresh queries the source again. This path does not require Power BI Desktop, DAX Studio, Fabric, or a full model export, so it avoids the previous 253 MB JSON/string-size failure.

## What is live now—and what is not

This is a **live PostgreSQL source preview**, not yet a faithful Power BI report conversion. It can discover a simple PostgreSQL table/view navigation or a literal `Value.NativeQuery(PostgreSQL.Database(...), "SQL", null or a simple positional list, ...)` in the PBIP and run it in a read-only transaction. It displays the actual report page names and visual metadata, but visual mapping is still pending. The table browser has pagination; it does not yet recreate report slicers, cross-filtering, or visuals.

The PBIP is a *definition* of the model, not a general-purpose runtime for Power Query M or DAX. The SQL text inside `Value.NativeQuery` can be sent to PostgreSQL. The M operations **after** that SQL—such as `Table.AddColumn`, `Table.RenameColumns`, and `Table.NestedJoin` with another model table—still need to be translated or executed by a Power Query engine. Model relationships and DAX measures also need their own implementation and validation. The current source preview does not quietly treat raw SQL results as finished Power BI model rows.

For the report discussed here, a faithful live report will require at least: the native SQL result, the later M transformations including the Brand Colors merge, the model relationships, and the DAX/visual queries used on each page. Those are separate pieces of work. No universal promise is made for all PBIP reports or connectors. If an unsupported connector is found, this live path stops rather than showing an apparently complete but partial report.

## Security and deployment

`input/`, `output/`, `work/`, and `.env` are Git-ignored. Do not force-add them to this public repository. Use a database account with only the necessary SELECT permissions; a read-only transaction is an additional safeguard, not a replacement for database permissions. `PG_SSL_MODE=verify-full` is the default; configure `PG_SSL_CA_FILE` if your organization uses its own certificate authority. The server listens only on `127.0.0.1`.

GitHub Pages can host static HTML but cannot run this Node server or read a private `.env`/PostgreSQL connection. A remotely hosted live version would need a separately hosted, authenticated backend with approved network access. Do not put credentials into the HTML or publish report data to a public Pages site.

## Optional legacy snapshot workflow

`npm run convert` runs the older Desktop-model export, Gemini reconstruction, and static snapshot sequence. It is **secondary** and still has a 200 MB default export limit; it is not the solution to the large-model error. `npm run convert-preflight` checks that path. `npm run snapshot` rebuilds the static HTML from its dynamic output. The static output embeds data and should not be shared publicly without data review.
