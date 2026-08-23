// Everything the report knows about a model id: how its output tokenizes, and what it
// costs. One lookup, keyed by model id, consulted by every consumer of either fact.
//
// [LAW:one-source-of-truth] One table, not a tokenizer table beside a pricing table.
// Two structures keyed the same way is a divergence with a schedule rather than a risk,
// and a caller that consults one but not the other is how a report ends up pricing a
// model it could not calibrate without ever saying so.
//
// WHY THE TWO HALVES ARE OBTAINED DIFFERENTLY, and why that is not two tables.
// The tokenizer half is a MEASUREMENT of the corpus in front of us: a call that emitted
// no thinking block has `output_tokens` exactly equal to the token count of its visible
// blocks, so every such call is a free, exact calibration point. Any corpus on any
// machine therefore calibrates itself, for whatever models it happens to contain. The
// price half is EXTERNAL KNOWLEDGE that no transcript contains — no amount of trace data
// tells you what Anthropic charges — so it is a published catalogue with a source and a
// date. Different provenance, same key, one lookup: a row says both what we measured and
// what we were told, and each half says which it is.
//
// [LAW:no-silent-failure] A model id absent from either half produces a typed absence
// carrying the REASON, never a fallback to some other model's numbers. That is the
// worst failure in the family: it fires precisely when a corpus contains something
// unfamiliar — the expected case on an enterprise machine — and answers confidently
// with the wrong number rather than refusing.

import { inputEquivalents, spend, type Usage } from './tokens.ts';

/** A fact we either have or can name the absence of.
 *
 * [LAW:parse-dont-validate] The miss carries `why`, so the report can tell a reader
 * WHICH models it could not handle and on what grounds. An `undefined` return would
 * have collapsed "no such model in the catalogue" and "too few calibration points"
 * into one indistinguishable nothing. */
export type Lookup<T> = { found: true; value: T } | { found: false; why: string };

const found = <T>(value: T): Lookup<T> => ({ found: true, value });
const missing = <T>(why: string): Lookup<T> => ({ found: false, why });

// ---------------------------------------------------------------------------
// Model ids
// ---------------------------------------------------------------------------

/** A dated snapshot id reduced to the alias that names the same model.
 *
 * Anthropic publishes each model under an alias and a dated full id — `claude-haiku-4-5`
 * and `claude-haiku-4-5-20251001` are one model at one price, and this corpus contains
 * only the dated form. Stripping the date is therefore not a guess about an unknown id;
 * it is the documented equivalence, and it is the ONLY normalisation performed here.
 *
 * [LAW:comments-carry-meaning] What is deliberately NOT normalised, and why each would
 * be a wrong number rather than a missing one:
 *   - `anthropic.claude-opus-5` (Amazon Bedrock) and `claude-opus-4-5@20251101` (Vertex)
 *     name the same MODELS but are served by partners at their own negotiated rates.
 *     Mapping them onto a first-party price would answer confidently and wrongly. Left
 *     unrecognised, they price as a named gap — the honest outcome — while still
 *     calibrating their own tokenizer, because the fit keys on whatever string appears
 *     and needs no catalogue at all.
 *   - `<synthetic>`, which Claude Code writes for calls it fabricates locally. Its usage
 *     vector is all zeros across all 34 occurrences here, so it contributes nothing to
 *     any total and needs no special case: it simply prices as an unpriced model worth
 *     $0, and the arithmetic stays true. */
export const canonicalModelId = (raw: string): string => raw.replace(/-\d{8}$/, '');

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

/** USD per million tokens. The input rate is charged against INPUT-EQUIVALENT tokens —
 * see `inputEquivalents` in tokens.ts — because the cache multipliers are properties of
 * the caching API rather than of any one model. */
export interface Rate {
  usdPerInputMtok: number;
  usdPerOutputMtok: number;
}

/** What a model costs, and when.
 *
 * [LAW:no-ambient-temporal-coupling] A rate is a fact about a model AT A TIME, and a
 * corpus spans months. Claude Sonnet 5 shipped at an introductory $2/$10 through
 * 2026-08-31 and $3/$15 after, so a session's dollar figure genuinely depends on when it
 * ran; pricing every session at today's rate would overstate the largest model in this
 * corpus by 50%. Making time an explicit input rather than an ambient assumption is what
 * keeps that from being invisible.
 *
 * [LAW:types-are-the-program] `initial` is separate from `changes` so that "no rate was
 * in effect yet" is unrepresentable — every instant from the epoch onward resolves. */
export interface Pricing {
  /** In effect until the first change. */
  initial: Rate;
  /** Rate changes, ascending by `from` (epoch ms). */
  changes: readonly { from: number; rate: Rate }[];
}

const rate = (usdPerInputMtok: number, usdPerOutputMtok: number): Rate => ({
  usdPerInputMtok,
  usdPerOutputMtok,
});

/** Where the numbers below came from, carried to the page rather than left in a comment.
 * A dollar figure whose rate card has no date is a number nobody can check. */
export const PRICE_SOURCE =
  'Anthropic first-party API list rates, as published 2026-08-22. Partner-served models (Amazon Bedrock, Google Vertex) are priced separately by those platforms and are deliberately absent.';

/** Published list rates, keyed by canonical model id.
 *
 * Models this corpus has never seen are included: a price is external knowledge, not a
 * measurement, so knowing it costs nothing to carry and is exactly what a machine with a
 * different model mix will need. [LAW:carrying-cost]
 *
 * Models whose rate could not be sourced are deliberately ABSENT rather than guessed at
 * from a neighbouring tier. An absent row is a named gap on the page; a guessed row is a
 * wrong number nobody can see. */
const PRICES: ReadonlyMap<string, Pricing> = new Map<string, Pricing>([
  ['claude-fable-5', { initial: rate(10, 50), changes: [] }],
  ['claude-mythos-5', { initial: rate(10, 50), changes: [] }],
  ['claude-opus-5', { initial: rate(5, 25), changes: [] }],
  ['claude-opus-4-8', { initial: rate(5, 25), changes: [] }],
  ['claude-opus-4-7', { initial: rate(5, 25), changes: [] }],
  ['claude-opus-4-6', { initial: rate(5, 25), changes: [] }],
  [
    'claude-sonnet-5',
    {
      // Introductory pricing through 2026-08-31; standard rates from 2026-09-01.
      initial: rate(2, 10),
      changes: [{ from: Date.UTC(2026, 8, 1), rate: rate(3, 15) }],
    },
  ],
  ['claude-sonnet-4-6', { initial: rate(3, 15), changes: [] }],
  ['claude-haiku-4-5', { initial: rate(1, 5), changes: [] }],
]);

/** The rate in effect for a model at an instant.
 *
 * [LAW:dataflow-not-control-flow] One code path whatever the rate history: a model with
 * a single rate is a `changes` list of length zero, not a separate case. */
export function rateAt(model: string, atMs: number): Lookup<Rate> {
  const id = canonicalModelId(model);
  const pricing = PRICES.get(id);
  if (!pricing) return missing(`no published rate for ${id}`);
  let current = pricing.initial;
  for (const change of pricing.changes) if (atMs >= change.from) current = change.rate;
  return found(current);
}

// ---------------------------------------------------------------------------
// Tokenizer calibration
// ---------------------------------------------------------------------------

/** One free, exact calibration point: a call that emitted no thinking block, so its
 * `output_tokens` IS the token count of the visible blocks whose size is recorded here.
 *
 * Extracted by `output.ts`, which owns the rule for what counts as a visible block and
 * how many characters it is. [LAW:one-source-of-truth] This module deliberately does not
 * re-derive that from `Call` — two implementations of "visible" would be two answers. */
export interface CalibrationPoint {
  model: string;
  chars: number;
  blocks: number;
  /** Exact, from the API `usage` block. */
  outputTokens: number;
}

/** How one model's visible output tokenizes, measured rather than assumed. */
export interface TokenizerFit {
  /** Characters per output token for this model's text and tool_use blocks. */
  charsPerToken: number;
  /** Tokens per block, independent of characters — id, name and JSON scaffolding cost
   * tokens no character count sees. */
  tokensPerBlock: number;
  /** Calibration points the published coefficients were fit on. */
  points: number;
  /** Transcripts those points came from. */
  transcripts: number;
  /** Signed aggregate error of a half-corpus fit scored on transcripts it never saw,
   * as a fraction: +0.05 means the estimator overstates that half's output by 5%.
   *
   * Measured by holding out whole TRANSCRIPTS rather than alternate calls. Interleaving
   * calls puts the same session on both sides of the split and reports an error bar that
   * flatters itself — Sonnet 5 scores -0.00% that way and +1.58% honestly. What a reader
   * needs is how the fit behaves on sessions it has never seen, because that is the only
   * question a corpus on another machine is asking. */
  heldOutError: number;
}

/** Fits below this many points are not published.
 *
 * Chosen by measurement, not by taste: fitting contiguous slices of a well-populated
 * model and scoring against its full population, the median absolute error is 3-4% at 32
 * points and roughly doubles at 16, where the fitted chars-per-token ranges from 1.8 to
 * 7.5 — values no tokenizer has. The threshold's job is only to reject fits that are
 * undetermined; fit QUALITY is disclosed rather than gated, via `heldOutError` on every
 * published row, so a thin fit reaches the page visibly thin instead of silently. */
const MIN_POINTS = 32;

/** Non-negative least squares for `output = chars*a + blocks*b`.
 *
 * [LAW:types-are-the-program] Negative coefficients are the one thing the physics
 * forbids — no quantity of characters can subtract tokens — so a noisy sample that lands
 * outside the non-negative quadrant is refitted on its boundary rather than published or
 * discarded. With two variables the boundary search is exhaustive: try each axis, keep
 * whichever has the smaller residual. */
function nonNegativeFit(points: readonly CalibrationPoint[]): { a: number; b: number } {
  let cc = 0;
  let bb = 0;
  let cb = 0;
  let cy = 0;
  let by = 0;
  for (const p of points) {
    cc += p.chars * p.chars;
    bb += p.blocks * p.blocks;
    cb += p.chars * p.blocks;
    cy += p.chars * p.outputTokens;
    by += p.blocks * p.outputTokens;
  }

  const det = cc * bb - cb * cb;
  if (det > 0) {
    const a = (cy * bb - by * cb) / det;
    const b = (by * cc - cy * cb) / det;
    if (a >= 0 && b >= 0) return { a, b };
  }

  const residual = (a: number, b: number): number =>
    points.reduce((acc, p) => acc + (p.chars * a + p.blocks * b - p.outputTokens) ** 2, 0);
  const aOnly = cc > 0 ? Math.max(0, cy / cc) : 0;
  const bOnly = bb > 0 ? Math.max(0, by / bb) : 0;
  return residual(aOnly, 0) <= residual(0, bOnly) ? { a: aOnly, b: 0 } : { a: 0, b: bOnly };
}

/** Signed aggregate error of a fit over a set of points: how far the estimator's total
 * lands from the exact total those points were billed. */
function aggregateError(points: readonly CalibrationPoint[], a: number, b: number): number {
  let predicted = 0;
  let actual = 0;
  for (const p of points) {
    predicted += p.chars * a + p.blocks * b;
    actual += p.outputTokens;
  }
  return actual === 0 ? 0 : (predicted - actual) / actual;
}

/** One transcript's contribution to the calibration.
 *
 * [LAW:types-are-the-program] The two fields are NOT the same population and the type
 * says so. `points` holds only the calls that are exact observations — the ones that
 * emitted no thinking block. `models` holds every model the transcript ran, calibratable
 * or not, and is the honest denominator for "how much of this corpus did we manage to
 * calibrate". Deriving that denominator from `points` instead, as an earlier version
 * did, makes a model whose every call thinks invisible: Haiku appears in this corpus
 * exclusively inside subagents that always think, so it produced no points, vanished
 * from the coverage figure, and the page reported full calibration coverage while
 * quietly failing to split Haiku's output. */
export interface CalibrationGroup {
  models: readonly string[];
  points: readonly CalibrationPoint[];
}

/** The assembled table. One lookup per fact, both keyed by canonical model id. */
export interface ModelTable {
  tokenizers: ReadonlyMap<string, TokenizerFit>;
  /** Every model id the calibration corpus ran, canonical form — including the ones that
   * produced no fit, which are exactly the ones a reader needs named. */
  seen: readonly string[];
}

/** Fit one tokenizer per model id from the corpus at hand.
 *
 * [LAW:effects-at-boundaries] Pure. Points in, coefficients out — the caller reads the
 * transcripts.
 *
 * Takes points GROUPED BY TRANSCRIPT because the hold-out split is by transcript: a fit
 * has to be scored on sessions it never saw. Grouping is the caller's knowledge (it
 * opened the files), so it is carried in the argument shape rather than recovered from a
 * field on the points. [LAW:no-ambient-temporal-coupling] The split alternates groups by
 * position, which is a property of the set handed in, not of the order the filesystem
 * happened to yield. */
export function fitTokenizers(groups: readonly CalibrationGroup[]): ModelTable {
  // One bucket of transcript-groups per model, so both the fit and the split can be
  // taken per model without re-walking the corpus.
  const byModel = new Map<string, CalibrationPoint[][]>();
  const seen = new Set<string>();
  for (const group of groups) {
    for (const m of group.models) seen.add(canonicalModelId(m));
    const perModel = new Map<string, CalibrationPoint[]>();
    for (const p of group.points) {
      const id = canonicalModelId(p.model);
      const arr = perModel.get(id) ?? [];
      arr.push(p);
      perModel.set(id, arr);
    }
    for (const [id, arr] of perModel) {
      const bucket = byModel.get(id) ?? [];
      bucket.push(arr);
      byModel.set(id, bucket);
    }
  }

  const tokenizers = new Map<string, TokenizerFit>();
  for (const [id, transcripts] of byModel) {
    const all = transcripts.flat();
    if (all.length < MIN_POINTS) continue;

    const fit = nonNegativeFit(all);
    // A zero character coefficient means the sample carries no characters-to-tokens
    // relationship at all — `<synthetic>`, whose every call is billed zero output. There
    // is nothing to publish and no chars-per-token to state.
    if (fit.a <= 0) continue;

    // Score a half-corpus fit on the transcripts it never saw. Where a model appears in
    // only one transcript there is no unseen half to score against, and the row is not
    // published: an estimator whose error cannot be measured is exactly the thing this
    // ticket exists to stop shipping.
    const train = transcripts.filter((_, i) => i % 2 === 0).flat();
    const test = transcripts.filter((_, i) => i % 2 === 1).flat();
    if (train.length === 0 || test.length === 0) continue;
    const trained = nonNegativeFit(train);

    tokenizers.set(id, {
      charsPerToken: 1 / fit.a,
      tokensPerBlock: fit.b,
      points: all.length,
      transcripts: transcripts.length,
      heldOutError: aggregateError(test, trained.a, trained.b),
    });
  }

  return { tokenizers, seen: [...seen].sort() };
}

/** The tokenizer for a model, or the reason there is none. */
export function tokenizerFor(table: ModelTable, model: string): Lookup<TokenizerFit> {
  const id = canonicalModelId(model);
  const fit = table.tokenizers.get(id);
  return fit
    ? found(fit)
    : missing(`no usable calibration for ${id} in this corpus (needs ${MIN_POINTS}+ calls that emitted no thinking block, across at least two transcripts)`);
}

/** Estimated tokens for the VISIBLE part of a call's output — its text and tool_use
 * blocks, never the thinking block whose text the transcript writer strips. */
export const visibleOutputTokens = (fit: TokenizerFit, chars: number, blocks: number): number =>
  Math.round(chars / fit.charsPerToken + blocks * fit.tokensPerBlock);

// ---------------------------------------------------------------------------
// Pricing a set of calls
// ---------------------------------------------------------------------------

/** What one usage vector costs in USD at one rate.
 *
 * The input rate is charged against input-EQUIVALENT tokens: tokens.ts owns the cache
 * multipliers (properties of the caching API), this module owns the rates (properties of
 * the model), and neither restates the other. [LAW:decomposition] */
export const usdAt = (r: Rate, u: Usage): number =>
  (inputEquivalents(u) * r.usdPerInputMtok + u.output * r.usdPerOutputMtok) / 1_000_000;

/** A call, reduced to what pricing needs. A model and an instant, because a rate is a
 * fact about a model AT A TIME. */
export interface Billable {
  model: string;
  /** When the call was made, epoch ms — the instant whose rate card applies. */
  ts: number;
  usage: Usage;
}

/** A dollar total that cannot be read without reading what it failed to cover.
 *
 * [LAW:types-are-the-program] The whole point of this shape. `usd` alone would be an
 * answer-shaped void: a corpus where half the models are unknown produces a small,
 * confident, wrong-looking-like-right number, and nothing about it says so. Because the
 * unpriced remainder rides in the same value, a renderer physically cannot show the
 * dollars without having been handed the gap. */
export interface PriceTotals {
  usd: number;
  /** Spend — input-equivalent tokens plus output — that carried a published rate. */
  pricedSpend: number;
  /** Spend that did not. The honest counterpart to `usd`, in the same units as
   * `pricedSpend`, so the share is a division rather than a comparison of apples. */
  unpricedSpend: number;
  /** Which model ids could not be priced, and why — named so a reader can act on it
   * rather than wonder. */
  unpriced: readonly { model: string; why: string }[];
  unpricedCalls: number;
  calls: number;
}

export const ZERO_PRICES: PriceTotals = {
  usd: 0,
  pricedSpend: 0,
  unpricedSpend: 0,
  unpriced: [],
  unpricedCalls: 0,
  calls: 0,
};

/** Roll two price totals together. [LAW:composability] One associative combine, so the
 * per-session and per-corpus figures are the same arithmetic. */
export const addPrices = (a: PriceTotals, b: PriceTotals): PriceTotals => {
  const merged = new Map(a.unpriced.map((u) => [u.model, u]));
  for (const u of b.unpriced) merged.set(u.model, u);
  return {
    usd: a.usd + b.usd,
    pricedSpend: a.pricedSpend + b.pricedSpend,
    unpricedSpend: a.unpricedSpend + b.unpricedSpend,
    unpriced: [...merged.values()].sort((x, y) => x.model.localeCompare(y.model)),
    unpricedCalls: a.unpricedCalls + b.unpricedCalls,
    calls: a.calls + b.calls,
  };
};

/** Price every call at its own model's rate, at its own instant.
 *
 * [LAW:effects-at-boundaries] Pure. [LAW:dataflow-not-control-flow] Every call lands in
 * exactly one of two named buckets; neither is a fallback for the other, and no call is
 * skipped. A model with no published rate contributes its spend to `unpricedSpend` and
 * nothing to `usd` — never a neighbouring model's rate, which is the failure this whole
 * module exists to prevent. */
export function priceCalls(items: readonly Billable[]): PriceTotals {
  const totals = { ...ZERO_PRICES, calls: items.length };
  const unpriced = new Map<string, { model: string; why: string }>();
  for (const item of items) {
    const r = rateAt(item.model, item.ts);
    const value = spend(item.usage);
    if (!r.found) {
      totals.unpricedSpend += value;
      totals.unpricedCalls++;
      unpriced.set(canonicalModelId(item.model), {
        model: canonicalModelId(item.model),
        why: r.why,
      });
      continue;
    }
    totals.usd += usdAt(r.value, item.usage);
    totals.pricedSpend += value;
  }
  totals.unpriced = [...unpriced.values()].sort((a, b) => a.model.localeCompare(b.model));
  return totals;
}
