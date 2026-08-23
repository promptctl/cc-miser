// The contract miser-portability-adi.2 exists to guarantee: every model-dependent number
// on the page is looked up by model id, and a model id the table does not know produces a
// LOUD, QUANTIFIED outcome rather than some other model's numbers wearing its name.
//
// [LAW:behavior-not-structure] These assert the contract — an unknown model is
// quarantined and named, a known one is priced at its own rate at its own instant, a fit
// recovers the tokenizer that generated its data — not how models.ts happens to compute
// any of it. Any implementation that refuses to guess passes; any that falls back to a
// neighbouring model's constants fails, which is the entire point.

import { expect, test, describe } from 'bun:test';
import { buildConversation } from '../src/calls.ts';
import { parseTranscript } from '../src/records.ts';
import { analyzeSession } from '../src/session.ts';
import { projectSession } from '../src/report/project.ts';
import type { SessionSource } from '../src/discover.ts';
import { totalOutput, calibrationGroup } from '../src/output.ts';
import {
  canonicalModelId,
  fitTokenizers,
  priceCalls,
  rateAt,
  tokenizerFor,
  type CalibrationGroup,
  type CalibrationPoint,
} from '../src/models.ts';
import { buildTranscript, fixtureModels, twoCallSession } from './fixtures.ts';

/** A model id that cannot exist: no vendor ships it, no rate card names it, and no
 * corpus can calibrate it. The only honest response to it is a refusal. */
const IMPOSSIBLE = 'claude-nonexistent-99';

const convOf = (text: string) => buildConversation(parseTranscript(text).lines);

describe('model ids resolve to exactly one row, or to none', () => {
  // The accept/reject table, written out rather than left implied. Each row is a form
  // that occurs in the wild and a decision about it; the ones deliberately NOT folded
  // together are the interesting half, because folding them would produce a confident
  // wrong price rather than a visible gap.
  test.each([
    // A dated snapshot and its alias are one model at one price — Anthropic publishes
    // both forms, and this corpus contains only the dated one.
    ['claude-haiku-4-5-20251001', 'claude-haiku-4-5'],
    // Aliases are already canonical.
    ['claude-opus-5', 'claude-opus-5'],
    // A version segment is not a date: `-4-8` must survive.
    ['claude-opus-4-8', 'claude-opus-4-8'],
    // Partner-served ids name the same MODEL at rates we do not hold. Left alone so
    // they miss the catalogue and price as a named gap.
    ['anthropic.claude-opus-5', 'anthropic.claude-opus-5'],
    ['claude-opus-4-5@20251101', 'claude-opus-4-5@20251101'],
    // Claude Code's own pseudo-model for calls it fabricates locally.
    ['<synthetic>', '<synthetic>'],
  ])('%s canonicalises to %s', (raw, canonical) => {
    expect(canonicalModelId(raw)).toBe(canonical);
  });

  test('a partner-served id is NOT priced at the first-party rate', () => {
    // The failure this guards against is the expensive kind: Bedrock and Vertex are
    // priced by those platforms, so answering with Anthropic's list rate would be
    // confidently wrong rather than missing.
    expect(rateAt('anthropic.claude-opus-5', Date.UTC(2026, 5, 1)).found).toBe(false);
    expect(rateAt('claude-opus-5', Date.UTC(2026, 5, 1)).found).toBe(true);
  });
});

describe('rates are per model and per instant', () => {
  test('an unknown model has no rate, and says which model it could not price', () => {
    const r = rateAt(IMPOSSIBLE, Date.UTC(2026, 5, 1));
    expect(r.found).toBe(false);
    if (r.found) throw new Error('unreachable');
    expect(r.why).toContain(IMPOSSIBLE);
  });

  test('two models at the same instant get their own rates, not a shared one', () => {
    const at = Date.UTC(2026, 5, 1);
    const opus = rateAt('claude-opus-5', at);
    const haiku = rateAt('claude-haiku-4-5', at);
    if (!opus.found || !haiku.found) throw new Error('unreachable: both are catalogued');
    expect(opus.value.usdPerOutputMtok).not.toBe(haiku.value.usdPerOutputMtok);
  });

  test('a model whose rate changed is priced by WHEN the call was made', () => {
    // Claude Sonnet 5 ran at introductory rates through 2026-08-31. A corpus spans
    // months, so pricing every session at today's card is a real error, not a rounding
    // one — and it is invisible unless the instant is an input.
    const intro = rateAt('claude-sonnet-5', Date.UTC(2026, 7, 15));
    const standard = rateAt('claude-sonnet-5', Date.UTC(2026, 9, 15));
    if (!intro.found || !standard.found) throw new Error('unreachable');
    expect(standard.value.usdPerInputMtok).toBeGreaterThan(intro.value.usdPerInputMtok);
    expect(standard.value.usdPerOutputMtok).toBeGreaterThan(intro.value.usdPerOutputMtok);
  });
});

describe('the tokenizer fit recovers the tokenizer that generated its data', () => {
  /** Points synthesised from known coefficients, split across `transcripts` groups. */
  const synthesise = (
    model: string,
    charsPerToken: number,
    tokensPerBlock: number,
    count: number,
    transcripts: number,
  ): CalibrationGroup[] => {
    const groups: CalibrationGroup[] = Array.from({ length: transcripts }, () => ({
      models: [model],
      points: [],
    }));
    for (let i = 0; i < count; i++) {
      const chars = 200 + ((i * 37) % 4000);
      const blocks = 1 + (i % 4);
      (groups[i % transcripts]!.points as CalibrationPoint[]).push({
        model,
        chars,
        blocks,
        outputTokens: Math.round(chars / charsPerToken + blocks * tokensPerBlock),
      });
    }
    return groups;
  };

  test('coefficients come back out within rounding', () => {
    const table = fitTokenizers(synthesise('m', 2.6, 50, 400, 8));
    const fit = tokenizerFor(table, 'm');
    if (!fit.found) throw new Error(`expected a fit: ${fit.why}`);
    expect(fit.value.charsPerToken).toBeCloseTo(2.6, 1);
    expect(fit.value.tokensPerBlock).toBeCloseTo(50, 0);
    expect(Math.abs(fit.value.heldOutError)).toBeLessThan(0.01);
    expect(fit.value.points).toBe(400);
  });

  test('two models in one corpus are fit separately, not pooled', () => {
    // The measurement that motivated this ticket: pooling models whose tokenizers differ
    // averages two physical constants and calls the average a measurement.
    const table = fitTokenizers([
      ...synthesise('dense', 2.6, 50, 200, 4),
      ...synthesise('sparse', 3.9, 40, 200, 4),
    ]);
    const dense = tokenizerFor(table, 'dense');
    const sparse = tokenizerFor(table, 'sparse');
    if (!dense.found || !sparse.found) throw new Error('unreachable: both are well populated');
    expect(dense.value.charsPerToken).toBeCloseTo(2.6, 1);
    expect(sparse.value.charsPerToken).toBeCloseTo(3.9, 1);
  });

  test('a thin sample publishes no row rather than a noisy one', () => {
    const table = fitTokenizers(synthesise('thin', 2.6, 50, 8, 2));
    expect(tokenizerFor(table, 'thin').found).toBe(false);
  });

  test('a model seen in only one transcript publishes no row', () => {
    // Nothing to hold out means no measurable error, and an estimator whose error cannot
    // be measured is the thing this ticket exists to stop shipping.
    const table = fitTokenizers(synthesise('lonely', 2.6, 50, 400, 1));
    expect(tokenizerFor(table, 'lonely').found).toBe(false);
  });

  test('a degenerate sample publishes no row', () => {
    // `<synthetic>` in the real corpus: every call billed zero output, so there is no
    // characters-to-tokens relationship to state and no chars-per-token to report.
    const groups = synthesise('zeroed', 2.6, 50, 400, 8).map((g) => ({
      ...g,
      points: g.points.map((p) => ({ ...p, outputTokens: 0 })),
    }));
    expect(tokenizerFor(fitTokenizers(groups), 'zeroed').found).toBe(false);
  });

  test('a model absent from the corpus is absent from the table', () => {
    const table = fitTokenizers(synthesise('m', 2.6, 50, 400, 8));
    const miss = tokenizerFor(table, IMPOSSIBLE);
    expect(miss.found).toBe(false);
    if (miss.found) throw new Error('unreachable');
    expect(miss.why).toContain(IMPOSSIBLE);
  });
});

describe('a transcript naming a model that cannot exist fails loudly', () => {
  // The ticket's own acceptance criterion, and the reason every type above is a union
  // rather than a number with a fallback.
  const conv = convOf(twoCallSession('', IMPOSSIBLE));
  const table = fitTokenizers([
    // A corpus that knows about a real model, and nothing at all about this one.
    calibrationGroup(convOf(twoCallSession('', 'claude-opus-5')).calls),
  ]);

  test('the fixture really does name an unknown model', () => {
    // Without this the assertions below could pass on a fixture that quietly used a
    // known model and proved nothing.
    expect(conv.calls.every((c) => c.model === IMPOSSIBLE)).toBe(true);
    expect(rateAt(IMPOSSIBLE, conv.calls[0]!.ts).found).toBe(false);
    expect(tokenizerFor(table, IMPOSSIBLE).found).toBe(false);
  });

  test('its output is counted exactly but attributed to nothing', () => {
    const out = totalOutput(conv.calls, table);
    // The exact figure survives — it came off a `usage` block and owes nothing to any
    // estimator.
    expect(out.total).toBe(conv.calls.reduce((a, c) => a + c.usage.output, 0));
    expect(out.uncalibrated).toBe(out.total);
    expect(out.uncalibratedCalls).toBe(conv.calls.length);
    expect(out.uncalibratedModels).toEqual([IMPOSSIBLE]);
    // And nothing was invented to fill the hole. This is the assertion that fails if
    // anyone ever reintroduces a global fallback coefficient.
    expect(out.visible).toBe(0);
    expect(out.reasoning).toBe(0);
    expect(out.estimatorError).toBe(0);
  });

  test('its spend is quarantined into a named bucket, priced at nothing', () => {
    const priced = priceCalls(conv.calls.map((c) => ({ model: c.model, ts: c.ts, usage: c.usage })));
    expect(priced.usd).toBe(0);
    expect(priced.pricedSpend).toBe(0);
    expect(priced.unpricedSpend).toBeGreaterThan(0);
    expect(priced.unpricedCalls).toBe(conv.calls.length);
    expect(priced.unpriced.map((u) => u.model)).toEqual([IMPOSSIBLE]);
  });

  test('a known model in the same corpus is unaffected by the unknown one', () => {
    // The quarantine must not be contagious: one unrecognised model does not cost the
    // report its numbers for every other model.
    const known = convOf(twoCallSession('', 'claude-opus-5'));
    const priced = priceCalls([
      ...known.calls.map((c) => ({ model: c.model, ts: c.ts, usage: c.usage })),
      ...conv.calls.map((c) => ({ model: c.model, ts: c.ts, usage: c.usage })),
    ]);
    expect(priced.usd).toBeGreaterThan(0);
    expect(priced.pricedSpend).toBeGreaterThan(0);
    expect(priced.unpricedSpend).toBeGreaterThan(0);
    expect(priced.calls).toBe(known.calls.length + conv.calls.length);
  });
});

describe('the whole report path refuses to guess, and still adds up', () => {
  // End to end through the real pipeline — parse, group, classify, span, project — on a
  // transcript naming a model that cannot exist. [LAW:effects-at-boundaries] `readText`
  // is injected, so this touches no filesystem and no corpus.
  const PATH = '/nowhere/impossible.jsonl';
  const source: SessionSource = {
    project: '-Users-nobody-src-demo',
    sessionId: '11111111-2222-3333-4444-555555555555',
    path: PATH,
    bytes: 0,
    mtime: 0,
    subagents: [],
    unpaired: [],
  };
  const table = fixtureModels({ 'claude-opus-5': { charsPerToken: 2.5, tokensPerBlock: 50 } });
  const text = twoCallSession('', IMPOSSIBLE);
  const report = projectSession(
    analyzeSession(source, (p) => {
      if (p !== PATH) throw new Error(`unexpected read of ${p}`);
      return text;
    }),
    table,
  );

  test('the output ledger closes on the exact total', () => {
    // The property that breaks the moment someone adds a bucket and forgets its row: the
    // page would show rows summing to less than the exact figure printed above them, with
    // nothing to explain the difference.
    const ledger = report.ledgers.find((l) => l.id === 'output');
    if (!ledger) throw new Error('the output ledger is required');
    const sum = ledger.rows.reduce((a, r) => a + r.cost.value, 0);
    expect(sum).toBe(report.output.total);
    expect(report.output.uncalibrated).toBe(report.output.total);
  });

  test('the dollar figure is zero and the spend is named, not absorbed', () => {
    expect(report.pricing.usd).toBe(0);
    expect(report.pricing.unpricedSpend).toBeGreaterThan(0);
    expect(report.pricing.unpriced.map((u) => u.model)).toEqual([IMPOSSIBLE]);
  });

  test('a finding states the gap in words a reader can act on', () => {
    // Loud means VISIBLE, not merely recorded in a field nobody renders.
    const finding = report.findings.find((f) => /could not be priced or calibrated/.test(f.headline));
    if (!finding) throw new Error('the gap must reach the punch list');
    expect(finding.detail).toContain(IMPOSSIBLE);
    expect(finding.severity).toBe('high');
  });

  test('the session names every model it ran, not just the first call’s', () => {
    expect(report.model).toBe(IMPOSSIBLE);
  });
});

describe('a session that mixes models is priced per call, never at one rate', () => {
  test('the total is the sum of each call at its own model, not the aggregate at one', () => {
    // A real session does this constantly: spawned agents run whatever their definition
    // names, and Haiku appears in this corpus only inside subagents. Pricing the session
    // aggregate at the first call's model is wrong by the ratio between the two cards.
    const usage = { input: 0, cacheCreation: 0, cacheRead: 0, output: 1_000_000 };
    const ts = Date.UTC(2026, 5, 1);
    const mixed = priceCalls([
      { model: 'claude-opus-5', ts, usage },
      { model: 'claude-haiku-4-5', ts, usage },
    ]);
    const opus = rateAt('claude-opus-5', ts);
    const haiku = rateAt('claude-haiku-4-5', ts);
    if (!opus.found || !haiku.found) throw new Error('unreachable');

    expect(mixed.usd).toBeCloseTo(
      opus.value.usdPerOutputMtok + haiku.value.usdPerOutputMtok,
      6,
    );
    // Which is emphatically NOT two million output tokens at either single rate.
    expect(mixed.usd).not.toBeCloseTo(2 * opus.value.usdPerOutputMtok, 6);
    expect(mixed.usd).not.toBeCloseTo(2 * haiku.value.usdPerOutputMtok, 6);
  });

  test('an uncalibrated model does not steal a calibrated one’s output split', () => {
    const table = fixtureModels({ 'claude-opus-5': { charsPerToken: 2.5, tokensPerBlock: 50 } });
    const known = convOf(twoCallSession('', 'claude-opus-5'));
    const unknown = convOf(buildTranscript('22222222-3333-4444-5555-666666666666', [
      { thinking: '', text: 'hello', usage: { input: 1, cacheCreation: 0, cacheRead: 0, output: 500 } },
    ], IMPOSSIBLE));

    const out = totalOutput([...known.calls, ...unknown.calls], table);
    expect(out.uncalibrated).toBe(500);
    expect(out.visible).toBeGreaterThan(0);
    // The closure property holds across the mix, which is what makes the ledger add up.
    expect(out.visible + out.reasoning + out.estimatorError + out.uncalibrated).toBe(out.total);
  });
});
