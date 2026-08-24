// Whether this machine has a corpus to scan, and — when it does not — why not.
//
// [LAW:decomposition] Its own module rather than an export from a test file: two suites
// now ask this question (the corpus smoke scan and the pipe-integrity check), and a
// helper reached for by importing someone else's test drags that test's whole body into
// every importer as a side effect.

import { existsSync } from 'node:fs';
import { discoverSessions, projectsRoot, type SessionSource } from '../src/discover.ts';

/** Whether there is a corpus to scan, and — when there isn't — why not.
 *
 * [LAW:types-are-the-program] A union rather than a nullable path with an `if` at each
 * use, because "skip" carries a REASON that has to reach the reader. A `string | null`
 * would have made the reason someone's job to remember to print. */
export type CorpusChoice =
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
