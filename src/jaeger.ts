// Where a session's exported spans live in Jaeger: the ids the exporter mints, and the
// URLs that open them.
//
// WHY THIS IS ITS OWN MODULE, BELOW BOTH SIDES. Two callers need the same answer from
// opposite ends of the program. `cli/otlp.ts` mints the ids on the way OUT, and
// `report/` links to them on the way IN — and `cli/main.ts` already imports `report/`,
// so a report that reached back into `cli/otlp.ts` for the digest would close a cycle.
// [LAW:one-way-deps] names the fix for exactly this shape: extract the shared concern
// into a unit below both. The alternative — the report recomputing
// `sha256(service + session)` on its own — is the two-clocks failure with a silent
// symptom, because a drifted digest still produces a well-formed hex id and a link that
// simply opens an empty trace. [LAW:one-source-of-truth]

import { createHash } from 'node:crypto';

/** The two domains the exporter publishes, as Jaeger sees them.
 *
 * THE SERVICE NAME IS NOT DECORATION — it is mixed into the trace-id digest below, so it
 * is a fact the exporter and the report must agree on to the byte. That is why it lives
 * here rather than as a literal at each end.
 *
 * Keyed rather than listed so that every consumer indexes it by a name the compiler
 * checks, and `cli/otlp.ts` can prove it has a layout for each one.
 * [LAW:types-are-the-program] */
export const DOMAINS = {
  time: {
    service: 'cc-miser-time',
    /** What a link to this domain calls it, in a reader's words — the caption on the
     * report's link, and the short name for the domain anywhere one is wanted. */
    label: 'wall clock',
    /** What one millisecond on this domain's axis MEANS, carried as the `cc_miser.axis`
     * span attribute because Jaeger labels the axis in time units whatever it is
     * measuring. Phrased as the same conversion on both domains so a reader who has seen
     * one can read the other: the time domain's is an identity, and saying so is what
     * makes the token domain's rescaling legible rather than surprising. */
    unit: 'one millisecond = one millisecond of real time',
  },
  tokens: {
    service: 'cc-miser-tokens',
    label: 'token cost',
    unit: 'one millisecond = one input-equivalent token',
  },
} as const;

/** Which domain a caller means. A `string` here would let any caller mint a well-formed
 * id for a service nothing publishes, and the resulting link would open an empty trace
 * rather than fail — an answer-shaped void. The union deletes that state.
 * [LAW:parse-dont-validate] */
export type DomainKey = keyof typeof DOMAINS;

export const DOMAIN_KEYS = Object.keys(DOMAINS) as readonly DomainKey[];

/** Where Jaeger's UI is when nobody says: the port `telemetry/stack.sh` publishes.
 *
 * NOT 16686. The well-known Jaeger port is what every telemetry stack on a developer
 * machine reaches for, so this project's stack yields it and publishes 17686 instead —
 * the same reasoning, and the same pair of files, as `DEFAULT_ENDPOINT` in
 * `cli/args.ts`. `scripts/verify-otlp.ts` reads this too, so the address a link points
 * at and the address the verifier checks cannot drift. [LAW:one-source-of-truth] */
export const DEFAULT_JAEGER = 'http://localhost:17686';

/** Trace and span ids, derived from what the span already is rather than drawn at random.
 *
 * Deterministic on purpose, and load-bearing twice over. It lets a re-export overwrite
 * the same trace in Jaeger instead of leaving a second copy beside it, so "what does this
 * session look like now" has one answer; and it lets the report address a span it never
 * exported, which is what makes a link out of a page that talks to no collector.
 * [FRAMING:representation]
 *
 * The session id is mixed in at every level because span ids are NOT unique across
 * sessions on their own: `turn:0` is the literal id of the first turn of every root
 * conversation in the corpus, and `spans.ts` only prefixes ids inside spawned
 * conversations.
 *
 * The parts are joined on a separator that cannot occur inside any of them, and that is
 * what keeps the digest unambiguous: joined on nothing, `("ab", "c")` and `("a", "bc")`
 * are one string and therefore one span id. A newline does the job here — session ids are
 * UUIDs, service names are literals, and `spans.ts` builds node ids out of colons — and it
 * is written as an ESCAPE. A raw control byte in the source makes the entire file binary
 * to git, which silently costs every future reviewer the diff. */
const hexId = (bytes: number, ...parts: readonly string[]): string =>
  createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, bytes * 2);

/** The trace one session occupies in one domain. */
export const traceIdOf = (domain: DomainKey, sessionId: string): string =>
  hexId(16, DOMAINS[domain].service, sessionId);

/** The span one span-tree node occupies. `nodeId` is the tree's own id, which
 * `spans.ts` owns and constructs — see `rootCallId` there for the one shape a consumer
 * outside the tree builder needs to name. */
export const spanIdOf = (domain: DomainKey, sessionId: string, nodeId: string): string =>
  hexId(8, DOMAINS[domain].service, sessionId, nodeId);

/** A base URL with any trailing slash removed, so `base + '/trace/…'` cannot produce the
 * double slash that Jaeger's router treats as a different route. Canonicalisation of a
 * value a person typed, not a check that skips work. */
const origin = (base: string): string => base.replace(/\/+$/, '');

/** The whole trace: what Jaeger opens at `…/trace/<id>`. */
export const traceUrl = (base: string, domain: DomainKey, sessionId: string): string =>
  `${origin(base)}/trace/${traceIdOf(domain, sessionId)}`;

/** One span inside its trace, selected on arrival.
 *
 * `uiFind` is Jaeger's own span-selection parameter — the one its UI writes into the
 * address bar when you click a span — so a link built with it lands the reader on the
 * span rather than at the top of a trace with hundreds of them. Verified against the
 * running v1.76.0 UI rather than taken from the docs. */
export const spanUrl = (
  base: string,
  domain: DomainKey,
  sessionId: string,
  nodeId: string,
): string => `${traceUrl(base, domain, sessionId)}?uiFind=${spanIdOf(domain, sessionId, nodeId)}`;
