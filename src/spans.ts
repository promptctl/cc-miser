// The span tree: how conversations, turns, calls and tools nest, and how exact usage
// rolls up through them.
//
// [LAW:effects-at-boundaries] Pure. Takes resolved conversations, returns a tree.

import type { Call, Conversation } from './calls.ts';
import { directChildren, type PlacedConversation } from './forest.ts';
import { ROOT, depthOf, immediateAgent, lineagePath, type Lineage } from './lineage.ts';
import { ZERO_USAGE, addUsage, type Usage } from './tokens.ts';
import type { Label } from './activity.ts';

export type SpanDetail =
  | { kind: 'session'; sessionId: string }
  | { kind: 'turn'; snippet: string }
  | { kind: 'call'; usage: Usage; model: string; lineCount: number; label: Label }
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

export type ToolSpan = Span & { detail: Extract<SpanDetail, { kind: 'tool' }> };
export const isToolSpan = (s: Span): s is ToolSpan => s.detail.kind === 'tool';

/** How a call's activity is decided, supplied by the caller.
 *
 * [LAW:one-way-deps] A parameter rather than an import of the classifier, which is
 * what keeps this module below `classify.ts` instead of tangled with it. It is also
 * what lets a spawned conversation INHERIT its spawner's label, per PROJECT.md's rule
 * that a review subagent's entire burn is review cost. */
export type ActivityResolver = (callIndex: number) => Label;

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

  /** Build the span for one spawned conversation, inheriting our activity label. */
  const graft = (kid: PlacedConversation, atCall: number): Span => {
    const inherited = activityFor(atCall);
    return buildConversationSpan(
      kid.conversation,
      kid.lineage,
      all,
      () => ({
        activity: inherited.activity,
        tier: inherited.tier,
        because: `inherited via ${lineagePath(kid.lineage)} from call ${atCall}: ${inherited.because}`,
      }),
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
      id: `call:${idPrefix}${c.index}`,
      label:
        lineage.length === 0 ? `call ${c.index}` : `${immediateAgent(lineage)!.agentType} call ${c.index}`,
      detail: {
        kind: 'call',
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
  for (const c of conv.calls) {
    const span = callSpans.get(c.index)!;
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

  // A spawned conversation often has no user turn of its own; fall back to its calls
  // so no call is ever dropped from the tree.
  const body: Span[] = turnSpans.length > 0 ? turnSpans : [...callSpans.values()];

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
