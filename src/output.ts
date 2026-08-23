// What a call's output tokens were spent on: the text and tool calls a reader can see,
// and the reasoning they cannot.
//
// [LAW:effects-at-boundaries] Pure. Takes calls, returns arithmetic.
//
// WHY THIS IS A SPLIT AND NOT A MEASUREMENT. No transcript version in the corpus carries
// a reasoning counter — every `usage` block holds exactly input_tokens,
// cache_creation_input_tokens, cache_read_input_tokens, output_tokens, service_tier,
// cache_creation, inference_geo, and sometimes server_tool_use/iterations/speed. And the
// reasoning text itself is stripped by the transcript writer in all 22,568 thinking
// blocks we hold. So the only route to the reasoning share is subtraction: the exact
// output total, minus an estimate of the visible part. Which makes the estimator the
// whole ballgame, and is why `visibleOutputTokens` is calibrated rather than guessed.

import type { Call } from './calls.ts';
import type { ContentBlock } from './records.ts';
import { visibleOutputTokens } from './tokens.ts';

/** What the visible blocks fail to explain, and what that failure means.
 *
 * [LAW:types-are-the-program] The number is the same subtraction either way; only its
 * meaning differs, and it differs by the KIND of block the call emitted. Carrying the
 * meaning in the type is what stops a consumer summing the two into one "reasoning"
 * figure — which would quietly book this estimator's own error as reasoning on the
 * 40.1% of calls that did none. */
export type Remainder =
  /** The call emitted a thinking block, so what the visible blocks do not account for
   * is reasoning. An ESTIMATE: exact total minus estimated visible. Can come out
   * negative when the estimator overshoots, and is reported that way rather than
   * clamped, because clamping would bias every aggregate upward and hide the error. */
  | { kind: 'reasoning'; tokens: number }
  /** No thinking block, so every output token was visible BY KIND. Whatever the
   * characters fail to explain is this estimator missing, and it is named that. */
  | { kind: 'estimator-error'; tokens: number };

/** How one call's output tokens divide. */
export interface OutputSplit {
  /** Exact, from `usage.output_tokens`. Includes reasoning — the API bills thinking as
   * output on the turn that produces it. */
  total: number;
  /** Estimated from the visible blocks' characters and count. */
  visible: number;
  remainder: Remainder;
}

/** Blocks a reader can see. Thinking is excluded by KIND, never by character count:
 * a transcript that retained its reasoning text and one that stripped it must produce
 * the same split, and only the kind is stable across the two. */
const isVisible = (b: ContentBlock): boolean => b.kind !== 'thinking';

const charsOf = (b: ContentBlock): number => (b.kind === 'tool_use' ? b.inputChars : b.chars);

export function splitOutput(call: Call): OutputSplit {
  const shown = call.blocks.filter(isVisible);
  const visible = visibleOutputTokens(
    shown.reduce((a, b) => a + charsOf(b), 0),
    shown.length,
  );
  const total = call.usage.output;
  const reasoned = call.blocks.some((b) => b.kind === 'thinking');
  return {
    total,
    visible,
    remainder: reasoned
      ? { kind: 'reasoning', tokens: total - visible }
      : { kind: 'estimator-error', tokens: total - visible },
  };
}

/** Output across many calls, with reasoning and estimator error kept apart.
 *
 * [LAW:one-source-of-truth] `visible` is summed, never derived as total-reasoning: the
 * three figures are three independent quantities here, and reconstructing one from the
 * others would make the estimator's error invisible by construction. */
export interface OutputTotals {
  total: number;
  visible: number;
  /** Summed over calls that emitted a thinking block. */
  reasoning: number;
  /** Summed over calls that did not — the error bar on `reasoning`, measured on this
   * very data rather than assumed. Corpus-wide it runs to +1.4% of those calls' output. */
  estimatorError: number;
  callsWithReasoning: number;
  calls: number;
}

export function totalOutput(calls: readonly Call[]): OutputTotals {
  const totals: OutputTotals = {
    total: 0,
    visible: 0,
    reasoning: 0,
    estimatorError: 0,
    callsWithReasoning: 0,
    calls: calls.length,
  };
  for (const c of calls) {
    const s = splitOutput(c);
    totals.total += s.total;
    totals.visible += s.visible;
    // [LAW:dataflow-not-control-flow] The remainder always lands in exactly one of two
    // named buckets. Neither is a default the other falls through to.
    if (s.remainder.kind === 'reasoning') {
      totals.reasoning += s.remainder.tokens;
      totals.callsWithReasoning++;
    } else {
      totals.estimatorError += s.remainder.tokens;
    }
  }
  return totals;
}
