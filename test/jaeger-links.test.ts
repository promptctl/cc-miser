// The seam between the two tools: the report stopped drawing the span tree, so its links
// into Jaeger are now the only way from a priced finding to the call it is about.
//
// WHAT THESE ARE REALLY GUARDING. A trace id is a digest over a session id and a service
// name, and a span id a digest over that plus a span-tree node id. Nothing validates one.
// Every way of getting it wrong — a service name spelled differently at the two ends, a
// `call:<n>` grammar that changed in `spans.ts`, a finding anchored to a call that does
// not exist — produces a perfectly well-formed hyperlink to a trace view with nothing in
// it. There is no error, no warning, and no way for a reader to tell that from a session
// nobody exported. [LAW:no-silent-failure] So the assertion that matters is not that the
// report emits links; it is that the ids in those links are ids the EXPORTER emits, for
// the same session, checked against the document a collector would receive.
//
// [LAW:behavior-not-structure] Everything below reads the rendered page and the emitted
// request. Any renderer that links a finding to the right span passes.

import { describe, expect, test } from 'bun:test';
import { exportSession, type OtlpTraces } from '../src/cli/otlp.ts';
import { traceFile } from '../src/cli/trace.ts';
import { DOMAINS, traceIdOf } from '../src/jaeger.ts';
import { projectSession } from '../src/report/project.ts';
import { renderCorpus } from '../src/report/render.ts';
import { analyzeSession } from '../src/session.ts';
import { ZERO_PRICES, PRICE_SOURCE } from '../src/models.ts';
import { ZERO_OUTPUT } from '../src/output.ts';
import { eqCost } from '../src/tokens.ts';
import { assistantTurn, buildSession, fixtureModels, userSays, type SessionSpec } from './fixtures.ts';
import type { CorpusReport } from '../src/report/model.ts';

/** Three root calls whose cache-read FALLS at the third, which is what `findEpochs` reads
 * as a boundary. That gives the page two different kinds of call-anchored finding — the
 * startup one, which every session has, and a cache-invalidation one naming the call that
 * opened the new epoch — so the anchoring is exercised on more than a single code path.
 *
 * A large tool result rides on the first call so the "largest tool result" finding, the
 * third anchored kind, has something to name. */
const SPEC: SessionSpec = {
  sessionId: 'lnk11111-2222-3333-4444-555555555555',
  project: '-home-jdoe-src-alpha',
  cwd: '/home/jdoe/src/alpha',
  model: 'claude-opus-5',
  root: [
    userSays('find where the parser lives'),
    assistantTurn({
      thinking: '',
      text: 'Searching.',
      tools: [
        { id: 'toolu_a', name: 'Grep', input: { pattern: 'parse' }, result: 'src/records.ts\n'.repeat(400) },
      ],
      attachments: [],
      usage: { input: 10, cacheCreation: 4_000, cacheRead: 0, output: 300 },
    }),
    assistantTurn({
      thinking: '',
      text: 'Reading it.',
      tools: [],
      attachments: [],
      usage: { input: 5, cacheCreation: 1_000, cacheRead: 4_000, output: 200 },
    }),
    assistantTurn({
      thinking: '',
      text: 'Back after a break.',
      tools: [],
      attachments: [],
      // Cache-read falls from 4,000 to 100: the prefix did not survive, which is exactly
      // the condition `findEpochs` treats as opening a new epoch.
      usage: { input: 900, cacheCreation: 5_000, cacheRead: 100, output: 150 },
    }),
  ],
  spawns: [],
};

const built = buildSession(SPEC);
const analyzed = analyzeSession(built.source, built.read);
const report = projectSession(
  analyzed,
  fixtureModels({ 'claude-opus-5': { charsPerToken: 2.5, tokensPerBlock: 50 } }),
);
const session = traceFile([analyzed], '/corpus', [], 1_700_000_000_000).sessions[0]!;
const { request, rows } = exportSession(session);

const JAEGER = 'https://jaeger.example:9999';

const corpus: CorpusReport = {
  generatedAt: 0,
  sessions: [report],
  selection: { discovered: 1, inScope: 1, rendered: 1, criteria: [] },
  ledgers: [],
  total: eqCost(report.total.value),
  pricing: ZERO_PRICES,
  calibration: { rows: [], seen: ['claude-opus-5'], priceSource: PRICE_SOURCE },
  coverage: { byTier: { marker: 0, rule: 0, judge: 0, hand: 0, none: 1 }, unclassified: 1 },
  output: ZERO_OUTPUT,
};

const html = renderCorpus(corpus, JAEGER);

/** Every href the page carries that points into Jaeger. */
const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);

const tagOf = (
  attrs: readonly { key: string; value: Record<string, unknown> }[],
  key: string,
): string | undefined => {
  const found = attrs.find((a) => a.key === key);
  return found === undefined ? undefined : String(Object.values(found.value)[0]);
};

/** The spans a collector would receive for one domain, keyed by the id Jaeger indexes. */
const spansByIdIn = (req: OtlpTraces, service: string): Map<string, { attributes: never[] }> =>
  new Map(
    req.resourceSpans
      .filter((rs) => tagOf(rs.resource.attributes, 'service.name') === service)
      .flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans))
      .map((s) => [s.spanId, s as unknown as { attributes: never[] }]),
  );

const tokenSpans = spansByIdIn(request, DOMAINS.tokens.service);

describe('a finding links to the span it names', () => {
  test('the page carries span links at all', () => {
    // Stated separately so the assertions below cannot pass vacuously on a page that
    // rendered no links whatsoever — every "for each link" check is true of none.
    const spanLinks = links.filter((h) => h.includes('uiFind='));
    expect(spanLinks.length).toBeGreaterThan(0);
  });

  test('every linked span id is a span the exporter actually emits', () => {
    // THE ANTI-DRIFT ASSERTION. The report computes these ids from the session id and a
    // node id; the exporter computes them independently on its way to the collector. If
    // either the digest, the service name or the `call:<n>` grammar moves at one end, the
    // ids stop matching here — where a human sees a failing test, rather than in Jaeger,
    // where they would see an empty trace and no reason to suspect the report.
    const linked = links
      .map((h) => /uiFind=([0-9a-f]+)$/.exec(h)?.[1])
      .filter((id): id is string => id !== undefined);
    expect(linked.length).toBeGreaterThan(0);
    for (const id of linked) expect(tokenSpans.has(id)).toBe(true);
  });

  test('the span a link lands on is the call its own text names', () => {
    // Not merely A span — the RIGHT span. A link that resolves to some other call is the
    // failure this catches: still well-formed, still opens a real trace, still wrong.
    const anchored = [
      ...html.matchAll(/href="[^"]*uiFind=([0-9a-f]+)"[^>]*>call (\d+) in Jaeger</g),
    ];
    // More than one DISTINCT call, so this cannot pass on a page where only the startup
    // finding — the one every session has — happens to anchor correctly. This fixture
    // reaches all three anchored kinds: startup at call 0, the largest tool result at the
    // call it became resident at, and the cache invalidation at the call that opened the
    // second epoch.
    expect(new Set(anchored.map(([, , call]) => call)).size).toBeGreaterThan(1);
    expect(anchored.length).toBeGreaterThan(0);
    for (const [, spanId, callIndex] of anchored) {
      const span = tokenSpans.get(spanId!)!;
      expect(span).toBeDefined();
      expect(tagOf(span.attributes, 'cc_miser.kind')).toBe('call');
      expect(tagOf(span.attributes, 'cc_miser.call_first')).toBe(callIndex!);
    }
  });

  test('a trace link opens the trace the exporter reported for that domain', () => {
    // `miser otlp` prints a trace id per (session, domain); the page must send a reader to
    // those exact traces, not to ids that merely look like them.
    for (const row of rows) {
      expect(html).toContain(`/trace/${row.traceId}`);
    }
    // ...and the ids are per-domain, so the two links must differ. A single-domain digest
    // would pass every check above while quietly sending both links to one trace.
    expect(traceIdOf('time', SPEC.sessionId)).not.toBe(traceIdOf('tokens', SPEC.sessionId));
  });
});

describe('the page says where it sent the tree, and what the links depend on', () => {
  test('the span tree is delegated rather than drawn', () => {
    // The deletion, stated as the reader's experience: there is no flamegraph on the page,
    // and there is a way to the one that replaced it.
    expect(html).not.toContain('cost-weighted flamegraph');
    expect(html).toContain('The span tree is in Jaeger');
  });

  test('both domains are offered, and named by what their axis means', () => {
    expect(html).toContain(DOMAINS.time.label);
    expect(html).toContain(DOMAINS.tokens.label);
  });

  test('the precondition is on the page, because an unexported session looks identical', () => {
    // Nothing here contacts Jaeger, so a link to a session nobody exported opens an empty
    // trace. Unless the page says so, that is indistinguishable from a broken report.
    expect(html).toContain('miser otlp');
    expect(html).toContain('opens an empty trace');
  });

  test('the page warns that an export is a snapshot, not a live view', () => {
    // Observed while verifying this change against a running Jaeger: a session exported
    // half an hour earlier had grown from 48 calls to 67, and the finding anchored to
    // call 65 linked to a span that did not exist there yet. The report was right and the
    // export was stale — which is `miser-tracing-yhc.5` — and the only thing that makes
    // that legible to a reader is the page saying so.
    // Whitespace-normalised: the sentence wraps across source lines, and asserting on the
    // template's indentation would be a test of how the string is typed, not of what the
    // page says. [LAW:behavior-not-structure]
    expect(html.replace(/\s+/g, ' ')).toContain('An export is a snapshot');
  });

  test('the links go where the caller said, not to a baked-in default', () => {
    expect(html).toContain(JAEGER);
    expect(html).not.toContain('localhost');
  });
});
