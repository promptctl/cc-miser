// The report: a pure function from the model to a self-contained HTML page.
//
// [LAW:effects-at-boundaries] Nothing here reads a file, fetches, or computes a
// token count. It receives the model and returns a string. Every number on the page
// was decided by the producer; the renderer's only job is to make it legible.
//
// [LAW:dataflow-not-control-flow] Sections are driven by data — the ledger list, the
// finding list, the strata — so a new ledger is a new row in the model, never a new
// branch here.
//
// The aesthetic is PROJECT.md's own first line: "Every Claude Code session you have
// ever run left behind an itemized bill, and nobody has ever read it." So the page is
// that bill — a forensic statement of account on bone paper, hairline-ruled, set in
// tabular figures, with the waste in accountant's red.

import type { CorpusReport, SessionReport, Ledger, Finding, Stratum, FlameNode, Cost, Activity } from './model.ts';

// ---------------------------------------------------------------------------
// Formatting. A Cost renders WITH its projection; there is no path that prints a
// bare number, because the model refuses to carry one.
// ---------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const n = (v: number): string => Math.round(v).toLocaleString('en-US');
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

const money = (c: Cost): string =>
  c.projection === 'usd' ? `$${c.value.toFixed(2)}` : n(c.value);

const unit = (c: Cost): string =>
  c.projection === 'usd' ? 'USD' : c.projection === 'raw-tokens' ? 'tokens' : 'tok-eq';

const dur = (ms: number): string => {
  const h = ms / 3600000;
  if (h >= 1) return `${h.toFixed(1)} h`;
  const m = ms / 60000;
  return m >= 1 ? `${m.toFixed(0)} min` : `${(ms / 1000).toFixed(0)} s`;
};

const day = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';

/** Earthy categoricals that hold up on bone paper. `unclassified` is deliberately
 * drab: an honesty bucket should look like a gap, not like a finding. */
const ACTIVITY_COLOR: Record<Activity, string> = {
  exploration: '#3E6B8A',
  implementation: '#4A6741',
  verification: '#6E7F3A',
  review: '#8A5A2B',
  design: '#7A4E7E',
  process: '#9A7B3B',
  orientation: '#5A6675',
  scm: '#2F6B63',
  debugging: '#A32F1E',
  reporting: '#7A6A55',
  overhead: '#B0432A',
  unclassified: '#B3AB9C',
};

const DEPTH_COLOR = ['#17150F', '#3E6B8A', '#8A5A2B', '#7A4E7E'];

const SOURCE_COLOR: Record<Stratum['source'], string> = {
  startup: '#5A6675',
  toolResult: '#3E6B8A',
  assistantOutput: '#8A5A2B',
  userText: '#4A6741',
  attachment: '#9A7B3B',
  mixed: '#7A6A55',
};

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function ledgerBlock(l: Ledger): string {
  const max = Math.max(...l.rows.map((r) => r.cost.value), 1);
  const rows = l.rows
    .map((r) => {
      const colour = ACTIVITY_COLOR[r.key as Activity] ?? '#55503F';
      return `<tr>
        <th scope="row"><span class="swatch" style="--c:${colour}"></span>${esc(r.key)}</th>
        <td class="bar"><span style="width:${(r.cost.value / max) * 100}%;--c:${colour}"></span></td>
        <td class="num">${n(r.cost.value)}</td>
        <td class="num pct">${pct(r.share)}</td>
        <td class="note">${esc(r.note)}</td>
      </tr>`;
    })
    .join('');
  return `<section class="ledger" id="ledger-${esc(l.id)}">
    <h3>${esc(l.title)}</h3>
    <p class="lede">${esc(l.lede)}</p>
    <table><tbody>${rows}</tbody></table>
  </section>`;
}

function findingBlock(f: Finding, i: number): string {
  return `<li class="finding sev-${f.severity}">
    <div class="fi-num">${String(i + 1).padStart(2, '0')}</div>
    <div class="fi-body">
      <h4>${esc(f.headline)}</h4>
      <p>${esc(f.detail)}</p>
    </div>
    <div class="fi-cost">
      <div class="fi-val">${n(f.cost.value)}</div>
      <div class="fi-unit">${unit(f.cost)}</div>
      <div class="fi-share">${pct(f.shareOfSession)} of session</div>
    </div>
  </li>`;
}

/** The arena: call index across, context-window offset up, one band per allocation
 * running rightward through its residency. An epoch boundary is a cliff — every band
 * ends and the whole column is re-written. */
function stratigraphy(s: SessionReport): string {
  const W = 1000;
  const H = 300;
  const PAD = { l: 54, r: 12, t: 12, b: 26 };
  const lastCall = Math.max(1, s.calls.filter((c) => c.depth === 0).length - 1);
  const peak = Math.max(
    1,
    ...s.calls.filter((c) => c.depth === 0).map((c) => c.usage.input + c.usage.cacheCreation + c.usage.cacheRead),
  );
  const x = (call: number): number => PAD.l + (call / lastCall) * (W - PAD.l - PAD.r);
  const y = (tok: number): number => H - PAD.b - (tok / peak) * (H - PAD.t - PAD.b);

  // Stack the bands within each epoch, oldest at the bottom — the arena fills upward.
  const offsets = new Map<number, number>();
  const bands = s.strata
    .map((st) => {
      const ep = s.epochs[st.epoch];
      if (!ep) return '';
      const base = offsets.get(st.epoch) ?? 0;
      offsets.set(st.epoch, base + st.tokens);
      const x0 = x(st.bornAtCall);
      const x1 = x(ep.endCall);
      const y0 = y(base + st.tokens);
      const y1 = y(base);
      const h = Math.max(0.8, y1 - y0);
      return `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${h.toFixed(1)}" fill="${SOURCE_COLOR[st.source]}" opacity="0.82"><title>${esc(st.label)} — born call ${st.bornAtCall}, ${n(st.tokens)} tokens, alive to call ${ep.endCall}</title></rect>`;
    })
    .join('');

  const cliffs = s.epochs
    .slice(1)
    .map(
      (e) =>
        `<line x1="${x(e.startCall).toFixed(1)}" y1="${PAD.t}" x2="${x(e.startCall).toFixed(1)}" y2="${H - PAD.b}" class="cliff"/>
         <text x="${(x(e.startCall) + 5).toFixed(1)}" y="${PAD.t + 12}" class="cliff-label">cache invalidated · ${n(e.rewrittenTokens)} re-written</text>`,
    )
    .join('');

  const ticks = [0, 0.5, 1]
    .map((f) => {
      const v = peak * f;
      return `<line x1="${PAD.l}" y1="${y(v).toFixed(1)}" x2="${W - PAD.r}" y2="${y(v).toFixed(1)}" class="grid"/>
              <text x="${PAD.l - 8}" y="${(y(v) + 3).toFixed(1)}" class="axis" text-anchor="end">${n(v / 1000)}k</text>`;
    })
    .join('');

  const legend = (Object.keys(SOURCE_COLOR) as Array<Stratum['source']>)
    .filter((k) => s.strata.some((st) => st.source === k))
    .map((k) => `<span class="key"><i style="--c:${SOURCE_COLOR[k]}"></i>${k}</span>`)
    .join('');

  return `<section class="panel wide">
    <h3>Stratigraphy — the context window as an arena</h3>
    <p class="lede">Call index across, resident tokens up. Every band is content written into the
      window once and re-read on every later call until its epoch ends. This is a memory
      profiler's allocation timeline applied to a context window.</p>
    <svg viewBox="0 0 ${W} ${H}" class="strat" role="img" aria-label="context window residency over call index">
      ${ticks}${bands}${cliffs}
      <line x1="${PAD.l}" y1="${H - PAD.b}" x2="${W - PAD.r}" y2="${H - PAD.b}" class="axisline"/>
      <text x="${PAD.l}" y="${H - 8}" class="axis">call 0</text>
      <text x="${W - PAD.r}" y="${H - 8}" class="axis" text-anchor="end">call ${lastCall}</text>
    </svg>
    <div class="legend">${legend}</div>
  </section>`;
}

/** Flamegraph as plain SVG — no library, so the page stays self-contained and the
 * palette matches the rest of the document. Colour is by activity, falling back to
 * spawn depth for non-call frames. */
function flame(root: FlameNode): string {
  const W = 1000;
  const ROW = 19;
  const rows: string[] = [];
  let maxDepth = 0;

  const walk = (node: FlameNode, x0: number, w: number, d: number): void => {
    maxDepth = Math.max(maxDepth, d);
    const colour = node.activity ? ACTIVITY_COLOR[node.activity] : DEPTH_COLOR[Math.min(node.depth, 3)]!;
    const label = w > 60 ? esc(node.name.slice(0, Math.floor(w / 6.2))) : '';
    rows.push(
      `<g class="fr"><rect x="${x0.toFixed(1)}" y="${(d * ROW).toFixed(1)}" width="${Math.max(0.6, w - 0.7).toFixed(1)}" height="${ROW - 1.4}" fill="${colour}" opacity="${node.activity ? 0.88 : 0.7}"/>` +
        (label ? `<text x="${(x0 + 4).toFixed(1)}" y="${(d * ROW + 13).toFixed(1)}" class="fl">${label}</text>` : '') +
        `<title>${esc(node.name)} — ${n(node.value)} tok-eq</title></g>`,
    );
    let cx = x0;
    const total = node.children.reduce((a, c) => a + c.value, 0) || 1;
    for (const c of node.children) {
      const cw = (c.value / node.value) * w * Math.min(1, node.value / total);
      walk(c, cx, cw, d + 1);
      cx += cw;
    }
  };
  walk(root, 0, W, 0);

  return `<section class="panel wide">
    <h3>Where the tokens went</h3>
    <p class="lede">The span tree weighted by cost, not time — width is spend. Colour is activity;
      spawned conversations carry their spawner's label.</p>
    <svg viewBox="0 0 ${W} ${(maxDepth + 1) * ROW}" class="flame" role="img" aria-label="cost-weighted flamegraph">${rows.join('')}</svg>
  </section>`;
}

function coverageBar(s: SessionReport): string {
  const parts = (Object.entries(s.coverage.byTier) as Array<[string, number]>).filter(([, v]) => v > 0.0005);
  const seg = parts
    .map(
      ([k, v]) =>
        `<span class="cov-seg cov-${k}" style="width:${v * 100}%"><em>${k} ${pct(v)}</em></span>`,
    )
    .join('');
  return `<div class="coverage">
    <div class="cov-bar">${seg}</div>
    <p class="cov-note">How every percentage on this page was decided.
      ${s.coverage.unclassified > 0 ? `<strong>${pct(s.coverage.unclassified)} is unclassified</strong> and is shown as its own row rather than distributed away.` : 'Nothing is unclassified.'}</p>
  </div>`;
}

function sessionSection(s: SessionReport, idx: number): string {
  const wall = s.endedAt - s.startedAt;
  const cons = s.conservation;
  const exact = cons.callsExact === cons.callsChecked;
  return `<article class="session" id="s-${idx}" data-session="${idx}">
    <header class="masthead">
      <div class="mh-left">
        <div class="eyebrow">Statement of account</div>
        <h2>${esc(s.project.replace(/^-Users-you-code-/, ''))}</h2>
        <div class="sub">session ${esc(s.sessionId.slice(0, 8))} · ${esc(s.model)} · ${day(s.startedAt)} · ${dur(wall)} wall</div>
      </div>
      <div class="mh-right">
        <div class="total">${n(s.total.value)}</div>
        <div class="total-unit">token-equivalents<br><span>input×1 + cache-write×1.25 + cache-read×0.1, plus output</span></div>
        <div class="total-usd">${money(s.totalUsd)}</div>
      </div>
    </header>

    <div class="strip">
      <div><b>${s.calls.length}</b><span>API calls</span></div>
      <div><b>${n(s.usage.cacheRead)}</b><span>tokens re-read</span></div>
      <div><b>${(s.usage.cacheRead / Math.max(1, s.usage.cacheCreation)).toFixed(1)}:1</b><span>read : write</span></div>
      <div><b>${s.epochs.length}</b><span>cache epoch${s.epochs.length === 1 ? '' : 's'}</span></div>
      <div><b>${Math.max(0, ...s.calls.map((c) => c.depth))}</b><span>max spawn depth</span></div>
    </div>

    <section class="panel">
      <h3>Findings</h3>
      <p class="lede">Not a chart — a punch list. Each item names the thing, prices it, and says what it cost you.</p>
      <ol class="findings">${s.findings.map(findingBlock).join('')}</ol>
    </section>

    ${stratigraphy(s)}
    ${flame(s.flame)}

    <div class="ledgers">${s.ledgers.map(ledgerBlock).join('')}</div>

    <section class="panel">
      <h3>How much to trust this page</h3>
      ${coverageBar(s)}
      <div class="checks">
        <div class="check ${exact ? 'ok' : 'warn'}">
          <b>${exact ? 'Residency reconstruction is exact' : 'Residency reconstruction does not reconcile'}</b>
          <p>Two independent routes to total cache-read — the API's own reported figure
          (${n(cons.actualCacheRead)}) and the residency model's prediction (${n(cons.predictedCacheRead)}) —
          agree on <b>${cons.callsExact} of ${cons.callsChecked}</b> calls individually.</p>
        </div>
        <div class="check note">
          <b>Parse</b>
          <ul>${s.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        </div>
      </div>
    </section>
  </article>`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function renderCorpus(c: CorpusReport): string {
  const index = c.sessions
    .map(
      (s, i) => `<li><button data-go="${i}" class="${i === 0 ? 'on' : ''}">
        <span class="ix-proj">${esc(s.project.replace(/^-Users-you-code-/, ''))}</span>
        <span class="ix-cost">${money(s.totalUsd)}</span>
        <span class="ix-sub">${esc(s.sessionId.slice(0, 8))} · ${s.calls.length} calls · ${dur(s.endedAt - s.startedAt)}</span>
      </button></li>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>cc-miser — statement of account</title>
<style>
:root{
  --paper:#F4F1E9; --paper-2:#EDE8DC; --paper-3:#E3DCCB;
  --ink:#17150F; --ink-2:#4A4536; --ink-3:#7A7361;
  --rule:#C9C1AC; --rule-2:#DDD6C4;
  --red:#A32F1E; --brass:#8A6D3B; --green:#4A6741;
  --display:"Hoefler Text","Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
  --sans:"Avenir Next","Optima","Gill Sans MT","Gill Sans",Helvetica,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--paper); color:var(--ink); font-family:var(--sans);
  font-size:14px; line-height:1.55; -webkit-font-smoothing:antialiased;
  font-variant-numeric:tabular-nums;
}
/* paper grain */
body::before{
  content:""; position:fixed; inset:0; pointer-events:none; z-index:9999; opacity:.35;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3'/><feColorMatrix type='saturate' values='0'/></filter><rect width='160' height='160' filter='url(%23n)' opacity='.5'/></svg>");
  mix-blend-mode:multiply;
}
.wrap{display:grid; grid-template-columns:288px minmax(0,1fr); min-height:100vh}

/* ---- left rail ---- */
.rail{
  border-right:1px solid var(--rule); background:var(--paper-2);
  position:sticky; top:0; height:100vh; overflow-y:auto; padding:26px 0 40px;
}
.brand{padding:0 22px 18px; border-bottom:1px solid var(--rule); margin-bottom:14px}
.brand h1{font-family:var(--display); font-size:27px; margin:0; letter-spacing:-.01em; font-weight:400}
.brand .tag{font-size:10.5px; letter-spacing:.15em; text-transform:uppercase; color:var(--ink-3); margin-top:6px}
.brand .totals{margin-top:16px; font-family:var(--display); font-size:16px}
.brand .totals b{font-size:25px; display:block; line-height:1.1}
.brand .totals span{font-family:var(--sans); font-size:10.5px; letter-spacing:.13em; text-transform:uppercase; color:var(--ink-3)}
.rail h2{font-size:10.5px; letter-spacing:.15em; text-transform:uppercase; color:var(--ink-3); padding:0 22px; margin:20px 0 8px; font-weight:600}
.rail ul{list-style:none; margin:0; padding:0}
.rail button{
  display:block; width:100%; text-align:left; background:none; border:0; cursor:pointer;
  padding:9px 22px; border-left:3px solid transparent; font:inherit; color:var(--ink-2);
  border-bottom:1px solid var(--rule-2);
}
.rail button:hover{background:var(--paper-3)}
.rail button.on{border-left-color:var(--red); background:var(--paper); color:var(--ink)}
.ix-proj{display:inline-block; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:bottom; font-weight:600; font-size:13px}
.ix-cost{float:right; font-family:var(--mono); font-size:12px; color:var(--red)}
.ix-sub{display:block; font-size:10.5px; color:var(--ink-3); font-family:var(--mono); margin-top:2px}

/* ---- main ---- */
.main{padding:36px 44px 120px; max-width:1180px}
.session{display:none}
.session.on{display:block}

.masthead{display:flex; justify-content:space-between; align-items:flex-end; gap:32px;
  border-bottom:2px solid var(--ink); padding-bottom:16px}
.eyebrow{font-size:10.5px; letter-spacing:.24em; text-transform:uppercase; color:var(--red); font-weight:600}
.masthead h2{font-family:var(--display); font-weight:400; font-size:40px; margin:5px 0 4px; letter-spacing:-.015em}
.masthead .sub{font-family:var(--mono); font-size:11.5px; color:var(--ink-3)}
.mh-right{text-align:right; flex:0 0 auto}
.total{font-family:var(--display); font-size:52px; line-height:1; letter-spacing:-.02em}
.total-unit{font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--ink-3); margin-top:5px}
.total-unit span{text-transform:none; letter-spacing:0; font-family:var(--mono); font-size:10px}
.total-usd{font-family:var(--display); font-size:22px; color:var(--red); margin-top:7px}

.strip{display:flex; gap:0; border-bottom:1px solid var(--rule); margin-bottom:30px}
.strip div{flex:1; padding:13px 0 12px; border-right:1px solid var(--rule-2)}
.strip div:last-child{border-right:0}
.strip b{display:block; font-family:var(--display); font-size:23px; line-height:1.1}
.strip span{font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-3)}

.panel{margin:0 0 34px}
.panel.wide{margin-bottom:38px}
.panel h3,.ledger h3{font-family:var(--display); font-weight:400; font-size:21px; margin:0 0 3px}
.lede{color:var(--ink-2); margin:0 0 15px; max-width:74ch; font-size:13px}

/* findings */
.findings{list-style:none; margin:0; padding:0}
.finding{display:grid; grid-template-columns:38px 1fr 132px; gap:16px; align-items:start;
  padding:15px 0; border-top:1px solid var(--rule)}
.finding:last-child{border-bottom:1px solid var(--rule)}
.fi-num{font-family:var(--mono); font-size:11px; color:var(--ink-3); padding-top:3px}
.fi-body h4{margin:0 0 4px; font-size:15px; font-weight:600}
.fi-body p{margin:0; color:var(--ink-2); font-size:13px; max-width:78ch}
.fi-cost{text-align:right}
.fi-val{font-family:var(--display); font-size:25px; line-height:1}
.fi-unit{font-size:9.5px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-3)}
.fi-share{font-family:var(--mono); font-size:11px; margin-top:4px}
.sev-high .fi-val,.sev-high .fi-share{color:var(--red)}
.sev-high .fi-num::after{content:"▲"; color:var(--red); display:block; margin-top:3px}
.sev-medium .fi-val{color:var(--brass)}

/* charts */
.strat,.flame{width:100%; height:auto; display:block; background:var(--paper-2);
  border:1px solid var(--rule)}
.grid{stroke:var(--rule-2); stroke-width:1}
.axisline{stroke:var(--ink); stroke-width:1}
.axis{font-family:var(--mono); font-size:9.5px; fill:var(--ink-3)}
.cliff{stroke:var(--red); stroke-width:1.5; stroke-dasharray:3 2}
.cliff-label{font-family:var(--mono); font-size:9.5px; fill:var(--red)}
.fl{font-family:var(--mono); font-size:9.5px; fill:#F4F1E9; pointer-events:none}
.fr rect{stroke:var(--paper); stroke-width:.6}
.fr:hover rect{opacity:1; stroke:var(--ink); stroke-width:1}
.legend{display:flex; gap:16px; flex-wrap:wrap; margin-top:9px}
.key{font-size:10.5px; color:var(--ink-2); letter-spacing:.04em}
.key i{display:inline-block; width:9px; height:9px; background:var(--c); margin-right:5px}

/* ledgers */
.ledgers{display:grid; grid-template-columns:1fr 1fr; gap:34px 44px; margin-bottom:34px}
.ledger table{width:100%; border-collapse:collapse}
.ledger tr{border-top:1px solid var(--rule-2)}
.ledger tr:first-child{border-top:1px solid var(--rule)}
.ledger th{text-align:left; font-weight:500; padding:6px 8px 6px 0; font-size:13px; white-space:nowrap}
.ledger td{padding:6px 0 6px 8px; font-size:12.5px}
.ledger .num{font-family:var(--mono); text-align:right; white-space:nowrap}
.ledger .pct{color:var(--ink-3); width:56px}
.ledger .note{color:var(--ink-3); font-size:10.5px; text-align:right; white-space:nowrap}
.ledger .bar{width:38%}
.ledger .bar span{display:block; height:7px; background:var(--c); opacity:.72}
.swatch{display:inline-block; width:8px; height:8px; background:var(--c); margin-right:7px}

/* trust */
.coverage{margin-bottom:18px}
.cov-bar{display:flex; height:22px; border:1px solid var(--rule); background:var(--paper-2)}
.cov-seg{position:relative; overflow:hidden}
.cov-seg em{position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  font-style:normal; font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; color:#F4F1E9; white-space:nowrap}
.cov-hand{background:var(--ink)} .cov-marker{background:var(--green)}
.cov-rule{background:var(--brass)} .cov-judge{background:#3E6B8A} .cov-none{background:#B3AB9C}
.cov-note{font-size:12px; color:var(--ink-2); margin:7px 0 0}
.checks{display:grid; grid-template-columns:1fr 1fr; gap:26px}
.check{border-left:3px solid var(--rule); padding-left:14px; font-size:12.5px; color:var(--ink-2)}
.check.ok{border-left-color:var(--green)}
.check.warn{border-left-color:var(--red)}
.check b{display:block; color:var(--ink); margin-bottom:3px; font-size:13px}
.check ul{margin:4px 0 0; padding-left:16px}
.check li{margin:2px 0}
@media (max-width:1000px){
  .wrap{grid-template-columns:1fr} .rail{position:static;height:auto}
  .ledgers,.checks{grid-template-columns:1fr} .masthead{flex-direction:column;align-items:flex-start}
  .mh-right{text-align:left}
}
</style></head>
<body><div class="wrap">
  <nav class="rail">
    <div class="brand">
      <h1>cc&#8202;·&#8202;miser</h1>
      <div class="tag">Itemized bill, finally read</div>
      <div class="totals">
        <b>${money(c.totalUsd)}</b>
        <span>${c.sessions.length} sessions · ${n(c.total.value)} tok-eq</span>
      </div>
    </div>
    <h2>Sessions by cost</h2>
    <ul>${index}</ul>
  </nav>
  <main class="main">${c.sessions.map(sessionSection).join('')}</main>
</div>
<script>
const show = (i) => {
  document.querySelectorAll('.session').forEach((el, k) => el.classList.toggle('on', k === i));
  document.querySelectorAll('.rail button').forEach((b, k) => b.classList.toggle('on', k === i));
  document.querySelector('.main').scrollTo(0, 0);
  window.scrollTo(0, 0);
};
document.querySelectorAll('.rail button').forEach((b) =>
  b.addEventListener('click', () => show(Number(b.dataset.go))));
show(0);
</script>
</body></html>`;
}
