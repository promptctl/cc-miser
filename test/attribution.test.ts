// Attribution beneath a call: causes as priced children, and an unattributed remainder
// that never adjusts to hide the gap.
//
// Two layers, same shape as `output.ts`'s split gets in `model-table.test.ts`: hand-built
// `Conversation`s with numbers chosen so every bucket can be checked by arithmetic, then
// one pass through the real pipeline to prove the bucketing survives actual transcript
// parsing — tool names read off `conv.tools`, attachment types read off real JSONL,
// character counts nobody hand-picked.

import { describe, expect, test } from 'bun:test';
import { attributeConversation } from '../src/attribution.ts';
import type { Arrival, Call, Conversation, ToolExec } from '../src/calls.ts';
import { analyzeSession } from '../src/session.ts';
import { estimatedSize, exactSize, WRITE_MULTIPLE, ZERO_USAGE, type Usage } from '../src/tokens.ts';
import type { SessionSource } from '../src/discover.ts';
import { assistantTurn, buildTranscript, userSays, FOREIGN_CWD } from './fixtures.ts';

const mkCall = (index: number, usage: Usage): Call => ({
  index,
  requestId: `req_${index}`,
  lineCount: 1,
  ts: index,
  model: 'claude-opus-5',
  usage,
  lastLineUsage: usage,
  outputVaries: false,
  cacheCreation: { kind: 'flat-only' },
  blocks: [],
});

const conv = (calls: Call[], arrivals: Arrival[], tools: ToolExec[] = []): Conversation => ({
  calls,
  arrivals,
  tools,
  turns: [],
  unmatchedToolResults: 0,
  duplicateToolResults: 0,
  duplicateToolUses: 0,
});

// ---------------------------------------------------------------------------------

describe('attributeConversation — hand-built numbers', () => {
  test('buckets by source and label, merges same-tool results, prices every bucket as a fresh write', () => {
    const calls = [
      mkCall(0, { input: 5, cacheCreation: 1000, cacheRead: 0, output: 800 }),
      mkCall(1, { input: 5, cacheCreation: 300, cacheRead: 1000, output: 200 }),
    ];
    const arrivals: Arrival[] = [
      { bornBeforeCall: 0, source: 'userText', label: 'do the thing', size: estimatedSize(40), toolUseId: '' },
      { bornBeforeCall: 1, source: 'toolResult', label: 'Read /a', size: estimatedSize(80), toolUseId: 't1' },
      { bornBeforeCall: 1, source: 'toolResult', label: 'Read /b', size: estimatedSize(40), toolUseId: 't2' },
      { bornBeforeCall: 1, source: 'attachment', label: 'task_reminder', size: estimatedSize(120), toolUseId: '' },
      {
        bornBeforeCall: 1,
        source: 'assistantOutput',
        label: 'assistant output of call 0',
        size: exactSize(800),
        toolUseId: '',
      },
    ];
    const tools: ToolExec[] = [
      { toolUseId: 't1', name: 'Read', summary: '', callIndex: 0, tsStart: 0, tsEnd: 0, resultChars: 80 },
      { toolUseId: 't2', name: 'Read', summary: '', callIndex: 0, tsStart: 0, tsEnd: 0, resultChars: 40 },
    ];
    const [call0, call1] = attributeConversation(conv(calls, arrivals, tools));

    // call 0: one cause (the opening user text), reconciled against input + cacheCreation
    // at write price. estimateTokens(40) = 10, so the bucket costs 10 * 1.25.
    expect(call0!.causes).toEqual([
      {
        source: 'userText',
        label: 'user text',
        arrivals: 1,
        estTokens: 10,
        cost: 12.5,
        basis: 'estimated-from-chars',
      },
    ]);
    expect(call0!.exactCost).toBe(5 + 1000 * WRITE_MULTIPLE); // 1255
    expect(call0!.causedCost).toBe(12.5);
    expect(call0!.unattributed).toBe(call0!.exactCost - 12.5);

    // call 1: two Read results (estimateTokens(80)=20, estimateTokens(40)=10) collapse
    // into ONE bucket keyed by tool name, not by toolUseId or the two distinct labels the
    // arrivals themselves carry.
    expect(call1!.causes).toHaveLength(3);
    const byLabel = Object.fromEntries(call1!.causes.map((c) => [c.label, c]));
    expect(byLabel['Read']).toEqual({
      source: 'toolResult',
      label: 'Read',
      arrivals: 2,
      estTokens: 30,
      cost: 37.5,
      basis: 'estimated-from-chars',
    });
    expect(byLabel['task_reminder']).toEqual({
      source: 'attachment',
      label: 'task_reminder',
      arrivals: 1,
      estTokens: 30,
      cost: 37.5,
      basis: 'estimated-from-chars',
    });
    // Prior output carries an EXACT size (call 0's own billed output_tokens), not an
    // estimate — the one bucket in this fixture with no chars/4 involved at all, and the
    // one bucket whose `basis` differs from every other source.
    expect(byLabel['prior output']).toEqual({
      source: 'assistantOutput',
      label: 'prior output',
      arrivals: 1,
      estTokens: 800,
      cost: 1000,
      basis: 'exact-api-usage',
    });

    // call 1's exact cost (5 + 300*1.25 = 380) is far smaller than what its causes claim
    // (37.5 + 37.5 + 1000 = 1075) — an epoch that just paid to rewrite a large prior output
    // is exactly the shape where causes overshoot. The remainder is negative and NOT
    // clamped, the same honesty rule `output.ts`'s `Remainder` follows.
    expect(call1!.causedCost).toBe(1075);
    expect(call1!.exactCost).toBe(380);
    expect(call1!.unattributed).toBe(-695);
    expect(call1!.causedCost + call1!.unattributed).toBe(call1!.exactCost);
  });

  test('a tool result whose tool_use was never seen buckets as "unknown tool" rather than throwing', () => {
    const a = attributeConversation(
      conv(
        [mkCall(0, ZERO_USAGE)],
        [{ bornBeforeCall: 0, source: 'toolResult', label: '?', size: estimatedSize(40), toolUseId: 'ghost' }],
      ),
    )[0]!;
    expect(a.causes).toEqual([
      {
        source: 'toolResult',
        label: 'unknown tool',
        arrivals: 1,
        estTokens: 10,
        cost: 12.5,
        basis: 'estimated-from-chars',
      },
    ]);
  });

  test('a call with nothing born at it has an empty cause list and remainder equal to its whole exact cost', () => {
    const a = attributeConversation(conv([mkCall(0, { input: 5, cacheCreation: 100, cacheRead: 0, output: 50 })], []))[0]!;
    expect(a.causes).toEqual([]);
    expect(a.causedCost).toBe(0);
    expect(a.exactCost).toBe(5 + 100 * WRITE_MULTIPLE);
    expect(a.unattributed).toBe(a.exactCost);
  });

  test('cache_read plays no part in exactCost — a call resuming a huge surviving prefix owes nothing to its causes', () => {
    // If cacheRead leaked into exactCost, a warm-resuming call with tiny new content would
    // report a huge unattributed remainder for a prefix some EARLIER call already wrote
    // and was charged for. It must not: that prefix is a different call's arrival.
    const a = attributeConversation(
      conv([mkCall(0, { input: 5, cacheCreation: 50, cacheRead: 900_000, output: 10 })], []),
    )[0]!;
    expect(a.exactCost).toBe(5 + 50 * WRITE_MULTIPLE);
  });
});

// ---------------------------------------------------------------------------------

describe('attributeConversation — wired into a real parsed conversation', () => {
  test('tool names come from conv.tools, attachment types from real JSONL, and every call closes exactly', () => {
    const source: SessionSource = {
      project: 'proj',
      sessionId: 'sid',
      path: '/corpus/proj/sid.jsonl',
      bytes: 0,
      mtime: 0,
      subagents: [],
      unpaired: [],
    };
    const transcript = buildTranscript({
      sessionId: 'sid',
      model: 'claude-opus-5',
      cwd: FOREIGN_CWD,
      startMinute: 0,
      events: [
        userSays('investigate the bug'),
        assistantTurn({
          thinking: '',
          text: 'looking',
          tools: [
            { id: 'toolu_1', name: 'Read', input: { file_path: '/a' }, result: 'A'.repeat(80) },
            { id: 'toolu_2', name: 'Read', input: { file_path: '/b' }, result: 'B'.repeat(40) },
            { id: 'toolu_3', name: 'Grep', input: { pattern: 'x' }, result: 'no matches' },
          ],
          attachments: [{ type: 'task_reminder', content: 'finish the thing' }],
          usage: { input: 5, cacheCreation: 1000, cacheRead: 0, output: 400 },
        }),
        assistantTurn({
          thinking: '',
          text: 'done',
          tools: [],
          attachments: [],
          usage: { input: 5, cacheCreation: 300, cacheRead: 1000, output: 100 },
        }),
      ],
    });
    const s = analyzeSession(source, (p) => {
      if (p !== source.path) throw new Error(`fixture has no file at ${p}`);
      return transcript;
    });

    const attributions = attributeConversation(s.conversation);
    expect(attributions).toHaveLength(2);

    const call1 = attributions[1]!;
    const bySource = Object.fromEntries(call1.causes.map((c) => [`${c.source}:${c.label}`, c]));
    expect(bySource['toolResult:Read']!.arrivals).toBe(2); // two distinct tool_use ids, one tool name
    expect(bySource['toolResult:Grep']!.arrivals).toBe(1);
    expect(bySource['attachment:task_reminder']!.arrivals).toBe(1);
    expect(bySource['assistantOutput:prior output']!.estTokens).toBe(400); // exact, call 0's billed output
    expect(bySource['assistantOutput:prior output']!.basis).toBe('exact-api-usage');
    expect(bySource['toolResult:Read']!.basis).toBe('estimated-from-chars');
    expect(bySource['attachment:task_reminder']!.basis).toBe('estimated-from-chars');

    for (const a of attributions) expect(a.causedCost + a.unattributed).toBeCloseTo(a.exactCost, 9);
  });
});
