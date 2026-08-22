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
 * granularity, not billing accuracy. */
export const estimateTokens = (chars: number): number => Math.round(chars / 4);

// Constructors for the two projections that reach a page, so the projection tag is
// never typed by hand at a call site (where it could be typed wrongly).
export const eqCost = (v: number): Cost => ({
  value: Math.round(v),
  projection: 'input-equivalent-tokens',
});
export const usdCost = (v: number): Cost => ({ value: Number(v.toFixed(4)), projection: 'usd' });
