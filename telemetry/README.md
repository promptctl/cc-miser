# Local telemetry stack

Sends a running Claude Code session's traces to Jaeger and its metrics to Prometheus.
Claude Code emits both natively; nothing in `src/` is involved.

The stack runs on Apple's native `container` runtime. No Docker is involved, and the
`docker` CLI still on this machine has no daemon behind it. On 2026-08-27 the three
services came up, `verify` confirmed spans travelling from the published OTLP ports into
Jaeger, and a real Claude Code session — subagent included — was read back out of Jaeger
and checked against its own transcript.

That session settled what this stack was built to settle, and the answer is on
`miser-tracing-yhc.1`: keep Jaeger for the span tree, because its waterfall, flamegraph
and span detail work well on real traces; expect nothing from it numerically, because its
only measures are span count and duration. It cannot sum a numeric tag even within a
single trace, so every token and cost ledger stays in `src/`. The usage vector on
`claude_code.llm_request` spans is exact — it matched the transcript to the token.

You need Apple's `container` CLI (`brew install container`) with the runtime started
(`container system start`).

## Run it

```bash
bun run telemetry up       # start Jaeger, the collector and Prometheus
bun run telemetry verify   # prove spans actually reach Jaeger
bun run telemetry down     # stop all three and remove them
bun run telemetry status   # what is running, and which ports answer
```

Jaeger's UI is at <http://localhost:17686>, Prometheus at <http://localhost:19090>.
Claude Code talks to the collector on `localhost:14317`, and the collector fans traces
out to Jaeger and metrics out to Prometheus. One endpoint to configure, two backends
behind it.

Those are not the ports you expect, and that is deliberate. OTLP's well-known 4317 and
4318 are what *every* telemetry stack on a developer machine reaches for, so a stack
pinned to them collides with the next project that wants to observe something — on this
machine, with an unrelated collector held up by a restart policy. cc-miser publishes
14317, 14318, 18889, 17686 and 19090 instead and yields the well-known numbers. Inside
the containers the services still listen on the standard ports; only the host-side
mapping moved. `telemetry/stack.sh` is the one place either set is written down.

Run `verify` after every `up`, before trusting anything you see. It sends real spans
through both published OTLP ports and then asks Jaeger's query API whether those exact
spans arrived, so it catches the case where the transport succeeds and the data
vanishes anyway. That is not hypothetical: it is how the previous Docker stack failed
on 2026-08-26 — every port open, every connection accepted, nothing ever stored.

`telemetry/stack.sh` is the script behind all four commands, and it is worth reading
once if you touch this stack. The part that surprises people: containers on this
runtime do not resolve each other by name, so the collector's address for Jaeger and
Prometheus's address for the collector are both read from the runtime at startup and
injected. That is why `otel-collector-config.yaml` names an environment variable where
you would expect a hostname, and why `prometheus.yml` discovers its target from a
generated file instead of listing it.

## Point Claude Code at it

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1   # traces are gated behind this
export OTEL_TRACES_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:14317   # not 4317 — see above
export OTEL_LOG_TOOL_DETAILS=1                 # see below — this one matters here
claude
```

`OTEL_LOG_TOOL_DETAILS=1` is the setting this project cares about most. Spans redact
tool detail by default, so a tool span arrives carrying `tool_name` and nothing else —
no `file_path`, no `full_command`, no `skill_name`, no `subagent_type`. Those are the
dimensions the whole analysis pivots on. Leave the default in place and you get a trace
tree with the right shape and nothing to interrogate.

`OTEL_LOG_USER_PROMPTS=1` and `OTEL_LOG_TOOL_CONTENT=1` unredact prompt text and tool
bodies as well. Decide those deliberately — they put the text of your actual work into
the trace store.

## Check it worked

`bun run telemetry verify` already answers this for the stack itself, so if it passed,
the collector and Jaeger are fine and any remaining problem is on Claude Code's side.

For a real session, run a prompt, then look for the `claude_code.session.count` metric
in Prometheus and a trace under the `claude-code` service in Jaeger.

If nothing arrives, find out whether Claude Code is emitting before you suspect the
collector:

```bash
export OTEL_METRICS_EXPORTER=console
export OTEL_METRIC_EXPORT_INTERVAL=1000
claude -p "test"
```

Metrics print to your terminal or they don't, which splits the problem in half in one
step. `claude --debug` also logs OTLP export errors.

## Reading the metrics in Prometheus

Metric names are not what the documentation calls them. `claude_code.cost.usage`
becomes `claude_code_cost_usage_USD_total` by the time you query it: the collector's
Prometheus exporter replaces dots with underscores, appends the unit, and adds `_total`
for counters. Search for `claude_code` in the Prometheus UI rather than typing a name
from memory.

```promql
sum(claude_code_cost_usage_USD_total) by (model)
sum(claude_code_token_usage_tokens_total) by (type)
```

The `type` label on token usage splits into `input`, `output`, `cacheCreation` and
`cacheRead` — the same cost vector this project computes from transcripts, arriving
free and already broken out.

Also free, and worth knowing about because PROJECT.md files it as speculative: the
metrics stream carries `claude_code.pull_request.count` and `claude_code.commit.count`.
That is the delivery join — cost against shipped work — without building anything.

## What this does not do

Traces begin when you switch telemetry on. The sessions already in
`~/.claude/projects` will never appear here, and reaching them is what
`miser-tracing-yhc.2` exists for. Native spans also carry no context residency, no
activity classification, and no attribution beneath the call. This stack shows you the
shape of a session, not its economics.

Two things the earlier notes here got wrong, corrected by enumerating every tag key in a
real trace on 2026-08-27. `result_tokens` is not emitted at all, so its documented
approximation is not a problem this project has. `parent_agent_id` is not emitted either
— subagent lineage rides on span parentage plus an `agent_id` tag, and that `agent_id` is
the same id as in the `subagents/agent-<id>.jsonl` filename `src/discover.ts` already
parses. What the spans DO carry exactly is the usage vector.

`reference/docs/CLAUDE_CODE_MONITORING.md` has the full span schema and the complete
environment variable list.
