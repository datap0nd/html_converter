import fs from 'node:fs';
import path from 'node:path';
import { dynamicDir, html, writeJson } from './core.mjs';

export function createPreview(inventory, data, targetDir = dynamicDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  writeJson(path.join(targetDir, 'report-data.json'), data);
  const pages = inventory.pages.length ? inventory.pages : [{ name: 'Report', visuals: [] }];
  const pageMarkup = pages.map((page, i) => `<section class="page" data-page="${i}" ${i ? 'hidden' : ''}><h2>${html(page.name)}</h2><div class="visual-grid">${page.visuals.length ? page.visuals.map(v => `<article class="visual"><div class="visual-type">${html(v.type)}</div><h3>${html(v.title ?? v.id)}</h3><p>Visual reconstruction pending review.</p><small>PBIR: ${html(v.source)}</small></article>`).join('') : '<article class="visual"><h3>No PBIR visuals found</h3><p>Check the source report format.</p></article>'}</div></section>`).join('');
  const title = path.basename(inventory.project, '.pbip');
  const noData = !data.datasets.length;
  const rawSource = data.datasets.some(x => x.kind === 'raw-file-source');
  const postgresSource = data.datasets.some(x => x.kind === 'raw-postgres-source');
  const markup = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${html(title)} — HTML review</title>
<style>
:root{font-family:Segoe UI,Arial,sans-serif;color:#142236;background:#f5f7fb}*{box-sizing:border-box}body{margin:0}header{background:#172b4d;color:white;padding:22px 28px}h1{font-size:22px;margin:0 0 8px}.status{background:#fff0c2;color:#503600;padding:12px 24px;border-left:5px solid #c78d00}nav{display:flex;gap:8px;padding:18px 24px;flex-wrap:wrap}button,select{font:inherit;padding:8px 12px;border:1px solid #b9c5d5;border-radius:6px;background:white}button[aria-current="page"]{background:#172b4d;color:white}main{padding:0 24px 40px}.page h2{font-size:19px}.visual-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}.visual{background:white;border:1px solid #dbe2ed;border-radius:10px;padding:18px;min-height:170px;box-shadow:0 2px 8px #182a410c}.visual h3{margin:6px 0}.visual p{color:#637187}.visual-type{color:#5068a8;text-transform:uppercase;font-size:11px;letter-spacing:.08em}small{color:#6c7890;overflow-wrap:anywhere}.data-panel{background:white;border:1px solid #dbe2ed;border-radius:10px;padding:18px;margin-top:28px}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;border-bottom:1px solid #e1e7ee;padding:7px;max-width:260px;overflow-wrap:anywhere}.table-wrap{overflow:auto;max-height:400px}label{display:inline-flex;gap:8px;align-items:center;margin:8px 12px 8px 0}
</style></head><body><header><h1>${html(title)}</h1><div>Local HTML reconstruction — review required</div></header>
<div class="status" id="report-status">${noData ? 'PBIP metadata only: no readable data source found. Values and charts cannot be verified.' : rawSource || postgresSource ? 'Direct CSV/PostgreSQL source read. Rows are raw; Power Query transformations and DAX results are not automatically reproduced.' : 'Local data supplied. Visual calculations and fidelity still require review.'}</div>
<nav aria-label="Report pages">${pages.map((p,i)=>`<button type="button" data-target="${i}" ${i===0?'aria-current="page"':''}>${html(p.name)}</button>`).join('')}</nav>
<main>${pageMarkup}<section class="data-panel"><h2>Available local data</h2><div id="data-explorer">Loading…</div></section></main>
<script type="application/json" id="embedded-report-data">__EMBEDDED_REPORT_DATA__</script>
<script>
const navButtons=[...document.querySelectorAll('nav button')];navButtons.forEach(button=>button.addEventListener('click',()=>{const n=button.dataset.target;document.querySelectorAll('.page').forEach(p=>p.hidden=p.dataset.page!==n);navButtons.forEach(b=>b.removeAttribute('aria-current'));button.setAttribute('aria-current','page')}));
async function getReportData(){const node=document.getElementById('embedded-report-data');const embedded=node.textContent.trim();if(embedded && embedded!=='__EMBEDDED_REPORT_DATA__')return JSON.parse(embedded);const response=await fetch('./report-data.json');if(!response.ok)throw new Error('Local data file unavailable');return response.json()}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function renderDataset(dataset,term=''){const rows=dataset.rows.filter(row=>Object.values(row).some(value=>String(value??'').toLowerCase().includes(term.toLowerCase())));return '<p>'+rows.length+' / '+dataset.rows.length+' rows</p><div class="table-wrap"><table><thead><tr>'+dataset.columns.map(c=>'<th>'+escapeHtml(c)+'</th>').join('')+'</tr></thead><tbody>'+rows.slice(0,200).map(row=>'<tr>'+dataset.columns.map(c=>'<td>'+escapeHtml(row[c])+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>'+(rows.length>200?'<p>Showing first 200 matching rows.</p>':'')}
getReportData().then(data=>{const host=document.getElementById('data-explorer');if(!data.datasets.length){host.textContent='No readable CSV/JSON source found. Check work/inventory.json or add files in input/data, then rerun.';return}host.innerHTML=data.datasets.map((dataset,i)=>'<section class="dataset"><h3>'+escapeHtml(dataset.name)+'</h3><label>Filter rows <input type="search" data-filter="'+i+'" placeholder="Search values"></label><div data-table="'+i+'"></div></section>').join('');data.datasets.forEach((dataset,i)=>{const table=host.querySelector('[data-table="'+i+'"]');const filter=host.querySelector('[data-filter="'+i+'"]');const render=()=>table.innerHTML=renderDataset(dataset,filter.value);filter.addEventListener('input',render);render()})}).catch(error=>{document.getElementById('data-explorer').textContent='Unable to load local data: '+error.message});
</script></body></html>`;
  fs.writeFileSync(path.join(targetDir, 'index.html'), markup);
}
