// Analyse one session end to end: parse, group into calls, resolve the spawn forest,
// classify, build the span tree, and model residency.
//
// [LAW:decomposition] This module composes; it computes nothing of its own. Every
// number here is produced by exactly one of the primitives below it, which is what
// makes a second consumer (a CLI, a JSON export, a different report) a matter of
// calling this rather than re-assembling the pipeline.

import { buildConversation, type Conversation } from './calls.ts';
import { classifyCalls } from './classify.ts';
import { parseSpawnMeta, resolveForest, depthDisagreements, type Candidate, type Forest } from './forest.ts';
import { parseTranscript, type ParseStats } from './records.ts';
import { conservation, findEpochs, type ConservationCheck, type Residency } from './residency.ts';
import { buildSessionTree, type Span } from './spans.ts';
import { UNCLASSIFIED, assertPartition, type Label } from './activity.ts';
import type { SessionSource } from './discover.ts';

export interface AnalyzedSession {
  source: SessionSource;
  /** The root conversation — the part a human can read. */
  conversation: Conversation;
  forest: Forest;
  /** Labels for the ROOT conversation, index-aligned with `conversation.calls`.
   * Spawned conversations inherit their spawner's label inside the tree. */
  labels: Label[];
  tree: Span;
  residency: Residency;
  conservation: ConservationCheck;
  stats: ParseStats;
  /** Facts that must stay visible on the page: fan-out, unlinked agents, drift.
   * [LAW:no-silent-failure] */
  notes: string[];
}

/** Read a file's text. Injected rather than imported so the whole analysis above stays
 * a pure function — `analyzeSession(src, (p) => fixtures[p])` needs no filesystem at
 * all. [LAW:effects-at-boundaries] */
export type ReadText = (path: string) => string;

export function analyzeSession(source: SessionSource, readText: ReadText): AnalyzedSession {
  const { lines, stats } = parseTranscript(readText(source.path));
  const conversation = buildConversation(lines);

  const candidates: Candidate[] = source.subagents.map((s) => ({
    meta: parseSpawnMeta(JSON.parse(readText(s.metaPath)), s.agentId),
    conversation: buildConversation(parseTranscript(readText(s.transcriptPath)).lines),
  }));
  const forest = resolveForest(conversation, candidates);

  // A spawning tool_use id names the agent it started, which is how a marker rule can
  // see "this call spawned an Explore".
  const agentTypeByToolUseId = new Map<string, string>(
    forest.placed.flatMap((c) => (c.meta.toolUseId ? [[c.meta.toolUseId, c.meta.agentType] as const] : [])),
  );
  const labels = classifyCalls(conversation.calls, agentTypeByToolUseId);
  assertPartition(labels, conversation.calls.length);

  const tree = buildSessionTree(
    conversation,
    forest.placed,
    (i) => labels[i] ?? UNCLASSIFIED,
    source.sessionId,
  );
  const res = findEpochs(conversation.calls);

  return {
    source,
    conversation,
    forest,
    labels,
    tree,
    residency: res,
    conservation: conservation(conversation.calls, res),
    stats,
    notes: notesFor(conversation, forest, stats, source),
  };
}

function notesFor(
  conv: Conversation,
  forest: Forest,
  stats: ParseStats,
  source: SessionSource,
): string[] {
  const fanOut = conv.calls.length === 0 ? 0 : stats.byKind.assistant / conv.calls.length;
  const unknown = Object.entries(stats.unknownTypes);
  return [
    `${stats.byKind.assistant} JSONL lines collapsed to ${conv.calls.length} API calls (${fanOut.toFixed(2)}x fan-out)`,
    `${conv.tools.length} tool executions paired, ${conv.unmatchedToolResults} unmatched`,
    ...(stats.unparseableLines ? [`${stats.unparseableLines} unparseable JSONL lines`] : []),
    // A line type we have never seen means the transcript format moved under us. It is
    // named here rather than counted silently, because every downstream number is
    // computed as if we understood the whole file.
    ...(unknown.length
      ? [`UNKNOWN line types (format drift?): ${unknown.map(([k, v]) => `${k}=${v}`).join(', ')}`]
      : []),
    ...source.unpaired.map((u) => `UNPAIRED subagent files: ${u}`),
    ...forest.orphans.map((o) => `ORPHAN subagent ${o.meta.agentId} (${o.meta.agentType}): ${o.why}`),
    ...depthDisagreements(forest).map((d) => `spawnDepth disagreement: ${d}`),
  ];
}
