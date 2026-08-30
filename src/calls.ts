// Reduce one transcript's records to the conversation they describe: its API calls,
// the content that arrived between them, the tool executions, and the user turns.
//
// [LAW:effects-at-boundaries] Pure. Takes records, returns a conversation.

import type { ContentBlock, SessionLine } from './records.ts';
import { estimatedSize, exactSize, type Size, type Usage } from './tokens.ts';

/** One API request.
 *
 * THE DEDUP RULE, stated once because getting it wrong silently corrupts everything
 * built on top: a call is the GROUP of JSONL lines sharing a requestId. `blocks` is the
 * UNION over the group — each line carries a different block, so keeping only the first
 * line drops most tool calls (29 of the specimen's 33, with no error). `usage` is ONE
 * snapshot from the group, chosen by `completeUsage` — never the sum, which overstates
 * by the fan-out factor (2.42x on the specimen), and never the first line, which is the
 * bug corrected below.
 *
 * [LAW:types-are-the-program] One rule cannot serve both: identity and payload are
 * different maps of the same call, and applying either rule to the other loses data. */
export interface Call {
  index: number;
  requestId: string;
  /** How many JSONL lines this one call fanned out to. Keeps the dedup factor
   * visible instead of leaving it as a number nobody can check. */
  lineCount: number;
  ts: number;
  model: string;
  usage: Usage;
  /** The usage snapshot the group's LAST line carried — the rule `completeUsage`
   * REJECTED, kept so the rule it chose can be checked instead of trusted.
   *
   * Deliberately order-dependent, which is the whole reason it is a useful rival: `max`
   * is a property of the SET of lines and `last` is a property of their sequence, so the
   * two are computed from genuinely different things and cannot agree by construction.
   * They agree on all 5,449 streaming groups and part company only where a placeholder
   * line carries an all-zero block. That gap is what `src/invariants.ts` watches: the
   * first-line reader that shipped understated the corpus's output by 27.4%, and nothing
   * in this suite could see it, because the only figure kept was the one it produced.
   * [LAW:no-silent-failure] */
  lastLineUsage: Usage;
  /** Whether `output` differed across ANY two of this group's lines. Most multi-line
   * groups are multi-BLOCK, not multi-VALUE: a turn with a thinking block, a tool_use,
   * and a text block is three lines, but the API often reports the same finished output
   * count on all three rather than a growing one — so `lineCount > 1` alone is a much
   * broader, weaker population than groups where `usage`/`lastLineUsage` were ever
   * genuinely at risk of disagreeing. Measured over this corpus's assistant lines: of
   * ~35,000 multi-line request groups, only a small minority actually have output that
   * varies across their lines — most are flat, and MAX vs LAST agrees on a flat sequence
   * by construction regardless of which line either rule would have picked. */
  outputVaries: boolean;
  /** Cache-creation tokens the adopted snapshot's own per-TTL breakdown reported and its
   * flat total did not account for. Zero everywhere in the corpus; non-zero means the one
   * figure this pipeline costs cache writes from has stopped totalling the tiers beside
   * it. See `ParsedUsage` in `records.ts`. Trivially zero, rather than checked-and-zero,
   * when `hasCacheCreationBreakdown` is false. */
  unaccountedCacheCreation: number;
  /** Whether the adopted snapshot's line carried a `cache_creation` breakdown at all —
   * i.e. whether `unaccountedCacheCreation` is evidence or a vacuous non-comparison. See
   * `ParsedUsage` in `records.ts`. */
  hasCacheCreationBreakdown: boolean;
  blocks: ContentBlock[];
}

/** The more complete of two usage snapshots from one request group.
 *
 * WHY THIS EXISTS. An earlier version of this file recorded, as verified fact, that
 * "usage is byte-identical across every line of every request group, so take-once is
 * safe; it is NOT a running total." That was measured on the 28-call specimen and stated
 * as a universal. It is false. Re-measured over all 740 transcripts with the grouping
 * this function performs: 5,395 of 36,426 request groups disagree on `output_tokens`,
 * because it is a PARTIAL count that grows as the response streams and only one line
 * carries the finished figure. Taking the first line understated the corpus's output by
 * 9,105,348 tokens — 27.4% of all output ever billed. Every other field
 * (input, cache creation, cache read) genuinely is constant within a group. HISTORICAL:
 * the token count and percentage are from that original 740-transcript bug discovery and
 * were not re-verified in the miser-pipeline-sll.6 re-measurement below, which only
 * re-confirmed the request-group counts — treat them as "what the bug cost when it was
 * found," not a current fact about this pipeline's output.
 *
 * WHY MAX AND NOT LAST. Both rules agree on every streaming group. They disagree only
 * where a placeholder line carries an all-zero usage block (`service_tier` and
 * `iterations` both null) beside the real one: "last" would adopt the zeros and throw
 * away a real call's entire cost. Max is also a property of the SET of lines rather than
 * of the order they were appended in. [LAW:no-ambient-temporal-coupling]
 *
 * Re-measured for miser-pipeline-sll.6 across all 943 transcripts, because the counts
 * this comment used to state were taken when the corpus was smaller and had quietly gone
 * stale: of 48,155 request groups, 5,449 stream and would be understated by a first-line
 * reader, 53 carry a placeholder tail, and ZERO disagree for any other reason. The last
 * of those three figures is the one that matters — it is what makes the disagreement
 * fully characterised rather than merely small — and `src/invariants.ts` now holds the
 * two rules against each other on every run instead of trusting this paragraph.
 *
 * The greatest output wins the WHOLE snapshot, never field-by-field: a per-field maximum
 * could assemble a usage vector that no line ever reported, which is a number with no
 * source. [LAW:one-source-of-truth] */
const completeUsage = (a: UsageSnapshot, b: UsageSnapshot): UsageSnapshot =>
  b.usage.output > a.usage.output ? b : a;

/** What one JSONL line of a request group claims the call cost, and how completely that
 * claim accounts for itself.
 *
 * The two travel together so the dedup rule chooses between whole snapshots. Reading
 * `unaccountedCacheCreation` off some other line of the group than the one whose usage
 * was adopted would report the completeness of a figure nobody used. */
interface UsageSnapshot {
  usage: Usage;
  unaccountedCacheCreation: number;
  hasCacheCreationBreakdown: boolean;
}

/** Something that entered the context window between two calls. */
export interface Arrival {
  /** Index of the first call whose prompt contained it. */
  bornBeforeCall: number;
  source: ArrivalSource;
  label: string;
  /** How much context this occupies, and how well that is known.
   *
   * [LAW:types-are-the-program] A raw `chars` field could not distinguish the one
   * arrival whose size the API reports exactly from the ones we reconstruct, so every
   * consumer estimated all of them alike and the exact figure was thrown away. The
   * basis travels with the number instead. */
  size: Size;
  /** Set when this arrival is a tool result, linking it to its tool_use block. */
  toolUseId: string;
}

export type ArrivalSource = 'toolResult' | 'userText' | 'attachment' | 'assistantOutput';

/** One tool_use block, and the tool_result line that answered it if one ever did.
 *
 * EVERY tool_use IS ONE OF THESE, answered or not, and that is a deliberate widening —
 * it used to mean "a PAIR", built by walking the results, so a tool still running when
 * the transcript was written had no `ToolExec` at all. The one consumer that needed a
 * time for such a tool, `spans.ts`, substituted the enclosing CALL's timestamp for the
 * tool's own, which made a tool span's position depend on whether a later record had
 * arrived yet: exported mid-flight it sat at the call, and exported again after the
 * result landed it moved. Jaeger's store keys a span partly on its start time, so that
 * move left the superseded copy behind as a second span — miser-tracing-yhc.5's
 * remainder, found by exporting a real growing session rather than a fixture.
 *
 * [LAW:one-source-of-truth] When this tool was requested is one fact with one home: the
 * tool_use record. It is knowable the moment the block is read and never changes, so no
 * consumer needs a second clock to fall back to. [LAW:types-are-the-program] The result's
 * absence is now in the type rather than in a caller's `??`. */
export interface ToolExec {
  toolUseId: string;
  name: string;
  /** Display text — whitespace-collapsed and cut. Rules match `Call.blocks`, never
   * this. */
  summary: string;
  callIndex: number;
  /** When the tool was REQUESTED — the tool_use record's own timestamp. */
  tsStart: number;
  /** When its result arrived, or null if the transcript ends before it did. */
  tsEnd: number | null;
  /** Size of that result, or null while there is no result to have a size.
   * Distinct from `0`, which is a result that arrived and was empty. */
  resultChars: number | null;
}

/** WHERE a turn's text came from.
 *
 * Not everything arriving as a "user" message was typed by a user. The harness injects
 * skill bodies, slash-command envelopes, caveats, task notifications, interrupt markers,
 * shell commands and compaction summaries down the same channel, and they are 76% of all
 * turns measured across the development corpus. Left as raw text, every one of them
 * becomes a span label reading "Base directory for this skill: …/skills/code" — which
 * names the envelope instead of the work.
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
  /** Tool results answering an id that already had one AND has a tool_use. The join
   * keeps a single result per tool_use, so these are results the analysis does not
   * carry — the same kind of gap as `unmatchedToolResults`, in the other direction.
   *
   * The two do not overlap: a repeated result for an id nothing requested is counted
   * only as unmatched, so the anomalies are partitioned rather than double-reported. */
  duplicateToolResults: number;
  /** Tool_use blocks whose id was already taken by an earlier one. Each costs that
   * earlier request its span, since `spans.ts` builds tool spans from the surviving
   * entries — the request-side twin of `duplicateToolResults`. */
  duplicateToolUses: number;
}

const SUMMARY_LEN = 90;
const TURN_LEN = 110;
const display = (s: string, n: number = SUMMARY_LEN): string => s.replace(/\s+/g, ' ').slice(0, n);

/** How a turn's text is recognised, as an ORDERED TABLE.
 *
 * [LAW:dataflow-not-control-flow] A newly-observed envelope is a new ROW, never
 * another branch. Every pattern here was taken from a real transcript rather than
 * guessed. Anything unmatched falls through to `user`, which is the honest default: text
 * we cannot attribute to the harness is text a person probably wrote.
 *
 * PORTABLE, AND CHECKED RATHER THAN ASSUMED. Every pattern matches a wrapper Claude Code
 * itself emits, so none of them depends on one user's skills, plugins or configuration —
 * the closest thing to a local assumption is splitting a skill path on `/skills/`, which
 * is the plugin cache's own layout and falls back to the whole path when absent.
 *
 * The check that established this also found what the table was MISSING, which is the
 * point of running it: replaying `readTurn` over all 3,353 turns of the development
 * corpus and listing everything that fell through to `user` while still looking like an
 * envelope surfaced 34 turns of `<bash-input>`/`<bash-stdout>` — the `!command` feature —
 * being counted as a person asking for work. They are rows now. The fall-through is
 * silent by design, so the only way this table stays true is by periodically asking it
 * what it failed to match. */
const ORIGIN_RULES: ReadonlyArray<{
  when: RegExp;
  read: (text: string, m: RegExpExecArray) => { origin: TurnOrigin; snippet: string };
}> = [
  {
    // "Base directory for this skill: <plugin cache>/promptctl/laws/0.17.0/skills/code"
    // — only the tail after `/skills/` names the skill; everything before it is wherever
    // this machine happens to keep its plugin cache.
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
  {
    // `!ls` — a shell command run in the session rather than a prompt. A person typed
    // the command, but they were not asking the model for anything, so counting it as
    // user intent overstates how often work was requested.
    when: /^<bash-input>([\s\S]*?)<\/bash-input>/,
    read: (_t, m) => ({
      origin: { kind: 'harness', what: 'shell command' },
      snippet: `! ${display(m[1]!.trim(), TURN_LEN)}`,
    }),
  },
  { when: /^<bash-(?:stdout|stderr)>/, read: () => harness('shell output') },
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
  let duplicateToolUses = 0;
  const toolResults: Array<{ id: string; chars: number; ts: number }> = [];

  for (const line of lines) {
    // The call any non-assistant content will be in the prompt of: the next one to
    // be issued, which is the number of distinct request groups seen so far.
    const nextCall = byRequest.size;

    switch (line.kind) {
      case 'assistant': {
        const call = byRequest.get(line.requestId) ?? {
          index: byRequest.size,
          requestId: line.requestId,
          lineCount: 0,
          ts: line.ts,
          model: line.model,
          usage: line.usage,
          lastLineUsage: line.usage,
          outputVaries: false,
          unaccountedCacheCreation: line.unaccountedCacheCreation,
          hasCacheCreationBreakdown: line.hasCacheCreationBreakdown,
          blocks: [],
        };
        byRequest.set(line.requestId, call);
        // Compared against the PREVIOUS line's output before lastLineUsage is overwritten
        // below — `call.lineCount` is still last iteration's count here, so this is a
        // no-op against itself on the line that created the call and a real adjacent
        // comparison on every line after.
        if (call.lineCount > 0 && call.lastLineUsage.output !== line.usage.output) call.outputVaries = true;
        // Assigned on every line of the group, so the one still standing when the group
        // ends is the last line's — the rival rule, recorded rather than recomputed.
        call.lastLineUsage = line.usage;
        // [LAW:dataflow-not-control-flow] The fold runs on EVERY line of the group,
        // including the one that created the call — where it is a no-op against itself.
        // The previous version ran it on no line at all, taking whichever usage the
        // first line happened to carry.
        const chosen = completeUsage(call, line);
        call.usage = chosen.usage;
        call.unaccountedCacheCreation = chosen.unaccountedCacheCreation;
        call.hasCacheCreationBreakdown = chosen.hasCacheCreationBreakdown;
        call.lineCount++;
        for (const block of line.blocks) {
          call.blocks.push(block); // unioned across the whole request group
          if (isToolUse(block)) {
            // A second tool_use under an id already seen REPLACES the first, which costs
            // that first request its whole span: `spans.ts` builds tool spans from this
            // map's entries, so an overwritten one is a tool that never appears in the
            // tree. Counted rather than left silent. [LAW:no-silent-failure]
            //
            // Not recovered, deliberately. A tool span's id is `tool:<toolUseId>`, so two
            // requests sharing an id are two spans sharing a span id — which the store
            // this stack now runs collapses into one anyway, and which would leave the
            // report's deep link addressing both at once. A span that is absent and
            // counted beats one that is present, ambiguous and uncounted.
            //
            // Measured on 2026-08-30: 67,251 tool_use blocks, zero blank ids and zero ids
            // seen twice in a session. `records.ts` defaults a missing id to '', so the
            // shape is reachable on a malformed transcript even though the corpus has none.
            if (toolUses.has(block.id)) duplicateToolUses++;
            toolUses.set(block.id, {
              name: block.name,
              summary: display(block.input),
              callIndex: call.index,
              ts: line.ts,
            });
          }
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
              size: estimatedSize(b.chars),
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
            size: estimatedSize(userChars),
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
          size: estimatedSize(line.chars),
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

  // Assistant output also occupies context on every later call, and its size is the
  // one arrival the API reports EXACTLY.
  //
  // THE MEASUREMENT THIS RESTS ON (miser-report-z52.3, whole corpus, no sampling). A
  // call's prompt is exactly input + cache_creation + cache_read tokens, so the token
  // delta between adjacent calls is exact. Across 33,984 boundaries that delta equals
  // the previous call's `output_tokens` plus whatever arrived in between — to within
  // 1% on low-noise cases, and `delta - output` is negative on 0.22% of them. Assistant
  // output is resident at exactly its billed output tokens for the rest of its epoch.
  //
  // That holds ACROSS USER TURNS, which is what the ticket set out to test and the
  // opposite of what it expected. One hand-checked case: a call with ~3,900 reasoning
  // tokens, followed by a 45-character user message, was followed by a prompt 6,858
  // tokens larger against an output of 6,841. Had the reasoning been stripped the delta
  // would have been about -3,900. The cache agrees independently: stripping rewrites
  // the prefix, and caching is a prefix match, so it would collapse cache_read at every
  // user turn — measured drop rate there is 8.23%, against 6.62% after a call that did
  // no thinking at all.
  //
  // [LAW:types-are-the-program] So thinking needs no special case, and gets none: the
  // arrival does not look at blocks. The previous version summed block characters,
  // which made this number depend on whether the transcript WRITER kept a block's text
  // — an incident of serialisation — rather than on what the model was billed for. A
  // thinking block's text is stripped in all 22,568 blocks we hold, so that sum was
  // silently omitting the reasoning share of every call: roughly 38% of all output
  // tokens in the corpus, understated to zero. Sizing from `usage.output` deletes the
  // estimator AND makes a retaining transcript and a stripping transcript of the same
  // session produce identical residency, which `test/thinking-regime.test.ts` asserts.
  for (const c of calls)
    arrivals.push({
      bornBeforeCall: c.index + 1,
      source: 'assistantOutput',
      label: `assistant output of call ${c.index}`,
      size: exactSize(c.usage.output),
      toolUseId: '',
    });

  // THE JOIN RUNS OVER THE USES, not over the results. Walking the results yields only
  // the tools that finished, which silently omits the tool that was still running when
  // the transcript was written — the one a live session always has. Walking the uses
  // yields every tool that was requested and lets the result be absent, which is the
  // shape the data actually has. Iteration order is therefore transcript order of the
  // requests, and stable regardless of when results come back.
  // Indexing by id keeps only ONE result per tool_use, so a second result for an id
  // already answered would vanish here — a whole result gone from every downstream
  // figure with nothing to say it happened. It is counted instead. Measured across the
  // corpus on 2026-08-30: 67,047 tool_result blocks, zero such duplicates, so this
  // counts a shape the transcripts do not currently produce — which is the same
  // likelihood `unmatchedToolResults` carries, and the same reason to count it rather
  // than assume it away. [LAW:no-silent-failure]
  //
  // ONLY FOR AN ID THAT HAS A tool_use, so the two counters partition the anomalies
  // instead of overlapping. A repeated result for an id nothing requested is already
  // described in full by `unmatchedToolResults` — counting it here as well would report
  // two bad records as three, in the note whose whole job is saying how much was lost.
  const resultOf = new Map<string, { id: string; chars: number; ts: number }>();
  let duplicateToolResults = 0;
  for (const r of toolResults) {
    if (resultOf.has(r.id) && toolUses.has(r.id)) duplicateToolResults++;
    resultOf.set(r.id, r);
  }

  const tools: ToolExec[] = [...toolUses].map(([id, use]) => {
    const answer = resultOf.get(id);
    return {
      toolUseId: id,
      name: use.name,
      summary: use.summary,
      callIndex: use.callIndex,
      tsStart: use.ts,
      tsEnd: answer === undefined ? null : answer.ts,
      resultChars: answer === undefined ? null : answer.chars,
    };
  });
  // A result whose tool_use block we never saw — the opposite gap, and still counted
  // rather than dropped. [LAW:no-silent-failure]
  const unmatchedToolResults = toolResults.filter((r) => !toolUses.has(r.id)).length;

  // Close turn extents: a turn runs until the next one starts.
  for (let i = 0; i < turns.length; i++) {
    const next = turns[i + 1];
    turns[i]!.lastCall = next ? next.firstCall - 1 : Math.max(0, calls.length - 1);
  }

  return {
    calls,
    arrivals,
    tools,
    turns,
    unmatchedToolResults,
    duplicateToolResults,
    duplicateToolUses,
  };
}
