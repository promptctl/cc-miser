// Project an analysed session into the report model.
//
// [LAW:decomposition] The one place the analysis is turned into what a page shows.
// It derives presentation facts — ledgers, findings, coverage, strata — and never
// recomputes an exact number: every `usage` here came off the span tree unchanged.
//
// [LAW:effects-at-boundaries] Pure. Analysis in, model out.

import type { AnalyzedSession } from '../session.ts';
import { isSessionControl, type Arrival, type Turn } from '../calls.ts';
import { invalidationExcess, trueCost } from '../residency.ts';
import { allCalls, isSpawned, isToolSpan, rollup, rollupWhere, type Span } from '../spans.ts';
import { depthOf } from '../lineage.ts';
import {
  CACHE_READ_MULTIPLE,
  WRITE_MULTIPLE,
  eqCost,
  inputEquivalents,
  spend,
  type Usage,
} from '../tokens.ts';
import {
  canonicalModelId,
  priceCalls,
  tokenizerFor,
  type ModelTable,
  type PriceTotals,
} from '../models.ts';
import { totalOutput, type OutputTotals } from '../output.ts';
import type { Tier } from '../activity.ts';
import type {
  ArenaBasis,
  CallRow,
  Coverage,
  Finding,
  FlameNode,
  Ledger,
  SessionReport,
  Stratum,
  StratumSource,
} from './model.ts';

const fmt = (n: number): string => Math.round(n).toLocaleString();
const pct = (n: number, d: number): string => (d === 0 ? '0.0' : ((n / d) * 100).toFixed(1));

export function projectSession(a: AnalyzedSession, models: ModelTable): SessionReport {
  const callSpans = allCalls(a.tree);
  const exact = rollup(a.tree);
  // Every call in the session, spawned ones included, so the output split covers the
  // same population as `exact` above. Call SPANS carry usage but not content blocks,
  // and the split needs the blocks — so it is taken from the conversations, which is
  // where blocks live. [LAW:one-source-of-truth] The two populations must match or the
  // reasoning share would be a fraction of a different denominator than it is shown
  // against.
  const output = totalOutput(
    [...a.conversation.calls, ...a.forest.placed.flatMap((p) => p.conversation.calls)],
    models,
  );
  // [LAW:one-source-of-truth] Both figures come from ONE traversal with different
  // predicates, never from subtracting one from the other.
  const spawnedOnly = rollupWhere(a.tree, isSpawned);
  const grandTotal = spend(exact);

  const calls: CallRow[] = callSpans.map((s) => ({
    index: s.callFirst,
    ts: s.tStart,
    model: s.detail.model,
    usage: s.detail.usage,
    depth: depthOf(s.lineage),
    lineage: s.lineage.map((sp) => ({ ...sp })),
    label: s.detail.label,
    tools: s.children.filter(isToolSpan).map((k) => ({
      name: k.detail.name,
      summary: k.detail.summary,
      resultChars: k.detail.resultChars,
    })),
  }));

  /** Group the calls by any key and price each bucket.
   *
   * [LAW:composability] One function, N ledgers — the key is a value crossing the
   * boundary, not a family of byActivity/byDepth/byModel functions. */
  const ledgerBy = (
    id: string,
    title: string,
    lede: string,
    keyOf: (c: CallRow) => string,
    noteOf: (rows: CallRow[]) => string = () => '',
  ): Ledger => {
    const buckets = new Map<string, CallRow[]>();
    for (const c of calls) buckets.set(keyOf(c), [...(buckets.get(keyOf(c)) ?? []), c]);
    return {
      id,
      title,
      lede,
      rows: [...buckets.entries()]
        .map(([key, rs]) => {
          const v = rs.reduce((acc, r) => acc + spend(r.usage), 0);
          return { key, cost: eqCost(v), share: v / grandTotal, calls: rs.length, note: noteOf(rs) };
        })
        .sort((x, y) => y.cost.value - x.cost.value),
    };
  };

  // Computed once and shared by the header figure and the findings, so the punch list
  // and the number at the top of the page cannot disagree. [LAW:one-source-of-truth]
  const pricing = priceCalls(calls);

  const agentShare = (rs: CallRow[]): string => {
    const tot = rs.reduce((acc, r) => acc + spend(r.usage), 0);
    const ag = rs.filter((r) => r.depth > 0).reduce((acc, r) => acc + spend(r.usage), 0);
    return tot === 0 ? '' : `${((ag / tot) * 100).toFixed(0)}% agent-driven`;
  };

  const toolLedger = (): Ledger => {
    const buckets = new Map<string, { v: number; n: number }>();
    for (const c of calls) {
      const per = c.tools.length === 0 ? 0 : spend(c.usage) / c.tools.length;
      for (const t of c.tools) {
        const b = buckets.get(t.name) ?? { v: 0, n: 0 };
        buckets.set(t.name, { v: b.v + per, n: b.n + 1 });
      }
    }
    return {
      id: 'tool',
      title: 'By tool',
      lede: "A call's cost split evenly across the tools it issued — an ESTIMATE for ranking, not an audit.",
      rows: [...buckets.entries()]
        .map(([key, b]) => ({
          key,
          cost: eqCost(b.v),
          share: b.v / grandTotal,
          calls: b.n,
          note: `${b.n} calls`,
        }))
        .sort((x, y) => y.cost.value - x.cost.value),
    };
  };

  /** What the output tokens bought. The one ledger whose rows are not all the same
   * kind of number, so it says which is which in the row itself rather than in a
   * footnote nobody reads. */
  const outputLedger = (o: OutputTotals): Ledger => {
    // THREE rows, and the third is the point. `visible` is summed over every call while
    // `reasoning` is claimed only on the calls that emitted a thinking block, so the two
    // do not close: what is left is this estimator's error on the calls where the true
    // reasoning is zero. Shown as its own row — including when it is negative — because
    // two rows adding to 101.6% is a page inviting the reader to find the missing 1.6%
    // themselves, and the answer is a number we already have.
    // Keys stay short. Every row here is an estimate and the lede says so once, so
    // tagging each one "(estimated)" restated it at the same altitude while squeezing
    // the bar column to nothing — the ledger rendered with no bars at all.
    // FOUR rows now, and the fourth is what keeps the first three honest. An
    // uncalibrated call's output belongs to no estimate at all — there is no tokenizer
    // for its model — so it cannot be folded into any of the others without inventing an
    // attribution. Given its own row, the ledger still closes on the exact total; folded
    // away, the page would have shown three rows summing to less than the figure above
    // them and no explanation of the difference. Stated at zero for the same reason the
    // others are.
    const rows: Array<[string, number, string]> = [
      ['reasoning', o.reasoning, `${o.callsWithReasoning} of ${o.calls} calls thought`],
      ['visible text and tool calls', o.visible, 'what a reader can see'],
      ['estimator error', o.estimatorError, 'where the true answer is 0'],
      [
        'uncalibrated',
        o.uncalibrated,
        o.uncalibratedCalls === 0
          ? 'every model was calibrated'
          : `${o.uncalibratedCalls} calls on ${o.uncalibratedModels.join(', ')}`,
      ],
    ];
    return {
      id: 'output',
      title: 'What the output tokens bought',
      lede: `${fmt(o.total)} output tokens is an EXACT figure, and the four rows below close on it exactly. The split is not exact: reasoning is whatever the visible blocks fail to explain, so it carries the estimator's error, the third row is that error measured where the true answer is known to be zero, and the fourth is output from models this corpus could not calibrate at all — counted, but attributed to neither.`,
      rows: rows.map(([key, v, note]) => ({
        key,
        cost: eqCost(v),
        share: v / Math.max(1, o.total),
        calls: 0,
        note,
      })),
    };
  };

  const cacheLedger = (): Ledger => {
    const parts: Array<[string, number]> = [
      ['uncached input', exact.input],
      [`cache writes (${WRITE_MULTIPLE}x)`, exact.cacheCreation * WRITE_MULTIPLE],
      [`cache reads (${CACHE_READ_MULTIPLE}x)`, exact.cacheRead * CACHE_READ_MULTIPLE],
      ['output', exact.output],
    ];
    return {
      id: 'cache',
      title: 'Cache economics',
      lede: `${fmt(exact.cacheRead)} tokens were re-read against ${fmt(exact.cacheCreation)} written — a ${(exact.cacheRead / Math.max(1, exact.cacheCreation)).toFixed(1)}:1 ratio. Re-reading is where a long session's money goes.`,
      rows: parts.map(([key, v]) => ({
        key,
        cost: eqCost(v),
        share: v / grandTotal,
        calls: 0,
        note: '',
      })),
    };
  };

  // Coverage by tier — required by the model, so percentages cannot be shown without
  // their basis. The `none` bucket is computed even when it is zero.
  const byTier: Record<Tier, number> = { marker: 0, rule: 0, judge: 0, hand: 0, none: 0 };
  for (const c of calls) byTier[c.label.tier] += spend(c.usage) / grandTotal;
  const coverage: Coverage = {
    byTier,
    unclassified:
      calls
        .filter((c) => c.label.activity === 'unclassified')
        .reduce((acc, c) => acc + spend(c.usage), 0) / grandTotal,
  };

  return {
    sessionId: a.source.sessionId,
    project: a.source.project,
    startedAt: a.tree.tStart,
    endedAt: a.tree.tEnd,
    // EVERY model the session ran, not the first call's.
    //
    // A session is routinely multi-model: spawned agents run whatever their definition
    // names, and this corpus has Haiku appearing only inside subagents. Naming the first
    // call's model made the page state, as a fact about the session, something that was
    // true of one call — and it is the exact assumption this ticket is here to remove,
    // since the pricing beneath it is now per call.
    model: [...new Set(calls.map((c) => canonicalModelId(c.model)))].sort().join(', '),
    usage: exact,
    total: eqCost(grandTotal),
    // Priced per call at each model's own rate and each call's own instant, then summed
    // — never the session's aggregate usage at one model's rate, which is what a single
    // global rate pair forced and what made every multi-model session's dollar figure
    // wrong. [LAW:one-source-of-truth]
    pricing,
    calls,
    epochs: a.residency.epochs.map((e) => ({
      index: e.index,
      startCall: e.start,
      endCall: e.end,
      rewrittenTokens: e.rewrittenTokens,
      gapBeforeMs: e.gapBeforeMs,
      excess: eqCost(invalidationExcess(e)),
    })),
    conservation: {
      actualCacheRead: a.conservation.actualCacheRead,
      predictedCacheRead: a.conservation.predictedCacheRead,
      callsChecked: a.conversation.calls.length,
      callsExact: a.conservation.exactCalls,
    },
    coverage,
    arenaBasis: arenaBasisOf(a.conversation.arrivals),
    output,
    ledgers: [
      outputLedger(output),
      ledgerBy(
        'activity',
        'By activity',
        'What phase of the work the tokens were buying. Activities partition the calls, so these sum to the whole session.',
        (c) => c.label.activity,
        agentShare,
      ),
      ledgerBy(
        'depth',
        'By spawn depth',
        'Depth 0 is the conversation a human can read. Everything below it is agent-driven and normally invisible.',
        (c) => (c.depth === 0 ? 'main conversation' : `spawned depth ${c.depth}`),
      ),
      toolLedger(),
      cacheLedger(),
    ],
    findings: findingsFor(a, exact, spawnedOnly, grandTotal, output, pricing, models, calls),
    strata: strataFor(a),
    flame: flameOf(a.tree),
    synopsis: synopsisFor(a, calls),
    notes: a.notes,
  };
}

/** The punch list. Each finding names the thing, its price, and its share — an
 * observation without a price is not actionable, so the model requires the cost. */
function findingsFor(
  a: AnalyzedSession,
  exact: Usage,
  spawnedOnly: Usage,
  grandTotal: number,
  output: OutputTotals,
  pricing: PriceTotals,
  models: ModelTable,
  calls: readonly CallRow[],
): Finding[] {
  const findings: Finding[] = [];

  // What the estimator was actually calibrated at, for the models this session ran —
  // read out of the same fits the arithmetic used rather than restated from a constant.
  // [LAW:one-source-of-truth]
  const usedModels = [...new Set(calls.map((c) => canonicalModelId(c.model)))].sort();
  const coefficients = usedModels
    .map((m) => ({ m, fit: tokenizerFor(models, m) }))
    .filter((x) => x.fit.found)
    .map((x) =>
      x.fit.found
        ? `${x.m} at ${x.fit.value.charsPerToken.toFixed(2)} chars/token plus ${x.fit.value.tokensPerBlock.toFixed(0)} per block (${(x.fit.value.heldOutError * 100).toFixed(1)}% held-out error over ${fmt(x.fit.value.points)} calibration calls)`
        : '',
    );

  // Reasoning is the largest single thing the transcript does not show you, and until
  // this ticket it was the largest thing this report did not show you either. It is
  // stated for every session — including the ones that did none, where the row reads
  // zero — because a figure that appears only when it is large teaches the reader to
  // read its absence as "small" rather than "not measured".
  findings.push({
    headline:
      output.reasoning > 0
        ? `Reasoning was ${pct(output.reasoning, Math.max(1, output.total))}% of output tokens`
        : 'No reasoning tokens in this session',
    detail: `${fmt(output.reasoning)} of ${fmt(output.total)} output tokens went to thinking the model did not show, across ${output.callsWithReasoning} of ${output.calls} calls. Billed as output at the full output rate, and — measured against exact prompt sizes — resident in the context window for the rest of its cache epoch, exactly like text you can read. The split is an ESTIMATE: output totals are exact, the visible part is reconstructed from characters using coefficients measured for each model separately — ${coefficients.length > 0 ? coefficients.join('; ') : 'none of this session’s models could be calibrated'} — and reasoning is the difference. The same arithmetic on calls that did no thinking returns ${fmt(Math.abs(output.estimatorError))} tokens where the true answer is zero, which is the error bar.`,
    cost: eqCost(output.reasoning),
    shareOfSession: output.reasoning / grandTotal,
    severity: output.reasoning / grandTotal > 0.05 ? 'high' : 'note',
  });

  // WHAT THE PAGE COULD NOT ACCOUNT FOR. Stated for every session, at zero as well as
  // above it, for the same reason the reasoning row is: a figure that appears only when
  // it is non-zero teaches a reader that its absence means "none" when it may mean
  // "never checked". This is the visible half of the loud failure — an unrecognised
  // model is quarantined into a named bucket here rather than silently priced at some
  // other model's rates. [LAW:no-silent-failure]
  const unpricedShare = pricing.unpricedSpend / Math.max(1, grandTotal);
  const uncalibratedShare = output.uncalibrated / Math.max(1, output.total);
  const gaps = [
    ...(pricing.unpriced.length > 0
      ? [
          `Could not price ${fmt(pricing.unpricedSpend)} token-equivalents (${pct(pricing.unpricedSpend, grandTotal)}% of this session) across ${pricing.unpricedCalls} calls: ${pricing.unpriced.map((u) => u.why).join('; ')}. Those calls contribute nothing to the dollar figure, which is therefore a floor rather than a total.`,
        ]
      : []),
    ...(output.uncalibratedModels.length > 0
      ? [
          `Could not split ${fmt(output.uncalibrated)} output tokens (${pct(output.uncalibrated, Math.max(1, output.total))}% of output) across ${output.uncalibratedCalls} calls on ${output.uncalibratedModels.join(', ')}: this corpus holds too few calls from those models that emitted no thinking block, which is the only free source of exact tokenizer calibration. Their output is counted but not attributed to reasoning or to visible text.`,
        ]
      : []),
  ];
  findings.push({
    headline:
      gaps.length === 0
        ? 'Every model in this session was priced and calibrated'
        : `${(Math.max(unpricedShare, uncalibratedShare) * 100).toFixed(1)}% of this session could not be priced or calibrated`,
    detail:
      gaps.length === 0
        ? `All ${pricing.calls} calls ran models with a published rate and a measured tokenizer, so the dollar figure covers the whole session and every output token is attributed. Stated even at zero, because a gap that only appears when it exists cannot be distinguished from a gap nobody looked for.`
        : gaps.join(' '),
    cost: eqCost(pricing.unpricedSpend),
    shareOfSession: unpricedShare,
    severity: unpricedShare > 0.05 || uncalibratedShare > 0.05 ? 'high' : 'note',
  });

  for (const e of a.residency.epochs.slice(1)) {
    const penalty = invalidationExcess(e);
    const idleMin = Math.round(e.gapBeforeMs / 60000);
    // Idle expiry is ONE cause of invalidation, not the only one. Claiming "expired
    // after 0 minutes idle" when the calls were seconds apart is simply false — the
    // prefix changed for some other reason, and the honest finding says so.
    const byTime = e.gapBeforeMs >= 5 * 60_000;
    findings.push({
      headline: byTime
        ? `Cache expired after ${idleMin} minutes idle`
        : `Cache invalidated at call ${e.start} — the prompt prefix changed`,
      detail: byTime
        ? `At call ${e.start} the cached prefix was gone, so ${fmt(e.rewrittenTokens)} tokens of unchanged context were re-written at ${WRITE_MULTIPLE}x instead of re-read at ${CACHE_READ_MULTIPLE}x. Nothing about the content changed — only the clock.`
        : `At call ${e.start}, ${fmt(e.rewrittenTokens)} tokens were re-written at ${WRITE_MULTIPLE}x instead of re-read at ${CACHE_READ_MULTIPLE}x, only ${(e.gapBeforeMs / 1000).toFixed(0)}s after the previous call. Too fast to be TTL expiry, so something edited the prefix — a changed tool set, a model switch, or an edited system prompt. Caching is a prefix match: one changed byte invalidates everything after it.`,
      cost: eqCost(penalty),
      shareOfSession: penalty / grandTotal,
      severity: penalty / grandTotal > 0.05 ? 'high' : 'medium',
    });
  }

  const biggest = biggestToolResult(a.conversation.arrivals);
  if (biggest) {
    const est = biggest.size.tokens;
    const tc = trueCost(biggest, est, a.residency);
    findings.push({
      headline: `Largest tool result cost ${tc.multiple.toFixed(1)}x its size`,
      detail: `${tc.label} is ~${fmt(est)} tokens, first resident at call ${tc.bornAtCall} of ${a.conversation.calls.length - 1}. Written ${tc.lives.length}x and re-read ${tc.lives.reduce((acc, l) => acc + l.reads, 0)}x, it cost ${fmt(tc.total)} token-equivalents. Position and lifetime, not size.`,
      cost: eqCost(tc.total),
      shareOfSession: tc.total / grandTotal,
      severity: tc.total / grandTotal > 0.05 ? 'high' : 'medium',
    });
  }

  if (a.forest.placed.length > 0) {
    const n = a.forest.placed.length;
    findings.push({
      headline: `${n} spawned conversation${n > 1 ? 's' : ''} paid ${fmt(spawnedOnly.input)} tokens of cold-cache startup`,
      detail: `Spawned work is ${pct(inputEquivalents(spawnedOnly), inputEquivalents(exact))}% of this session's cost and starts from an empty cache every time. That is the price of the isolated context, charged once per spawn.`,
      cost: eqCost(spawnedOnly.input),
      shareOfSession: spawnedOnly.input / grandTotal,
      severity: 'note',
    });
  }

  const first = a.conversation.calls[0];
  const startup = first ? first.usage.input + first.usage.cacheCreation * WRITE_MULTIPLE : 0;
  findings.push({
    headline: `Startup payload cost ${fmt(startup)} token-equivalents before any work began`,
    detail: `Call 0 carried ${fmt(first?.usage.input ?? 0)} uncached tokens and wrote ${fmt(first?.usage.cacheCreation ?? 0)} to cache — system prompt, tool definitions, CLAUDE.md and skill listings. Every later call re-reads it.`,
    cost: eqCost(startup),
    shareOfSession: startup / grandTotal,
    severity: 'note',
  });

  return findings.sort((x, y) => y.shareOfSession - x.shareOfSession);
}

const biggestToolResult = (arrivals: readonly Arrival[]): Arrival | undefined =>
  arrivals.filter((x) => x.source === 'toolResult').sort((x, y) => y.size.tokens - x.size.tokens)[0];

/** How much of the arena is exactly known. Assistant output is; the rest is chars/4. */
const arenaBasisOf = (arrivals: readonly Arrival[]): ArenaBasis => {
  const of = (basis: string): number =>
    arrivals.filter((x) => x.size.basis === basis).reduce((s, x) => s + x.size.tokens, 0);
  const exactTokens = of('exact-api-usage');
  const estimatedTokens = of('estimated-from-chars');
  const all = exactTokens + estimatedTokens;
  return { exactTokens, estimatedTokens, exactShare: all === 0 ? 0 : exactTokens / all };
};

/** The arena: one band per allocation, born at a call, alive until its epoch ends. */
function strataFor(a: AnalyzedSession): Stratum[] {
  // Tokens per source, per call. Dominance is decided by weight, not by whether anything
  // disagreed — see the note on Stratum.source.
  //
  // Weighed in TOKENS, not characters. Assistant output is now sized from the API's
  // exact figure while everything else is reconstructed from characters, so comparing
  // the two by character count would be comparing a number that no longer exists
  // against one that does. Tokens is the unit both are expressed in.
  const bySource = new Map<number, Map<StratumSource, number>>();
  for (const arr of a.conversation.arrivals) {
    const at = bySource.get(arr.bornBeforeCall) ?? new Map<StratumSource, number>();
    at.set(arr.source, (at.get(arr.source) ?? 0) + arr.size.tokens);
    bySource.set(arr.bornBeforeCall, at);
  }

  return a.conversation.calls
    .filter((c) => c.usage.cacheCreation > 0)
    .map((c) => {
      const arrivals = a.conversation.arrivals.filter((x) => x.bornBeforeCall === c.index);
      const biggest = [...arrivals].sort((x, y) => y.size.tokens - x.size.tokens)[0];
      const dominant = dominantSource(bySource.get(c.index));
      // Call 0 is the startup payload by definition — system prompt, tool definitions,
      // CLAUDE.md, skill listings — none of which arrive as a transcript record.
      return c.index === 0
        ? {
            bornAtCall: 0,
            epoch: a.residency.epochOfCall[0]!,
            tokens: c.usage.cacheCreation,
            source: 'startup' as const,
            sourceShare: 1,
            label: 'startup payload (system prompt, tools, CLAUDE.md)',
          }
        : {
            bornAtCall: c.index,
            epoch: a.residency.epochOfCall[c.index]!,
            tokens: c.usage.cacheCreation,
            source: dominant.source,
            sourceShare: dominant.share,
            label: biggest?.label ?? `call ${c.index}`,
          };
    });
}

/** The source contributing the most tokens, and its share.
 *
 * [LAW:parse-dont-validate] A call with no arrivals at all returns `unattributed` with
 * a zero share, which says "nothing explains this band". Returning the first source, or
 * a plausible-looking `toolResult`, would be an answer-shaped void — indistinguishable
 * on the page from a band we genuinely attributed. */
function dominantSource(byTokens: Map<StratumSource, number> | undefined): {
  source: StratumSource;
  share: number;
} {
  const entries = [...(byTokens?.entries() ?? [])];
  const total = entries.reduce((a, [, v]) => a + v, 0);
  // Sorted by tokens, then by name, so a tie resolves the same way on every run rather
  // than following Map insertion order.
  const top = entries.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
  return top && total > 0
    ? { source: top[0], share: top[1] / total }
    : { source: 'unattributed', share: 0 };
}

function flameOf(s: Span): FlameNode {
  const u = rollup(s);
  const agent = s.lineage[s.lineage.length - 1];
  return {
    name: (agent ? `${agent.agentType} · ` : '') + s.label,
    value: Math.max(1, Math.round(spend(u))),
    kind: s.detail.kind,
    activity: s.detail.kind === 'call' ? s.detail.label.activity : null,
    depth: depthOf(s.lineage),
    children: s.children.map(flameOf),
  };
}

/** One line telling a person scanning a list what this session was.
 *
 * The opening ask is the useful half, so it must be something a HUMAN said. Preferring
 * the first `user` turn is what turn origins buy: the earlier version took the first
 * turn over 20 characters, which in 40% of sessions is a skill body or a slash-command
 * envelope, and produced twelve rail entries all reading "Base directory for this
 * skill". A session with no human turn at all (an agent-driven `claude -p` run) says so
 * rather than borrowing the harness's words. */
function synopsisFor(a: AnalyzedSession, calls: readonly CallRow[]): string {
  const byActivity = new Map<string, number>();
  for (const c of calls)
    byActivity.set(c.label.activity, (byActivity.get(c.label.activity) ?? 0) + spend(c.usage));
  const dominant = [...byActivity.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'unclassified';

  // Preference ORDER as data, so the fallback is one lookup rather than a ladder of
  // ifs. Order is the whole content: the first matching turn in TRANSCRIPT order is
  // usually `/clear`, and three sessions were named after it — the question is which
  // KIND of turn best says what a session was for, not which came first.
  const substantial = (t: Turn): boolean => t.snippet.length > 20;
  const PREFERENCE: ReadonlyArray<(t: Turn) => boolean> = [
    (t) => t.origin.kind === 'user' && substantial(t),
    (t) => t.origin.kind === 'agent' && substantial(t),
    (t) => t.origin.kind === 'command' && !isSessionControl(t.origin),
  ];
  const opening = PREFERENCE.map((p) => a.conversation.turns.find(p)).find(Boolean);
  return `${dominant} — ${opening ? opening.snippet.slice(0, 100) : 'no stated task — agent-driven throughout'}`;
}
