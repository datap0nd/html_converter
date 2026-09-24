# Data honesty playbook

PBIP alone does not guarantee rows. Never synthesize business numbers. A field name, measure expression, or visual binding is not a row-level dataset. If a visual cannot be populated faithfully, display an explicit empty state saying why. Keep missing data, ambiguous joins, unimplemented DAX, and unsupported interactions in a limitations list. Never read `.env` or connect to external services yourself.

For live conversion (`prompts/live-*.md`), generate the backend against the actual source connectors and let the Node orchestrator execute it with local credentials. HTML fetches only its same-origin `/api/report` endpoint. Account for M transformations, relationships, DAX, and filters; raw source rows alone do not prove calculation parity. There is no `report-data.json` in this workflow.

For static/export conversion, use only normalized `output/dynamic/report-data.json` rows. A `desktop-model-export` dataset contains tables exported from Power BI Desktop after Power Query and model processing; it does not contain evaluated DAX measures for every visual/filter context. A `raw-*` dataset is source data before later Power Query steps and DAX. Dynamic HTML may fetch only its localhost `report-data.json`; static HTML must make no runtime requests. Static HTML discloses all embedded data.
