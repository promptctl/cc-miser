// What happens beneath a `Agent` call: spawn resolution, grafting, depth accounting and
// label inheritance.
//
// WHY THIS FILE EXISTS. Five modules — activity, classify, forest, lineage, spans — were
// imported by zero tests, and between them they decide every number the report shows
// about WHAT the work was, plus the entire subagent half of the corpus. There was no
// subagent fixture anywhere: the only session a test had ever built carried an empty
// spawn list, so `resolveForest` had never once run under test. On the development
// corpus depth 2 carried 66.2% of one session's spend, so this was not an edge case
// going unexercised — it was the majority of the money.
//
// HOW THE EXPECTED VALUES WERE ARRIVED AT. Written down first, then built. Every figure
// asserted below was chosen by hand from the scenario diagram before any transcript
// existed, so the suite says what the pipeline SHOULD do rather than recording what it
// did on the day it was captured. A recorded expectation pins today's behaviour,
// including today's bugs — which is how a reader that understated the corpus's output by
// 27.4% survived the whole life of the project.
//
// [LAW:behavior-not-structure] These assert the contract: which conversation ended up
// where, whose label it carries, what it cost, and what refused to resolve. Any resolver
// with those properties passes. A tool_use-only resolver, a depth-guessing one, and one
// that flattens grandchildren to depth 1 each fail a case below, which is the point.

import { expect, test, describe } from 'bun:test';
import {
  assistantTurn,
  buildSession,
  userSays,
  FOREIGN_CWD,
  FOREIGN_SLUG,
  type SessionSpec,
} from './fixtures.ts';
import { UNCLASSIFIED, assertPartition, label, withReason } from '../src/activity.ts';
import { buildConversation } from '../src/calls.ts';
import { classifyCalls } from '../src/classify.ts';
import { depthDisagreements, resolveForest, type Candidate } from '../src/forest.ts';
import { depthOf, lineagePath } from '../src/lineage.ts';
import { parseTranscript } from '../src/records.ts';
import { analyzeSession } from '../src/session.ts';
import { allCalls, atDepth, rollup, rollupWhere, type Span } from '../src/spans.ts';

// ---------------------------------------------------------------------------------
// THE SCENARIO, WRITTEN DOWN BEFORE THE TRANSCRIPT
// ---------------------------------------------------------------------------------
//
//  root — 4 calls, one turn
//    call 0  Skill(laws:code)                            orientation    [marker]
//    call 1  Read(src/parser.ts)  + attachment            exploration    [rule]
//    call 2  Skill(code-review) + Agent(toolu_review)     review         [marker]
//    call 3  Edit(src/parser.ts)                          implementation [rule]
//
//    ├── a_review  "code-review"        tool_use toolu_review @ root call 2   depth 1
//    │     call 0  Write(src/parser.ts)      — ALONE this classifies implementation
//    │     call 1  Agent(toolu_guide), result never arrived
//    │     └── a_guide  "claude-code-guide"  tool_use toolu_guide @ a_review call 1
//    │           call 0  Read(README.md)     — ALONE this classifies exploration  depth 2
//    ├── a_recap   "general-purpose"    slash-command fork, no tool_use       depth 1
//    │     call 0  Bash(git log)             — ALONE this classifies scm
//    ├── a_lost    toolUseId toolu_vanished, which no transcript contains     ORPHAN
//    └── a_stray   no toolUseId, claims depth 4 — nothing sits at depth 3     ORPHAN
//
// The three resolved children each run tools that would classify them DIFFERENTLY from
// their spawner. That is deliberate: a fixture whose child and parent classify alike
// passes whether inheritance works or not, and would have proved nothing.
//
// The two orphans are the two ways `resolveForest` can fail to place a candidate, and
// both are order-independent by construction. Route A is always exhausted before route B
// runs, so `a_lost`'s missing tool_use id can never resolve, and no conversation ever
// reaches depth 3, so `a_stray`'s claimed parent depth is empty on every pass. An orphan
// whose verdict depended on which order the candidates happened to be listed in would be
// an assertion about array order wearing a contract's clothes.

/** Root call index → what the classifier must say about it, and on what evidence. */
const ROOT_LABELS = [
  { activity: 'orientation', tier: 'marker' },
  { activity: 'exploration', tier: 'rule' },
  { activity: 'review', tier: 'marker' },
  { activity: 'implementation', tier: 'rule' },
] as const;

/** Output tokens per conversation, as the API reported them. The orphans' figures are
 * deliberately large and unmistakable: they must appear in NO rollup, and a resolver
 * that quietly grafted an unlinkable agent somewhere plausible would show up here as a
 * four-digit surplus rather than as a rounding difference. */
const OUTPUT = {
  root: 100 + 200 + 300 + 400,
  a_review: 150 + 250,
  a_recap: 120,
  a_guide: 90,
  a_lost: 7777,
  a_stray: 8888,
} as const;

const TREE_OUTPUT = OUTPUT.root + OUTPUT.a_review + OUTPUT.a_recap + OUTPUT.a_guide; // 1610
const OUTPUT_AT_DEPTH = [
  OUTPUT.root, // 1000
  OUTPUT.a_review + OUTPUT.a_recap, // 520
  OUTPUT.a_guide, // 90
] as const;

const REPO = '/home/jdoe/src/my-project';

const NESTED: SessionSpec = {
  sessionId: '11111111-2222-3333-4444-555555555555',
  project: FOREIGN_SLUG,
  cwd: FOREIGN_CWD,
  model: 'claude-opus-5',
  root: [
    userSays('do the thing'),
    assistantTurn({
      thinking: '',
      text: 'Loading the craft laws before touching anything.',
      tools: [{ id: 'toolu_skill', name: 'Skill', input: { skill: 'laws:code' }, result: 'loaded' }],
      attachments: [],
      usage: { input: 10, cacheCreation: 1000, cacheRead: 0, output: 100 },
    }),
    assistantTurn({
      thinking: '',
      text: 'Reading the parser first.',
      tools: [
        {
          id: 'toolu_read',
          name: 'Read',
          input: { file_path: `${REPO}/src/parser.ts` },
          result: 'export function parse(): void {}\n'.repeat(20),
        },
      ],
      attachments: [{ type: 'task_reminder', content: 'the task list has not been updated' }],
      usage: { input: 5, cacheCreation: 500, cacheRead: 1000, output: 200 },
    }),
    assistantTurn({
      thinking: '',
      text: 'Putting the diff in front of a reviewer.',
      // Two tool_use blocks in one call — the ordinary shape, and the reason a call's
      // blocks are the UNION over its request group rather than its first line.
      tools: [
        { id: 'toolu_skill2', name: 'Skill', input: { skill: 'code-review' }, result: 'loaded' },
        {
          id: 'toolu_review',
          name: 'Agent',
          input: { description: 'line-by-line review of the parser change' },
          result: 'three findings, all in error handling',
        },
      ],
      attachments: [],
      usage: { input: 5, cacheCreation: 800, cacheRead: 1500, output: 300 },
    }),
    assistantTurn({
      thinking: '',
      text: 'Applying the fix.',
      tools: [
        {
          id: 'toolu_edit',
          name: 'Edit',
          input: { file_path: `${REPO}/src/parser.ts` },
          result: 'edited',
        },
      ],
      attachments: [],
      usage: { input: 5, cacheCreation: 400, cacheRead: 2300, output: 400 },
    }),
  ],
  spawns: [
    {
      agentId: 'a_review',
      agentType: 'code-review',
      description: 'line-by-line review of the parser change',
      toolUseId: 'toolu_review',
      declaredDepth: 1,
      startMinute: 10,
      events: [
        userSays('Review the parser change line by line.'),
        assistantTurn({
          thinking: '',
          text: 'Rewriting the guard as a parse.',
          tools: [
            {
              id: 'toolu_fix',
              name: 'Write',
              input: { file_path: `${REPO}/src/parser.ts` },
              result: 'written',
            },
          ],
          attachments: [],
          usage: { input: 4, cacheCreation: 2000, cacheRead: 0, output: 150 },
        }),
        assistantTurn({
          thinking: '',
          text: 'Asking the guide about the harness contract.',
          // No result: the spawned conversation outlived the transcript writer. The
          // graft must still happen, and the tool span must still cover its child.
          tools: [
            {
              id: 'toolu_guide',
              name: 'Agent',
              input: { description: 'what does the harness guarantee here' },
              result: null,
            },
          ],
          attachments: [],
          usage: { input: 4, cacheCreation: 300, cacheRead: 2000, output: 250 },
        }),
      ],
    },
    {
      agentId: 'a_guide',
      agentType: 'claude-code-guide',
      description: 'what does the harness guarantee here',
      // The trap the fixpoint exists for: this id lives in ANOTHER SUBAGENT's
      // transcript, so a single pass over the root's tool_use blocks never finds it.
      toolUseId: 'toolu_guide',
      // The harness claims depth 1; the chain resolves depth 2. Both are recorded and
      // the disagreement is reported, because reconciling would hide whichever is broken.
      declaredDepth: 1,
      startMinute: 14,
      events: [
        userSays('What does the harness guarantee about tool results?'),
        assistantTurn({
          thinking: '',
          text: 'Checking the README.',
          tools: [
            {
              id: 'toolu_readme',
              name: 'Read',
              input: { file_path: `${REPO}/README.md` },
              result: '# my-project\n',
            },
          ],
          attachments: [],
          usage: { input: 2, cacheCreation: 700, cacheRead: 0, output: 90 },
        }),
      ],
    },
    {
      agentId: 'a_recap',
      agentType: 'general-purpose',
      description: '/recap what changed on this branch',
      // A slash-command fork leaves no tool_use block behind at all.
      toolUseId: '',
      declaredDepth: 1,
      // Its first call lands after root call 3, which is where route B must place it.
      startMinute: 7,
      events: [
        userSays('Recap what changed on this branch.'),
        assistantTurn({
          thinking: '',
          text: 'Reading the log.',
          tools: [
            {
              id: 'toolu_log',
              name: 'Bash',
              input: { command: 'git log --oneline -20' },
              result: 'abc1234 fix the parser\n',
            },
          ],
          attachments: [],
          usage: { input: 3, cacheCreation: 900, cacheRead: 0, output: 120 },
        }),
      ],
    },
    {
      agentId: 'a_lost',
      agentType: 'general-purpose',
      description: 'spawned by a call nobody kept',
      toolUseId: 'toolu_vanished',
      declaredDepth: 1,
      startMinute: 20,
      events: [
        userSays('Do something unattributable.'),
        assistantTurn({
          thinking: '',
          text: 'Working.',
          tools: [],
          attachments: [],
          usage: { input: 1, cacheCreation: 100, cacheRead: 0, output: OUTPUT.a_lost },
        }),
      ],
    },
    {
      agentId: 'a_stray',
      agentType: 'general-purpose',
      description: 'a fork claiming a depth nothing reaches',
      toolUseId: '',
      declaredDepth: 4,
      startMinute: 22,
      events: [
        userSays('Do something else unattributable.'),
        assistantTurn({
          thinking: '',
          text: 'Working.',
          tools: [],
          attachments: [],
          usage: { input: 1, cacheCreation: 100, cacheRead: 0, output: OUTPUT.a_stray },
        }),
      ],
    },
  ],
};

const fixture = buildSession(NESTED);
const analyzed = analyzeSession(fixture.source, fixture.read);

/** The one conversation with this agent id, as the forest resolved it. Throws rather
 * than returning undefined: a test looking for a conversation that was never placed has
 * already failed, and should say so where it asked. [LAW:no-silent-failure] */
function placed(agentId: string) {
  const c = analyzed.forest.placed.find((p) => p.meta.agentId === agentId);
  if (!c) throw new Error(`${agentId} was not placed; orphans: ${analyzed.forest.orphans.map((o) => o.meta.agentId).join(', ')}`);
  return c;
}

/** The one span with this id, anywhere in the tree. */
function span(id: string): Span {
  const walk = (s: Span): Span | undefined =>
    s.id === id ? s : s.children.reduce<Span | undefined>((hit, k) => hit ?? walk(k), undefined);
  const found = walk(analyzed.tree);
  if (!found) throw new Error(`no span ${id} in the tree`);
  return found;
}

describe('a spawned conversation is resolved to where it actually sits', () => {
  test('a tool_use edge links a child to the exact call that spawned it', () => {
    expect(placed('a_review').lineage).toEqual([
      { agentId: 'a_review', agentType: 'code-review', spawnedAtCall: 2, via: 'tool_use' },
    ]);
  });

  test('a slash-command fork resolves too, and says which route found it', () => {
    // Resolving only the tool_use edge orphaned all 14 subagents of one real session,
    // because the single command-forked ancestor took its whole subtree with it.
    const recap = placed('a_recap').lineage;
    expect(recap.length).toBe(1);
    expect(recap[0]!.via).toBe('command');
    // No spawning call exists, so it is placed at the parent call that most closely
    // precedes its first — root call 3.
    expect(recap[0]!.spawnedAtCall).toBe(3);
  });

  test('a grandchild links through a tool_use inside ANOTHER SUBAGENT’s transcript', () => {
    // The fixpoint. A single pass over the root's tool_use ids never sees `toolu_guide`,
    // because it was issued inside a_review — so a one-pass resolver loses this whole
    // branch and, with it, the depth at which most of the money is spent.
    const guide = placed('a_guide').lineage;
    expect(guide.map((s) => s.agentId)).toEqual(['a_review', 'a_guide']);
    expect(depthOf(guide)).toBe(2);
    expect(guide[1]!.spawnedAtCall).toBe(1); // a_review's OWN call index, not the root's
    expect(lineagePath(guide)).toBe('code-review > claude-code-guide');
  });

  test('depth is the resolved chain, and the harness’s claim is reported when it differs', () => {
    // a_guide's meta says spawnDepth 1; the chain says 2. The chain wins because it was
    // resolved structurally, and the disagreement is surfaced rather than reconciled
    // away — reconciling hides whichever of the two is broken. [LAW:one-source-of-truth]
    expect(depthOf(placed('a_guide').lineage)).toBe(2);
    expect(placed('a_guide').meta.declaredDepth).toBe(1);
    expect(depthDisagreements(analyzed.forest)).toEqual(['a_guide: chain=2 meta.spawnDepth=1']);
    expect(analyzed.notes.some((n) => n.includes('spawnDepth disagreement'))).toBe(true);
  });
});

describe('what cannot be placed is named, never guessed at', () => {
  const orphans = analyzed.forest.orphans;

  test('exactly the two unplaceable agents are orphaned', () => {
    expect(orphans.map((o) => o.meta.agentId).sort()).toEqual(['a_lost', 'a_stray']);
  });

  test('a dangling tool_use edge names the id it could not find', () => {
    const why = orphans.find((o) => o.meta.agentId === 'a_lost')!.why;
    expect(why).toContain('toolu_vanished');
  });

  test('a fork whose claimed parent depth is empty is refused, not attached to the nearest thing', () => {
    // The guard is `exactly one candidate parent`. Attaching a_stray to any of the three
    // resolved conversations would corrupt every depth-keyed number downstream, and it
    // would do so silently — the tree would still render.
    const why = orphans.find((o) => o.meta.agentId === 'a_stray')!.why;
    expect(why).toContain('depth 3');
    expect(why).toContain('need exactly 1');
  });

  test('orphans are on the page, not swallowed', () => {
    expect(analyzed.notes.filter((n) => n.startsWith('ORPHAN')).length).toBe(2);
  });

  test('an orphan’s cost reaches no rollup', () => {
    // The unmistakable-figures check: both orphans bill four-digit output, so any route
    // by which an unplaceable agent sneaks into the tree shows up as a surplus here.
    expect(rollup(analyzed.tree).output).toBe(TREE_OUTPUT);
    expect(rollup(analyzed.tree).output).toBeLessThan(TREE_OUTPUT + OUTPUT.a_lost);
  });
});

describe('ambiguity is refused rather than resolved by preference', () => {
  test('a fork with two possible parents at its claimed depth stays an orphan', () => {
    // Deterministic by construction: route A is exhausted before route B ever runs, so
    // both tool_use children are already at depth 1 when the command fork is considered,
    // and nothing else can join them on that pass.
    const twoChildren: SessionSpec = {
      ...NESTED,
      root: [
        assistantTurn({
          thinking: '',
          text: 'Fanning out.',
          tools: [
            { id: 'toolu_a', name: 'Agent', input: { description: 'first' }, result: 'ok' },
            { id: 'toolu_b', name: 'Agent', input: { description: 'second' }, result: 'ok' },
          ],
          attachments: [],
          usage: { input: 1, cacheCreation: 100, cacheRead: 0, output: 10 },
        }),
      ],
      spawns: [
        { ...leaf('a_first', 'toolu_a', 1, 10), agentType: 'Explore' },
        { ...leaf('a_second', 'toolu_b', 1, 12), agentType: 'Explore' },
        // Claims to sit under depth 1, where two conversations now sit.
        leaf('a_ambiguous', '', 2, 14),
      ],
    };
    const f = buildSession(twoChildren);
    const a = analyzeSession(f.source, f.read);

    expect(a.forest.placed.map((p) => p.meta.agentId).sort()).toEqual(['a_first', 'a_second']);
    expect(a.forest.orphans.map((o) => o.meta.agentId)).toEqual(['a_ambiguous']);
    expect(a.forest.orphans[0]!.why).toContain('2 resolved conversations sit at depth 1');
  });
});

/** A one-call spawned conversation, for scenarios whose subject is the linking rather
 * than the contents. */
function leaf(agentId: string, toolUseId: string, declaredDepth: number, startMinute: number) {
  return {
    agentId,
    agentType: 'general-purpose',
    description: agentId,
    toolUseId,
    declaredDepth,
    startMinute,
    events: [
      userSays('go'),
      assistantTurn({
        thinking: '',
        text: 'done',
        tools: [],
        attachments: [],
        usage: { input: 1, cacheCreation: 10, cacheRead: 0, output: 5 },
      }),
    ],
  };
}

describe('the root conversation is classified from what the transcript says about itself', () => {
  test('every call gets exactly one label, at the tier that decided it', () => {
    expect(analyzed.labels.map((l) => ({ activity: l.activity, tier: l.tier }))).toEqual(
      ROOT_LABELS.map((l) => ({ activity: l.activity, tier: l.tier })),
    );
  });

  test('every label carries the evidence it was decided on', () => {
    // A percentage whose basis is unstated is not an answer.
    expect(analyzed.labels.every((l) => l.because.length > 0)).toBe(true);
    expect(analyzed.labels[2]!.because).toContain('code-review');
  });

  test('a spawn the forest could not place contributes no marker', () => {
    // `agentTypeByToolUseId` is built from PLACED conversations only, so an orphan can
    // never talk the classifier into a label. a_lost is a `general-purpose`; if orphans
    // fed the map it would still not fire a marker, but a future Explore-typed orphan
    // would — this pins the boundary now, while it is cheap.
    expect(analyzed.labels.map((l) => l.activity)).not.toContain('unclassified');
  });
});

describe('a label cannot claim to know something it does not', () => {
  // The forbidden combination is `unclassified` at any tier but `none`, and it is not
  // hypothetical: the catch-all row for "ran tools, but nothing matched" once stamped
  // tier `rule`, so 14.7% of corpus calls were counted as rule-decided when what actually
  // happened is that no rule fired. That renders as 97% coverage and 0% unknown —
  // an answer-shaped void, and coverage is the last number allowed to flatter itself.

  test('proposing a decided tier for unclassified is impossible, not merely discouraged', () => {
    const l = label('unclassified', 'marker', 'a caller that meant well');
    expect(l.tier).toBe('none');
  });

  test('a real activity keeps the tier it was decided at', () => {
    expect(label('review', 'marker', 'invoked a code-review skill').tier).toBe('marker');
  });

  test('re-explaining a label cannot smuggle the combination back in', () => {
    // The inheritance path rebuilds a label with a new reason. Doing that field-by-field
    // at the call site is exactly how the invariant gets reintroduced.
    const restated = withReason(UNCLASSIFIED, 'inherited via general-purpose from call 0');
    expect(restated.activity).toBe('unclassified');
    expect(restated.tier).toBe('none');
    expect(restated.because).toContain('inherited');
  });

  test('labels that do not cover the calls STOP the run rather than skewing a percentage', () => {
    // A gap here silently breaks every percentage downstream, so it is loud.
    expect(() => assertPartition([UNCLASSIFIED], 2)).toThrow(/partition/);
    expect(() => assertPartition([UNCLASSIFIED], 1)).not.toThrow();
  });
});

describe('a spawned conversation inherits its spawner’s phase of work', () => {
  // PROJECT.md's rule: a review subagent's entire burn is review cost. The fixture is
  // built so that each child's OWN tools would say something else, which is the only way
  // this assertion can distinguish inheritance from coincidence.

  const ownLabelsOf = (agentId: string) =>
    classifyCalls(placed(agentId).conversation.calls, new Map()).map((l) => l.activity);

  test('the review agent would classify as implementation on its own tools', () => {
    expect(ownLabelsOf('a_review')[0]).toBe('implementation');
  });

  test('...but carries its spawner’s review label in the tree', () => {
    const call = span('call:a_review:0');
    expect(call.detail.kind).toBe('call');
    if (call.detail.kind !== 'call') throw new Error('unreachable');
    expect(call.detail.label.activity).toBe('review');
    expect(call.detail.label.because).toContain('inherited via');
  });

  test('the command fork inherits the call it forked from, not the one the child ran', () => {
    expect(ownLabelsOf('a_recap')[0]).toBe('scm');
    const call = span('call:a_recap:0');
    if (call.detail.kind !== 'call') throw new Error('unreachable');
    // Root call 3 is the implementation call; that is where the fork was placed.
    expect(call.detail.label.activity).toBe('implementation');
  });

  test('inheritance reaches the grandchild, whose own tools say exploration', () => {
    expect(ownLabelsOf('a_guide')[0]).toBe('exploration');
    const call = span('call:a_guide:0');
    if (call.detail.kind !== 'call') throw new Error('unreachable');
    expect(call.detail.label.activity).toBe('review');
    expect(call.detail.label.because).toContain('code-review > claude-code-guide');
  });
});

describe('the span tree grafts every resolved conversation where it belongs', () => {
  test('a tool_use-spawned conversation hangs under its spawning tool', () => {
    const tool = span('tool:toolu_review');
    expect(tool.children.map((k) => k.id)).toEqual(['subagent:a_review']);
  });

  test('a command fork hangs directly off the call, having no tool to hang from', () => {
    const call = span('call:3');
    expect(call.children.map((k) => k.id)).toContain('subagent:a_recap');
  });

  test('a grandchild hangs under its spawning tool inside its parent’s transcript', () => {
    expect(span('tool:a_review:toolu_guide').children.map((k) => k.id)).toEqual([
      'subagent:a_guide',
    ]);
  });

  test('a tool whose result never came back still hosts its child and covers it in time', () => {
    // The Agent that spawned a_guide has no tool_result, so the tool span has no end of
    // its own. A parent that did not stretch over its child produces nesting that Chrome
    // Trace rejects as malformed.
    const tool = span('tool:a_review:toolu_guide');
    if (tool.detail.kind !== 'tool') throw new Error('unreachable');
    expect(tool.detail.resultChars).toBe(0);
    expect(tool.tEnd).toBeGreaterThanOrEqual(span('subagent:a_guide').tEnd);
    expect(tool.tStart).toBeLessThanOrEqual(span('subagent:a_guide').tStart);
  });

  test('every resolved call is in the tree exactly once', () => {
    const ids = allCalls(analyzed.tree).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(4 + 2 + 1 + 1);
  });
});

describe('cost rolls up through the tree by one rule at every depth', () => {
  test('the whole tree bills what the four conversations billed', () => {
    expect(rollup(analyzed.tree).output).toBe(TREE_OUTPUT);
  });

  test('the depth cohorts partition that total', () => {
    const byDepth = [0, 1, 2].map((d) => rollupWhere(analyzed.tree, atDepth(d)).output);
    expect(byDepth).toEqual([...OUTPUT_AT_DEPTH]);
    expect(byDepth.reduce((a, b) => a + b, 0)).toBe(TREE_OUTPUT);
  });

  test('spawned cost is summed, never derived by subtracting the parent’s', () => {
    // total − depth-0 happens to agree here; it stops agreeing the moment a
    // grandchild is misplaced, which is exactly when the number matters.
    const spawned = rollupWhere(analyzed.tree, (s) => depthOf(s.lineage) > 0).output;
    expect(spawned).toBe(OUTPUT.a_review + OUTPUT.a_recap + OUTPUT.a_guide);
  });
});

describe('no call and no conversation falls out of the tree', () => {
  // BOTH CASES BELOW WERE FOUND BY POINTING THE SCAN AT A REAL CORPUS, on 4 of 396
  // sessions, the first time anything checked that the tree holds what the pipeline
  // parsed. They are re-stated here as synthetic fixtures because the deployment target
  // has no corpus: a bug that only the smoke scan can catch is a bug that goes uncaught
  // on every machine but this one.

  const bareTurn = (text: string, output: number, cacheRead: number) =>
    assistantTurn({
      thinking: '',
      text,
      tools: [],
      attachments: [],
      usage: { input: 1, cacheCreation: 100, cacheRead, output },
    });

  test('calls that precede the first user line are in the tree, not dropped', () => {
    // A transcript can open straight into API calls, with its first user-channel line
    // arriving only later — a compaction resume, or a spawned conversation whose prompt
    // line the writer never emitted. The calls before that line belong to no turn, and
    // the tree was assembled from turns, so they were absent from every rollup with no
    // warning anywhere. Measured on the corpus: one subagent lost 31 of its 39 calls.
    //
    // The turns here are NOT empty, which is the whole point — the fallback this
    // replaced handled a conversation with no turns at all and missed this one.
    const f = buildSession({
      ...NESTED,
      root: [
        bareTurn('Picking up where the compaction left off.', 11, 0),
        bareTurn('Still going.', 22, 100),
        userSays('now do the other thing'),
        bareTurn('On it.', 33, 200),
      ],
      spawns: [],
    });
    const a = analyzeSession(f.source, f.read);

    // One turn, and it reaches only the last call.
    expect(a.conversation.turns.map((t) => [t.firstCall, t.lastCall])).toEqual([[2, 2]]);
    expect(a.conversation.calls.length).toBe(3);
    expect(allCalls(a.tree).length).toBe(3);
    expect(rollup(a.tree).output).toBe(11 + 22 + 33);
  });

  test('a root that recorded no calls of its own still carries the conversation it spawned', () => {
    // A real session shape: all of the work went to one spawned agent, so the root
    // transcript holds turns but no API calls. Children are grafted onto call spans, so
    // with no calls there was nothing to graft onto — and a 40-call conversation vanished
    // from the tree entirely, cost and all.
    const f = buildSession({
      ...NESTED,
      root: [userSays('do all of it in a subagent')],
      spawns: [
        {
          ...leaf('a_only', '', 1, 4),
          events: [userSays('do all of it'), bareTurn('Doing all of the work.', 640, 0)],
        },
      ],
    });
    const a = analyzeSession(f.source, f.read);

    expect(a.conversation.calls.length).toBe(0);
    expect(a.conversation.turns.length).toBe(1);
    expect(a.forest.placed.map((p) => p.meta.agentId)).toEqual(['a_only']);
    expect(allCalls(a.tree).length).toBe(1);
    expect(rollup(a.tree).output).toBe(640);
  });

  test('a spawned conversation with no call span to hang from is still labelled honestly', () => {
    // It inherits from a call that does not exist, so there is no phase of work to
    // inherit. `unclassified` is the honest answer; a real activity here would be a
    // guess wearing a measurement's clothes.
    const f = buildSession({
      ...NESTED,
      root: [userSays('do all of it in a subagent')],
      spawns: [leaf('a_only', '', 1, 4)],
    });
    const a = analyzeSession(f.source, f.read);
    const call = allCalls(a.tree)[0]!;
    expect(call.detail.label.activity).toBe('unclassified');
    expect(call.detail.label.tier).toBe('none');
  });
});

describe('a subagent transcript is read with the same care as a root one', () => {
  // Subagent transcripts are written by a different path than root ones, and 74.5% of
  // their request groups stream a rising partial `output_tokens` where only the finished
  // line carries the true figure. A fixture set built solely from root-shaped
  // transcripts passes while being wrong on 6% of output tokens.

  const reviewText = fixture.read(fixture.source.subagents.find((s) => s.agentId === 'a_review')!.transcriptPath);

  /** The reader that shipped: keep the FIRST line of each request group. */
  const firstLinePerGroup = (text: string): number[] => {
    const seen = new Map<string, number>();
    for (const l of parseTranscript(text).lines)
      if (l.kind === 'assistant' && !seen.has(l.requestId)) seen.set(l.requestId, l.usage.output);
    return [...seen.values()];
  };

  const trueOutput = buildConversation(parseTranscript(reviewText).lines).calls.map(
    (c) => c.usage.output,
  );

  test('the pipeline recovers the finished figure', () => {
    expect(trueOutput).toEqual([150, 250]);
  });

  test('the fixture has teeth: a first-line reader disagrees, and understates', () => {
    // Asserting the disagreement rather than the naive reader's exact numbers — those
    // are a property of how many blocks this fixture happens to fan out to, not of the
    // contract. What the contract says is that first-wins is wrong here, and low.
    const naive = firstLinePerGroup(reviewText);
    expect(naive).not.toEqual(trueOutput);
    expect(naive.reduce((a, b) => a + b, 0)).toBeLessThan(
      trueOutput.reduce((a, b) => a + b, 0),
    );
  });

  test('the fan-out is recorded rather than inferred', () => {
    const calls = buildConversation(parseTranscript(reviewText).lines).calls;
    // thinking + text + tool_use on each turn.
    expect(calls.map((c) => c.lineCount)).toEqual([3, 3]);
  });
});

describe('what arrived in the context window, and what could not be paired', () => {
  test('a tool result becomes an arrival labelled with the tool that asked for it', () => {
    const read = analyzed.conversation.arrivals.find(
      (a) => a.source === 'toolResult' && a.toolUseId === 'toolu_read',
    );
    expect(read?.label).toContain('Read');
    expect(read?.size.basis).toBe('estimated-from-chars');
    expect(read!.size.tokens).toBeGreaterThan(0);
  });

  test('a harness attachment is an arrival of its own kind, born before the next call', () => {
    const att = analyzed.conversation.arrivals.filter((a) => a.source === 'attachment');
    expect(att.map((a) => a.label)).toEqual(['task_reminder']);
    // Injected after turn 1, so it is in the prompt of call 2 onward.
    expect(att[0]!.bornBeforeCall).toBe(2);
    expect(analyzed.stats.byKind.attachment).toBe(1);
  });

  test('assistant output is sized from the exact billed figure, per call', () => {
    const out = analyzed.conversation.arrivals.filter((a) => a.source === 'assistantOutput');
    expect(out.map((a) => a.size.tokens)).toEqual([100, 200, 300, 400]);
    expect(out.every((a) => a.size.basis === 'exact-api-usage')).toBe(true);
  });

  test('every tool_use in the fixture is paired with its result, and none is invented', () => {
    // toolu_guide is deliberately unanswered, so it pairs with nothing.
    expect(analyzed.conversation.tools.map((t) => t.toolUseId).sort()).toEqual([
      'toolu_edit',
      'toolu_read',
      'toolu_review',
      'toolu_skill',
      'toolu_skill2',
    ]);
    expect(analyzed.conversation.unmatchedToolResults).toBe(0);
  });

  test('a result whose tool_use was never seen is counted, never dropped', () => {
    // Written as literal lines rather than through the builder: the builder pairs by
    // construction, so it CANNOT produce this shape — which is the whole reason the
    // counter exists. Real transcripts truncated mid-session do produce it.
    const text =
      [
        JSON.stringify({
          type: 'user',
          uuid: 'x1',
          timestamp: '2026-01-01T00:00:00.000Z',
          cwd: FOREIGN_CWD,
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_from_a_lost_epoch', content: 'ok' }],
          },
        }),
      ].join('\n') + '\n';
    const conv = buildConversation(parseTranscript(text).lines);
    expect(conv.unmatchedToolResults).toBe(1);
    expect(conv.tools).toEqual([]);
  });
});

describe('the residency model still holds on a session that spawns', () => {
  test('every root call’s cache_read equals what its epoch wrote before it', () => {
    // Two independent routes to one quantity. Aggregate agreement is weak — two wrong
    // numbers cancel — so the claim asserted is the per-call one. A concrete count, not
    // `exactCalls === predictableCalls`: that equality is also true, vacuously, if a
    // regression misclassified every call as its own epoch-opener (predictableCalls and
    // exactCalls would both collapse to 0 together). Call 0 is this session's one epoch's
    // sole opener, so 3 of its 4 calls are predictable.
    expect(analyzed.conservation.predictableCalls).toBe(3);
    expect(analyzed.conservation.exactCalls).toBe(3);
    expect(analyzed.conservation.perCall.map((p) => p.delta)).toEqual([0, 0, 0, 0]);
  });

  test('the session runs on one cached prefix, as its usage vectors describe', () => {
    expect(analyzed.residency.epochs.length).toBe(1);
  });
});

describe('the pipeline reads only the files it was told about', () => {
  test('a path nobody wrote throws rather than analysing an empty transcript', () => {
    // The fixture's reader is the boundary's failure arm. A reader that returned '' for
    // an unknown path would let this whole suite pass against empty conversations.
    expect(() => fixture.read('/corpus/nowhere.jsonl')).toThrow(/no file at/);
  });

  test('a slash-command fork’s meta file carries no toolUseId key at all', () => {
    const metaPath = fixture.source.subagents.find((s) => s.agentId === 'a_recap')!.metaPath;
    expect(JSON.parse(fixture.read(metaPath)).toolUseId).toBeUndefined();
    // ...and the parser normalises that absence to '', which is what route B keys on.
    expect(placed('a_recap').meta.toolUseId).toBe('');
  });
});

describe('resolveForest is a pure function of what it is handed', () => {
  test('a session with no candidates resolves to a root and nothing else', () => {
    const conv = buildConversation(parseTranscript(fixture.read(fixture.source.path)).lines);
    const empty = resolveForest(conv, [] as Candidate[]);
    expect(empty).toEqual({ placed: [], orphans: [] });
  });
});
