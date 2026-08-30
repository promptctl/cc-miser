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
 * body, and it is the SERVER doing it: the failure reproduces at roughly a third of reads
 * through Bun's `fetch` (as ECONNRESET), through curl into a pipe, and through curl
 * straight to a file — three clients, one behaviour. Identical requests then succeed.
 *
 * That is a flaky read-only GET against a local dev backend, and retrying one is ordinary.
 * What it must not become is a loop that retries until it likes the answer: exhaustion is
 * fatal, and a NON-ZERO HTTP STATUS is never retried, because a 4xx or 5xx is Jaeger
 * answering rather than Jaeger stumbling. [LAW:no-silent-failure]
 *
 * The distinction matters more here than usual: a truncated response reaches this script as
 * a trace that could not be found, which reads as "that dimension is not indexed" — a false
 * finding about the exporter, manufactured by the transport.
 *
 * Response size drives the failure rate, so point this at a session of a few hundred spans.
 * Every dimension is emitted by the same code path at any size, and a small trace proves
 * the indexing exactly as well while leaving the answer unconfounded.
 *
 * curl rather than `fetch` because `telemetry/stack.sh` already queries this same API with
 * it, and because its exit codes separate a closed transfer from a refusal where `fetch`
 * gives one opaque reset. Its streams are drained one at a time: read concurrently with
 * `Promise.all`, the same queries succeeded 1 time in 5 rather than 4. */
async function jaegerGet(url: string, attempts = 5): Promise<{ data: JaegerTrace[] | null }> {
  for (let i = 1; i <= attempts; i++) {
    const proc = Bun.spawn(['curl', '-sS', '--fail-with-body', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const body = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;

    // 22 is `--fail-with-body` reporting an HTTP error. Jaeger answered; do not retry it.
    if (code === 22) throw new Error(`Jaeger refused ${url}: ${body.slice(0, 200)}`);
    if (code === 0 && body !== '') return JSON.parse(body) as { data: JaegerTrace[] | null };
    if (i === attempts)
      throw new Error(`${url} truncated ${attempts} times (curl ${code}): ${err.trim()}`);
    console.log(`  ..   truncated response, retrying (${i}/${attempts})`);
    await new Promise((r) => setTimeout(r, 200 * i));
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
    `${spans.length} in Jaeger vs ${expectedSpans} exported`,
  );

  const roots = spans.filter((s) => s.references.filter((r) => r.refType === 'CHILD_OF').length === 0);
  check(roots.length === 1, 'exactly one root span', `${roots.length} roots`);
  const dangling = spans.filter((s) =>
    s.references.some((r) => r.refType === 'CHILD_OF' && !byId.has(r.spanID)),
  );
  check(dangling.length === 0, 'every parent reference resolves inside the trace', `${dangling.length} dangling`);

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
  check(
    subagents.length > 0 && stray.length === 0,
    'every subagent nests under the span that spawned it',
    `${subagents.length} subagents — ${routes}`,
  );

  // THE TOTAL — the ticket's third condition, as an equality against the report.
  const rootSpan = roots[0]!;
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
if (unexercised.length > 0) {
  console.log(`\n${unexercised.length} not exercised by this session:`);
  for (const u of new Set(unexercised)) console.log(`  - ${u}`);
  console.log('  run again against a session that has them (e.g. one with depth-2 spawns).');
}
// [LAW:no-silent-failure] A verification script that exits 0 on failure is worse than no
// script: it converts a broken export into evidence that the export works.
process.exitCode = failures.length === 0 ? 0 : 1;
