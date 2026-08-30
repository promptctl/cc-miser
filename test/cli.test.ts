// The command line is a contract: which sessions a command is about, what lands on
// stdout, what lands on stderr, and what the exit code tells a script.
//
// [LAW:behavior-not-structure] Everything below asserts what a caller can observe — a
// parsed command, the rows in a stream, an exit code — never how the driver is wired
// internally. A different implementation of the same contract passes all of it.
//
// WHY A REAL DIRECTORY FOR THE END-TO-END CASES. Discovery is a filesystem walk, and
// the walk is half of what the scope flags act on. Driving `run` over a temp corpus
// exercises `--project`, `--session` and `--limit` against the thing they actually
// filter, rather than against a list handed straight to the predicate.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  COMMAND_NAMES,
  FLAG_NAMES,
  DEFAULT_OUT,
  DEFAULT_RENDER_LIMIT,
  USAGE,
  DEFAULT_ENDPOINT,
  applyScope,
  commandsAccepting,
  readArgs,
  type Scope,
} from '../src/cli/args.ts';
import { COLUMNS, listRow, toTsv, type ListRow } from '../src/cli/list.ts';
import { EXPORT_COLUMNS } from '../src/cli/otlp.ts';
import { EXIT, main, makePostJson, run, type Streams } from '../src/cli/main.ts';
import { SCHEMA, traceFile, traceNode } from '../src/cli/trace.ts';
import type { SessionSource } from '../src/discover.ts';
import { analyzeSession } from '../src/session.ts';
import { rollup } from '../src/spans.ts';
import { spend } from '../src/tokens.ts';
import {
  CORPUS_ROOT,
  assistantTurn,
  buildSession,
  userSays,
  type ConversationEvent,
  type SessionFixture,
  type SessionSpec,
} from './fixtures.ts';

/** The scope of a command that has one.
 *
 * Throws rather than widening the type: a test asking for the scope of `help` has
 * already failed, and should say so where it asked. [LAW:no-silent-failure] */
function scopeOf(argv: readonly string[]): Scope {
  const c = readArgs(argv);
  if (c.kind === 'help') throw new Error(`\`${argv[0]}\` carries no scope`);
  return c.scope;
}

/** Every command that is about a corpus — which is every command except `help`. */
const SCOPED = COMMAND_NAMES.filter((n) => n !== 'help');

describe('a command line is parsed into the one command it names', () => {
  test('every corpus command reads the scope flags', () => {
    for (const kind of SCOPED) {
      expect(readArgs([kind]).kind).toBe(kind);
      expect(scopeOf([kind, '--project', 'cc-miser', '--since', '2026-01-01']).filters.map((f) => f.describe)).toEqual([
        'project matches /cc-miser/',
        'modified on or after 2026-01-01',
      ]);
    }
  });

  test('asking for help is answered, not treated as a mistake', () => {
    for (const token of ['help', '--help', '-h']) expect(readArgs([token]).kind).toBe('help');
  });

  test('help takes no options, so a flag on it is still a usage error', () => {
    expect(() => readArgs(['help', '--limit', '3'])).toThrow(/not an option of `help`/);
  });

  test('a name inherited from Object.prototype is not a command', () => {
    // `COMMANDS` used to be read as an object literal, so `COMMANDS['constructor']`
    // answered the `Object` constructor — truthy, past the "unrecognised" check, and
    // dead on `command.build is not a function`. The contract is that every name that
    // is not a command is refused the same way, whatever `Object.prototype` calls it.
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty'])
      expect(() => readArgs([name])).toThrow(/unrecognised command/);
  });

  test('an inherited name is not an option either', () => {
    expect(() => readArgs(['list', 'constructor', 'x'])).toThrow(/unrecognised argument/);
  });

  test('the usage text lists every command and every option that exists', () => {
    // The guarantee PROJECT.md makes: the usage text is generated from the command
    // table, so a new row cannot leave it stale. Asserted on the observable text rather
    // than on how it is built. [LAW:behavior-not-structure]
    for (const name of COMMAND_NAMES) expect(USAGE).toContain(name);
    // Read from the same table `USAGE` is built from. A hand-copied list here would keep
    // passing after a new flag row was added, which is the exact drift this asserts
    // against. [LAW:one-source-of-truth]
    expect(FLAG_NAMES.length).toBeGreaterThan(0);
    for (const flag of FLAG_NAMES) expect(USAGE).toContain(flag);
  });

  test('the usage text says how report reads --limit differently', () => {
    // `--limit` means "the N most recent" on list and trace, and something else on
    // report. A help text that states only the first is wrong for one of three commands.
    expect(USAGE).toMatch(/--limit caps what is RENDERED/);
  });

  test('no command at all is a usage error, not a default', () => {
    // Defaulting to `report` would make the expensive command the one you get by
    // accident. [LAW:no-silent-failure]
    expect(() => readArgs([])).toThrow(/no command given/);
  });

  test('an unrecognised command names the ones that exist', () => {
    expect(() => readArgs(['reprot'])).toThrow(/unrecognised command/);
    // Read from the command table rather than spelled out, so adding a command updates
    // what this asserts instead of breaking it. [LAW:one-source-of-truth]
    expect(() => readArgs(['reprot'])).toThrow(new RegExp(COMMAND_NAMES.join(', ')));
  });

  test('an unrecognised flag stops the run', () => {
    // A typo'd flag that was ignored would produce a full, plausible artifact built
    // from the wrong scope, and its reader would have no reason to doubt it.
    expect(() => readArgs(['list', '--porject', 'x'])).toThrow(/unrecognised argument/);
  });

  test('a flag with no value stops the run', () => {
    expect(() => readArgs(['list', '--project'])).toThrow(/needs a value/);
  });

  test('a flag belonging to another command is refused, and says which', () => {
    // The failure this prevents: `miser list --out /tmp/x` succeeding, writing nothing
    // to /tmp/x, and reporting success.
    expect(() => readArgs(['list', '--out', '/tmp/x'])).toThrow(/not an option of `list`/);
    expect(() => readArgs(['list', '--out', '/tmp/x'])).toThrow(/applies to: report/);
  });

  test('malformed values stop the run where they are read', () => {
    expect(() => readArgs(['list', '--limit', 'lots'])).toThrow(/positive whole number/);
    expect(() => readArgs(['list', '--limit', '0'])).toThrow(/positive whole number/);
    // An unchecked NaN date compares false against every session — an empty result that
    // looks exactly like "nothing matched".
    expect(() => readArgs(['list', '--since', 'yesterday'])).toThrow(/needs a date/);
    expect(() => readArgs(['list', '--project', '('])).toThrow(/regular expression/);
  });

  test("report's limit caps what it renders, not what it scopes", () => {
    // The two are different steps: `report` narrows again after scoping, so a cap
    // applied first would render whichever handful survived the second narrowing.
    const c = readArgs(['report', '--limit', '3']);
    if (c.kind !== 'report') throw new Error('expected a report command');
    expect(c.renderLimit).toBe(3);
    expect(c.scope.limit).toBeNull();
    expect(c.out).toBe(DEFAULT_OUT);
    expect(readArgs(['report']).kind === 'report' && readArgs(['report'])).toMatchObject({
      renderLimit: DEFAULT_RENDER_LIMIT,
    });
  });

  test("list's limit caps the sessions it lists", () => {
    expect(scopeOf(['list', '--limit', '3']).limit).toBe(3);
    expect(scopeOf(['list']).limit).toBeNull();
  });
});

const source = (over: Partial<SessionSource>): SessionSource => ({
  project: '-home-jdoe-src-alpha',
  sessionId: 'aaaa1111',
  path: '/corpus/-home-jdoe-src-alpha/aaaa1111.jsonl',
  bytes: 10,
  mtime: 1_000,
  subagents: [],
  unpaired: [],
  ...over,
});

describe('a scope narrows the corpus, and says what it excluded', () => {
  const sources = [
    source({ sessionId: 'a', project: '-src-alpha', mtime: 300 }),
    source({ sessionId: 'b', project: '-src-beta', mtime: 100 }),
    source({ sessionId: 'c', project: '-src-alpha', mtime: 200 }),
  ];

  test('no filters keep everything, and say nothing', () => {
    const { picked, criteria } = applyScope(sources, scopeOf(['list']));
    expect(picked).toHaveLength(3);
    expect(criteria).toEqual([]);
  });

  test('filters compose, and each states what it cost', () => {
    const { picked, criteria } = applyScope(sources, scopeOf(['list', '--project', 'alpha']));
    expect(picked.map((s) => s.sessionId)).toEqual(['a', 'c']);
    expect(criteria).toEqual(['project matches /alpha/ — excluded 1 of 3']);
  });

  test('a filter that excluded nothing still says so', () => {
    // "excluded 0" and a missing line are different facts, and only one of them is
    // evidence the filter is idle.
    const { criteria } = applyScope(sources, scopeOf(['list', '--project', 'src']));
    expect(criteria).toEqual(['project matches /src/ — excluded 0 of 3']);
  });

  test('a cap takes the most recently modified, and reports what it left', () => {
    // A cap over an unspecified order is a result nobody can reproduce.
    const { picked, criteria } = applyScope(sources, scopeOf(['list', '--limit', '2']));
    expect(picked.map((s) => s.sessionId)).toEqual(['a', 'c']);
    expect(criteria[0]).toContain('left 1 eligible sessions unexamined');
  });

  test('--session matches by prefix, so a short id from a list row is usable', () => {
    const { picked } = applyScope(sources, scopeOf(['list', '--session', 'b']));
    expect(picked.map((s) => s.sessionId)).toEqual(['b']);
  });
});

/** Turns that exist only to make the transcript long enough to be worth rendering.
 *
 * `select()` in the report driver keeps transcripts between 60 and 700 lines, on the
 * grounds that a two-line stub is not a session anybody wants on a page. A fixture
 * below that band is not a broken fixture — it is a session the report is right to
 * refuse — so the padding is here, named for what it is, rather than the band being
 * loosened to let a toy through. */
const padding = (n: number): ConversationEvent[] =>
  Array.from({ length: n }, (_, i) => [
    userSays(`follow-up ${i}`),
    assistantTurn({
      thinking: '',
      text: `Answering ${i}.`,
      tools: [
        {
          id: `toolu_pad_${i}`,
          name: 'Read',
          input: { file_path: `/src/file-${i}.ts` },
          result: 'export const x = 1;\n',
        },
      ],
      attachments: [],
      usage: { input: 1, cacheCreation: 100, cacheRead: 50, output: 20 },
    }),
  ]).flat();

/** A session with one spawned conversation, so every figure that distinguishes
 * agent-driven work from the rest has something to distinguish. */
const SPEC: SessionSpec = {
  sessionId: 'cli11111-2222-3333-4444-555555555555',
  project: '-home-jdoe-src-alpha',
  cwd: '/home/jdoe/src/alpha',
  model: 'claude-opus-5',
  root: [
    userSays('find where the parser lives'),
    assistantTurn({
      thinking: '',
      text: 'Searching.',
      tools: [
        { id: 'toolu_a', name: 'Grep', input: { pattern: 'parse' }, result: 'src/records.ts\n' },
      ],
      attachments: [],
      usage: { input: 10, cacheCreation: 2_000, cacheRead: 0, output: 300 },
    }),
    assistantTurn({
      thinking: '',
      text: 'Handing this to an explorer.',
      tools: [
        {
          id: 'toolu_spawn',
          name: 'Agent',
          input: { subagent_type: 'Explore', description: 'map the parser' },
          result: 'done',
        },
      ],
      attachments: [],
      usage: { input: 5, cacheCreation: 1_000, cacheRead: 2_000, output: 200 },
    }),
    ...padding(25),
  ],
  spawns: [
    {
      agentId: 'a_explore',
      agentType: 'Explore',
      description: 'map the parser',
      toolUseId: 'toolu_spawn',
      declaredDepth: 1,
      startMinute: 4,
      events: [
        userSays('map the parser'),
        assistantTurn({
          thinking: '',
          text: 'Read three files.',
          tools: [],
          attachments: [],
          usage: { input: 2, cacheCreation: 800, cacheRead: 100, output: 150 },
        }),
      ],
    },
  ],
};

const analyzed = analyzeSession(buildSession(SPEC).source, buildSession(SPEC).read);

describe('a list row is one session reduced to figures that stay exact', () => {
  const row = listRow(analyzed);

  test('the row counts every call, spawned ones included', () => {
    expect(row.calls).toBe(28);
    expect(row.spawnedCalls).toBe(1);
    expect(row.maxDepth).toBe(1);
  });

  test('the total is the tree rollup, not a second sum', () => {
    expect(row.tokEq).toBe(Math.round(spend(rollup(analyzed.tree))));
  });

  test('spawned spend is a slice of the total, never larger than it', () => {
    expect(row.spawnedTokEq).toBeGreaterThan(0);
    expect(row.spawnedTokEq).toBeLessThan(row.tokEq);
  });

  test('the workspace name comes from the transcript, not the flattened directory', () => {
    // The flattening is lossy and has no inverse, so a row naming the slug would be
    // naming a guess.
    expect(row.project).toBe('alpha');
  });

  test('the dollar figure is never shown without what it failed to cover', () => {
    expect(row).toHaveProperty('usd');
    expect(row).toHaveProperty('unpricedTokEq');
  });
});

describe('the tab-separated rows are the format, not a rendering of one', () => {
  test('the header is the column list, and every row has the same width', () => {
    const text = toTsv([listRow(analyzed)]);
    const [header, ...rows] = text.split('\n');
    expect(header).toBe(COLUMNS.join('\t'));
    for (const r of rows) expect(r!.split('\t')).toHaveLength(COLUMNS.length);
  });

  test('a tab inside a value cannot add a column', () => {
    const row = { ...listRow(analyzed), project: 'we\tird' };
    expect(toTsv([row]).split('\n')[1]!.split('\t')).toHaveLength(COLUMNS.length);
  });
});

describe('a trace file is the span tree, carrying what a consumer must know', () => {
  const file = traceFile([analyzed], '/corpus', ['project matches /alpha/'], 1_700_000_000_000);

  test('it declares its schema, so a consumer can refuse a shape it does not know', () => {
    expect(file.schema).toBe(SCHEMA);
  });

  test('it says which corpus it came from and what narrowed it', () => {
    expect(file.projectsRoot).toBe('/corpus');
    expect(file.criteria).toEqual(['project matches /alpha/']);
  });

  test("the pipeline's own notes travel with the data, not only to the HTML page", () => {
    // A consumer summing this file needs to know the tree it is summing had subagents
    // nobody could place. [LAW:no-silent-failure]
    expect(file.sessions[0]!.notes).toEqual(analyzed.notes);
  });

  test('every node carries its cost, and a parent is never cheaper than its children', () => {
    const check = (n: ReturnType<typeof traceNode>): void => {
      const kids = n.children.reduce((a, k) => a + k.tokEq, 0);
      expect(n.tokEq).toBeGreaterThanOrEqual(kids - 1); // -1 for per-node rounding
      n.children.forEach(check);
    };
    check(file.sessions[0]!.tree);
  });

  test('spawn depth reaches the node, so a consumer can group by it without the tree', () => {
    const depths = new Set<number>();
    const walk = (n: ReturnType<typeof traceNode>): void => {
      depths.add(n.depth);
      n.children.forEach(walk);
    };
    walk(file.sessions[0]!.tree);
    expect([...depths].sort()).toEqual([0, 1]);
  });
});

/** Write a fixture session into a real directory, at the paths discovery walks. */
function materialize(root: string, f: SessionFixture): void {
  const local = (p: string): string => join(root, p.slice(CORPUS_ROOT.length + 1));
  const files = [
    f.source.path,
    ...f.source.subagents.flatMap((s) => [s.transcriptPath, s.metaPath]),
  ];
  for (const p of files) {
    mkdirSync(dirname(local(p)), { recursive: true });
    writeFileSync(local(p), f.read(p));
  }
}

/** A corpus of two projects, on disk, and a runtime that captures both streams. */
function corpus(): {
  root: string;
  rt: () => {
    rt: Runtime;
    out: () => string;
    err: () => string;
    /** Every OTLP request the run made, captured instead of sent. */
    posts: () => readonly { url: string; json: string }[];
  };
} {
  const root = mkdtempSync(join(tmpdir(), 'cc-miser-cli-'));
  materialize(root, buildSession(SPEC));
  materialize(
    root,
    buildSession({
      ...SPEC,
      sessionId: 'bbbb2222-2222-3333-4444-555555555555',
      project: '-home-jdoe-src-beta',
      cwd: '/home/jdoe/src/beta',
      spawns: [],
    }),
  );
  return {
    root,
    rt: () => {
      let out = '';
      let err = '';
      const streams: Streams = { out: (t) => (out += t), err: (t) => (err += t) };
      // Every OTLP request the run made, captured instead of sent. The exporter is a pure
      // function and the socket is a parameter, so `otlp` is exercisable here with no
      // collector running and no mock library. [LAW:effects-at-boundaries]
      const posts: { url: string; json: string }[] = [];
      return {
        rt: {
          env: {},
          streams,
          now: 1_700_000_000_000,
          read: (p: string) => readFileSync(p, 'utf8'),
          post: async (url: string, json: string) => {
            posts.push({ url, json });
            return { status: 200, body: '{}' };
          },
        },
        posts: () => posts,
        out: () => out,
        err: () => err,
      };
    },
  };
}

type Runtime = Parameters<typeof run>[1];

describe('a command run end to end keeps its two streams apart', () => {
  const { root, rt } = corpus();

  test('list writes rows to stdout and its summary to stderr', async () => {
    const t = rt();
    expect(await run(readArgs(['list', '--projects', root]), t.rt)).toBe(EXIT.OK);
    const lines = t.out().trimEnd().split('\n');
    expect(lines[0]).toBe(COLUMNS.join('\t'));
    expect(lines).toHaveLength(3); // header plus two sessions
    // Nothing conversational on stdout: a pipe reading this gets rows and only rows.
    expect(t.out()).not.toContain('scanning');
    expect(t.err()).toContain('scanning');
    expect(t.err()).toContain('2 sessions');
  });

  test('a scope reaches the walk, not just the predicate', async () => {
    const t = rt();
    expect(await run(readArgs(['list', '--projects', root, '--project', 'beta']), t.rt)).toBe(EXIT.OK);
    expect(t.out().trimEnd().split('\n')).toHaveLength(2);
    expect(t.out()).toContain('beta');
    expect(t.out()).not.toContain('alpha');
  });

  test('a scope that matches nothing exits EMPTY rather than looking like success', async () => {
    // The failure this prevents: a script processing zero sessions believing it
    // processed a corpus.
    const t = rt();
    expect(await run(readArgs(['list', '--projects', root, '--project', 'nonesuch']), t.rt)).toBe(
      EXIT.EMPTY,
    );
    expect(t.out()).toBe('');
    expect(t.err()).toContain('no sessions matched');
  });

  test('trace writes one parseable document, whatever else was printed', async () => {
    const t = rt();
    expect(await run(readArgs(['trace', '--projects', root]), t.rt)).toBe(EXIT.OK);
    const doc = JSON.parse(t.out());
    expect(doc.schema).toBe(SCHEMA);
    expect(doc.sessions).toHaveLength(2);
    expect(doc.projectsRoot).toBe(root);
  });

  test('otlp posts every in-scope session and names its traces on stdout', async () => {
    const t = rt();
    expect(await run(readArgs(['otlp', '--projects', root]), t.rt)).toBe(EXIT.OK);

    // Two fixture sessions, two domains each. Read off the posted BODIES rather than off
    // the exporter, so this covers the wiring — that the driver posts what it printed.
    expect(t.posts()).toHaveLength(2);
    for (const p of t.posts()) {
      expect(p.url).toBe(DEFAULT_ENDPOINT);
      expect(JSON.parse(p.json).resourceSpans).toHaveLength(2);
    }

    const lines = t.out().trimEnd().split('\n');
    expect(lines[0]).toBe(EXPORT_COLUMNS.join('\t'));
    expect(lines).toHaveLength(5);
    for (const line of lines.slice(1))
      expect(line.split('\t')).toHaveLength(EXPORT_COLUMNS.length);
    expect(t.err()).toContain(`-> ${DEFAULT_ENDPOINT}`);
  });

  test('otlp posts where --endpoint says, not where the default says', async () => {
    const t = rt();
    const elsewhere = 'http://example.invalid:4318/v1/traces';
    expect(await run(readArgs(['otlp', '--projects', root, '--endpoint', elsewhere]), t.rt)).toBe(
      EXIT.OK,
    );
    expect(t.posts().map((p) => p.url)).toEqual([elsewhere, elsewhere]);
  });

  test('a collector that refuses a session fails the run and names it', async () => {
    const t = rt();
    const refusing = { ...t.rt, post: async () => ({ status: 503, body: 'collector down' }) };
    // Scoped to ONE session and asserted against that literal id. Run over both fixtures
    // and matched with a hex pattern, this passed only because the two sessions happen to
    // sort the way they do: `applyScope` orders most-recently-modified first, and of the
    // two ids only `bbbb2222` is hex — `cli11111` contains `l` and `i`. The assertion was
    // therefore standing on the mtimes of two writes rather than on any behaviour, and a
    // tie would have failed it while the naming worked perfectly.
    expect(await main(['otlp', '--projects', root, '--session', 'bbbb2222'], refusing)).toBe(
      EXIT.FAILED,
    );
    expect(t.err()).toContain('503');
    // The session is named — "the export failed" without which one is a report nobody can
    // act on.
    expect(t.err()).toContain('rejected session bbbb2222-2222-3333-4444-555555555555');
  });

  test('a collector that stores only part of a session is a failure, not a success', async () => {
    // OTLP/HTTP answers 200 and reports what it dropped in the body. Read only the status,
    // this prints a trace id and exits OK for a trace quietly missing spans — and the
    // person who follows that id finds a short trace with nothing pointing back here.
    const t = rt();
    const partial = {
      ...t.rt,
      post: async () => ({
        status: 200,
        body: JSON.stringify({ partialSuccess: { rejectedSpans: '3', errorMessage: 'too big' } }),
      }),
    };
    expect(await main(['otlp', '--projects', root], partial)).toBe(EXIT.FAILED);
    expect(t.err()).toContain('3 spans rejected');
    expect(t.err()).toContain('too big');
  });

  test('a collector that stored everything and warned is heard, and still succeeds', async () => {
    // OTLP documents `error_message` for warnings on a FULL success, not only for
    // explaining a rejection, so `rejectedSpans: 0` with a message is an ordinary answer.
    // Read through a two-state return it had nowhere to go: dropped as "nothing rejected",
    // or promoted to a failure on an export that completely succeeded. Both are wrong, and
    // this pins the third answer — the run survives AND the reader hears it.
    const t = rt();
    const warning = {
      ...t.rt,
      post: async () => ({
        status: 200,
        body: JSON.stringify({
          partialSuccess: { rejectedSpans: '0', errorMessage: 'queue is nearly full' },
        }),
      }),
    };
    expect(await main(['otlp', '--projects', root], warning)).toBe(EXIT.OK);
    expect(t.err()).toContain('queue is nearly full');
    // Named, so a warning on a multi-session run points at the session it is about.
    expect(t.err()).toMatch(/stored session [0-9a-z-]+ with a warning/);
  });

  test('a rejection spelled in snake_case is still a rejection', async () => {
    // proto3's JSON mapping requires a PARSER to accept both spellings; only emitters
    // choose, and a marshaler built with OrigName emits the snake_case one. Read under
    // camelCase alone, this body parses as "nothing rejected" and the run exits OK having
    // printed a trace id for a trace missing 7 spans — the failure the function exists to
    // prevent, reintroduced through a naming convention.
    const t = rt();
    const snake = {
      ...t.rt,
      post: async () => ({
        status: 200,
        body: JSON.stringify({
          partial_success: { rejected_spans: '7', error_message: 'attribute too long' },
        }),
      }),
    };
    expect(await main(['otlp', '--projects', root], snake)).toBe(EXIT.FAILED);
    expect(t.err()).toContain('7 spans rejected');
    expect(t.err()).toContain('attribute too long');
  });

  test('a rejected-span count that will not parse fails the run', async () => {
    // NOT a count of zero. Folded into "nothing dropped" this exits OK on the one answer
    // that says spans went missing AND cannot be interpreted; an export that cannot be
    // certified whole is not a success.
    const t = rt();
    const garbled = {
      ...t.rt,
      post: async () => ({
        status: 200,
        body: JSON.stringify({
          partialSuccess: { rejectedSpans: 'lots', errorMessage: 'dropped 4000 spans' },
        }),
      }),
    };
    expect(await main(['otlp', '--projects', root], garbled)).toBe(EXIT.FAILED);
    expect(t.err()).toContain('unreadable rejected-span count');
    expect(t.err()).toContain('dropped 4000 spans');
  });

  test('values that are not counts are not read as zero, and not read as counts either', async () => {
    // `Number()` answers for all of these and answers wrongly in BOTH directions:
    // `Number("")`, `Number(false)`, `Number([])` are 0 — so a body saying spans were
    // dropped exited OK — while `Number(true)` is 1 and `Number([5])` is 5, reporting
    // non-counts AS counts. The shape is what decides, not the coercion.
    for (const rejectedSpans of ['', ' ', '3.7', 'lots', true, false, [], [5], -1, 2.5]) {
      const t = rt();
      const odd = {
        ...t.rt,
        post: async () => ({
          status: 200,
          body: JSON.stringify({ partialSuccess: { rejectedSpans, errorMessage: 'dropped 4000 spans' } }),
        }),
      };
      expect(await main(['otlp', '--projects', root], odd)).toBe(EXIT.FAILED);
      expect(t.err()).toContain('unreadable rejected-span count');
    }
  });

  test('a count the collector really did send is still read, in both wire forms', async () => {
    // The other direction, so the shape test above cannot pass by rejecting everything:
    // int64 crosses OTLP/JSON as a digit string, and a plain JSON number is also legal.
    for (const rejectedSpans of ['7', 7]) {
      const t = rt();
      const real = {
        ...t.rt,
        post: async () => ({
          status: 200,
          body: JSON.stringify({ partialSuccess: { rejectedSpans, errorMessage: 'too big' } }),
        }),
      };
      expect(await main(['otlp', '--projects', root], real)).toBe(EXIT.FAILED);
      expect(t.err()).toContain('7 spans rejected');
    }
  });

  test('a null count is the field default, not an unreadable one', async () => {
    // proto3's JSON mapping defines JSON null on a scalar as the field's default, so this
    // says zero rejected — same as omitting the field, which is what protojson does with a
    // zero int64. Pinned because the shape test deliberately does NOT route it to the
    // unreadable arm, and that is a decision rather than an oversight.
    const t = rt();
    const nulled = {
      ...t.rt,
      post: async () => ({
        status: 200,
        body: JSON.stringify({ partialSuccess: { rejectedSpans: null, errorMessage: 'queue is nearly full' } }),
      }),
    };
    expect(await main(['otlp', '--projects', root], nulled)).toBe(EXIT.OK);
    expect(t.err()).toContain('queue is nearly full');
  });

  test('a count past 2^53 is echoed, not rounded', async () => {
    // `Number("9007199254740993")` is 9007199254740992. Reporting that back would hand the
    // operator a wrong figure from the one function whose job is never to do that.
    const t = rt();
    const huge = {
      ...t.rt,
      post: async () => ({
        status: 200,
        body: JSON.stringify({ partialSuccess: { rejectedSpans: '9007199254740993' } }),
      }),
    };
    expect(await main(['otlp', '--projects', root], huge)).toBe(EXIT.FAILED);
    expect(t.err()).toContain('9007199254740993 spans rejected');
  });

  test('an ordinary 200 is not read as a partial rejection', async () => {
    // The other direction, so the check above cannot pass by failing everything: a
    // collector that stored the lot answers `{}` or `{"partialSuccess":{}}`.
    for (const body of ['{}', '{"partialSuccess":{}}', '', 'not json at all']) {
      const t = rt();
      const ok = { ...t.rt, post: async () => ({ status: 200, body }) };
      expect(await main(['otlp', '--projects', root], ok)).toBe(EXIT.OK);
    }
  });

  test('sessions that landed before a failure still reach stdout', async () => {
    // The failure this guards: rows batched until the end are lost entirely when a later
    // session throws, so a run that posted three sessions and failed on the fourth leaves
    // no record of the three traces now sitting in Jaeger.
    const t = rt();
    let n = 0;
    const failsOnSecond = {
      ...t.rt,
      post: async (url: string, json: string) => {
        n += 1;
        t.rt.post(url, json);
        return n === 1 ? { status: 200, body: '{}' } : { status: 500, body: 'nope' };
      },
    };
    expect(await main(['otlp', '--projects', root], failsOnSecond)).toBe(EXIT.FAILED);
    const lines = t.out().trimEnd().split('\n');
    expect(lines[0]).toBe(EXPORT_COLUMNS.join('\t'));
    // The first session's two domains, and nothing for the one that failed.
    expect(lines).toHaveLength(3);
  });

  test('report writes its files and names them on stdout', async () => {
    const t = rt();
    const out = join(root, 'report-out');
    expect(await run(readArgs(['report', '--projects', root, '--out', out]), t.rt)).toBe(EXIT.OK);
    const written = t.out().trimEnd().split('\n');
    expect(written).toEqual([join(out, 'index.html'), join(out, 'corpus.json')]);
    expect(readFileSync(written[0]!, 'utf8')).toContain('<!doctype html>');
    expect(JSON.parse(readFileSync(written[1]!, 'utf8')).generatedAt).toBe(1_700_000_000_000);
  });

  test('the page states the scope it was given, not just its own heuristic', async () => {
    // [LAW:one-source-of-truth] One list of criteria, holding both narrowings.
    const t = rt();
    const out = join(root, 'report-scoped');
    await run(readArgs(['report', '--projects', root, '--project', 'alpha', '--out', out]), t.rt);
    const corpusJson = JSON.parse(readFileSync(join(out, 'corpus.json'), 'utf8'));
    expect(corpusJson.selection.criteria.join(' ')).toContain('project matches /alpha/');
    expect(corpusJson.selection.criteria.join(' ')).toContain('transcript length between');
  });

  test('a scoped report counts its scope separately from the machine', async () => {
    // The masthead asks "how much of what I asked for did you show me", and it can only
    // answer that if the scoped count is its own number rather than folded into either
    // neighbour.
    const t = rt();
    const out = join(root, 'report-inscope');
    await run(readArgs(['report', '--projects', root, '--project', 'alpha', '--out', out]), t.rt);
    const { selection } = JSON.parse(readFileSync(join(out, 'corpus.json'), 'utf8'));
    expect(selection.discovered).toBe(2);
    expect(selection.inScope).toBe(1);
    expect(selection.rendered).toBe(1);
  });

  test('an unscoped report has nothing to distinguish, and says so', async () => {
    const t = rt();
    const out = join(root, 'report-unscoped');
    await run(readArgs(['report', '--projects', root, '--out', out]), t.rt);
    const { selection } = JSON.parse(readFileSync(join(out, 'corpus.json'), 'utf8'));
    expect(selection.inScope).toBe(selection.discovered);
  });
});

describe('the exit codes are the contract they are documented to be', () => {
  // [LAW:behavior-not-structure] Asserted through `main`, which is what a shell sees.
  // `run` alone never exercises the mapping from a THROW to a code, so swapping the two
  // catch arms used to pass every test.
  const { root, rt } = corpus();

  test('a bad flag is USAGE, and nothing is read or written', async () => {
    const t = rt();
    expect(await main(['list', '--bogus', 'x'], t.rt)).toBe(EXIT.USAGE);
    expect(t.out()).toBe('');
    expect(t.err()).toContain('unrecognised argument');
    // A usage error must not have walked the corpus on its way to failing.
    expect(t.err()).not.toContain('scanning');
  });

  test('a misspelled flag in command position is reported as a command', async () => {
    // `miser --hlep` names no command, and the first token IS the command slot — so the
    // message says so rather than guessing that a flag was intended.
    const t = rt();
    expect(await main(['--hlep'], t.rt)).toBe(EXIT.USAGE);
    expect(t.err()).toContain('unrecognised command `--hlep`');
  });

  test('an unrecognised command is USAGE, not FAILED', async () => {
    const t = rt();
    expect(await main(['stratigraphy'], t.rt)).toBe(EXIT.USAGE);
  });

  test('a failure reading real input is FAILED, not USAGE', async () => {
    // The command line was valid; the pipeline broke. A script that retries on USAGE and
    // stops on FAILED can only be written if these stay different numbers.
    const t = rt();
    const exploding: Runtime = {
      ...t.rt,
      read: () => {
        throw new Error('transcript is not readable');
      },
    };
    expect(await main(['list', '--projects', root], exploding)).toBe(EXIT.FAILED);
    expect(t.err()).toContain('transcript is not readable');
  });

  test('a scope that matches nothing is EMPTY, distinct from both', async () => {
    const t = rt();
    expect(await main(['list', '--projects', root, '--session', 'nomatch'], t.rt)).toBe(EXIT.EMPTY);
  });

  test('help is OK and goes to stdout, because asking is not a mistake', async () => {
    const t = rt();
    expect(await main(['--help'], t.rt)).toBe(EXIT.OK);
    expect(t.out()).toContain('usage: miser');
  });
});

describe('one session is always one line of TSV', () => {
  // A POSIX directory name may legally contain a newline, and `project` is the last
  // segment of a real one. An un-stripped `\n` does not merely misplace a field — it
  // ends the row and starts another with the wrong column count, so one session is read
  // downstream as two malformed records.
  const rowWith = (project: string): ListRow => ({
    session: 'abc',
    project,
    started: '2026-01-01',
    wallMin: 1,
    calls: 1,
    spawnedCalls: 0,
    maxDepth: 0,
    tokEq: 1,
    spawnedTokEq: 0,
    usd: 0,
    unpricedTokEq: 0,
  });

  for (const [name, project] of [
    ['a newline', 'we\nird'],
    ['a carriage return', 'we\rird'],
    ['a tab', 'we\tird'],
    ['all three', 'a\tb\nc\rd'],
  ] as const) {
    test(`${name} in a project name cannot split the row`, () => {
      const lines = toTsv([rowWith(project)]).split('\n');
      expect(lines).toHaveLength(2); // header plus exactly one row
      expect(lines[1]!.split('\t')).toHaveLength(COLUMNS.length);
    });
  }
});

describe('a failure names the transcript that caused it', () => {
  const { root, rt } = corpus();

  // The EXIT.FAILED contract says the message on stderr names the transcript. Asserted
  // for every command, because the guarantee used to hold only for `report` — `list` and
  // `trace` called `analyzeSession` bare, so a throw from deep inside reached stderr with
  // nothing saying which of hundreds of scanned files it came from.
  //
  // Read from the command table rather than listed here, so "every command" stays true as
  // commands are added. Written out by hand it was already false the moment `otlp` landed:
  // the comment claimed every command and the array named three, so a fourth that dropped
  // the `naming(...)` wrap would have broken the contract with nothing to catch it.
  // [LAW:one-source-of-truth]
  for (const command of SCOPED) {
    test(`${command} says which file broke`, async () => {
      const t = rt();
      const exploding: Runtime = {
        ...t.rt,
        read: () => {
          throw new Error('malformed transcript');
        },
      };
      const argv = [command, '--projects', root, ...(command === 'report' ? ['--out', join(root, `o-${command}`)] : [])];
      expect(await main(argv, exploding)).toBe(EXIT.FAILED);
      expect(t.err()).toContain('malformed transcript');
      // The contract is that the message NAMES the transcript — not which stage did the
      // naming. `report` fails first in calibration, which has its own wrap and its own
      // wording; pinning the verb here would assert the wiring rather than the promise.
      expect(t.err()).toMatch(/\.jsonl/);
    });
  }
});

describe('a flag given an empty value is a usage error, not a filesystem error', () => {
  // An unset shell variable expands to nothing, and `--out ''` used to slip past
  // `d.out ?? DEFAULT_OUT` (an empty string is not nullish) to surface as a raw ENOENT
  // under EXIT.FAILED instead of the usage error every other bad value gets.
  for (const flag of FLAG_NAMES) {
    test(`${flag} rejects an empty value`, () => {
      // Which command to ask comes from the table that decides it, not from a map kept
      // here by hand: a hand-written one sends a command-specific flag to a command that
      // refuses it, and the test then passes on the wrong error — or fails for a reason
      // that has nothing to do with empty values. [LAW:one-source-of-truth]
      const command = commandsAccepting(flag)[0]!;
      expect(() => readArgs([command, flag, ''])).toThrow(/needs a value/);
    });
  }
});

describe('--since accepts the format it documents, and only that', () => {
  test('a plain YYYY-MM-DD is read as UTC midnight', () => {
    const s = scopeOf(['list', '--since', '2026-01-01']);
    expect(s.filters).toHaveLength(1);
  });

  test('a form Date.parse would read in the local zone is refused', () => {
    // These parse fine, and would silently shift the inclusion boundary by the machine's
    // UTC offset while the code still claimed start-of-day UTC.
    for (const raw of ['2026-01-01T10:00:00', 'January 1, 2026', '2026-1-1'])
      expect(() => readArgs(['list', '--since', raw])).toThrow(/needs a date as `YYYY-MM-DD`/);
  });

  test('gibberish is still refused', () => {
    expect(() => readArgs(['list', '--since', 'lastweek'])).toThrow(/needs a date/);
  });
});

describe('report writes to ./out when nobody says otherwise', () => {
  test('the default is relative to the current directory, by design', () => {
    // Documented rather than anchored: a globally installed `miser` anchored to its own
    // module would write into node_modules. The usage text has to say relative-to-what,
    // because "default: out" alone does not.
    expect(DEFAULT_OUT).toBe('out');
    expect(readArgs(['report']).kind).toBe('report');
    const c = readArgs(['report']);
    if (c.kind !== 'report') throw new Error('unreachable');
    expect(c.out).toBe(DEFAULT_OUT);
    expect(USAGE).toContain('relative to the current directory');
  });
});

// The one thing in this file that actually opens a socket. Everything else drives `run`
// with an injected `post`, which is what makes the commands testable — and what left the
// real edge with no test at all: moving the body read back outside its `try` reintroduced
// a bug the whole suite still passed. These drive `makePostJson` against sockets that fail
// in the three ways a collector does, so the naming is asserted rather than described.
describe('a failed export names the endpoint and the phase', () => {
  // Bun's own messages for these name none of it — "Unable to connect. Is the computer able
  // to access the url?", "The socket connection was closed unexpectedly…pass `verbose:
  // true`…", "The operation timed out." On a run exporting many sessions, each is
  // unactionable, and the middle one points at a `fetch` option the reader cannot reach.
  const listening = async (
    handle: (sock: import('node:net').Socket) => void,
  ): Promise<{ url: string; close: () => void }> => {
    const { createServer } = await import('node:net');
    const server = createServer(handle);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    return { url: `http://127.0.0.1:${addr.port}/v1/traces`, close: () => server.close() };
  };

  const HEADERS = 'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100\r\n\r\n{';

  test('a collector that is not there is named, not just "unable to connect"', async () => {
    // Port 1 is reserved and nothing listens on it, so this is the connect-phase failure.
    const post = makePostJson(2_000);
    // The bound is optional in the pattern on purpose: where a firewall DROPs rather
    // than refuses, this fails as a timeout and the message carries ` after 2s`. Pinning
    // its absence would fail for an environment reason rather than a behaviour one.
    await expect(post('http://127.0.0.1:1/v1/traces', '{}')).rejects.toThrow(
      /127\.0\.0\.1:1\/v1\/traces gave no response( after [\d.]+s)?: /,
    );
  });

  test('a collector that answers then drops the connection is named, and the phase is right', async () => {
    // `verify-otlp.ts` documents this backend doing exactly this — "closes connections
    // part-way through the body". It is NOT a timeout, so a catch that renamed only
    // TimeoutError let this one out bare; that is the gap this pins.
    // FIN after the request lands, never an RST on a timer. `destroy()` resets, and a
    // reset lets the peer discard data still unread in its receive buffer — which could
    // drop the very headers this asserts the client saw, flipping the phase for a timing
    // reason. `end(HEADERS)` writes then closes cleanly, and keying off `data` rather than
    // a 50ms timer removes the race entirely. [LAW:no-ambient-temporal-coupling]
    const { url, close } = await listening((sock) => {
      sock.once('data', () => sock.end(HEADERS));
    });
    try {
      await expect(makePostJson(5_000)(url, '{}')).rejects.toThrow(
        /\/v1\/traces answered, then failed before its body arrived: /,
      );
    } finally {
      close();
    }
  });

  test('a collector that answers then goes silent reports the bound, and does not claim it never answered', async () => {
    // It DID answer — 200 headers arrived — so "did not answer within 30s" would be false
    // and would send the reader to `--endpoint` when the spans may already be stored.
    const { url, close } = await listening((sock) => sock.write(HEADERS));
    try {
      await expect(makePostJson(400)(url, '{}')).rejects.toThrow(
        /answered, then failed before its body arrived after 0\.4s: /,
      );
    } finally {
      close();
    }
  });
});
