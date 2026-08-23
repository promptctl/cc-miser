// Synthetic transcripts, built to order.
//
// [LAW:effects-at-boundaries] These return TEXT, not paths. `parseTranscript` takes
// text, so a test that uses these touches no filesystem and no corpus — which is what
// lets it assert things the real corpus cannot show, such as how the pipeline behaves
// on a model that keeps its reasoning text.

import type { ModelTable } from '../src/models.ts';

/** A tokenizer table with coefficients chosen rather than fit.
 *
 * For tests whose subject is the SPLIT — how output divides once a tokenizer exists —
 * rather than the fit that produces one. Handing those tests a real corpus fit would
 * couple them to whatever machine they run on, which is the opposite of what a synthetic
 * fixture is for. `heldOutError` is zero because nothing was held out: these coefficients
 * were not measured, and the field says so honestly rather than inventing an error bar.
 * [LAW:behavior-not-structure] */
export const fixtureModels = (
  entries: Record<string, { charsPerToken: number; tokensPerBlock: number }>,
): ModelTable => ({
  tokenizers: new Map(
    Object.entries(entries).map(([model, c]) => [
      model,
      { ...c, points: 0, transcripts: 0, heldOutError: 0 },
    ]),
  ),
  seen: Object.keys(entries).sort(),
});

/** One assistant turn's worth of content, in the shape the builder needs. */
export interface TurnSpec {
  /** The reasoning the model did. The empty string is the STRIPPING regime — what
   * Claude Code writes for every model in the corpus. Non-empty is the RETAINING
   * regime, which no transcript we hold exhibits and which the pipeline must
   * nonetheless handle identically. */
  thinking: string;
  /** What the model said out loud. */
  text: string;
  /** A tool call, or none. `input` is serialized as-is. */
  tool?: { id: string; name: string; input: Record<string, unknown> };
  /** The tool result that came back, if a tool was called. */
  result?: string;
  /** Exact usage as the API would have reported it. */
  usage: { input: number; cacheCreation: number; cacheRead: number; output: number };
}

const line = (o: unknown): string => JSON.stringify(o);

/** Build a transcript from turn specs.
 *
 * [LAW:dataflow-not-control-flow] Regime is not a flag this function branches on — it
 * is the CONTENT of `thinking`, flowing through unchanged. There is one code path here,
 * and the stripping and retaining transcripts differ only in the characters they carry.
 */
export function buildTranscript(
  sessionId: string,
  turns: readonly TurnSpec[],
  /** The model id to write into every assistant line.
   *
   * A parameter rather than a constant because the model id is now load-bearing: it is
   * the key both the tokenizer and the rate card are looked up by, and the only way to
   * test what happens to an unrecognised one is to be able to write one.
   * [LAW:dataflow-not-control-flow] */
  model: string,
): string {
  const out: string[] = [];
  let uuid = 0;
  const next = (): string => `u${String(++uuid).padStart(4, '0')}`;
  const at = (i: number): string => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();

  out.push(
    line({
      type: 'user',
      uuid: next(),
      timestamp: at(0),
      sessionId,
      message: { role: 'user', content: 'do the thing' },
    }),
  );

  turns.forEach((t, i) => {
    const requestId = `req_${i}`;
    // One JSONL line per content block — the fan-out the dedup rule exists for, and the
    // trap PROJECT.md calls out as invalidating naive analysis.
    const blocks: unknown[] = [
      { type: 'thinking', thinking: t.thinking, signature: 'c2ln'.repeat(120) },
      { type: 'text', text: t.text },
      ...(t.tool ? [{ type: 'tool_use', id: t.tool.id, name: t.tool.name, input: t.tool.input }] : []),
    ];
    // `output_tokens` RISES across the group and only the last line carries the finished
    // count, because the writer records a snapshot per block while the response is still
    // streaming. 5,395 of the corpus's 36,426 request groups look like this.
    //
    // The earlier version of this fixture repeated ONE usage object verbatim on every
    // line, on the strength of a claim that the writer always does. It does not — and a
    // fixture built to that claim cannot fail on a reader that takes the first line,
    // which is exactly the reader that shipped and understated the corpus's output by
    // 27.4%. A fixture is a claim about the world; this one is now the claim the
    // measurement supports. [LAW:behavior-not-structure]
    const usageAt = (k: number): unknown => ({
      input_tokens: t.usage.input,
      cache_creation_input_tokens: t.usage.cacheCreation,
      cache_read_input_tokens: t.usage.cacheRead,
      output_tokens: Math.round((t.usage.output * (k + 1)) / blocks.length),
    });
    blocks.forEach((b, k) =>
      out.push(
        line({
          type: 'assistant',
          uuid: next(),
          timestamp: at(i * 2 + 1),
          sessionId,
          requestId,
          message: { role: 'assistant', model, usage: usageAt(k), content: [b] },
        }),
      ),
    );

    if (t.tool && t.result !== undefined)
      out.push(
        line({
          type: 'user',
          uuid: next(),
          timestamp: at(i * 2 + 2),
          sessionId,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: t.tool.id, content: t.result }],
          },
        }),
      );
  });

  return out.join('\n') + '\n';
}

/** The reasoning a retaining model would have left behind. Long enough that omitting it
 * changes every character count in the transcript, which is the whole point. */
export const REASONING = `Let me work through this carefully before touching anything.
The user asked for the file to be read, so the first move is to establish what is
actually in it rather than assume. I should check the imports at the top, then the
exported surface, then whether anything downstream depends on the shape I am about to
change. If the type is under-constrained I will fix the type rather than guard at the
call site, because a guard there would only move the question one frame up the stack
and leave the illegal state representable.`.repeat(4);

/** A request group whose SECOND line carries an all-zero usage block beside a real one.
 *
 * Three groups in the corpus have this shape — every field zero, with `service_tier` and
 * `iterations` null, which is a placeholder the writer emitted rather than anything the
 * API measured. It is the one case that separates "take the last line" from "take the
 * completed one": a last-wins reader adopts the zeros and silently discards a real
 * call's entire cost. */
export const placeholderTailSession = (): string =>
  [
    line({
      type: 'user',
      uuid: 'p0001',
      timestamp: '2026-01-01T00:00:00.000Z',
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      message: { role: 'user', content: 'do the thing' },
    }),
    line({
      type: 'assistant',
      uuid: 'p0002',
      timestamp: '2026-01-01T00:01:00.000Z',
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      requestId: 'req_placeholder',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 9745,
          cache_read_input_tokens: 86159,
          output_tokens: 278,
          service_tier: 'standard',
        },
        content: [{ type: 'thinking', thinking: '', signature: 'c2ln'.repeat(30) }],
      },
    }),
    line({
      type: 'assistant',
      uuid: 'p0003',
      timestamp: '2026-01-01T00:01:01.000Z',
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      requestId: 'req_placeholder',
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
          service_tier: null,
          iterations: null,
        },
        content: [{ type: 'text', text: 'Done.' }],
      },
    }),
  ].join('\n') + '\n';

/** Two calls, one with reasoning and a tool call, one with reasoning and only text.
 * `thinking` is threaded in so the same session can be built under either regime, and
 * `model` so the same session can be built on a model the report has never heard of. */
export const twoCallSession = (thinking: string, model = 'claude-opus-5'): string =>
  buildTranscript(
    '11111111-2222-3333-4444-555555555555',
    [
    {
      thinking,
      text: 'Reading the file first.',
      tool: { id: 'toolu_01', name: 'Read', input: { file_path: '/src/calls.ts' } },
      result: 'export interface Arrival { size: Size }\n'.repeat(40),
      usage: { input: 12, cacheCreation: 4200, cacheRead: 0, output: 900 },
    },
      {
        thinking,
        text: 'The seam is the type, so the fix goes in the signature.',
        usage: { input: 3, cacheCreation: 610, cacheRead: 4200, output: 1400 },
      },
    ],
    model,
  );
