// What is resident in the context window over the call sequence, and what that
// residency cost.
//
// [LAW:effects-at-boundaries] Pure. Takes calls, returns arithmetic.

import type { Arrival, Call } from './calls.ts';
import { CACHE_READ_MULTIPLE, WRITE_MULTIPLE } from './tokens.ts';

/** A maximal run of calls over which the cached prefix survives.
 *
 * A new epoch begins when `cache_read` DROPS relative to the previous call: the
 * cached prefix is gone, so everything still needed must be re-written at 1.25x
 * instead of re-read at 0.1x. This is the event PROJECT.md calls cache thrash, and on
 * the hand-traced specimen a single one of them was 14.6% of the whole session. */
export interface Epoch {
  index: number;
  start: number;
  end: number;
  /** Tokens re-written at this boundary that a live cache would have re-read. */
  rewrittenTokens: number;
  gapBeforeMs: number;
}

/** The epochs, plus the epoch each call belongs to.
 *
 * [LAW:types-are-the-program] `epochOfCall` is returned rather than recovered later by
 * scanning for the epoch whose range contains a call. That scan can miss — and every
 * caller of it wrote `find(...)!` to promise it wouldn't. Building the index here
 * makes the lookup total by construction, which deletes the promises. */
export interface Residency {
  epochs: Epoch[];
  epochOfCall: number[];
}

export function findEpochs(calls: readonly Call[]): Residency {
  const boundaries = [0];
  for (let i = 1; i < calls.length; i++)
    if (calls[i]!.usage.cacheRead < calls[i - 1]!.usage.cacheRead) boundaries.push(i);

  const epochs = boundaries.map((start, k) => {
    const end = (boundaries[k + 1] ?? calls.length) - 1;
    return {
      index: k,
      start,
      end,
      rewrittenTokens: k === 0 ? 0 : calls[start]!.usage.cacheCreation,
      gapBeforeMs: start === 0 ? 0 : calls[start]!.ts - calls[start - 1]!.ts,
    };
  });

  const epochOfCall = new Array<number>(calls.length).fill(0);
  for (const e of epochs) for (let i = e.start; i <= e.end; i++) epochOfCall[i] = e.index;
  return { epochs, epochOfCall };
}

/** The excess a single invalidation cost: the same tokens at write price instead of
 * read price. */
export const invalidationExcess = (e: Epoch): number =>
  e.rewrittenTokens * (WRITE_MULTIPLE - CACHE_READ_MULTIPLE);

export interface PerCallCheck {
  call: number;
  expected: number;
  actual: number;
  delta: number;
  /** False for a call at its own epoch's start: there `expected` reduces to the call's
   * own reported `cacheRead` with nothing added, so it equals `actual` by construction
   * rather than by the model predicting anything. Kept in `perCall` because it's still a
   * real term of `predictedCacheRead` — the aggregate sum isn't inflated by it, since
   * `actualCacheRead` sums the identical value on the other side — but excluded from
   * `exactCalls`, where counting a call the model never predicted would pass off copying
   * as evidence of predictive accuracy. [LAW:no-silent-failure] */
  predictable: boolean;
}

export interface ConservationCheck {
  actualCacheRead: number;
  predictedCacheRead: number;
  perCall: PerCallCheck[];
  /** Calls where the model's prediction was exactly right, to the token — counted only
   * among `predictable` calls. */
  exactCalls: number;
  /** How many calls were eligible to count toward `exactCalls`, i.e. `predictable` ones.
   * The correct denominator for the trust ratio; `perCall.length` also includes the
   * epoch-openers that can only ever match. */
  predictableCalls: number;
}

/** THE CONSERVATION CHECK.
 *
 * Two independent routes to one quantity, both built only from exact API numbers.
 * Route A sums the reported `cache_read`. Route B predicts it from the residency
 * model: an epoch opens on whatever prefix survived into it, and everything written at
 * call i is re-read by every later call in i's epoch. If the model is right they agree;
 * the gap measures what the model fails to explain, and is reported rather than hidden.
 * [LAW:no-silent-failure]
 *
 * THE BASE TERM IS NOT OPTIONAL, and leaving it out is the most expensive thing this
 * file has done. The model previously predicted a call's `cache_read` from prior
 * cache_creation ALONE, which is the same equation with `cache_read(epochStart)` assumed
 * to be zero. It recorded, as its licence for every residency-derived number downstream,
 * that it "held on 28 of 28 calls of the hand-traced specimen" — and it did, because that
 * specimen opened cold. On the corpus scanned when this fix landed (47,782 calls) it held
 * on only 26.2% without the base term; 56.3% of epochs opened on a prefix that survived,
 * and for each of those the prediction was short by the whole surviving prefix, on every
 * call in the epoch.
 *
 * WITH the base term restored, re-measured on a LATER scan of 42,642 calls (corpus size
 * moves between scans; the 47,782 above and the 42,642 here are two different snapshots,
 * not the same population before and after) — 84.3% match INCLUDING epoch-openers, which
 * match trivially by construction (see `PerCallCheck.predictable` below) and so cannot be
 * evidence of anything; over the 41,886 predictable calls only — the honest population —
 * it's 84.0%. That predictable-only figure is what `src/invariants.ts`'s
 * `residency-predicts-cache-read` basis states and measures, and the one to trust; expect
 * both numbers here to drift on the next re-measurement, since the corpus this comment
 * reads is live. A theorem checked on the one specimen that cannot disprove it is not
 * checked.
 *
 * WHAT THE REMAINING 15% IS. The per-call form is cumulative: one bad boundary poisons
 * every later call in its epoch. Stated LOCALLY instead — each call's `cache_read` equals
 * the previous call's `cache_read` plus what the previous call wrote — the same model
 * holds on 99.15% of 46,462 boundaries. `src/invariants.ts` checks the local form for
 * exactly that reason: it names the one boundary that broke rather than the fifty calls
 * downstream of it.
 *
 * NOT EVERY CALL IS A PREDICTION. A call at its own epoch's start has no prior call in
 * the same epoch to predict it from, so `expected` reduces to that call's own
 * `cacheRead` compared to itself. See `PerCallCheck.predictable`. */
export function conservation(calls: readonly Call[], r: Residency): ConservationCheck {
  const perCall = calls.map((c) => {
    const e = r.epochs[r.epochOfCall[c.index]!]!;
    const expected =
      calls[e.start]!.usage.cacheRead +
      calls.slice(e.start, c.index).reduce((a, prior) => a + prior.usage.cacheCreation, 0);
    return {
      call: c.index,
      expected,
      actual: c.usage.cacheRead,
      delta: c.usage.cacheRead - expected,
      predictable: c.index !== e.start,
    };
  });
  const predictable = perCall.filter((p) => p.predictable);
  return {
    actualCacheRead: calls.reduce((a, c) => a + c.usage.cacheRead, 0),
    // [LAW:one-source-of-truth] Summed from `perCall` rather than derived a second way
    // from the epoch spans. The two were independent expressions of one model, free to
    // disagree about it — and they did, the moment the base term was added to one of
    // them. The aggregate is a projection of the per-call result, so it cannot drift.
    predictedCacheRead: perCall.reduce((a, p) => a + p.expected, 0),
    perCall,
    exactCalls: predictable.filter((p) => p.delta === 0).length,
    predictableCalls: predictable.length,
  };
}

/** True cost of one arrival over its whole life — the number naive accounting misses.
 *
 * The figure people quote for a file read is its size. The figure they pay is its size
 * times how many epochs it lived through and how many calls re-read it: position and
 * lifetime, not size. On the specimen this was a 3.9x understatement. */
export interface TrueCost {
  label: string;
  estTokens: number;
  bornAtCall: number;
  /** One entry per epoch the content lived through; each costs a fresh write. */
  lives: Array<{ epoch: number; writeAtCall: number; reads: number }>;
  writeCost: number;
  readCost: number;
  total: number;
  /** What naive accounting would call it: just the size. */
  naive: number;
  multiple: number;
}

export function trueCost(a: Arrival, estTokens: number, r: Residency): TrueCost {
  const lives: TrueCost['lives'] = [];
  for (const e of r.epochs) {
    if (e.end < a.bornBeforeCall) continue; // content did not exist yet
    const writeAt = Math.max(e.start, a.bornBeforeCall);
    if (writeAt > e.end) continue;
    lives.push({ epoch: e.index, writeAtCall: writeAt, reads: e.end - writeAt });
  }
  const writeCost = lives.length * estTokens * WRITE_MULTIPLE;
  const readCost = lives.reduce((s, l) => s + l.reads, 0) * estTokens * CACHE_READ_MULTIPLE;
  const total = writeCost + readCost;
  return {
    label: a.label,
    estTokens,
    bornAtCall: a.bornBeforeCall,
    lives,
    writeCost,
    readCost,
    total,
    naive: estTokens,
    multiple: estTokens === 0 ? 0 : total / estTokens,
  };
}
