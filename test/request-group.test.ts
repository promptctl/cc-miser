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
import { placeholderTailSession, twoCallSession } from './fixtures.ts';

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

describe('the completed usage reaches the arena', () => {
  test('the assistant-output arrival is sized from the finished figure', () => {
    // The two bugs compound: a partial usage figure would now also under-size the band
    // this call occupies in the context window for the rest of its epoch.
    const conv = convOf(twoCallSession(''));
    const out = conv.arrivals.filter((a) => a.source === 'assistantOutput');
    expect(out.map((a) => a.size.tokens)).toEqual([900, 1400]);
  });
});
