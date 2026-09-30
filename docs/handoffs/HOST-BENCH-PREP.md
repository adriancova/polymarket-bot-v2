# HOST-BENCH-PREP — a self-contained guide and tools for the laptop agent

**Status:** Complete (2026-09-30). Merged `1710a86`, PR #33, CI run `36765180501`.
**Reviewers:** Opus and gpt-6-astra, reconciled. r1 joint CHANGES REQUIRED (13 agreed findings) → r2 joint ACCEPT (Opus ACCEPT; astra's gates stopped on the grpc-js audit advisory later fixed by DEPS-2). Loop `wf_cc1c60a6-b4c`.
**Delivered:** `docs/runbooks/laptop-host-bench.md` (the guide for a zero-context agent), `tools/bench/host/` (the multi-market public-WS recorder, a host sampler, bench wrappers, 46 offline tests wired into `pnpm test`), and `docs/bench/README.md`.

## Live smoke finding (10 minutes, 8 series, US afternoon)
- 554 MB of text in 10 minutes, about **79.5 GB/day if scaled**. The p95 10-second rate was **5,563 envelopes/s** across the 8 series.
- BTC 5-minute was the busiest single series (about 33.9 GB/day scaled, with a 1-second peak of 4,026 envelopes/s).
- This is far above the LEAN-1 per-market estimate (12-14 GB/day), and far above one trader's measured intake (about 800 events/s). HOST-BENCH's 24-hour recording decides the real numbers; `SCALE-8` and ruling A6 (several traders) or `REFDIET` will likely be needed well before 8 markets.


## Implementer handoff r0 (verbatim)

### summary

HOST-BENCH-PREP is done: one commit, 0340727, on host-bench-prep (base 7f9da56), not pushed. All four gates pass: lint, check:deps, typecheck and test (369 files, 7,821 tests).

Deliverables:
- **The guide,** docs/runbooks/laptop-host-bench.md, for a Claude Code agent with no prior context:
  - Part 0, operator: powercfg for sleep, hibernate and lid; Best performance; Ethernet; Windows Update paused; wsl --install; .wslconfig (11 GB, 20 processors, 4 GB swap; sparse disk optional); clone; copy the fixture; one sudo setup script; wsl --shutdown; gh auth; the Claude Code installer.
  - Part 1: the safety rules.
  - Part 2, setup: an env file that every block sources; preflight; Node 24 by nvm and pnpm 11.17.0 by corepack, no root; pnpm install --frozen-lockfile, typecheck, and the unit suite in tmux; the recorder venv; the fixture sha256 check; machine facts.
  - Part 3, trader bench: a warm-up, catch-up and paced 3 each, one CPU-profiled catch-up, and 3+3 under taskset. Then an optional Windows-side P-core affinity run (operator-elevated) and a 1-hour sustained loop. A determinism check expects one normalized decision digest and 99,669 events consumed. Windows is sampled per logical processor to tell P-cores from E-cores.
  - Part 4: a 24-hour recording of 8 series (BTC, ETH, SOL, XRP × 5m, 15m).
  - Part 5: the host profile over those 24 hours.
  - Part 6: a results skeleton, a redaction grep, and a commit and push of host-bench-results-<date> only, with no PR.
  - Troubleshooting.
- **The tools,** tools/bench/host/ (Python standard library, websockets for the live recorder only, and bash):
  - record_markets.py and recorder_core.py, the recorder: Gamma /events discovery with documented parameters only; one public market WebSocket per series; the current and next window, rolled with the documented dynamic subscribe and unsubscribe frames; PING every 10 s and a 30 s staleness close; jittered reconnect; counts per market per second; optional gzip raw frames; summary.json. Every venue fact is cited in recorder_core.py's docstring.
  - host_sampler.py: /proc, PSI and statvfs. It adds Windows readings through powershell.exe using WMI class names, which Windows does not translate; this desktop's Windows is Spanish.
  - trader-bench.sh, bench_table.py and report_tables.py: run the bench and build the tables.
  - setup-wsl-root.sh: the operator's one root step.
  - README.md.
- **Offline tests:** 46 unittest cases, on 28 frames from H1 run 8's WAL and a trimmed Gamma response. test/unit/tooling/host-bench-tools.test.ts runs them inside pnpm run test. It also checks that the tools name only documented public endpoints and no credential.
- **docs/bench/README.md:** one paragraph on where results land.

Acceptance 2, the live smoke: the recorder ran for 600 s (17:20:04Z to 17:30:07Z) on all 8 series.
- Connections: 8 connects, 0 disconnects, 0 unparsable frames, 0 unattributed events.
- Rollovers worked live: each next window was subscribed as its predecessor opened, and each ended window was dropped 30 s after its end.
- Traffic: 554.4 MB of text in 10 minutes, about 79.5 GB/day if scaled; that is a US-afternoon sample, not a daily figure. The p95 10-second rate was 5,563 envelopes/s. BTC 5m was the busiest series (33.9 GB/day scaled, 1-second peak 4,026 envelopes/s).
- Raw frames compress about 8.3× with gzip.
- The Python recorder used about 20% of one Ryzen core.

Also checked:
- The guide's command blocks were run under a scratch HOME, including a Part 6 dry run in a local clone with the push skipped.
- Short trader-bench runs through the wrapper, unpinned, pinned and profiled, all completed with no halt.
- 16 recorder and sampler mutants all failed the tests, after two survivors got stronger tests. 4 mutants of the vitest wrapper each failed it.

### files_changed

[
 "docs/runbooks/laptop-host-bench.md",
 "docs/bench/README.md",
 "tools/bench/host/README.md",
 "tools/bench/host/requirements.txt",
 "tools/bench/host/recorder_core.py",
 "tools/bench/host/record_markets.py",
 "tools/bench/host/host_sampler.py",
 "tools/bench/host/bench_table.py",
 "tools/bench/host/report_tables.py",
 "tools/bench/host/trader-bench.sh",
 "tools/bench/host/setup-wsl-root.sh",
 "tools/bench/host/tests/test_recorder_core.py",
 "tools/bench/host/tests/test_record_markets.py",
 "tools/bench/host/tests/test_host_tools.py",
 "tools/bench/host/tests/fixtures/market-ws-frames-h1-run-8.jsonl",
 "tools/bench/host/tests/fixtures/gamma-events.json",
 "test/unit/tooling/host-bench-tools.test.ts"
]

### tests_run

Every pnpm command used pnpm_config_verify_deps_before_run=false. I never ran pnpm install.

Gates at the tip 0340727, all exit 0:
- pnpm run lint;
- pnpm run check:deps;
- pnpm run typecheck;
- pnpm run test: 369 files, 7,821 tests. The same gates also passed before the commit.

Tool tests:
- python3 -m unittest discover -s tools/bench/host/tests: 46 tests OK, on Python 3.10.12.
- The vitest wrapper test/unit/tooling/host-bench-tools.test.ts: 4 tests passed.

Live runs on this desktop:
- **Recorder, 10 minutes:** the acceptance smoke, with its summary in the summary field. Plus an earlier 75 s run.
- **Host sampler:** short runs with --windows, --windows-per-cpu and --raw-commands, then summarize and report_tables.
- **trader-bench.sh:**
  - catch-up with --limit 3000: 726 events/s, 1,528 µs/event;
  - paced with --limit 2000 under taskset -c 2;
  - a profiled catch-up;
  - a duplicate label, which was refused with exit 73.
  - Every run was COMPLETE with no halt.

The guide's own commands:
- The bash blocks for steps 2.1, 2.2, 2.6, 2.7, the clock check, 3.2, 3.4, 3.5, 3.6, 4.4, 4.6, 4.7 and Part 5 ran under a scratch HOME. For 4.7, zstd was replaced by a gzip shim, because zstd is not installed here.
- Part 6 (steps 6.2, 6.4 and 6.5) ran in a local clone with the push skipped.
- The four branches of the wsl.conf edit were tested on temporary files.

Mutation checks:
- **Python tests:** 16 mutants applied to a scratch copy of the tools. Two first survived: an array frame counted as one event, and profiled runs included in group spreads. The tests were tightened, and all 16 now fail.
- **The vitest wrapper:** 4 mutants each made exactly 1 of its 4 tests fail. They were a Python test failure, an undocumented URL, a credential name, and a shell syntax error. The files were restored and the wrapper re-run green.

Not run here:
- Part 0 on Windows, and setup-wsl-root.sh as root.
- nvm, and step 2.4's pnpm install.
- The full-fixture Part 3 sequence, the 24-hour runs, and any git push.

### assumptions

- **Docker Engine inside WSL, rather than native PostgreSQL 17 plus Redis 7.4.**
  - The bench's default path starts exactly redis:7.4.2-alpine with AOF and postgres:17.5-alpine, the images and settings behind every desktop number, so the two machines compare like for like.
  - Ubuntu 24.04 ships PostgreSQL 16 and Redis 7.0. Native 17 and 7.4 would need extra apt repositories and settings made by hand.
  - It also matches the repository's Testcontainers integration suites.
- **Node through nvm, which needs no root.** It is the same setup as this desktop.
- **Series names are observed, not documented.** Names like btc-up-or-down-15m are seriesSlug values seen on the venue. The guide has the agent confirm them with --list-series first.
- **No series_slug filter.** H1's driver used /events?series_slug=, which the list-events OpenAPI does not document. The recorder filters only by closed, end_date_min and end_date_max, and by the Event fields seriesSlug and series[].slug.
- **Byte counts are text payloads, with WebSocket compression off.** This matches the gateway's Node client, which negotiated no compression extension in a probe.
- **A window opens at the market's eventStartTime.**
- **Intel P-core numbering (logical processors 0-11) is checked, not assumed.** The guide has the agent confirm it from each processor's measured performance %.
- **Venue facts are cited.** The recorder_core.py docstring cites verified-2026-09-16 and verified-2026-09-30 (§3 and §8). It also cites the official pages fetched on 2026-09-30: list-events, wss/market.md (byte-identical to the verified copy) and rate-limits.

### deviations

1. **Part 2's root steps (apt packages, Docker, systemd, the docker group) moved into Part 0**, as one sudo script the operator runs. A Claude Code agent cannot type a sudo password, and passwordless sudo would weaken the host. The agent's Part 2 checks the result and does every step that needs no root.
2. **Additions beyond the packet's list:**
   - trader-bench.sh, bench_table.py and report_tables.py, which keep Part 3 and Part 6 copy-pasteable;
   - a 1-hour sustained bench, from LEAN-1 §9 item 1 ("over several hours");
   - Windows sampling per logical processor. It is the only evidence of P-core against E-core placement that needs no administrator.
3. **taskset pins a virtual CPU, not a P-core.** The guide says so. It offers the Windows-side vmmemWSL affinity only as an optional step the operator runs elevated, and it does not claim the step works.
4. **Where the tests live:**
   - The offline tests are Python unittest suites under tools/bench/host/tests/, inside the allowed tools/bench/host/**.
   - One vitest wrapper under test/unit/tooling/ runs them in CI.
   - As a result, the unit suite now needs python3 3.10 or later on PATH; ubuntu-latest has it.

### known_risks

1. **Nothing ran on the laptop or on Windows 11 Home.** Part 0 and the root setup script, run as root, were not executed. This desktop runs Docker Desktop, not Docker Engine in WSL. The first real run may still find a step that does not work as written; the guide's STOP rules catch that but do not fix it.
2. **Two URLs come from memory, not from a page fetched this round:** the Claude Code installer (https://claude.ai/install.sh) and the pinned nvm version (v0.40.3). The guide falls back to Anthropic's current setup page.
3. **Windows readings that may be missing or refused:**
   - `wsl --manage --set-sparse` may be disabled; it is optional, and --allow-unsafe is forbidden.
   - The power-mode overlay registry value may read empty.
   - The laptop may expose no thermal zones.
   - The vmmemWSL affinity may not bind the VM's virtual CPUs.
4. **The recorder is Python.** At about 1,450 frames/s it used about 20% of a Ryzen core. A much busier day could smear its per-second timestamps. Its CPU use shows in the host profile.
5. **Disk use is an estimate.** The smoke scales to about 79 GB/day of text, about 10 GB/day as gzip on disk. The guide asks for 150 GB free; a busier day could exceed the estimate.
6. **The reference feeds (Binance, Coinbase, Chainlink) are not recorded.** H1 measured them at about 6 GB/day per asset.
7. **bytesPerDay is scaled from the recording's length.** A partial recording skews it, so the guide asks for at least 20 hours.
8. **The unit suite now depends on python3 on PATH.**

### follow_up

1. Merge the guide to main before the user starts the laptop agent. The agent clones main.
2. After the laptop run, the orchestrator reruns Part 3 on the desktop at the laptop's commit, for a like-for-like comparison.
3. A small follow-up round fixes any guide step the first laptop run shows does not work, using PROGRESS.md and the results file.
4. Items in LEAN-1 §9 that this package does not cover:
   - the Hetzner CX33 half of item 1;
   - the research-tier prototype (item 4);
   - state churn (item 5);
   - restart behaviour (item 7);
   - watts, which need the user's plug meter.
5. If the 24-hour recording confirms that the 5-minute series dominate (BTC 5m was the busiest in the smoke), size SCALE-8 and ROLLOVER-1 for them first.

### commit_sha

0340727

## Implementer handoff r1 (verbatim)

### summary

Round 1 of HOST-BENCH-PREP fixes every agreed finding in one commit, 4c27e0f, on top of 0340727 (not pushed). All gates exit 0 at 4c27e0f. The earlier live smoke was rerun on the changed recorder.

**Findings and fixes:**
- **X1 (recorder tasks could die silently):**
  - The reconnect backoff no longer overflows: 1024 attempts used to raise OverflowError.
  - A failed Gamma poll of any kind (including IncompleteRead) is now counted by kind and retried, instead of ending discovery.
  - `Recorder.run` checks its tasks every second. If one dies it logs FAILED, stops at once, writes summary.json with `outcome: "failed"` and a failures list, and exits 3. A signal gives `outcome: "interrupted"`.
- **X2 (partial summaries dropped rows):** summaries no longer remove rows from the per-second file. The 1-second peak now also counts the seconds still buffered.
- **X3 (unmeasured LEAN-1 §9 inputs):** the guide and results template now mark as UNVERIFIED, each with a follow-up: "with and without evaluation", the gateway-based recording, SNAPPY Parquet, Redis bytes per entry, and deployment headroom. "Host headroom" became "baseline capacity".
- **A1 (adapter names in public results):** the sampler summary labels Windows adapters `adapter-1`, `adapter-2`, and so on. The redaction grep also checks the Windows user name.
- **O2 (untested failure paths):** offline tests on a fake WebSocket, a stubbed Gamma and a stand-in `run.sh`. All 15 mutants are killed, including all 6 earlier survivors.
- **LOW items, all fixed:**
  - A6: PATH set before `claude --version`.
  - A7: `wsl --shutdown` is described as terminating every session, including the agent's.
  - O3: `--pin` pins only the trader; the paced publisher is moved to the other vCPUs and logged as `publisher=<cpus>`.
  - O5: Gamma pages use the documented `order=id&ascending=true`, and a truncated poll is logged and counted.
  - O6: the URL guard requires the exact host.
  - O7: the sampler now reports CPU per process.
- **A defect I found under O7:** the venv recorder's command name is `python`, so the r0 sampler never tracked it at all. The sampler now labels Python processes by script name, e.g. `python:record_markets.py`.
- **O4 (INFO):** adopted. The smoke-gate step still stops, but first records the failing file and one isolated rerun.
- **O8 (INFO):** argued, no change (see assumptions).

**Live 10-minute smoke** (18:25:30-18:35:33Z, all 8 series):
- Exit 0, `outcome: complete`.
- 712,264,489 text bytes; 1,121,353 events.
- 8 connects, 0 disconnects, 0 stale closes.
- 10 Gamma polls, 0 failures.
- The per-second file reconciles exactly with the summary: 601 unique seconds, same event total.
- The recorder used 27% of one vCPU on average, 35.8% at most.

**Real bench check:** a pinned paced run with `--limit 2000` finished COMPLETE with `publisher=0,1,3,…,23` (the other 23 of this desktop's 24 vCPUs).

Handoff: /tmp/claude-1000/-home-adriancova-proyects-tradeBot-polymarket-bot/083749fa-1d4c-4735-b241-48f81129d71c/scratchpad/host-bench-prep/handoff-r1.md, mirrored to ~/pmb-rounds/host-bench-prep/handoff-r1.md. It has the finding-to-pin table and the mutation table.

### files_changed

[
 "docs/runbooks/laptop-host-bench.md",
 "tools/bench/host/README.md",
 "tools/bench/host/recorder_core.py",
 "tools/bench/host/record_markets.py",
 "tools/bench/host/host_sampler.py",
 "tools/bench/host/report_tables.py",
 "tools/bench/host/trader-bench.sh",
 "tools/bench/host/tests/test_recorder_core.py",
 "tools/bench/host/tests/test_record_markets.py",
 "tools/bench/host/tests/test_host_tools.py",
 "test/unit/tooling/host-bench-tools.test.ts"
]

### tests_run

All pnpm commands ran with `pnpm_config_verify_deps_before_run=false`; no install was run.

**Gates at 4c27e0f:**
- lint: exit 0.
- check:deps: exit 0.
- test: exit 0. Test Files 369 passed (369); Tests 7822 passed (7822), one more than r0 from the new vitest case.
- typecheck: exit 0 (run before two guide-only wording edits; no TypeScript changed after it).

**One earlier test run at the tip failed under load (load average 20):** 1 failed | 368 passed. The failure was a 5000 ms timeout in `packages/features/src/canonical-order.test.ts`, a file this diff does not touch. The same file passed 4/4 alone, and the rerun above passed.

**Offline Python suite:** 69 tests, OK (Python 3.10.12). The vitest wrapper `host-bench-tools.test.ts`: 5 passed.

**Pins against 0340727:**
- Method: the five tool sources were restored from 0340727 in the worktree (`git diff` empty), and the new suite was run against them.
- Result: 69 tests, FAILED (failures=6, errors=15). Every new pin failed.
- Restore: the files were copied back, and `sha256sum -c` passed on all five.

**O6:** r0's prefix guard accepts `https://gamma-api.polymarket.com.example/` and `https://gamma-api.polymarket.com@evil.example/` (shown with node). The new guard rejects both.

**Mutation table:** 15 of 15 mutants killed, each on a scratch copy of `tools/bench/host`. They include all 6 of opus's survivors, such as the aligned-open `% 900` → `% 300`.

**Live checks:**
- the 10-minute recorder smoke (exit 0, `outcome: complete`);
- the sampler with the new per-process CPU;
- real `trader-bench.sh --pin 2` runs, paced and catch-up, `--limit 2000`, both COMPLETE with halts none;
- a 4-minute tracemalloc probe;
- a 20-minute recorder RSS observation;
- a 12-poll Gamma RSS check.

### assumptions

- **How the publisher is found:** the paced publisher is the bench Node process's direct child whose arguments contain `--pace-from` (bench-main.ts:189-200). taskset and run.sh both exec, so `$!` is the bench pid. The real run confirmed it. If the pattern ever misses, `runs.txt` says `publisher=missed` and the guide says STOP.
- **Gamma ordering:** `order` and `ascending` are documented list-events parameters (the same docs sha256 as r0, a4a9bf4f…). `order=id` uses the documented Event field `id`. Correctness does not depend on the order, because windows are keyed by conditionId.
- **Per-process CPU is approximate:** it sums utime+stime deltas per pid. A process that starts and exits inside one interval is not seen.
- **O8 ("installing the service"):** argued, no change. The packet scopes this package to machine setup plus HOST-BENCH, and a product service install belongs to later HOST-1 rounds. The orchestrator should confirm with the user what "installing the service" meant.
- **Exit statuses:** 3 means a dead task. 0 means complete or interrupted. 2 is unchanged.

### deviations

1. **Test seams added:** `SeriesConnection` takes an optional `connect`; `ping_interval_s` and `pong_timeout_s` are attributes; `args.quiet` and `args.connect` are read with getattr. Production defaults and the CLI are unchanged.
2. **O7 fixed in code, not only in the handoff wording:** the sampler now reports CPU and RSS per label, and Python processes are labelled by script name. r0's sampler could not see the venv recorder at all.
3. **Extra redaction check:** the redaction grep also checks the Windows user name, fetched through interop.
4. **Summary format:** summaryVersion 1 → 2, adding `outcome`, `failures` and an extended `gamma` block.
5. **No RSS guard this round:** the packet allows one commit with no amend, so the guard for known_risks 1 is left as a follow-up.

### known_risks

1. **Recorder RSS growth outside the Python heap:**
   - In the smoke, the recorder's RSS rose from 47 to 147 MiB. Python-traced memory stayed flat at about 5 MiB current and 18 MiB peak.
   - A 20-minute run grew about 13 MiB/min for 8 minutes, then about 3 MiB/min, then stayed flat at 143 MiB from minute 16 to 20. The first smoke flattened at 141-147 MiB the same way.
   - A Gamma-only loop stays flat at 58 MiB.
   - This looks like an allocator high-water mark, not a leak, but 20 minutes is not 24 hours. The sampler logs the recorder's RSS every minute; nothing in the guide stops on it this round.
2. **Nothing ran on the laptop, on Windows 11 Home or in WSL's own taskset:** all of this round's live checks ran on the development desktop.
3. **Load-sensitive unit tests:** the full suite's 5 s timeouts fail under heavy host load. The guide's step 2.4 now collects evidence, but still STOPs.
4. **New async offline tests:** they take about 9 s and use short real sleeps. They could flake under extreme load, though they passed at load average 20.
5. **r0 risks unchanged:**
   - the Claude Code installer URL and the nvm version come from memory;
   - `--set-sparse` may not be available;
   - `vmmemWSL` affinity semantics are undocumented;
   - the unit suite needs Python 3 on CI's PATH;
   - `bytesPerDay` is scaled from the recording's length.

### follow_up

1. The verifiers re-check X1-X3, A1, O2 and the LOW items at 4c27e0f.
2. **Optional recorder RSS guard,** now or later: a `runtime.maxRssMiB` field (from getrusage) printed by the report, a 1-hour check in guide step 4.4 that STOPs above 1 GiB, and `MALLOC_ARENA_MAX=2` if a longer run shows unbounded growth.
3. **Owners for the UNVERIFIED LEAN-1 §9 inputs:**
   - a bench switch to turn evaluation off;
   - a gateway-based recording;
   - a SNAPPY Parquet conversion of recorded hours;
   - Redis bytes per entry, measured against a kept bench Redis.
4. The orchestrator confirms O8 with the user.
5. **r0 follow-ups still open:**
   - a desktop rerun at the laptop's commit;
   - a small guide round after the first laptop run;
   - the guide must be on main before the user clones.

### commit_sha

4c27e0f
