#!/usr/bin/env bash
# The gateway publish benchmark (THROUGHPUT-1b). See README.md beside this file.
#
# Bundles test/integration/data-gateway/bench/publish-bench-cli.ts with esbuild
# (the gateway's own runtime build convention) and runs it once per offered
# rate. Each rate gets a FRESH Redis container (redis:7.4.2-alpine, the pinned
# image) on a loopback port, removed afterwards, unless --redis-url names an
# existing server. One JSON document per rate is printed on stdout.
#
#   tools/bench/gateway/run.sh --fixture FILE [--rates "735 1500 3000 saturate"]
#     [--pacing uniform|recorded] [--redis-url URL] [--cpu-prof DIR]
#     [--limit N] [--retention N] [--prefill N] [--epoch UUID] [--stream NAME]
#
# Environment: PMB_BENCH_CONTAINER_PREFIX names the containers this starts
# (default pmb-bench-gateway); PMB_BENCH_OUT is where the bundle is written
# (default a fresh temporary directory).
#
# SAFETY: recorded public market data only; the only connections opened are
# to the Redis it starts or is given. No credential, signer, wallet, or order.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
esbuild="$repo/apps/data-gateway/node_modules/.bin/esbuild"
entry="$repo/test/integration/data-gateway/bench/publish-bench-cli.ts"
image="redis:7.4.2-alpine"
prefix="${PMB_BENCH_CONTAINER_PREFIX:-pmb-bench-gateway}"

rates="735 1500 3000 saturate"
redis_url=""
cpu_prof=""
passthrough=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rates) rates="$2"; shift 2 ;;
    --redis-url) redis_url="$2"; shift 2 ;;
    --cpu-prof) cpu_prof="$2"; shift 2 ;;
    --fixture|--pacing|--limit|--retention|--prefill|--epoch|--stream) passthrough+=("$1" "$2"); shift 2 ;;
    *) echo "run.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [[ ! -x "$esbuild" ]]; then
  echo "run.sh: $esbuild is missing; install the workspace dependencies first" >&2
  exit 2
fi

out="${PMB_BENCH_OUT:-$(mktemp -d)}"
mkdir -p "$out"
bundle="$out/publish-bench.cjs"
"$esbuild" "$entry" --bundle --platform=node --format=cjs --target=node24 \
  --log-level=warning --outfile="$bundle"

container=""
cleanup() {
  if [[ -n "$container" ]]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
    container=""
  fi
}
trap cleanup EXIT

# Starts a fresh container and sets `container` and `started_url`. Called in
# THIS shell, never inside `$(...)`: a subshell's `container` would never
# reach `cleanup`, and the container would outlive the run.
started_url=""
start_redis() {
  container="$prefix-$$-$1"
  docker run -d --rm --name "$container" -p 127.0.0.1::6379 "$image" >/dev/null
  local mapped
  for _ in $(seq 1 100); do
    if docker exec "$container" redis-cli ping 2>/dev/null | grep -q PONG; then
      mapped="$(docker port "$container" 6379/tcp | head -n 1)"
      started_url="redis://127.0.0.1:${mapped##*:}"
      return 0
    fi
    sleep 0.1
  done
  echo "run.sh: $container did not answer PING" >&2
  return 1
}

node_flags=()
if [[ -n "$cpu_prof" ]]; then
  mkdir -p "$cpu_prof"
fi

index=0
for rate in $rates; do
  index=$((index + 1))
  url="$redis_url"
  if [[ -z "$url" ]]; then
    start_redis "$index"
    url="$started_url"
  fi
  node_flags=()
  if [[ -n "$cpu_prof" ]]; then
    node_flags=(--cpu-prof --cpu-prof-dir "$cpu_prof" --cpu-prof-name "publish-bench-$rate.cpuprofile")
  fi
  node "${node_flags[@]}" "$bundle" --redis-url "$url" --rate "$rate" "${passthrough[@]}"
  cleanup
done
