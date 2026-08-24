// The identities the pipeline's numbers must satisfy, and the runner that names every
// place one of them fails.
//
// WHY THIS FILE EXISTS, in one sentence: an oracle that checks the pipeline against
// another computation of the pipeline cannot catch a wrong belief that both sides share.
// That is not a hypothetical. This project shipped a reader that took each request
// group's usage from its FIRST line, while `output_tokens` is a partial count that rises
// as the response streams. A hand-written oracle recomputed every figure from raw JSONL
// using none of this pipeline's code, asserted exact agreement on sixteen quantities, and
// reported AGREEMENT on every run — for the life of the project — while 27.4% of every
// output token ever billed was missing. The two implementations shared no arithmetic and
// the same wrong belief about the DATA, which independence does nothing about.
//
// So an identity earns its place here by being closeable against a number NEITHER
// implementation derived. Two below have that shape and say so in their `basis`:
// `cache-creation-accounted` closes the figure this pipeline costs from against a
// breakdown of the same fact in the same API usage block, and `cache-read-recurrence`
// closes one call's reported `cache_read` against two fields of the call before it. The
// rest are internal, and are marked as such rather than flattered.
//
// [LAW:effects-at-boundaries] Pure. Takes analysed sessions, returns findings.

import type { Call, Conversation } from './calls.ts';
import type { AnalyzedSession } from './session.ts';
import { rollup } from './spans.ts';
import { ZERO_USAGE, addUsage, type Usage } from './tokens.ts';

/** One equation, at one place it is claimed to hold.
 *
 * [LAW:types-are-the-program] An identity yields CLAIMS rather than a pass/fail, which is
 * what makes "names the session, the call and the identity it violated" a property of the
 * shape instead of a formatting convention each identity has to remember. There is no way
 * to report a violation without having said where it is. */
export interface Claim {
  /** Which call, boundary or component within the session. Reaches the reader verbatim
   * on failure, so it must locate the site on its own. */
  site: string;
  left: number;
  right: number;
}

/** An identity the corpus must satisfy, written as a ROW rather than as a function.
 *
 * [LAW:dataflow-not-control-flow] A newly-discovered identity is DATA — one more entry in
 * `IDENTITIES` — never another test body with its own idea of how to report a failure.
 * One runner walks every row, so every violation is located and formatted the same way,
 * and the twentieth identity costs what the second did. */
export interface Identity {
  name: string;
  /** What the two sides are, in a sentence a failure message can carry. */
  says: string;
  /** Why `maxViolationRate` is the number it is: the measurement behind it, or the
   * argument that no violation is admissible at all. Written down here because a bare
   * tolerance is a magic number, and a magic number is a claim with its evidence
   * discarded. */
  basis: string;
  /** The share of sites permitted to violate it.
   *
   * Zero makes the row a LAW: something that must be true of any corpus, on any machine,
   * because it follows from what the pipeline does rather than from what Anthropic's
   * cache happened to do. A non-zero rate makes it a MEASURED REGULARITY — real, useful,
   * and honest about not being exact. [LAW:no-silent-failure] Both kinds still name every
   * site that failed; the rate decides only whether the suite goes red, never whether the
   * reader is told. */
  maxViolationRate: number;
  claims: (s: AnalyzedSession) => Claim[];
}

export interface Violation {
  identity: string;
  session: string;
  site: string;
  left: number;
  right: number;
  delta: number;
}

export interface Audit {
  identity: Identity;
  sites: number;
  violations: Violation[];
  /** How many violations this identity's rate admits across this many sites. */
  allowed: number;
  held: boolean;
}

/** Every conversation a session holds, root and spawned alike.
 *
 * [LAW:one-type-per-behavior] A spawned conversation is the same kind of thing as a root
 * one — `buildConversation` produces both — so an identity that holds of a session's
 * calls holds of a subagent's, and checking only the root would leave the deepest and
 * least-watched spend unexamined. */
const conversationsOf = (s: AnalyzedSession): Array<{ what: string; conv: Conversation }> => [
  { what: 'root', conv: s.conversation },
  ...s.forest.placed.map((p) => ({ what: `agent ${p.meta.agentId}`, conv: p.conversation })),
];

/** The four components of a usage vector, enumerated once.
 *
 * [LAW:one-source-of-truth] Every per-component identity below maps over this rather than
 * spelling the four names out again — a fifth component would otherwise be checked by
 * whichever identities someone remembered to update. */
const USAGE_COMPONENTS = ['input', 'cacheCreation', 'cacheRead', 'output'] as const;

/** Adjacent call pairs whose cached prefix survived from one to the next.
 *
 * [LAW:dataflow-not-control-flow] Site SELECTION is a filter over data, so the identity
 * below runs one unconditional expression at every site it is handed rather than deciding
 * per call whether to check. A boundary where `cache_read` dropped is not a violation and
 * not an exception — the cached prefix died, so there is no prediction to make and no
 * claim is produced. */
const cacheSurvivingBoundaries = (conv: Conversation): Array<{ i: number; a: Call; b: Call }> =>
  conv.calls
    .slice(0, -1)
    .map((a, i) => ({ i, a, b: conv.calls[i + 1]! }))
    .filter(({ a, b }) => b.usage.cacheRead >= a.usage.cacheRead);

/** Request groups whose last line carried a real usage block.
 *
 * The groups whose final line is an all-zero placeholder — every usage field zero, with
 * `service_tier` and `iterations` both null — are excluded, because there the rival rule
 * is not a rival but a known-broken reading. That exclusion is the whole reason
 * `completeUsage` takes the maximum rather than the last.
 *
 * The exclusion is known to be SUFFICIENT rather than assumed to be. Re-measured over all
 * 943 transcripts: of 48,155 request groups, 53 have a placeholder tail and ZERO have a
 * non-zero last line that disagrees with the adopted maximum. Nothing beyond the
 * placeholder is being quietly forgiven, which is the only thing that makes the identity
 * below evidence rather than a formality. */
const groupsWithRealLastLine = (conv: Conversation): Call[] =>
  conv.calls.filter((c) => USAGE_COMPONENTS.some((k) => c.lastLineUsage[k] !== 0));

/** Calls whose adopted line's usage block carried a `cache_creation` breakdown.
 *
 * A block with none makes `unaccountedCacheCreation` trivially 0 — nothing was there to
 * disagree with `cache_creation_input_tokens` — which is a different fact from a
 * breakdown that was checked and found to sum correctly. Excluded the same way
 * `groupsWithRealLastLine` excludes placeholder tails: not a violation and not an
 * exception, a call with nothing to claim. [LAW:no-silent-failure] */
const groupsWithCacheCreationBreakdown = (conv: Conversation): Call[] =>
  conv.calls.filter((c) => c.hasCacheCreationBreakdown);

const flatUsage = (s: AnalyzedSession): Usage =>
  conversationsOf(s)
    .flatMap(({ conv }) => conv.calls)
    .reduce((a, c) => addUsage(a, c.usage), ZERO_USAGE);

export const IDENTITIES: readonly Identity[] = [
  {
    name: 'tree-holds-every-token',
    says: "the span tree's rolled-up usage equals the usage of every call the parser produced",
    basis:
      'LAW. Grafting rearranges calls; it does not create or destroy tokens. Exact on ' +
      '438/438 sessions. The count-only form of this claim found 130 dropped calls and ' +
      '3.1M input-equivalent tokens on its first run; stated over TOKENS it also catches ' +
      'a call that reached the tree carrying the wrong usage, which counting cannot see.',
    maxViolationRate: 0,
    claims: (s) => {
      const tree = rollup(s.tree);
      const flat = flatUsage(s);
      return USAGE_COMPONENTS.map((k) => ({
        site: `tree rollup vs parsed calls: ${k}`,
        left: tree[k],
        right: flat[k],
      }));
    },
  },

  {
    name: 'cache-creation-accounted',
    says:
      'the flat cache_creation figure this pipeline costs from totals the per-TTL ' +
      'breakdown reported beside it in the same API usage block',
    basis:
      'LAW, and one of the two rows that closes against figures NEITHER implementation ' +
      'derived: both sides are raw API output, and the breakdown is read nowhere else in ' +
      'the pipeline. Exact across every call whose adopted line carries a breakdown — a ' +
      'call with none is excluded from being a site at all (`groupsWithCacheCreationBreakdown`), ' +
      'because there `unaccountedCacheCreation` is 0 by construction rather than by a ' +
      'check that ran and passed; counting it as a site would inflate this row exactly ' +
      "the way an unfiltered `residency-predicts-cache-read` used to. It is also the " +
      'only alarm for format drift on the TOKEN axis — a new TTL tier that stops being ' +
      'included in the flat total leaves the line type, and every field we read, ' +
      'unchanged, so `unknownTypes` is structurally blind to it.',
    maxViolationRate: 0,
    claims: (s) =>
      conversationsOf(s).flatMap(({ what, conv }) =>
        groupsWithCacheCreationBreakdown(conv).map((c) => ({
          site: `${what} call ${c.index}: cache-creation tiers vs flat total`,
          left: c.unaccountedCacheCreation,
          right: 0,
        })),
      ),
  },

  {
    name: 'cache-read-recurrence',
    says:
      "each call's cache_read equals the previous call's cache_read plus what that call " +
      'wrote, wherever the cached prefix survived',
    basis:
      'MEASURED: exact on 46,067 of 46,462 cache-surviving boundaries (99.15%). The ' +
      'second row closing against figures neither implementation derived — three fields ' +
      'of two DIFFERENT calls, straight off their API usage blocks. It is a regularity ' +
      'and not a law because the residual is real: 55 boundaries read less than was ' +
      'written (a prefix partially expired) and 340 read more, all after idle gaps of ' +
      'minutes. The rate is set well above the measured 0.85% because it is a fact about ' +
      "Anthropic's cache on one corpus, not about this code; what it catches is a " +
      'COLLAPSE, which is what misreading a usage block looks like.',
    maxViolationRate: 0.05,
    claims: (s) =>
      conversationsOf(s).flatMap(({ what, conv }) =>
        cacheSurvivingBoundaries(conv).map(({ i, a, b }) => ({
          site: `${what} call ${i}->${i + 1}: cache_read`,
          left: b.usage.cacheRead,
          right: a.usage.cacheRead + a.usage.cacheCreation,
        })),
      ),
  },

  {
    name: 'output-snapshot-agrees',
    says:
      'the output figure adopted for a request group equals the one its last line ' +
      'reported',
    basis:
      'MEASURED: exact on 47,949 of 47,949 sites. This is the OUTPUT-side guard, and ' +
      'output is precisely the quantity that was wrong by 27.4%. `completeUsage` picks one ' +
      'snapshot per group by MAX, a property of the set of lines; the last line is an ' +
      'independent rule over the same raw data, a property of their order. The two cannot ' +
      'agree by construction, so agreement is evidence. A revert to the first-line reader ' +
      'fails this row on the 5,449 groups whose output streams — the exact bug, caught at ' +
      'the exact site. The known disagreements are the all-zero placeholder tails, which ' +
      'are excluded from being sites at all. The rate is not zero only because a partial ' +
      'placeholder — a tail zeroed in `output` but not in every field — would slip that ' +
      'exclusion on a corpus we have not seen; at 0.1% it still admits nothing systematic.',
    maxViolationRate: 0.001,
    claims: (s) =>
      conversationsOf(s).flatMap(({ what, conv }) =>
        groupsWithRealLastLine(conv).map((c) => ({
          site: `${what} call ${c.index}: adopted output vs last line's`,
          left: c.usage.output,
          right: c.lastLineUsage.output,
        })),
      ),
  },

  {
    name: 'residency-predicts-cache-read',
    says:
      "the residency model's prediction of each call's cache_read equals the cache_read " +
      'the API reported',
    basis:
      'MEASURED: exact on 83.9% of 41,547 PREDICTABLE calls — epoch-opening calls are ' +
      'excluded (`PerCallCheck.predictable`), because there `expected` reduces to the ' +
      "call's own reported value with nothing added, so it matches by construction and " +
      'is not a genuine prediction; counting it would inflate this rate with calls the ' +
      "model never actually predicted. INTERNAL — it grades this pipeline's own model, " +
      'so it is weaker evidence than the two rows above and is kept for a different job: ' +
      'it is the licence every residency-derived number downstream runs on, and it was ' +
      'previously justified by "28 of 28 calls of the hand-traced specimen" while ' +
      'scoring 26.2% on the corpus (that figure and the one in residency.ts predate the ' +
      'predictable/not split and are stated over all calls, not just predictable ones). ' +
      'The rate is set to catch a collapse back to something like that, not to certify ' +
      'the model. The residual is cumulative by nature — one bad boundary poisons every ' +
      'later call in its epoch — which is why `cache-read-recurrence` states the same ' +
      'physics locally and scores 99.15%. SCOPE, stated so it is not assumed away: this ' +
      'row reads the conservation check the pipeline STORED, which `analyzeSession` ' +
      'computes for the root conversation only, so spawned conversations are outside it. ' +
      'They are inside every other row. Residency is not modelled per subagent yet; when ' +
      'it is, this row widens with it.',
    maxViolationRate: 0.3,
    claims: (s) =>
      s.conservation.perCall
        .filter((p) => p.predictable)
        .map((p) => ({
          site: `root call ${p.call}: predicted vs reported cache_read`,
          left: p.actual,
          right: p.expected,
        })),
  },
];

/** The identity with this name.
 *
 * [LAW:parse-dont-validate] A name becomes an Identity here or not at all. `find` returns
 * `Identity | undefined`, and a caller that took the undefined would run zero claims and
 * report that nothing violated — an answer-shaped void, and the exact way a renamed row
 * would quietly stop being checked while its test kept passing. */
export function identityNamed(name: string): Identity {
  const found = IDENTITIES.find((i) => i.name === name);
  if (!found)
    throw new Error(
      `no identity named "${name}" — known identities: ${IDENTITIES.map((i) => i.name).join(', ')}`,
    );
  return found;
}

/** Run every identity over every session, and locate each failure.
 *
 * [LAW:no-silent-failure] Returns an audit per identity whether or not it held. An
 * identity that produced no claims at all reports zero sites rather than passing quietly
 * — a check that never ran and a check that passed are different facts, and collapsing
 * them is how a suite comes to certify work it never did. */
export function auditCorpus(
  sessions: readonly AnalyzedSession[],
  identities: readonly Identity[] = IDENTITIES,
): Audit[] {
  return identities.map((identity) => {
    let sites = 0;
    const violations: Violation[] = [];
    for (const s of sessions)
      for (const c of identity.claims(s)) {
        sites++;
        if (c.left === c.right) continue;
        violations.push({
          identity: identity.name,
          session: s.source.sessionId,
          site: c.site,
          left: c.left,
          right: c.right,
          delta: c.left - c.right,
        });
      }
    const allowed = Math.floor(identity.maxViolationRate * sites);
    return { identity, sites, violations, allowed, held: violations.length <= allowed };
  });
}

/** One violation, as a line a reader can act on without opening this file. */
export const describeViolation = (v: Violation): string =>
  `${v.identity}: session ${v.session}, ${v.site} — ${v.left} vs ${v.right} (off by ${v.delta})`;

/** An audit's whole story: the identity, how it scored, and the sites that failed.
 *
 * The first few violations are shown rather than all of them: a collapsed identity can
 * fail at tens of thousands of sites, and a failure message nobody can read is a failure
 * message nobody reads. The COUNT is never truncated, so the scale of the break is always
 * stated even when its every instance is not. */
export function describeAudit(a: Audit, show = 5): string {
  const head =
    `${a.held ? 'held' : 'BROKE'}  ${a.identity.name}  ` +
    `${a.sites - a.violations.length}/${a.sites} sites exact` +
    `${a.allowed > 0 ? ` (${a.allowed} admitted)` : ''}`;
  return [head, ...a.violations.slice(0, show).map((v) => `    ${describeViolation(v)}`)].join('\n');
}
