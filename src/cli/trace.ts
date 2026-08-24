// The span tree, as a document something else can read.
//
// [LAW:effects-at-boundaries] Pure. Analysed sessions in, a JSON-shaped value out; the
// driver serialises and writes it.
//
// WHAT THIS IS NOT, said here because the name invites the assumption. This is not a
// Chrome Trace Event file and not OTLP. It is the span tree itself — the single source
// of truth every renderer in this project is a pure function of — handed out so that
// the exporters which target a specific viewer can be pure functions of it as well
// (miser-tracing-yhc.2 emits OTLP into Jaeger from exactly this shape). Writing a
// viewer format here would put a second span model in the project, one that a viewer
// upgrade could pull out of step with the pipeline's.

import { depthOf, lineagePath } from '../lineage.ts';
import type { AnalyzedSession } from '../session.ts';
import { rollup, type Span, type SpanDetail } from '../spans.ts';
import { spend, type Usage } from '../tokens.ts';

/** The wire shape of one span.
 *
 * Deliberately the internal `Span` plus its rolled-up cost, rather than a hand-written
 * parallel structure: a second shape would be a second representation of the tree, free
 * to drift from the one the pipeline actually holds. [LAW:one-source-of-truth] The two
 * additions are `depth` and `lineagePath`, which are functions of `lineage` computed
 * here so a consumer does not have to reimplement them to group by the dimension the
 * whole analysis pivots on. */
export interface TraceNode {
  id: string;
  label: string;
  kind: SpanDetail['kind'];
  detail: SpanDetail;
  /** How many spawn hops from the conversation a human was reading. 0 is the root. */
  depth: number;
  /** e.g. "main", or "code-review > Angle A line-by-line scan". */
  lineage: string;
  tStart: number;
  tEnd: number;
  callFirst: number;
  callLast: number;
  /** Exact usage summed over every call in this subtree, this span included. */
  usage: Usage;
  /** `usage` projected to input-equivalent tokens plus output. Exact. */
  tokEq: number;
  children: TraceNode[];
}

/** [LAW:dataflow-not-control-flow] One rule at every level. A session root, a turn and a
 * depth-4 sub-sub-subagent's tool call all take this same path; what differs is the data
 * handed in, never which branch runs. */
export function traceNode(span: Span): TraceNode {
  const usage = rollup(span);
  return {
    id: span.id,
    label: span.label,
    kind: span.detail.kind,
    detail: span.detail,
    depth: depthOf(span.lineage),
    lineage: lineagePath(span.lineage),
    tStart: span.tStart,
    tEnd: span.tEnd,
    callFirst: span.callFirst,
    callLast: span.callLast,
    usage,
    tokEq: Math.round(spend(usage)),
    children: span.children.map(traceNode),
  };
}

export interface TraceSession {
  session: string;
  project: string;
  /** The transcript this was built from, so a reader can go back to the original. */
  path: string;
  /** Fan-out, unpaired subagent files, orphans, format drift. [LAW:no-silent-failure]
   * These travel WITH the data rather than only reaching the HTML page: a consumer
   * computing totals off this file needs to know the tree it is summing had three
   * subagents nobody could place. */
  notes: string[];
  tree: TraceNode;
}

export interface TraceFile {
  /** Versioned because this is a published shape with consumers outside this repo. A
   * consumer that checks it gets a loud mismatch instead of silently misreading a field
   * that changed meaning. [LAW:no-silent-failure] */
  schema: 'cc-miser/span-tree@1';
  generatedAt: number;
  /** The directory scanned, and what narrowed it — so the file answers "which sessions
   * is this?" without anyone having to remember the command line that produced it. */
  projectsRoot: string;
  criteria: string[];
  sessions: TraceSession[];
}

export const SCHEMA = 'cc-miser/span-tree@1';

export const traceFile = (
  sessions: readonly AnalyzedSession[],
  projectsRoot: string,
  criteria: readonly string[],
  now: number,
): TraceFile => ({
  schema: SCHEMA,
  generatedAt: now,
  projectsRoot,
  criteria: [...criteria],
  sessions: sessions.map((a) => ({
    session: a.source.sessionId,
    project: a.workspace.name,
    path: a.source.path,
    notes: a.notes,
    tree: traceNode(a.tree),
  })),
});
