#!/usr/bin/env bash
#
# The local telemetry stack — Jaeger, an OpenTelemetry collector and Prometheus — on
# Apple's native container runtime.
#
# Apple's `container` has no compose equivalent, so this file is what the three services
# are bound behind: `up` brings them all the way up, `down` takes them all the way away,
# `status` says what is running, and `verify` proves data actually arrives.
#
# WHY `verify` EXISTS, AND WHY IT ASKS JAEGER RATHER THAN THE PORTS. On 2026-08-26 the
# colima VM silently dropped every OTLP payload sent through it: ports open, TCP
# connecting, no error printed anywhere, and nothing ever reaching the collector. "The
# stack is up" was true and worthless that day. So `verify` sends real spans through the
# real published ingest ports and asks Jaeger's own query API whether those exact spans
# landed — the only question whose answer distinguishes a working stack from that one.
# [LAW:verifiable-goals]
#
# HOW THE CONTAINERS FIND EACH OTHER. Verified on 2026-08-27 against container CLI 1.2.2:
# containers sharing a `container network` do NOT resolve each other by name. A peer
# lookup returns NXDOMAIN and the runtime registers no DNS domain by default; getting
# names requires `container system dns create`, which needs admin rights and writes
# machine-global state this repo does not own. Docker's behaviour simply is not this
# runtime's behaviour, and the config files were written expecting Docker's.
#
# So the runtime itself is the single authority on where a service lives.
# [LAW:one-source-of-truth] `up` reads each container's address from `container inspect`
# once it is running and hands it to its dependent through that dependent's own
# configuration seam — an environment variable the collector expands, a service-discovery
# file Prometheus reads. No address is written into any tracked file, so there is no
# second copy of an address able to drift from the runtime that assigns it.
#
# Exit codes follow the same contract as `miser` (see commit b296272): 0 ok, 1 the stack
# failed on real input, 2 the command line was wrong.

set -euo pipefail

readonly NETWORK=cc-miser-telemetry

readonly JAEGER=cc-miser-jaeger
readonly COLLECTOR=cc-miser-otel-collector
readonly PROMETHEUS=cc-miser-prometheus

readonly IMAGE_JAEGER=docker.io/jaegertracing/all-in-one:latest
readonly IMAGE_COLLECTOR=docker.io/otel/opentelemetry-collector-contrib:latest
readonly IMAGE_PROMETHEUS=docker.io/prom/prometheus:latest
readonly IMAGE_TELEMETRYGEN=ghcr.io/open-telemetry/opentelemetry-collector-contrib/telemetrygen:latest

# Two different facts live here, and they were one constant each until 2026-08-27,
# when the host numbers had to move and the conflation became a bug waiting to fire.
# [LAW:one-source-of-truth]
#
# CONTAINER_PORT_* is what a service listens on INSIDE its container. This file is not
# the authority for those: otel-collector-config.yaml declares the collector's receiver
# and exporter endpoints, and the Jaeger and Prometheus images fix theirs. These
# constants restate that authority so `up` can wire peers together, and changing one
# here without changing it there is how you get a container that starts and answers
# nobody.
readonly CONTAINER_PORT_OTLP_GRPC=4317
readonly CONTAINER_PORT_OTLP_HTTP=4318
readonly CONTAINER_PORT_COLLECTOR_METRICS=8889
readonly CONTAINER_PORT_JAEGER_UI=16686
readonly CONTAINER_PORT_PROMETHEUS=9090

# PORT_* is the host-visible surface: which of THIS MACHINE's ports the stack claims.
# Deliberately not the OTLP defaults. Those defaults are exactly what every other
# telemetry stack on a developer's machine also wants, and on this one an unrelated
# project's collector holds 4317, 4318 and 8889 under a restart policy that brings it
# straight back — so a stack pinned to the defaults is a stack that loses a race it
# should never have entered. Nothing outside this machine reads these numbers, so
# yielding the well-known ports costs nothing and ends the collision permanently.
readonly PORT_OTLP_GRPC=14317
readonly PORT_OTLP_HTTP=14318
readonly PORT_COLLECTOR_METRICS=18889
readonly PORT_JAEGER_UI=17686
readonly PORT_PROMETHEUS=19090

# Jaeger's own OTLP receiver port. Container-side only, and deliberately NOT published:
# the collector owns the one ingest address on this machine, and a second host-visible
# OTLP port would be a second place to send traces to. [LAW:single-enforcer]
readonly CONTAINER_PORT_JAEGER_OTLP=4317

# WHICH SPAN STORE JAEGER RUNS, and it is not the default. This is the whole of the fix
# for miser-tracing-yhc.5, so the reasoning lives here rather than in a ticket nobody
# reads from a shell script.
#
# WHAT WAS MEASURED, on 2026-08-30, by posting one span twice to a throwaway all-in-one
# under each store and reading the trace back — because the docs do not state this at a
# resolution that decides it:
#
#   memory   re-sending a span APPENDS. The trace then holds both versions, which is why
#            re-exporting a session that grew produced two root spans and a doubled span
#            count, and why the only cure was wiping the entire store.
#   badger   re-sending a span REPLACES it. Same trace, one span, the newer content.
#
# THE PART THAT IS EASY TO GET WRONG, and the reason `test/otlp-rewrite.test.ts` exists:
# badger keys a span on (traceId, startTime, spanId), NOT on (traceId, spanId). Re-sending
# with a DIFFERENT start time appends exactly like `memory` did. So this store fixes
# re-export only for as long as the exporter derives a given span's start time the same
# way twice, and that is a property of `cli/otlp.ts`, not of this file. The test asserts
# it; this comment is why it may not be deleted.
#
# EPHEMERAL, so `down` still destroys the store and `down && up` remains the full reset
# the README points at for the one case re-export cannot fix — an id derivation that
# changed, which orphans the previous trace rather than superseding it. Badger persists to
# disk if pointed at a directory, and that was measured to work here (a bind-mounted store
# survived the container being removed and recreated); it is not adopted because this
# stack has no restart path to benefit from it — `up` refuses to run while the containers
# exist, so every route back through here goes via `down`. [LAW:carrying-cost]
readonly JAEGER_STORAGE=badger

TELEMETRY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly TELEMETRY_DIR
readonly RUN_DIR="$TELEMETRY_DIR/.run"

# Prometheus cannot expand environment variables inside its config file, so the
# collector's discovered address reaches it through file_sd — Prometheus's own seam for
# targets that are not knowable when the config is written. `up` is the only writer of
# this file, and `down` deletes it.
readonly COLLECTOR_TARGETS="$RUN_DIR/collector-targets.json"

readonly STARTUP_TIMEOUT=60
readonly ARRIVAL_TIMEOUT=60

say() { printf '%s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

require_runtime() {
  command -v container >/dev/null \
    || die "Apple's container CLI is not on PATH. Install it with: brew install container"

  local status state
  status=$(container system status) \
    || die "\`container system status\` failed; the runtime may be broken"

  # Read the value of the `status` field rather than searching the whole table for the
  # word, so an unrelated field that happens to contain "running" cannot pass for a
  # started runtime.
  state=$(printf '%s\n' "$status" | awk '$1 == "status" { print $2 }')
  [[ $state == running ]] \
    || die "the container runtime reports status '${state:-unknown}'. Start it with: container system start"
}

# Every container this stack owns, whether running or stopped.
existing_containers() { container ls --all --quiet; }
running_containers() { container ls --quiet; }

has_line() { printf '%s' "$1" | grep -qx -- "$2"; }

# The whole host-visible surface, in one place, so preflight and status can never
# disagree about what this stack claims. [LAW:one-source-of-truth]
stack_ports() {
  printf '%s\n' "$PORT_OTLP_GRPC" "$PORT_OTLP_HTTP" "$PORT_COLLECTOR_METRICS" \
                "$PORT_JAEGER_UI" "$PORT_PROMETHEUS"
}

# True when something is already listening. `nc -z` announces the connections it makes
# on stderr and carries both outcomes in its exit code; the exit code is therefore the
# entire signal and the announcement is chatter, so discarding it hides no failure.
port_open() { nc -z -w 1 localhost "$1" 2>/dev/null; }

# The runtime reports a bind collision only once a container is already coming up, which
# leaves the services started before it running behind a failed `up`. Checking first
# means `up` either claims the whole surface or changes nothing at all.
require_ports_free() {
  local port taken="" probes=""

  while read -r port; do
    if port_open "$port"; then
      taken="$taken $port"
      probes="$probes -iTCP:$port"
    fi
  done < <(stack_ports)

  [[ -z $taken ]] || die "$(
    printf 'these host ports are already in use:%s\n' "$taken"
    printf 'This stack needs all of them. Find what holds them with:\n'
    printf '  lsof -nP -sTCP:LISTEN%s\n' "$probes"
  )"
}

network_exists() {
  container network ls | awk 'NR > 1 { print $1 }' | grep -qx -- "$NETWORK"
}

# The address the runtime assigned. Empty until the container is actually up, which is
# why every caller goes through wait_for_address rather than reading this directly.
address_of() {
  container inspect "$1" \
    | jq -r '.[0].status.networks[0].ipv4Address // empty' \
    | cut -d/ -f1
}

wait_for_address() {
  local name=$1 deadline=$((SECONDS + STARTUP_TIMEOUT)) addr

  while ((SECONDS < deadline)); do
    addr=$(address_of "$name")
    if [[ -n $addr ]]; then
      printf '%s\n' "$addr"
      return 0
    fi
    sleep 1
  done

  die "$name never received an address on network $NETWORK within ${STARTUP_TIMEOUT}s"
}

# Common shape of every service: detached, named, on the stack's own network. Everything
# after the name is that service's own flags, image and arguments, so the differences
# between the three stay data at one call site rather than three near-copies of this.
run_detached() {
  local name=$1
  shift
  container run --detach --name "$name" --network "$NETWORK" "$@" >/dev/null
}

cmd_up() {
  require_runtime

  local existing
  existing=$(existing_containers)
  local name
  for name in "$JAEGER" "$COLLECTOR" "$PROMETHEUS"; do
    if has_line "$existing" "$name"; then
      die "$name already exists. Take the stack down first: $0 down"
    fi
  done

  require_ports_free

  if ! network_exists; then
    say "creating network $NETWORK"
    container network create "$NETWORK" >/dev/null
  fi

  # Jaeger first, because the collector cannot be started without its address, and the
  # runtime does not hand out an address until the container is running. The ordering is
  # a real data dependency owned by this function, not an incidental sequence.
  # [LAW:no-ambient-temporal-coupling]
  say "starting $JAEGER"
  run_detached "$JAEGER" \
    --publish "$PORT_JAEGER_UI:$CONTAINER_PORT_JAEGER_UI" \
    --env COLLECTOR_OTLP_ENABLED=true \
    --env "SPAN_STORAGE_TYPE=$JAEGER_STORAGE" \
    --env BADGER_EPHEMERAL=true \
    "$IMAGE_JAEGER"
  local jaeger_addr
  jaeger_addr=$(wait_for_address "$JAEGER")
  say "  $JAEGER at $jaeger_addr"

  say "starting $COLLECTOR"
  run_detached "$COLLECTOR" \
    --publish "$PORT_OTLP_GRPC:$CONTAINER_PORT_OTLP_GRPC" \
    --publish "$PORT_OTLP_HTTP:$CONTAINER_PORT_OTLP_HTTP" \
    --publish "$PORT_COLLECTOR_METRICS:$CONTAINER_PORT_COLLECTOR_METRICS" \
    --env "JAEGER_OTLP_ENDPOINT=$jaeger_addr:$CONTAINER_PORT_JAEGER_OTLP" \
    --volume "$TELEMETRY_DIR/otel-collector-config.yaml:/etc/otel-collector-config.yaml:ro" \
    "$IMAGE_COLLECTOR" \
    --config=/etc/otel-collector-config.yaml
  local collector_addr
  collector_addr=$(wait_for_address "$COLLECTOR")
  say "  $COLLECTOR at $collector_addr"

  mkdir -p "$RUN_DIR"
  printf '[{"targets": ["%s:%s"], "labels": {"job": "otel-collector"}}]\n' \
    "$collector_addr" "$CONTAINER_PORT_COLLECTOR_METRICS" > "$COLLECTOR_TARGETS"

  say "starting $PROMETHEUS"
  run_detached "$PROMETHEUS" \
    --publish "$PORT_PROMETHEUS:$CONTAINER_PORT_PROMETHEUS" \
    --volume "$TELEMETRY_DIR/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
    --volume "$COLLECTOR_TARGETS:/etc/prometheus/collector-targets.json:ro" \
    "$IMAGE_PROMETHEUS" \
    --config.file=/etc/prometheus/prometheus.yml \
    --storage.tsdb.path=/prometheus \
    --storage.tsdb.retention.time=200h
  local prometheus_addr
  prometheus_addr=$(wait_for_address "$PROMETHEUS")
  say "  $PROMETHEUS at $prometheus_addr"

  say ""
  say "Jaeger UI      http://localhost:$PORT_JAEGER_UI"
  say "Prometheus     http://localhost:$PORT_PROMETHEUS"
  say "OTLP ingest    localhost:$PORT_OTLP_GRPC (gRPC), localhost:$PORT_OTLP_HTTP (HTTP)"
  say ""
  say "The stack being up is not evidence that data flows. Run: $0 verify"
}

cmd_down() {
  require_runtime

  local existing running name
  existing=$(existing_containers)
  running=$(running_containers)

  for name in "$PROMETHEUS" "$COLLECTOR" "$JAEGER"; do
    if has_line "$running" "$name"; then
      say "stopping $name"
      container stop "$name" >/dev/null
    fi
    if has_line "$existing" "$name"; then
      say "removing $name"
      container rm "$name" >/dev/null
    fi
  done

  if network_exists; then
    say "removing network $NETWORK"
    container network delete "$NETWORK" >/dev/null
  fi

  rm -rf "$RUN_DIR"
  say "the stack is down"
}

cmd_status() {
  require_runtime

  local running name state
  running=$(running_containers)

  for name in "$JAEGER" "$COLLECTOR" "$PROMETHEUS"; do
    if has_line "$running" "$name"; then
      state="running  $(address_of "$name")"
    else
      state="not running"
    fi
    printf '%-26s %s\n' "$name" "$state"
  done

  local port
  while read -r port; do
    if port_open "$port"; then
      printf '%-26s %s\n' "localhost:$port" "open"
    else
      printf '%-26s %s\n' "localhost:$port" "closed"
    fi
  done < <(stack_ports)
}

# Poll Jaeger's query API until a trace for this service shows up. A unique service name
# per run is what makes a hit mean "the span I just sent arrived" rather than "some span
# arrived at some point", so a stale trace can never produce a pass.
await_trace() {
  local service=$1 deadline=$((SECONDS + ARRIVAL_TIMEOUT)) body count

  while ((SECONDS < deadline)); do
    if body=$(curl -sS "http://localhost:$PORT_JAEGER_UI/api/traces?service=$service&lookback=1h&limit=1"); then
      if count=$(printf '%s' "$body" | jq -r '(.data // []) | length'); then
        if [[ $count =~ ^[0-9]+$ ]] && ((count > 0)); then
          return 0
        fi
      fi
    fi
    sleep 1
  done

  return 1
}

# The gRPC leg, over the published OTLP gRPC port — the one telemetry/README.md tells
# Claude Code to use, so this is the path that actually matters. telemetrygen runs on the stack's
# network and is aimed at the network gateway, which is this host, so the span travels
# through the published host port rather than around it.
verify_grpc() {
  local service=$1 gateway

  gateway=$(container network inspect "$NETWORK" | jq -r '.[0].status.ipv4Gateway')
  [[ -n $gateway && $gateway != null ]] \
    || die "could not read the gateway address of network $NETWORK"

  say "sending a span over gRPC to the published :$PORT_OTLP_GRPC (via gateway $gateway)"

  # telemetrygen narrates every gRPC state change, which is pages of noise when it works
  # and the first thing worth reading when it does not — so it is held and printed on
  # the failing path only. Nothing is discarded. [LAW:no-silent-failure]
  local output
  if ! output=$(container run --rm --network "$NETWORK" "$IMAGE_TELEMETRYGEN" traces \
      --otlp-endpoint "$gateway:$PORT_OTLP_GRPC" \
      --otlp-insecure \
      --service "$service" \
      --traces 1 2>&1); then
    say "$output"
    die "telemetrygen could not deliver a span to $gateway:$PORT_OTLP_GRPC"
  fi
}

# One span, posted through the published OTLP/HTTP port. The wire shape lives here alone,
# so the two checks that send spans this way can differ only in the values they vary —
# and `verify_replaces` below depends on being able to re-send a span identical to an
# earlier one in every field but its name. [LAW:one-source-of-truth]
post_span() {
  local service=$1 trace_id=$2 span_id=$3 start_ns=$4 name=$5 end_ns payload code

  end_ns=$((start_ns + 1000000))
  payload=$(printf '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"%s"}}]},"scopeSpans":[{"scope":{"name":"telemetry/stack.sh"},"spans":[{"traceId":"%s","spanId":"%s","name":"%s","kind":1,"startTimeUnixNano":"%s","endTimeUnixNano":"%s"}]}]}]}' \
    "$service" "$trace_id" "$span_id" "$name" "$start_ns" "$end_ns")

  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' --data "$payload" \
    "http://localhost:$PORT_OTLP_HTTP/v1/traces") \
    || die "could not reach the collector on localhost:$PORT_OTLP_HTTP"

  [[ $code == 200 ]] \
    || die "the collector rejected a test span: HTTP $code from localhost:$PORT_OTLP_HTTP/v1/traces"
}

# The HTTP leg, over the published OTLP HTTP port, sent from the host itself. OTLP/JSON needs
# nothing but curl, which makes this the most faithful reproduction available of what a
# process on this machine does when it exports.
verify_http() {
  local service=$1 trace_id span_id start_ns

  trace_id=$(openssl rand -hex 16)
  span_id=$(openssl rand -hex 8)
  start_ns=$(( $(date +%s) * 1000000000 ))

  say "sending a span over HTTP to localhost:$PORT_OTLP_HTTP"
  post_span "$service" "$trace_id" "$span_id" "$start_ns" "stack-verify"
}

# THE STORE SUPERSEDES A RE-SENT SPAN RATHER THAN ACCUMULATING BOTH — the property
# `miser otlp` relies on to re-export a session that grew, and the one thing about this
# stack that could be taken away silently.
#
# It is configuration, not code: `up` asks for `SPAN_STORAGE_TYPE=badger` and the image
# obliges. Nothing here owns that promise. An image whose `:latest` moved, a renamed or
# retired env var — Jaeger v1 is past its own end-of-life notice — or a changed default
# would all put the memory store back, and every symptom would be downstream and quiet: a
# trace holding two versions of one session, two root spans, and totals computed over
# both. Exactly the shape of the 2026-08-26 failure this command was written for, so it
# gets checked the same way: ask Jaeger, do not assume the config took.
#
# The second span is IDENTICAL to the first but for its name, because the store keys a
# span on (traceId, startTime, spanId) — varying the start time would append under any
# backend and prove nothing.
verify_replaces() {
  local service=$1 trace_id span_id start_ns deadline body spans

  trace_id=$(openssl rand -hex 16)
  span_id=$(openssl rand -hex 8)
  start_ns=$(( $(date +%s) * 1000000000 ))

  say "posting one span twice to :$PORT_OTLP_HTTP to prove the store replaces it"
  post_span "$service" "$trace_id" "$span_id" "$start_ns" "first-version"
  await_trace "$service" \
    || die "the first of the two replacement-test spans never reached Jaeger"
  post_span "$service" "$trace_id" "$span_id" "$start_ns" "second-version"

  # Wait for the SECOND write to be visible before counting, and wait for it by name. A
  # count taken while only the first span had landed would read 1 and PASS — the very
  # answer this check exists to earn — so the arrival of the new version is what opens
  # the question, never a sleep. [LAW:no-ambient-temporal-coupling]
  deadline=$((SECONDS + ARRIVAL_TIMEOUT))
  while ((SECONDS < deadline)); do
    body=$(curl -sS "http://localhost:$PORT_JAEGER_UI/api/traces/$trace_id") || body=''
    if printf '%s' "$body" | jq -e '[.data[0].spans[]? | select(.operationName == "second-version")] | length > 0' >/dev/null 2>&1; then
      spans=$(printf '%s' "$body" | jq -r '(.data[0].spans // []) | length')
      [[ $spans == 1 ]] && return 0
      die "$(
        printf 'Jaeger kept %s spans where one span was sent twice under one id.\n' "$spans"
        printf 'The span store is appending rather than replacing, so re-exporting a\n'
        printf 'session that grew will leave its previous export in the trace.\n'
        printf 'Check that %s still honours SPAN_STORAGE_TYPE=%s:\n' "$IMAGE_JAEGER" "$JAEGER_STORAGE"
        printf '  container logs %s\n' "$JAEGER"
      )"
    fi
    sleep 1
  done

  die "the re-sent span never appeared in Jaeger within ${ARRIVAL_TIMEOUT}s; cannot tell whether the store replaces"
}

cmd_verify() {
  require_runtime

  local running name
  running=$(running_containers)
  for name in "$JAEGER" "$COLLECTOR"; do
    has_line "$running" "$name" || die "$name is not running. Bring the stack up first: $0 up"
  done

  local stamp grpc_service http_service rewrite_service
  stamp="$(date +%s)-$$"
  grpc_service="cc-miser-verify-grpc-$stamp"
  http_service="cc-miser-verify-http-$stamp"
  rewrite_service="cc-miser-verify-rewrite-$stamp"

  verify_grpc "$grpc_service"
  verify_http "$http_service"

  # Both legs are asked the same question the same way; only the service name differs.
  local failures=""
  await_trace "$grpc_service" || failures="$failures gRPC(:$PORT_OTLP_GRPC)"
  await_trace "$http_service" || failures="$failures HTTP(:$PORT_OTLP_HTTP)"

  if [[ -n $failures ]]; then
    say ""
    say "The collector accepted the spans and Jaeger never showed them."
    say "This is the shape of the colima failure: transport succeeds, data disappears."
    say "Look at the collector's own account of what it did:"
    say "  container logs $COLLECTOR"
    die "no trace arrived in Jaeger within ${ARRIVAL_TIMEOUT}s for:$failures"
  fi

  # Only once both legs are known to deliver: a replacement check run over a broken
  # transport would fail for a reason that has nothing to do with the span store, and
  # name the wrong cause. The arrival checks above are what make its answer readable.
  verify_replaces "$rewrite_service"

  say ""
  say "verified: spans sent over :$PORT_OTLP_GRPC and :$PORT_OTLP_HTTP both arrived in Jaeger,"
  say "          and a span sent twice under one id is stored once, not twice"
  say "  http://localhost:$PORT_JAEGER_UI/search?service=$grpc_service"
  say "  http://localhost:$PORT_JAEGER_UI/search?service=$http_service"
}

cmd_help() {
  cat <<EOF
Usage: $0 <command>

  up      create the network and start Jaeger, the collector and Prometheus
  down    stop and remove all three, the network, and the generated run state
  status  report which containers are running and which host ports are open
  verify  send real spans through the published OTLP ports and confirm via
          Jaeger's query API that they arrived, and that a span sent twice
          under one id is stored once; fail loudly when either is untrue

Jaeger UI      http://localhost:$PORT_JAEGER_UI
Prometheus     http://localhost:$PORT_PROMETHEUS
OTLP ingest    localhost:$PORT_OTLP_GRPC (gRPC), localhost:$PORT_OTLP_HTTP (HTTP)
EOF
}

case "${1-}" in
  up)     cmd_up ;;
  down)   cmd_down ;;
  status) cmd_status ;;
  verify) cmd_verify ;;
  help|--help|-h) cmd_help ;;
  "")     cmd_help >&2; exit 2 ;;
  *)      printf 'ERROR: unknown command: %s\n\n' "$1" >&2; cmd_help >&2; exit 2 ;;
esac
