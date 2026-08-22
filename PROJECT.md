# cc-miser

Every Claude Code session you have ever run left behind an itemized bill, and nobody
has ever read it. Each assistant message in the transcript JSONL carries the exact
`usage` block the API returned — input tokens, cache writes, cache reads, output —
alongside timestamps, a parent/child message tree, tool calls with their full inputs
and results, and complete subagent transcripts. That is not telemetry we need to
start collecting. It is 428MB of precise, already-collected trace data sitting in
`~/.claude/projects`, across ~610 sessions, waiting for a viewer.

cc-miser is that viewer. It treats a Claude Code session as what it structurally is —
a distributed trace — and renders it the way traces are rendered: nested spans you
can zoom into. But where Jaeger and Datadog answer "where did the *time* go," cc-miser
answers **"where did the *tokens* go"** — precisely enough to find the overhead and
cut it.

## The atom

One API call is the atom. Everything the tool does is built from this unit:

> An API call has an exact, non-negotiable cost (the `usage` block), a position in a
> tree (session → turn → call → tool execution → nested subagent session), and a set
> of *attributable causes* — the user's prompt, tool results, harness-injected
> attachments, the previous call's output — whose sizes we can estimate.

Exact costs roll *up* the tree without ambiguity. Estimated causes break costs *down*
within a call, always with an explicit `unattributed` remainder so the estimates can
never quietly disagree with the exact totals. That honesty rule — exact numbers are
authoritative, estimates are labeled and never adjust them — is the one invariant
everything else hangs on.

## Why this is worth building

The overhead you want to optimize is largely invisible in normal use. Three examples
already confirmed in the data:

- **The harness talks to itself on your bill.** `attachment` records — task
  reminders, token-count reminders, hook context, skill listings, agent listings —
  are context injected on the harness's initiative, not yours. Each one becomes
  `cache_creation` tokens on your next call. Nobody has ever seen these summed.
- **Session startup has a fixed cost you pay every time.** The first call of every
  session writes the system prompt, CLAUDE.md, and the full skill/agent listing into
  cache. Per-project startup cost is directly measurable and directly optimizable
  (that skill listing alone is thousands of tokens).
- **Tool output is unmetered today.** A chatty `Bash` call or a full-file `Read`
  lands in context forever. Attributing input growth to tool names — "Bash results
  cost you 1.4M tokens this month" — is exactly the lever you need to tune
  truncation, allowlists, and habits.

One data trap worth recording because it invalidates naive analysis: a single API
response fans out to ~5 JSONL lines (one per content block), and every line repeats
the identical usage object. Sum without deduplicating by `requestId` and every number
is ~5× wrong. cc-miser dedupes at the parse boundary so nothing downstream can make
that mistake.

## What we build first

A pipeline with four stages, each pure after the file reads at the front:

1. **discover** — walk `~/.claude/projects`, pair each session with its subagent
   transcripts (`subagents/agent-<id>.jsonl`, linked from the parent's Task tool
   result by `agentId`).
2. **parse** — one checkpoint stamps raw JSONL into typed records. Unknown line
   types are counted and reported, never silently dropped; one malformed line never
   sinks the corpus scan.
3. **build** — records become a span tree: session → turn → API call → tool
   execution, with subagent sessions grafted under the Task calls that spawned them.
   Exact usage on every call; estimated attribution beneath it.
4. **render** — pure functions from the tree to two artifacts:
   - **An HTML report**: a zoomable token-weighted flamegraph (d3-flame-graph — an
     existing, purpose-built library) plus aggregate tables: tokens by tool, by
     attachment type, by project, by model; cache economics; startup overhead.
   - **A Chrome Trace Event file** you load into [ui.perfetto.dev](https://ui.perfetto.dev)
     — a professional trace-span UI for free, in two flavors: *time domain* (spans
     are wall-clock, the classic waterfall) and *token domain* (span width is token
     count, so Perfetto's zoom, search, and SQL query engine all operate on cost).

That alone answers the founding question — "what do I spend tokens doing" — with
real numbers over the full history. Everything past it is leverage on top of a
working profiler.

## How far can we take this?

Far. The arc runs from *profiler* to *advisor* to *instrument*, and the data supports
each step. In rough order of confidence:

**Attribution science** (high confidence — the data is already verified). A harness
overhead ledger: what fraction of your total spend is task reminders, hook context,
skill listings, system re-caching — per project, per config era. Cache-thrash
detection: a call whose `cache_read` drops to zero mid-session is a cache
invalidation you paid to rebuild; find them, date them, correlate them with what
changed. Compaction analysis: `compact_boundary` records mark context resets — how
much did each compaction cost and save? Startup cost per project, trended.

**Dollar modeling** (high confidence, modest effort). Token counts weighted by
per-model prices — cache writes cost more than reads by an order of magnitude, output
costs more than input by another — so the flamegraph can render *dollars* instead of
tokens. Then what-ifs: what would this month have cost with 5m instead of 1h cache
TTL, or with Sonnet running the subagents?

**The optimization advisor** (medium confidence — the analysis is real work, but the
findings write themselves once attribution exists). The report stops being a chart
and starts being a punch list: "your top overhead is X, here is the config change."
Bloated tool outputs worth truncating. Hooks whose injected context outweighs their
value. A CLAUDE.md or skill listing that costs more per session than it earns.
Sessions that should have been subagents, and subagents that cost more than they
saved (delegation ROI is directly computable: tokens the subagent burned vs. context
the parent avoided).

**The longitudinal instrument** (speculative — depends on living with the tool).
Trends over weeks: is overhead growing? A/B across config changes: did removing that
plugin actually reduce startup cost? Model-mix analysis across the fleet of sessions.
A watch mode that profiles the session you are *in*; maybe a statusline hook that
shows the meter running. At this altitude cc-miser stops being a retrospective and
becomes part of the feedback loop.

The honest ceiling: cc-miser can *measure* anything the transcripts record, and the
transcripts record almost everything. What it cannot do is see spend that never
reaches disk (other machines, claude.ai sessions) or attribute with exactness below
the API-call level — the chars/4 estimates are good enough to rank causes, not to
audit them. The `unattributed` remainder is the permanent, visible reminder of that
line.

## Open questions

- **What is the right default weight?** Raw tokens, "new tokens" (input +
  cache-write + output, excluding cheap cache reads), or dollars? Likely: tokens
  first, dollars as a toggle once pricing lands.
- **Format drift.** All current sessions are CC 2.1.x. Older or future vintages will
  differ; the parse checkpoint's unknown-type counter is the early-warning system,
  but somebody has to look at it.
- **Where does "advisor" stop?** Detecting a bloated hook is analysis; editing your
  settings is a different tool. Current position: cc-miser reports, you act.

## Ground rules

The architecture commitments, stated once: file I/O only at the edges, pure core;
one parse checkpoint, typed records everywhere downstream; one span tree as the
single source of truth with every renderer a pure function of it; exact numbers
never adjusted by estimates; failures and unknowns surfaced, never swallowed. Lean
on existing viewers and libraries (Perfetto, d3-flame-graph) rather than building
chart engines — the value here is in the attribution, not the pixels.
