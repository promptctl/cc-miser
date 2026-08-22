// Project an analysed session into the report model.
//
// [LAW:decomposition] The one place the analysis is turned into what a page shows.
// It derives presentation facts — ledgers, findings, coverage, strata — and never
// recomputes an exact number: every `usage` here came off the span tree unchanged.
//
// [LAW:effects-at-boundaries] Pure. Analysis in, model out.

import type { AnalyzedSession } from '../session.ts';
import type { Arrival } from '../calls.ts';
import { invalidationExcess, trueCost } from '../residency.ts';
import { allCalls, isSpawned, isToolSpan, rollup, rollupWhere, type Span } from '../spans.ts';
import { depthOf } from '../lineage.ts';
import {
  CACHE_READ_MULTIPLE,
  WRITE_MULTIPLE,
  dollars,
  eqCost,
  estimateTokens,
  inputEquivalents,
  spend,
  usdCost,
  type Usage,
} from '../tokens.ts';
import type { Tier } from '../activity.ts';
import type {
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

export function projectSession(a: AnalyzedSession): SessionReport {
  const callSpans = allCalls(a.tree);
  const exact = rollup(a.tree);
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
    model: a.conversation.calls[0]?.model ?? '(unknown)',
    usage: exact,
    total: eqCost(grandTotal),
    totalUsd: usdCost(dollars(exact)),
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
    ledgers: [
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
    findings: findingsFor(a, exact, spawnedOnly, grandTotal),
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
): Finding[] {
  const findings: Finding[] = [];

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
    const est = estimateTokens(biggest.chars);
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
  arrivals.filter((x) => x.source === 'toolResult').sort((x, y) => y.chars - x.chars)[0];

/** The arena: one band per allocation, born at a call, alive until its epoch ends. */
function strataFor(a: AnalyzedSession): Stratum[] {
  const sourceAt = new Map<number, StratumSource>();
  for (const arr of a.conversation.arrivals) {
    const cur = sourceAt.get(arr.bornBeforeCall);
    sourceAt.set(arr.bornBeforeCall, cur && cur !== arr.source ? 'mixed' : arr.source);
  }
  return a.conversation.calls
    .filter((c) => c.usage.cacheCreation > 0)
    .map((c) => ({
      bornAtCall: c.index,
      epoch: a.residency.epochOfCall[c.index]!,
      tokens: c.usage.cacheCreation,
      source: c.index === 0 ? ('startup' as const) : (sourceAt.get(c.index) ?? 'mixed'),
      label:
        c.index === 0
          ? 'startup payload (system prompt, tools, CLAUDE.md)'
          : (a.conversation.arrivals
              .filter((x) => x.bornBeforeCall === c.index)
              .sort((x, y) => y.chars - x.chars)[0]?.label ?? `call ${c.index}`),
    }));
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

function synopsisFor(a: AnalyzedSession, calls: readonly CallRow[]): string {
  const byActivity = new Map<string, number>();
  for (const c of calls)
    byActivity.set(c.label.activity, (byActivity.get(c.label.activity) ?? 0) + spend(c.usage));
  const dominant = [...byActivity.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 'unclassified';
  const firstTurn = a.conversation.turns.find((t) => t.snippet.length > 20)?.snippet ?? '(no user text)';
  return `${dominant} — ${firstTurn.slice(0, 100)}`;
}
