# html_converter

Place one Power BI Desktop project (`*.pbip` and its neighboring `.Report` / `.SemanticModel` folders) in `input/`. Then, from this `gemini/` directory, run:

```powershell
npm start
```

You need Node.js 20+, Power BI Desktop, [DAX Studio](https://daxstudio.org/), and an installed, authenticated [Gemini CLI](https://geminicli.com/docs/get-started/). The runner uses `gemini-3.5-flash` by default; set the `GEMINI_MODEL` environment variable if your CLI account needs a different model. It starts each phase in a fresh headless Gemini session, so there is no manual `/clear` step or chat to babysit. If the folder-trust/auth setup is not complete, do that once in Gemini CLI before running this workflow.

Open `output/static/report.html` directly in a browser. To review the dynamic version, run `npm run preview` and open the localhost address it prints. By default the local preview server re-exports the currently loaded Desktop model on each data request. After refreshing the model in Power BI Desktop, run `npm run snapshot` to rebuild the standalone file without rerunning Gemini. The static file embeds its data and makes no runtime requests. `work/` holds the inventory, agent notes, logs, and final checks.

## Input

```text
gemini/
  input/
    MyReport.pbip
    MyReport.Report/...
    MyReport.SemanticModel/...
    data/                   # optional manual exports
      sales.csv             # optional CSV or JSON exports you are permitted to use
```

The PBIP/PBIR report definition describes pages, visuals, and semantic-model connections, but does **not** guarantee underlying rows. The default route opens or connects to this PBIP in Power BI Desktop and uses [DAX Studio's `dscmd export csv`](https://daxstudio.org/docs/features/command-line/commands/export-csv-command/) to export the finished model tables. This avoids having to reimplement every PostgreSQL/SQL/CSV connector and Power Query step. Install DAX Studio once; its window does **not** need to be open. If `dscmd.exe` is not found automatically, set `DSCMD_PATH` in `gemini/.env`. The first run creates that file. The PBIP must be loaded in Power BI Desktop, but Desktop need not be the foreground window. The runner attempts to open it if necessary. You may still need to resolve source credentials and manually refresh imported data in Desktop; the runner cannot bypass those prompts or perform a supported headless Desktop refresh. [DAX Studio requires a running Desktop instance](https://daxstudio.org/docs/features/command-line/connecting/). To honor the no-Fabric requirement, reports must have a local PBIR `datasetReference.byPath` pointing to the included semantic-model folder; remote or unresolved model references stop before export.

The optional `DATA_MODE=raw` fallback reads local/UNC CSV exports and simple PostgreSQL table/view references directly. It can also run a literal `Value.NativeQuery(PostgreSQL.Database(...), "SQL", null, ...)` only after you review the query and set `PG_ALLOW_NATIVE_QUERIES=true`, using a read-only database login. Fill `PG_USER` and `PG_PASSWORD` in `.env` for this mode. This fallback is **not** the recommended general converter: it does not apply subsequent Power Query steps. It never uses Fabric, a gateway, or Power BI Service.

Desktop model export includes Power Query transformations, merged queries, and calculated columns that are present in the loaded model. It does **not** turn every DAX measure or Power BI visual interaction into standalone JavaScript. The agent reconstructs what it can and must flag gaps. RLS, DirectQuery behavior, custom visuals, drill-through, bookmarks, and large models need particular review. A general-purpose, guaranteed pixel-and-calculation-identical static HTML converter does not exist in this repository.

## What `npm start` does

1. Inventory the PBIP/PBIR and export loaded model tables through Power BI Desktop/DAX Studio; create a baseline review page.
2. Ask Gemini to interpret the report, then independently audit that interpretation.
3. Ask Gemini to build/refine the dynamic HTML, then audit and repair it.
4. Package the same report/data into one offline static HTML file.
5. Run an independent final review and deterministic file/link checks.

The run stops on a failed phase or check. It does not publish or upload anything. Each run preserves prior output under `work/runs/<timestamp>/previous-output/` before replacing it.

`npm run preflight` checks input without calling Gemini. `npm test` runs local unit tests. Gemini usage may incur charges according to your account. If Gemini exits unsuccessfully, inspect the latest `work/runs/<timestamp>/01-interpret.stderr.log` and `.stdout.json`; the runner also prints the final error text.

## Security and limits

`input/`, `output/`, `work/`, and `.env` are Git-ignored so report data and credentials are not accidentally committed to this public repository. **Do not remove those ignore rules or force-add sensitive files.** Desktop-model CSV exports are stored in ignored `work/`. Gemini CLI reads normalized rows during a run; its model provider will process the content, but `.env` credentials are not supplied in its prompt or child environment. Confirm your organization's data-handling policy before use. The static HTML contains the complete embedded data and is readable by anyone who receives it. Do not put confidential snapshots on public GitHub Pages. GitHub Pages cannot directly read a private Windows/SMB share or PostgreSQL database; the dynamic mode requires the local Node server.

This is an assisted reconstruction workflow, not a one-click Power BI renderer. The final `work/final-review.json` and on-page status are part of the review, not a guarantee of equivalence.
