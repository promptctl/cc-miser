// Attribution beneath a call: which arrivals explain the tokens it newly wrote to the
// context, and how much of that exact figure they fail to explain.
//
// [LAW:effects-at-boundaries] Pure. Takes a conversation, returns arithmetic.
//
// WHY "NEWLY WROTE" AND NOT THE WHOLE CALL. A call's usage vector mixes three things
// that are caused by three different sources: `cacheRead` is a prefix that survived from
// an earlier call — already explained by whichever arrival first wrote it, not this
// call's to re-explain — and `output` is what the model produced, which `output.ts`
// already attributes on its own axis (visible text/tools vs. reasoning). What is left,
// and what this module owns, is `input + cacheCreation`: the tokens this call's prompt
// contains for the first time. Every `Arrival` in `src/calls.ts` records exactly that —
// something entering the context window before a named call — which is what makes the
// two sides of this reconciliation the same quantity measured two ways.

import type { Arrival, ArrivalSource, Call, Conversation } from './calls.ts';
import { WRITE_MULTIPLE } from './tokens.ts';

/** One named group of arrivals attributed to a call, priced as a fresh cache write —
 * which is what every arrival born at a call becomes: content entering the context for
 * the first time.
 *
 * [LAW:one-type-per-behavior] One bucket shape for all four `ArrivalSource`s, keyed by
 * whatever actually varies within each: the attachment type, the tool name, or a fixed
 * label for user text and prior output. Four bucket types would differ only in that
 * label's provenance. */
export interface Cause {
  source: ArrivalSource;
  label: string;
  arrivals: number;
  estTokens: number;
  cost: number;
}

/** One call's estimated causes, and the exact gap between what they explain and what
 * the call's own usage block reports.
 *
 * [LAW:types-are-the-program] `unattributed` is a field, not a discipline: `causes` are
 * never adjusted to make it disappear, which is PROJECT.md's honesty rule — exact
 * numbers are authoritative, estimates are labeled and never adjust them — carried in
 * the type rather than trusted to be remembered. Can be negative, when the character
 * estimator overshoots; reported as-is, never clamped, for the same reason `output.ts`'s
 * `Remainder` is not clamped — clamping would bias every rollup upward and hide the
 * estimator's own error. */
export interface CallAttribution {
  call: number;
  causes: Cause[];
  /** Sum of `causes[].cost`. Kept as a field rather than recomputed at every use, so a
   * consumer and this module cannot silently sum the same array two different ways. */
  causedCost: number;
  /** `input + cacheCreation * WRITE_MULTIPLE` — see the file header for why `cacheRead`
   * and `output` are excluded. */
  exactCost: number;
  unattributed: number;
}

/** What distinguishes one bucket from another within a source.
 *
 * [LAW:one-source-of-truth] A tool result's name comes from `conv.tools`, joined by
 * `toolUseId` — never parsed back out of `Arrival.label`, which `calls.ts` builds as a
 * display string for a reader (name plus a truncated summary of the input) and is not a
 * key anything should re-derive structure from.
 *
 * [LAW:types-are-the-program] A `switch` with no `default`, so a fifth `ArrivalSource`
 * added to `calls.ts` fails this function to compile rather than silently falling through
 * to some other source's label. */
function bucketLabel(a: Arrival, toolNameByUseId: ReadonlyMap<string, string>): string {
  switch (a.source) {
    case 'toolResult':
      return toolNameByUseId.get(a.toolUseId) ?? 'unknown tool';
    case 'attachment':
      return a.label;
    case 'userText':
      return 'user text';
    case 'assistantOutput':
      return 'prior output';
  }
}

/** Group and price one call's arrivals. [LAW:dataflow-not-control-flow] Every arrival
 * handed in belongs to this call — selection already happened in `attributeConversation`
 * — so this is one unconditional fold, not a per-arrival decision about whether to
 * count it. */
function causesOf(arrivals: readonly Arrival[], toolNameByUseId: ReadonlyMap<string, string>): Cause[] {
  const buckets = new Map<string, Cause>();
  for (const a of arrivals) {
    const label = bucketLabel(a, toolNameByUseId);
    const key = `${a.source}:${label}`;
    const cost = a.size.tokens * WRITE_MULTIPLE;
    const existing = buckets.get(key);
    if (existing) {
      existing.arrivals++;
      existing.estTokens += a.size.tokens;
      existing.cost += cost;
    } else {
      buckets.set(key, { source: a.source, label, arrivals: 1, estTokens: a.size.tokens, cost });
    }
  }
  return [...buckets.values()];
}

const exactCostOf = (u: Call['usage']): number => u.input + u.cacheCreation * WRITE_MULTIPLE;

/** Attribute every call in a conversation.
 *
 * [LAW:composability] One conversation in, one attribution per call out — a root
 * session, a spawned agent and a corpus scan all call this the same way, since
 * `buildConversation` already made both kinds of conversation the same shape. */
export function attributeConversation(conv: Conversation): CallAttribution[] {
  const toolNameByUseId = new Map(conv.tools.map((t) => [t.toolUseId, t.name] as const));

  const arrivalsByCall = new Map<number, Arrival[]>();
  for (const a of conv.arrivals) {
    const bucket = arrivalsByCall.get(a.bornBeforeCall);
    if (bucket) bucket.push(a);
    else arrivalsByCall.set(a.bornBeforeCall, [a]);
  }

  return conv.calls.map((c) => {
    const causes = causesOf(arrivalsByCall.get(c.index) ?? [], toolNameByUseId);
    const causedCost = causes.reduce((a, b) => a + b.cost, 0);
    const exactCost = exactCostOf(c.usage);
    return { call: c.index, causes, causedCost, exactCost, unattributed: exactCost - causedCost };
  });
}
