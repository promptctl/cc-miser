// The conservation identities, on transcripts whose answers are declared.
//
// WHY THIS FILE EXISTS BESIDE THE CORPUS SCAN. A corpus has no declared answers, so
// running the identities over one can show that they HOLD and can never show that they
// WOULD HAVE CAUGHT anything. A check that has never failed is not known to work — and
// this project has the receipt: an oracle asserting exact agreement on sixteen quantities
// reported success on every run for the life of the project while 27.4% of all output
// tokens were missing. So every identity below is fault-injected: a transcript is built
// that breaks it, and the test asserts it BREAKS and names the site.
//
// THE OTHER REASON. The deployment target has no corpus. Everything here runs on strings,
// so the identities are exercised on a machine that has never run Claude Code — which is
// where they would otherwise be nothing but untested code.

import { expect, test, describe } from 'bun:test';
import type { SessionSource } from '../src/discover.ts';
import {
  IDENTITIES,
  auditCorpus,
  describeViolation,
  identityNamed,
  type Audit,
} from '../src/invariants.ts';
import { analyzeSession, type AnalyzedSession } from '../src/session.ts';
import { isCallSpan } from '../src/spans.ts';
import {
  assistantTurn,
  buildSession,
  buildTranscript,
  placeholderTailSession,
  usageBlockSession,
  userSays,
  FOREIGN_CWD,
} from './fixtures.ts';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PATH = '/corpus/proj/session.jsonl';

const source: SessionSource = {
  project: 'proj',
  sessionId: SESSION_ID,
  path: PATH,
  bytes: 0,
  mtime: 0,
  subagents: [],
  unpaired: [],
};

/** Analyse a bare transcript. The reader throws on any other path, so a test cannot
 * silently analyse an empty string. [LAW:no-silent-failure] */
const analyzed = (transcript: string): AnalyzedSession =>
  analyzeSession(source, (p) => {
    if (p !== PATH) throw new Error(`fixture has no file at ${p}`);
    return transcript;
  });

const auditOne = (name: string, s: AnalyzedSession): Audit =>
  auditCorpus([s], [identityNamed(name)])[0]!;

/** A turn with no tools and no attachments — the usage vector is the whole subject. */
const turnCosting = (usage: {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
}) => assistantTurn({ thinking: '', text: 'ok', tools: [], attachments: [], usage });

/** A conversation of consecutive calls with the given usage vectors. */
const callsCosting = (
  ...usages: Array<{ input: number; cacheCreation: number; cacheRead: number; output: number }>
): string =>
  buildTranscript({
    sessionId: SESSION_ID,
    model: 'claude-opus-5',
    cwd: FOREIGN_CWD,
    startMinute: 0,
    events: [userSays('do the thing'), ...usages.map(turnCosting)],
  });

// ---------------------------------------------------------------------------------

describe('the table itself', () => {
  test('every identity states what it says and why its tolerance is what it is', () => {
    // A bare tolerance is a magic number, and a magic number is a claim with its evidence
    // thrown away. The next row added to the table has to bring its measurement with it.
    const undocumented = IDENTITIES.filter(
      (i) => i.says.trim() === '' || i.basis.trim() === '' || i.name.trim() === '',
    );
    expect(undocumented.map((i) => i.name)).toEqual([]);
  });

  test('a tolerance above zero is declared as measured, and zero as a law', () => {
    // The two kinds are a real distinction — a claim about this pipeline versus a claim
    // about what Anthropic's cache happened to do — and the `basis` has to own which one
    // it is rather than leaving a reader to infer it from the number.
    const miscast = IDENTITIES.filter((i) =>
      i.maxViolationRate === 0 ? !i.basis.startsWith('LAW') : !i.basis.startsWith('MEASURED'),
    );
    expect(miscast.map((i) => i.name)).toEqual([]);
  });

  test('an identity that produced no claims reports zero sites rather than passing quietly', () => {
    // "Never ran" and "passed" are different facts. Collapsing them is how a suite comes
    // to certify work it never did. [LAW:no-silent-failure]
    for (const a of auditCorpus([], IDENTITIES)) expect(a.sites).toBe(0);
  });

  test('a violation names the identity, the session and the site', () => {
    const s = analyzed(callsCosting(
      { input: 5, cacheCreation: 1000, cacheRead: 0, output: 100 },
      { input: 5, cacheCreation: 200, cacheRead: 1500, output: 100 },
    ));
    const a = auditOne('cache-read-recurrence', s);
    expect(a.held).toBe(false);
    const line = describeViolation(a.violations[0]!);
    expect(line).toContain('cache-read-recurrence');
    expect(line).toContain(SESSION_ID);
    expect(line).toContain('call 0->1');
  });

  test('asking for an identity that does not exist stops, and lists the ones that do', () => {
    expect(() => identityNamed('no-such-identity')).toThrow(/known identities: /);
  });
});

// ---------------------------------------------------------------------------------

describe('tree-holds-every-token', () => {
  const spawning = () =>
    buildSession({
      sessionId: SESSION_ID,
      project: 'proj',
      cwd: FOREIGN_CWD,
      model: 'claude-opus-5',
      root: [
        userSays('investigate this'),
        assistantTurn({
          thinking: '',
          text: 'Delegating.',
          tools: [{ id: 'toolu_a', name: 'Agent', input: { description: 'look' }, result: 'done' }],
          attachments: [],
          usage: { input: 5, cacheCreation: 1000, cacheRead: 0, output: 100 },
        }),
        turnCosting({ input: 5, cacheCreation: 300, cacheRead: 1000, output: 200 }),
      ],
      spawns: [
        {
          agentId: 'agent1',
          agentType: 'Explore',
          description: 'look',
          toolUseId: 'toolu_a',
          declaredDepth: 1,
          startMinute: 1,
          events: [
            userSays('look at the thing'),
            turnCosting({ input: 2, cacheCreation: 700, cacheRead: 0, output: 60 }),
          ],
        },
      ],
    });

  test('holds when the tree carries every call the parser produced, spawned ones included', () => {
    const f = spawning();
    const a = auditOne('tree-holds-every-token', analyzeSession(f.source, f.read));
    expect(a.violations).toEqual([]);
    expect(a.sites).toBe(4); // one claim per usage component
  });

  test('BREAKS when the tree drops a call — the bug that lost 79% of one subagent', () => {
    const f = spawning();
    const s = analyzeSession(f.source, f.read);
    // Historically a subagent's calls fell into no turn and simply were not in the tree.
    // Dropping a child reproduces the shape of that loss without reintroducing the bug.
    s.tree.children = s.tree.children.slice(1);

    const a = auditOne('tree-holds-every-token', s);
    expect(a.held).toBe(false);
    // Tokens, not counts: the identity says WHICH component went missing.
    expect(a.violations.map((v) => v.site)).toContain('tree rollup vs parsed calls: output');
  });

  test('BREAKS when a call reaches the tree carrying different usage than it was parsed with', () => {
    const f = spawning();
    const s = analyzeSession(f.source, f.read);
    const call = s.tree.children.flatMap(function walk(x): typeof x[] {
      return [x, ...x.children.flatMap(walk)];
    }).find(isCallSpan)!;
    // A NEW object rather than a mutation: the span and the parser's call share one usage
    // reference, so mutating in place would move both sides and prove nothing.
    call.detail.usage = { ...call.detail.usage, cacheRead: call.detail.usage.cacheRead + 7 };

    const a = auditOne('tree-holds-every-token', s);
    expect(a.held).toBe(false);
    expect(a.violations.map((v) => v.delta)).toContain(7);
  });
});

// ---------------------------------------------------------------------------------

describe('cache-creation-accounted', () => {
  const tiered = (flat: number, tiers: Record<string, number> | null): string =>
    usageBlockSession([
      {
        input_tokens: 2,
        cache_creation_input_tokens: flat,
        ...(tiers ? { cache_creation: tiers } : {}),
        cache_read_input_tokens: 0,
        output_tokens: 50,
      },
    ]);

  test('holds when the per-TTL tiers total the flat figure the pipeline costs from', () => {
    const a = auditOne(
      'cache-creation-accounted',
      analyzed(tiered(1000, { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 600 })),
    );
    expect(a.violations).toEqual([]);
    expect(a.sites).toBe(1);
  });

  test('holds when the block carries no breakdown at all — there is nothing to disagree', () => {
    const a = auditOne('cache-creation-accounted', analyzed(tiered(1000, null)));
    expect(a.violations).toEqual([]);
  });

  test('BREAKS when a tier is not included in the flat total — format drift on the token axis', () => {
    // What a new TTL tier looks like on the day it ships: the line type is unchanged, every
    // field we read is still there, and the one figure everything costs from is short.
    const a = auditOne(
      'cache-creation-accounted',
      analyzed(
        tiered(1000, {
          ephemeral_5m_input_tokens: 400,
          ephemeral_1h_input_tokens: 600,
          ephemeral_1d_input_tokens: 300,
        }),
      ),
    );
    expect(a.held).toBe(false);
    expect(a.violations[0]!.left).toBe(300);
    expect(a.violations[0]!.site).toContain('call 0');
  });

  test('the tier figure follows the snapshot the dedup rule adopted, not some other line', () => {
    // Reading completeness off a line whose usage nobody used would report on a figure
    // that never reached a page. The group's finished line is the one that counts.
    const s = analyzed(
      usageBlockSession([
        {
          input_tokens: 2,
          cache_creation_input_tokens: 500,
          cache_creation: { ephemeral_5m_input_tokens: 500 },
          cache_read_input_tokens: 0,
          output_tokens: 10,
        },
        {
          input_tokens: 2,
          cache_creation_input_tokens: 500,
          cache_creation: { ephemeral_5m_input_tokens: 900 },
          cache_read_input_tokens: 0,
          output_tokens: 99,
        },
      ]),
    );
    const a = auditOne('cache-creation-accounted', s);
    expect(a.held).toBe(false);
    expect(a.violations[0]!.left).toBe(400); // the finished line's disagreement, not the first's
  });
});

// ---------------------------------------------------------------------------------

describe('cache-read-recurrence', () => {
  test('holds when each call reads exactly what the call before it had and wrote', () => {
    const a = auditOne(
      'cache-read-recurrence',
      analyzed(callsCosting(
        { input: 5, cacheCreation: 1000, cacheRead: 0, output: 100 },
        { input: 5, cacheCreation: 300, cacheRead: 1000, output: 200 },
        { input: 5, cacheCreation: 400, cacheRead: 1300, output: 300 },
      )),
    );
    expect(a.violations).toEqual([]);
    expect(a.sites).toBe(2);
  });

  test('a boundary where the cached prefix died is not a site, and not a violation', () => {
    // [LAW:dataflow-not-control-flow] Nothing to predict, so no claim is produced — the
    // identity is not "excused" at these boundaries, it simply has nothing to say.
    const a = auditOne(
      'cache-read-recurrence',
      analyzed(callsCosting(
        { input: 5, cacheCreation: 1000, cacheRead: 5000, output: 100 },
        { input: 5, cacheCreation: 300, cacheRead: 0, output: 200 },
      )),
    );
    expect(a.sites).toBe(0);
    expect(a.violations).toEqual([]);
  });

  test('BREAKS when a call reads more than was ever written to the cache', () => {
    const a = auditOne(
      'cache-read-recurrence',
      analyzed(callsCosting(
        { input: 5, cacheCreation: 1000, cacheRead: 0, output: 100 },
        { input: 5, cacheCreation: 200, cacheRead: 1500, output: 200 },
      )),
    );
    expect(a.held).toBe(false);
    expect(a.violations[0]!.delta).toBe(500);
  });
});

// ---------------------------------------------------------------------------------

describe('output-snapshot-agrees — the guard on the quantity that was wrong by 27.4%', () => {
  /** Three JSONL lines per call, output ramping 1/3, 2/3, 3/3 as the response streams —
   * the shape of the 5,395 corpus groups the first-line reader understated. */
  const streaming = (): string =>
    buildTranscript({
      sessionId: SESSION_ID,
      model: 'claude-opus-5',
      cwd: FOREIGN_CWD,
      startMinute: 0,
      events: [
        userSays('do the thing'),
        assistantTurn({
          thinking: '',
          text: 'working',
          tools: [{ id: 'toolu_a', name: 'Read', input: { file_path: '/x' }, result: 'ok' }],
          attachments: [],
          usage: { input: 5, cacheCreation: 1000, cacheRead: 0, output: 900 },
        }),
      ],
    });

  test('holds: the adopted output is the finished figure, and so is the last line’s', () => {
    const s = analyzed(streaming());
    const call = s.conversation.calls[0]!;
    expect(call.lineCount).toBe(3);
    expect(call.usage.output).toBe(900);
    expect(call.lastLineUsage.output).toBe(900);
    expect(auditOne('output-snapshot-agrees', s).violations).toEqual([]);
  });

  test('BREAKS under the first-line reader — the exact bug, at the exact call', () => {
    const s = analyzed(streaming());
    // What the shipped reader produced: the first line's partial count, 1/3 of the way
    // through a three-block response. Simulated rather than reintroduced, because a test
    // that needs the bug present to pass is a test keeping the bug alive.
    const call = s.conversation.calls[0]!;
    call.usage = { ...call.usage, output: 300 };

    const a = auditOne('output-snapshot-agrees', s);
    expect(a.held).toBe(false);
    expect(a.violations[0]!.delta).toBe(-600);
    expect(a.violations[0]!.site).toContain('call 0');
  });

  test('the all-zero placeholder tail is excluded from being a site at all', () => {
    // The three corpus groups whose final line is a placeholder are why `completeUsage`
    // takes the maximum rather than the last. Counting them as sites would make the
    // identity demand the pipeline adopt the very zeros that rule exists to reject.
    const s = analyzed(placeholderTailSession());
    expect(s.conversation.calls[0]!.usage.output).toBe(278);
    expect(s.conversation.calls[0]!.lastLineUsage.output).toBe(0);
    const a = auditOne('output-snapshot-agrees', s);
    expect(a.sites).toBe(0);
    expect(a.violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------

describe('residency-predicts-cache-read', () => {
  /** A session that opens WARM: its first call already reads a surviving prefix. 56.3% of
   * the corpus's epochs open this way, and the model used to assume none of them did. */
  const resumed = (): AnalyzedSession =>
    analyzed(callsCosting(
      { input: 5, cacheCreation: 1000, cacheRead: 50_000, output: 100 },
      { input: 5, cacheCreation: 300, cacheRead: 51_000, output: 200 },
      { input: 5, cacheCreation: 400, cacheRead: 51_300, output: 300 },
    ));

  test('an epoch is predicted from the prefix it OPENED on, not from zero', () => {
    // THE REGRESSION PIN. The model previously summed prior cache_creation alone, which is
    // this same equation with the opening prefix assumed to be zero. It scored 28/28 on a
    // hand-traced specimen that opened cold, and 26.2% on 47,782 real calls.
    const { perCall } = resumed().conservation;
    expect(perCall[0]!.expected).toBe(50_000);
    expect(perCall.map((p) => p.delta)).toEqual([0, 0, 0]);
  });

  test('the aggregate route is the per-call result summed, so the two cannot disagree', () => {
    // [LAW:one-source-of-truth] These were independent expressions of one model and drifted
    // the moment the base term was added to only one of them.
    const c = resumed().conservation;
    expect(c.predictedCacheRead).toBe(c.perCall.reduce((a, p) => a + p.expected, 0));
    expect(c.predictedCacheRead).toBe(c.actualCacheRead);
  });

  test('holds on a session that opens warm', () => {
    expect(auditOne('residency-predicts-cache-read', resumed()).violations).toEqual([]);
  });

  test('BREAKS when the API reports a cache_read the residency model cannot account for', () => {
    const a = auditOne(
      'residency-predicts-cache-read',
      analyzed(callsCosting(
        { input: 5, cacheCreation: 1000, cacheRead: 0, output: 100 },
        { input: 5, cacheCreation: 300, cacheRead: 1000, output: 200 },
        { input: 5, cacheCreation: 400, cacheRead: 9999, output: 300 },
      )),
    );
    expect(a.held).toBe(false);
    expect(a.violations.map((v) => v.site)).toContain(
      'root call 2: predicted vs reported cache_read',
    );
  });
});
