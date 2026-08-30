#!/usr/bin/env bun
// The `bin.miser` entry in package.json points here, and an installed or linked `bin` is
// exec'd by the OS directly rather than through `bun run` — so without this line the
// kernel has no interpreter to hand the file to and the installed command fails. The
// `scripts` entries hid that, because `bun run <file>` supplies the interpreter itself.
//
// The command driver: the one place that reads transcript CONTENTS, writes artifacts,
// asks the clock and sets the process exit code.
//
// [LAW:effects-at-boundaries] Not the only module that touches the filesystem, and the
// claim is worth stating precisely because the imprecise version invites someone to add
// a raw `readFileSync` here on the belief that fs calls are centralised in this file.
// `discover.ts` is its own established boundary — it owns the directory walk, and says
// so in its own header — and this file reaches the filesystem THROUGH it rather than
// instead of it. What this file owns is the rest: `readText` is the only reader of
// transcript text, `writeFileSync` the only writer, and the two stream writers below the
// only output. Everything above those is a pure function of the text it is handed, which
// is what lets the whole pipeline be exercised on fixtures.
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
import { analyzeSession, naming, type ReadText } from '../session.ts';
import { applyScope, readArgs, USAGE, type Command, type Scope } from './args.ts';
import { listRow, toTsv } from './list.ts';
import { traceFile } from './trace.ts';
import { exportHeader, exportRow, exportSession } from './otlp.ts';
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
  /** The pipeline failed on real input. The message on stderr names WHAT FAILED, which is
   * the transcript when the failure is about a session's contents, and the endpoint and
   * session when a collector refused an export the pipeline built correctly. Those are two
   * failure classes under one code, and the second is not a weaker case of the first:
   * naming a transcript there would point the reader at a file that is fine and send them
   * to debug it. `otlp`'s exports are the path that has both. */
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
  /** Sending one OTLP request, as a capability rather than a `fetch` call in `run`.
   *
   * [LAW:effects-at-boundaries] This is what keeps `otlp` exercisable without a collector:
   * the whole translation is a pure function and the one thing that reaches the network is
   * a parameter a test can supply. It is also the seam that made the driver async — a
   * command that talks to a socket cannot honestly pretend otherwise. */
  post: Post;
}

/** What a collector answered. Status and body together, because a message like
 * `partial success: 3 spans rejected` arrives in the body of a 200 and the status alone
 * would report that as a clean export. */
export interface PostResult {
  status: number;
  body: string;
}

export type Post = (url: string, json: string) => Promise<PostResult>;

/** What a collector said while answering 200 — all three of the things it can say.
 *
 * [LAW:types-are-the-program] THREE states, because the collector has three. It stored
 * everything; it stored everything and wants to tell you something; it refused some spans.
 * OTLP's `ExportTracePartialSuccess` documents `error_message` for both of the last two —
 * "to explain why the server rejected parts of the data during a partial success OR to
 * convey warnings/suggestions during a full success" — so a 200 with `rejected_spans: 0`
 * and a message is an ordinary case and not a contradiction.
 *
 * Returned as `string | null` there were only two slots, and the warning had to be miscast
 * into one of them: as `null` it vanished, which is the answer-shaped void this function
 * exists to prevent, and as a non-null string it would have failed a run whose export
 * succeeded. Neither is a check that was forgotten — both are what a two-state type does to
 * a three-state fact. Widening the type is what deletes the question. */
export type CollectorSaid =
  | { kind: 'stored' }
  | { kind: 'warned'; message: string }
  | { kind: 'rejected'; message: string };

/** [LAW:no-silent-failure] Read rather than merely available. `PostResult.body` exists to
 * carry this and, until this function, nothing looked at it — so a partially-rejected
 * export printed a trace id and exited OK, and the person who followed that id to Jaeger
 * found a trace quietly missing spans with nothing pointing back here.
 *
 * A body that is not JSON, or carries no `partialSuccess`, means nothing was rejected.
 * That is not a fallback: a collector reporting a rejection has one documented way to say
 * so, and its absence is the collector saying nothing was dropped. */
export function collectorSaid(body: string): CollectorSaid {
  const parsed: unknown = ((): unknown => {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  })();
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'stored' };
  const partial: unknown = (parsed as Record<string, unknown>)['partialSuccess'];
  if (typeof partial !== 'object' || partial === null) return { kind: 'stored' };
  const { rejectedSpans, errorMessage } = partial as Record<string, unknown>;
  // The count crosses OTLP/JSON as a string, like every other int64 on this wire.
  const rejected = Number(rejectedSpans ?? 0);
  const note = typeof errorMessage === 'string' && errorMessage !== '' ? errorMessage : '';
  if (!Number.isFinite(rejected) || rejected === 0)
    // Nothing dropped. The message, if there is one, is the collector's full-success
    // warning — the run continues and the reader still gets to see it.
    return note === '' ? { kind: 'stored' } : { kind: 'warned', message: note };
  return {
    kind: 'rejected',
    message: `${rejected} spans rejected${note === '' ? '' : `: ${note}`}`,
  };
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
 * whole driver is testable and the single exit lives in `main` below.
 *
 * Async because `otlp` posts to a collector. The three commands that touch no socket
 * still resolve immediately; what the signature now states is that this function may
 * perform network I/O, which it may. */
export async function run(command: Command, rt: Runtime): Promise<number> {
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
      const rows = picked.map((s) => listRow(naming(s, () => analyzeSession(s, read))));
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
      const analyzed = picked.map((s) => naming(s, () => analyzeSession(s, read)));
      streams.out(`${JSON.stringify(traceFile(analyzed, root, criteria, now), null, 2)}\n`);
      const notes = analyzed.reduce((a, s) => a + s.notes.length, 0);
      streams.err(`${analyzed.length} session trees written · ${notes} notes carried\n`);
      return EXIT.OK;
    }

    case 'otlp': {
      const analyzed = picked.map((s) => naming(s, () => analyzeSession(s, read)));
      // Built through `traceFile` rather than from the analysed sessions directly, so the
      // exporter is a function of the SAME document `miser trace` publishes. A second
      // route from analysis to spans would be a second span model, free to drift from the
      // one every other renderer in this project is a view of. [LAW:one-source-of-truth]
      const file = traceFile(analyzed, root, criteria, now);

      // The header goes out before the first POST, so stdout is a RUNNING RECORD of what
      // reached the collector rather than a report issued only if the whole scope
      // succeeded. Batched until the end, a failure on session N discarded the trace ids
      // of sessions 1..N-1 that had already landed — the run said "this failed" and left
      // no record of the traces that are sitting in Jaeger right now. Those are different
      // facts and the batching collapsed them. [LAW:no-silent-failure]
      streams.out(`${exportHeader()}\n`);

      let traces = 0;
      let spans = 0;
      for (const session of file.sessions) {
        const { request, rows } = exportSession(session);
        const { status, body } = await rt.post(command.endpoint, JSON.stringify(request));

        // [LAW:no-silent-failure] Checked after every call, before anything downstream
        // treats the export as done. A collector that refuses a session and a collector
        // that stored it both leave this loop having "sent" it, and a run that printed
        // trace ids for spans Jaeger never received would send its reader to an empty page
        // with no reason to doubt the tool.
        if (status < 200 || status >= 300)
          throw new Error(
            `${command.endpoint} rejected session ${session.session}: HTTP ${status} ${body}`,
          );
        // A 200 is not the same as "all of it arrived". `collectorSaid` reads what the
        // status cannot say; treated as success, a partially-stored session would print a
        // trace id for a trace quietly missing spans. A warning is NOT that case — the
        // export landed whole — so it goes to stderr beside the progress dots and the run
        // carries on. [LAW:no-silent-failure] the collector spoke; something says so.
        const said = collectorSaid(body);
        if (said.kind === 'rejected')
          throw new Error(
            `${command.endpoint} accepted session ${session.session} only in part: ${said.message}`,
          );
        if (said.kind === 'warned')
          streams.err(
            `\n${command.endpoint} stored session ${session.session} with a warning: ${said.message}\n`,
          );

        // Written as it lands, header already out, so the rows on stdout are exactly the
        // sessions the collector took — including on the run that later throws.
        for (const r of rows) streams.out(`${exportRow(r)}\n`);
        traces += rows.length;
        spans += rows.reduce((a, r) => a + r.spans, 0);
        streams.err('.');
      }
      streams.err('\n');
      streams.err(
        `${file.sessions.length} sessions · ${traces} traces · ${spans} spans -> ${command.endpoint}\n`,
      );
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
        // What the scope flags kept. Equal to `discovered` when none were given, so an
        // unscoped run frames itself exactly as it did before the flags existed.
        inScope: picked.length,
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

/** Parse, run, and turn either failure into its own exit code.
 *
 * [LAW:effects-at-boundaries] Takes `argv` and the `Runtime` rather than reaching for
 * `process.argv`, `process.env` and `Date.now()` itself, so the exit-code contract this
 * file declares can be exercised by a test instead of asserted in a comment. The three
 * ambient reads live on the `import.meta.main` line below — the actual edge. */
export async function main(argv: readonly string[], rt: Runtime): Promise<number> {
  // Parsed in its own try, so a bad command line exits USAGE and a failure during the
  // run exits FAILED. Collapsing them would tell a script that a corrupt transcript was
  // a typo. [LAW:no-silent-failure]
  let command: Command;
  try {
    command = readArgs(argv);
  } catch (e) {
    rt.streams.err(`${message(e)}\n`);
    return EXIT.USAGE;
  }

  try {
    return await run(command, rt);
  } catch (e) {
    rt.streams.err(`${message(e)}\n`);
    return EXIT.FAILED;
  }
}

/** How long one session's export may take before the run gives up on the collector.
 *
 * Generous, because the bound exists to catch a collector that has STOPPED rather than one
 * that is merely slow: a session posts as a single body, the corpus has sessions past a
 * megabyte, and an endpoint across a slow link is doing nothing wrong. Thirty seconds is
 * far past any healthy local collector and far short of forever, which is the only other
 * value on offer. */
const POST_TIMEOUT_MS = 30_000;

/** The real post. [LAW:effects-at-boundaries] The only place in this project that opens a
 * socket, and it lives on the edge beside the file reader and the clock.
 *
 * A network error throws out of `fetch` and is caught by `main`'s handler as EXIT.FAILED
 * with the message attached — a collector that is not running should say so, not be
 * turned into a status code this function invented. [LAW:no-silent-failure]
 *
 * THE BOUND, because "not running" is not the only way a collector fails. One that accepts
 * the connection and then never answers leaves a bare `fetch` awaiting forever: no exit
 * code, no stderr, no partial answer — the loudest failure design in this file defeated by
 * a socket that simply goes quiet. That is not hypothetical for this backend; the retry
 * budget in `scripts/verify-otlp.ts` exists because its memory store stalls part-way
 * through bodies under load, measured on the read path. The write path gets a bound for
 * the same reason.
 *
 * The abort is re-thrown NAMED. Bun raises a `TimeoutError` whose message is the bare
 * "The operation timed out." — true, and useless: it names neither the endpoint it gave up
 * on nor how long it waited, so a reader cannot tell a wedged collector from a wrong
 * `--endpoint`. Trading an indefinite hang for an unactionable message is not the fix.
 * [LAW:no-silent-failure] */
const postJson: Post = async (url, json) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: json,
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  }).catch((e: unknown) => {
    if (e instanceof DOMException && e.name === 'TimeoutError')
      throw new Error(`${url} did not answer within ${POST_TIMEOUT_MS / 1000}s`);
    throw e;
  });
  return { status: res.status, body: await res.text() };
};

// `import.meta.main` is false when a test imports `run` above, so importing this module
// never runs a corpus scan as a side effect — the exact trap `src/report/args.ts` was
// carved out of `generate.ts` to escape.
// `process.exitCode`, NEVER `process.exit()`. Writing to stdout is non-blocking when
// stdout is a pipe, so `process.exit()` terminates with bytes still sitting in the pipe
// buffer — measured here at exactly 65,536 of 798,808, i.e. one buffer's worth, which
// made `miser trace | jq` die on unfinished JSON while the same command redirected to a
// file was whole. Setting the code and letting the process end when the event loop
// drains flushes the stream first. The truncation is invisible to the writer and only
// appears under the pipe this tool's output contract is designed around.
// Assigned inside `.then` rather than awaited at the top level, for the same reason the
// paragraph above gives: the process must be allowed to end on a drained event loop, and
// a top-level await here is equivalent — but the `.then` makes the ordering visible.
if (import.meta.main)
  void main(process.argv.slice(2), {
    env: process.env,
    streams: { out: (t) => process.stdout.write(t), err: (t) => process.stderr.write(t) },
    now: Date.now(),
    read: readText,
    post: postJson,
  }).then((code) => {
    process.exitCode = code;
  });

export { USAGE };
