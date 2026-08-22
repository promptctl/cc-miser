// Assign one activity to every call, deterministically.
//
// PROJECT.md's cascade, tiers 1 and 2: explicit markers the transcript states about
// itself, then tool signatures. No LLM, no network, no cache — tier 3 (the judge) is
// miser-activity-4vo.3 and slots in as more rows plus a fallback, not as a rewrite.
//
// [LAW:effects-at-boundaries] Pure.

import type { Call } from './calls.ts';
import { UNCLASSIFIED, label, type Activity, type DecidedTier, type Label } from './activity.ts';

/** What a rule gets to look at. Flattened from the call so rules stay one-liners. */
export interface CallFacts {
  toolNames: string[];
  /** Tool argument text, stripped to the program and lowercased. Index-aligned with
   * `toolNames`, so a rule can ask about the two together. */
  texts: string[];
  skills: string[];
  agentTypes: string[];
}

interface Rule {
  activity: Activity;
  tier: Extract<DecidedTier, 'marker' | 'rule'>;
  because: string;
  matches: (f: CallFacts) => boolean;
}

const any = (xs: readonly string[], re: RegExp): boolean => xs.some((x) => re.test(x));

/** A command minus its payloads.
 *
 * A `lit new --description "...pytest..."` is filing a ticket, not running tests: the
 * quoted body is data the command CARRIES, not evidence about what the command DOES.
 * Matching raw text mislabelled two ticket-filing calls as verification, so quoted
 * runs and heredoc bodies are removed before any rule sees the text. */
const programText = (s: string): string =>
  s
    .replace(/<<-?'?(\w+)'?[\s\S]*?^\s*\1/gm, ' ')
    .replace(/'[^']*'/g, ' ')
    .replace(/"[^"]*"/g, ' ')
    .toLowerCase();

/** Paths that are the agent's own workspace rather than the project's. */
const SCRATCH = /\/tmp\/|\/private\/tmp\/|scratchpad|\/var\/folders\//;

/** The classification cascade, as an ORDERED TABLE rather than a chain of ifs.
 *
 * [LAW:dataflow-not-control-flow] A new activity signal is a new ROW, never another
 * branch. Order is the priority: markers are exact and come first, and among the
 * tool-signature rules the more specific act wins (an edit beats the test run that
 * follows it in the same call).
 *
 * Every row states its tier and its evidence, because PROJECT.md requires a label to
 * carry its provenance — a percentage whose basis is unstated is not an answer. */
const RULES: readonly Rule[] = [
  // --- Tier 1: explicit markers. The transcripts self-label constantly. ---
  { activity: 'review', tier: 'marker', because: 'invoked a code-review skill',
    matches: (f) => any(f.skills, /code-?review|address-pr|security-review/) },
  { activity: 'process', tier: 'marker', because: 'invoked a backlog/ticket skill',
    matches: (f) => any(f.skills, /groom-backlog|ticket|next\b|schedule|loop/) },
  { activity: 'scm', tier: 'marker', because: 'invoked a commit skill',
    matches: (f) => any(f.skills, /organize-commits|commit/) },
  { activity: 'exploration', tier: 'marker', because: 'spawned an Explore subagent',
    matches: (f) => any(f.agentTypes, /^explore$/i) },
  { activity: 'design', tier: 'marker', because: 'spawned a Plan subagent',
    matches: (f) => any(f.agentTypes, /^plan$/i) },
  { activity: 'orientation', tier: 'marker', because: 'loaded a skill — the session orienting itself',
    matches: (f) => f.skills.length > 0 },

  // --- Tier 2: tool signatures. Deterministic. ---
  // A Write whose path is a scratch directory is throwaway analysis tooling, not a
  // change to the project. Ignoring the path labelled two probe scripts in the
  // hand-traced session as implementation, which would have inflated every "how much
  // do I spend making changes" figure across the corpus.
  { activity: 'implementation', tier: 'rule', because: 'edited or wrote repository files',
    matches: (f) =>
      f.toolNames.some((n, i) => /^(Edit|Write|NotebookEdit)$/.test(n) && !SCRATCH.test(f.texts[i] ?? '')) },
  { activity: 'exploration', tier: 'rule', because: 'ran a throwaway script from a scratch path',
    matches: (f) => any(f.texts, SCRATCH) },
  { activity: 'verification', tier: 'rule', because: 'ran a test suite or linter',
    matches: (f) => any(f.texts, /\b(pytest|jest|vitest|go test|cargo test|npm test|bun test|tsc|ruff|eslint|mypy)\b/) },
  { activity: 'scm', tier: 'rule', because: 'ran git or gh',
    matches: (f) => any(f.texts, /(^|[;&|\s])(git|gh)\s/) },
  { activity: 'process', tier: 'rule', because: 'ran the issue tracker',
    matches: (f) => any(f.texts, /(^|[;&|\s])lit\s/) },
  { activity: 'design', tier: 'rule', because: 'put a decision to the user',
    matches: (f) => any(f.toolNames, /^AskUserQuestion$/) },
  { activity: 'exploration', tier: 'rule', because: 'read or searched without editing',
    matches: (f) =>
      any(f.toolNames, /^(Read|Grep|Glob|WebFetch|WebSearch|Agent)$/) ||
      any(f.texts, /(^|[;&|\s])(grep|rg|find|cat|sed|awk|ls)\s/) },
  // NO catch-all that invents a real activity. An unmatched call is `unclassified` and
  // is rendered as such — a fallback label here would be an answer-shaped void, making
  // coverage look complete while quietly guessing. PROJECT.md: the honesty bucket is
  // never a silent gap. [LAW:parse-dont-validate]
  { activity: 'unclassified', tier: 'rule',
    because: 'ran tools, but no signature matched — left unclassified rather than guessed',
    matches: (f) => f.toolNames.length > 0 },
];

/** What the transcript says about one call, in the shape the rules read. */
export function factsOf(c: Call, agentTypeByToolUseId: ReadonlyMap<string, string>): CallFacts {
  const tools = c.blocks.filter((b): b is Extract<typeof b, { kind: 'tool_use' }> => b.kind === 'tool_use');
  return {
    toolNames: tools.map((t) => t.name),
    texts: tools.map((t) => programText(t.input)),
    skills: tools.filter((t) => t.name === 'Skill').map((t) => t.input.toLowerCase()),
    agentTypes: tools.flatMap((t) => {
      const at = agentTypeByToolUseId.get(t.id);
      return at ? [at] : [];
    }),
  };
}

/** Classify every call in a conversation.
 *
 * A call with no tool calls at all (pure thinking, or a text reply) carries no signal
 * of its own, so it CONTINUES the preceding call's phase. That keeps the partition
 * total — PROJECT.md's invariant is that every call belongs to exactly one activity,
 * so leaving a gap here would silently break every percentage downstream.
 *
 * The result is index-aligned with `calls`, which is what makes the partition true by
 * construction rather than by a later check. */
export function classifyCalls(
  calls: readonly Call[],
  agentTypeByToolUseId: ReadonlyMap<string, string>,
): Label[] {
  const out: Label[] = [];
  for (const c of calls) {
    const f = factsOf(c, agentTypeByToolUseId);
    const hit = RULES.find((r) => r.matches(f));
    const prev = out[out.length - 1];
    out.push(
      hit
        ? label(hit.activity, hit.tier, hit.because)
        : prev
          ? label(
              prev.activity,
              'rule',
              "continuation of the preceding call's phase (no tool signal of its own)",
            )
          : UNCLASSIFIED,
    );
  }
  return out;
}
