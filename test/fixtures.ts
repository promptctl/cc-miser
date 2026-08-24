// Synthetic transcripts, built to order.
//
// [LAW:effects-at-boundaries] These return TEXT, not paths. `parseTranscript` takes
// text, so a test that uses these touches no filesystem and no corpus — which is what
// lets it assert things the real corpus cannot show, such as how the pipeline behaves
// on a model that keeps its reasoning text.

import type { SessionSource } from '../src/discover.ts';
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

/** One tool call inside an assistant turn, together with what came back.
 *
 * [LAW:one-source-of-truth] The result travels WITH the call that asked for it rather
 * than in a parallel array indexed alongside it. Pairing is then structural, and a
 * fixture cannot declare three tools and two results.
 */
export interface ToolCallSpec {
  id: string;
  name: string;
  /** Serialized as-is into the `tool_use` block. */
  input: Record<string, unknown>;
  /** The `tool_result` that answered it. `null` is a call whose result never arrived —
   * an interrupt, or an agent still running when the transcript was written. */
  result: string | null;
}

/** A record the harness injected into the transcript on its own initiative: a task
 * reminder, a hook's additional context, a skill listing. It occupies context but no
 * model produced it and no tool was called for it. */
export interface AttachmentSpec {
  type: string;
  content: string;
}

/** One assistant turn's worth of content, in the shape the builder needs.
 *
 * Every field is required, including the empty cases. An optional `tools?` lets a
 * fixture omit a dimension it meant to exercise and still typecheck, which is how a
 * suite comes to claim coverage of a shape it never built. [LAW:types-are-the-program]
 */
export interface TurnSpec {
  /** The reasoning the model did. The empty string is the STRIPPING regime — what
   * Claude Code writes for every model in the corpus. Non-empty is the RETAINING
   * regime, which no transcript we hold exhibits and which the pipeline must
   * nonetheless handle identically. */
  thinking: string;
  /** What the model said out loud. */
  text: string;
  /** Every tool this call asked for. A call carrying several is the ordinary shape —
   * parallel tool calls are what the harness asks for and what the corpus shows — so
   * the singular field this replaces was a fixture that could not model its subject. */
  tools: readonly ToolCallSpec[];
  /** Attachments the harness injected after this turn, i.e. before the next call. */
  attachments: readonly AttachmentSpec[];
  /** Exact usage as the API would have reported it. */
  usage: { input: number; cacheCreation: number; cacheRead: number; output: number };
}

/** One thing that happens in a conversation, in transcript order.
 *
 * [LAW:types-are-the-program] A transcript IS an ordered stream of lines. Modelling it
 * as "an opening prompt, then a list of assistant turns" was a weaker theorem than the
 * truth, and the gap was not cosmetic: it could express neither a user line arriving
 * BETWEEN calls — which leaves the calls before it in no turn at all — nor a
 * conversation carrying user lines and no calls. Both shapes are in the corpus, and
 * between them they hid 31 calls of one subagent and an entire 40-call conversation
 * from the span tree. A fixture that cannot build the shape cannot catch the bug. */
export type ConversationEvent =
  /** A user-channel line: what a person typed, or the prompt a spawner handed an agent.
   * The transcript line is the same kind either way, which is why one builder serves a
   * root session and a spawned one. [LAW:one-type-per-behavior] */
  | { kind: 'user'; text: string }
  /** One assistant response, its tool calls, their results, and anything the harness
   * injected after it. */
  | { kind: 'turn'; turn: TurnSpec };

/** The ordinary opening: a person asks for something. */
export const userSays = (text: string): ConversationEvent => ({ kind: 'user', text });

/** An assistant response. */
export const assistantTurn = (turn: TurnSpec): ConversationEvent => ({ kind: 'turn', turn });

const line = (o: unknown): string => JSON.stringify(o);

/** A working directory on a machine nobody here has ever used: a Linux home layout
 * rather than a macOS one, an OS user who is not this repo's author, and a leaf name
 * containing the `-` that makes a flattened slug ambiguous.
 *
 * Claude Code files this session under `-home-jdoe-src-my-project`, from which
 * `my-project` cannot be recovered — the same slug is what `src/my/project` would have
 * produced. That ambiguity is the reason the pipeline reads `cwd`, so the fixture is
 * built to exhibit it rather than to avoid it. */
export const FOREIGN_CWD = '/home/jdoe/src/my-project';

/** The directory name Claude Code derives from `FOREIGN_CWD`, transcribed from the
 * observed flattening rule rather than recomputed here — a test that reimplemented the
 * transform would be asserting against its own copy of it. */
export const FOREIGN_SLUG = '-home-jdoe-src-my-project';

/** Everything one conversation's transcript is built from.
 *
 * An object rather than a run of positional parameters because `sessionId`, `prompt`,
 * `model` and `cwd` are all strings: positionally, any two of them can be swapped and
 * the fixture still compiles while modelling something else entirely.
 * [LAW:types-are-the-program] */
export interface TranscriptSpec {
  sessionId: string;
  /** The model id to write into every assistant line.
   *
   * A parameter rather than a constant because the model id is load-bearing: it is the
   * key both the tokenizer and the rate card are looked up by, and the only way to test
   * what happens to an unrecognised one is to be able to write one. */
  model: string;
  /** The `cwd` every line carries. Required rather than defaulted, because every
   * transcript in the observed corpus carries one on every non-bookkeeping line — a
   * fixture allowed to omit it would model a shape the format does not produce. */
  cwd: string;
  /** Minutes from the fixture epoch to this conversation's first line.
   *
   * Required, and load-bearing as soon as a session spawns anything: a slash-command
   * fork carries no `tool_use` block, so `forest.ts` places it at the parent call that
   * most closely PRECEDES its first call. Two conversations sharing a clock make that
   * placement a coin flip, and a fixture that lets them is asserting against whichever
   * way the coin landed the day it was written. [LAW:no-ambient-temporal-coupling] */
  startMinute: number;
  events: readonly ConversationEvent[];
}

/** Build a transcript from turn specs.
 *
 * [LAW:dataflow-not-control-flow] Regime is not a flag this function branches on — it
 * is the CONTENT of `thinking`, flowing through unchanged. There is one code path here,
 * and the stripping and retaining transcripts differ only in the characters they carry.
 * The same is true of tools and attachments: the empty list runs the same path as a
 * full one.
 */
export function buildTranscript(spec: TranscriptSpec): string {
  const { sessionId, model, cwd, startMinute, events } = spec;
  const out: string[] = [];
  let uuid = 0;
  const next = (): string => `u${String(++uuid).padStart(4, '0')}`;
  const at = (i: number): string => new Date(Date.UTC(2026, 0, 1, 0, startMinute + i)).toISOString();

  // The clock advances with the CALLS, not with the events: a user line sits in the
  // minute before the response it provokes. That keeps a conversation's call timestamps
  // a function of how many calls precede them, which is what the spawn-placement
  // expectations in the tests are derived from.
  let i = 0;

  for (const event of events) {
    if (event.kind === 'user') {
      out.push(
        line({
          type: 'user',
          uuid: next(),
          timestamp: at(i * 2),
          sessionId,
          cwd,
          message: { role: 'user', content: event.text },
        }),
      );
      continue;
    }
    const t = event.turn;
    const requestId = `req_${i}`;
    // One JSONL line per content block — the fan-out the dedup rule exists for, and the
    // trap PROJECT.md calls out as invalidating naive analysis.
    const blocks: unknown[] = [
      { type: 'thinking', thinking: t.thinking, signature: 'c2ln'.repeat(120) },
      { type: 'text', text: t.text },
      ...t.tools.map((tool) => ({
        type: 'tool_use',
        id: tool.id,
        name: tool.name,
        input: tool.input,
      })),
    ];
    // `output_tokens` RISES across the group and only the last line carries the finished
    // count, because the writer records a snapshot per block while the response is still
    // streaming. 5,449 of the corpus's 48,155 request groups look like this.
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
          cwd,
          requestId,
          message: { role: 'assistant', model, usage: usageAt(k), content: [b] },
        }),
      ),
    );

    // One user line per result, which is what the harness writes. A tool whose result
    // is `null` contributes none — the transcript simply ends without it.
    for (const tool of t.tools)
      if (tool.result !== null)
        out.push(
          line({
            type: 'user',
            uuid: next(),
            timestamp: at(i * 2 + 2),
            sessionId,
            cwd,
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: tool.id, content: tool.result }],
            },
          }),
        );

    for (const a of t.attachments)
      out.push(
        line({
          type: 'attachment',
          uuid: next(),
          timestamp: at(i * 2 + 2),
          sessionId,
          cwd,
          attachment: { type: a.type, content: a.content },
        }),
      );

    i++;
  }

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
 * 53 groups of the corpus's 48,155 have this shape — every field zero, with
 * `service_tier` and `iterations` null, which is a placeholder the writer emitted rather
 * than anything the API measured. It is the one case that separates "take the last line"
 * from "take the completed one": a last-wins reader adopts the zeros and silently
 * discards a real call's entire cost. */
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

/** A one-call transcript whose request group's usage blocks are written VERBATIM.
 *
 * `buildTranscript` synthesizes a plausible streaming ramp across a group's lines, which
 * is the right model for a conversation and the wrong one for a test whose subject IS the
 * usage block. The shapes that matter to the conservation identities are exactly the ones
 * that ramp cannot produce: a per-TTL breakdown that disagrees with its own flat total, or
 * a final line reporting less than the peak without being the all-zero placeholder.
 *
 * [LAW:one-type-per-behavior] `placeholderTailSession` above is the first of these,
 * written out by hand. This is the same thing with the usage blocks lifted into a
 * parameter, so the next adversarial shape is DATA rather than a fourth hand-written
 * transcript — and `placeholderTailSession` keeps its own name because what it models is
 * a specific observed corpus shape, not an arbitrary one. */
export const usageBlockSession = (
  usages: readonly Record<string, unknown>[],
  sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
): string =>
  [
    line({
      type: 'user',
      uuid: 'q0001',
      timestamp: '2026-01-01T00:00:00.000Z',
      sessionId,
      cwd: FOREIGN_CWD,
      message: { role: 'user', content: 'do the thing' },
    }),
    ...usages.map((usage, k) =>
      line({
        type: 'assistant',
        uuid: `q${String(k + 2).padStart(4, '0')}`,
        timestamp: `2026-01-01T00:01:${String(k).padStart(2, '0')}.000Z`,
        sessionId,
        cwd: FOREIGN_CWD,
        // One requestId across every block: these are the lines of ONE call, which is
        // what makes them a dedup decision rather than a sequence of calls.
        requestId: 'req_usage',
        message: {
          role: 'assistant',
          model: 'claude-opus-5',
          usage,
          content: [{ type: 'text', text: `part ${k}` }],
        },
      }),
    ),
  ].join('\n') + '\n';

// ---------------------------------------------------------------------------------
// A WHOLE SESSION: the root conversation plus every conversation it spawned.
// ---------------------------------------------------------------------------------

/** One spawned conversation, declared as data.
 *
 * [LAW:one-type-per-behavior] There is no `buildSubagentTranscript` beside
 * `buildTranscript`. A spawned conversation IS a transcript — `src/calls.ts` reduces it
 * with the same function it uses on a root — so what makes it a subagent is the
 * `.meta.json` filed next to it, which is data, not a second builder. */
export interface SpawnSpec {
  agentId: string;
  agentType: string;
  description: string;
  /** The `tool_use` id, IN SOME TRANSCRIPT, that started this conversation — the root's
   * for a child, another subagent's for a grandchild. The empty string is a
   * slash-command fork, which leaves no `tool_use` block behind at all; the meta file
   * then omits the key entirely, exactly as the observed corpus does (158 of 481). */
  toolUseId: string;
  /** What the meta file CLAIMS its depth is. Deliberately allowed to disagree with the
   * chain the resolver works out, because in the corpus it does: 7 meta files carry no
   * `spawnDepth` at all and default to 1 regardless of where they actually sit. */
  declaredDepth: number;
  startMinute: number;
  events: readonly ConversationEvent[];
}

export interface SessionSpec {
  sessionId: string;
  /** The flattened project-directory name Claude Code files the session under. */
  project: string;
  cwd: string;
  model: string;
  root: readonly ConversationEvent[];
  spawns: readonly SpawnSpec[];
}

/** A session as `analyzeSession` needs it: where its files are, and how to read them.
 *
 * [LAW:effects-at-boundaries] `read` closes over a map, so a test using this touches no
 * filesystem. That is the whole reason the pipeline takes a `ReadText` rather than
 * opening files itself. */
export interface SessionFixture {
  source: SessionSource;
  read: (path: string) => string;
}

/** Where a fixture session pretends to live. Never touched; the paths exist only as
 * keys, and mirroring the real layout is what keeps the fixture a map of the territory
 * rather than of a convenient invention. */
const CORPUS_ROOT = '/corpus';

/** Build a whole session — root transcript, one transcript and one meta file per spawn
 * — into the paths `discover.ts` would have found them at.
 *
 * The reader THROWS on any path the fixture did not write. A reader that returned `''`
 * for an unknown path would let a test pass while silently analysing an empty
 * transcript, which is the answer-shaped void this pipeline exists to hunt.
 * [LAW:no-silent-failure] */
export function buildSession(spec: SessionSpec): SessionFixture {
  const projectDir = `${CORPUS_ROOT}/${spec.project}`;
  const path = `${projectDir}/${spec.sessionId}.jsonl`;
  const subagentDir = `${projectDir}/${spec.sessionId}/subagents`;
  const files = new Map<string, string>();

  files.set(
    path,
    buildTranscript({
      sessionId: spec.sessionId,
      model: spec.model,
      cwd: spec.cwd,
      startMinute: 0,
      events: spec.root,
    }),
  );

  const subagents = spec.spawns.map((s) => {
    const transcriptPath = `${subagentDir}/agent-${s.agentId}.jsonl`;
    const metaPath = `${subagentDir}/agent-${s.agentId}.meta.json`;
    files.set(
      transcriptPath,
      buildTranscript({
        sessionId: spec.sessionId,
        model: spec.model,
        cwd: spec.cwd,
        startMinute: s.startMinute,
        events: s.events,
      }),
    );
    files.set(
      metaPath,
      JSON.stringify({
        agentType: s.agentType,
        description: s.description,
        // Omitted rather than written empty, because that is what a slash-command
        // fork's meta file looks like on disk.
        ...(s.toolUseId ? { toolUseId: s.toolUseId } : {}),
        spawnDepth: s.declaredDepth,
      }),
    );
    return { agentId: s.agentId, transcriptPath, metaPath };
  });

  return {
    source: {
      project: spec.project,
      sessionId: spec.sessionId,
      path,
      bytes: 0,
      mtime: 0,
      subagents,
      unpaired: [],
    },
    read: (p) => {
      const text = files.get(p);
      if (text === undefined)
        throw new Error(`fixture has no file at ${p} — the pipeline read a path nobody wrote`);
      return text;
    },
  };
}

/** Two calls, one with reasoning and a tool call, one with reasoning and only text.
 * `thinking` is threaded in so the same session can be built under either regime, and
 * `model` so the same session can be built on a model the report has never heard of. */
export const twoCallSession = (
  thinking: string,
  model = 'claude-opus-5',
  cwd = FOREIGN_CWD,
): string =>
  buildTranscript({
    sessionId: '11111111-2222-3333-4444-555555555555',
    model,
    cwd,
    startMinute: 0,
    events: [
      userSays('do the thing'),
      assistantTurn({
        thinking,
        text: 'Reading the file first.',
        tools: [
          {
            id: 'toolu_01',
            name: 'Read',
            input: { file_path: '/src/calls.ts' },
            result: 'export interface Arrival { size: Size }\n'.repeat(40),
          },
        ],
        attachments: [],
        usage: { input: 12, cacheCreation: 4200, cacheRead: 0, output: 900 },
      }),
      assistantTurn({
        thinking,
        text: 'The seam is the type, so the fix goes in the signature.',
        tools: [],
        attachments: [],
        usage: { input: 3, cacheCreation: 610, cacheRead: 4200, output: 1400 },
      }),
    ],
  });
