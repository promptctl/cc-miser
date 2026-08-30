#!/usr/bin/env bun
// Prove a backfilled session is actually IN Jaeger, nested correctly, filterable on every
// dimension, and numerically equal to what the report says.
//
// WHY THIS EXISTS RATHER THAN A PARAGRAPH IN A TICKET. miser-tracing-yhc.2's done-when
// conditions are all claims about a running Jaeger — "viewable with its subagents nested
// correctly", "verified by filtering on each one in the UI rather than by reading the
// exporter", "agrees with the same session's total in the report". A person clicking
// through the UI can establish those once. This establishes them on demand, which is what
// makes them survive the next change to the exporter. [LAW:verifiable-goals]
//
// IT ASKS JAEGER, NOT THE EXPORTER. Every assertion below reads Jaeger's query API — the
// same index the UI filters on — so a tag that is emitted but not indexed fails here.
// Checking the request document instead would prove only that this project agrees with
// itself, which `test/otlp.test.ts` already covers.
//
//   bun run verify:otlp <session-id-prefix> [jaeger-url]
//
// Export first: `miser otlp --session <prefix>`.

import { readFileSync } from 'node:fs';
import { discoverSessions, projectsRoot } from '../src/discover.ts';
import { listRow } from '../src/cli/list.ts';
import { DOMAINS, GROUPABLE, exportSession } from '../src/cli/otlp.ts';
import { traceFile } from '../src/cli/trace.ts';
import { analyzeSession } from '../src/session.ts';

const [prefix, jaegerArg] = process.argv.slice(2);
const JAEGER = jaegerArg ?? 'http://localhost:17686';
if (prefix === undefined || prefix === '') {
  console.error('usage: bun run verify:otlp <session-id-prefix> [jaeger-url]');
  process.exit(2);
}

/** One checked claim. Collected rather than thrown so a run reports every failure it
 * found, not the first one. [LAW:no-silent-failure] */
const failures: string[] = [];
const check = (ok: boolean, claim: string, detail = ''): void => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${claim}${detail === '' ? '' : ` — ${detail}`}`);
  if (!ok) failures.push(claim);
};

/** A dimension this session never produced a value for — a session with no depth-2 spawn
 * has no `parent_agent_id` to filter on, and that is a fact about the SESSION.
 *
 * [LAW:types-are-the-program] Three outcomes, not two. Folded into `check` as a failure,
 * a shallow session would indict the exporter for a tag it correctly omitted; folded in as
 * a pass, a green run would claim coverage it never had — an answer-shaped void, since
 * "verified" and "never tried" would print identically. Kept apart, both stay legible and
 * the summary says which dimensions this session could not speak to. */
const unexercised: string[] = [];
const skip = (claim: string, why: string): void => {
  console.log(`  --   ${claim} — NOT EXERCISED: ${why}`);
  unexercised.push(claim);
};

// ─── What the pipeline says, computed locally ──────────────────────────────────────

const root = projectsRoot(null, process.env);
const sources = discoverSessions(root).filter((s) => s.sessionId.startsWith(prefix));
if (sources.length !== 1) {
  console.error(`\`${prefix}\` matched ${sources.length} sessions; need exactly one.`);
  process.exit(2);
}
const analyzed = analyzeSession(sources[0]!, (p) => readFileSync(p, 'utf8'));
const sessionId = analyzed.source.sessionId;
const expected = listRow(analyzed);
/** How many spans this session SHOULD have in each domain, from the exporter itself.
 *
 * Worth checking because the collector batches: querying moments after an export returns a
 * trace that is real, well-formed, correctly nested and INCOMPLETE. Three identical queries
 * during one such window answered 790,522 then 854,910 then 852,146 bytes. Every structural
 * check here would pass on a half-ingested trace, and the total would quietly disagree. */
const expectedSpans = exportSession(
  traceFile([analyzed], root, [], Date.now()).sessions[0]!,
).rows[0]!.spans;
console.log(
  `session ${sessionId} — ${expected.calls} calls, ${expected.tokEq} tok-eq, ` +
    `${expectedSpans} spans per domain, per the pipeline\n`,
);

// ─── Asking Jaeger ─────────────────────────────────────────────────────────────────

/** Jaeger's search window is in MICROSECONDS and is not optional; a query without one
 * silently searches a default recent window and finds nothing for an old session, which
 * reads exactly like "the export never arrived". */
const WINDOW = {
  start: (analyzed.tree.tStart - 86_400_000) * 1000,
  end: (analyzed.tree.tEnd + 86_400_000) * 1000,
};

interface JaegerSpan {
  spanID: string;
  operationName: string;
  references: { refType: string; spanID: string }[];
  tags: { key: string; value: unknown }[];
  processID: string;
}
interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, { tags: { key: string; value: unknown }[] }>;
}

async function search(service: string, tags: Record<string, string>): Promise<JaegerTrace[]> {
  // `limit=2` because the response carries WHOLE traces: a corpus session runs to
  // thousands of spans, and asking for twenty of them made Jaeger's all-in-one drop the
  // connection while assembling ~50MB of JSON. Every query here is scoped to one session,
  // so two is one more than any of them can legitimately return.
  const url =
    `${JAEGER}/api/traces?service=${encodeURIComponent(service)}` +
    `&start=${WINDOW.start}&end=${WINDOW.end}&limit=2` +
    `&tags=${encodeURIComponent(JSON.stringify(tags))}`;
  return (await jaegerGet(url)).data ?? [];
}

/** Ask Jaeger one question, retrying a truncated answer.
 *
 * WHY A RETRY IS THE RIGHT ANSWER HERE, WHICH TOOK MEASURING TO ESTABLISH. Jaeger's search
 * API returns WHOLE traces — no projection, no id-only form — so each of the two dozen
 * queries below re-serialises the entire trace, 2.5MB for a 1,463-span session. Under that
 * repetition `jaeger-all-in-one`'s memory store closes connections part-way through the
 * body, and it is the SERVER doing it: the failure reproduces through Bun's `fetch` (as
 * ECONNRESET), through curl into a pipe, and through curl straight to a file — three
 * clients, one behaviour. Identical requests then succeed.
 *
 * HOW OFTEN IT FAILS DECIDES THE BUDGET, which is why the number below is measured and not
 * estimated. Against the 525-span domain of session `8c55cbcd` — an 894KB response, and the
 * very session `telemetry/README.md` hands you to verify — 14 of 24 reads truncated on
 * 2026-08-30: a 58% per-read failure rate. An earlier estimate of "roughly a third" sized
 * this budget at 5, which leaves 0.58^5 ≈ 7% per query and, over the two dozen queries a run
 * makes, failed FOUR RUNS IN FIVE — the shape the bug actually took, on the one command the
 * README promises will prove the export arrived. Twenty attempts gives 0.58^20 ≈ 2e-5 per
 * query, under one run in a thousand. Re-measure before retuning it: the measurement is the
 * reason and the constant is only its residue, and it was the two drifting apart that broke
 * this. [FRAMING:representation]
 *
 * That is a flaky read-only GET against a local dev backend, and retrying one is ordinary.
 * What it must not become is a loop that retries until it likes the answer: exhaustion is
 * fatal, and only ONE class of failure takes the retry path at all. A 4xx or 5xx is Jaeger
 * answering rather than stumbling, and a refused or unresolvable connection means there is
 * nothing there to stumble — each fails immediately, with its own message.
 * [LAW:no-silent-failure]
 *
 * The distinction matters more here than usual: a truncated response reaches this script as
 * a trace that could not be found, which reads as "that dimension is not indexed" — a false
 * finding about the exporter, manufactured by the transport.
 *
 * Response size drives that rate, so prefer the smallest session that still carries the
 * dimensions you need: every dimension is emitted by the same code path at any size, and a
 * small trace proves the indexing exactly as well while leaving the answer unconfounded.
 * Small is not automatically sufficient, though, and the tension is real — the four subagent
 * checks stay NOT EXERCISED until the session has spawns, and a session with spawns is a
 * session of hundreds of spans. The budget above is what keeps that unavoidably larger
 * session readable, so the two halves of the advice stop contradicting each other.
 *
 * curl rather than `fetch` because `telemetry/stack.sh` already queries this same API with
 * it, and because its exit codes separate a closed transfer from a refusal where `fetch`
 * gives one opaque reset. Its streams are drained one at a time: read concurrently with
 * `Promise.all`, the same queries succeeded 1 time in 5 rather than 4. */
async function jaegerGet(url: string, attempts = 20): Promise<{ data: JaegerTrace[] | null }> {
  for (let i = 1; i <= attempts; i++) {
    const proc = Bun.spawn(['curl', '-sS', '--fail-with-body', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const body = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;

    if (code === 0 && body !== '') return JSON.parse(body) as { data: JaegerTrace[] | null };

    // WHAT WENT WRONG DECIDES WHAT TO DO, and only ONE of these outcomes is the flake the
    // retry above exists for. Routing everything that is not an HTTP error through the
    // truncation path gave the likeliest first-run failure — the stack simply is not up —
    // a full budget of pointless retries and then the wrong diagnosis, `truncated 20 times
    // (curl 7)`, for a connection that was never made. A message that misnames the cause
    // costs more than no message. [LAW:no-silent-failure]
    if (code === 22) throw new Error(`Jaeger refused ${url}: ${body.slice(0, 200)}`);
    if (code === 6 || code === 7 || code === 28)
      throw new Error(
        `cannot reach Jaeger at ${JAEGER} (curl ${code}: ${err.trim()}). ` +
          `Is the stack up? \`bun run telemetry up && bun run telemetry verify\``,
      );
    // Everything left is a connected transfer that did not complete — curl 18 and its
    // relatives — which is the server closing part-way through a large body.
    if (i === attempts)
      throw new Error(`${url} truncated ${attempts} times (curl ${code}): ${err.trim()}`);
    console.log(`  ..   truncated response, retrying (${i}/${attempts})`);
    // Capped, because this is politeness and not backoff: the store needs no recovery time —
    // identical requests succeed immediately — while an uncapped 200ms×i across twenty
    // attempts would sit out 38s per query waiting for nothing to happen.
    await new Promise((r) => setTimeout(r, Math.min(200 * i, 500)));
  }
  throw new Error('unreachable');
}

/** A span's tag as text, looking in the span's own tags and then in its process tags —
 * which is where resource attributes land, and where Jaeger's UI shows them. */
const tagOf = (trace: JaegerTrace, span: JaegerSpan, key: string): string | undefined => {
  const own = span.tags.find((t) => t.key === key);
  const proc = trace.processes[span.processID]?.tags.find((t) => t.key === key);
  const found = own ?? proc;
  return found === undefined ? undefined : String(found.value);
};

for (const domain of DOMAINS) {
  console.log(`── ${domain.service} ──`);

  // The session tag doing real work: this is both the first filter check and how the
  // trace is located, so a session.id that is emitted but not indexed fails immediately
  // rather than being reported as a missing trace.
  const found = await search(domain.service, { [GROUPABLE.session]: sessionId });
  check(found.length === 1, `the session is one trace, findable by \`${GROUPABLE.session}\``, `${found.length} found`);
  if (found.length !== 1) continue;
  const trace = found[0]!;
  const spans = trace.spans;
  const byId = new Map(spans.map((s) => [s.spanID, s]));

  // NESTING — the ticket's first condition. Jaeger accepts a span whose parent it has
  // never seen and renders it at the top level, so "arrived" and "nested correctly" are
  // different facts and only the second one is worth anything here.
  // Checked FIRST, because every assertion below it is meaningless on a partial trace:
  // a half-ingested tree still has one root, still resolves every reference it does have,
  // and still nests correctly. Only the count knows the difference.
  check(
    spans.length === expectedSpans,
    'every span sent is a span stored',
    // "would export now", not "exported": the corpus is live. A session still being
    // written grows between an export and this check, and the honest reading of a
    // mismatch is either a partial ingest or a stale export — re-export and run again.
    `${spans.length} in Jaeger vs ${expectedSpans} the pipeline would export now`,
  );

  const roots = spans.filter((s) => s.references.filter((r) => r.refType === 'CHILD_OF').length === 0);
  check(roots.length === 1, 'exactly one root span', `${roots.length} roots`);
  const dangling = spans.filter((s) =>
    s.references.some((r) => r.refType === 'CHILD_OF' && !byId.has(r.spanID)),
  );
  check(dangling.length === 0, 'every parent reference resolves inside the trace', `${dangling.length} dangling`);

  // Everything below needs THE root, and a rootless trace is exactly the malformed shape
  // this script exists to catch. Reading `roots[0]!` anyway turned that finding into a
  // TypeError that killed the run — so the one input worth reporting in full detail was
  // the one input that produced no report at all, against this file's own promise to
  // collect every failure rather than throw on the first. The failed check above is
  // already recorded; this stops, it does not swallow. [LAW:no-silent-failure]
  //
  // The root is BOUND here rather than asserted with `!` further down: the check and the
  // value come from one expression, so there is no second place that could be right about
  // the count and wrong about the span.
  const rootSpan = roots.length === 1 ? roots[0] : undefined;
  if (rootSpan === undefined) {
    console.log('  --   remaining checks skipped for this domain: no single root to walk from\n');
    continue;
  }

  // WHERE A SUBAGENT MAY LEGALLY HANG, enumerated rather than assumed. This check first
  // asserted the one shape everybody pictures — a subagent under the `claude_code.tool`
  // span that spawned it — and a real session failed it with 1 of 11 misparented. The
  // pipeline was right and the check was wrong: `spans.ts` resolves TWO spawn routes, and
  // a slash-command fork leaves no `tool_use` block to hang from, so it attaches to the
  // CALL it was issued at. A conversation with no call to graft onto at all (`looseKids`)
  // attaches to the conversation span. Three legal parents, one illegal outcome — being
  // parented to nothing, which is the failure "nested correctly" is actually about.
  const LEGAL_PARENTS: Record<string, string> = {
    'claude_code.tool': 'tool_use edge',
    'claude_code.llm_request': 'slash-command fork',
    'cc_miser.session': 'no call to graft onto',
    'cc_miser.subagent': 'no call to graft onto',
  };
  const subagents = spans.filter((s) => s.operationName === 'cc_miser.subagent');
  const parents = subagents.map(
    (s) => byId.get(s.references.find((r) => r.refType === 'CHILD_OF')?.spanID ?? '')?.operationName,
  );
  const stray = parents.filter((p) => p === undefined || LEGAL_PARENTS[p] === undefined);
  const routes = [...new Set(parents)]
    .map((p) => `${parents.filter((q) => q === p).length}× ${p} (${LEGAL_PARENTS[p ?? ''] ?? 'ILLEGAL'})`)
    .join(', ');
  // A session with no spawns at all is an ordinary session, not a broken export — the
  // same kind of fact as a dimension this session does not carry, and it belongs in the
  // same bucket. Folded into `check`, `subagents.length > 0` made every plain
  // conversation report a false failure; folded in as a pass, a green run would claim it
  // had checked nesting when there was no nesting to check.
  if (subagents.length === 0)
    skip('every subagent nests under the span that spawned it', 'this session spawned none');
  else
    check(
      stray.length === 0,
      'every subagent nests under the span that spawned it',
      `${subagents.length} subagents — ${routes}`,
    );

  // THE TOTAL — the ticket's third condition, as an equality against the report.
  const inJaeger = tagOf(trace, rootSpan, 'cc_miser.rollup.tok_eq');
  check(
    inJaeger === String(expected.tokEq),
    'the total in Jaeger equals the total in the report',
    `${inJaeger} vs ${expected.tokEq}`,
  );

  // EVERY DIMENSION IS FILTERABLE — the ticket's second condition. For each dimension,
  // take a value the trace actually carries and ask Jaeger to find the trace BY it. A
  // tag that is present in the payload but absent from the index fails here, which is the
  // failure "verified by reading the exporter" would never catch.
  for (const [dimension, key] of Object.entries(GROUPABLE)) {
    const carrier = spans.find((s) => tagOf(trace, s, key) !== undefined);
    if (carrier === undefined) {
      skip(`${dimension} is filterable on \`${key}\``, `no span in this session carries \`${key}\``);
      continue;
    }
    const value = tagOf(trace, carrier, key)!;
    // AND'd with the session so the question is "does filtering on this dimension find
    // THIS trace" rather than "does anything in the corpus carry this key". Jaeger matches
    // all tags on one span, and `session.id` is a process tag every span inherits, so the
    // carrier span satisfies both.
    const hits = await search(domain.service, { [GROUPABLE.session]: sessionId, [key]: value });
    check(
      hits.some((t) => t.traceID === trace.traceID),
      `${dimension} is filterable on \`${key}\``,
      `${key}=${value.slice(0, 40)} → ${hits.length} traces`,
    );
  }
  console.log('');
}

console.log(failures.length === 0 ? 'all checks passed' : `${failures.length} FAILED:`);
for (const f of failures) console.log(`  - ${f}`);
// Printed even on a clean run, and printed LAST, because this is the sentence that says
// how much a green run is worth. A dimension nothing exercised was not verified.
//
// ONE collection decides both the count and the list. Every skip fires once per domain and
// a dimension's presence does not vary between them, so counting the raw array while
// listing the deduplicated set printed "8 not exercised" above two bullets — a header
// disagreeing with its own list, in the script whose whole job is keeping "verified" and
// "never tried" legible. [LAW:one-source-of-truth]
const distinct = new Set(unexercised);
if (distinct.size > 0) {
  console.log(`\n${distinct.size} not exercised by this session:`);
  for (const u of distinct) console.log(`  - ${u}`);
  console.log('  run again against a session that has them (e.g. one with depth-2 spawns).');
}
// [LAW:no-silent-failure] A verification script that exits 0 on failure is worse than no
// script: it converts a broken export into evidence that the export works.
process.exitCode = failures.length === 0 ? 0 : 1;
