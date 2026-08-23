// Drive the pipeline over the corpus and write the report.
//
// [LAW:effects-at-boundaries] All the I/O in the report path lives here: discover
// sessions, read transcripts, write one HTML file. The analysis and the renderer stay
// pure functions on either side of it.
//
// [LAW:one-source-of-truth] The producer is `src/` — the same primitives any other
// consumer would call. An oracle that produces cannot check itself, so nothing on this
// path is allowed to double as the verifier.
//
// NOTHING CURRENTLY CHECKS THESE FIGURES INDEPENDENTLY. Until miser-portability-adi.1
// this comment named `examples/hand-trace/trace.ts` — a second implementation that
// recomputed every number from raw JSONL and asserted agreement on 16 quantities. It
// was deleted with the rest of the specimen because it was welded to one session UUID
// on one machine. That check is a real loss, and miser-portability-adi.4 rebuilds it on
// synthetic fixtures. Said here rather than left implied: a repo that quietly stops
// verifying itself is worse off than one that never claimed to.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildConversation } from '../calls.ts';
import { discoverSessions, hasSpawns, type SessionSource } from '../discover.ts';
import { fitTokenizers, PRICE_SOURCE, addPrices, ZERO_PRICES, type ModelTable } from '../models.ts';
import { addOutput, calibrationGroup, ZERO_OUTPUT } from '../output.ts';
import { parseTranscript } from '../records.ts';
import { analyzeSession } from '../session.ts';
import { eqCost } from '../tokens.ts';
import { projectSession } from './project.ts';
import { renderCorpus } from './render.ts';
import type { Calibration, CorpusReport, Coverage, Ledger, SessionReport, Tier } from './model.ts';

const HOME = process.env.HOME ?? '';
const PROJECTS = join(HOME, '.claude', 'projects');
// Generated output, never checked in. It used to land in `examples/report/`, which put
// build output and hand-authored specimen artifacts in one directory under one name —
// two concerns sharing a home. [LAW:decomposition] The specimen is gone; the joint the
// two were sharing is now cut, and `out/` says what this is.
const OUT = join(import.meta.dirname, '..', '..', 'out');

const readText = (p: string): string => readFileSync(p, 'utf8');

const countLines = (text: string): number => {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

/** Sessions worth putting in front of a person: real work rather than a two-line stub,
 * small enough that the whole batch finishes quickly, and spread across projects.
 *
 * Reading every transcript to count its lines costs ~370ms over the whole corpus,
 * which is why discovery stays stat-only and this cost is spent explicitly here. */
function select(sources: readonly SessionSource[], limit: number): SessionSource[] {
  const MIN_LINES = 60;
  const MAX_LINES = 700;
  const PER_PROJECT = 2;

  const sized = sources
    .map((source) => ({ source, lines: countLines(readText(source.path)) }))
    .filter((x) => x.lines >= MIN_LINES && x.lines <= MAX_LINES);

  // Prefer sessions with spawned conversations — they exercise the depth dimension,
  // which is the thing a main/subagent flag would have hidden.
  const ordered = [
    ...sized.filter((x) => hasSpawns(x.source)),
    ...sized.filter((x) => !hasSpawns(x.source)),
  ];

  // Cap per project. Without this the list fills with whichever project happens to
  // have the most sessions, and the corpus view stops being a view of the corpus.
  const seen = new Map<string, number>();
  const picked: SessionSource[] = [];
  for (const { source } of ordered) {
    const k = seen.get(source.project) ?? 0;
    if (k >= PER_PROJECT) continue;
    seen.set(source.project, k + 1);
    picked.push(source);
    if (picked.length >= limit) break;
  }
  return picked;
}

/** Fit one tokenizer per model id from EVERY transcript on the machine, main
 * conversations and subagents alike.
 *
 * WHY THE WHOLE CORPUS AND NOT THE SESSIONS BEING REPORTED. The estimator is a property
 * of a model, not of the handful of sessions on this page, so restricting the fit to
 * them would throw away calibration points for no reason and leave thinly-used models —
 * Haiku appears here only inside subagents — with no row at all. Reading everything
 * costs about a second over 742 transcripts, which is the same order as the line-count
 * pass `select` already makes.
 *
 * Grouped BY TRANSCRIPT because that is the unit `fitTokenizers` holds out: a fit has to
 * be scored on sessions it never saw, and a group boundary is the only thing in this
 * data that marks "a different session's writing style". [LAW:no-silent-failure] A
 * transcript that will not parse is a pipeline bug and is thrown, not skipped — a
 * calibration quietly fit on the subset of files that happened to open is exactly the
 * kind of number nobody can check. */
function calibrate(sources: readonly SessionSource[], readText: (p: string) => string): ModelTable {
  const groups = sources.flatMap((s) =>
    [s.path, ...s.subagents.map((a) => a.transcriptPath)].map((path) => {
      try {
        return calibrationGroup(buildConversation(parseTranscript(readText(path)).lines).calls);
      } catch (e) {
        throw new Error(
          `failed to read ${path} for tokenizer calibration: ${e instanceof Error ? e.message : String(e)}`,
          { cause: e },
        );
      }
    }),
  );
  return fitTokenizers(groups);
}

/** Roll the same ledger shape up across sessions.
 *
 * [LAW:one-source-of-truth] One rule applied to a different grouping — the per-session
 * ledgers are the only place these numbers are computed, and this re-buckets them. It
 * is not a second accounting path. */
function corpusLedger(
  id: string,
  title: string,
  lede: string,
  sessions: readonly SessionReport[],
): Ledger {
  const acc = new Map<string, { v: number; calls: number }>();
  let total = 0;
  for (const s of sessions) {
    const l = s.ledgers.find((x) => x.id === id);
    if (!l) continue;
    for (const r of l.rows) {
      const cur = acc.get(r.key) ?? { v: 0, calls: 0 };
      acc.set(r.key, { v: cur.v + r.cost.value, calls: cur.calls + r.calls });
      total += r.cost.value;
    }
  }
  return {
    id: `corpus-${id}`,
    title,
    lede,
    rows: [...acc.entries()]
      .map(([key, b]) => ({
        key,
        cost: eqCost(b.v),
        share: total === 0 ? 0 : b.v / total,
        calls: b.calls,
        note: '',
      }))
      .sort((a, b) => b.cost.value - a.cost.value),
  };
}

/** The calibration, carried to the page as data.
 *
 * [LAW:one-source-of-truth] The coefficients a reader sees are the very objects the
 * arithmetic used. The alternative — a human transcribing the fit into a caption — is a
 * second copy of a number that changes every time the corpus does. */
const calibrationOf = (models: ModelTable): Calibration => ({
  rows: [...models.tokenizers]
    .map(([model, fit]) => ({ model, ...fit }))
    .sort((a, b) => b.points - a.points),
  seen: models.seen,
  priceSource: PRICE_SOURCE,
});

/** Spend-weighted coverage across the corpus: a tiny session's perfect coverage must
 * not outvote a huge session's gaps. */
function corpusCoverage(sessions: readonly SessionReport[]): Coverage {
  const byTier: Record<Tier, number> = { marker: 0, rule: 0, judge: 0, hand: 0, none: 0 };
  const grand = sessions.reduce((a, s) => a + s.total.value, 0) || 1;
  for (const s of sessions)
    for (const [k, v] of Object.entries(s.coverage.byTier) as Array<[Tier, number]>)
      byTier[k] += (v * s.total.value) / grand;
  return {
    byTier,
    unclassified: sessions.reduce((a, s) => a + s.coverage.unclassified * s.total.value, 0) / grand,
  };
}

function main(): void {
  const limit = Number(process.argv[2] ?? 24);
  mkdirSync(OUT, { recursive: true });

  const sources = discoverSessions(PROJECTS);

  const models = calibrate(sources, readText);
  console.log(
    `calibrated ${models.tokenizers.size} of ${models.seen.length} model ids: ${[...models.tokenizers]
      .map(([m, f]) => `${m} ${f.charsPerToken.toFixed(2)}c/t ${(f.heldOutError * 100).toFixed(1)}%`)
      .join(', ')}`,
  );

  const picked = select(sources, limit);
  console.log(`analyzing ${picked.length} sessions...`);

  const sessions: SessionReport[] = [];
  for (const source of picked) {
    // [LAW:no-silent-failure] No catch that turns a failure into a skip. A session
    // that cannot be analyzed is a pipeline bug, and the previous `catch { return
    // null }` here made a crash and an empty result indistinguishable. The path is
    // added to the message so the failure names the input that caused it.
    try {
      sessions.push(projectSession(analyzeSession(source, readText), models));
    } catch (e) {
      throw new Error(`failed to analyze ${source.path}: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      });
    }
    process.stdout.write('.');
  }
  console.log();

  sessions.sort((a, b) => b.pricing.usd - a.pricing.usd);

  const corpus: CorpusReport = {
    generatedAt: Date.now(),
    sessions,
    ledgers: [
      corpusLedger(
        'activity',
        'Across every session, by activity',
        'The founding question, over real history rather than one specimen.',
        sessions,
      ),
      corpusLedger(
        'depth',
        'Across every session, by spawn depth',
        'How much of the corpus is work no human ever reads.',
        sessions,
      ),
      corpusLedger(
        'output',
        'Across every session, what the output bought',
        'Reasoning you never see, against text and tool calls you do.',
        sessions,
      ),
    ],
    total: eqCost(sessions.reduce((a, s) => a + s.total.value, 0)),
    // [LAW:one-source-of-truth] Rolled up with the same associative combine the sessions
    // were built from, rather than a second hand-written reducer that would have to
    // remember to carry the unpriced remainder too — and, the first time someone added a
    // field, would not.
    pricing: sessions.reduce((a, s) => addPrices(a, s.pricing), ZERO_PRICES),
    calibration: calibrationOf(models),
    coverage: corpusCoverage(sessions),
    // Summed, not spend-weighted like coverage above: these are token counts, and the
    // corpus figure a reader wants is "of all the output tokens I bought, how many were
    // reasoning" — a ratio of two totals, not an average of ratios.
    output: sessions.reduce((a, s) => addOutput(a, s.output), ZERO_OUTPUT),
  };

  const out = join(OUT, 'index.html');
  writeFileSync(out, renderCorpus(corpus));
  writeFileSync(join(OUT, 'corpus.json'), JSON.stringify(corpus, null, 2));

  console.log(`${sessions.length} sessions rendered`);
  console.log(
    `corpus total: $${corpus.pricing.usd.toFixed(2)} / ${corpus.total.value.toLocaleString()} tok-eq`,
  );
  // Printed at zero as well, so a clean run and an unchecked one are distinguishable.
  console.log(
    `unpriced: ${corpus.pricing.unpricedSpend.toLocaleString()} tok-eq across ${corpus.pricing.unpricedCalls} calls` +
      `${corpus.pricing.unpriced.length ? ` (${corpus.pricing.unpriced.map((u) => u.model).join(', ')})` : ''}` +
      ` · uncalibrated output: ${corpus.output.uncalibrated.toLocaleString()} tokens across ${corpus.output.uncalibratedCalls} calls` +
      `${corpus.output.uncalibratedModels.length ? ` (${corpus.output.uncalibratedModels.join(', ')})` : ''}`,
  );
  console.log(
    `coverage: ${Object.entries(corpus.coverage.byTier)
      .filter(([, v]) => v > 0.001)
      .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
      .join(', ')}`,
  );
  console.log(`-> ${out} (${(readFileSync(out).length / 1024).toFixed(0)} KB)`);
}

main();
