# cc-miser

Every Claude Code session you have ever run left behind an itemized bill, and nobody
has ever read it. Each assistant message in the transcript JSONL carries the exact
`usage` block the API returned — input tokens, cache writes, cache reads, output —
alongside timestamps, a parent/child message tree, tool calls with their full inputs
and results, and complete subagent transcripts. That is not telemetry we need to
start collecting. It is 428MB of precise, already-collected trace data sitting in
`~/.claude/projects`, across ~610 sessions, waiting for a viewer.

cc-miser is that viewer. It treats a session as what it structurally is — a
distributed trace — and renders it the way traces are rendered: nested spans you can
zoom into. But where Jaeger answers "where did the *time* go," cc-miser answers two
harder questions: **where did the tokens go**, and **what phase of the work were
they buying**. Precisely enough to find the overhead and cut it.

## What a span is

The span model is the whole design; everything else is a projection of it. A span
here is richer than a trace viewer's `{name, start, end, parent}` in five specific
ways.

**A span's identity is a set of dimensions, not a name.** Tool name, file path,
command, model, agent type, skill invoked, project, git branch, hook name,
attachment type, CC version. These are pivot axes in the OLAP sense: the interesting
questions ("what does *Read on files over 1k lines* cost across all projects?") cut
across the trace hierarchy, not down it. The tree is one grouping of the span set;
the span set is the real object.

**A span has three extents, not one.**

- *Wall time* — the classic axis. It hides one fact worth surfacing: the gap
  between assistant-done and next-user-prompt is the human's latency, and
  separating your think-time from the agent's work-time changes every reading of
  "where did this session go."
- *Call index* — the conversation's true clock. Cost only happens at API calls;
  they are the ticks. Two spans adjacent in wall time can be identical in
  cost-time.
- *Context residency* — the extent no trace model has, and the one that dominates
  the economics. A tool result is not a cost event; it is an **allocation in a
  replayed arena**. It is born once as `cache_creation` (1.25× base price), then
  re-read as `cache_read` (0.1×) on *every subsequent call* until it dies by
  compaction, `/clear`, or session end — and a cache invalidation mid-life forces
  re-writing everything still resident.

The residency extent is why naive accounting understates overhead by an order of
magnitude. A 10k-token Bash output born at call 5 of a 100-call session costs
10k × 1.25 to write plus 10k × 0.1 × 95 in reads — roughly 107k token-equivalents.
The same output at call 95 costs about 13k. Same content, same size, 8× different
true cost. **Position and lifetime, not size, determine what content costs**, which
means the expensive content is whatever arrives early and lives long: the startup
payload, hooks that fire every turn, the harness's accumulating reminders.

**A span's cost is a vector, never a scalar.** Uncached input, cache write (5m and
1h), cache read, output — five price classes spanning a 50× range. Dollars are one
projection of the vector; "tokens" as a single number is another, and any
single-number view must say which projection it is. Exact vectors exist at the
API-call level and roll up the tree without ambiguity. Below the call, causes are
*estimated* (chars/4) and always carry an explicit `unattributed` remainder, so the
estimates can never quietly disagree with the exact totals. That honesty rule —
exact numbers are authoritative, estimates are labeled and never adjust them — is
the invariant everything hangs on.

**A span has a cause and an outcome.** Who put it in context: the user, the harness
(reminders, hook output, skill listings), the model's own choices (thinking,
verbosity), or a tool. And what it bought: progress, or waste — the failed tool
call, the permission-denied retry, the third full read of the same file. Cause ×
outcome is the optimization story in two words: *harness-caused, zero-outcome*
spend is pure overhead.

**A span links beyond its parent.** Spawner links join an `Agent` call — or a
forking `Skill` call — to the conversation it started, on disk at
`<project>/<sessionId>/subagents/agent-<agentId>.jsonl`. That directory is flat
while the spawn structure is a tree, so resolving it is a fixpoint rather than a
pass over the root: a grandchild's spawning `tool_use` lives inside *another
subagent's* transcript. Two edge kinds exist and both are needed — an exact
`tool_use` edge from the sidecar `meta.json`, and a command edge for slash-command
forks, which leave no `tool_use` block at all and must be placed by depth. So a
conversation's identity is the *chain* of spawns that reached it, and depth is that
chain's length — a pivot axis, not a main-vs-subagent flag. Reference links join
spans touching the same entity — the same file re-read, the same command re-run.
And some things are instants, not intervals: compaction boundaries, cache
invalidations, model switches.

One data trap, recorded because it invalidates naive analysis: a single API
response fans out to several JSONL lines (one per content block), each carrying a
usage object. Sum them without deduplicating by `requestId` and every number is
multiples too large. cc-miser dedupes at the parse boundary — but the rule needs
stating precisely, because two obvious readings of it each destroy something. A
call is the *group* of lines sharing a `requestId`: its content blocks are the
**union** of the whole group, and its usage is **one** snapshot from it. Identity
and payload are different maps of the same call, and collapsing both with the same
operation silently drops most of the session's tool calls.

Which snapshot is not a formality, and getting it wrong cost this project 27.4% of
every output token it had ever counted. In *root* transcripts every line of a group
does repeat one finished usage object, so "take the first" looks correct and was
verified as such. In *subagent* transcripts it is false: `output_tokens` is a
partial count that rises block by block as the response streams, and only the last
line holds the finished figure. 74.5% of subagent request groups stream, and
first-line reads were recovering 594,863 of their 9,695,389 output tokens —
**6%**. So the group's usage is the snapshot with the greatest `output_tokens`,
which is also right on the handful of groups carrying an all-zero placeholder line
that a last-wins rule would adopt. Every other field is genuinely constant within a
group. The lesson generalizes past this one field: a property verified on root
transcripts is a property of root transcripts, and subagent transcripts are written
by a different path.

## The activity layer

The mechanical tree says *what happened*: turn, call, tool. A second hierarchy over
the same spans says *what the work was for*: figuring out what to do next,
exploring the codebase, designing, implementing, verifying, debugging, reviewing,
committing, grooming the backlog, reporting back. This is the layer where "optimize
the overhead" becomes "optimize the process," and it exists to answer questions
like: **on average, what percentage of a session's cost is the code review process,
and how does that compare to the cost of making the changes?**

The taxonomy is a first-class, versioned artifact — every percentage is relative to
it, so it cannot be ad-hoc labels scattered through code. Draft leaves:
`orientation`, `exploration`, `design`, `implementation`, `verification`,
`debugging`, `review`, `scm`, `process`, `reporting`, `overhead`, and
`unclassified` — an honesty bucket, never a silent gap.

Classification is a cascade, cheapest and most certain first, every label carrying
its provenance and confidence:

1. **Explicit markers, free and exact.** The transcripts self-label constantly:
   skill invocations name activities outright (`/code-review` → review, `/next`
   and `/groom-backlog` → orientation and process, `/organize-commits` → scm),
   subagent types carry intent (Explore → exploration, Plan → design), and
   plan-mode entry/exit brackets design phases.
2. **Tool-signature rules, deterministic.** Runs of Grep/Glob/Read with no edits
   are exploration; Edit/Write bursts are implementation; Bash running tests is
   verification; git and gh commands are scm.
3. **An LLM judge for the remainder.** The model narrates its own phases ("Now let
   me run the tests…"), so a classifier reading a cheap projection of each turn —
   user text, assistant snippets, tool names, never tool outputs — labels what the
   rules can't. Napkin math: the full 610-session backlog is roughly $10 of Haiku,
   or free on local Ollama, classified once and cached by content hash forever.

The invariant that makes the percentages trustworthy: activity spans **partition
the call sequence**. Every API call belongs to exactly one leaf activity — no gaps,
no overlaps — so activities always sum to 100% of a session and "what share went to
review" is a query, not a judgment call. Tool executions inherit their call's
activity; a subagent's entire trace inherits the activity of the call that spawned
it, so a review subagent's whole burn is review cost. Reports state coverage
honestly: what share of spend was labeled by marker, by rule, by model, and not at
all.

What the layer unlocks, beyond the founding question: the comprehension multiplier
(exploration tokens per implementation token, per project — a direct measure of
whether a project's CLAUDE.md is doing its job); process ROI (does `/next` make
orientation cheaper? does review-in-a-subagent beat inline review, given that it
also keeps the diff out of the parent's resident context?); activity × cause
(inside review, how much is reading diffs and how much is reminder silt); activity
× outcome (debugging episodes that ended in reverts, priced); and eventually the
delivery join — sessions record their commits and PR links, so cost can be joined
to shipped artifacts: tokens per merged PR, decomposed by phase, trended over time.

## The views

Three renderings of the span set, in ascending order of novelty:

1. **The waterfall** — spans over wall time, nested, the classic trace UI. Free:
   export Chrome Trace Event JSON and load it in ui.perfetto.dev, which brings
   zoom, search, and a SQL engine. Exported twice — *time domain*, and *token
   domain* where span width is cost, so Perfetto's whole toolset operates on spend.
2. **The flamegraph** — the tree weighted by tokens (or dollars), zoomable,
   rendered with d3-flame-graph in a self-contained HTML report beside the
   aggregate ledgers: cost by tool, by attachment type, by activity, by project,
   by model; cache economics; startup cost.
3. **The stratigraphy** — the arena view, which we believe does not exist anywhere
   yet: call index on x, context-window offset on y, every content item a colored
   stratum (by cause or activity) running rightward through its residency.
   Compactions appear as cliffs, cache invalidations as full-column flashes, the
   harness's reminder silt visibly thickening. This is a memory profiler's
   allocation timeline applied to a context window, and it renders the true-cost
   model directly.

Because spans are attribute-rich events, a fourth door opens cheaply: emit genuine
OTLP and point real backends at it — SigNoz or Tempo locally, Honeycomb if wanted,
whose entire product is "which high-cardinality attribute explains this cost."

## What we build first

A pipeline of five stages, pure after the file reads at the front:

1. **discover** — walk `~/.claude/projects`, pair each session with its subagent
   transcripts.
2. **parse** — one checkpoint stamps raw JSONL into typed records. Unknown line
   types are counted and reported, never dropped; one malformed line never sinks a
   400MB scan.
3. **build** — records become the span tree: session → turn → API call → tool
   execution, subagents grafted under their Task calls, allocations given their
   birth/death, exact usage on every call, estimated attribution beneath.
4. **classify** — the activity cascade, pure given the tree plus cached judge
   verdicts; LLM calls live at the boundary and their verdicts are cached locally
   so re-renders never re-pay.
5. **render** — pure functions from the tree to the artifacts above.

The profiler (stages 1–3 plus the waterfall and flamegraph) answers "what do I
spend tokens doing" with real numbers over the full history. The activity layer
answers "what phase of my process is expensive." Everything past that is leverage
on a working instrument.

## How far can we take this?

In rough order of confidence:

**Attribution science** (high — the data is verified). The harness overhead ledger:
what fraction of spend is reminders, hook context, skill listings, re-caching — per
project, per config era. True-cost accounting via residency. Cache-thrash
detection: a call whose `cache_read` collapses mid-session is an invalidation you
paid to rebuild; find them, date them, correlate them with what changed. Compaction
cost/benefit. Startup cost per project, trended.

**Dollar modeling** (high). The cost vector priced per model, so every view can
render dollars; then what-ifs — this month on 5m instead of 1h TTL, subagents on a
cheaper model.

**Activity analytics** (high once classification lands). The percentages, the
multipliers, the ROI questions above — answered over the whole corpus, not
anecdotally.

**The optimization advisor** (medium — real analysis work, but the findings write
themselves once attribution exists). The report stops being a chart and becomes a
punch list: the tool output worth truncating, the hook whose injected context
outweighs its value, the CLAUDE.md that costs more per session than it earns, the
session that should have been a subagent — and the subagent that cost more than it
saved.

**The longitudinal instrument** (speculative — depends on living with the tool).
Trends across weeks; A/B across config changes; the delivery join (cost per merged
PR by phase); watch mode profiling the session you are in; maybe a statusline
meter. At this altitude cc-miser stops being a retrospective and joins the feedback
loop.

The honest ceiling: cc-miser can measure anything the transcripts record, and they
record almost everything — but it cannot see spend that never reaches this disk
(other machines, claude.ai), it cannot attribute exactly below the API-call level
(chars/4 ranks causes; it does not audit them), and activity labels are
classifications, not facts. The `unattributed` remainder and the coverage
statement are the permanent, visible reminders of those lines.

## Open questions

- **Default weight:** raw tokens, "new tokens" (input + cache-write + output,
  excluding cheap reads), or dollars? Likely tokens first, dollars as a toggle
  once pricing lands.
- **Format drift:** all current sessions are CC 2.1.x. The parse checkpoint's
  unknown-type counter is the early-warning system, but someone has to look at it.
- **Taxonomy fit:** the draft leaves will meet reality when the classifier runs;
  expect one revision after the first full-corpus pass, and version it.
- **Where "advisor" stops:** detecting a bloated hook is analysis; editing
  settings is a different tool. Current position: cc-miser reports, you act.

## Ground rules

File I/O and LLM calls only at the edges, pure core. One parse checkpoint, typed
records everywhere downstream. One span tree as the single source of truth, every
renderer a pure function of it. Exact numbers never adjusted by estimates;
estimates always labeled, with the remainder explicit. Failures and unknowns
surfaced, never swallowed. Classification verdicts cached, versioned, and carrying
provenance. Lean on existing viewers (Perfetto, d3-flame-graph, OTLP backends)
rather than building chart engines — the value is in the attribution, not the
pixels.
