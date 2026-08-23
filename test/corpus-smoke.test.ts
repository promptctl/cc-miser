// Point the whole pipeline at a real Claude Code corpus and see whether it survives.
//
// WHAT THIS TEST IS FOR, AND WHAT IT IS NOT. Every other test in this suite runs on
// synthetic transcripts whose expected values were chosen by hand — which is what lets
// them assert that a number is RIGHT. This one asserts nothing about any number: a real
// corpus has no declared answers, so the only honest claims available are structural.
// It exists to catch what fixtures cannot: a line shape nobody anticipated, a spawn
// topology no fixture models, a transcript large enough to break an assumption about
// size. Those have all happened, and each time the first symptom was a crash here.
//
// THE DEPLOYMENT TARGET HAS NO CORPUS. This repo is meant to run on a machine it has
// never seen, and a suite that requires ~/.claude/projects to exist cannot run there —
// which defeats the point of having one. So the absence of a corpus is a SKIP with a
// stated reason, and every other test file passes with nothing on disk at all.
//
// [LAW:no-silent-failure] The absence of an EXPLICIT corpus is a different fact and gets
// the opposite treatment: someone who set CC_MISER_CORPUS asked for a scan, and quietly
// skipping it would report success for work that never ran.

import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, describe } from 'bun:test';
import { discoverSessions, projectsRoot, type SessionSource } from '../src/discover.ts';
import { depthOf } from '../src/lineage.ts';
import { analyzeSession, type AnalyzedSession } from '../src/session.ts';
import { allCalls, rollup } from '../src/spans.ts';

/** Whether there is a corpus to scan, and — when there isn't — why not.
 *
 * [LAW:types-are-the-program] A union rather than a nullable path with an `if` at each
 * use, because "skip" carries a REASON that has to reach the reader. A `string | null`
 * would have made the reason someone's job to remember to print. */
type CorpusChoice =
  | { kind: 'scan'; root: string; sources: readonly SessionSource[] }
  | { kind: 'skip'; why: string };

/** [LAW:parse-dont-validate] The single checkpoint where an environment becomes a
 * decision, and the only place that decision is made. It carries the discovered sources
 * rather than just the root, so "is there anything to scan" is answered once, by the
 * same discovery the scan then runs on — asking `existsSync` here and discovering
 * separately would be two maps of one fact, and they disagree on a real machine: a
 * directory that exists and holds no sessions.
 *
 * `env` is a parameter rather than a read of `process.env`, which is what lets both
 * outcomes be exercised below without mutating the process.
 *
 * [LAW:dataflow-not-control-flow] One rule decides both cases: nothing to scan is a SKIP
 * when the location was the default and an ERROR when someone named it, because those
 * are different facts — a machine that has never run Claude Code, versus an invocation
 * that asked for work and would otherwise report success for never doing it. */
export function chooseCorpus(env: Record<string, string | undefined>): CorpusChoice {
  const explicit = env.CC_MISER_CORPUS ?? null;
  const root = projectsRoot(explicit, env);
  const sources = existsSync(root) ? discoverSessions(root) : [];
  if (sources.length > 0) return { kind: 'scan', root, sources };
  if (explicit)
    throw new Error(
      `CC_MISER_CORPUS names ${root}, which holds no Claude Code sessions. A scan was ` +
        `asked for and cannot be run; skipping it would report success for work that ` +
        `never happened.`,
    );
  return {
    kind: 'skip',
    why: `no Claude Code sessions under ${root} — set CC_MISER_CORPUS to scan a corpus elsewhere`,
  };
}

const choice = chooseCorpus(process.env);
if (choice.kind === 'skip') console.log(`corpus smoke scan SKIPPED: ${choice.why}`);

const scanned: AnalyzedSession[] =
  choice.kind === 'scan'
    ? choice.sources.map((s) => analyzeSession(s, (p) => readFileSync(p, 'utf8')))
    : [];

describe.skipIf(choice.kind === 'skip')('the pipeline survives a real corpus', () => {
  test('every discovered session analyses end to end', () => {
    // The scan itself is the assertion: `analyzeSession` parses, groups, resolves the
    // forest, classifies, builds the tree and checks the activity partition, throwing on
    // any of them. Reaching this line means all of it held on every session on disk.
    expect(scanned.length).toBeGreaterThan(0);
  });

  test('activity labels partition the root calls of every session', () => {
    // Asserted again here, out loud. `analyzeSession` checks it internally; a caller that
    // depends on the invariant should not have to know that.
    const mismatched = scanned.filter((s) => s.labels.length !== s.conversation.calls.length);
    expect(mismatched.map((s) => s.source.sessionId)).toEqual([]);
  });

  test('every placed conversation sits deeper than the root, by one of the two known routes', () => {
    const bad = scanned.flatMap((s) =>
      s.forest.placed.filter(
        (p) => depthOf(p.lineage) < 1 || !['tool_use', 'command'].includes(p.lineage[p.lineage.length - 1]!.via),
      ),
    );
    expect(bad.map((p) => p.meta.agentId)).toEqual([]);
  });

  test('every orphan says why it could not be placed', () => {
    const silent = scanned.flatMap((s) => s.forest.orphans.filter((o) => o.why.trim() === ''));
    expect(silent).toEqual([]);
  });

  test('the tree holds every root call plus every placed conversation’s calls', () => {
    // The one structural conservation claim available without declared answers: grafting
    // neither drops a call nor duplicates one. A resolver that lost a subtree, or that
    // attached a conversation twice, shows up here on the real topology rather than only
    // on the one a fixture happened to model.
    const wrong = scanned.filter((s) => {
      const expectedCalls =
        s.conversation.calls.length +
        s.forest.placed.reduce((a, p) => a + p.conversation.calls.length, 0);
      const inTree = allCalls(s.tree);
      return inTree.length !== expectedCalls || new Set(inTree.map((c) => c.id)).size !== inTree.length;
    });
    expect(wrong.map((s) => s.source.sessionId)).toEqual([]);
  });

  test('no session bills negative tokens', () => {
    const negative = scanned.filter((s) => {
      const u = rollup(s.tree);
      return u.input < 0 || u.cacheCreation < 0 || u.cacheRead < 0 || u.output < 0;
    });
    expect(negative.map((s) => s.source.sessionId)).toEqual([]);
  });

  test('what the scan saw, printed', () => {
    // PROJECT.md names the unknown-type counter as the early-warning system for Claude
    // Code version drift. It is PRINTED rather than asserted on: a new line type means
    // the format moved, which is a fact worth seeing, but failing a developer's test run
    // the week Anthropic ships one would train people to ignore the alarm. The number
    // that gates anything belongs on the report, where a reader can weigh it.
    const stats = scanned.map((s) => s.stats);
    const sum = (f: (s: (typeof stats)[number]) => number): number => stats.reduce((a, s) => a + f(s), 0);
    const unknown = new Map<string, number>();
    for (const s of stats)
      for (const [k, v] of Object.entries(s.unknownTypes)) unknown.set(k, (unknown.get(k) ?? 0) + v);

    const depths = new Map<number, number>();
    for (const s of scanned)
      for (const p of s.forest.placed)
        depths.set(depthOf(p.lineage), (depths.get(depthOf(p.lineage)) ?? 0) + 1);

    const calls = scanned.reduce((a, s) => a + s.conversation.calls.length, 0);
    const assistantLines = sum((s) => s.byKind.assistant);
    console.log(
      [
        `corpus smoke scan: ${choice.kind === 'scan' ? choice.root : '(skipped)'}`,
        `  sessions              ${scanned.length}`,
        `  JSONL lines           ${sum((s) => s.totalLines)}`,
        `  assistant lines       ${assistantLines}`,
        `  API calls             ${calls} (${(assistantLines / Math.max(1, calls)).toFixed(2)}x fan-out)`,
        `  attachments           ${sum((s) => s.byKind.attachment)}`,
        `  unparseable lines     ${sum((s) => s.unparseableLines)}`,
        `  UNKNOWN line types    ${unknown.size === 0 ? 'none — format matches' : [...unknown].map(([k, v]) => `${k}=${v}`).join(', ')}`,
        `  spawns placed         ${scanned.reduce((a, s) => a + s.forest.placed.length, 0)} at depths ${[...depths].sort().map(([d, n]) => `${d}:${n}`).join(' ')}`,
        `  spawns orphaned       ${scanned.reduce((a, s) => a + s.forest.orphans.length, 0)}`,
        `  depth disagreements   ${scanned.reduce((a, s) => a + s.notes.filter((n) => n.startsWith('spawnDepth disagreement')).length, 0)}`,
        `  unmatched tool results ${scanned.reduce((a, s) => a + s.conversation.unmatchedToolResults, 0)}`,
      ].join('\n'),
    );
    expect(sum((s) => s.totalLines)).toBeGreaterThan(0);
  });
});

describe('the decision to scan is itself checked', () => {
  test('an explicit corpus that is not there STOPS, rather than skipping quietly', () => {
    expect(() => chooseCorpus({ CC_MISER_CORPUS: '/nowhere/at/all', HOME: '/home/jdoe' })).toThrow(
      /holds no Claude Code sessions/,
    );
  });

  test('a directory that exists but holds no sessions is still nothing to scan', () => {
    // The machine that installed Claude Code and never ran it: the directory is there
    // and holds nothing. `existsSync` alone says yes here, which is why the choice is
    // made from what discovery actually found rather than from whether a path resolves.
    const empty = mkdtempSync(join(tmpdir(), 'cc-miser-empty-'));
    expect(() => chooseCorpus({ CC_MISER_CORPUS: empty, HOME: '/home/jdoe' })).toThrow(
      /holds no Claude Code sessions/,
    );
  });

  test('a machine with no corpus at the default location skips, with the reason', () => {
    const c = chooseCorpus({ HOME: '/nowhere/at/all' });
    expect(c.kind).toBe('skip');
    if (c.kind !== 'skip') throw new Error('unreachable');
    expect(c.why).toContain('CC_MISER_CORPUS');
  });
});
