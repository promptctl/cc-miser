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

import { usdCost } from './model.ts';
import type {
  Activity,
  ArenaBasis,
  Calibration,
  Conservation,
  CorpusReport,
  Cost,
  Coverage,
  Finding,
  FlameNode,
  Ledger,
  OutputTotals,
  PriceTotals,
  Selection,
  SessionReport,
  Stratum,
} from './model.ts';
import { workspaceKey } from '../workspace.ts';

// ---------------------------------------------------------------------------
// Formatting. A Cost renders WITH its projection; there is no path that prints a
// bare number, because the model refuses to carry one.
// ---------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const n = (v: number): string => Math.round(v).toLocaleString('en-US');
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/** What this page may honestly call itself, given what it actually rendered.
 *
 * [FRAMING:representation] The map states its own scale. These words used to be
 * hardcoded as "The whole account" / "Every session" above a filtered sample, which is
 * the one kind of caption error nobody downstream can catch: a reader who has never seen
 * the corpus has nothing to compare the claim against. Derived from `Selection` so the
 * claim cannot outlive the filter that made it true. */
const framing = (s: Selection): { eyebrow: string; title: string } =>
  s.rendered === s.discovered
    ? { eyebrow: 'The whole account', title: 'Every session' }
    : { eyebrow: 'A sample of the account', title: `${n(s.rendered)} of ${n(s.discovered)} sessions` };

const money = (c: Cost): string =>
  c.projection === 'usd' ? `$${c.value.toFixed(2)}` : n(c.value);

/** A dollar total on its way to the page.
 *
 * The projection tag is stamped here, at the last moment, because `PriceTotals` carries
 * `usd` as the bare number the arithmetic is done in. Routing every dollar figure
 * through this one helper keeps the model's rule intact — nothing prints a bare number —
 * without a second copy of the total living in the model to satisfy it. */
const dollars = (usd: number): string => money(usdCost(usd));

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
  unattributed: '#B3AB9C',
};

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function ledgerBlock(l: Ledger): string {
  // Scaled by MAGNITUDE, so a negative row draws a bar. The output ledger's estimator-
  // error row is routinely negative, and `width:-3%` is invalid CSS — the browser drew
  // nothing at all, leaving a row whose number said "-1,234" beside a bar that said
  // "zero". Two renderings of one fact, disagreeing. The bar carries size; the sign is
  // carried by the colour and by the number beside it. [FRAMING:representation]
  const max = Math.max(...l.rows.map((r) => Math.abs(r.cost.value)), 1);
  const rows = l.rows
    .map((r) => {
      const colour = ACTIVITY_COLOR[r.key as Activity] ?? '#55503F';
      const below = r.cost.value < 0 ? ' below' : '';
      return `<tr>
        <th scope="row"><span class="swatch" style="--c:${colour}"></span>${esc(r.key)}</th>
        <td class="bar"><span class="${below.trim()}" style="width:${(Math.abs(r.cost.value) / max) * 100}%;--c:${colour}"></span></td>
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
      // The tooltip carries the dominance share, so a band coloured `toolResult` at 51%
      // does not read as the same claim as one at 98%.
      return `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${Math.max(1, x1 - x0).toFixed(1)}" height="${h.toFixed(1)}" fill="${SOURCE_COLOR[st.source]}" opacity="0.82"><title>${esc(st.label)} — born call ${st.bornAtCall}, ${n(st.tokens)} tokens, alive to call ${ep.endCall}
mostly ${st.source} (${pct(st.sourceShare)} of the characters that arrived here)</title></rect>`;
    })
    .join('');

  // Invalidations cluster, and every label was drawn on the same baseline at the same
  // offset — so on a session with five of them the words overprinted each other into
  // "93,640hee-invalidated". Each label drops a row until it clears the previous one,
  // and one close to the right edge is anchored from its line so it cannot run off the
  // chart. Both are decided from the x it will actually be drawn at.
  const LABEL_ROW = 11;
  const CHAR_W = 5.4;
  /** Rightmost x already occupied on each row. A label takes the first row whose
   * occupied span it clears, which is what "does this collide" actually means —
   * comparing only against the PREVIOUS label lets a third one land back on row 0
   * underneath the first. */
  const rowEnds: number[] = [];
  const cliffs = s.epochs
    .slice(1)
    .map((e) => {
      const cx = x(e.startCall);
      const text = `cache invalidated · ${n(e.rewrittenTokens)} re-written`;
      const width = text.length * CHAR_W;
      const flip = cx + width > W - PAD.r;
      const free = rowEnds.findIndex((end) => cx > end);
      const row = free === -1 ? rowEnds.length : free;
      rowEnds[row] = cx + width;
      return `<line x1="${cx.toFixed(1)}" y1="${PAD.t}" x2="${cx.toFixed(1)}" y2="${H - PAD.b}" class="cliff"/>
         <text x="${(cx + (flip ? -5 : 5)).toFixed(1)}" y="${PAD.t + 10 + row * LABEL_ROW}" class="cliff-label"${flip ? ' text-anchor="end"' : ''}>${text}</text>`;
    })
    .join('');

  const ticks = [0, 0.5, 1]
    .map((f) => {
      const v = peak * f;
      return `<line x1="${PAD.l}" y1="${y(v).toFixed(1)}" x2="${W - PAD.r}" y2="${y(v).toFixed(1)}" class="grid"/>
              <text x="${PAD.l - 8}" y="${(y(v) + 3).toFixed(1)}" class="axis" text-anchor="end">${n(v / 1000)}k</text>`;
    })
    .join('');

  // Each key carries how much of the arena that source dominates, so the legend says
  // what the picture is made of rather than only which colours appear in it.
  const totalTokens = Math.max(1, s.strata.reduce((a, st) => a + st.tokens, 0));
  const legend = (Object.keys(SOURCE_COLOR) as Array<Stratum['source']>)
    .filter((k) => s.strata.some((st) => st.source === k))
    .map((k) => {
      const share = s.strata.filter((st) => st.source === k).reduce((a, st) => a + st.tokens, 0) / totalTokens;
      return `<span class="key"><i style="--c:${SOURCE_COLOR[k]}"></i>${k} <b>${pct(share)}</b></span>`;
    })
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

/** The trust bar: which tier of the cascade decided each share of the spend.
 *
 * The unclassified figure is stated ALWAYS, including when it is zero. A page that
 * mentions its unknowns only when it has some teaches the reader to read silence as
 * "none", and silence is also what a broken honesty bucket looks like. Saying "0.0%
 * unclassified" is a claim that can be wrong; saying nothing is not. */
function coverageBar(cov: Coverage): string {
  const seg = (Object.entries(cov.byTier) as Array<[string, number]>)
    // A zero-width segment cannot be drawn; the figure it would carry is in the note.
    .filter(([, v]) => v > 0.0005)
    .map(
      ([k, v]) =>
        `<span class="cov-seg cov-${k}" style="width:${v * 100}%"><em>${k} ${pct(v)}</em></span>`,
    )
    .join('');
  return `<div class="coverage">
    <div class="cov-bar">${seg}</div>
    <p class="cov-note">How every percentage on this page was decided.
      <strong>${pct(cov.unclassified)} of spend is unclassified</strong> — carried as its own
      row rather than distributed across the others.</p>
  </div>`;
}

/** How much the per-call reconciliation has to say, and what it found.
 *
 * [LAW:types-are-the-program] A four-way status rather than a boolean. `callsChecked
 * === 0` is a distinct state — no predictable calls, so the model made no individual
 * predictions to check — not a degenerate case of "exact": a session where every call
 * opened its own epoch would otherwise print a 0-of-0 match through the same "ok" badge
 * a real reconciliation earns, the exact vacuous-match presentation excluding
 * epoch-openers from `exactCalls` was introduced to eliminate, just relocated from a
 * guaranteed N-of-N to a guaranteed 0-of-0. And `callsChecked === 0` has two distinct
 * CAUSES that must not share one narration: a root conversation can legitimately make
 * zero API calls at all (every call delegated to a spawned agent — `rootCalls === 0`),
 * in which case no call opened or failed to open an epoch, versus a root conversation
 * with calls where every one of them opened its own epoch (`rootCalls > 0`). Conflating
 * them would print "every call here opened its own epoch" for a session with no calls
 * to have done so. [LAW:no-silent-failure] */
function residencyCheck(cons: Conservation): string {
  const status =
    cons.rootCalls === 0
      ? 'no-calls'
      : cons.callsChecked === 0
        ? 'no-predictable'
        : cons.callsExact === cons.callsChecked
          ? 'exact'
          : 'mismatch';
  const badge = { 'no-calls': 'note', 'no-predictable': 'note', exact: 'ok', mismatch: 'warn' }[status];
  const headline = {
    'no-calls': 'No root calls in this session',
    'no-predictable': 'No predictable calls in this session',
    exact: 'Residency reconstruction is exact',
    mismatch: 'Residency reconstruction does not reconcile',
  }[status];
  const reconciliation = `Two independent routes to total cache-read — the API's own
       reported figure (${n(cons.actualCacheRead)}) and the residency model's prediction
       (${n(cons.predictedCacheRead)}) — agree on <b>${cons.callsExact} of
       ${cons.callsChecked}</b> predictable calls individually (epoch-opening calls,
       which have nothing to predict from, are excluded).`;
  const detail = {
    'no-calls': `Every call here was delegated to a spawned agent — the root transcript
         itself made no API calls, so there is nothing for the residency model to
         predict or reconcile at this level.`,
    'no-predictable': `Every call here opened its own epoch — the cached prefix never
         survived from one call to the next — so the residency model had no individual
         prediction to make. The two aggregate routes to total cache-read still agree
         (${n(cons.actualCacheRead)} actual vs ${n(cons.predictedCacheRead)} predicted),
         but that agreement is trivial with nothing to check it against.`,
    exact: reconciliation,
    mismatch: reconciliation,
  }[status];
  return `<div class="check ${badge}">
    <b>${headline}</b>
    <p>${detail}</p>
  </div>`;
}

/** How much of the arena rests on exact numbers rather than on chars/4.
 *
 * Sits beside the coverage bar because it answers the same question on a different axis:
 * coverage says how the page's LABELS were decided, this says how its SIZES were. The
 * stratigraphy stacks one arrival the API measures exactly — every call's assistant
 * output, reasoning included — against three reconstructed from characters, and a
 * picture that does not say which is which invites the reader to trust all of it
 * equally. Stated always, including at 100%, for coverageBar's reason: a figure that
 * appears only when it is bad teaches the reader to read its absence as "fine". */
function arenaBasisCheck(b: ArenaBasis): string {
  return `<div class="check note">
    <b>Arena sizes are ${pct(b.exactShare)} exact</b>
    <p>${n(b.exactTokens)} of the ${n(b.exactTokens + b.estimatedTokens)} tokens stacked in
    the stratigraphy come straight from an API <code>usage</code> block. The remaining
    ${n(b.estimatedTokens)} — tool results, user text, attachments — are reconstructed
    from characters, which ranks causes and never adjusts an exact number.</p>
  </div>`;
}

/** What the dollar figure covers, and what it does not.
 *
 * Sits with the other trust checks because it answers their question on the money axis:
 * coverage says how the LABELS were decided, the arena check says how the SIZES were,
 * and this says what the PRICE rests on. Every figure here is stated at zero as well —
 * "everything on this page was priced" is a claim a reader can hold the page to, while
 * silence is also what an unpriced corpus looks like. [LAW:no-silent-failure]
 *
 * The two gaps are separate rows because they are separate failures with separate fixes:
 * a model with no published rate needs a rate card, a model with no measured tokenizer
 * needs more of its calls in the corpus. Collapsing them into one "unknown" percentage
 * would tell a reader something is wrong and nothing about which. */
function pricingCheck(p: PriceTotals, out: OutputTotals): string {
  const total = p.pricedSpend + p.unpricedSpend;
  const priced = total === 0 ? 1 : p.pricedSpend / total;
  const rows = [
    p.unpriced.length === 0
      ? `<p>Every one of the ${n(p.calls)} calls ran a model with a published rate, so
         ${dollars(p.usd)} is the whole bill rather than a floor.</p>`
      : `<p><strong>${dollars(p.usd)} covers ${pct(priced)} of spend.</strong> The remaining
         ${n(p.unpricedSpend)} token-equivalents across ${n(p.unpricedCalls)} calls ran
         ${p.unpriced.map((u) => `<code>${esc(u.model)}</code>`).join(', ')}, for which this
         report holds no rate. They are priced at nothing rather than at some other model's
         rate, so the total above accounts for the priced share and infers nothing for the
         rest.</p>`,
    out.uncalibratedModels.length === 0
      ? `<p>Every output token was split against a tokenizer measured for its own model.</p>`
      : `<p><strong>${pct(out.uncalibrated / Math.max(1, out.total))} of output tokens could not
         be split.</strong> ${n(out.uncalibrated)} tokens across ${n(out.uncalibratedCalls)} calls
         ran ${out.uncalibratedModels.map((m) => `<code>${esc(m)}</code>`).join(', ')}, and this
         corpus holds too few calls from those models that emitted no thinking block — the only
         free source of exact tokenizer calibration. Their output is counted in the exact total
         and attributed to neither reasoning nor visible text.</p>`,
  ];
  // The colour follows what the gap COSTS, not whether one exists. This corpus has 12
  // calls on a model with no rate card whose usage vector is all zeros, and painting that
  // red would spend the reader's alarm on nothing and teach them to ignore the border.
  // The numbers are stated in full either way; only the emphasis moves.
  const material = p.unpricedSpend / Math.max(1, total) > 0.005 ||
    out.uncalibrated / Math.max(1, out.total) > 0.005;
  return `<div class="check wide ${material ? 'warn' : 'note'}">
    <b>What the money rests on</b>
    ${rows.join('')}
  </div>`;
}

/** The measured tokenizer, per model, with the error bar that says how far to trust it.
 *
 * These are the coefficients the arithmetic on this page actually used, read out of the
 * fit rather than transcribed — the estimator publishing its own calibration is the only
 * version of this table that cannot go stale. [LAW:one-source-of-truth] */
function calibrationTable(cal: Calibration): string {
  const rows = cal.rows
    .map(
      (r) => `<tr>
        <th scope="row"><code>${esc(r.model)}</code></th>
        <td class="num">${r.charsPerToken.toFixed(2)}</td>
        <td class="num">${r.tokensPerBlock.toFixed(1)}</td>
        <td class="num">${n(r.points)}</td>
        <td class="num ${Math.abs(r.heldOutError) > 0.05 ? 'below' : ''}">${(r.heldOutError * 100).toFixed(1)}%</td>
      </tr>`,
    )
    .join('');
  const uncalibrated = cal.seen.filter((m) => !cal.rows.some((r) => r.model === m));
  return `<div class="check note wide">
    <b>How the output split was calibrated</b>
    <p>A call that emitted no thinking block was billed <code>output_tokens</code> for exactly
      the blocks a reader can see, so every such call is a free, exact measurement of that
      model's tokenizer. These coefficients are fit per model id over every transcript on this
      machine, and scored on transcripts the fit never saw.</p>
    <table class="calib"><thead><tr>
      <th>model</th><th class="num">chars/token</th><th class="num">tokens/block</th>
      <th class="num">calibration calls</th><th class="num">held-out error</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <p>${
      uncalibrated.length === 0
        ? 'Every model id in the corpus produced a usable fit.'
        : `No usable fit for ${uncalibrated.map((m) => `<code>${esc(m)}</code>`).join(', ')} — too few calls that emitted no thinking block. Output from those models is counted but not split.`
    } Dollar rates are a separate matter and are not measured from any corpus: ${esc(cal.priceSource)}</p>
  </div>`;
}

/** Which sessions the page was built from, and every filter that decided it.
 *
 * The wording is deliberately true at both ends of the range — "24 of the 24 sessions
 * found" reads correctly when nothing was excluded — so the honest disclosure needs no
 * conditional and cannot be left in a state that only one branch keeps true.
 * [LAW:dataflow-not-control-flow] */
const selectionNote = (s: Selection): string => `<section class="panel">
      <h3>What this page covers</h3>
      <p class="lede">${n(s.rendered)} of the ${n(s.discovered)} sessions found under the
        projects directory. Every figure on this page describes those ${n(s.rendered)}
        sessions and nothing beyond them.</p>
      <ul class="criteria">${s.criteria.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    </section>`;

/** The corpus view.
 *
 * PROJECT.md's founding question — how much goes to reviewing versus making changes —
 * is a question about a HISTORY, not about one session. The corpus ledgers answering it
 * were being computed and then never rendered, so the corpus view was just the session
 * rail and the page could not answer the question it exists for.
 *
 * The share of spend that is unclassified is stated beside the answer rather than in a
 * footnote, because with 14% unknown corpus-wide, "0.6% review" and "0.6% review, 14%
 * unknown" are different claims and only the second one is true. */
function corpusSection(c: CorpusReport): string {
  const activity = c.ledgers.find((l) => l.id === 'corpus-activity');
  const shareOf = (key: string): number =>
    activity?.rows.find((r) => r.key === key)?.share ?? 0;

  const calls = c.sessions.reduce((a, s) => a + s.calls.length, 0);
  const spanned = {
    from: Math.min(...c.sessions.map((s) => s.startedAt)),
    to: Math.max(...c.sessions.map((s) => s.endedAt)),
  };
  // Keyed on workspace identity rather than display name: two checkouts can share a leaf
  // name, and counting by what the heading says would quietly merge them.
  const projects = new Set(c.sessions.map((s) => workspaceKey(s.workspace))).size;
  const { eyebrow, title } = framing(c.selection);

  return `<article class="session corpus on" data-panel="corpus">
    <header class="masthead">
      <div class="mh-left">
        <div class="eyebrow">${esc(eyebrow)}</div>
        <h2>${esc(title)}</h2>
        <div class="sub">${c.sessions.length} sessions · ${projects} projects · ${day(spanned.from)} — ${day(spanned.to)}</div>
      </div>
      <div class="mh-right">
        <div class="total">${n(c.total.value)}</div>
        <div class="total-unit">token-equivalents<br><span>input×1 + cache-write×1.25 + cache-read×0.1, plus output</span></div>
        <div class="total-usd">${dollars(c.pricing.usd)}</div>
      </div>
    </header>

    <div class="strip">
      <div><b>${c.sessions.length}</b><span>sessions</span></div>
      <div><b>${n(calls)}</b><span>API calls</span></div>
      <div><b>${dollars(c.pricing.usd)}</b><span>total</span></div>
      <div><b>${n(c.total.value / Math.max(1, calls))}</b><span>tok-eq per call</span></div>
      <div><b>${pct(c.output.reasoning / Math.max(1, c.output.total))}</b><span>output was reasoning</span></div>
      <div><b>${pct(c.coverage.unclassified)}</b><span>unclassified</span></div>
    </div>

    <section class="panel founding">
      <h3>The founding question</h3>
      <p class="lede">"How much do I spend reviewing versus actually making changes?" Every
        call in every session above belongs to exactly one activity, so this is a query
        over real history rather than an impression.</p>
      <div class="fq">
        <div class="fq-cell"><b>${pct(shareOf('review'))}</b><span>review</span></div>
        <div class="fq-cell"><b>${pct(shareOf('implementation'))}</b><span>implementation</span></div>
        <div class="fq-cell"><b>${pct(shareOf('exploration'))}</b><span>exploration</span></div>
        <div class="fq-cell muted"><b>${pct(shareOf('unclassified'))}</b><span>unclassified</span></div>
      </div>
      <p class="cov-note">The last figure is the honest one: that share of spend matched no
        marker and no tool signature, and is counted nowhere else on this page.</p>
    </section>

    <div class="ledgers">${c.ledgers.map(ledgerBlock).join('')}</div>

    ${selectionNote(c.selection)}

    <section class="panel">
      <h3>How much to trust this page</h3>
      ${coverageBar(c.coverage)}
      <div class="checks">
        ${pricingCheck(c.pricing, c.output)}
        ${calibrationTable(c.calibration)}
      </div>
    </section>
  </article>`;
}

function sessionSection(s: SessionReport, idx: number): string {
  const wall = s.endedAt - s.startedAt;
  const cons = s.conservation;
  return `<article class="session" id="s-${idx}" data-panel="${idx}">
    <header class="masthead">
      <div class="mh-left">
        <div class="eyebrow">Statement of account</div>
        <h2>${esc(s.workspace.name)}</h2>
        <div class="sub">session ${esc(s.sessionId.slice(0, 8))} · ${esc(s.model)} · ${day(s.startedAt)} · ${dur(wall)} wall</div>
      </div>
      <div class="mh-right">
        <div class="total">${n(s.total.value)}</div>
        <div class="total-unit">token-equivalents<br><span>input×1 + cache-write×1.25 + cache-read×0.1, plus output</span></div>
        <div class="total-usd">${dollars(s.pricing.usd)}</div>
      </div>
    </header>

    <div class="strip">
      <div><b>${s.calls.length}</b><span>API calls</span></div>
      <div><b>${n(s.usage.cacheRead)}</b><span>tokens re-read</span></div>
      <div><b>${(s.usage.cacheRead / Math.max(1, s.usage.cacheCreation)).toFixed(1)}:1</b><span>read : write</span></div>
      <div><b>${s.epochs.length}</b><span>cache epoch${s.epochs.length === 1 ? '' : 's'}</span></div>
      <div><b>${Math.max(0, ...s.calls.map((c) => c.depth))}</b><span>max spawn depth</span></div>
      <div><b>${pct(s.output.reasoning / Math.max(1, s.output.total))}</b><span>output was reasoning</span></div>
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
      ${coverageBar(s.coverage)}
      <div class="checks">
        ${pricingCheck(s.pricing, s.output)}
        ${residencyCheck(cons)}
        ${arenaBasisCheck(s.arenaBasis)}
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
  // The synopsis is what distinguishes two sessions of the same project — without it,
  // five entries all read "home-infra" and the rail is a list of indistinguishable rows.
  const index = c.sessions
    .map(
      (s, i) => `<li><button data-go="${i}">
        <span class="ix-proj">${esc(s.workspace.name)}</span>
        <span class="ix-cost">${dollars(s.pricing.usd)}</span>
        <span class="ix-syn">${esc(s.synopsis)}</span>
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
/* Two lines, clamped: enough of the synopsis to tell two sessions of one project
   apart, not so much that the rail becomes the report. */
.ix-syn{display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
  font-size:11px; line-height:1.35; color:var(--ink-2); margin-top:3px}
.ix-sub{display:block; font-size:10.5px; color:var(--ink-3); font-family:var(--mono); margin-top:3px}
.rail ul.overview{border-bottom:1px solid var(--rule)}
.rail ul.overview .ix-proj{font-family:var(--display); font-size:15px; max-width:none}

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
/* min-width, because a nowrap note is unshrinkable and the table gave it the room by
   taking it from here — on the output ledger the bar column collapsed to nothing and
   every ledger row rendered barless. */
.ledger .bar{width:38%; min-width:86px}
.ledger .bar span{display:block; height:7px; background:var(--c); opacity:.72}
/* A row below zero: hatched rather than solid, so it reads as "this went the other
   way" at a glance instead of as an ordinary share of the total. */
.ledger .bar span.below{background:repeating-linear-gradient(135deg,var(--c) 0 3px,transparent 3px 6px); opacity:.9}
.swatch{display:inline-block; width:8px; height:8px; background:var(--c); margin-right:7px}

/* the founding question */
.fq{display:grid; grid-template-columns:repeat(4,1fr); gap:0; border-top:1px solid var(--ink);
  border-bottom:1px solid var(--rule); margin-bottom:10px}
.fq-cell{padding:16px 0 14px; border-right:1px solid var(--rule-2)}
.fq-cell:last-child{border-right:0}
.fq-cell b{display:block; font-family:var(--display); font-size:38px; line-height:1; letter-spacing:-.02em}
.fq-cell span{font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-3)}
.fq-cell.muted b{color:var(--ink-3)}

/* trust */
.coverage{margin-bottom:18px}
.cov-bar{display:flex; height:22px; border:1px solid var(--rule); background:var(--paper-2)}
.cov-seg{position:relative; overflow:hidden}
.cov-seg em{position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  font-style:normal; font-size:9.5px; letter-spacing:.08em; text-transform:uppercase; color:#F4F1E9; white-space:nowrap}
.cov-hand{background:var(--ink)} .cov-marker{background:var(--green)}
.cov-rule{background:var(--brass)} .cov-judge{background:#3E6B8A} .cov-none{background:#B3AB9C}
.cov-note{font-size:12px; color:var(--ink-2); margin:7px 0 0}
.criteria{margin:0; padding-left:18px; color:var(--ink-2); font-size:12px; line-height:1.65}
.criteria li{margin:0 0 3px}
.checks{display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr)); gap:26px}
.check{border-left:3px solid var(--rule); padding-left:14px; font-size:12.5px; color:var(--ink-2)}
.check.ok{border-left-color:var(--green)}
.check.warn{border-left-color:var(--red)}
.check b{display:block; color:var(--ink); margin-bottom:3px; font-size:13px}
.check code{font-family:var(--mono); font-size:11.5px}
.check ul{margin:4px 0 0; padding-left:16px}
.check li{margin:2px 0}
.check p{margin:4px 0 0}
/* The calibration table is a rate card, not a sidebar note: it needs the full width to
   stay readable, so it opts out of the auto-fit column grid the other checks share. */
.check.wide{grid-column:1/-1}
table.calib{width:100%; border-collapse:collapse; margin:8px 0; font-family:var(--mono); font-size:11.5px}
table.calib th,table.calib td{padding:3px 10px 3px 0; text-align:left; border-bottom:1px solid var(--rule); font-weight:400}
table.calib thead th{color:var(--ink-2); border-bottom-width:2px}
table.calib .num{text-align:right; white-space:nowrap}
table.calib .below{color:var(--red)}
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
        <b>${dollars(c.pricing.usd)}</b>
        <span>${c.sessions.length} sessions · ${n(c.total.value)} tok-eq</span>
      </div>
    </div>
    <ul class="overview"><li><button data-go="corpus" class="on">
      <span class="ix-proj">${esc(framing(c.selection).title)}</span>
      <span class="ix-syn">the corpus, and the founding question</span>
    </button></li></ul>
    <h2>Sessions by cost</h2>
    <ul>${index}</ul>
  </nav>
  <main class="main">${corpusSection(c)}${c.sessions.map(sessionSection).join('')}</main>
</div>
<script>
// Panels are addressed by KEY, not by position. An earlier version matched the nth
// article to the nth button, so adding the corpus overview at the top would have
// silently shifted every session by one.
const show = (key) => {
  document.querySelectorAll('[data-panel]').forEach((el) => el.classList.toggle('on', el.dataset.panel === key));
  document.querySelectorAll('.rail button').forEach((b) => b.classList.toggle('on', b.dataset.go === key));
  document.querySelector('.main').scrollTo(0, 0);
  window.scrollTo(0, 0);
};
document.querySelectorAll('.rail button').forEach((b) =>
  b.addEventListener('click', () => show(b.dataset.go)));
// Exposed so the screenshot harness can select a panel without synthesising a click.
window.show = show;
show('corpus');
</script>
</body></html>`;
}
