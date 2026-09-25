# html_converter — PBIP to live HTML attempt

Put one complete PBIP project (`*.pbip` plus its `.Report` and `.SemanticModel` folders) in `input/`. From `gemini/`, run:

```powershell
.\setup.ps1
```

That one command updates the code from GitHub, preserves your `input/`, `.env`, `output/`, `work/`, and logs, installs the checked-in Node dependencies, then runs the converter. The stable `setup.ps1` launcher does not need routine edits; the downloaded `live-setup.ps1` controls the current workflow. Stop a previous server with Ctrl+C before starting another (if you forget, the new server moves to the next free port and prints its address).

The first question offers three choices:

- `1` (default): convert the first two report pages end to end. Hidden tooltip/drillthrough pages and empty pages are skipped when choosing them. The test is fully isolated: its output is `output/first-2-pages/dynamic/` and its checkpoints are under `work/scopes/first-2-pages/`, so it cannot overwrite or reset a full-report conversion.
- `2`: convert all report pages (`output/dynamic/`, `work/live-state.json`).
- `3`: **self-test this PC**. It runs the real converter with your Node.js and your installed Gemini CLI against a local mock of the Gemini API and a generic test report. It uses no Gemini quota, no sign-in, and none of your report data, and takes about a minute. Run it after updating Node.js or Gemini CLI, or whenever something fails in a way the message below does not explain. `npm run selftest` does the same.

## What you see while it runs

Every line is printed as it happens and saved to `logs/converter-<date>-<pid>.log` (`logs/latest-converter-log.txt` names the newest). When something fails, send that one file. Each Gemini phase narrates what Gemini is doing, for example:

```
12:03:13 [01-interpret] Attempt 1 of 4: Gemini gemini-3.8-flash running. Live transcript: work/.../01-interpret.attempt-1.events.jsonl
12:03:14 [01-interpret] Gemini session started (model gemini-3.8-flash).
12:03:15 [01-interpret] read_file work/report-digest.json
12:04:41 [01-interpret] write_file work/live-interpretation.json (18.2 KB)
12:04:42 [01-interpret] Gemini finished: success, 6 tool call(s), 81k input / 9k output tokens.
```

Gemini CLI's own API retries (HTTP 429/503, network errors) appear as `Gemini API request failed; Gemini CLI is retrying on its own`. If Gemini is silent for a minute, a `Waiting for Gemini` line says how long and what it did last; silence is normal while it writes a large file. The raw event stream, stderr, and a Gemini debug log for every attempt are kept under `work/.../live-run-*/`.

## How a run works

1. **Scan and digest.** The runner reads the PBIR pages and visuals (data, decorative, or group), the TMDL or `model.bim` semantic model, Power Query sources (including literal M parameters), and writes `work/.../report-digest.json`: the selected pages, visuals, field bindings, filters, and only the model tables, measures, calculation groups, relationships, and Power Query code those visuals use. Gemini starts from this one file instead of opening every definition file.
2. **Preflight.** Before any Gemini call it checks Node.js, that Gemini CLI is installed, that the semantic model folder is present, that file sources used by the selected pages are readable, that the PostgreSQL login works (and that native SQL was explicitly allowed), and that no selected page needs a connector with no available driver (SQL Server, Oracle, Excel, SharePoint, ...). Each stop explains what to do.
3. **Gemini phases**, each in a fresh headless Gemini CLI process inside a temporary copy of the definitions (never `.env`, data exports, Desktop caches, or culture files): interpret, build (`output/.../index.html` plus a local `backend.mjs`), and an independent review.
4. **Self-check.** The runner itself executes the generated backend: syntax, import, source healthcheck, and a query for every data visual. Code errors, a blocked review, or missing visual markup are sent back to Gemini in focused fix or repair phases (bounded, with a final independent review), instead of failing the run.
5. **Serve** the report on `http://127.0.0.1:8765/` (or the next free port).

Gemini CLI is launched the way its headless mode is verified to work (checked against Gemini CLI 0.61.0): a single process that the runner can stop cleanly, workspace trust through `GEMINI_CLI_TRUST_WORKSPACE`, only file tools (read, list, search, write, replace; no shell, web, subagents, plan mode, or MCP servers), `NO_BROWSER` so an expired sign-in fails fast instead of waiting for a `[Y/n]` answer, and no terminal-colour warnings. Older CLIs that lack `--output-format stream-json` still work, without live narration.

A phase attempt stops when Gemini produces no output for 8 minutes (10 for all pages) or runs for 20 minutes (35), and a phase has 40 minutes (90) in total. If Gemini already wrote every required file when an attempt is stopped, those files are used. Raise the limits in `.env` with `GEMINI_IDLE_TIMEOUT_MINUTES`, `GEMINI_ATTEMPT_TIMEOUT_MINUTES`, and `GEMINI_PHASE_BUDGET_MINUTES` if your reports are very large.

Progress is saved in `work/.../live-state.json`. Re-running `setup.ps1` with an unchanged PBIP and page selection reuses completed phases and repaired visuals, rechecks the saved backend before spending another Gemini phase, and retries only what is unfinished. Changing the PBIP definitions, the selected pages, or updating to a converter with a new checkpoint format starts that scope fresh. To restart deliberately, run `node scripts/start-live-report.mjs --fresh` (add `--page-limit 2` for the test scope). `npm run preflight` runs the scan and preflight checks without Gemini.

## When it stops

The last lines always say `CONVERSION STOPPED at <step>: <reason>`, then `What to do:`, then the log file. The common cases:

| Message | What to do |
|---|---|
| Gemini CLI is waiting for an interactive answer / could not authenticate (exit 41) | Open PowerShell, run `gemini`, finish the Google sign-in (or set `GEMINI_API_KEY`), type `/quit`, rerun setup. Completed phases are kept. |
| Gemini CLI was not found | `npm install -g @google/gemini-cli`, open a new PowerShell window, run `gemini` once to sign in. |
| A Gemini CLI settings file is invalid (exit 52) | Fix `%USERPROFILE%\.gemini\settings.json`; save it as UTF-8 **without** BOM (Windows PowerShell 5.1 `Set-Content -Encoding UTF8` adds one). |
| Gemini CLI does not trust the corporate proxy certificate | In the same PowerShell window: `$env:NODE_EXTRA_CA_CERTS = "C:\path\to\corporate-root-ca.pem"` (ask IT), then rerun. Behind a proxy also set `$env:HTTPS_PROXY`. |
| The pinned model is not available | `npm install -g @google/gemini-cli@latest`; check the account can use `gemini-3.8-flash`. |
| Gemini stopped making progress | Rerun; it resumes at that phase. Raise the timeouts in `.env` if it repeats. |
| Cannot connect to PostgreSQL ... | The hint names the cause: wrong `PG_USER`/`PG_PASSWORD`, VPN/firewall, unknown host, TLS (`PG_SSL_CA_FILE` or, only if your DBA approves, `PG_SSL_MODE=disable`). |
| The report runs its own SQL (Value.NativeQuery) | Review the SQL in `work/inventory.json`, then set `PG_ALLOW_NATIVE_QUERIES=true`. |
| The selected pages read file(s) this PC cannot open | Connect to VPN / the share; check the path (or the M parameter holding its folder). |
| ... connector(s) this converter has no driver for | Choose pages that use PostgreSQL or files, or set `HC_ALLOW_UNSUPPORTED_CONNECTORS=true` to build anyway with labeled placeholders. |
| The report points to a semantic model folder that is not in gemini/input | Copy the `.pbip` file with both the `.Report` and `.SemanticModel` folders. |
| No enhanced PBIR pages/visuals found | In Power BI Desktop enable the PBIR preview feature (File > Options > Preview features), save as `.pbip` again. |
| The independent Gemini review still blocks the report | Read the named review file. Rerun for another fix round, or set `HC_ALLOW_BLOCKED_REVIEW=true` to open it anyway for manual comparison. |

## What Gemini can and cannot guarantee

Gemini generates replacement code for the connectors, Power Query transformations, DAX-like calculations, relationships, filters, and visuals it can reconstruct. It must flag unsupported parts and cannot fabricate data. Visuals it cannot reconstruct are served as explicit, labeled placeholders and listed at the end of the run. Results and limitations are written to `work/.../live-interpretation.json`, `live-build.json`, `live-review.json` (and `live-final-review.json` after repairs), `live-selfcheck.json`, `live-preflight.json`, and `live-validation.json`.

This is **not a universal exact Power BI clone**. A PBIP contains report/model definitions but not necessarily imported rows, connector credentials, a Power Query/DAX execution engine, proprietary custom visual code, or every service feature. Gemini CLI runs locally but the selected Gemini model is a cloud service: report definitions passed to it may leave your PC. Check your organization's data-use policy before running it with confidential PBIP files. Do not put credentials in PBIP files, prompts, HTML, or this public repository.

The generated backend is AI-written code. The independent review and automated checks reduce errors but cannot prove security or parity with Power BI. Compare representative totals, slicer behavior, page layouts, and visual results in Power BI before relying on or distributing the HTML. The HTML is a review artifact served by the local backend, not a standalone static snapshot; private files and SQL databases need that backend while the report is live.

## Credentials and source access

The first run creates private `gemini/.env` from `.env.example`. Network files normally use the Windows identity running the converter. The checked-in SQL driver is `pg` for PostgreSQL; `PG_*` settings apply only when the PBIP actually uses PostgreSQL. A different connector is never mapped to PostgreSQL as a shortcut. Gemini never receives `.env`; the runner passes its values only to the generated backend, keeps them out of every log line, and scans the HTML for them.

`input/`, `output/`, `work/`, `logs/`, and `.env` are Git-ignored. Do not force-add them to this public repository. The server listens only on `127.0.0.1` and must be stopped with Ctrl+C when finished.

## Tests

`npm test` runs the unit, fixture, and end-to-end tests. `tests/fixtures/` holds generic PBIP projects modelled on what Power BI Desktop saves (CSV, PostgreSQL with native SQL, edge cases, a legacy report, a thin report) with expected results. End-to-end tests drive the real entry point with a fake Gemini CLI that injects stalls, sign-in prompts, rate limits, broken backends, missing visuals, and blocked reviews. Optional: set `HC_TEST_GEMINI_BUNDLE` to an installed `@google/gemini-cli/bundle/gemini.js` to run the real CLI offline against the mock API, and `HC_TEST_PG=host:port:user:password` for a PostgreSQL seeded with `tests/fixtures/data/salespostgres-seed.sql`.

The older PostgreSQL table browser remains `npm run live-preview` and the static export path `npm run convert`; neither is the default.
