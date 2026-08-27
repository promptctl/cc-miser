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

# The host-visible surface, unchanged from the compose stack it replaces. telemetry/
# README.md's environment-variable instructions were verified correct against a
# collector listening on exactly these ports, so holding them keeps those instructions
# true and keeps the runtime swap invisible to everything outside this directory.
readonly PORT_OTLP_GRPC=4317
readonly PORT_OTLP_HTTP=4318
readonly PORT_COLLECTOR_METRICS=8889
readonly PORT_JAEGER_UI=16686
readonly PORT_PROMETHEUS=9090

# Jaeger's own OTLP receiver port. Deliberately NOT published: the collector owns the one
# ingest address on this machine, and a second host-visible OTLP port would be a second
# place to send traces to. [LAW:single-enforcer]
readonly JAEGER_OTLP_PORT=4317

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
    --publish "$PORT_JAEGER_UI:$PORT_JAEGER_UI" \
    --env COLLECTOR_OTLP_ENABLED=true \
    "$IMAGE_JAEGER"
  local jaeger_addr
  jaeger_addr=$(wait_for_address "$JAEGER")
  say "  $JAEGER at $jaeger_addr"

  say "starting $COLLECTOR"
  run_detached "$COLLECTOR" \
    --publish "$PORT_OTLP_GRPC:$PORT_OTLP_GRPC" \
    --publish "$PORT_OTLP_HTTP:$PORT_OTLP_HTTP" \
    --publish "$PORT_COLLECTOR_METRICS:$PORT_COLLECTOR_METRICS" \
    --env "JAEGER_OTLP_ENDPOINT=$jaeger_addr:$JAEGER_OTLP_PORT" \
    --volume "$TELEMETRY_DIR/otel-collector-config.yaml:/etc/otel-collector-config.yaml:ro" \
    "$IMAGE_COLLECTOR" \
    --config=/etc/otel-collector-config.yaml
  local collector_addr
  collector_addr=$(wait_for_address "$COLLECTOR")
  say "  $COLLECTOR at $collector_addr"

  mkdir -p "$RUN_DIR"
  printf '[{"targets": ["%s:%s"], "labels": {"job": "otel-collector"}}]\n' \
    "$collector_addr" "$PORT_COLLECTOR_METRICS" > "$COLLECTOR_TARGETS"

  say "starting $PROMETHEUS"
  run_detached "$PROMETHEUS" \
    --publish "$PORT_PROMETHEUS:$PORT_PROMETHEUS" \
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

# The gRPC leg, over the published :4317 — the port telemetry/README.md tells Claude Code
# to use, so this is the path that actually matters. telemetrygen runs on the stack's
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

# The HTTP leg, over the published :4318, sent from the host itself. OTLP/JSON needs
# nothing but curl, which makes this the most faithful reproduction available of what a
# process on this machine does when it exports.
verify_http() {
  local service=$1 trace_id span_id start_ns end_ns payload code

  trace_id=$(openssl rand -hex 16)
  span_id=$(openssl rand -hex 8)
  start_ns=$(( $(date +%s) * 1000000000 ))
  end_ns=$((start_ns + 1000000))

  payload=$(printf '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"%s"}}]},"scopeSpans":[{"scope":{"name":"telemetry/stack.sh"},"spans":[{"traceId":"%s","spanId":"%s","name":"stack-verify","kind":1,"startTimeUnixNano":"%s","endTimeUnixNano":"%s"}]}]}]}' \
    "$service" "$trace_id" "$span_id" "$start_ns" "$end_ns")

  say "sending a span over HTTP to localhost:$PORT_OTLP_HTTP"
  code=$(curl -sS -o /dev/null -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' --data "$payload" \
    "http://localhost:$PORT_OTLP_HTTP/v1/traces") \
    || die "could not reach the collector on localhost:$PORT_OTLP_HTTP"

  [[ $code == 200 ]] \
    || die "the collector rejected the test span: HTTP $code from localhost:$PORT_OTLP_HTTP/v1/traces"
}

cmd_verify() {
  require_runtime

  local running name
  running=$(running_containers)
  for name in "$JAEGER" "$COLLECTOR"; do
    has_line "$running" "$name" || die "$name is not running. Bring the stack up first: $0 up"
  done

  local stamp grpc_service http_service
  stamp="$(date +%s)-$$"
  grpc_service="cc-miser-verify-grpc-$stamp"
  http_service="cc-miser-verify-http-$stamp"

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

  say ""
  say "verified: spans sent over :$PORT_OTLP_GRPC and :$PORT_OTLP_HTTP both arrived in Jaeger"
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
          Jaeger's query API that they arrived; fail loudly when they did not

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
