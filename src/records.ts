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

function parseUsage(raw: unknown): Usage {
  const u = asObj(raw) ?? {};
  return {
    input: num(u.input_tokens),
    cacheCreation: num(u.cache_creation_input_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    output: num(u.output_tokens),
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
      return {
        kind: 'assistant',
        uuid,
        ts,
        // Older/synthetic lines can lack requestId; message.id is the same
        // per-response constant, uuid the last resort (degrades to no dedup).
        requestId: str(o.requestId) || str(msg.id) || uuid,
        model: str(msg.model, '(unknown-model)'),
        usage: parseUsage(msg.usage),
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
