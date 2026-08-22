// Which conversation a thing belongs to: the chain of spawns that reached it.
//
// [LAW:one-way-deps] Imports nothing. Both the resolver that BUILDS lineages
// (`forest.ts`) and the report model that CARRIES them import this, so the concept has
// one home instead of two structurally-identical copies that drift.

/** One spawn hop: an agent conversation started from within its parent.
 *
 * Two edge kinds exist in this corpus and both are required — a tool_use-only
 * resolver loses whole subtrees, because a slash-command fork leaves no tool_use
 * block behind and every conversation beneath it then becomes unreachable. `via`
 * records which route established the edge, so neither is a silent fallback. */
export interface Spawn {
  agentId: string;
  agentType: string;
  /** Index of the call, IN THE PARENT CONVERSATION, this fork happened at. Exact for
   * a tool_use edge; derived from timestamps for a command edge, which has no call. */
  spawnedAtCall: number;
  via: 'tool_use' | 'command';
}

/** WHICH CONVERSATION a span belongs to — the chain of spawns that reached it.
 *
 * [LAW:types-are-the-program] A chain, not an enum. `{kind:'root'} | {kind:'subagent'}`
 * looks like a union but is a boolean in a trenchcoat: the tag carries exactly the one
 * bit that depth already carries, and it caps the domain at two levels, so the next
 * requirement invents `subsubagent`. That is mode explosion by another name. The real
 * domain is UNBOUNDED nesting, and the strongest true theorem about unbounded nesting
 * is a sequence: root is `[]`, depth is `.length`, and depth 7 needs no new code.
 *
 * It matters empirically, not just aesthetically: on session 4700e3d6, depth 0 is 0.7%
 * of spend, depth 1 is 33.1%, and depth 2 is 66.2%. A boolean would have hidden that
 * the grandchildren are where the money is.
 *
 * [LAW:dataflow-not-control-flow] This is a DIMENSION carried on every span, never a
 * branch in the analysis. Rollup keeps one rule; every cohort ("main", "depth 2",
 * "spawned by Explore") is a predicate VALUE handed to that one rule. */
export type Lineage = readonly Spawn[];

export const ROOT: Lineage = [];

export const depthOf = (l: Lineage): number => l.length;

/** The agent whose conversation this is directly in; absent at the root. */
export const immediateAgent = (l: Lineage): Spawn | undefined => l[l.length - 1];

/** e.g. "main", or "code-review > Angle A line-by-line scan" */
export const lineagePath = (l: Lineage): string =>
  l.length === 0 ? 'main' : l.map((s) => s.agentType).join(' > ');

/** Who supplies the prompts for this conversation.
 *
 * [LAW:comments-carry-meaning] This is a CLAIM, not a fact the transcript states. A
 * root transcript is normally human-driven, but `claude -p` in a shell loop is a root
 * transcript with no human in it. Lineage is the fact; driver is the reading. */
export const driverOf = (l: Lineage): 'human' | 'agent' => (l.length === 0 ? 'human' : 'agent');

/** True when `child` was reached by extending `parent` by exactly one hop. */
export const isChildOf = (child: Lineage, parent: Lineage): boolean =>
  child.length === parent.length + 1 && parent.every((s, i) => child[i]!.agentId === s.agentId);
