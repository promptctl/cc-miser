// What phase of work a call belongs to, and how confidently we know that.
//
// [LAW:one-way-deps] Imports nothing. The classifier that DECIDES labels, the span
// tree that CARRIES them and the report model that SHOWS them all import this.

/** PROJECT.md's phases of work. Activities PARTITION the call sequence — every call
 * belongs to exactly one — so "what share went to X" is a query rather than a
 * judgment call. `unclassified` is what keeps that total honest. */
export type Activity =
  | 'orientation'
  | 'exploration'
  | 'design'
  | 'implementation'
  | 'verification'
  | 'debugging'
  | 'review'
  | 'scm'
  | 'process'
  | 'reporting'
  | 'overhead'
  | 'unclassified';

/** Which tier of PROJECT.md's cascade decided a label. Cheapest and most certain
 * first; `none` is the honesty bucket and is always rendered, never smoothed away. */
export type Tier = 'marker' | 'rule' | 'judge' | 'hand' | 'none';

/** A decided label, with its provenance.
 *
 * [FRAMING:representation] `tier` is a FIELD, not something recovered by sniffing
 * `because` for a `[marker]` prefix. An earlier version wrote the tier into the prose
 * and parsed it back out — one fact stored in its own rendering, which drifts the
 * first time anybody rewords a `because`. */
export interface Label {
  activity: Activity;
  tier: Tier;
  /** The specific evidence, in words a reader can check against the transcript. */
  because: string;
}

/** The honesty bucket. Not a fallback that makes coverage look complete — a stated
 * absence of evidence, rendered as such. */
export const UNCLASSIFIED: Label = {
  activity: 'unclassified',
  tier: 'none',
  because: 'no classifier produced a label for this call',
};

/** PROJECT.md's invariant, checked rather than assumed: the labels cover every call
 * exactly once. A gap would silently break every percentage downstream. */
export function assertPartition(labels: readonly Label[], callCount: number): void {
  if (labels.length !== callCount)
    throw new Error(`activity labels do not partition the calls: ${labels.length} labels for ${callCount} calls`);
}
