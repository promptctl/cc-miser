// What the CLI was told on the command line.
//
// [LAW:decomposition] Its own module, for the reason `src/report/args.ts` used to give
// and this file inherits: the command driver performs I/O the moment it is imported, so
// a test that wanted to check the argument rules got a report of the developer's own
// machine. Parsing a command line is a separate, pure job, and separating it is what
// makes it checkable.
//
// [LAW:parse-dont-validate] The one crossing where `string[]` becomes `Command`.
// Everything downstream takes `Command` and never re-inspects `process.argv` — and,
// because a `--since` has already become a predicate here, never re-parses a date
// either. The failure arm is loud: every unrecognised, value-less or malformed argument
// throws with the usage text attached.

import { byProject, since as modifiedSince, type SessionSource } from '../discover.ts';

export const USAGE = `usage: miser <command> [options]

commands:
  help      this text
  list      one row per in-scope session, tab-separated, on stdout
  trace     the span tree of every in-scope session, as JSON, on stdout
  report    the HTML report and corpus.json, written into --out

options:
  --projects <dir>      the Claude Code projects directory to scan
                        (default: this machine's ~/.claude/projects)
  --project <regex>     keep sessions whose project directory matches
  --session <prefix>    keep sessions whose id starts with this
  --since <YYYY-MM-DD>  keep sessions modified on or after this date
  --limit <n>           keep at most this many, most recently modified first
  --out <dir>           where report writes its files (report only, default: out)`;

/** A scope narrowing, carrying its own description.
 *
 * [LAW:one-source-of-truth] The description is produced by the same expression that
 * produces the predicate, so "what did this run actually look at" is answered from the
 * filter itself rather than from a sentence somewhere else that has to be remembered
 * when the filter changes. `select()` in the report driver earns its headline the same
 * way, and for the same reason. */
export interface Filter {
  describe: string;
  keep: (s: SessionSource) => boolean;
}

/** Which sessions a command is about.
 *
 * [LAW:composability] A list of predicate VALUES, not a bag of optional criteria fields
 * every consumer would have to interpret. `discover.ts` deliberately takes no filter
 * parameters for the same reason; this is that decision carried up to the command line,
 * so a future scope is a new row in `FLAGS` rather than a new field here and a new
 * branch in every command. */
export interface Scope {
  /** An explicit projects root, or null to use this machine's Claude Code directory. */
  projects: string | null;
  filters: readonly Filter[];
  /** A cap, or null for no cap. Distinct values because "show me everything" and "show
   * me some number" are different requests, and a sentinel like 0 or Infinity would
   * make them the same one. */
  limit: number | null;
}

/** [LAW:types-are-the-program] `out` exists on the one command that writes files and on
 * no other, so "where does `list` write its directory to" is not a question anyone can
 * ask. The alternative — one `Args` shape with an `out` every command carries and two of
 * them ignore — is an illegal state left representable, and the flag-legality check
 * below would have nothing to enforce. */
export type Command =
  /** Print the usage text and stop. Carries no scope, because it is a question about
   * the tool rather than about a corpus — and a `help` that reached discovery would
   * walk 490 transcripts to print a paragraph. */
  | { kind: 'help' }
  | { kind: 'list'; scope: Scope }
  | { kind: 'trace'; scope: Scope }
  | { kind: 'report'; scope: Scope; out: string; renderLimit: number };

export const DEFAULT_OUT = 'out';

/** What `report` renders when nobody says. The figure the report has always used.
 *
 * WHY THE CAP LIVES IN A DIFFERENT FIELD FOR `report`. `--limit` means one thing
 * everywhere — at most this many sessions in the output — but `report` narrows the set
 * a second time after scoping (a transcript-length band and a per-project cap, in
 * `select()`), and a cap applied BEFORE that narrowing is a different request: it would
 * take the 24 most recent, then render whichever handful of those survived the band.
 * So the number rides to whichever step narrows last, and `scope.limit` stays null on
 * the command that has a later step. [LAW:types-are-the-program] Two fields, because
 * they are consumed at two different places; a single field would leave "applied twice"
 * representable. */
export const DEFAULT_RENDER_LIMIT = 24;

const positiveInt = (flag: string, raw: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`\`${flag}\` needs a positive whole number, got \`${raw}\`.\n\n${USAGE}`);
  return value;
};

/** A date at the start of its day, UTC.
 *
 * [LAW:no-silent-failure] `Date.parse` answers `NaN` for gibberish, and an unchecked
 * NaN becomes a comparison that is false for every session — an empty result that looks
 * exactly like "nothing matched" and means "your date was nonsense". */
function epochOf(raw: string): number {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms))
    throw new Error(
      `\`--since\` needs a date, got \`${raw}\`. Try a plain \`YYYY-MM-DD\`.\n\n${USAGE}`,
    );
  return ms;
}

function regexOf(raw: string): RegExp {
  try {
    return new RegExp(raw);
  } catch (e) {
    throw new Error(
      `\`--project\` needs a regular expression, got \`${raw}\`: ` +
        `${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`,
    );
  }
}

/** Everything the flags accumulate into before a command claims it. */
interface Draft {
  projects: string | null;
  filters: readonly Filter[];
  limit: number | null;
  out: string | null;
}

const EMPTY: Draft = { projects: null, filters: [], limit: null, out: null };

const withFilter = (d: Draft, f: Filter): Draft => ({ ...d, filters: [...d.filters, f] });

/** How an argument is recognised, as a TABLE.
 *
 * [LAW:dataflow-not-control-flow] A new option is a new ROW, in the same idiom
 * `ORIGIN_RULES` uses in `calls.ts` and the old report parser used before it — never
 * another arm of a growing `if`. Each row is a pure `value -> (draft -> draft)`, so the
 * fold below has no knowledge of any particular flag. */
const FLAGS: Record<string, (value: string) => (d: Draft) => Draft> = {
  '--projects': (v) => (d) => ({ ...d, projects: v }),
  '--out': (v) => (d) => ({ ...d, out: v }),
  '--limit': (v) => (d) => ({ ...d, limit: positiveInt('--limit', v) }),
  '--project': (v) => (d) =>
    withFilter(d, { describe: `project matches /${v}/`, keep: byProject(regexOf(v)) }),
  '--since': (v) => (d) =>
    withFilter(d, { describe: `modified on or after ${v}`, keep: modifiedSince(epochOf(v)) }),
  '--session': (v) => (d) =>
    withFilter(d, {
      describe: `session id starts with ${v}`,
      keep: (s) => s.sessionId.startsWith(v),
    }),
};

const SCOPE_FLAGS = ['--projects', '--project', '--session', '--since', '--limit'] as const;

/** What each command is called, what it will accept, and how it is built.
 *
 * [LAW:dataflow-not-control-flow] The whole command set is data. Adding `stratigraphy`
 * later is one row, and the driver's dispatch stays the same shape it is now. */
interface CommandSpec {
  accepts: readonly string[];
  build: (d: Draft, scope: Scope) => Command;
}

/** Keyed by the union's own tag, so the table cannot describe a command that does not
 * exist and cannot omit one that does — the compiler checks the set both ways.
 * [LAW:types-are-the-program] */
const COMMANDS: Record<Command['kind'], CommandSpec> = {
  help: { accepts: [], build: () => ({ kind: 'help' }) },
  list: { accepts: SCOPE_FLAGS, build: (_d, scope) => ({ kind: 'list', scope }) },
  trace: { accepts: SCOPE_FLAGS, build: (_d, scope) => ({ kind: 'trace', scope }) },
  report: {
    accepts: [...SCOPE_FLAGS, '--out'],
    build: (d, scope) => ({
      kind: 'report',
      scope: { ...scope, limit: null },
      out: d.out ?? DEFAULT_OUT,
      renderLimit: d.limit ?? DEFAULT_RENDER_LIMIT,
    }),
  },
};

export const COMMAND_NAMES = Object.keys(COMMANDS) as readonly Command['kind'][];

/** The one place an untrusted string is admitted as a command name.
 *
 * [LAW:parse-dont-validate] The cast lives here and nowhere else: everything past this
 * function holds a `CommandSpec` or has already thrown, so no caller re-checks whether
 * a name was real. */
const commandNamed = (name: string): CommandSpec | undefined =>
  (COMMANDS as Record<string, CommandSpec | undefined>)[name];

/** Turn a command line into the one command it names.
 *
 * [LAW:no-silent-failure] Everything unrecognised throws. A flag accepted by one command
 * and quietly ignored by another is the worst of the failures available here: `miser
 * list --out /tmp/x` would report success, write nothing to `/tmp/x`, and give its user
 * no reason to doubt that it had. So legality is per command, checked against the table
 * above, and the message names both the flag and the command that refused it. */
/** The spellings that mean "tell me how to use this".
 *
 * Asking for help is not a mistake, so it does not exit like one: `miser --help` prints
 * to stdout and exits OK, where `miser --hlep` prints to stderr and exits USAGE. A tool
 * that answers the former with an error teaches its user that it is hostile. */
const HELP_TOKENS = new Set(['help', '--help', '-h']);

export function readArgs(argv: readonly string[]): Command {
  const [first, ...rest] = argv;
  if (first === undefined) throw new Error(`no command given.\n\n${USAGE}`);
  // Aliased to the command NAME rather than short-circuited to a result, so `help` goes
  // through the same flag-legality loop as everything else. Returning early here made
  // `miser help --limit 3` accept and ignore the flag — the silent no-op that loop
  // exists to prevent, reintroduced by the one command that skipped it.
  const name = HELP_TOKENS.has(first) ? 'help' : first;
  const command = commandNamed(name);
  if (!command)
    throw new Error(
      `unrecognised command \`${name}\`. Expected one of ${COMMAND_NAMES.join(', ')}.\n\n${USAGE}`,
    );

  let draft = EMPTY;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i]!;
    const read = FLAGS[flag];
    if (!read) throw new Error(`unrecognised argument \`${flag}\`.\n\n${USAGE}`);
    if (!command.accepts.includes(flag))
      throw new Error(
        `\`${flag}\` is not an option of \`${name}\`. ` +
          `It applies to: ${COMMAND_NAMES.filter((n) => COMMANDS[n].accepts.includes(flag)).join(', ')}.` +
          `\n\n${USAGE}`,
      );
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`\`${flag}\` needs a value.\n\n${USAGE}`);
    draft = read(value)(draft);
  }

  return command.build(draft, {
    projects: draft.projects,
    filters: draft.filters,
    limit: draft.limit,
  });
}

/** Apply a scope to what discovery found.
 *
 * [LAW:one-source-of-truth] Lives beside the type it applies, so every command narrows
 * the corpus by the same rule and in the same order, and the description it returns is
 * derived from the filters that ran rather than written out a second time by a caller.
 *
 * Ordered most-recently-modified first BEFORE the cap, so `--limit 5` means the five
 * newest rather than five arbitrary ones — a cap over an unspecified order is a result
 * nobody can reproduce. */
export function applyScope(
  sources: readonly SessionSource[],
  scope: Scope,
): { picked: SessionSource[]; criteria: string[] } {
  const criteria: string[] = [];
  const kept = scope.filters.reduce<SessionSource[]>((acc, f) => {
    const next = acc.filter(f.keep);
    // Counted, never estimated, and stated at zero as well — "excluded 0" and a missing
    // line are different facts, and only one of them is evidence the filter is idle.
    criteria.push(`${f.describe} — excluded ${acc.length - next.length} of ${acc.length}`);
    return next;
  }, [...sources]);

  const ordered = kept.sort((a, b) => b.mtime - a.mtime);
  const picked = scope.limit === null ? ordered : ordered.slice(0, scope.limit);
  if (scope.limit !== null)
    criteria.push(
      `--limit ${scope.limit}, most recently modified first — left ` +
        `${ordered.length - picked.length} eligible sessions unexamined`,
    );
  return { picked, criteria };
}
