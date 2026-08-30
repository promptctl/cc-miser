// The span tree: how conversations, turns, calls and tools nest, and how exact usage
// rolls up through them.
//
// [LAW:effects-at-boundaries] Pure. Takes resolved conversations, returns a tree.

import type { Call, Conversation } from './calls.ts';
import { directChildren, type PlacedConversation } from './forest.ts';
import { ROOT, depthOf, immediateAgent, lineagePath, type Lineage } from './lineage.ts';
import { ZERO_USAGE, addUsage, type Usage } from './tokens.ts';
import { withReason, type Label } from './activity.ts';

export type SpanDetail =
  | { kind: 'session'; sessionId: string }
  | { kind: 'turn'; snippet: string }
  /** `ts` is WHEN THE CALL HAPPENED, which is a different fact from where its span
   * starts. It lives here, beside the usage and the model it is priced with, because
   * `tStart` is an EXTENT: a parent's extent has to cover its children, so a call whose
   * subagent began before it must start earlier than the call did. Read as the billable
   * instant, that widened extent would silently move the call to a different day's rate
   * card. Two facts, two fields. [LAW:one-source-of-truth] */
  | { kind: 'call'; ts: number; usage: Usage; model: string; lineCount: number; label: Label }
  | { kind: 'tool'; name: string; summary: string; resultChars: number }
  | { kind: 'subagent'; agentType: string; description: string };

export interface Span {
  id: string;
  label: string;
  detail: SpanDetail;
  lineage: Lineage;
  tStart: number;
  tEnd: number;
  callFirst: number;
  callLast: number;
  children: Span[];
}

/** Roll exact usage up the tree.
 *
 * [LAW:dataflow-not-control-flow] ONE rule for the whole tree: sum the exact usage of
 * every `call` descendant. Spawned conversations need no special case, because their
 * calls are ordinary call spans that happen to sit deeper — the difference is in the
 * data's shape, never in a branch here. */
export const rollup = (span: Span): Usage => rollupWhere(span, () => true);

/** The same one rule, with the variability moved into a value.
 *
 * [LAW:composability] `rollupWhere(root, isMain)` and `rollupWhere(root, isSpawned)`
 * are one function and two predicates — not `rollupMain()` and `rollupSubagents()`,
 * a family of names encoding what a parameter should carry. Any future slice (by
 * model, by activity, by depth) is a new predicate, never new code.
 *
 * [LAW:one-source-of-truth] This replaces deriving spawned cost by SUBTRACTION
 * (total − parent), which is two routes to one fact and misattributes grandchildren
 * the moment depth-2 nesting appears — and it does appear. */
export function rollupWhere(span: Span, keep: (s: Span) => boolean): Usage {
  const own = span.detail.kind === 'call' && keep(span) ? span.detail.usage : ZERO_USAGE;
  return span.children.reduce((acc, c) => addUsage(acc, rollupWhere(c, keep)), own);
}

// Cohort predicates: values crossing one boundary. [LAW:composability]
export const isMain = (s: Span): boolean => depthOf(s.lineage) === 0;
export const isSpawned = (s: Span): boolean => depthOf(s.lineage) > 0;
export const atDepth =
  (n: number) =>
  (s: Span): boolean =>
    depthOf(s.lineage) === n;
export const inAgent =
  (agentId: string) =>
  (s: Span): boolean =>
    s.lineage.some((sp) => sp.agentId === agentId);

/** A span already known to be a call.
 *
 * [LAW:types-are-the-program] `allCalls` has always known its results are calls — it
 * selected them on that basis. Saying so in the return type spares every caller an
 * `as Extract<SpanDetail, {kind:'call'}>` cast to recover what the filter established.
 * A cast is a promise; this is a proof. */
export type CallSpan = Span & { detail: Extract<SpanDetail, { kind: 'call' }> };

/** Every call span in the tree, flattened — the span SET that the tree is one grouping
 * of. PROJECT.md's point: the set is the real object; the tree is a view of it. */
export function allCalls(span: Span): CallSpan[] {
  const here = isCallSpan(span) ? [span] : [];
  return here.concat(...span.children.map(allCalls));
}

export const isCallSpan = (s: Span): s is CallSpan => s.detail.kind === 'call';

/** A call span reduced to what pricing needs: a model, an instant, and a usage vector.
 *
 * [LAW:one-source-of-truth] The single place a call span becomes billable. Both the
 * report's per-session rows and the CLI's per-session lines price the same population
 * by the same reduction, so "which instant does a rate card apply at" is decided once
 * here rather than agreed on by two call sites that are free to drift. Typed
 * structurally rather than as `models.ts`'s `Billable` so this module keeps importing
 * only from below it. [LAW:one-way-deps] */
export const billableOf = (s: CallSpan): { model: string; ts: number; usage: Usage } => ({
  model: s.detail.model,
  // The call's own instant, NOT `tStart`. See the note on `SpanDetail`'s call variant:
  // `tStart` is an extent that a child can widen, and pricing must not move when it does.
  ts: s.detail.ts,
  usage: s.detail.usage,
});

export type ToolSpan = Span & { detail: Extract<SpanDetail, { kind: 'tool' }> };
export const isToolSpan = (s: Span): s is ToolSpan => s.detail.kind === 'tool';

/** How a call's activity is decided, supplied by the caller.
 *
 * [LAW:one-way-deps] A parameter rather than an import of the classifier, which is
 * what keeps this module below `classify.ts` instead of tangled with it. It is also
 * what lets a spawned conversation INHERIT its spawner's label, per PROJECT.md's rule
 * that a review subagent's entire burn is review cost. */
export type ActivityResolver = (callIndex: number) => Label;

/** The id of a call node, in the conversation identified by `prefix`.
 *
 * A FUNCTION RATHER THAN A TEMPLATE AT EACH SITE, because the report now names call
 * nodes too — it anchors a finding to the call it is about so the page can link that
 * call to its span in Jaeger. The span id Jaeger indexes is a digest OVER this string
 * (`jaeger.ts`), so a report spelling `call:<n>` itself would be a second copy of a
 * grammar this module owns, and a drift between them produces a well-formed link to a
 * span that does not exist — wrong silently, in the direction nobody checks.
 * [LAW:one-source-of-truth] The other four node kinds keep their literals: they have
 * one writer each, and a constructor with a single caller states a sharing that isn't
 * there. */
const callId = (prefix: string, index: number): string => `call:${prefix}${index}`;

/** The id of a call in the ROOT conversation — the one a human was reading.
 *
 * The root's prefix is empty (`buildConversationSpan` derives it from an empty lineage),
 * and this states that once so a consumer outside this module never has to know it.
 * Spawned conversations prefix their ids with an agent id, which is why this is
 * deliberately narrow: it is the only shape reachable from a `CallRow.index`. */
export const rootCallId = (index: number): string => callId('', index);

/** Build the span tree for one session, grafting every conversation it spawned.
 *
 * [LAW:dataflow-not-control-flow] The SAME function runs at every depth. A root
 * session and a depth-4 sub-sub-sub-agent differ only in the `lineage` value handed in
 * and the resolver they carry — never in which code path executes. That is what makes
 * arbitrary nesting free rather than another variant to write. */
export function buildSessionTree(
  root: Conversation,
  placed: readonly PlacedConversation[],
  activityFor: ActivityResolver,
  sessionId: string,
): Span {
  return buildConversationSpan(root, ROOT, placed, activityFor, {
    id: `session:${sessionId}`,
    label: `session ${sessionId.slice(0, 8)}`,
    detail: { kind: 'session', sessionId },
  });
}

/** What this conversation's own root span is called. Passed in rather than derived
 * from `detail`, because deriving it needed a branch for a `detail` kind that cannot
 * reach here — an unreachable case is a theorem the type was overstating. */
interface ConversationHead {
  id: string;
  label: string;
  detail: SpanDetail;
}

function buildConversationSpan(
  conv: Conversation,
  lineage: Lineage,
  all: readonly PlacedConversation[],
  activityFor: ActivityResolver,
  head: ConversationHead,
): Span {
  const kids = directChildren(all, lineage);
  const idPrefix = lineage.length === 0 ? '' : `${immediateAgent(lineage)!.agentId}:`;

  /** Which children have found a home, written by `graft` below as it places them.
   *
   * A ledger rather than a second pass that re-derives which kid attaches where: that
   * derivation already exists in `callChildren`, and a copy of it here would be two
   * routes to one fact, free to disagree about a conversation's existence.
   * [LAW:one-source-of-truth] */
  const grafted = new Set<string>();

  /** Build the span for one spawned conversation, inheriting our activity label. */
  const graft = (kid: PlacedConversation, atCall: number): Span => {
    grafted.add(kid.meta.agentId);
    const inherited = activityFor(atCall);
    return buildConversationSpan(
      kid.conversation,
      kid.lineage,
      all,
      () =>
        withReason(
          inherited,
          `inherited via ${lineagePath(kid.lineage)} from call ${atCall}: ${inherited.because}`,
        ),
      {
        id: `subagent:${kid.meta.agentId}`,
        label: `subagent(${kid.meta.agentType}): ${kid.meta.description}`,
        detail: { kind: 'subagent', agentType: kid.meta.agentType, description: kid.meta.description },
      },
    );
  };

  const callChildren = (c: Call): Span[] => {
    const out: Span[] = [];
    for (const b of c.blocks) {
      if (b.kind !== 'tool_use') continue;
      const exec = conv.tools.find((e) => e.toolUseId === b.id);
      const toolSpan: Span = {
        id: `tool:${idPrefix}${b.id}`,
        label: `${b.name} ${exec?.summary ?? ''}`.trim(),
        detail: {
          kind: 'tool',
          name: b.name,
          summary: exec?.summary ?? '',
          resultChars: exec?.resultChars ?? 0,
        },
        lineage,
        tStart: exec?.tsStart ?? c.ts,
        tEnd: exec?.tsEnd ?? c.ts,
        callFirst: c.index,
        callLast: c.index,
        children: [],
      };
      // Conversations this tool call spawned (the tool_use edge).
      for (const kid of kids.filter(
        (k) => immediateAgent(k.lineage)!.via === 'tool_use' && k.meta.toolUseId === b.id,
      ))
        toolSpan.children.push(graft(kid, c.index));
      // A grafted conversation can outlast the tool result that started it; the
      // parent must cover it or the nesting is invalid.
      toolSpan.tEnd = Math.max(toolSpan.tEnd, ...toolSpan.children.map((k) => k.tEnd));
      toolSpan.tStart = Math.min(toolSpan.tStart, ...toolSpan.children.map((k) => k.tStart));
      out.push(toolSpan);
    }
    // Slash-command forks have no tool_use block to hang from, so they attach directly
    // to the call they were issued at.
    for (const kid of kids.filter(
      (k) =>
        immediateAgent(k.lineage)!.via === 'command' &&
        immediateAgent(k.lineage)!.spawnedAtCall === c.index,
    ))
      out.push(graft(kid, c.index));
    return out;
  };

  const callSpans = new Map<number, Span>();
  for (const c of conv.calls) {
    callSpans.set(c.index, {
      id: callId(idPrefix, c.index),
      label:
        lineage.length === 0 ? `call ${c.index}` : `${immediateAgent(lineage)!.agentType} call ${c.index}`,
      detail: {
        kind: 'call',
        ts: c.ts,
        usage: c.usage,
        model: c.model,
        lineCount: c.lineCount,
        label: activityFor(c.index),
      },
      lineage,
      tStart: c.ts,
      tEnd: c.ts,
      callFirst: c.index,
      callLast: c.index,
      children: callChildren(c),
    });
  }

  // Extents flow UPWARD: a parent covers its children and nothing more. Stretching a
  // call to the NEXT call's start (the earlier version) both charged human idle time
  // to the call and produced spans that escaped their parents, which Chrome Trace
  // rejects as malformed nesting.
  //
  // BOTH ENDS, which is what this rule used to say and only half do. `tEnd` flowed up
  // and `tStart` did not, so a child that BEGAN before its parent still escaped — and it
  // does begin earlier, on 24 of the sessions on this machine: a slash-command fork is
  // attributed to the call nearest it in time, and a subagent transcript's first line can
  // precede that call. The half-rule was invisible while the only consumer was a
  // flamegraph that lays children out by value; it surfaced the moment spans were emitted
  // to a viewer that reads the timestamps (miser-tracing-yhc.2).
  //
  // Widening `tStart` is safe here ONLY because the call's billable instant moved to
  // `detail.ts` — see `SpanDetail`. Done before that, this would have repriced 24
  // sessions' calls at whatever rate card the subagent's start date fell under.
  for (const c of conv.calls) {
    const span = callSpans.get(c.index)!;
    span.tStart = Math.min(c.ts, ...span.children.map((k) => k.tStart));
    span.tEnd = Math.max(c.ts + 1, ...span.children.map((k) => k.tEnd));
  }

  const turnSpans: Span[] = conv.turns
    .map((turn) => {
      const inTurn = conv.calls
        .filter((c) => c.index >= turn.firstCall && c.index <= turn.lastCall)
        .map((c) => callSpans.get(c.index)!);
      return {
        id: `turn:${idPrefix}${turn.index}`,
        label: `turn ${turn.index}: ${turn.snippet}`,
        detail: { kind: 'turn' as const, snippet: turn.snippet },
        lineage,
        tStart: inTurn.length ? Math.min(...inTurn.map((k) => k.tStart)) : 0,
        tEnd: inTurn.length ? Math.max(...inTurn.map((k) => k.tEnd)) : 0,
        callFirst: turn.firstCall,
        callLast: turn.lastCall,
        children: inTurn,
      };
    })
    .filter((s) => s.children.length > 0);

  // EVERY CALL SPAN HAS EXACTLY ONE PARENT, and every placed conversation exactly one
  // home. Both used to be promises rather than properties, and the corpus collected on
  // both.
  //
  // [LAW:dataflow-not-control-flow] The rule this replaces was `turnSpans.length > 0 ?
  // turnSpans : [...callSpans.values()]` — a fallback whose comment claimed "so no call
  // is ever dropped from the tree". It covered the case where a conversation has NO
  // turns and missed the one where it has turns that do not reach its first calls: a
  // transcript that opens with API calls before any user-channel line (a compaction
  // resume, or a subagent whose prompt line the writer never emitted) leaves those calls
  // in no turn at all, and the tree simply did not contain them. Measured on 396 real
  // sessions when this check was first run: one subagent lost 31 of its 39 calls — 79%
  // of its spend — silently, from every rollup on the page.
  //
  // Stated as a partition instead of a fallback, the loss is not something to remember
  // to handle: a call the turns do not cover is attached here by the same expression
  // that covers the ordinary case.
  const covered = new Set<number>();
  for (const t of turnSpans) for (const c of t.children) covered.add(c.callFirst);
  const looseCalls = [...callSpans.entries()].filter(([i]) => !covered.has(i)).map(([, s]) => s);

  // The same law on the other axis. A child is normally grafted onto the call that
  // spawned it, but a root conversation with no calls at all has nothing to graft onto —
  // and that is a real session shape: when all of a session's work goes to one spawned
  // agent, the root transcript records zero API calls and its 40-call child vanished
  // entirely. It attaches to the conversation instead. [LAW:no-silent-failure]
  const looseKids = kids
    .filter((k) => !grafted.has(k.meta.agentId))
    .map((k) => graft(k, immediateAgent(k.lineage)!.spawnedAtCall));

  const body: Span[] = [...turnSpans, ...looseCalls, ...looseKids].sort(
    (a, b) => a.tStart - b.tStart,
  );

  return {
    ...head,
    lineage,
    tStart: body.length ? Math.min(...body.map((s) => s.tStart)) : 0,
    tEnd: body.length ? Math.max(...body.map((s) => s.tEnd)) : 0,
    callFirst: 0,
    callLast: Math.max(0, conv.calls.length - 1),
    children: body,
  };
}
