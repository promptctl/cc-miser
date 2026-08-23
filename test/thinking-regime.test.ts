// The property miser-report-z52.3 exists to guarantee: what a thinking block costs the
// context window is decided by its KIND, never by whether the transcript writer kept its
// text. Two transcripts of the same session — one from a model that strips its reasoning,
// one from a model that retains it — must produce the same numbers.
//
// [LAW:behavior-not-structure] These assert the contract (regime invariance, exact
// sizing, honest remainders), not how calls.ts happens to compute it. Any
// implementation that gets residency from the API's own output figure passes; any that
// reconstructs it from characters fails, which is the point.

import { expect, test, describe } from 'bun:test';
import { buildConversation } from '../src/calls.ts';
import { parseTranscript } from '../src/records.ts';
import { splitOutput, totalOutput } from '../src/output.ts';
import { findEpochs, trueCost } from '../src/residency.ts';
import { fixtureModels, REASONING, twoCallSession } from './fixtures.ts';

const convOf = (text: string) => buildConversation(parseTranscript(text).lines);

// Coefficients chosen, not fit: the subject here is how output DIVIDES once a tokenizer
// exists, and every assertion below holds for any coefficients — `remainder` is defined
// as `total - visible` whatever `visible` comes out to. Pinning them keeps these tests
// from depending on whichever corpus the machine running them happens to hold.
const models = fixtureModels({ 'claude-opus-5': { charsPerToken: 2.5, tokensPerBlock: 50 } });

const stripping = convOf(twoCallSession(''));
const retaining = convOf(twoCallSession(REASONING));

const arenaOf = (c: ReturnType<typeof convOf>) =>
  c.arrivals.map((a) => `${a.bornBeforeCall}/${a.source}/${a.size.tokens}/${a.size.basis}`);

describe('the fixture actually exercises the difference', () => {
  // Without this, "the two regimes agree" could pass because the two transcripts are
  // identical. It has to be established that they are not.
  test('the retaining transcript carries reasoning text the stripping one does not', () => {
    const chars = (c: ReturnType<typeof convOf>) =>
      c.calls.flatMap((k) => k.blocks).reduce((a, b) => a + (b.kind === 'thinking' ? b.chars : 0), 0);
    expect(chars(stripping)).toBe(0);
    expect(chars(retaining)).toBeGreaterThan(2000);
  });

  test('both regimes parse to the same calls with the same exact usage', () => {
    expect(stripping.calls.length).toBe(2);
    expect(retaining.calls.map((c) => c.usage)).toEqual(stripping.calls.map((c) => c.usage));
  });
});

describe('residency is regime-invariant', () => {
  test('every arrival is identical under both regimes', () => {
    expect(arenaOf(retaining)).toEqual(arenaOf(stripping));
  });

  test('true cost of the assistant output is identical under both regimes', () => {
    const cost = (c: ReturnType<typeof convOf>) => {
      const r = findEpochs(c.calls);
      const out = c.arrivals.filter((a) => a.source === 'assistantOutput');
      return out.map((a) => trueCost(a, a.size.tokens, r).total);
    };
    expect(cost(retaining)).toEqual(cost(stripping));
  });
});

describe('assistant output is sized exactly, not estimated', () => {
  test('each assistant-output arrival equals its call usage.output', () => {
    const out = stripping.arrivals.filter((a) => a.source === 'assistantOutput');
    expect(out.map((a) => a.size.tokens)).toEqual([900, 1400]);
    expect(out.map((a) => a.size.basis)).toEqual(['exact-api-usage', 'exact-api-usage']);
  });

  test('tool results and user text stay labelled as estimates', () => {
    const rest = stripping.arrivals.filter((a) => a.source !== 'assistantOutput');
    expect(rest.length).toBeGreaterThan(0);
    for (const a of rest) expect(a.size.basis).toBe('estimated-from-chars');
  });

  test('output arrives one call later than the call that produced it', () => {
    // Content the model emits at call i is in the prompt from call i+1 onward, never
    // in its own. Getting this off by one would charge every call for its own output.
    const out = stripping.arrivals.filter((a) => a.source === 'assistantOutput');
    expect(out.map((a) => a.bornBeforeCall)).toEqual([1, 2]);
  });
});

describe('the output split names its remainder honestly', () => {
  test('a call with a thinking block reports reasoning', () => {
    const s = splitOutput(stripping.calls[0]!, models);
    expect(s.kind).toBe('split');
    if (s.kind !== 'split') throw new Error('unreachable: the fixture model is calibrated');
    expect(s.total).toBe(900);
    expect(s.remainder.kind).toBe('reasoning');
    expect(s.remainder.tokens).toBe(900 - s.visible);
  });

  test('a call with no thinking block reports estimator error, not reasoning', () => {
    // The same subtraction, a different meaning. A single `reasoning` field would have
    // booked this as reasoning on a call that did none.
    const noThink = convOf(
      twoCallSession('').replace(/\{"type":"thinking"[^}]*\}/g, '{"type":"text","text":""}'),
    );
    const s = splitOutput(noThink.calls[0]!, models);
    if (s.kind !== 'split') throw new Error('unreachable: the fixture model is calibrated');
    expect(s.remainder.kind).toBe('estimator-error');
    expect(totalOutput(noThink.calls, models).reasoning).toBe(0);
    expect(totalOutput(noThink.calls, models).callsWithReasoning).toBe(0);
  });

  test('the split is regime-invariant: visible and reasoning do not move', () => {
    expect(totalOutput(retaining.calls, models)).toEqual(totalOutput(stripping.calls, models));
  });

  test('exact totals are never adjusted by the estimate', () => {
    // PROJECT.md's invariant. `total` comes off usage and must equal it whatever the
    // visible estimate does.
    const t = totalOutput(retaining.calls, models);
    expect(t.total).toBe(retaining.calls.reduce((a, c) => a + c.usage.output, 0));
  });

  test('the four figures close on the exact total, uncalibrated included', () => {
    // The ledger's closure property, now that a fourth bucket exists. If an uncalibrated
    // call's output were dropped rather than bucketed, this is what would catch it.
    const t = totalOutput(retaining.calls, models);
    expect(t.visible + t.reasoning + t.estimatorError + t.uncalibrated).toBe(t.total);
  });
});
