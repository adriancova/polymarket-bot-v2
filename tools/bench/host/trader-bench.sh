#!/usr/bin/env bash
# HOST-BENCH: one trader-throughput bench run on the H1 burst, with the guide's
# fixed inputs (docs/runbooks/laptop-host-bench.md, Part 3).
#
#   tools/bench/host/trader-bench.sh [--pin CPU] LABEL MODE [run.sh flags ...]
#
# MODE is catch-up or paced. The run's artifacts go to
# $HB/trader-throughput/LABEL/, its full output to $HB/trader-throughput/LABEL.log,
# and one line per run to $HB/trader-throughput/runs.txt. --pin CPU runs the
# bench process (the trader, and the paced publisher it spawns) under
# `taskset -c CPU`; PostgreSQL and Redis stay unpinned in their containers.
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
if [[ -n ${pin} ]]; then
  command=(taskset -c "${pin}" "${command[@]}")
fi

started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
set +e
"${command[@]}" > "${out}/${label}.log" 2>&1
status=$?
set -e
printf '%s mode=%s exit=%s pin=%s started=%s ended=%s\n' \
  "${label}" "${mode}" "${status}" "${pin:-none}" "${started}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "${out}/runs.txt"
grep -E '^RESULT|lag \(publish|halts:' "${out}/${label}.log" || true
exit "${status}"
