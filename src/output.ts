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
// whole ballgame, and is why the tokenizer is calibrated PER MODEL rather than guessed
// or pooled — see `models.ts`.

import type { Call } from './calls.ts';
import type { ContentBlock } from './records.ts';
import {
  canonicalModelId,
  tokenizerFor,
  visibleOutputTokens,
  type CalibrationGroup,
  type ModelTable,
} from './models.ts';

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

/** How one call's output tokens divide — or the reason they cannot be divided.
 *
 * [LAW:types-are-the-program] A union rather than a `visible` that goes to zero when the
 * model has no tokenizer. Zero visible tokens is a real, reachable answer meaning "this
 * call said nothing"; it must not also mean "we could not tell". A caller that has to
 * handle both arms cannot accidentally book an uncalibrated call's entire output as
 * reasoning, which is precisely what a silent fallback to some other model's
 * coefficients would have done. [LAW:no-silent-failure] */
export type OutputSplit =
  | {
      kind: 'split';
      /** Exact, from `usage.output_tokens`. Includes reasoning — the API bills thinking
       * as output on the turn that produces it. */
      total: number;
      /** Estimated from the visible blocks' characters and count, at this model's own
       * measured coefficients. */
      visible: number;
      remainder: Remainder;
    }
  | {
      kind: 'uncalibrated';
      /** Still exact, and still counted. Only the SPLIT is unavailable. */
      total: number;
      model: string;
      why: string;
    };

/** Blocks a reader can see. Thinking is excluded by KIND, never by character count:
 * a transcript that retained its reasoning text and one that stripped it must produce
 * the same split, and only the kind is stable across the two. */
const isVisible = (b: ContentBlock): boolean => b.kind !== 'thinking';

const charsOf = (b: ContentBlock): number => (b.kind === 'tool_use' ? b.inputChars : b.chars);

/** The visible extent of a call: characters and block count, by the one rule above. */
const visibleExtent = (call: Call): { chars: number; blocks: number } => {
  const shown = call.blocks.filter(isVisible);
  return { chars: shown.reduce((a, b) => a + charsOf(b), 0), blocks: shown.length };
};

/** One conversation's contribution to the tokenizer calibration: every model it ran, and
 * the subset of its calls that are free, exact observations of a tokenizer.
 *
 * A call that emitted no thinking block was billed `output_tokens` for exactly the
 * visible blocks measured here, so the pair is an exact observation requiring no API call
 * and no tokenizer library. The model list is deliberately the WHOLE conversation's, not
 * the points' — see `CalibrationGroup`.
 *
 * [LAW:one-source-of-truth] Lives here, beside `visibleExtent`, because the fit and the
 * split must measure the same thing. A second implementation of "visible" inside
 * `models.ts` would be a second answer, and the estimator would be calibrated against a
 * quantity it never predicts. */
export const calibrationGroup = (calls: readonly Call[]): CalibrationGroup => ({
  models: [...new Set(calls.map((c) => c.model))],
  points: calls
    .filter((c) => !c.blocks.some((b) => b.kind === 'thinking'))
    .map((c) => {
      const { chars, blocks } = visibleExtent(c);
      return { model: c.model, chars, blocks, outputTokens: c.usage.output };
    }),
});

export function splitOutput(call: Call, table: ModelTable): OutputSplit {
  const total = call.usage.output;
  const fit = tokenizerFor(table, call.model);
  if (!fit.found)
    return { kind: 'uncalibrated', total, model: canonicalModelId(call.model), why: fit.why };

  const { chars, blocks } = visibleExtent(call);
  const visible = visibleOutputTokens(fit.value, chars, blocks);
  const reasoned = call.blocks.some((b) => b.kind === 'thinking');
  return {
    kind: 'split',
    total,
    visible,
    remainder: reasoned
      ? { kind: 'reasoning', tokens: total - visible }
      : { kind: 'estimator-error', tokens: total - visible },
  };
}

/** Output across many calls, with reasoning, estimator error, and the part that could
 * not be split kept apart.
 *
 * [LAW:one-source-of-truth] `visible` is summed, never derived as total-reasoning: the
 * figures here are independent quantities, and reconstructing one from the others would
 * make the estimator's error invisible by construction.
 *
 * The four token figures close on `total` exactly:
 * `total = visible + reasoning + estimatorError + uncalibrated`. */
export interface OutputTotals {
  total: number;
  visible: number;
  /** Summed over calls that emitted a thinking block. */
  reasoning: number;
  /** Summed over calls that did not — the error bar on `reasoning`, measured on this
   * very data rather than assumed. */
  estimatorError: number;
  /** Exact output tokens on calls whose model has no measured tokenizer, so none of the
   * three figures above can claim them. The honest remainder, stated rather than
   * absorbed. [LAW:no-silent-failure] */
  uncalibrated: number;
  callsWithReasoning: number;
  /** Calls counted in `uncalibrated`. */
  uncalibratedCalls: number;
  /** Which model ids those were, so a reader can see WHAT the report could not split. */
  uncalibratedModels: readonly string[];
  calls: number;
}

export const ZERO_OUTPUT: OutputTotals = {
  total: 0,
  visible: 0,
  reasoning: 0,
  estimatorError: 0,
  uncalibrated: 0,
  callsWithReasoning: 0,
  uncalibratedCalls: 0,
  uncalibratedModels: [],
  calls: 0,
};

/** Roll two output totals together, keeping the named-model set a union rather than a
 * count. [LAW:composability] One associative combine, so per-session and per-corpus
 * rollups are the same arithmetic rather than two hand-written reducers. */
export const addOutput = (a: OutputTotals, b: OutputTotals): OutputTotals => ({
  total: a.total + b.total,
  visible: a.visible + b.visible,
  reasoning: a.reasoning + b.reasoning,
  estimatorError: a.estimatorError + b.estimatorError,
  uncalibrated: a.uncalibrated + b.uncalibrated,
  callsWithReasoning: a.callsWithReasoning + b.callsWithReasoning,
  uncalibratedCalls: a.uncalibratedCalls + b.uncalibratedCalls,
  uncalibratedModels: [...new Set([...a.uncalibratedModels, ...b.uncalibratedModels])].sort(),
  calls: a.calls + b.calls,
});

export function totalOutput(calls: readonly Call[], table: ModelTable): OutputTotals {
  const totals = { ...ZERO_OUTPUT, calls: calls.length };
  const models = new Set<string>();
  for (const c of calls) {
    const s = splitOutput(c, table);
    totals.total += s.total;
    // [LAW:dataflow-not-control-flow] Every call's output lands in exactly one named
    // bucket, and none of them is a default the others fall through to.
    if (s.kind === 'uncalibrated') {
      totals.uncalibrated += s.total;
      totals.uncalibratedCalls++;
      models.add(s.model);
      continue;
    }
    totals.visible += s.visible;
    if (s.remainder.kind === 'reasoning') {
      totals.reasoning += s.remainder.tokens;
      totals.callsWithReasoning++;
    } else {
      totals.estimatorError += s.remainder.tokens;
    }
  }
  totals.uncalibratedModels = [...models].sort();
  return totals;
}
