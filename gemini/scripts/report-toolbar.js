// Injected by the report server into the served page (never into the saved HTML):
// a small bar with the data load time, a Refresh button, and the result of the
// comparison with Power BI Desktop, which also outlines each visual that differs.
(() => {
  if (window.__htmlConverterToolbar) return;
  window.__htmlConverterToolbar = true;
  const start = () => {
    const host = document.createElement('div');
    host.setAttribute('data-html-converter', 'toolbar');
    host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483646;';
    document.body.appendChild(host);
    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.innerHTML = [
      '<style>',
      ':host{all:initial}',
      '.bar{display:flex;gap:8px;align-items:center;font:12px/1.4 Segoe UI,system-ui,sans-serif;background:#fff;color:#252423;border:1px solid #c8c6c4;border-radius:6px;padding:6px 8px;box-shadow:0 2px 8px rgba(0,0,0,.15)}',
      'button{font:inherit;border:1px solid #8a8886;background:#f3f2f1;border-radius:4px;padding:3px 8px;cursor:pointer;color:inherit}',
      'button:disabled{opacity:.6;cursor:default}',
      '.good{border-color:#107c10;color:#0b5a0b}',
      '.bad{border-color:#d13438;color:#a4262c;font-weight:600}',
      '.none{border-color:#c19c00;color:#795c00}',
      '.panel{margin-top:6px;max-height:50vh;overflow:auto;background:#fff;border:1px solid #c8c6c4;border-radius:6px;padding:6px 8px;font:12px/1.4 Segoe UI,system-ui,sans-serif;color:#252423;box-shadow:0 2px 8px rgba(0,0,0,.15);max-width:520px}',
      '.row{padding:3px 0;border-bottom:1px solid #edebe9;cursor:pointer}',
      '.row:last-child{border-bottom:0}',
      '.status{display:inline-block;min-width:92px;font-weight:600}',
      '.match{color:#0b5a0b}.mismatch{color:#a4262c}.not-compared{color:#605e5c}',
      '.detail{color:#605e5c;margin-left:92px}',
      '</style>',
      '<div class="bar"><span class="time"></span><button class="refresh" type="button" title="Read the sources again and redraw every visual">Refresh data</button><button class="check" type="button" hidden></button></div>',
      '<div class="panel" hidden></div>'
    ].join('');
    const time = root.querySelector('.time'), refresh = root.querySelector('.refresh'), check = root.querySelector('.check'), panel = root.querySelector('.panel');
    time.textContent = 'Data loaded ' + new Date().toLocaleTimeString();
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      refresh.textContent = 'Refreshing...';
      try {
        const response = await fetch('/api/refresh', { cache: 'no-store' });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || ('HTTP ' + response.status));
        location.reload();
      } catch (error) {
        refresh.textContent = 'Refresh failed';
        refresh.title = String(error && error.message || error);
        refresh.disabled = false;
      }
    });
    check.addEventListener('click', () => { panel.hidden = !panel.hidden; });
    const escape = value => (window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&'));
    const text = value => value === null || value === undefined ? 'blank' : typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 6 }) : String(value);
    fetch('/api/status', { cache: 'no-store' }).then(response => response.json()).then(status => {
      const parity = status && status.parity;
      check.hidden = false;
      if (!parity || !parity.summary) {
        check.textContent = 'Not compared with Power BI';
        check.className = 'check none';
        check.title = 'Open the report\'s .pbip in Power BI Desktop and rerun setup: every visual is then compared with Power BI and differences are fixed.';
        check.disabled = true;
        return;
      }
      const summary = parity.summary;
      check.textContent = 'Power BI check: ' + summary.match + ' of ' + summary.total + ' match' + (summary.mismatch ? ', ' + summary.mismatch + ' differ' : '');
      check.className = 'check ' + (summary.mismatch ? 'bad' : 'good');
      check.title = 'Compared with Power BI Desktop at ' + new Date(parity.checkedAt).toLocaleString() + '. Click for details.';
      const order = { mismatch: 0, 'not-compared': 1, match: 2 };
      const visuals = parity.visuals.slice().sort((a, b) => order[a.status] - order[b.status]);
      for (const visual of visuals) {
        const row = document.createElement('div');
        row.className = 'row';
        const label = document.createElement('div');
        const badge = document.createElement('span');
        badge.className = 'status ' + visual.status;
        badge.textContent = visual.status === 'match' ? 'matches' : visual.status === 'mismatch' ? 'DIFFERS' : 'not compared';
        label.appendChild(badge);
        label.appendChild(document.createTextNode((visual.title || visual.type) + ' (' + visual.page + ')'));
        row.appendChild(label);
        if (visual.status !== 'match') {
          const detail = document.createElement('div');
          detail.className = 'detail';
          const first = visual.firstDifference;
          detail.textContent = (visual.reason || '') + (first ? ' - ' + first.field + ': Power BI ' + text(first.powerBI) + ', report ' + text(first.report) : '');
          row.appendChild(detail);
        }
        const element = document.querySelector('[data-visual-id="' + escape(visual.visualId) + '"]');
        if (element) {
          row.addEventListener('click', () => element.scrollIntoView({ behavior: 'smooth', block: 'center' }));
          if (visual.status === 'mismatch') {
            element.style.outline = '2px solid #d13438';
            element.style.outlineOffset = '2px';
            element.title = 'Differs from Power BI: ' + (visual.reason || '');
          }
        }
        panel.appendChild(row);
      }
      if (summary.mismatch) panel.hidden = false;
    }).catch(() => { check.hidden = true; });
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
