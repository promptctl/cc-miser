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

// WHERE THE DOLLARS AND THE OUTPUT TOKENIZER WENT. Both used to live here as global
// constants: `USD_PER_INPUT_MTOK`/`USD_PER_OUTPUT_MTOK` measured on the one model this
// laptop happened to run, and `OUTPUT_CHARS_PER_TOKEN`/`OUTPUT_TOKENS_PER_BLOCK` fit
// with every model POOLED. Both are model-dependent facts, and a global is the claim
// that they are not. Pooling was the more expensive lie: refit per model on corrected
// data, the 4.6 family tokenizes at ~3.9 chars/token against ~2.6 for the 5 family and
// Opus 4.8, so the pooled constant scored +30% and +50% held out on those two models.
// Both now live in `models.ts`, keyed by model id. [LAW:one-source-of-truth]

/** chars→tokens heuristic for English/code (~4 chars per token). Attribution
 * granularity, not billing accuracy.
 *
 * THE ONE SURVIVING GLOBAL CHARACTER CONSTANT, and it is a different constant from the
 * output one that just left: this sizes INPUT-side arrivals — tool results, user text,
 * attachments — which no model produced and which therefore have no model id to key on.
 * It also has no free calibration source the way output does, so it needs a method of
 * its own rather than a table row. miser-pipeline-sll.3 owns that; the method is written
 * down on miser-report-z52.3. Until then, 4 is unmeasured and is labelled as an estimate
 * wherever it reaches a page. */
export const estimateTokens = (chars: number): number => Math.round(chars / 4);

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
