// What the OTLP export promises: a tree Jaeger can hold, in two domains that stay apart,
// carrying every dimension a reader can group by.
//
// [LAW:behavior-not-structure] Everything here reads the emitted REQUEST — the document a
// collector would receive — rather than the functions that built it. A different exporter
// producing the same spans passes all of it.
//
// The invariants are checked twice on purpose: once on a fixture, where the expected
// numbers were chosen by hand and a wrong answer is visible, and once over a real corpus
// where no answer is declared but the shapes must still hold. Every span-model bug this
// project has had showed up in the second kind first.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { listRow } from '../src/cli/list.ts';
import {
  DOMAINS,
  EXPORT_COLUMNS,
  GROUPABLE,
  exportSession,
  type OtlpTraces,
} from '../src/cli/otlp.ts';
import { traceFile, type TraceSession } from '../src/cli/trace.ts';
import { analyzeSession, type AnalyzedSession } from '../src/session.ts';
import {
  assistantTurn,
  buildSession,
  userSays,
  type SessionSpec,
} from './fixtures.ts';
import { chooseCorpus } from './corpus.ts';

/** A session with a subagent under a tool call, so nesting is exercised rather than
 * assumed. The numbers are small and chosen by hand: 2 root calls and 1 spawned call. */
const SPEC: SessionSpec = {
  sessionId: 'otlp1111-2222-3333-4444-555555555555',
  project: '-home-jdoe-src-alpha',
  cwd: '/home/jdoe/src/alpha',
  model: 'claude-opus-5',
  root: [
    userSays('find where the parser lives'),
    assistantTurn({
      thinking: '',
      text: 'Searching.',
      tools: [{ id: 'toolu_a', name: 'Grep', input: { pattern: 'parse' }, result: 'src/records.ts\n' }],
      attachments: [],
      usage: { input: 10, cacheCreation: 2_000, cacheRead: 0, output: 300 },
    }),
    assistantTurn({
      thinking: '',
      text: 'Handing this to an explorer.',
      tools: [
        {
          id: 'toolu_spawn',
          name: 'Agent',
          input: { subagent_type: 'Explore', description: 'map the parser' },
          result: 'done',
        },
      ],
      attachments: [],
      usage: { input: 5, cacheCreation: 1_000, cacheRead: 2_000, output: 200 },
    }),
  ],
  spawns: [
    {
      agentId: 'a_explore',
      agentType: 'Explore',
      description: 'map the parser',
      toolUseId: 'toolu_spawn',
      declaredDepth: 1,
      startMinute: 4,
      events: [
        userSays('map the parser'),
        assistantTurn({
          thinking: '',
          text: 'Read three files, then delegating the plan.',
          tools: [
            {
              id: 'toolu_deep',
              name: 'Agent',
              input: { subagent_type: 'Plan', description: 'plan the change' },
              result: 'ok',
            },
          ],
          attachments: [],
          usage: { input: 2, cacheCreation: 800, cacheRead: 100, output: 150 },
        }),
      ],
    },
    {
      // A SLASH-COMMAND FORK: the empty `toolUseId` is the whole point. This route leaves
      // no `tool_use` block behind — 158 of 481 spawns in the observed corpus — so the
      // conversation attaches to the CALL it was issued at rather than to a tool span.
      // Modelled here because a check that assumed the tool_use shape passed every fixture
      // and then failed on a real session where the pipeline was right.
      agentId: 'a_command',
      agentType: 'review',
      description: 'slash-command fork',
      toolUseId: '',
      declaredDepth: 1,
      startMinute: 5,
      events: [
        userSays('/review'),
        assistantTurn({
          thinking: '',
          text: 'Reviewed.',
          tools: [],
          attachments: [],
          usage: { input: 3, cacheCreation: 600, cacheRead: 40, output: 80 },
        }),
      ],
    },
    {
      // A GRANDCHILD, because depth 2 is where this corpus keeps its money — `lineage.ts`
      // measured one session at 0.7% / 33.1% / 66.2% across depths 0, 1 and 2 — and
      // because `parent_agent_id` has nothing to name until a spawn has a grandparent.
      agentId: 'a_deep',
      agentType: 'Plan',
      description: 'plan the change',
      toolUseId: 'toolu_deep',
      declaredDepth: 2,
      startMinute: 6,
      events: [
        userSays('plan the change'),
        assistantTurn({
          thinking: '',
          text: 'Here is the plan.',
          tools: [],
          attachments: [],
          usage: { input: 1, cacheCreation: 400, cacheRead: 50, output: 90 },
        }),
      ],
    },
  ],
};

/** The one session, as the document `miser trace` publishes and the exporter consumes. */
const sessionOf = (a: AnalyzedSession): TraceSession =>
  traceFile([a], '/corpus', [], 1_700_000_000_000).sessions[0]!;

const analyzed = analyzeSession(buildSession(SPEC).source, buildSession(SPEC).read);
const session = sessionOf(analyzed);
const { request, rows: emittedRows } = exportSession(session);

// ─── Reading the emitted document back ─────────────────────────────────────────────
//
// These helpers read the REQUEST, not the tree it came from — a test that walked the
// TraceNode tree would be asserting that the exporter agrees with its own input.

/** An attribute's value as text, whatever `oneof` arm it arrived in — the way a tag reads
 * in Jaeger's UI, which is where the ticket asks these be filterable. */
const tagOf = (
  attrs: readonly { key: string; value: Record<string, unknown> }[],
  key: string,
): string | undefined => {
  const found = attrs.find((a) => a.key === key);
  return found === undefined ? undefined : String(Object.values(found.value)[0]);
};

const resourceOf = (req: OtlpTraces, domain: string) =>
  req.resourceSpans.find((rs) => tagOf(rs.resource.attributes, 'service.name') === domain)!.resource
    .attributes;

const spansOf = (req: OtlpTraces, domain: string) =>
  req.resourceSpans
    .filter((rs) => tagOf(rs.resource.attributes, 'service.name') === domain)
    .flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));

const TIME = DOMAINS[0]!.service;
const TOKENS = DOMAINS[1]!.service;

describe('a backfilled session is one trace per domain, and the domains do not mix', () => {
  test('both domains are emitted on every export, with no flag to ask for either', () => {
    // The ticket's requirement that the two domains be kept apart "rather than emitting
    // one and discovering the other is unrepresentable". Neither is opt-in.
    expect(request.resourceSpans).toHaveLength(2);
    expect(request.resourceSpans.map((rs) => tagOf(rs.resource.attributes, 'service.name'))).toEqual([
      TIME,
      TOKENS,
    ]);
  });

  test('the two domains are different traces, so no view can mix a duration with a cost', () => {
    const timeIds = new Set(spansOf(request, TIME).map((s) => s.traceId));
    const tokenIds = new Set(spansOf(request, TOKENS).map((s) => s.traceId));
    expect(timeIds.size).toBe(1);
    expect(tokenIds.size).toBe(1);
    expect([...timeIds][0]).not.toBe([...tokenIds][0]);
  });

  test('both domains carry the same spans, since only the layout differs', () => {
    expect(spansOf(request, TIME)).toHaveLength(spansOf(request, TOKENS).length);
  });
});

describe('the span tree survives the crossing into OTLP', () => {
  const spans = spansOf(request, TIME);
  const byId = new Map(spans.map((s) => [s.spanId, s]));

  test('exactly one span has no parent, and every other parent exists in the trace', () => {
    // A dangling parent id is a subtree Jaeger renders detached from its session, which
    // is the failure the ticket's "subagents nested correctly" is about.
    const roots = spans.filter((s) => s.parentSpanId === undefined);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.name).toBe('cc_miser.session');
    const orphans = spans.filter((s) => s.parentSpanId !== undefined && !byId.has(s.parentSpanId!));
    expect(orphans.map((s) => s.name)).toEqual([]);
  });

  test('a slash-command fork nests under the CALL it was issued at', () => {
    // The second spawn route, and the one an exporter that only models `tool_use` gets
    // wrong: there is no tool span to hang from, so the conversation attaches to the call.
    // Asserting "every subagent is under a tool" passes every tool_use fixture and is
    // false for 158 of the 481 spawns in the observed corpus.
    const forked = spans.find(
      (s) => s.name === 'cc_miser.subagent' && tagOf(s.attributes, GROUPABLE.agent) === 'a_command',
    )!;
    expect(forked).toBeDefined();
    expect(byId.get(forked.parentSpanId!)!.name).toBe('claude_code.llm_request');
  });

  test('span ids are unique, so no two spans collapse into one in the UI', () => {
    expect(new Set(spans.map((s) => s.spanId)).size).toBe(spans.length);
  });

  test('a tool_use spawn nests under the tool call that spawned it', () => {
    const subagent = spans.find(
      (s) => s.name === 'cc_miser.subagent' && tagOf(s.attributes, GROUPABLE.agent) === 'a_explore',
    )!;
    expect(subagent).toBeDefined();
    const parent = byId.get(subagent.parentSpanId!)!;
    expect(parent.name).toBe('claude_code.tool');
    expect(tagOf(parent.attributes, GROUPABLE.tool)).toBe('Agent');
    // And the subagent's own call sits under the subagent, not beside it.
    const spawnedCall = spans.find(
      (s) => s.name === 'claude_code.llm_request' && tagOf(s.attributes, GROUPABLE.depth) === '1',
    )!;
    expect(spawnedCall).toBeDefined();
    expect(byId.has(spawnedCall.parentSpanId!)).toBe(true);
  });
});

describe('names match the native schema where native has the concept', () => {
  const names = new Set(spansOf(request, TIME).map((s) => s.name));

  test('a turn, a call and a tool arrive under the names live traces use', () => {
    // The point of matching: a Jaeger query written against a live session finds a
    // backfilled one. `interaction` is native's name for one prompt and its consequences.
    expect(names).toContain('claude_code.interaction');
    expect(names).toContain('claude_code.llm_request');
    expect(names).toContain('claude_code.tool');
  });

  test('what native has no concept of is not dressed as a native span', () => {
    // Native emits no session root and no span for a subagent itself — lineage rides on
    // parentage plus `agent_id`. A `claude_code.` name for either would be this project
    // claiming the native exporter emits something it does not.
    expect(names).toContain('cc_miser.session');
    expect(names).toContain('cc_miser.subagent');
    const NATIVE = ['claude_code.interaction', 'claude_code.llm_request', 'claude_code.tool'];
    const invented = [...names].filter((n) => n.startsWith('claude_code.') && !NATIVE.includes(n));
    expect(invented).toEqual([]);
  });

  test('every span states its own name as span.type, as native does', () => {
    for (const s of spansOf(request, TIME)) expect(tagOf(s.attributes, 'span.type')).toBe(s.name);
  });
});

describe('every dimension the report groups by is a tag a reader can filter on', () => {
  // The ticket's second DONE-WHEN condition. `GROUPABLE` is the table the emitter builds
  // its attributes from and the verification script queries Jaeger with, so this checks
  // the keys actually emitted rather than a list kept in step by hand.
  const spanTags = new Set(spansOf(request, TIME).flatMap((s) => s.attributes.map((a) => a.key)));
  const resourceTags = new Set(resourceOf(request, TIME).map((a) => a.key));

  for (const [dimension, key] of Object.entries(GROUPABLE)) {
    test(`${dimension} rides on \`${key}\``, () => {
      expect(spanTags.has(key) || resourceTags.has(key)).toBe(true);
    });
  }

  test('a call carries its model, its activity and the tier that decided it', () => {
    const call = spansOf(request, TIME).find((s) => s.name === 'claude_code.llm_request')!;
    expect(tagOf(call.attributes, GROUPABLE.model)).toBe('claude-opus-5');
    expect(tagOf(call.attributes, 'gen_ai.request.model')).toBe('claude-opus-5');
    expect(tagOf(call.attributes, GROUPABLE.activity)).toBeDefined();
    // The tier is beside the label because a label nobody can trace to a decision is a
    // number that flatters itself.
    expect(tagOf(call.attributes, GROUPABLE.tier)).toBeDefined();
  });

  test('a spawned span carries the agent id that joins this corpus to a live trace', () => {
    const subagent = spansOf(request, TIME).find((s) => s.name === 'cc_miser.subagent')!;
    // The same id `discover.ts` parses out of `agent-a_explore.jsonl` and the same id
    // native puts on every span that agent emits.
    expect(tagOf(subagent.attributes, GROUPABLE.agent)).toBe('a_explore');
    expect(tagOf(subagent.attributes, GROUPABLE.subagentType)).toBe('Explore');
  });

  test('a grandchild names the agent that spawned it, which native leaves to parentage', () => {
    // `parent_agent_id` is documented in native's schema and, as of the 2026-08-29 check,
    // not actually emitted — a live trace leaves subagent lineage to span parentage alone.
    // cc-miser knows it, so it fills the documented key rather than inventing another.
    const deep = spansOf(request, TIME).find(
      (s) => s.name === 'cc_miser.subagent' && tagOf(s.attributes, GROUPABLE.agent) === 'a_deep',
    )!;
    expect(deep).toBeDefined();
    expect(tagOf(deep.attributes, GROUPABLE.parentAgent)).toBe('a_explore');
    expect(tagOf(deep.attributes, GROUPABLE.depth)).toBe('2');
    expect(tagOf(deep.attributes, GROUPABLE.lineage)).toBe('Explore > Plan');
  });

  test('a root span carries no agent id, rather than an invented one', () => {
    const root = spansOf(request, TIME).find((s) => s.name === 'cc_miser.session')!;
    expect(tagOf(root.attributes, GROUPABLE.agent)).toBeUndefined();
    expect(tagOf(root.attributes, GROUPABLE.parentAgent)).toBeUndefined();
  });
});

describe('the numbers in Jaeger are the numbers in the report', () => {
  test("the root span's rollup is the session total `miser list` prints", () => {
    // The ticket's third DONE-WHEN condition, as an equality rather than a comparison by
    // eye. Both sides are the exact rollup; neither is a re-sum of the transcript, which
    // is what makes them agree by construction instead of by luck.
    const root = spansOf(request, TIME).find((s) => s.name === 'cc_miser.session')!;
    expect(tagOf(root.attributes, 'cc_miser.rollup.tok_eq')).toBe(String(listRow(analyzed).tokEq));
  });

  test("a call carries its own exact usage under native's keys", () => {
    const call = spansOf(request, TIME).find(
      (s) => s.name === 'claude_code.llm_request' && tagOf(s.attributes, 'cc_miser.call_first') === '0',
    )!;
    expect(tagOf(call.attributes, 'input_tokens')).toBe('10');
    expect(tagOf(call.attributes, 'cache_creation_tokens')).toBe('2000');
    expect(tagOf(call.attributes, 'output_tokens')).toBe('300');
  });

  test('the rollup on a span covers its whole subtree, which is what Jaeger cannot sum', () => {
    // Jaeger has no group-by-and-sum across spans, so a subtree's cost arrives already
    // summed or it is not available at all.
    const spans = spansOf(request, TIME);
    const root = spans.find((s) => s.name === 'cc_miser.session')!;
    const subagent = spans.find((s) => s.name === 'cc_miser.subagent')!;
    const rootEq = Number(tagOf(root.attributes, 'cc_miser.rollup.tok_eq'));
    const subEq = Number(tagOf(subagent.attributes, 'cc_miser.rollup.tok_eq'));
    expect(subEq).toBeGreaterThan(0);
    expect(subEq).toBeLessThan(rootEq);
  });

  test('an int64 crosses as a string, so nothing is truncated at 2^53', () => {
    // Epoch milliseconds times a million is ~1.8e18 and MAX_SAFE_INTEGER is 9.0e15.
    // Computed as a JS number, every timestamp in the corpus silently loses its low
    // digits. Asserted on the wire value because that is where the loss would show.
    const root = spansOf(request, TIME).find((s) => s.name === 'cc_miser.session')!;
    expect(typeof root.startTimeUnixNano).toBe('string');
    expect(BigInt(root.startTimeUnixNano)).toBe(BigInt(analyzed.tree.tStart) * 1_000_000n);
    for (const a of root.attributes)
      if ('intValue' in a.value) expect(typeof a.value.intValue).toBe('string');
  });
});

describe('ids are derived, so re-exporting a session replaces it instead of duplicating it', () => {
  test('the same session exports to the same ids every time', () => {
    const again = exportSession(sessionOf(analyzed)).request;
    expect(spansOf(again, TIME).map((s) => s.spanId)).toEqual(
      spansOf(request, TIME).map((s) => s.spanId),
    );
  });

  test('two sessions never share a span id, though their span names collide', () => {
    // `turn:0` is the literal span id of the first turn of EVERY root conversation in the
    // corpus — `spans.ts` only prefixes ids inside spawned conversations. An id derived
    // without the session mixed in would give two sessions the same span.
    const other = analyzeSession(
      buildSession({ ...SPEC, sessionId: 'otlp2222-2222-3333-4444-555555555555' }).source,
      buildSession({ ...SPEC, sessionId: 'otlp2222-2222-3333-4444-555555555555' }).read,
    );
    const mine = new Set(spansOf(request, TIME).map((s) => s.spanId));
    const theirs = spansOf(exportSession(sessionOf(other)).request, TIME).map((s) => s.spanId);
    expect(theirs.filter((id) => mine.has(id))).toEqual([]);
  });

  test('ids are the hex OTLP requires, and never the all-zero invalid id', () => {
    for (const s of spansOf(request, TIME)) {
      expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(s.spanId).not.toBe('0'.repeat(16));
    }
  });
});

describe('the stdout rows say where to find each trace', () => {
  const rows = emittedRows;

  test('one row per session and domain, carrying the id that opens the trace', () => {
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.domain)).toEqual([TIME, TOKENS]);
    for (const r of rows) expect(r.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test('every field of a row reaches stdout', () => {
    // The column list is the header line, so a field absent from it silently never
    // appears — and a column that is missing looks exactly like one whose value was
    // always empty.
    expect([...EXPORT_COLUMNS].sort() as string[]).toEqual(Object.keys(rows[0]!).sort());
  });
});

// ─── The invariant both domains rest on ────────────────────────────────────────────

/** Every span sits inside its parent's extent. Returns the ones that escape.
 *
 * Checked on the emitted spans rather than on the layout that produced them: a child that
 * escapes its parent is a malformed tree whatever computed it, and this is the form a
 * viewer actually receives. */
function escapees(spans: ReturnType<typeof spansOf>): string[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  return spans
    .filter((s) => {
      const parent = s.parentSpanId === undefined ? undefined : byId.get(s.parentSpanId);
      return (
        parent !== undefined &&
        (BigInt(s.startTimeUnixNano) < BigInt(parent.startTimeUnixNano) ||
          BigInt(s.endTimeUnixNano) > BigInt(parent.endTimeUnixNano))
      );
    })
    .map((s) => `${s.name} escapes ${byId.get(s.parentSpanId!)!.name}`);
}

describe('a parent covers its children in both domains', () => {
  for (const domain of DOMAINS) {
    test(`${domain.service}: no span escapes its parent`, () => {
      expect(escapees(spansOf(request, domain.service))).toEqual([]);
    });
  }

  test('token width is spend, up to the one-token floor that keeps a span clickable', () => {
    // Width is layout and the `cc_miser.rollup.*` attributes are accounting; they agree
    // to within the floor, which adds at most one token per span. Stated as a bound
    // rather than an equality because claiming equality here would be false the moment a
    // zero-cost tool span appears — and they always do.
    const spans = spansOf(request, TOKENS);
    const root = spans.find((s) => s.name === 'cc_miser.session')!;
    const widthTokens = Number(
      (BigInt(root.endTimeUnixNano) - BigInt(root.startTimeUnixNano)) / 1_000_000n,
    );
    const tokEq = Number(tagOf(root.attributes, 'cc_miser.rollup.tok_eq'));
    expect(widthTokens).toBeGreaterThanOrEqual(tokEq);
    expect(widthTokens - tokEq).toBeLessThanOrEqual(spans.length);
  });

  test('the token domain is anchored at the session, not at the epoch', () => {
    // Anchored at zero the spans are all still there and Jaeger's default time-range
    // search never returns them.
    const root = spansOf(request, TOKENS).find((s) => s.name === 'cc_miser.session')!;
    expect(BigInt(root.startTimeUnixNano)).toBe(BigInt(analyzed.tree.tStart) * 1_000_000n);
  });
});

// ─── Against a real corpus ─────────────────────────────────────────────────────────

const choice = chooseCorpus(process.env);
if (choice.kind === 'skip') console.log(`otlp corpus check SKIPPED: ${choice.why}`);

describe.skipIf(choice.kind === 'skip')('the exporter survives a real corpus', () => {
  const sessions =
    choice.kind === 'scan'
      ? choice.sources
          .map((s) => analyzeSession(s, (p) => readFileSync(p, 'utf8')))
          .map((a) => ({ analyzed: a, session: sessionOf(a) }))
      : [];

  test('every session on disk exports, and no span escapes its parent in either domain', () => {
    // The fixture proves the arithmetic; this proves the shapes hold on topologies no
    // fixture models — a conversation with no turns, a subagent that outlives its tool
    // result, a depth-4 spawn. Each of those broke an assumption here before.
    const broken: string[] = [];
    for (const { analyzed: a, session: s } of sessions) {
      const req = exportSession(s).request;
      for (const domain of DOMAINS) {
        const bad = escapees(spansOf(req, domain.service));
        if (bad.length > 0) broken.push(`${a.source.sessionId} ${domain.service}: ${bad[0]}`);
      }
    }
    expect(sessions.length).toBeGreaterThan(0);
    expect(broken).toEqual([]);
  });

  test('every session agrees with its own list row, across the whole corpus', () => {
    const disagreed = sessions
      .map(({ analyzed: a, session: s }) => {
        const root = spansOf(exportSession(s).request, DOMAINS[0]!.service).find(
          (sp) => sp.name === 'cc_miser.session',
        )!;
        const inJaeger = tagOf(root.attributes, 'cc_miser.rollup.tok_eq');
        const inReport = String(listRow(a).tokEq);
        return inJaeger === inReport ? null : `${a.source.sessionId}: ${inJaeger} vs ${inReport}`;
      })
      .filter((x) => x !== null);
    expect(disagreed).toEqual([]);
  });

  test('span ids stay unique across every session in the corpus at once', () => {
    // They land in one Jaeger, so uniqueness within a session is not the property that
    // matters. `turn:0` is every root conversation's first turn.
    const seen = new Set<string>();
    const collisions: string[] = [];
    for (const { session: s } of sessions)
      for (const span of spansOf(exportSession(s).request, DOMAINS[0]!.service)) {
        if (seen.has(span.spanId)) collisions.push(`${s.session} ${span.name}`);
        seen.add(span.spanId);
      }
    expect(collisions).toEqual([]);
  });
});
