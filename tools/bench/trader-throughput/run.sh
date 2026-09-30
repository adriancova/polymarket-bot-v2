#!/usr/bin/env bash
# THROUGHPUT-1a — the trader-throughput benchmark driver. See README.md.
#
# Bundles the harness (test/integration/paper-trader/support/throughput/) with
# the trader's own esbuild and the trader's own bundle flags, then runs it:
#
#   tools/bench/trader-throughput/run.sh --mode catch-up|paced --out-dir <dir> \
#     --fixture <burst.jsonl> --market-opened <market-opened.json> --template <template.json> \
#     [--limit N] [--cpu-prof] [--container-prefix tp-bench] [--keep] \
#     [--redis-url redis://… --postgres-url postgres://…] [--retention N] [--code-commit <sha>]
#
#   tools/bench/trader-throughput/run.sh profile <file.cpuprofile> [--top N]
#
# The harness sources live under test/ (not here) because every tracked .ts/.mjs
# file ESLint lints must be inside the typed lint program (see README.md).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../../.." && pwd)"
harness="${repo}/test/integration/paper-trader/support/throughput"
esbuild="${repo}/apps/trader/node_modules/.bin/esbuild"
build="${BENCH_BUILD_DIR:-$(mktemp -d -t trader-throughput-bench.XXXXXX)}"
mkdir -p "${build}"

# The trader app's bundle flags (apps/trader/package.json "build"). NODE_PATH
# resolves the workspace packages through the trader app's own dependency links.
banner="--banner:js=import { createRequire as __bundleCreateRequire } from 'node:module'; const require = __bundleCreateRequire(import.meta.url);"
for entry in bench-main:bench publish-main:publish; do
  NODE_PATH="${repo}/apps/trader/node_modules" "${esbuild}" "${harness}/${entry%%:*}.ts" \
    --bundle --platform=node --format=esm --target=node24 --log-level=warning \
    "${banner}" --outfile="${build}/${entry##*:}.mjs"
done

# Entered through a one-line wrapper, never as the main module itself: inside
# one bundle every module's import.meta.url is the bundle's, so REGISTER-1's
# entry guard (apps/trader/src/register/main.ts isProcessEntry) would take the
# bundle for its own process entry and run the registration command on these
# arguments at import time. The harness calls runRegisterCommand itself.
printf 'await import("./bench.mjs");\n' > "${build}/entry.mjs"
exec node "${build}/entry.mjs" --repo "${repo}" --publisher-bundle "${build}/publish.mjs" "$@"
