// The token cost vocabulary: the usage vector, and the projections of it into a
// single number.
//
// [LAW:one-way-deps] The bottom of the hill. This module imports nothing, and every
// other module that talks about cost imports it — including `report/model.ts`, so the
// seam and the pipeline cannot end up with two structurally-identical `Usage` types
// that drift apart.
//
// [LAW:one-source-of-truth] Exact token counts come only from API `usage` blocks.
// `estimateTokens` below is a labeled ESTIMATE used to attribute what the exact
// totals were spent on; an estimate never replaces or adjusts an exact number.

/** Exact token usage as the API reported it for one request. */
export interface Usage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

export const ZERO_USAGE: Usage = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 };

export const addUsage = (a: Usage, b: Usage): Usage => ({
  input: a.input + b.input,
  cacheCreation: a.cacheCreation + b.cacheCreation,
  cacheRead: a.cacheRead + b.cacheRead,
  output: a.output + b.output,
});

// Anthropic's cache multipliers, relative to the base input-token price. These are
// properties of the caching API, not of any one model, which is why the input-side
// projection below is model-independent.
export const WRITE_MULTIPLE = 1.25;
export const CACHE_READ_MULTIPLE = 0.1;

/** How a token count was projected into a single number.
 *
 * PROJECT.md: "any single-number view must say which projection it is." Pairing the
 * number with its projection in `Cost` means a bare figure cannot reach a page
 * unlabelled — the honesty rule is carried by the type rather than by discipline.
 * [LAW:types-are-the-program] */
export type Projection =
  /** input×1 + cacheWrite×1.25 + cacheRead×0.1. Model-independent. */
  | 'input-equivalent-tokens'
  /** Raw token count with no weighting. */
  | 'raw-tokens'
  /** USD at the session's own model rates. */
  | 'usd';

export interface Cost {
  value: number;
  projection: Projection;
}

/** The input-side cost projection, in base-input-token equivalents.
 *
 * [LAW:comments-carry-meaning] Output is deliberately NOT folded in. Folding it would
 * need an output/input price ratio, which is model-specific — that would make this
 * number a per-model dollar proxy wearing a token costume. Kept separate, the figure
 * is exact and model-independent, and residency is entirely input-side anyway. */
export const inputEquivalents = (u: Usage): number =>
  u.input + u.cacheCreation * WRITE_MULTIPLE + u.cacheRead * CACHE_READ_MULTIPLE;

/** Everything a call cost, input side plus output. The figure the ledgers rank by. */
export const spend = (u: Usage): number => inputEquivalents(u) + u.output;

// Rates for claude-opus-4-8, the only model in the sessions measured so far. Stated
// as named rates rather than folded into the arithmetic so the assumption stays
// visible; miser-pricing-afc replaces this with a per-model table.
export const USD_PER_INPUT_MTOK = 5;
export const USD_PER_OUTPUT_MTOK = 25;

export const dollars = (u: Usage): number =>
  (inputEquivalents(u) * USD_PER_INPUT_MTOK + u.output * USD_PER_OUTPUT_MTOK) / 1_000_000;

/** chars→tokens heuristic for English/code (~4 chars per token). Attribution
 * granularity, not billing accuracy.
 *
 * Calibrated for INPUT-side arrivals — tool results, user text, attachments — and
 * wrong by a factor of 1.6 on assistant output, which is denser. Use
 * `visibleOutputTokens` there. (Whether 4 is right for the input side is itself
 * unmeasured; miser-pipeline-sll.3 owns that, and the method is written down on
 * miser-report-z52.3.) */
export const estimateTokens = (chars: number): number => Math.round(chars / 4);

// How assistant OUTPUT tokenizes, measured rather than assumed.
//
// A call that emitted no thinking block has `output_tokens` exactly equal to the token
// count of its visible blocks — so every such call is a free, exact calibration point,
// and there are 14,564 of them in the corpus. Fitting
// `output = chars/CHARS_PER_TOKEN + blocks*TOKENS_PER_BLOCK` on half of them and
// scoring the other half gives -1.19% aggregate error, against -47.5% for chars/4:
// assistant output is dense code, JSON and markdown, and chars/4 under-counts it by
// nearly half. The per-block term is real — id, name and JSON scaffolding cost tokens
// no character count sees.
//
// REFIT after the request-group usage bug (see `completeUsage` in calls.ts). The first
// fit read a partial `output_tokens` on 15% of calls, which taught it that output was
// cheaper per character than it is; on corrected data those constants score -3.20%.
// A calibration is only ever as true as the measurement it was fit against, so this
// pair is stated with the fit that produced it and must be refit if that changes.
//
// [LAW:one-type-per-behavior] One character coefficient, not one for prose and one for
// tool_use JSON. The three-parameter fit separated them by less than its own error bar
// and scored no better held out.
export const OUTPUT_CHARS_PER_TOKEN = 2.585;
export const OUTPUT_TOKENS_PER_BLOCK = 50.16;

/** Estimated tokens for the VISIBLE part of a call's output: its text and tool_use
 * blocks. Never the thinking block, whose text the transcript writer strips. */
export const visibleOutputTokens = (chars: number, blocks: number): number =>
  Math.round(chars / OUTPUT_CHARS_PER_TOKEN + blocks * OUTPUT_TOKENS_PER_BLOCK);

/** How a token count was arrived at.
 *
 * PROJECT.md's load-bearing invariant is that exact numbers are authoritative and
 * estimates are labeled and never adjust them. Pairing the count with its basis is
 * what stops an estimate reaching a page wearing an exact number's clothes — the same
 * job `Projection` does for costs, and for the same reason. [LAW:types-are-the-program] */
export type Basis =
  /** Straight off an API `usage` block. Authoritative. */
  | 'exact-api-usage'
  /** Reconstructed from characters. Ranks causes; never adjusts an exact number. */
  | 'estimated-from-chars';

/** A token count that knows how well it is known. */
export interface Size {
  tokens: number;
  basis: Basis;
}

// Constructors, so the basis tag is never typed by hand where it could be typed wrongly.
export const exactSize = (tokens: number): Size => ({ tokens, basis: 'exact-api-usage' });
export const estimatedSize = (chars: number): Size => ({
  tokens: estimateTokens(chars),
  basis: 'estimated-from-chars',
});

// Constructors for the two projections that reach a page, so the projection tag is
// never typed by hand at a call site (where it could be typed wrongly).
export const eqCost = (v: number): Cost => ({
  value: Math.round(v),
  projection: 'input-equivalent-tokens',
});
export const usdCost = (v: number): Cost => ({ value: Number(v.toFixed(4)), projection: 'usd' });
