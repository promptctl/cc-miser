// [LAW:parse-dont-validate] The single checkpoint where raw JSONL becomes typed
// records. Everything downstream consumes SessionLine and never re-checks shape.
// [LAW:types-are-the-program] The union below is the strongest theorem we can
// state about the transcript format observed in the wild (CC 2.1.x): every line
// kind we consume is a distinct variant; every line kind we don't is still
// represented (Meta/Unknown) so nothing vanishes silently.

/** A content block inside an assistant or user message, reduced to what token
 * accounting needs: its kind, its size in characters, and linkage ids. */
export type ContentBlock =
  | { kind: 'thinking'; chars: number }
  | { kind: 'text'; chars: number; snippet: string }
  | { kind: 'tool_use'; id: string; name: string; inputChars: number; inputSummary: string }
  | { kind: 'tool_result'; toolUseId: string; chars: number }
  | { kind: 'other'; type: string; chars: number };

/** Exact token usage as reported by the API for one request. */
export interface Usage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}

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
  /** Set when this line delivers a subagent's result back to a Task tool call. */
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
        inputSummary: snip(summarizeToolInput(str(b.name), asObj(b.input) ?? {})),
      };
    case 'tool_result':
      return { kind: 'tool_result', toolUseId: str(b.tool_use_id), chars: jsonChars(b.content) };
    default:
      return { kind: 'other', type: str(b.type, '?'), chars: jsonChars(b) };
  }
}

/** One human-meaningful line per tool call, for span labels. */
function summarizeToolInput(name: string, input: Json): string {
  const first =
    str(input.command) ||
    str(input.file_path) ||
    str(input.pattern) ||
    str(input.query) ||
    str(input.description) ||
    str(input.prompt) ||
    str(input.skill) ||
    '';
  return first || jsonChars(input).toString() + ' chars';
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
