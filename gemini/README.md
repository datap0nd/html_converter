# html_converter

Place one Power BI Desktop project (`*.pbip` and its neighboring `.Report` / `.SemanticModel` folders) in `input/`. Then, from this `gemini/` directory, run:

```powershell
npm start
```

You need Node.js 20+ and an installed, authenticated [Gemini CLI](https://geminicli.com/docs/get-started/). The runner uses `gemini-3.5-flash` by default; set the `GEMINI_MODEL` environment variable if your CLI account needs a different model. It starts each phase in a fresh headless Gemini session, so there is no manual `/clear` step or chat to babysit. If the folder-trust/auth setup is not complete, do that once in Gemini CLI before running this workflow.

Open `output/static/report.html` directly in a browser. To review the dynamic version, run `npm run preview` and open the localhost address it prints. The local preview server rereads directly referenced CSV files on each data request. After source data changes, run `npm run snapshot` to rebuild the standalone file without rerunning Gemini. The static file embeds its data and makes no runtime requests. `work/` holds the inventory, agent notes, logs, and final checks.

## Input

```text
gemini/
  input/
    MyReport.pbip
    MyReport.Report/...
    MyReport.SemanticModel/...
    data/                   # optional but needed for actual values
      sales.csv             # optional CSV or JSON exports you are permitted to use
```

The PBIP/PBIR report definition describes pages, visuals, and semantic-model connections. The model definition can contain Power Query source expressions, but usually does **not** contain the underlying rows. The runner now recognizes a simple literal `File.Contents("C:\\...\\file.csv")` or `File.Contents("\\\\server\\share\\file.csv")` inside TMDL/M or `model.bim` and reads that CSV using your Windows account. The path must be accessible on the machine running `npm start`; mapped drives may not exist in every session. You can also supply approved CSV/JSON exports in `input/data/`. The tool never asks Fabric, a gateway, or Power BI Service for data.

This direct-source support is intentionally narrow: it does **not** execute arbitrary Power Query M, resolve parameterized paths, apply joins/transforms, calculate DAX, or mirror Power BI security. Raw CSV values can therefore differ from report values. A visual whose calculation or interaction cannot be reconstructed must be marked as such. Complex custom visuals, DAX, RLS, drill-through, and bookmarks may need manual work.

## What `npm start` does

1. Inventory the PBIP/PBIR, direct file-based CSV sources, and local exports; create a baseline review page.
2. Ask Gemini to interpret the report, then independently audit that interpretation.
3. Ask Gemini to build/refine the dynamic HTML, then audit and repair it.
4. Package the same report/data into one offline static HTML file.
5. Run an independent final review and deterministic file/link checks.

The run stops on a failed phase or check. It does not publish or upload anything. Each run preserves prior output under `work/runs/<timestamp>/previous-output/` before replacing it.

`npm run preflight` checks input without calling Gemini. `npm test` runs local unit tests. Gemini usage may incur charges according to your account. If Gemini exits unsuccessfully, inspect the latest `work/runs/<timestamp>/01-interpret.stderr.log` and `.stdout.json`; the runner also prints the final error text.

## Security and limits

`input/`, `output/`, and `work/` contents are Git-ignored so report data is not accidentally committed to this public repository. **Do not remove those ignore rules or force-add sensitive files.** The runner may read CSV files outside the repo when your PBIP directly references them. Gemini CLI reads the normalized data during a run; its model provider will process the content. Confirm your organization's data-handling policy before use. The static HTML contains the complete embedded data and is readable by anyone who receives it. Do not put confidential snapshots on public GitHub Pages. GitHub Pages cannot directly read a private Windows/SMB share; the dynamic mode requires the local Node server.

This is an assisted reconstruction workflow, not a one-click Power BI renderer. The final `work/final-review.json` and on-page status are part of the review, not a guarantee of equivalence.
