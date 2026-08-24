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
  DEFAULT_OUT,
  DEFAULT_RENDER_LIMIT,
  USAGE,
  applyScope,
  readArgs,
  type Scope,
} from '../src/cli/args.ts';
import { COLUMNS, listRow, toTsv } from '../src/cli/list.ts';
import { EXIT, run, type Streams } from '../src/cli/main.ts';
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
    for (const flag of ['--projects', '--project', '--session', '--since', '--limit', '--out'])
      expect(USAGE).toContain(flag);
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
    expect(() => readArgs(['reprot'])).toThrow(/list, trace, report/);
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
function corpus(): { root: string; rt: () => { rt: Runtime; out: () => string; err: () => string } } {
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
      return {
        rt: {
          env: {},
          streams,
          now: 1_700_000_000_000,
          read: (p: string) => readFileSync(p, 'utf8'),
        },
        out: () => out,
        err: () => err,
      };
    },
  };
}

type Runtime = Parameters<typeof run>[1];

describe('a command run end to end keeps its two streams apart', () => {
  const { root, rt } = corpus();

  test('list writes rows to stdout and its summary to stderr', () => {
    const t = rt();
    expect(run(readArgs(['list', '--projects', root]), t.rt)).toBe(EXIT.OK);
    const lines = t.out().trimEnd().split('\n');
    expect(lines[0]).toBe(COLUMNS.join('\t'));
    expect(lines).toHaveLength(3); // header plus two sessions
    // Nothing conversational on stdout: a pipe reading this gets rows and only rows.
    expect(t.out()).not.toContain('scanning');
    expect(t.err()).toContain('scanning');
    expect(t.err()).toContain('2 sessions');
  });

  test('a scope reaches the walk, not just the predicate', () => {
    const t = rt();
    expect(run(readArgs(['list', '--projects', root, '--project', 'beta']), t.rt)).toBe(EXIT.OK);
    expect(t.out().trimEnd().split('\n')).toHaveLength(2);
    expect(t.out()).toContain('beta');
    expect(t.out()).not.toContain('alpha');
  });

  test('a scope that matches nothing exits EMPTY rather than looking like success', () => {
    // The failure this prevents: a script processing zero sessions believing it
    // processed a corpus.
    const t = rt();
    expect(run(readArgs(['list', '--projects', root, '--project', 'nonesuch']), t.rt)).toBe(
      EXIT.EMPTY,
    );
    expect(t.out()).toBe('');
    expect(t.err()).toContain('no sessions matched');
  });

  test('trace writes one parseable document, whatever else was printed', () => {
    const t = rt();
    expect(run(readArgs(['trace', '--projects', root]), t.rt)).toBe(EXIT.OK);
    const doc = JSON.parse(t.out());
    expect(doc.schema).toBe(SCHEMA);
    expect(doc.sessions).toHaveLength(2);
    expect(doc.projectsRoot).toBe(root);
  });

  test('report writes its files and names them on stdout', () => {
    const t = rt();
    const out = join(root, 'report-out');
    expect(run(readArgs(['report', '--projects', root, '--out', out]), t.rt)).toBe(EXIT.OK);
    const written = t.out().trimEnd().split('\n');
    expect(written).toEqual([join(out, 'index.html'), join(out, 'corpus.json')]);
    expect(readFileSync(written[0]!, 'utf8')).toContain('<!doctype html>');
    expect(JSON.parse(readFileSync(written[1]!, 'utf8')).generatedAt).toBe(1_700_000_000_000);
  });

  test('the page states the scope it was given, not just its own heuristic', () => {
    // [LAW:one-source-of-truth] One list of criteria, holding both narrowings.
    const t = rt();
    const out = join(root, 'report-scoped');
    run(readArgs(['report', '--projects', root, '--project', 'alpha', '--out', out]), t.rt);
    const corpusJson = JSON.parse(readFileSync(join(out, 'corpus.json'), 'utf8'));
    expect(corpusJson.selection.criteria.join(' ')).toContain('project matches /alpha/');
    expect(corpusJson.selection.criteria.join(' ')).toContain('transcript length between');
  });
});
