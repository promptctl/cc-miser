# reference/

Third-party material vendored for reading, not for building. Nothing here is imported by
`src/`, and nothing here ships in the product.

## `docs/CLAUDE_CODE_MONITORING.md`

Anthropic's official Claude Code monitoring documentation, fetched 2026-08-23 from
<https://code.claude.com/docs/en/monitoring>.

Why it is in scope: it documents that Claude Code exports OpenTelemetry natively —
metrics, events, and, behind `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, **distributed traces**.
The emitted span hierarchy is close to the one cc-miser reconstructs from transcript JSONL:

    claude_code.interaction              (a turn)
    ├── claude_code.llm_request          (an API call: input/output/cache_read/
    │                                     cache_creation tokens, model, request_id)
    ├── claude_code.hook
    └── claude_code.tool                 (tool_name, result_tokens, tool_use_id)
        ├── claude_code.tool.blocked_on_user
        ├── claude_code.tool.execution
        └── subagent spans nest here

Subagent spans nest under their spawning tool span, and `agent_id` / `parent_agent_id`
carry the lineage directly — the two things `src/forest.ts` and `src/lineage.ts` currently
derive by fixpoint.

Read the boundaries before assuming this replaces the pipeline: traces cover sessions from
the moment telemetry is switched on, not the history already on disk; prompts, tool inputs
and tool content are redacted unless explicitly gated on; `result_tokens` is documented as
approximate; and nothing here carries context residency, activity classification, or
attribution beneath the call.

## Removed: the Claude Code monitoring guide

A third-party ROI-measurement guide was briefly vendored here and has been removed. Its
upstream repository declared no licence, which under `miser-portability-adi.6` fails rather
than passes, so keeping it was not an option.

What was worth having from it now lives in `telemetry/`, rewritten: a collector stack that
actually carries traces to Jaeger, which the original did not — it was metrics-only and
predated the traces beta. The handful of non-obvious facts it recorded are in
`telemetry/README.md`, chiefly that the Prometheus exporter mangles metric names
(`claude_code.cost.usage` is queried as `claude_code_cost_usage_USD_total`) and that
switching Claude Code's exporter to `console` is the fastest way to tell whether the
problem is the client or the collector.

Do not re-vendor it. Everything else it contained was ROI narrative, a Linear integration,
and organisation-deployment advice already covered by the official documentation above.
