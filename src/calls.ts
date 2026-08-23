// Reduce one transcript's records to the conversation they describe: its API calls,
// the content that arrived between them, the tool executions, and the user turns.
//
// [LAW:effects-at-boundaries] Pure. Takes records, returns a conversation.

import type { ContentBlock, SessionLine } from './records.ts';
import type { Usage } from './tokens.ts';

/** One API request.
 *
 * THE DEDUP RULE, stated once because getting it wrong silently corrupts everything
 * built on top: a call is the GROUP of JSONL lines sharing a requestId. `usage` is
 * taken from the group ONCE — every line repeats it verbatim, so summing overstates
 * by the fan-out factor (2.42x on the specimen). `blocks` is the UNION over the group
 * — each line carries a different block, so keeping only the first line drops most
 * tool calls (29 of the specimen's 33, with no error).
 *
 * [LAW:types-are-the-program] One rule cannot serve both: identity and payload are
 * different maps of the same call, and applying either rule to the other loses data.
 * Verified empirically in miser-validation-7xn — usage is byte-identical across every
 * line of every request group, so "take once" is safe; it is NOT a running total. */
export interface Call {
  index: number;
  requestId: string;
  /** How many JSONL lines this one call fanned out to. Keeps the dedup factor
   * visible instead of leaving it as a number nobody can check. */
  lineCount: number;
  ts: number;
  model: string;
  usage: Usage;
  blocks: ContentBlock[];
}

/** Something that entered the context window between two calls. */
export interface Arrival {
  /** Index of the first call whose prompt contained it. */
  bornBeforeCall: number;
  source: ArrivalSource;
  label: string;
  chars: number;
  /** Set when this arrival is a tool result, linking it to its tool_use block. */
  toolUseId: string;
}

export type ArrivalSource = 'toolResult' | 'userText' | 'attachment' | 'assistantOutput';

/** A tool_use block paired with the tool_result line that answered it. */
export interface ToolExec {
  toolUseId: string;
  name: string;
  /** Display text — whitespace-collapsed and cut. Rules match `Call.blocks`, never
   * this. */
  summary: string;
  callIndex: number;
  tsStart: number;
  tsEnd: number;
  resultChars: number;
}

/** WHERE a turn's text came from.
 *
 * Not everything arriving as a "user" message was typed by a user. The harness injects
 * skill bodies, slash-command envelopes, caveats, task notifications, interrupt markers
 * and compaction summaries down the same channel, and they are 40% of all turns in this
 * corpus. Left as raw text, every one of them becomes a span label reading
 * "Base directory for this skill: /Users/you/.claude/plugins/cache/..." — which names
 * the envelope instead of the work.
 *
 * [LAW:types-are-the-program] Origin is a FIELD decided once, not a prefix that each
 * consumer re-sniffs. The flamegraph, the session rail and the synopsis all want the
 * same answer, and three independent guesses at it would be three chances to disagree. */
export type TurnOrigin =
  /** A person typed it. */
  | { kind: 'user' }
  /** A slash command: `<command-name>/next</command-name>`. */
  | { kind: 'command'; name: string }
  /** A skill body delivered as a user turn. */
  | { kind: 'skill'; skill: string }
  /** Relayed on a user's behalf by another agent. */
  | { kind: 'agent' }
  /** Harness bookkeeping: caveats, interrupts, notifications, compaction summaries. */
  | { kind: 'harness'; what: string };

export interface Turn {
  index: number;
  origin: TurnOrigin;
  /** What to put on a label: the user's words, or a short name for the envelope. Never
   * the envelope's guts. */
  snippet: string;
  firstCall: number;
  lastCall: number;
}

export interface Conversation {
  calls: Call[];
  arrivals: Arrival[];
  tools: ToolExec[];
  turns: Turn[];
  /** Tool results whose tool_use block we never saw. Counted, never dropped.
   * [LAW:no-silent-failure] */
  unmatchedToolResults: number;
}

const SUMMARY_LEN = 90;
const TURN_LEN = 110;
const display = (s: string, n: number = SUMMARY_LEN): string => s.replace(/\s+/g, ' ').slice(0, n);

/** How a turn's text is recognised, as an ORDERED TABLE.
 *
 * [LAW:dataflow-not-control-flow] A newly-observed envelope is a new ROW, never
 * another branch. Every pattern here was taken from a real transcript rather than
 * guessed — the eight below cover 40% of the 1,439 turns sampled across the corpus.
 * Anything unmatched falls through to `user`, which is the honest default: text we
 * cannot attribute to the harness is text a person probably wrote. */
const ORIGIN_RULES: ReadonlyArray<{
  when: RegExp;
  read: (text: string, m: RegExpExecArray) => { origin: TurnOrigin; snippet: string };
}> = [
  {
    // "Base directory for this skill: /Users/.../plugins/cache/promptctl/laws/0.17.0/skills/code"
    when: /^Base directory for this skill:\s*(\S+)/,
    read: (_t, m) => {
      const skill = m[1]!.split('/skills/').pop() ?? m[1]!;
      return { origin: { kind: 'skill', skill }, snippet: `skill: ${skill}` };
    },
  },
  {
    // Either ordering occurs: <command-name> first, or <command-message> first.
    when: /^<command-(?:name|message)>/,
    read: (t) => {
      const name = /<command-name>\/?([^<]*)<\/command-name>/.exec(t)?.[1]?.trim() ?? '?';
      const args = /<command-args>([^<]*)<\/command-args>/.exec(t)?.[1]?.trim() ?? '';
      return { origin: { kind: 'command', name }, snippet: `/${name}${args ? ` ${args}` : ''}` };
    },
  },
  {
    when: /^=== Below is a message from an agent[^\n]*\n([\s\S]*)/,
    read: (_t, m) => ({
      origin: { kind: 'agent' },
      // The relayed message sits between the two === markers.
      snippet: `via agent: ${m[1]!.split(/\n=== /)[0]!.trim()}`,
    }),
  },
  { when: /^<local-command-caveat>/, read: () => harness('local command caveat') },
  { when: /^<local-command-stdout>/, read: () => harness('local command output') },
  { when: /^<task-notification>/, read: () => harness('task notification') },
  { when: /^\[Request interrupted by user/, read: () => harness('interrupted by user') },
  { when: /^\[Image: /, read: () => harness('pasted image') },
  {
    when: /^This session is being continued from a previous conversation/,
    read: () => harness('resumed after compaction'),
  },
];

const harness = (what: string): { origin: TurnOrigin; snippet: string } => ({
  origin: { kind: 'harness', what },
  snippet: `[${what}]`,
});

/** Commands that operate the session rather than ask for work.
 *
 * A session opening with `/clear` is not a session ABOUT clearing. The distinction
 * matters wherever a turn is used to say what a session was for: three sessions in the
 * corpus start `/clear`, and naming them after it makes them indistinguishable. */
const SESSION_CONTROL = new Set(['clear', 'compact', 'model', 'context', 'rewind', 'resume']);

export const isSessionControl = (o: TurnOrigin): boolean =>
  o.kind === 'command' && SESSION_CONTROL.has(o.name);

/** Decide what a user-channel turn actually is, and what to call it. */
export function readTurn(text: string): { origin: TurnOrigin; snippet: string } {
  for (const r of ORIGIN_RULES) {
    const m = r.when.exec(text);
    if (m) return r.read(text, m);
  }
  return { origin: { kind: 'user' }, snippet: text };
}

const isToolUse = (b: ContentBlock): b is Extract<ContentBlock, { kind: 'tool_use' }> =>
  b.kind === 'tool_use';

/** Build the conversation from one transcript's records, in transcript order.
 *
 * [LAW:one-type-per-behavior] Used for BOTH a main session and each spawned agent. A
 * subagent transcript is the same kind of thing as a session transcript, so it gets
 * the same function, not a parallel one. */
export function buildConversation(lines: readonly SessionLine[]): Conversation {
  const byRequest = new Map<string, Call>();
  const arrivals: Arrival[] = [];
  const turns: Turn[] = [];
  const toolUses = new Map<string, { name: string; summary: string; callIndex: number; ts: number }>();
  const toolResults: Array<{ id: string; chars: number; ts: number }> = [];

  for (const line of lines) {
    // The call any non-assistant content will be in the prompt of: the next one to
    // be issued, which is the number of distinct request groups seen so far.
    const nextCall = byRequest.size;

    switch (line.kind) {
      case 'assistant': {
        let call = byRequest.get(line.requestId);
        if (!call) {
          call = {
            index: byRequest.size,
            requestId: line.requestId,
            lineCount: 0,
            ts: line.ts,
            model: line.model,
            usage: line.usage, // taken ONCE per request group
            blocks: [],
          };
          byRequest.set(line.requestId, call);
        }
        call.lineCount++;
        for (const block of line.blocks) {
          call.blocks.push(block); // unioned across the whole request group
          if (isToolUse(block))
            toolUses.set(block.id, {
              name: block.name,
              summary: display(block.input),
              callIndex: call.index,
              ts: line.ts,
            });
        }
        break;
      }

      case 'user': {
        let userChars = 0;
        for (const b of line.blocks) {
          if (b.kind === 'tool_result') {
            toolResults.push({ id: b.toolUseId, chars: b.chars, ts: line.ts });
            const use = toolUses.get(b.toolUseId);
            arrivals.push({
              bornBeforeCall: nextCall,
              source: 'toolResult',
              label: `${use?.name ?? '?'} ${use?.summary ?? ''}`.trim(),
              chars: b.chars,
              toolUseId: b.toolUseId,
            });
          } else if (b.kind === 'text') {
            userChars += b.chars;
          }
        }
        if (userChars > 0)
          arrivals.push({
            bornBeforeCall: nextCall,
            source: 'userText',
            label: display(line.snippet),
            chars: userChars,
            toolUseId: '',
          });
        // A user line that is not a tool result opens a new turn.
        if (!line.isToolResult) {
          const t = readTurn(line.snippet);
          turns.push({
            index: turns.length,
            origin: t.origin,
            snippet: display(t.snippet, TURN_LEN),
            firstCall: nextCall,
            lastCall: nextCall,
          });
        }
        break;
      }

      case 'attachment':
        arrivals.push({
          bornBeforeCall: nextCall,
          source: 'attachment',
          label: line.attachmentType,
          chars: line.chars,
          toolUseId: '',
        });
        break;

      case 'system':
      case 'meta':
      case 'unknown':
        // Carry no context-window content of their own. Counted in ParseStats.
        break;
    }
  }

  const calls = [...byRequest.values()];

  // Assistant output also occupies context on every later call.
  //
  // THINKING CONTRIBUTES ZERO HERE, AND THAT IS DELIBERATE. Thinking tokens are billed
  // as OUTPUT on the turn that produces them and are not carried into the next turn's
  // context, so they must not be counted as resident. Today that happens for an
  // accidental reason: Claude Code strips the reasoning text before writing the
  // transcript — all 4,178 blocks sampled across the corpus have `thinking: ""` — so
  // `chars` is 0 and the block adds nothing.
  //
  // The trap: the empty field looks like a parse bug, and "fixing" it by falling back
  // to the block's `signature` (352–80,280 chars) would silently start charging
  // residency for content that is not resident. Do not do that without
  // miser-report-z52.3, which is measuring where thinking actually dies and whether the
  // signature itself occupies context.
  for (const c of calls) {
    const chars = c.blocks.reduce((a, b) => a + blockChars(b), 0);
    if (chars > 0)
      arrivals.push({
        bornBeforeCall: c.index + 1,
        source: 'assistantOutput',
        label: `assistant output of call ${c.index}`,
        chars,
        toolUseId: '',
      });
  }

  const tools: ToolExec[] = [];
  let unmatchedToolResults = 0;
  for (const r of toolResults) {
    const use = toolUses.get(r.id);
    if (!use) {
      unmatchedToolResults++;
      continue;
    }
    tools.push({
      toolUseId: r.id,
      name: use.name,
      summary: use.summary,
      callIndex: use.callIndex,
      tsStart: use.ts,
      tsEnd: r.ts,
      resultChars: r.chars,
    });
  }

  // Close turn extents: a turn runs until the next one starts.
  for (let i = 0; i < turns.length; i++) {
    const next = turns[i + 1];
    turns[i]!.lastCall = next ? next.firstCall - 1 : Math.max(0, calls.length - 1);
  }

  return { calls, arrivals, tools, turns, unmatchedToolResults };
}

const blockChars = (b: ContentBlock): number => (b.kind === 'tool_use' ? b.inputChars : b.chars);
