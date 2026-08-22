// Resolve the tree of spawned conversations from a flat directory of transcripts.
//
// [LAW:effects-at-boundaries] Pure. Takes already-parsed conversations plus the
// metadata read off each `.meta.json`, returns where each one sits.

import type { Conversation } from './calls.ts';
import { ROOT, isChildOf, type Lineage, type Spawn } from './lineage.ts';

/** What a subagent's `.meta.json` claims about itself. */
export interface SpawnMeta {
  agentId: string;
  agentType: string;
  description: string;
  /** The tool_use block that started this conversation — in SOME transcript, not
   * necessarily the root's. Empty when the meta file recorded none, which is what a
   * slash-command fork looks like. */
  toolUseId: string;
  /** What the harness itself claimed. Cross-checked against the resolved chain. */
  declaredDepth: number;
}

/** Read a subagent's `.meta.json` into the claims we use.
 *
 * [LAW:parse-dont-validate] The one place a meta file's shape is known. `toolUseId`
 * normalises to '' rather than null/undefined, because "no spawning tool_use block" is
 * exactly what a slash-command fork looks like — it is a real, expected case that
 * route B handles, not an absence to guard against downstream. */
export function parseSpawnMeta(raw: unknown, agentId: string): SpawnMeta {
  const o: Record<string, unknown> = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d);
  return {
    agentId,
    agentType: str(o.agentType, '?'),
    description: str(o.description, '(no description)'),
    toolUseId: str(o.toolUseId, ''),
    declaredDepth: typeof o.spawnDepth === 'number' ? o.spawnDepth : 1,
  };
}

/** A candidate before resolution: we have its transcript, not yet its place. */
export interface Candidate {
  meta: SpawnMeta;
  conversation: Conversation;
}

/** A candidate after resolution: the same conversation, plus where it sits. */
export interface PlacedConversation extends Candidate {
  lineage: Lineage;
}

export interface Orphan {
  meta: SpawnMeta;
  why: string;
}

export interface Forest {
  placed: PlacedConversation[];
  orphans: Orphan[];
}

/** Resolve the spawn FOREST from a flat set of candidate transcripts.
 *
 * The `subagents/` directory is flat, but the spawn structure is a TREE — each agent
 * has exactly one spawning edge, hence exactly one parent, so it can never be a DAG.
 * What makes resolution non-trivial is that a grandchild's `meta.toolUseId` points at
 * a tool_use block inside ANOTHER SUBAGENT's transcript, not the root's. So linking is
 * a FIXPOINT over "which transcript owns this tool_use id", not a single pass over the
 * root: each newly attached conversation contributes tool_use ids that may be the
 * parent edge of a candidate still pending.
 *
 * [LAW:no-silent-failure] Anything that cannot be attached to a resolved parent comes
 * back as an orphan with the reason. Silently flattening an unlinkable grandchild to
 * depth 1 would corrupt every depth-keyed number downstream, and one missing link
 * cascades — resolving only the tool_use edge orphaned all 14 subagents of session
 * 4700e3d6, because the one command-forked ancestor took its whole subtree with it. */
export function resolveForest(root: Conversation, candidates: readonly Candidate[]): Forest {
  // Which conversation owns each tool_use id, and at which call index. The root is
  // keyed by '' — it has no agentId, being nobody's child.
  const owner = new Map<string, { agentId: string; callIndex: number }>();
  const byAgent = new Map<string, { conversation: Conversation; lineage: Lineage }>([
    ['', { conversation: root, lineage: ROOT }],
  ]);

  const indexTools = (c: Conversation, agentId: string): void => {
    for (const call of c.calls)
      for (const b of call.blocks)
        if (b.kind === 'tool_use') owner.set(b.id, { agentId, callIndex: call.index });
  };
  indexTools(root, '');

  const placed: PlacedConversation[] = [];
  const pending = [...candidates];
  const orphans: Orphan[] = [];

  const attach = (
    cand: Candidate,
    parentAgentId: string,
    spawnedAtCall: number,
    via: Spawn['via'],
  ): void => {
    const parent = byAgent.get(parentAgentId)!;
    const lineage: Lineage = [
      ...parent.lineage,
      { agentId: cand.meta.agentId, agentType: cand.meta.agentType, spawnedAtCall, via },
    ];
    byAgent.set(cand.meta.agentId, { conversation: cand.conversation, lineage });
    indexTools(cand.conversation, cand.meta.agentId);
    placed.push({ ...cand, lineage });
  };

  // Fixpoint over BOTH edge kinds. Route A is exact and is always exhausted first, so
  // route B only ever sees agents route A cannot reach — a tool_use edge can never be
  // overridden by the weaker depth signal.
  let progress = true;
  while (progress && pending.length > 0) {
    progress = false;

    // Route A — the exact tool_use edge.
    for (let i = pending.length - 1; i >= 0; i--) {
      const cand = pending[i]!;
      if (!cand.meta.toolUseId) continue;
      const own = owner.get(cand.meta.toolUseId);
      if (!own || !byAgent.has(own.agentId)) continue;
      attach(cand, own.agentId, own.callIndex, 'tool_use');
      pending.splice(i, 1);
      progress = true;
    }
    if (progress) continue;

    // Route B — a slash-command fork. No tool_use block exists, so the parent is
    // identified by depth: meta.spawnDepth N means the parent sits at depth N-1.
    // Attached only when exactly ONE resolved conversation qualifies; ambiguity is
    // reported, never guessed. [LAW:no-silent-failure]
    for (let i = pending.length - 1; i >= 0; i--) {
      const cand = pending[i]!;
      if (cand.meta.toolUseId) continue;
      const wantDepth = cand.meta.declaredDepth - 1;
      const hits = [...byAgent.entries()].filter(([, v]) => v.lineage.length === wantDepth);
      if (hits.length !== 1) continue;
      const [parentAgentId, parent] = hits[0]!;
      // No spawning call exists; place the fork at the parent call that most closely
      // precedes the child's first call, which is what a waterfall needs anyway.
      const firstTs = cand.conversation.calls[0]?.ts ?? 0;
      const at = parent.conversation.calls.reduce((best, c, idx) => (c.ts <= firstTs ? idx : best), 0);
      attach(cand, parentAgentId, at, 'command');
      pending.splice(i, 1);
      progress = true;
    }
  }

  for (const p of pending) {
    const wantDepth = p.meta.declaredDepth - 1;
    const hits = [...byAgent.values()].filter((v) => v.lineage.length === wantDepth).length;
    orphans.push({
      meta: p.meta,
      why: p.meta.toolUseId
        ? `spawning tool_use ${p.meta.toolUseId} not found in any transcript`
        : `no toolUseId, and ${hits} resolved conversations sit at depth ${wantDepth} (need exactly 1)`,
    });
  }
  return { placed, orphans };
}

/** Conversations spawned DIRECTLY by `parent`.
 *
 * [LAW:one-source-of-truth] Parentage is read off the resolved lineage, never
 * re-derived by re-matching ids, so the span tree and the forest cannot disagree. */
export const directChildren = (
  all: readonly PlacedConversation[],
  parent: Lineage,
): PlacedConversation[] => all.filter((c) => isChildOf(c.lineage, parent));

/** Where the harness's own `spawnDepth` disagrees with the chain we resolved.
 *
 * [LAW:one-source-of-truth] Two maps of one fact. The chain is authoritative because
 * it was resolved structurally; a disagreement is REPORTED rather than reconciled
 * away, because reconciling would hide whichever of the two is broken. */
export const depthDisagreements = (f: Forest): string[] =>
  f.placed
    .filter((c) => c.lineage.length !== c.meta.declaredDepth)
    .map((c) => `${c.meta.agentId}: chain=${c.lineage.length} meta.spawnDepth=${c.meta.declaredDepth}`);
