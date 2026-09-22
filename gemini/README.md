# html_converter

Place one Power BI Desktop project (`*.pbip` and its neighboring `.Report` / `.SemanticModel` folders) in `input/`. Then, from this `gemini/` directory, run:

```powershell
npm start
```

You need Node.js 20+ and an installed, authenticated [Gemini CLI](https://geminicli.com/docs/get-started/). The runner uses `gemini-3.5-flash` by default. It starts each phase in a fresh headless Gemini session, so there is no manual `/clear` step or chat to babysit. If the folder-trust/auth setup is not complete, do that once in Gemini CLI before running this workflow.

Open `output/static/report.html` directly in a browser. To review the dynamic version, run `npm run preview` and open the localhost address it prints. The static file embeds its data and makes no runtime requests. `work/` holds the inventory, agent notes, logs, and final checks. All are local.

## Input

```text
gemini/
  input/
    MyReport.pbip
    MyReport.Report/...
    MyReport.SemanticModel/...
    data/                   # optional but needed for actual values
      sales.csv             # CSV or JSON exports you are permitted to use
```

The PBIP/PBIR report definition normally describes pages, visuals, and the semantic-model connection; it does **not** provide the report's underlying rows. A PBIP-only run can produce a layout/logic preview with clearly marked missing-data placeholders, not an exact data-faithful report. For populated charts, add approved local CSV/JSON exports in `input/data/`. The tool never asks Fabric, a gateway, or Power BI Service for data. A visual whose calculation or interaction cannot be reconstructed is marked as such. Complex custom visuals, DAX, RLS, drill-through, and bookmarks may need manual work.

## What `npm start` does

1. Inventory the PBIP/PBIR and local exports; create a baseline review page.
2. Ask Gemini to interpret the report, then independently audit that interpretation.
3. Ask Gemini to build/refine the dynamic HTML, then audit and repair it.
4. Package the same report/data into one offline static HTML file.
5. Run an independent final review and deterministic file/link checks.

The run stops on a failed phase or check. It does not publish or upload anything. Each run preserves prior output under `work/runs/<timestamp>/previous-output/` before replacing it.

`npm run preflight` checks input without calling Gemini. `npm test` runs local unit tests. Gemini usage may incur charges according to your account.

## Security and limits

`input/`, `output/`, and `work/` contents are Git-ignored so report data is not accidentally committed to this public repository. **Do not remove those ignore rules or force-add sensitive files.** Gemini CLI still reads local input during a run; its model provider will process the content. Confirm your organization's data-handling policy before use. The static HTML contains the complete embedded exported data and is readable by anyone who receives it. Do not put confidential snapshots on public GitHub Pages.

This is an assisted reconstruction workflow, not a one-click Power BI renderer. The final `work/final-review.json` and on-page status are part of the review, not a guarantee of equivalence.
