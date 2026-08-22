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
export type Tier = DecidedTier | 'none';

/** A tier that actually reached a verdict. */
export type DecidedTier = 'marker' | 'rule' | 'judge' | 'hand';

/** A decided label, with its provenance.
 *
 * [FRAMING:representation] `tier` is a FIELD, not something recovered by sniffing
 * `because` for a `[marker]` prefix. An earlier version wrote the tier into the prose
 * and parsed it back out — one fact stored in its own rendering, which drifts the
 * first time anybody rewords a `because`.
 *
 * [LAW:types-are-the-program] The union forbids the one combination that is a lie:
 * `unclassified` at any tier but `none`. It was reachable and it was reached — the
 * catch-all row for "ran tools, but nothing matched" stamped tier `rule`, so 14.7% of
 * corpus calls were counted as rule-decided when what actually happened is that no
 * rule fired. That reads on the page as 97% coverage and 0% unknown, which is the
 * precise shape of an answer-shaped void: it has the form of an answer and means "I
 * could not do my job". Coverage is the number a reader uses to decide how much of
 * this page to believe, so it is the last number allowed to flatter itself. */
export type Label =
  | { activity: Exclude<Activity, 'unclassified'>; tier: DecidedTier; because: string }
  | { activity: 'unclassified'; tier: 'none'; because: string };

/** The only way to build a Label, so the invariant above holds by construction rather
 * than by every call site remembering it. A caller may propose any tier; proposing one
 * for `unclassified` is silently impossible rather than quietly accepted. */
export const label = (activity: Activity, tier: DecidedTier, because: string): Label =>
  activity === 'unclassified' ? { activity, tier: 'none', because } : { activity, tier, because };

/** The same verdict with a different explanation — used when a spawned conversation
 * inherits its spawner's label and needs to say where the label came from.
 *
 * Lives here, beside the type, because rebuilding a Label field-by-field at a call site
 * is exactly how the forbidden combination gets reintroduced. */
export const withReason = (l: Label, because: string): Label =>
  l.activity === 'unclassified' ? { ...l, because } : { ...l, because };

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
