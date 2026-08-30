// Re-exporting a session that GREW must supersede the previous export, not join it.
//
// WHY THIS IS A TEST OF START TIMES, WHICH IS NOT WHERE ANYONE WOULD LOOK. The fix for
// miser-tracing-yhc.5 is a storage backend that replaces a re-sent span instead of
// appending it, and `telemetry/stack.sh` runs badger for exactly that. But badger keys a
// span on (traceId, startTime, spanId) — measured on 2026-08-30 by posting one span twice
// under each store, where re-sending with an identical start time replaced and re-sending
// with a shifted one appended, exactly as `memory` had. So the start time is not a
// rendering detail here; it is HALF THE PRIMARY KEY, and the exporter is the only thing
// that decides it.
//
// That leaves the guarantee split across two files with nothing joining them.
// `jaeger.ts` derives and documents the ids, and is careful about it. The start times are
// computed a whole module away in `cli/otlp.ts`'s layouts, where nothing says they are
// load-bearing — and the token layout in particular lays children end to end, so a width
// that changes anywhere moves every span after it. A layout change that looked purely
// cosmetic would silently restore the duplicate-span bug, and restore it in the failure
// mode this project keeps getting bitten by: a well-formed trace holding two versions of
// one session, with nothing raising an error. [LAW:one-source-of-truth]
//
// So the assertion below is the CROSSING, in the same spirit as `jaeger-links.test.ts`:
// not that the ids are stable and not that the layout is correct, but that a span present
// in both exports arrives at the same storage key both times.
//
// [LAW:behavior-not-structure] It reads the emitted request documents only. Any layout
// that leaves a pre-existing span where it was passes, however it computes it.

import { describe, expect, test } from 'bun:test';
import { exportSession, type OtlpTraces } from '../src/cli/otlp.ts';
import { traceFile } from '../src/cli/trace.ts';
import { DOMAIN_KEYS, DOMAINS } from '../src/jaeger.ts';
import { analyzeSession } from '../src/session.ts';
import {
  assistantTurn,
  buildSession,
  userSays,
  type ConversationEvent,
  type SessionSpec,
} from './fixtures.ts';

/** A transcript still being written, at two moments.
 *
 * GROWTH HAS THREE SHAPES AND ALL THREE ARE HERE, because they stress different things.
 * Appending a NEW turn adds spans the first export never had. Adding a tool to the turn
 * that was already last changes the CONTENT of spans the first export did have — their
 * rollups, their widths — while leaving their ids alone, which is where an appending
 * store leaves two versions of one span and the reader cannot tell which is current.
 *
 * And the third, which is the one a fixture will not think of and a real session
 * produces every time: a transcript cut BETWEEN a tool_use and its tool_result. That tool
 * is in flight at the first export and finished at the second, so the span exists in both
 * — same id — while gaining a duration and a summary. An earlier version of this file
 * modelled only the first two shapes, passed, and was proved incomplete by exporting a
 * real growing session, where exactly one such tool left a stale span behind. The
 * transcript is the shape the fixture has to have. */
const OPENING: readonly ConversationEvent[] = [
  userSays('trace how a session id reaches the exporter'),
  assistantTurn({
    thinking: '',
    text: 'Looking for the derivation.',
    tools: [{ id: 'toolu_a', name: 'Grep', input: { pattern: 'traceIdOf' }, result: 'src/jaeger.ts\n' }],
    attachments: [],
    usage: { input: 20, cacheCreation: 3_000, cacheRead: 0, output: 260 },
  }),
];

/** The last turn as the first export saw it: its `Read` had been issued and had not
 * come back. */
const TOOL_STILL_RUNNING = assistantTurn({
  thinking: '',
  text: 'Reading it.',
  tools: [{ id: 'toolu_b', name: 'Read', input: { file_path: 'src/jaeger.ts' }, result: null }],
  attachments: [],
  usage: { input: 15, cacheCreation: 900, cacheRead: 3_000, output: 180 },
});

/** The same turn once the result landed, and once the model asked for a second file. */
const TOOL_CAME_BACK = assistantTurn({
  thinking: '',
  text: 'Reading it.',
  tools: [
    { id: 'toolu_b', name: 'Read', input: { file_path: 'src/jaeger.ts' }, result: 'x\n'.repeat(200) },
    { id: 'toolu_c', name: 'Read', input: { file_path: 'src/cli/otlp.ts' }, result: 'y\n'.repeat(300) },
  ],
  attachments: [],
  usage: { input: 15, cacheCreation: 900, cacheRead: 3_000, output: 180 },
});

const AT_FIRST_EXPORT: SessionSpec = {
  sessionId: 'grw11111-2222-3333-4444-555555555555',
  project: '-home-jdoe-src-alpha',
  cwd: '/home/jdoe/src/alpha',
  model: 'claude-opus-5',
  root: [...OPENING, TOOL_STILL_RUNNING],
  spawns: [],
};

const AFTER_IT_GREW: SessionSpec = {
  ...AT_FIRST_EXPORT,
  root: [
    ...OPENING,
    TOOL_CAME_BACK,
    // And a turn the first export had never seen.
    userSays('now check the exporter agrees'),
    assistantTurn({
      thinking: '',
      text: 'It does.',
      tools: [],
      attachments: [],
      usage: { input: 40, cacheCreation: 1_200, cacheRead: 3_900, output: 220 },
    }),
  ],
};

/** What a collector receives for one session, at one moment in that session's life. */
function exportOf(spec: SessionSpec): OtlpTraces {
  const built = buildSession(spec);
  const analyzed = analyzeSession(built.source, built.read);
  return exportSession(traceFile([analyzed], '/corpus', [], 1_700_000_000_000).sessions[0]!).request;
}

/** The storage key of every span one export sends, in one domain — spelled the way the
 * store spells it, so what this test compares is what the store compares. */
function keysIn(req: OtlpTraces, service: string): Map<string, { traceId: string; startTimeUnixNano: string }> {
  return new Map(
    req.resourceSpans
      .filter((rs) =>
        rs.resource.attributes.some(
          (a) => a.key === 'service.name' && 'stringValue' in a.value && a.value.stringValue === service,
        ),
      )
      .flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans))
      .map((s) => [s.spanId, { traceId: s.traceId, startTimeUnixNano: s.startTimeUnixNano }]),
  );
}

const before = exportOf(AT_FIRST_EXPORT);
const after = exportOf(AFTER_IT_GREW);

describe('a session that grew re-exports onto its previous export', () => {
  for (const domain of DOMAIN_KEYS) {
    const service = DOMAINS[domain].service;
    const wasSent = keysIn(before, service);
    const isSentNow = keysIn(after, service);
    const shared = [...wasSent.keys()].filter((id) => isSentNow.has(id));

    describe(service, () => {
      // THE VACUITY GUARD, first, because every assertion below is a statement about the
      // spans the two exports share — and all of them are trivially true of a fixture
      // that did not actually grow, or that grew into a disjoint set of spans.
      test('the fixture really grew, and the two exports really overlap', () => {
        expect(isSentNow.size).toBeGreaterThan(wasSent.size);
        expect(shared.length).toBe(wasSent.size);
      });

      test('every span the first export sent keeps its trace', () => {
        for (const id of shared) expect(isSentNow.get(id)!.traceId).toBe(wasSent.get(id)!.traceId);
      });

      // THE ASSERTION THIS FILE EXISTS FOR. A span in both exports must land on the same
      // key both times, or the store keeps both copies and the trace holds two versions
      // of one session — two root spans, a doubled span count, and a total that is wrong
      // in a way nothing reports.
      test('every span the first export sent keeps its start time', () => {
        const moved = shared.filter(
          (id) => isSentNow.get(id)!.startTimeUnixNano !== wasSent.get(id)!.startTimeUnixNano,
        );
        expect(
          moved.map((id) => `${id}: ${wasSent.get(id)!.startTimeUnixNano} → ${isSentNow.get(id)!.startTimeUnixNano}`),
        ).toEqual([]);
      });

      // The root is called out on its own because it is the span whose duplication is
      // visible: `verify:otlp` reports the failure as "2 roots", and a reader sees the
      // session twice in the waterfall.
      test('the root span is superseded rather than joined by a second one', () => {
        const rootsOf = (req: OtlpTraces): string[] =>
          req.resourceSpans
            .filter((rs) =>
              rs.resource.attributes.some(
                (a) => a.key === 'service.name' && 'stringValue' in a.value && a.value.stringValue === service,
              ),
            )
            .flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans))
            .filter((s) => s.parentSpanId === undefined)
            .map((s) => s.spanId);

        expect(rootsOf(before)).toHaveLength(1);
        expect(rootsOf(after)).toEqual(rootsOf(before));
        const root = rootsOf(before)[0]!;
        expect(isSentNow.get(root)!.startTimeUnixNano).toBe(wasSent.get(root)!.startTimeUnixNano);
      });
    });
  }
});
