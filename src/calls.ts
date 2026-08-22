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

export interface Turn {
  index: number;
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
        if (!line.isToolResult)
          turns.push({
            index: turns.length,
            snippet: display(line.snippet, TURN_LEN),
            firstCall: nextCall,
            lastCall: nextCall,
          });
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
