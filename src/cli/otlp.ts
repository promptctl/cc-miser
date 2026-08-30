// The corpus as OTLP spans: the span tree `miser trace` already publishes, rendered into
// the one wire format Jaeger speaks.
//
// [LAW:effects-at-boundaries] Pure. A `TraceSession` in, one JSON-shaped request value
// out. Nothing here opens a socket, reads a clock or touches the disk — the driver does
// that — which is what lets the whole translation be exercised on a fixture tree with no
// collector running and no mocks.
//
// THE COUNTING TRAP THIS CANNOT FALL INTO, said here because the obvious implementation
// of "emit the corpus as OTLP" is a second transcript reader, and a second transcript
// reader gets this wrong. The transcript writes one usage record PER CONTENT BLOCK,
// repeating the same `requestId`, so anything that sums usage straight off the lines
// roughly DOUBLES the answer and raises no error anywhere. `calls.ts` groups by
// `requestId` once; the span tree is downstream of that; this file is a function of the
// span tree. [LAW:one-source-of-truth] The trap is not guarded against here — it is
// unreachable from here, which is the stronger property.
//
// WHY NO OTLP LIBRARY. OTLP/JSON is a documented protobuf-to-JSON mapping, and the part
// of it this file needs is the span message and four attribute value kinds. An SDK would
// bring a batch-span-processor whose correctness depends on a shutdown-flush happening
// before the process ends — ambient temporal coupling
// ([LAW:no-ambient-temporal-coupling]) bought in exchange for code that fits on a screen —
// plus a dependency tree to licence-check against miser-portability-adi.6. The wire
// format is the seam; a library is one possible implementation of it, and not the one
// with the lower carrying cost here. [LAW:carrying-cost]
//
// THE NAMING RULE, stated once so nobody has to infer it from the table. Where Claude
// Code's native exporter has the concept, this emits the NAME AND KEYS NATIVE USES, so a
// backfilled session and a live one are one vocabulary in one UI. Where it does not have
// the concept — a session root, a subagent's own span — the name takes a `cc_miser.`
// prefix rather than inventing a `claude_code.` name native never emits. Nothing here
// masquerades as native, and nothing native names is renamed. The schema is
// `reference/docs/CLAUDE_CODE_MONITORING.md`.

import { createHash } from 'node:crypto';
import { spend } from '../tokens.ts';
import { SCHEMA, type TraceNode, type TraceSession } from './trace.ts';
import { tsv } from './tsv.ts';

// ─── The wire shape ────────────────────────────────────────────────────────────────

/** An attribute value, as OTLP/JSON spells it.
 *
 * [LAW:types-are-the-program] A union rather than `{ stringValue?, intValue?, ... }`,
 * because the protobuf message this maps is a `oneof`: a value carrying both a
 * `stringValue` and an `intValue` is not a value a collector can read, and the bag of
 * optionals would leave it representable. */
type AttrValue =
  | { stringValue: string }
  /** int64 crosses OTLP/JSON as a STRING, per the protobuf JSON mapping. A number here
   * is silently truncated at 2^53 by any reader that parses it as a JS number. */
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

interface KeyValue {
  key: string;
  value: AttrValue;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  /** Omitted, not empty, on a trace root — an empty string is a distinct (invalid)
   * parent id rather than the absence of one. */
  parentSpanId?: string;
  name: string;
  /** SPAN_KIND_INTERNAL. Uniform because every span here is a RECONSTRUCTION rather
   * than an observed client call; claiming CLIENT on `llm_request` would assert this
   * process made the request, which it did not. */
  kind: 1;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
}

/** One `ExportTraceServiceRequest`: what a collector's `/v1/traces` endpoint accepts. */
export interface OtlpTraces {
  resourceSpans: {
    resource: { attributes: KeyValue[] };
    scopeSpans: { scope: { name: string; version: string }; spans: OtlpSpan[] }[];
  }[];
}

// Constructors, so the `oneof` tag is never typed by hand at a call site where it could
// be typed wrongly — the same reason `tokens.ts` builds its `Size` and `Cost` values
// through `exactSize` and `eqCost` rather than object literals.
const str = (key: string, value: string): KeyValue => ({ key, value: { stringValue: value } });
const int = (key: string, value: number): KeyValue => ({
  key,
  value: { intValue: String(Math.round(value)) },
});

// ─── Identity ──────────────────────────────────────────────────────────────────────

/** Trace and span ids, derived from what the span already is rather than drawn at random.
 *
 * Deterministic on purpose: re-exporting a session after a pipeline change overwrites the
 * same trace in Jaeger instead of leaving a second copy beside it, so "what does this
 * session look like now" has one answer. [FRAMING:representation]
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

// ─── Layout: the two domains ───────────────────────────────────────────────────────

/** A span's extent, with its children's nested inside it.
 *
 * [LAW:types-are-the-program] The same SHAPE as the tree it measures, rather than a
 * `Map<spanId, extent>` the emitter would look up. A lookup can miss, which means a
 * guard, which means deciding what a missing extent renders as; mirroring the tree makes
 * the miss unrepresentable and deletes the question. */
interface Extent {
  startNs: bigint;
  endNs: bigint;
  children: Extent[];
}

/** How one domain lays a tree out on the time axis. The whole difference between the two
 * domains, as a value crossing one boundary. [LAW:composability] */
type Layout = (node: TraceNode) => Extent;

const NS_PER_MS = 1_000_000n;

/** Nanoseconds, as a bigint, because milliseconds-since-epoch times a million is ~1.8e18
 * and `Number.MAX_SAFE_INTEGER` is 9.0e15. Computed in `number` this silently loses the
 * low digits of every timestamp in the corpus. */
const nsOf = (ms: number): bigint => BigInt(Math.round(ms)) * NS_PER_MS;

/** WALL CLOCK. A direct read, and DELIBERATELY nothing more: `spans.ts` already flows
 * extents upward so that a parent covers its children and nothing more, which is exactly
 * the property this domain needs. Every adjustment this function could make is a second
 * opinion about extents, and the tree's is the one every other renderer in the project
 * shares. [LAW:one-source-of-truth]
 *
 * A minimum-width floor lived here and was removed, because a floor applied per span
 * pushes a zero-duration child that sits at its parent's right edge one millisecond past
 * it — six real sessions did precisely that. The token domain floors the TOTAL for the
 * same reason, where growing a parent can only ever help. A zero-duration span is the
 * truth about a tool whose result came back within the same millisecond, and Jaeger
 * renders and selects those. */
const timeLayout: Layout = (node) => ({
  startNs: nsOf(node.tStart),
  endNs: nsOf(node.tEnd),
  children: node.children.map(timeLayout),
});

/** How wide one token is on the axis Jaeger labels in time units. A millisecond makes a
 * 500k-token session read as about eight minutes — a range the UI's zoom is comfortable
 * in, where a nanosecond per token would put the whole corpus inside one tick. */
const NS_PER_TOKEN = 1_000_000n;

/** What this span itself cost, excluding its children.
 *
 * Read from the call's own usage rather than derived as `node.tokEq − Σ children.tokEq`.
 * The subtraction is arithmetically equal and is the exact move `spans.ts` removed from
 * the rollup: two routes to one fact, of which the derived one misattributes the moment
 * the tree shape it assumes changes. [LAW:one-source-of-truth] */
const ownTokens = (node: TraceNode): number =>
  node.detail.kind === 'call' ? Math.round(spend(node.detail.usage)) : 0;

/** TOKEN COST. Width is spend, so Jaeger's zoom, search and span detail operate on money
 * instead of on latency — PROJECT.md's second view, on the axis the viewer gives us.
 *
 * CONTAINMENT IS STRUCTURAL, not checked afterwards. Width is computed bottom-up as
 * `own + Σ child widths`, and children are laid end to end from the parent's own start,
 * so a child cannot escape its parent for any input: the parent was sized from the very
 * widths it is holding. This is the sixth of the hand-trace findings on
 * miser-render-82c.1, which is a fact about span models rather than about Perfetto.
 *
 * The parent's own spend is the slack left AFTER its children — a call renders as its
 * tools and subagents, then the block of context the call itself paid for.
 *
 * The one-token floor makes a zero-cost span (a tool, a turn) visible and clickable
 * instead of a hairline. It is layout, not accounting: it inflates a session's rendered
 * width by one token per span, and the exact figure a reader should quote rides on the
 * `cc_miser.rollup.*` attributes, which no floor touches. */
function tokenExtent(node: TraceNode, startNs: bigint): Extent {
  let cursor = startNs;
  const children = node.children.map((child) => {
    const extent = tokenExtent(child, cursor);
    cursor = extent.endNs;
    return extent;
  });
  const childWidth = cursor - startNs;
  const width = childWidth + BigInt(ownTokens(node)) * NS_PER_TOKEN;
  return {
    startNs,
    // The floor applies to the TOTAL, so it can only ever grow a parent that already
    // holds its children — a floor applied per-child instead could sum past the parent.
    endNs: startNs + (width > 0n ? width : NS_PER_TOKEN),
    children,
  };
}

/** Anchored at the session's real start so the trace lands in Jaeger's time range where a
 * reader would look for it. Anchored at epoch zero the spans are all still there and the
 * default "last hour" search never returns them. */
const tokenLayout: Layout = (node) => tokenExtent(node, nsOf(node.tStart));

/** What a domain is: a name Jaeger will show in its service picker, and a layout.
 *
 * THE TWO DOMAINS ARE KEPT APART BY THE VIEWER'S OWN PRIMITIVE. The ticket asks how,
 * "rather than emitting one and discovering the other is unrepresentable". Putting the
 * domain in `service.name` means Jaeger's service dropdown IS the domain selector: no
 * convention for a reader to remember, no trace that mixes the two, and no way to compare
 * a duration against a cost by accident. */
interface Domain {
  service: string;
  /** What one nanosecond on this domain's axis means, carried as an attribute because
   * Jaeger will label the axis in time units either way. */
  unit: string;
  layout: Layout;
}

/** [LAW:dataflow-not-control-flow] Both domains, always, on every export — a table to
 * iterate rather than a `--domain` flag to pass. A flag would make the common case
 * ("show me this session") two commands, leave every trace half-emitted, and add a mode
 * with no deletion date. [LAW:no-mode-explosion] */
export const DOMAINS: readonly Domain[] = [
  { service: 'cc-miser-time', unit: 'wall clock', layout: timeLayout },
  { service: 'cc-miser-tokens', unit: 'one millisecond = one input-equivalent token', layout: tokenLayout },
];

// ─── Names and attributes ──────────────────────────────────────────────────────────

/** Span names, keyed by the span tree's own discriminator so the compiler checks the set
 * both ways: a new `SpanDetail` kind cannot reach the exporter unnamed, and a name cannot
 * outlive the kind it was for. [LAW:types-are-the-program]
 *
 * Three of these are native Claude Code span names and two are not — see THE NAMING RULE
 * in this file's header. `turn` maps to `interaction` because that is native's name for
 * the same thing: one user prompt and everything it triggered. */
const SPAN_NAMES: Record<TraceNode['kind'], string> = {
  session: 'cc_miser.session',
  turn: 'claude_code.interaction',
  call: 'claude_code.llm_request',
  tool: 'claude_code.tool',
  subagent: 'cc_miser.subagent',
};

/** The dimensions a reader can group by, as the attribute keys they ride on.
 *
 * [LAW:one-source-of-truth] The emitter below builds its attributes from these constants
 * and the verification script iterates the same table, so "every dimension is filterable
 * in Jaeger" is checked against the keys actually emitted rather than against a list
 * someone kept in step by hand. A dimension added here without an emitter using it fails
 * the check, which is the direction the failure should point. */
export const GROUPABLE = {
  session: 'session.id',
  project: 'cc_miser.project',
  kind: 'cc_miser.kind',
  depth: 'cc_miser.depth',
  lineage: 'cc_miser.lineage',
  agent: 'agent_id',
  parentAgent: 'parent_agent_id',
  model: 'model',
  activity: 'cc_miser.activity',
  tier: 'cc_miser.activity.tier',
  tool: 'tool_name',
  subagentType: 'subagent_type',
} as const;

/** What every span carries, whatever it is.
 *
 * The rollup is here rather than on calls alone because it is the answer to the question
 * Jaeger structurally cannot compute: it has no group-by-and-sum across spans, so a
 * subtree's cost has to arrive already summed or it is not available at all. Every span
 * therefore states what its whole subtree cost, and selecting a subagent in the waterfall
 * answers "what did this agent spend" from the span detail panel. */
function commonAttrs(node: TraceNode): KeyValue[] {
  return [
    // Native sets `span.type` to the span's own name on every span it emits; matched so a
    // query written against live traces finds backfilled ones.
    str('span.type', SPAN_NAMES[node.kind]),
    str(GROUPABLE.kind, node.kind),
    int(GROUPABLE.depth, node.depth),
    str(GROUPABLE.lineage, node.lineage),
    int('cc_miser.rollup.input_tokens', node.usage.input),
    int('cc_miser.rollup.output_tokens', node.usage.output),
    int('cc_miser.rollup.cache_read_tokens', node.usage.cacheRead),
    int('cc_miser.rollup.cache_creation_tokens', node.usage.cacheCreation),
    int('cc_miser.rollup.tok_eq', node.tokEq),
    // Which calls of the transcript this span covers — the join back to `miser trace`
    // and `miser list` for anyone who wants the numbers this UI cannot compute.
    int('cc_miser.call_first', node.callFirst),
    int('cc_miser.call_last', node.callLast),
  ];
}

/** What each kind of span carries beyond the common set.
 *
 * The switch is on the domain's own discriminator and is exhaustive, which is the one
 * shape of branch `[LAW:dataflow-not-control-flow]` asks for: five genuinely different
 * things, not one thing with a mode. */
function detailAttrs(node: TraceNode): KeyValue[] {
  const detail = node.detail;
  switch (detail.kind) {
    case 'session':
      return [str('cc_miser.session_id', detail.sessionId)];

    case 'turn':
      // Native's `user_prompt` is `<REDACTED>` unless a gate is set, and its
      // `user_prompt_length` is the length of the whole prompt. This is a SNIPPET, so it
      // gets its own key rather than arriving under a native name meaning something else.
      return [str('cc_miser.turn.snippet', detail.snippet)];

    case 'call':
      return [
        str(GROUPABLE.model, detail.model),
        str('gen_ai.system', 'anthropic'),
        str('gen_ai.request.model', detail.model),
        // Native's own keys for the usage vector, carrying THIS call's exact usage — the
        // `cc_miser.rollup.*` set above is the subtree. Both are on the span because they
        // are different facts, and on a leaf call they happen to agree.
        int('input_tokens', detail.usage.input),
        int('output_tokens', detail.usage.output),
        int('cache_read_tokens', detail.usage.cacheRead),
        int('cache_creation_tokens', detail.usage.cacheCreation),
        int('cc_miser.tok_eq', Math.round(spend(detail.usage))),
        int('cc_miser.line_count', detail.lineCount),
        // Activity, its tier and its reason: the classification native export has no
        // concept of, and the dimension PROJECT.md's whole ledger pivots on. The tier
        // rides beside the label because a label nobody can trace to a decision is a
        // number that flatters itself.
        str(GROUPABLE.activity, detail.label.activity),
        str(GROUPABLE.tier, detail.label.tier),
        str('cc_miser.activity.because', detail.label.because),
      ];

    case 'tool':
      return [
        str(GROUPABLE.tool, detail.name),
        // The tool input's one human-meaningful field — a path for Read/Edit/Write, a
        // command for Bash, a pattern for Grep. Deliberately NOT emitted as native's
        // `file_path` or `full_command`: `records.ts` picks the first field that is
        // present and the span tree keeps only the winner, so which key it came from is
        // not something this file knows. Emitting it under a native key would be a guess
        // wearing native's name.
        str('cc_miser.tool.target', detail.summary),
        int('cc_miser.tool.result_chars', detail.resultChars),
      ];

    case 'subagent':
      return [
        // Native names this one on the parent `claude_code.tool` span; the concept is the
        // same, so the key is.
        str(GROUPABLE.subagentType, detail.agentType),
        str('cc_miser.subagent.description', detail.description),
      ];
  }
}

/** Lineage as native's two keys.
 *
 * `agent_id` is THE JOIN between this corpus and live traces: it is the same id native
 * puts on every span a subagent emits and the same id `discover.ts` parses out of an
 * `agent-<id>.jsonl` filename, so the two sources meet on it with nothing invented.
 *
 * `parent_agent_id` is documented in native's schema and, as of the 2026-08-29 check, not
 * actually emitted — native leaves subagent lineage to span parentage alone. cc-miser
 * knows it, so it fills the documented key rather than inventing another. */
const lineageAttrs = (node: TraceNode): KeyValue[] =>
  [
    node.agentId === null ? null : str(GROUPABLE.agent, node.agentId),
    node.parentAgentId === null ? null : str(GROUPABLE.parentAgent, node.parentAgentId),
  ].filter((a): a is KeyValue => a !== null);

// ─── The emitter ───────────────────────────────────────────────────────────────────

/** Flatten one tree into OTLP spans, walking the node and its extent together.
 *
 * [LAW:dataflow-not-control-flow] One rule at every level, exactly as `traceNode` builds
 * the tree it consumes: a session root, a turn and a depth-4 sub-sub-subagent's tool call
 * all take this path, and what differs is the data handed in. */
function flatten(
  node: TraceNode,
  extent: Extent,
  traceId: string,
  parentSpanId: string | undefined,
  spanIdOf: (node: TraceNode) => string,
): OtlpSpan[] {
  const spanId = spanIdOf(node);
  const here: OtlpSpan = {
    traceId,
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    name: SPAN_NAMES[node.kind],
    kind: 1,
    startTimeUnixNano: String(extent.startNs),
    endTimeUnixNano: String(extent.endNs),
    attributes: [...commonAttrs(node), ...lineageAttrs(node), ...detailAttrs(node)],
  };
  return node.children.reduce(
    (acc, child, i) => acc.concat(flatten(child, extent.children[i]!, traceId, spanId, spanIdOf)),
    [here],
  );
}

/** One session in one domain: the spans a collector receives, and the row a reader gets.
 *
 * [LAW:one-source-of-truth] Built together, from the one place that knows which domain
 * this is. Deriving the row afterwards by walking the finished request meant either
 * indexing `DOMAINS` at the same position — a coupling nothing states, which would
 * mislabel every row if the table were reordered while every count stayed right — or
 * digging `service.name` back out of an attribute union, which is reading a fact out of
 * its own rendering. Neither is necessary: at this point the domain is simply in scope. */
function domainExport(
  session: TraceSession,
  domain: Domain,
): { resourceSpans: OtlpTraces['resourceSpans'][number]; row: ExportRow } {
  const traceId = hexId(16, domain.service, session.session);
  const spanIdOf = (node: TraceNode): string => hexId(8, domain.service, session.session, node.id);
  const spans = flatten(session.tree, domain.layout(session.tree), traceId, undefined, spanIdOf);
  return {
    row: {
      session: session.session,
      project: session.project,
      domain: domain.service,
      traceId,
      spans: spans.length,
    },
    resourceSpans: {
        resource: {
          attributes: [
            str('service.name', domain.service),
            // The span-tree schema this was built from, so a consumer that finds a field
            // has changed meaning gets a version to check rather than a surprise.
            str('service.version', SCHEMA),
            // What one nanosecond on this trace's axis MEANS. There is no second
            // `cc_miser.domain` key beside it: that would be `service.name` again under a
            // different name, and two spellings of one fact are two things to keep in step.
            str('cc_miser.axis', domain.unit),
            // Native carries `session.id` as a resource attribute; matched, so the same
            // Jaeger query reaches a backfilled session and a live one.
            str(GROUPABLE.session, session.session),
            str(GROUPABLE.project, session.project),
            str('cc_miser.transcript', session.path),
            // Fan-out, unpaired subagent files, orphans, format drift. [LAW:no-silent-failure]
            // These travel WITH the data everywhere else in this pipeline, and a reader
            // summing a waterfall needs to know the tree they are looking at had three
            // subagents nobody could place.
            int('cc_miser.notes', session.notes.length),
            ...session.notes.map((note, i) => str(`cc_miser.note.${i}`, note)),
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'cc-miser', version: SCHEMA },
            spans: flatten(session.tree, domain.layout(session.tree), traceId, undefined, spanIdOf),
          },
        ],
    },
  };
}

/** One session, in every domain: the request to post and the rows to print.
 *
 * Per session rather than per corpus because a request is also the unit of failure: a
 * collector that rejects one session names that session, where a single request carrying
 * four hundred of them fails as a wall. [LAW:no-silent-failure] It bounds the payload
 * too — the corpus does not have to fit in one POST body to be exportable.
 *
 * Both domains ride in one request as two `resourceSpans` entries. They are different
 * traces with different ids; nothing about them is mixed. */
export function exportSession(session: TraceSession): { request: OtlpTraces; rows: ExportRow[] } {
  const parts = DOMAINS.map((domain) => domainExport(session, domain));
  return {
    request: { resourceSpans: parts.map((p) => p.resourceSpans) },
    rows: parts.map((p) => p.row),
  };
}

/** What one exported session is, as a row on stdout: where to find it in the viewer.
 *
 * The trace ids are the artifact. A session id is something the caller already had; the
 * id that opens `…/trace/<id>` in Jaeger is the thing this command produces and the only
 * thing that cannot be worked out without running it. */
export interface ExportRow {
  session: string;
  project: string;
  domain: string;
  traceId: string;
  spans: number;
}

/** The column order, which IS the header line — `list`'s idiom, and the same renderer.
 * A test asserts this covers every field of `ExportRow`, so a field added to the row
 * cannot silently stop reaching stdout. */
export const EXPORT_COLUMNS = [
  'session',
  'project',
  'domain',
  'traceId',
  'spans',
] as const satisfies readonly (keyof ExportRow)[];

export const toExportTsv = (rows: readonly ExportRow[]): string => tsv(EXPORT_COLUMNS, rows);
