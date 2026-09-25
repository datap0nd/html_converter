# Data honesty playbook

Never synthesize business numbers. A field name, measure expression, or visual binding is not data. If a visual cannot be populated faithfully, display an explicit empty state saying why, and keep missing data, ambiguous joins, unimplemented DAX, and unsupported interactions in a limitations list. PBIP definitions alone do not contain rows. Never read `.env` or connect to external services yourself.

Live converter (`npm start`, the default): values come only from the generated local backend (`output/dynamic/backend.mjs`), which reads the report's real sources and applies the Power Query steps, relationships, and DAX logic that the PBIP evidence supports. The HTML fetches only `/api/report` on its own local server. Raw source tables are not the report: later M steps, merges, and measures must be implemented or labeled as not reproduced.

Legacy snapshot converter (`npm run convert`): use only rows in the normalized `output/dynamic/report-data.json`. A `desktop-model-export` dataset contains tables exported from Power BI Desktop after Power Query and model processing; it does not contain evaluated DAX measures for every visual/filter context. A `raw-*` dataset is source data before later Power Query steps and DAX. Dynamic HTML may fetch only its local `report-data.json`; static HTML must make no runtime requests and discloses all embedded data.
