#!/usr/bin/env bash
# HOST-BENCH: one trader-throughput bench run on the H1 burst, with the guide's
# fixed inputs (docs/runbooks/laptop-host-bench.md, Part 3).
#
#   tools/bench/host/trader-bench.sh [--pin CPU] LABEL MODE [run.sh flags ...]
#
# MODE is catch-up or paced. The run's artifacts go to
# $HB/trader-throughput/LABEL/, its full output to $HB/trader-throughput/LABEL.log,
# and one line per run to $HB/trader-throughput/runs.txt.
#
# --pin CPU (one virtual CPU number) starts the bench process, which runs the
# trader, under `taskset -c CPU`. In paced mode that process spawns a SEPARATE
# publisher process (a Node child whose arguments hold `--pace-from`); it would
# inherit the pin and share the trader's virtual CPU, which the unpinned runs
# never do. So this script watches for that child and moves it, with all its
# threads, to every OTHER virtual CPU (`taskset -a -p`) as soon as it appears.
# runs.txt records `publisher=<cpus>`, `publisher=missed` (never seen: the
# run is not comparable) or `publisher=n/a`. PostgreSQL and Redis are started
# by the Docker daemon, never by this process, so they are never pinned.
# The watcher itself runs on the other virtual CPUs too.
#
# A LABEL that already exists is refused, so a result is never overwritten.
#
# Environment: FX (default ~/pmb-fixtures) holds run-1-window-burst.jsonl;
# HB (default ~/pmb-host-bench) receives the output. The bench itself is
# tools/bench/trader-throughput/run.sh; see its README.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../../.." && pwd)"

usage() { echo "usage: $0 [--pin CPU] LABEL catch-up|paced [run.sh flags ...]" >&2; exit 64; }

pin=""
if [[ ${1:-} == --pin ]]; then
  [[ $# -ge 2 ]] || usage
  pin="$2"
  shift 2
  [[ ${pin} =~ ^[0-9]+$ ]] || { echo "--pin takes ONE virtual CPU number" >&2; exit 64; }
fi
[[ $# -ge 2 ]] || usage
label="$1"
mode="$2"
shift 2
[[ ${mode} == catch-up || ${mode} == paced ]] || usage
[[ ${label} =~ ^[A-Za-z0-9._-]+$ ]] || { echo "LABEL may hold letters, digits, '.', '_' and '-' only" >&2; exit 64; }

fixture="${FX:-${HOME}/pmb-fixtures}/run-1-window-burst.jsonl"
out="${HB:-${HOME}/pmb-host-bench}/trader-throughput"
[[ -s ${fixture} ]] || { echo "missing ${fixture}: decompress the fixture first (guide step 2.6)" >&2; exit 66; }
mkdir -p "${out}"
[[ ! -e ${out}/${label} ]] || { echo "${out}/${label} exists; pick a new LABEL" >&2; exit 73; }

command=(
  "${repo}/tools/bench/trader-throughput/run.sh" --mode "${mode}" --out-dir "${out}/${label}"
  --fixture "${fixture}"
  --market-opened "${repo}/test/fixtures/trader-throughput/market-opened.json"
  --template "${repo}/test/fixtures/trader-throughput/template.json"
  --container-prefix hb --code-commit "$(git -C "${repo}" rev-parse --short HEAD)"
  "$@"
)
others=""
if [[ -n ${pin} ]]; then
  # Every online virtual CPU except the pinned one, as a taskset list.
  cpus="$(nproc --all)"
  (( pin < cpus )) || { echo "--pin ${pin}: this host has virtual CPUs 0-$((cpus - 1))" >&2; exit 64; }
  for ((c = 0; c < cpus; c++)); do
    (( c == pin )) || others+="${others:+,}${c}"
  done
  [[ -n ${others} ]] || { echo "--pin needs at least 2 virtual CPUs" >&2; exit 64; }
  command=(taskset -c "${pin}" "${command[@]}")
fi

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
publisher="n/a"
set +e
"${command[@]}" > "${out}/${label}.log" 2>&1 &
bench_pid=$!
if [[ -n ${pin} && ${mode} == paced ]]; then
  # taskset and run.sh both exec, so bench_pid becomes the bench's Node process,
  # and the publisher is its direct child.
  taskset -p -c "${others}" $$ > /dev/null
  publisher="missed"
  while kill -0 "${bench_pid}" 2> /dev/null; do
    child="$(pgrep -P "${bench_pid}" -f -- '--pace-from' | head -1)"
    if [[ -n ${child} ]]; then
      if taskset -a -p -c "${others}" "${child}" > /dev/null 2>&1; then
        publisher="${others}"
      fi
      break
    fi
    sleep 0.2
  done
fi
wait "${bench_pid}"
status=$?
set -e
printf '%s mode=%s exit=%s pin=%s publisher=%s started=%s ended=%s\n' \
  "${label}" "${mode}" "${status}" "${pin:-none}" "${publisher}" "${started}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "${out}/runs.txt"
grep -E '^RESULT|lag \(publish|halts:' "${out}/${label}.log" || true
exit "${status}"
