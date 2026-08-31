// [LAW:parse-dont-validate] The single checkpoint where raw JSONL becomes typed
// records. Everything downstream consumes SessionLine and never re-checks shape.
// [LAW:types-are-the-program] The union below is the strongest theorem we can
// state about the transcript format observed in the wild (CC 2.1.x): every line
// kind we consume is a distinct variant; every line kind we don't is still
// represented (Meta/Unknown) so nothing vanishes silently.

import type { Usage } from './tokens.ts';

/** A content block inside an assistant or user message, reduced to what token
 * accounting needs: its kind, its size in characters, and linkage ids. */
export type ContentBlock =
  | { kind: 'thinking'; chars: number }
  | { kind: 'text'; chars: number; snippet: string }
  | {
      kind: 'tool_use';
      id: string;
      name: string;
      /** Size of the WHOLE input once serialized — never truncated, because this is
       * the token-accounting figure. */
      inputChars: number;
      /** The input's one human-meaningful field (command, path, pattern, ...), capped
       * at INPUT_TEXT_CAP.
       *
       * [LAW:one-source-of-truth] One field, not a `summary` beside a `full`. The
       * hand trace found that storing only a display-truncated copy sent classifier
       * rules matching against 90 characters of a command, so a `grep` past the cut
       * went unclassified. Display truncation is the renderer's job; matching wants
       * the whole string, and two copies of one string is how they disagreed. */
      input: string;
    }
  | { kind: 'tool_result'; toolUseId: string; chars: number }
  | { kind: 'other'; type: string; chars: number };

export interface AssistantLine {
  kind: 'assistant';
  uuid: string;
  ts: number;
  /** Dedup key: all JSONL lines of one API response share this. */
  requestId: string;
  model: string;
  usage: Usage;
  /** Which account of cache creation `usage.cacheCreation` was taken from, and the flat
   * figure this line stated beside it. See `CacheCreation`. */
  cacheCreation: CacheCreation;
  blocks: ContentBlock[];
}

export interface UserLine {
  kind: 'user';
  uuid: string;
  ts: number;
  blocks: ContentBlock[];
  /** Set when this line delivers a spawned conversation's result back to the `Agent`
   * tool call that started it. (The tool is named `Agent`; `Task` — the name the
   * design originally assumed — appears nowhere in the corpus.) */
  agentId: string | null;
  /** True when the line only carries tool_result blocks (harness-generated). */
  isToolResult: boolean;
  /** First 200 chars of user-typed text, for span labels. */
  snippet: string;
}

export interface AttachmentLine {
  kind: 'attachment';
  uuid: string;
  ts: number;
  /** e.g. task_reminder, hook_additional_context, skill_listing */
  attachmentType: string;
  chars: number;
}

export interface SystemLine {
  kind: 'system';
  uuid: string;
  ts: number;
  subtype: string;
  durationMs: number | null;
}

/** Known transcript bookkeeping we deliberately don't consume (mode, ai-title,
 * last-prompt, ...). Kept as a counted variant, not dropped. */
export interface MetaLine {
  kind: 'meta';
  type: string;
}

/** A line whose type we have never seen. Surfaced in parse stats so format
 * drift is loud, never silent. [LAW:no-silent-failure] */
export interface UnknownLine {
  kind: 'unknown';
  type: string;
}

export type SessionLine =
  | AssistantLine
  | UserLine
  | AttachmentLine
  | SystemLine
  | MetaLine
  | UnknownLine;

const META_TYPES = new Set([
  'mode',
  'permission-mode',
  'last-prompt',
  'ai-title',
  'bridge-session',
  'file-history-snapshot',
  'file-history-delta',
  'queue-operation',
  'pr-link',
  'worktree-state',
  'relocated',
  'frame-link',
  'summary',
  'auto-mode',
  'date_change',
  // Found by the corpus smoke scan as UNKNOWN (197 and 20 occurrences), which is the
  // drift alarm working. Both are bookkeeping carrying no context-window content and no
  // usage — `{type:"agent-name", agentName:"ci configuration check"}` and
  // `{type:"agent-setting", agentSetting:"claude"}` — so they are known-and-ignored
  // rather than unknown. Left in the unknown bucket they would fire the format-drift
  // warning on every affected session, and an alarm that cries wolf on benign types is
  // how a real drift gets scrolled past.
  'agent-name',
  'agent-setting',
]);

type Json = Record<string, unknown>;

const asObj = (v: unknown): Json | null =>
  typeof v === 'object' && v !== null ? (v as Json) : null;

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' ? v : fallback);

/** Size of any value once serialized into the context window. */
const jsonChars = (v: unknown): number => {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'string') return v.length;
  try {
    return JSON.stringify(v).length;
  } catch {
    return 0;
  }
};

const SNIPPET_LEN = 200;
const snip = (s: string): string => s.slice(0, SNIPPET_LEN);

/** How much of a tool input's text we retain. An `Agent` prompt can run to tens of
 * kilobytes and is held for every call of every session in a corpus scan; classifier
 * rules only ever look at the head of a command. `inputChars` still records the true
 * size, so the cap costs no accounting accuracy. */
const INPUT_TEXT_CAP = 4000;

function parseBlock(raw: unknown): ContentBlock {
  const b = asObj(raw);
  if (!b) return { kind: 'other', type: 'malformed', chars: jsonChars(raw) };
  switch (b.type) {
    case 'thinking':
      return { kind: 'thinking', chars: jsonChars(b.thinking) };
    case 'text': {
      const text = str(b.text);
      return { kind: 'text', chars: text.length, snippet: snip(text) };
    }
    case 'tool_use':
      return {
        kind: 'tool_use',
        id: str(b.id),
        name: str(b.name, '(unnamed)'),
        inputChars: jsonChars(b.input),
        input: toolInputText(asObj(b.input) ?? {}).slice(0, INPUT_TEXT_CAP),
      };
    case 'tool_result':
      return { kind: 'tool_result', toolUseId: str(b.tool_use_id), chars: jsonChars(b.content) };
    default:
      return { kind: 'other', type: str(b.type, '?'), chars: jsonChars(b) };
  }
}

/** The one field of a tool input that says what the call is doing. Ordered most
 * specific first, so a Bash call reports its command rather than its description. */
function toolInputText(input: Json): string {
  const first =
    str(input.command) ||
    str(input.file_path) ||
    str(input.pattern) ||
    str(input.query) ||
    str(input.description) ||
    str(input.prompt) ||
    str(input.skill) ||
    '';
  return first || `${jsonChars(input)} chars`;
}

/** The usage vector, plus the rival account of cache creation the same block carried.
 *
 * The API states cache creation twice in one block: once as a flat
 * `cache_creation_input_tokens`, and once as a `cache_creation` object broken out per TTL
 * tier. Two maps of one fact, and a map that can drift will. [FRAMING:representation] */
interface ParsedUsage {
  usage: Usage;
  cacheCreation: CacheCreation;
}

/** Which account of cache creation `usage.cacheCreation` came from, and the rival figure
 * where there was one.
 *
 * [LAW:types-are-the-program] A union rather than a `flatTotal` beside a
 * `hasBreakdown: boolean`, because the pair admits a state the API cannot produce — a
 * rival total on a block that stated no rival — and every consumer would then have to
 * remember which field licenses the other. Here the rival figure is unreachable until
 * you have discriminated, so "is this a real comparison or nothing to compare" is
 * answered by the compiler rather than by a convention. */
export type CacheCreation =
  /** No `cache_creation` object: the flat field is the only map, and `usage.cacheCreation`
   * carries it. Never observed on this laptop's 155,364 usage blocks, all of which carry a
   * breakdown — but the field was added to the API at some point, and the deployment
   * target's corpus is one nobody here can see (miser-portability-adi.4). */
  | { kind: 'flat-only' }
  /** A `cache_creation` object was present and `usage.cacheCreation` is its total.
   * `flatTotal` is the flat field beside it — the rival map, read nowhere else in the
   * pipeline, which is what lets `cache-creation-accounted` close the costed figure
   * against a number the pipeline does not derive from. */
  | { kind: 'tiered'; flatTotal: number };

/** WHICH MAP IS AUTHORITATIVE, and why it is the breakdown. [LAW:one-source-of-truth]
 *
 * Measured over every raw assistant usage block on this laptop (155,364 blocks, scanned
 * without any of this pipeline's code): the flat field reports cache-creation tokens that
 * no tier claims on ZERO blocks, while the breakdown reports tokens the flat field omits
 * on 8 — every one of them a `flat: 0` beside a non-zero `ephemeral_1h_input_tokens`,
 * i.e. the flat total sporadically dropping a whole 1h-tier write. So the disagreement
 * runs one way only: the flat field is a sometimes-lossy summary, never a superset.
 *
 * The structural argument agrees with the measurement and outlives it: a sum is always
 * derivable from its parts, and the parts are never recoverable from the sum. Costing
 * from the breakdown can only ever be at least as complete as costing from the flat
 * field, whatever tiers Anthropic adds next. */
function parseUsage(raw: unknown): ParsedUsage {
  const u = asObj(raw) ?? {};
  const flatTotal = num(u.cache_creation_input_tokens);
  // EVERY numeric member is summed, not the two tier names observed so far. A tier this
  // parser has never heard of must not become invisible by virtue of being unnamed here —
  // which is why reading the breakdown needs no update when a third TTL ships, and why
  // the drift the flat field showed cannot recur on this side.
  const tiers = asObj(u.cache_creation);
  // The figure and its provenance are chosen TOGETHER, in one expression, so a
  // `usage.cacheCreation` taken from one map cannot end up labelled with the other. Two
  // ternaries on `tiers` would have left that agreement to whoever edits them next.
  // [LAW:one-source-of-truth]
  const [costed, provenance]: [number, CacheCreation] = tiers
    ? [Object.values(tiers).reduce((a: number, v) => a + num(v), 0), { kind: 'tiered', flatTotal }]
    : [flatTotal, { kind: 'flat-only' }];
  return {
    usage: {
      input: num(u.input_tokens),
      cacheCreation: costed,
      cacheRead: num(u.cache_read_input_tokens),
      output: num(u.output_tokens),
    },
    cacheCreation: provenance,
  };
}

/** Parse one JSONL line's decoded JSON into a typed record. Total: every input
 * maps to some variant — malformed shapes land in Unknown, not exceptions,
 * because one bad line must not sink a 400MB corpus scan. */
export function parseLine(raw: unknown): SessionLine {
  const o = asObj(raw);
  if (!o) return { kind: 'unknown', type: '(not an object)' };
  const type = str(o.type, '(untyped)');
  const ts = Date.parse(str(o.timestamp)) || 0;
  const uuid = str(o.uuid);

  switch (type) {
    case 'assistant': {
      const msg = asObj(o.message) ?? {};
      const content = Array.isArray(msg.content) ? msg.content : [];
      const parsed = parseUsage(msg.usage);
      return {
        kind: 'assistant',
        uuid,
        ts,
        // Older/synthetic lines can lack requestId; message.id is the same
        // per-response constant, uuid the last resort (degrades to no dedup).
        requestId: str(o.requestId) || str(msg.id) || uuid,
        model: str(msg.model, '(unknown-model)'),
        usage: parsed.usage,
        cacheCreation: parsed.cacheCreation,
        blocks: content.map(parseBlock),
      };
    }
    case 'user': {
      const msg = asObj(o.message) ?? {};
      const content = msg.content;
      const blocks: ContentBlock[] =
        typeof content === 'string'
          ? [{ kind: 'text', chars: content.length, snippet: snip(content) }]
          : Array.isArray(content)
            ? content.map(parseBlock)
            : [];
      const tur = asObj(o.toolUseResult);
      const isToolResult = blocks.some((b) => b.kind === 'tool_result');
      const firstText = blocks.find((b) => b.kind === 'text');
      return {
        kind: 'user',
        uuid,
        ts,
        blocks,
        agentId: tur ? str(tur.agentId) || null : null,
        isToolResult,
        snippet: firstText?.kind === 'text' ? firstText.snippet : '',
      };
    }
    case 'attachment': {
      const att = asObj(o.attachment) ?? {};
      return {
        kind: 'attachment',
        uuid,
        ts,
        attachmentType: str(att.type, '?'),
        chars: jsonChars(att),
      };
    }
    case 'system':
      return {
        kind: 'system',
        uuid,
        ts,
        subtype: str(o.subtype, '?'),
        durationMs: typeof o.durationMs === 'number' ? o.durationMs : null,
      };
    default:
      return META_TYPES.has(type) ? { kind: 'meta', type } : { kind: 'unknown', type };
  }
}

/** What the checkpoint saw, so format drift is loud rather than silent.
 *
 * PROJECT.md names the unknown-type counter as the early-warning system for Claude
 * Code version drift: a new line type appears here as a count long before it appears
 * downstream as a wrong number. [LAW:no-silent-failure] */
export interface ParseStats {
  totalLines: number;
  /** Count per typed variant — how many assistant/user/attachment/... records. */
  byKind: Record<SessionLine['kind'], number>;
  /** Count per raw `type` string, including the ones we map to meta/unknown. */
  byType: Record<string, number>;
  /** Raw `type` values we have no variant for. Non-empty means the format moved. */
  unknownTypes: Record<string, number>;
  /** Lines that were not valid JSON at all. */
  unparseableLines: number;
}

const emptyStats = (): ParseStats => ({
  totalLines: 0,
  byKind: { assistant: 0, user: 0, attachment: 0, system: 0, meta: 0, unknown: 0 },
  byType: {},
  unknownTypes: {},
  unparseableLines: 0,
});

const bump = (m: Record<string, number>, k: string): void => {
  m[k] = (m[k] ?? 0) + 1;
};

export interface Transcript {
  lines: SessionLine[];
  stats: ParseStats;
  /** The directory the session was working in, as the transcript itself reports it:
   * the FIRST `cwd` any line carries.
   *
   * First rather than last, because `cwd` follows the agent — a `cd` inside a Bash call
   * moves it for every subsequent line — so later values name subdirectories the work
   * wandered into, while the first names the directory the session was opened in. That
   * is the one Claude Code derives the project directory's name from.
   *
   * `null` when no line carried one, which is a fact about the transcript rather than a
   * failure: bookkeeping-only lines (`mode`, `summary`, `last-prompt`) have no `cwd`, so
   * a transcript made of nothing else has no working directory to report. Left as a
   * typed absence for `workspaceOf` to resolve, rather than defaulted to a string that
   * would read like an answer. [LAW:no-silent-failure] */
  cwd: string | null;
}

/** Parse a whole transcript's text into records plus the stats about them.
 *
 * [LAW:effects-at-boundaries] Takes the text, not a path. Reading the file is the
 * driver's job, which keeps this — and therefore the entire analysis above it —
 * testable against a string literal with no filesystem at all. */
export function parseTranscript(text: string): Transcript {
  const stats = emptyStats();
  const lines: SessionLine[] = [];
  let cwd: string | null = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    stats.totalLines++;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      stats.unparseableLines++;
      continue;
    }
    const o = asObj(decoded);
    const line = parseLine(decoded);
    lines.push(line);
    stats.byKind[line.kind]++;
    bump(stats.byType, str(o?.type, '(untyped)'));
    if (line.kind === 'unknown') bump(stats.unknownTypes, line.type);
    // `cwd` is a fact about the TRANSCRIPT, not about any one record, so it is read here
    // rather than threaded through four line variants that would each carry it and
    // oblige every consumer to hunt for the first one holding a value.
    cwd ??= str(o?.cwd) || null;
  }
  return { lines, stats, cwd };
}
