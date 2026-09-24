# html_converter — PBIP to live HTML attempt

Put one complete PBIP project (`*.pbip` plus its `.Report` and `.SemanticModel` folders) in `input/`. From `gemini/`, run:

```powershell
.\setup.ps1
```

That one command updates the code from GitHub, preserves your `input/`, `.env`, `output/`, `work/`, and logs, installs the checked-in Node dependencies, then runs the converter. The stable `setup.ps1` launcher does not need routine edits; the downloaded `live-setup.ps1` and the npm `start` command control the current workflow. If the window closes, `logs/latest.txt` names the persistent setup log. Stop a previous server with Ctrl+C before starting another.

The workflow is pinned to `gemini-3.8-flash`; a `GEMINI_MODEL` value left in an existing `.env` is ignored.

The converter scans the PBIP, runs Gemini CLI interpretation, build, and independent review phases, and generates `output/dynamic/index.html` plus a source-specific local `output/dynamic/backend.mjs`. If page/visual coverage is incomplete, it asks Gemini to repair the missing visuals in batches of up to eight, then runs a final independent review. It checks source health and calls every visual endpoint before serving the report at `http://127.0.0.1:8765/`. These checks do not prove that the generated source logic is correct. `npm run preflight` checks PBIP structure without Gemini or source access. The old PostgreSQL table browser is available separately as `npm run live-preview`; it is not the report converter. The older static export path remains `npm run convert` but is not the default.

Progress is saved in `work/live-state.json`. Re-running the same `setup.ps1` with an unchanged PBIP reuses completed phases and already repaired visuals; it retries the incomplete phase or page batch. The runner can adopt artifacts from a pre-checkpoint run when its saved inventory matches. Changing the PBIP definitions invalidates the checkpoint and starts a new conversion. To deliberately restart from the beginning, run `node scripts/start-live-report.mjs --fresh` from `gemini/`. Source health and visual endpoint checks always run again, since the live data may have changed. Logs for each attempt remain under `work/live-run-*/`; setup logs are named in `logs/latest.txt`.

Gemini `429`, `RESOURCE_EXHAUSTED`, rate-limit, and temporary model-capacity failures are retried up to five times with bounded exponential backoff. Every retry starts from the last saved output rather than retaining a partially edited failed attempt. If the provider remains unavailable, setup stops while preserving the checkpoint, and a later `setup.ps1` run resumes the same unfinished page batch. A terminal color-support warning is cosmetic and does not affect conversion.

The runner intends to keep `.env` credentials in the **local Node backend**, not the HTML; it scans generated HTML for known secrets. AI-generated code still requires security review. Private files and SQL databases require a backend while the report is live. An HTML file opened directly or hosted on GitHub Pages cannot maintain private network/SQL connections. For remote hosting you need an approved, authenticated backend with access to those sources. The generated HTML is a review artifact, not a standalone static snapshot.

## What Gemini can and cannot guarantee

Gemini reads the report definitions in a temporary workspace that excludes `.env` and data exports, then generates replacement code for the connectors, Power Query transformations, DAX-like calculations, relationships, filters, and visuals it can reconstruct. It must flag unsupported parts and cannot fabricate data. The runner refuses a review marked `blocked`, missing pages/visuals, broken source connections, or nonworking visual endpoints. Results and limitations are written to `work/live-interpretation.json`, `work/live-build.json`, `work/live-review.json`, `work/live-preflight.json`, and `work/live-validation.json`.

This is **not a universal exact Power BI clone**. The phased runner and checkpoints apply generically to enhanced PBIR reports, but connector support, calculations, custom visuals, and fidelity still depend on each report. A PBIP contains report/model definitions but not necessarily imported rows, connector credentials, a Power Query/DAX execution engine, proprietary custom visual code, or every service feature. Reports with unsupported connectors or missing credentials stop with an explicit limitation; the runner cannot solve those automatically. Gemini CLI runs locally but the selected Gemini model is a cloud service: report definitions passed to it may leave your PC. Check your organization's data-use policy before running it with confidential PBIP files. Do not put credentials in PBIP files, prompts, HTML, or this public repository.

The generated backend is AI-written code. The independent review and automated checks reduce errors but cannot prove security or parity with Power BI. Compare representative totals, slicer behavior, page layouts, and visual results in Power BI before relying on or distributing the HTML. If a connector needs a driver or credential that is unavailable, the run stops and reports that need; it does not silently switch to a different source.

## Credentials and source access

The first run creates private `gemini/.env` from `.env.example`. Network files normally use the Windows identity running the converter. SQL sources need their own read-only credentials and drivers. The current checked-in driver is `pg` for PostgreSQL; other SQL connectors may require an approved driver to be added to the repo. `PG_USER`, `PG_PASSWORD`, and the other PostgreSQL settings in `.env.example` apply only when the PBIP actually uses PostgreSQL. A different connector should never be mapped to PostgreSQL as a shortcut.

`input/`, `output/`, `work/`, `logs/`, and `.env` are Git-ignored. Do not force-add them to this public repository. The server listens only on `127.0.0.1` and must be stopped with Ctrl+C when finished.
