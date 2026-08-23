// Drive the pipeline over the corpus and write the report.
//
// [LAW:effects-at-boundaries] All the I/O in the report path lives here: discover
// sessions, read transcripts, write one HTML file. The analysis and the renderer stay
// pure functions on either side of it.
//
// [LAW:one-source-of-truth] The producer is `src/` — the same primitives any other
// consumer would call. It is NOT the hand-trace oracle: an oracle that produces cannot
// check itself, and routing production through one is what previously put a scheduled
// rip-out into this file. `examples/hand-trace/trace.ts` now computes the same figures
// independently and ASSERTS agreement, which is the job it was built for.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { discoverSessions, hasSpawns, type SessionSource } from '../discover.ts';
import { analyzeSession } from '../session.ts';
import { eqCost, usdCost } from '../tokens.ts';
import { projectSession } from './project.ts';
import { renderCorpus } from './render.ts';
import type { CorpusReport, Coverage, Ledger, SessionReport, Tier } from './model.ts';

const HOME = process.env.HOME ?? '';
const PROJECTS = join(HOME, '.claude', 'projects');
const OUT = join(import.meta.dirname, '..', '..', 'examples', 'report');

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

  const picked = select(discoverSessions(PROJECTS), limit);
  console.log(`analyzing ${picked.length} sessions...`);

  const sessions: SessionReport[] = [];
  for (const source of picked) {
    // [LAW:no-silent-failure] No catch that turns a failure into a skip. A session
    // that cannot be analyzed is a pipeline bug, and the previous `catch { return
    // null }` here made a crash and an empty result indistinguishable. The path is
    // added to the message so the failure names the input that caused it.
    try {
      sessions.push(projectSession(analyzeSession(source, readText)));
    } catch (e) {
      throw new Error(`failed to analyze ${source.path}: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      });
    }
    process.stdout.write('.');
  }
  console.log();

  sessions.sort((a, b) => b.totalUsd.value - a.totalUsd.value);

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
    totalUsd: usdCost(sessions.reduce((a, s) => a + s.totalUsd.value, 0)),
    coverage: corpusCoverage(sessions),
    // Summed, not spend-weighted like coverage above: these are token counts, and the
    // corpus figure a reader wants is "of all the output tokens I bought, how many were
    // reasoning" — a ratio of two totals, not an average of ratios.
    output: sessions.reduce(
      (a, s) => ({
        total: a.total + s.output.total,
        visible: a.visible + s.output.visible,
        reasoning: a.reasoning + s.output.reasoning,
        estimatorError: a.estimatorError + s.output.estimatorError,
        callsWithReasoning: a.callsWithReasoning + s.output.callsWithReasoning,
        calls: a.calls + s.output.calls,
      }),
      { total: 0, visible: 0, reasoning: 0, estimatorError: 0, callsWithReasoning: 0, calls: 0 },
    ),
  };

  const out = join(OUT, 'index.html');
  writeFileSync(out, renderCorpus(corpus));
  writeFileSync(join(OUT, 'corpus.json'), JSON.stringify(corpus, null, 2));

  console.log(`${sessions.length} sessions rendered`);
  console.log(
    `corpus total: $${corpus.totalUsd.value.toFixed(2)} / ${corpus.total.value.toLocaleString()} tok-eq`,
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
