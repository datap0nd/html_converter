# Phase 5 — review the resumed report after page repairs

Read `skills/pbir-reading.md`, `skills/data-honesty.md`, `skills/visual-qa.md`, `work/inventory.json`, original PBIP/PBIR/TMDL/M/DAX definitions, `work/live-interpretation.json`, `work/live-build.json`, `output/dynamic/index.html`, and `output/dynamic/backend.mjs`. Do not read `.env` or run shell commands. Do not edit generated report files.

This is an independent skeptical review after per-page repair. Check every page and every visual against its original definition, the source connector path, transformations, measures, relationships, filter context, layout, and credentials isolation. Do not count ID markers or generic chart cards as implemented visuals. Use `blocked` for fabricated or missing visuals, missing required sources/calculations, unsafe code, or broken interactions. Exact numerical/visual parity cannot be certified without comparison to Power BI.

Write `work/live-final-review.json` with `status` (`pass`, `warnings`, or `blocked`), `findings`, `limitations`, `unverified`, `pageCoverage`, `visualCoverage`, and `sourceCoverage`.
