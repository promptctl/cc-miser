// The contract miser-portability-adi.3 exists to guarantee: nothing on the page depends
// on the machine that produced the corpus, and the page does not claim to cover more of
// that corpus than it read.
//
// [LAW:behavior-not-structure] These assert what a reader of the report gets — a project
// heading that names the project, a masthead whose coverage claim matches what was
// rendered, a scan that can be pointed somewhere else, an unknown flag that stops the
// run. Any implementation with those properties passes; the one that shipped, which
// stripped a literal `/Users/<name>/code/` prefix and headlined a filtered sample as
// "Every session", fails every one of them.
//
// The corpus these were written against is not available to this test and never will be:
// the deployment target is a machine this repo will never see. Everything below is built
// from synthetic transcripts for that reason.

import { expect, test, describe } from 'bun:test';
import { FOREIGN_CWD, FOREIGN_SLUG, fixtureModels, twoCallSession } from './fixtures.ts';
import { projectsRoot } from '../src/discover.ts';
import { parseTranscript } from '../src/records.ts';
import { readTurn } from '../src/calls.ts';
import { analyzeSession } from '../src/session.ts';
import { workspaceKey, workspaceOf } from '../src/workspace.ts';
import { projectSession } from '../src/report/project.ts';
import { renderCorpus } from '../src/report/render.ts';
import { COMMAND_NAMES, readArgs } from '../src/cli/args.ts';
import { ZERO_PRICES, PRICE_SOURCE } from '../src/models.ts';
import { ZERO_OUTPUT } from '../src/output.ts';
import { eqCost } from '../src/tokens.ts';
import type { SessionSource } from '../src/discover.ts';
import type { CorpusReport, Selection, SessionReport } from '../src/report/model.ts';

const PATH = '/nowhere/impossible.jsonl';

/** One session from a machine nobody here has, run through the real pipeline.
 *
 * [LAW:effects-at-boundaries] `readText` is injected, so this touches no filesystem —
 * which is what lets the test claim something about a foreign machine at all. */
function foreignSession(cwd = FOREIGN_CWD, slug = FOREIGN_SLUG): SessionReport {
  const source: SessionSource = {
    project: slug,
    sessionId: '11111111-2222-3333-4444-555555555555',
    path: PATH,
    bytes: 0,
    mtime: 0,
    subagents: [],
    unpaired: [],
  };
  const text = twoCallSession('', 'claude-opus-5', cwd);
  return projectSession(
    analyzeSession(source, (p) => {
      if (p !== PATH) throw new Error(`unexpected read of ${p}`);
      return text;
    }),
    fixtureModels({ 'claude-opus-5': { charsPerToken: 2.5, tokensPerBlock: 50 } }),
  );
}

const corpusOf = (sessions: SessionReport[], selection: Selection): CorpusReport => ({
  generatedAt: 0,
  sessions,
  selection,
  ledgers: [],
  total: eqCost(sessions.reduce((a, s) => a + s.total.value, 0)),
  pricing: ZERO_PRICES,
  calibration: { rows: [], seen: ['claude-opus-5'], priceSource: PRICE_SOURCE },
  coverage: { byTier: { marker: 0, rule: 0, judge: 0, hand: 0, none: 1 }, unclassified: 1 },
  output: ZERO_OUTPUT,
});

/** Deliberately NOT `localhost`, so these tests cannot pass on a default that happens to
 * be baked in somewhere: every Jaeger URL in the rendered page has to have come from the
 * argument. */
const JAEGER = 'https://jaeger.example:9999';
const render = (c: CorpusReport): string => renderCorpus(c, JAEGER);

describe('a project heading names the project, on a machine nobody here has used', () => {
  test('the leaf name comes back from a foreign home layout and username', () => {
    expect(foreignSession().workspace.name).toBe('my-project');
  });

  test('the name is NOT recoverable from the slug, which is why cwd is read', () => {
    // Both directories flatten to the same slug. A heading derived from the slug would
    // have to give these two the same name; reading cwd tells them apart. This is the
    // ambiguity the ticket originally proposed to parse through, restated as a test so
    // nobody re-proposes it. [LAW:one-source-of-truth]
    const a = workspaceOf(FOREIGN_SLUG, '/home/jdoe/src/my-project');
    const b = workspaceOf(FOREIGN_SLUG, '/home/jdoe/src/my/project');
    expect(a.name).toBe('my-project');
    expect(b.name).toBe('project');
  });

  test('a transcript that reports no cwd renders the slug and says so, rather than guessing', () => {
    const w = workspaceOf(FOREIGN_SLUG, null);
    expect(w.from).toBe('slug');
    expect(w.name).toBe(FOREIGN_SLUG);
  });

  test('a Windows path yields its leaf on whatever platform reads the transcript', () => {
    expect(workspaceOf('-C--Users-jdoe-proj', 'C:\\Users\\jdoe\\proj').name).toBe('proj');
  });

  test('two projects sharing a leaf name stay distinct when counted', () => {
    const work = workspaceOf('-home-jdoe-work-api', '/home/jdoe/work/api');
    const oss = workspaceOf('-home-jdoe-oss-api', '/home/jdoe/oss/api');
    expect(work.name).toBe(oss.name);
    expect(workspaceKey(work)).not.toBe(workspaceKey(oss));
  });

  test('no machine-specific string reaches the rendered page', () => {
    const html = render(
      corpusOf([foreignSession()], { discovered: 1, inScope: 1, rendered: 1, criteria: [] }),
    );
    expect(html).toContain('my-project');
    // The slug is a whole filesystem path. It is what the old renderer printed on any
    // machine its one hardcoded prefix failed to match.
    expect(html).not.toContain(FOREIGN_SLUG);
  });
});

describe('the page states what it covers', () => {
  const sessions = [foreignSession()];

  test('a filtered sample does not call itself every session', () => {
    const html = render(
      corpusOf(sessions, {
        discovered: 271,
        inScope: 271,
        rendered: 1,
        criteria: ['transcript length between 60 and 700 lines — excluded 180 of 271'],
      }),
    );
    expect(html).not.toContain('Every session');
    expect(html).not.toContain('The whole account');
    expect(html).toContain('1 of 271 sessions');
  });

  test('the filters that decided the sample are on the page', () => {
    const html = render(
      corpusOf(sessions, {
        discovered: 271,
        inScope: 271,
        rendered: 1,
        criteria: ['excluded 180 of 271'],
      }),
    );
    expect(html).toContain('excluded 180 of 271');
  });

  test('a scoped run that rendered all of its scope is not called a sample', () => {
    // `--project foo` on a 500-session machine where all 3 foo sessions render: the page
    // showed everything it was asked for, and calling that "3 of 500" reports arbitrary
    // omission that did not happen.
    const html = render(
      corpusOf(sessions, { discovered: 500, inScope: 3, rendered: 3, criteria: ['project foo'] }),
    );
    expect(html).not.toContain('A sample of the scope');
    expect(html).toContain('The whole of the scope');
    // ...and it must not claim the machine either, having shown 3 of its 500.
    expect(html).not.toContain('The whole account');
    expect(html).not.toContain('Every session</');
  });

  test('a scoped run counts its sample against the scope, not the machine', () => {
    const html = render(
      corpusOf(sessions, { discovered: 500, inScope: 20, rendered: 3, criteria: ['project foo'] }),
    );
    expect(html).toContain('3 of 20 sessions in scope');
    expect(html).not.toContain('3 of 500 sessions');
  });

  test('a scoped page still states what the machine held', () => {
    // The scope narrowing must not cost the reader the denominator that says how much of
    // the machine they are NOT looking at.
    const html = render(
      corpusOf(sessions, { discovered: 500, inScope: 20, rendered: 3, criteria: ['project foo'] }),
    );
    expect(html).toContain('500 sessions found under the');
    expect(html).toContain('20 of them in the requested scope');
  });

  test('a page that really did cover everything may still say so', () => {
    const html = render(
      corpusOf(sessions, { discovered: 1, inScope: 1, rendered: 1, criteria: [] }),
    );
    expect(html).toContain('Every session');
    expect(html).toContain('The whole account');
  });
});

describe('the corpus location is overridable, and never silently wrong', () => {
  test('an explicit root wins', () => {
    expect(projectsRoot('/mnt/archive/projects', { HOME: '/home/jdoe' })).toBe(
      '/mnt/archive/projects',
    );
  });

  test('the default is this machine’s Claude Code directory', () => {
    expect(projectsRoot(null, { HOME: '/home/jdoe' })).toBe('/home/jdoe/.claude/projects');
  });

  test('Windows reports its home in USERPROFILE, where HOME is unset', () => {
    expect(projectsRoot(null, { USERPROFILE: 'C:\\Users\\jdoe' })).toContain('jdoe');
  });

  test('no home at all THROWS rather than scanning /.claude/projects', () => {
    // The behaviour this replaces: `HOME ?? ''` produced a real-looking absolute path
    // that failed further downstream, naming a directory the user never chose.
    // [LAW:no-silent-failure]
    expect(() => projectsRoot(null, {})).toThrow(/HOME|USERPROFILE/);
  });

  test('an explicit root works even with no home variable set', () => {
    expect(projectsRoot('/mnt/archive', {})).toBe('/mnt/archive');
  });
});

describe('the corpus a run reads is the one it was told to read', () => {
  // The rest of the argument grammar lives in test/cli.test.ts. What belongs HERE is
  // only the machine-independence half: that `--projects` reaches the scope every
  // command scans, so a run can be pointed at an archive instead of this developer's
  // home directory.
  /** The scope of a command that reads a corpus. `help` reads none, and the type says
   * so, which is why this cannot simply reach for `.scope`. */
  const projectsOf = (argv: readonly string[]): string | null => {
    const c = readArgs(argv);
    if (c.kind === 'help') throw new Error(`\`${argv[0]}\` reads no corpus`);
    return c.scope.projects;
  };
  const CORPUS_COMMANDS = COMMAND_NAMES.filter((n) => n !== 'help');

  test('--projects reaches the scope of every corpus command', () => {
    for (const kind of CORPUS_COMMANDS)
      expect(projectsOf([kind, '--projects', '/mnt/archive'])).toBe('/mnt/archive');
  });

  test('with no --projects the scope defers to this machine, and says so with null', () => {
    for (const kind of CORPUS_COMMANDS) expect(projectsOf([kind])).toBeNull();
  });
});

describe('the transcript reports its own working directory', () => {
  test('the FIRST cwd is taken, because a cd inside the session moves the rest', () => {
    const lines = [
      { type: 'user', uuid: 'a', timestamp: '2026-01-01T00:00:00Z', cwd: '/home/jdoe/proj', message: { role: 'user', content: 'hi' } },
      { type: 'user', uuid: 'b', timestamp: '2026-01-01T00:01:00Z', cwd: '/home/jdoe/proj/sub', message: { role: 'user', content: 'still hi' } },
    ];
    expect(parseTranscript(lines.map((l) => JSON.stringify(l)).join('\n')).cwd).toBe(
      '/home/jdoe/proj',
    );
  });

  test('bookkeeping-only lines carry no cwd, and that is reported as absence', () => {
    const text = JSON.stringify({ type: 'summary', summary: 'a title' });
    expect(parseTranscript(text).cwd).toBeNull();
  });
});

describe('harness envelopes are not counted as things a person typed', () => {
  // Found by replaying `readTurn` over the whole development corpus and listing what fell
  // through to `user` while still looking like an envelope: 34 turns of the `!command`
  // feature were being read as a person asking for work.
  test('a shell command run in the session is harness, not user', () => {
    const t = readTurn('<bash-input>lit next</bash-input>');
    expect(t.origin.kind).toBe('harness');
    expect(t.snippet).toContain('lit next');
  });

  test('shell output is harness', () => {
    expect(readTurn('<bash-stdout>total 24</bash-stdout>').origin.kind).toBe('harness');
    expect(readTurn('<bash-stderr>no such file</bash-stderr>').origin.kind).toBe('harness');
  });

  test('ordinary typing is still a person', () => {
    expect(readTurn('please fix the parser').origin.kind).toBe('user');
  });
});
