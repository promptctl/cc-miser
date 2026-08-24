// The command driver: the one place in this tool that touches the filesystem, the
// clock, the environment, or the process exit code.
//
// [LAW:effects-at-boundaries] Everything above this file is a pure function of the text
// it is handed. `readText` is the only reader, `writeFileSync` the only writer, and the
// two stream writers below are the only output. That is what lets the whole pipeline be
// exercised on fixtures with no filesystem at all.
//
// THE OUTPUT CONTRACT, which the ticket asks be decided deliberately rather than
// discovered:
//
//   stdout carries the ARTIFACT and nothing else — `list` writes tab-separated rows,
//   `trace` writes one JSON document, `report` writes the path of each file it wrote,
//   one per line. So `miser list | sort -t$'\t' -k8 -nr` and `miser trace | jq` work
//   without a flag to quiet anything down.
//
//   stderr carries everything a PERSON wants: what was scanned, what the scope excluded,
//   calibration, progress, totals, and every failure. A pipeline that redirects stdout
//   still shows its operator what happened.
//
//   exit codes are a contract, not just 0/1 — see `EXIT` below.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverSessions, projectsRoot, type SessionSource } from '../discover.ts';
import { analyzeSession, type ReadText } from '../session.ts';
import { applyScope, readArgs, USAGE, type Command, type Scope } from './args.ts';
import { listRow, toTsv } from './list.ts';
import { traceFile } from './trace.ts';
import { analyzeAll, buildCorpus, calibrate, select } from '../report/generate.ts';
import { renderCorpus } from '../report/render.ts';
import type { Selection } from '../report/model.ts';

/** What each exit code means.
 *
 * [LAW:types-are-the-program] A named table rather than integers sprinkled through the
 * code, because these are a published interface: a script that reruns on `EMPTY` but
 * stops on `FAILED` can only be written if the two are different numbers and stay that
 * way. `EMPTY` exists because "your filters matched nothing" and "everything worked"
 * are different outcomes that both produce no rows, and a caller that cannot tell them
 * apart processes an empty set believing it processed a corpus. */
export const EXIT = {
  OK: 0,
  /** The pipeline failed on real input. The message on stderr names the transcript. */
  FAILED: 1,
  /** The command line was wrong. Nothing was read, nothing was written. */
  USAGE: 2,
  /** The command was valid and the scope selected no sessions at all. */
  EMPTY: 3,
} as const;

const readText: ReadText = (p) => readFileSync(p, 'utf8');

/** Where the writing goes, as parameters, so `run` below is drivable by a test that
 * captures both streams instead of a test that reads the terminal. */
export interface Streams {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Everything `run` needs from the world outside it, gathered into one value.
 *
 * [LAW:effects-at-boundaries] The clock and the file reader are here rather than called
 * inside `run`, which is what makes a command drivable over fixtures. Bundled rather
 * than passed as four positional parameters because they arrive together and grow
 * together — the next one (a writer, when `report` stops being the only command that
 * writes files) is a field, not a fifth argument at every call site. */
export interface Runtime {
  env: Record<string, string | undefined>;
  streams: Streams;
  /** Epoch ms stamped into whatever the command produces. */
  now: number;
  read: ReadText;
}

/** Discover, then narrow — the spine every command shares.
 *
 * [LAW:dataflow-not-control-flow] One scoping rule for all three commands. `list`,
 * `trace` and `report` differ in what they EMIT, never in which sessions they are
 * about, so the scope cannot mean one thing on one command and something else on
 * another. */
function scoped(
  scope: Scope,
  { env, streams }: Runtime,
): { root: string; sources: SessionSource[]; picked: SessionSource[]; criteria: string[] } {
  const root = projectsRoot(scope.projects, env);
  const sources = discoverSessions(root);
  const { picked, criteria } = applyScope(sources, scope);
  streams.err(`scanning ${root}: ${sources.length} sessions discovered\n`);
  for (const c of criteria) streams.err(`  ${c}\n`);
  streams.err(`${picked.length} in scope\n`);
  return { root, sources, picked, criteria };
}

/** Run one command. Returns the exit code rather than calling `process.exit`, so the
 * whole driver is testable and the single exit lives in `main` below. */
export function run(command: Command, rt: Runtime): number {
  const { streams, now, read } = rt;

  // Answered before anything is discovered: `help` is a question about the tool, and a
  // corpus walk to print a paragraph would make the cheapest command the slowest one.
  // Written to stdout, because a user who asked for it wants to pipe it to a pager.
  if (command.kind === 'help') {
    streams.out(`${USAGE}\n`);
    return EXIT.OK;
  }

  const { root, sources, picked, criteria } = scoped(command.scope, rt);
  if (picked.length === 0) {
    streams.err('no sessions matched. Nothing written.\n');
    return EXIT.EMPTY;
  }

  // The one branch in this file, on the domain's own discriminator: three commands are
  // three genuinely different artifacts, not one artifact with a mode.
  switch (command.kind) {
    case 'list': {
      const rows = picked.map((s) => listRow(analyzeSession(s, read)));
      streams.out(`${toTsv(rows)}\n`);
      const tokEq = rows.reduce((a, r) => a + r.tokEq, 0);
      const usd = rows.reduce((a, r) => a + r.usd, 0);
      const unpriced = rows.reduce((a, r) => a + r.unpricedTokEq, 0);
      // Printed at zero as well, so a clean run and an unchecked one are distinguishable.
      streams.err(
        `${rows.length} sessions · ${tokEq.toLocaleString()} tok-eq · $${usd.toFixed(2)} · ` +
          `${unpriced.toLocaleString()} tok-eq unpriced\n`,
      );
      return EXIT.OK;
    }

    case 'trace': {
      const analyzed = picked.map((s) => analyzeSession(s, read));
      streams.out(`${JSON.stringify(traceFile(analyzed, root, criteria, now), null, 2)}\n`);
      const notes = analyzed.reduce((a, s) => a + s.notes.length, 0);
      streams.err(`${analyzed.length} session trees written · ${notes} notes carried\n`);
      return EXIT.OK;
    }

    case 'report': {
      // Calibrated over every transcript on the machine rather than the ones being
      // rendered: a tokenizer is a property of a MODEL, not of this page's sample, and
      // restricting the fit would leave thinly-used models with no row at all. The
      // reasoning is `calibrate`'s own, in generate.ts; the corpus-wide input is passed
      // here because this is where the file reads live.
      const models = calibrate(sources, read);
      streams.err(
        `calibrated ${models.tokenizers.size} of ${models.seen.length} model ids: ` +
          `${[...models.tokenizers]
            .map(
              ([m, f]) =>
                `${m} ${f.charsPerToken.toFixed(2)}c/t ${(f.heldOutError * 100).toFixed(1)}%`,
            )
            .join(', ')}\n`,
      );

      const chosen = select(picked, read, command.renderLimit);
      if (chosen.picked.length === 0) {
        streams.err(`${criteria.concat(chosen.criteria).join('; ')}\nno sessions left to render.\n`);
        return EXIT.EMPTY;
      }
      const selection: Selection = {
        discovered: sources.length,
        rendered: chosen.picked.length,
        // The page states its own scale from ONE list, so the scope a person typed and
        // the heuristic the report applies are both on it. [LAW:one-source-of-truth]
        criteria: [...criteria, ...chosen.criteria],
      };

      streams.err(`analyzing ${chosen.picked.length} sessions`);
      const analyzed = analyzeAll(chosen.picked, read, models, () => streams.err('.'));
      streams.err('\n');

      const corpus = buildCorpus(analyzed, selection, models, now);
      mkdirSync(command.out, { recursive: true });
      const html = join(command.out, 'index.html');
      const json = join(command.out, 'corpus.json');
      writeFileSync(html, renderCorpus(corpus));
      writeFileSync(json, JSON.stringify(corpus, null, 2));
      streams.out(`${html}\n${json}\n`);

      streams.err(
        `${corpus.sessions.length} sessions rendered · ` +
          `$${corpus.pricing.usd.toFixed(2)} / ${corpus.total.value.toLocaleString()} tok-eq\n`,
      );
      streams.err(
        `unpriced: ${corpus.pricing.unpricedSpend.toLocaleString()} tok-eq across ` +
          `${corpus.pricing.unpricedCalls} calls` +
          `${corpus.pricing.unpriced.length ? ` (${corpus.pricing.unpriced.map((u) => u.model).join(', ')})` : ''}` +
          ` · uncalibrated output: ${corpus.output.uncalibrated.toLocaleString()} tokens across ` +
          `${corpus.output.uncalibratedCalls} calls` +
          `${corpus.output.uncalibratedModels.length ? ` (${corpus.output.uncalibratedModels.join(', ')})` : ''}\n`,
      );
      streams.err(
        `coverage: ${Object.entries(corpus.coverage.byTier)
          .filter(([, v]) => v > 0.001)
          .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
          .join(', ')}\n`,
      );
      streams.err(`-> ${html} (${(readFileSync(html).length / 1024).toFixed(0)} KB)\n`);
      return EXIT.OK;
    }
  }
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function main(): number {
  const streams: Streams = {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  };

  // Parsed in its own try, so a bad command line exits USAGE and a failure during the
  // run exits FAILED. Collapsing them would tell a script that a corrupt transcript was
  // a typo. [LAW:no-silent-failure]
  let command: Command;
  try {
    command = readArgs(process.argv.slice(2));
  } catch (e) {
    streams.err(`${message(e)}\n`);
    return EXIT.USAGE;
  }

  try {
    return run(command, { env: process.env, streams, now: Date.now(), read: readText });
  } catch (e) {
    streams.err(`${message(e)}\n`);
    return EXIT.FAILED;
  }
}

// `import.meta.main` is false when a test imports `run` above, so importing this module
// never runs a corpus scan as a side effect — the exact trap `src/report/args.ts` was
// carved out of `generate.ts` to escape.
if (import.meta.main) process.exit(main());

export { USAGE };
