// What a request GROUP reduces to: one call, all of its blocks, and the usage the API
// finished with.
//
// The rule these assert is the one src/calls.ts got wrong for the whole life of the
// project. `output_tokens` is a partial count that rises as a response streams, and the
// reader took the first line it saw — understating the corpus's output by 9,105,348
// tokens, 27.4% of everything ever billed, with no error and no warning. The figure is
// load-bearing twice over: it prices output directly, and since miser-report-z52.3 it
// also sizes the assistant-output arrival in the residency arena.
//
// [LAW:behavior-not-structure] These assert the contract — one call, every block, the
// completed usage — not how the fold is written. Any reader that recovers the finished
// figure passes; first-wins and last-wins each fail a case below, which is the point.

import { expect, test, describe } from 'bun:test';
import { buildConversation } from '../src/calls.ts';
import { parseTranscript } from '../src/records.ts';
import { resolveForest } from '../src/forest.ts';
import { analyzeSession } from '../src/session.ts';
import type { Span } from '../src/spans.ts';
import {
  duplicateToolResultSession,
  duplicateToolUseSession,
  placeholderTailSession,
  twoCallSession,
} from './fixtures.ts';

const convOf = (text: string) => buildConversation(parseTranscript(text).lines);

describe('a request group becomes one call', () => {
  const conv = convOf(twoCallSession(''));

  test('lines sharing a requestId collapse to a single call', () => {
    expect(conv.calls.length).toBe(2);
    // Three lines for the tool-calling turn, two for the text-only one. The fan-out is
    // recorded rather than inferred, so the dedup factor stays checkable.
    expect(conv.calls.map((c) => c.lineCount)).toEqual([3, 2]);
  });

  test('blocks are the UNION over the group, not the first line', () => {
    // Keeping one line per call is what drops most of a session's tool calls.
    expect(conv.calls[0]!.blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'tool_use']);
  });
});

describe('usage is the completed snapshot, not the first', () => {
  test('output_tokens is the finished count even though earlier lines are partial', () => {
    const conv = convOf(twoCallSession(''));
    // The fixture streams 300/600/900 and 700/1400. A first-wins reader returns
    // [300, 700] here, which is precisely the shipped bug.
    expect(conv.calls.map((c) => c.usage.output)).toEqual([900, 1400]);
  });

  test('the other usage fields survive the fold unchanged', () => {
    // Only output_tokens streams. If the fold ever started assembling a vector
    // field-by-field, it could report a usage no line ever carried.
    const conv = convOf(twoCallSession(''));
    expect(conv.calls.map((c) => c.usage)).toEqual([
      { input: 12, cacheCreation: 4200, cacheRead: 0, output: 900 },
      { input: 3, cacheCreation: 610, cacheRead: 4200, output: 1400 },
    ]);
  });

  test('an all-zero placeholder line never wins the group', () => {
    // The case that rules out "take the last line". Adopting the zeros would erase a
    // call that genuinely cost 86,159 cache-read tokens.
    const conv = convOf(placeholderTailSession());
    expect(conv.calls.length).toBe(1);
    expect(conv.calls[0]!.usage).toEqual({
      input: 2,
      cacheCreation: 9745,
      cacheRead: 86159,
      output: 278,
    });
  });
});

// A tool_use is joined to at most ONE result, so a transcript offering two leaves one of
// them out of every downstream figure. That the leftover is COUNTED is the whole reason
// the counter exists, and a counter nothing exercises is a comment with a number in it —
// the corpus has zero instances, so nothing else in the suite would notice it break.
describe('a second result for one tool_use is counted, not swallowed', () => {
  const conv = convOf(duplicateToolResultSession());

  test('the extra result is reported', () => {
    expect(conv.duplicateToolResults).toBe(1);
  });

  test('the surviving execution carries the LAST result', () => {
    // Last-wins is what the join's overwrite means, and it is the half a future
    // reordering would break while leaving the count above still correct.
    expect(conv.tools.length).toBe(1);
    expect(conv.tools[0]!.resultChars).toBe('second-and-longer'.length);
  });
});

// The two counters must PARTITION the anomalies rather than overlap, and only an id with
// no tool_use can tell the difference: a repeated result for a matched id is a duplicate
// under either rule. Two results for an id nothing requested are two unmatched records
// and nothing else — counting one of them as a duplicate as well would report two bad
// records as three, in the note whose job is saying how much was lost.
describe('a repeated result for an id nothing requested is only unmatched', () => {
  const conv = convOf(duplicateToolResultSession('toolu_never_issued'));

  test('both results count as unmatched', () => {
    expect(conv.unmatchedToolResults).toBe(2);
  });

  test('neither is also counted as a duplicate', () => {
    expect(conv.duplicateToolResults).toBe(0);
  });

  test('the tool that WAS requested is still carried, unanswered', () => {
    expect(conv.tools.length).toBe(1);
    expect(conv.tools[0]!.tsEnd).toBeNull();
    expect(conv.tools[0]!.resultChars).toBeNull();
  });
});

// The request-side twin, and the one with teeth: tool spans are built from these entries,
// so a tool_use whose id was already taken is a tool that never appears in the tree at
// all. The count is the only trace it leaves, which makes the count worth asserting.
describe('a second tool_use under one id is counted, and costs the first its entry', () => {
  const conv = convOf(duplicateToolUseSession());

  /** The same fixture as a span tree. Shared so the two tree assertions below cannot
   * drift onto different sessions. [LAW:one-source-of-truth] */
  const treeOf = (): Span =>
    analyzeSession(
      {
        project: 'proj',
        sessionId: 'aaaaaaaa-bbbb-cccc-dddd-999999999999',
        path: '/corpus/proj/dup.jsonl',
        bytes: 0,
        mtime: 0,
        subagents: [],
        unpaired: [],
      },
      () => duplicateToolUseSession(),
    ).tree;

  /** The tool spans hanging off one call, in the order the tree presents them. */
  const toolNamesUnderCall = (tree: Span, call: number): string[] =>
    [...descend(tree)]
      .filter((s) => s.detail.kind === 'call')
      [call]!.children.flatMap((c) => (c.detail.kind === 'tool' ? [c.detail.name] : []));

  test('the collision is reported', () => {
    expect(conv.duplicateToolUses).toBe(1);
  });

  test('only the later request survives the join', () => {
    // Two calls asked under one id; one entry remains for it, carrying the SECOND
    // request's data. Naming the tool is what distinguishes "the later one won" from
    // "one of them won". The sibling the second call also asked for is untouched.
    expect(conv.calls.length).toBe(2);
    const collided = conv.tools.filter((t) => t.toolUseId === 'toolu_same');
    expect(collided.length).toBe(1);
    expect(collided[0]!.name).toBe('Read');
    expect(collided[0]!.callIndex).toBe(1);
  });

  test('the earlier request produces no tool span at all', () => {
    // The consequence the counter exists to make visible, asserted on the tree rather
    // than argued for in a comment: call 0 asked for a tool and has no tool child.
    const tree = treeOf();
    expect([...descend(tree)].filter((s) => s.detail.kind === 'call').length).toBe(2);
    expect(toolNamesUnderCall(tree, 0)).toEqual([]);
  });

  test("the survivor is placed by when it was requested, not by its id's old slot", () => {
    // THE VACUITY GUARD. `toolUses` is a Map and `set` on an existing key updates the
    // value in place without moving it, so the colliding id keeps its FIRST-seen
    // position and the raw join order is genuinely backwards here. If this stops being
    // true the assertion below still passes while testing nothing.
    expect(conv.tools.map((t) => t.name)).toEqual(['Read', 'Bash']);

    // The behaviour: call 1 asked for Bash at 00:02 and Read at 00:03, so the tree owes
    // a reader those two in that order regardless of where the map happened to keep them.
    expect(toolNamesUnderCall(treeOf(), 1)).toEqual(['Bash', 'Read']);
  });
});

/** Every span in the tree, parents before children. */
function* descend(s: Span): Generator<Span> {
  yield s;
  for (const kid of s.children) yield* descend(kid);
}

// WHICH CALL A SUBAGENT IS ATTRIBUTED TO WHEN ITS SPAWNING ID COLLIDES, asserted rather
// than reasoned about, because the reasoning is the kind that is easy to get backwards.
//
// A review raised the worry that `spans.ts` grafting kids by tool_use id could reattach a
// subagent to a call that did not spawn it, on the grounds that `forest.ts` decides
// lineage independently of the tool join. It does not decide it independently: `owner` is
// built by walking raw `call.blocks` and overwriting per id, exactly as the tool join
// does, over the same records in the same order. So both collapse to the LATER call and
// agree, which is what this test pins — if they ever stop agreeing, a subagent's whole
// rollup lands under a tool span that is not where it was grafted.
describe('a colliding spawn id resolves to the same call the tool join kept', () => {
  const conv = convOf(duplicateToolUseSession());
  const kid = buildConversation(parseTranscript(twoCallSession('')).lines);
  const forest = resolveForest(conv, [
    {
      meta: {
        agentId: 'a_kid',
        agentType: 'general-purpose',
        description: 'spawned by the colliding id',
        toolUseId: 'toolu_same',
        declaredDepth: 1,
      },
      conversation: kid,
    },
  ]);

  test('the spawn is placed, not orphaned', () => {
    expect(forest.placed.length).toBe(1);
    expect(forest.orphans.length).toBe(0);
  });

  test('it is attributed to the later call — the one whose ToolExec survived', () => {
    expect(forest.placed[0]!.lineage.at(-1)!.spawnedAtCall).toBe(1);
    expect(conv.tools[0]!.callIndex).toBe(1);
  });
});

describe('the completed usage reaches the arena', () => {
  test('the assistant-output arrival is sized from the finished figure', () => {
    // The two bugs compound: a partial usage figure would now also under-size the band
    // this call occupies in the context window for the rest of its epoch.
    const conv = convOf(twoCallSession(''));
    const out = conv.arrivals.filter((a) => a.source === 'assistantOutput');
    expect(out.map((a) => a.size.tokens)).toEqual([900, 1400]);
  });
});
