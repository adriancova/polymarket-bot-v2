# ADR-025: The laptop PAPER host profile

- **Status:** Accepted. The user ruled on 2026-09-30 (`LEAN-1`, ruling H).
- **Date:** 2026-09-30
- **Recorded by:** `LEAN-GOV`
- **Implemented by:** `HOST-BENCH`, `HOST-1` and `BURN-IN`. None of them exists yet.
- **Supersedes / Superseded by:** none. It **must be superseded** before any
  mode above PAPER runs on any host (Decision 9).
- **Handoff sections:** §2, §4, §4.1, §4.2, §9.1, §11, §15. **ADRs:** ADR-003,
  ADR-004, ADR-010, ADR-019, ADR-028.

## Context

1. The handoff describes processes, not a host. §4.1 lists five deployable
   processes. §4.2 lists failure boundaries between them. Nothing says where
   they run.
2. §2 names "object storage" but no vendor:
   "| Raw archive | Append-only local WAL, compacted into checksummed Parquet in
   object storage |". The shipped store is a local directory
   (`packages/storage-parquet` `fileSystemObjectStore`).
3. Two values depend on the host:
   - the Redis stream retention, which ADR-003 calls "a safety parameter, not
     a tuning knob";
   - the §9.1 latency target, "target under 5 ms on the deployment host".
4. The user set a budget: under $100 a month for at least the first three
   months.
5. `LEAN-1` planned a first deployment on a machine the user owns. It priced a
   cloud exit. The user ruled on it on 2026-09-30.

## The ruling

The user's ruling H, as recorded in `docs/handoffs/LEAN-1.md` ("The user's
rulings (2026-09-30)"):

> **H: yes.** A dedicated laptop (ASUS TUF F15: i7-12700H, 16 GB, 1 TB), PAPER
> only, all processes on one host. The user's desktop is a personal machine
> (gaming, work), so it is the development machine and the fallback, not the
> host. About 600 GB can be freed; the connection is 1 Gb/s with no data cap.
> Electricity cost: not a concern.

> **The budget (the user):** under $100/mo for at least the first 3 months.

The proposal the user accepted (`LEAN-1` §6, row H):

> Deploy months 1-3 on a machine you own, PAPER only, all processes on one
> host, with the Redis retention raised to the measured need (for example
> 500k-1M events).

## Decision

### 1. The host

1. The host is the dedicated laptop: an ASUS TUF F15 with an i7-12700H, 16 GB
   of RAM and a 1 TB disk.
2. It runs Windows 11 with WSL2 Ubuntu and systemd. It does not use Docker
   Desktop.
3. About 600 GB of its disk is available to the deployment.
4. Its network link is 1 Gb/s with no data cap.
5. The user's desktop is the development machine. It is the fallback host,
   not the host. It is shared with games and other work, so it does not have
   its full resources around the clock.
6. A measurement taken on the desktop is not a measurement of the host. Every
   `THROUGHPUT-*` figure so far came from the desktop.

### 2. Everything runs on one host

1. The host runs the five §4.1 processes, PostgreSQL, Redis and Prometheus.
2. The process boundaries of §4.2 are kept. Each process still fails on its
   own. For example, a trader restart still does not stop recording.
3. The host itself is a shared fate. A host outage stops recording and trading
   together.
4. A host outage is a recording gap. It is recorded as an explained
   data-quality window, as any other gap is.

### 3. "Object storage" on this host

§2's "object storage" means, on this profile:

1. the local filesystem object store (`fileSystemObjectStore`), which is the
   store every verification step reads; and
2. Backblaze B2, which holds encrypted copies of the pinned windows, the
   research tier and the nightly database dumps.

The B2 key cannot delete. B2 lifecycle rules expire old copies. What the raw
WAL keeps, and for how long, is ADR-028.

### 4. The Redis retention value

1. The retention is set from measurement, not from the shipped default. The
   default today is `GATEWAY_RETENTION_EVENTS` = 100,000
   (`apps/data-gateway/src/main.ts`).
2. `HOST-BENCH` measures the peak event rate and the worst tolerated trader
   restart on the host. The retention must cover that restart at that rate.
   The plan's example range is 500,000 to 1,000,000 events.
3. The chosen value is recorded in `HOST-1`'s configuration and runbook, with
   the measurement it came from.
4. It remains a safety parameter (ADR-003, Consequences). A change to it is
   reviewed, not tuned.

### 5. The §9.1 latency target

1. §9.1's p99 target ("target under 5 ms on the deployment host") is measured
   on this host.
2. No measurement exists yet. Nothing may state the target as met.
3. If the target cannot be met on this host, the response is an amendment with
   the evidence (ADR-003, Consequences), not a quiet relaxation.

### 6. The budget

1. The budget is under $100 a month for at least the first three months.
2. Before any step whose forecast exceeds $80 a month, the orchestrator stops
   and brings the options to the user (`LEAN-1` §5.3).
3. Evidence is never deleted to meet a budget.
4. The user said electricity cost is not a concern. No electricity exemption
   from the budget was recorded.

### 7. Security on this host

1. Every service binds to 127.0.0.1. Remote access is through Tailscale only.
2. No router port is forwarded.
3. The host holds no wallet, signer or venue credential. It holds only the B2
   key and the alert tokens.
4. §6 invariant 17's startup validation stays on.

### 8. PAPER only

1. The safety defaults are unchanged: `MAX_RUN_MODE=PAPER`,
   `ALLOW_REAL_ORDERS=false`, and both `LIVE_MICRO_*` caps at 0.
2. This profile covers PAPER and BACKTEST runs only. It does not cover SHADOW
   or any live mode.

### 9. It must be superseded before any live mode

1. No mode above PAPER may run under this profile.
2. Before any mode above PAPER runs on any host, a new host ADR supersedes
   this one.
3. That ADR must name a host fit for live trading, a cost ruling, and
   `WP-320`'s geoblock and eligibility controls (§6 invariant 18).

### 10. An open question: several traders per asset group (A6)

1. `LEAN-1` ruling A6 would allow several PAPER traders, one per asset group,
   if one trader cannot carry eight markets.
2. It is **not decided**. The user deferred it until `SCALE-8` reports.
3. Until then, one gateway and one trader run on the host, as §2 ("Process
   shape") and §4 ("Single Active Trading Process") describe.

## What it amends

| Text | As written | How it now reads |
| --- | --- | --- |
| §2 "Raw archive" | "Append-only local WAL, compacted into checksummed Parquet in object storage" | On this profile, "object storage" is the local filesystem store plus B2 copies (Decision 3). What is compacted and kept is ADR-028 |
| §4.2 | "A trader deployment must not interrupt public data recording." (and the other process boundaries) | Unchanged between processes. The host is a shared fate: a host outage stops every process (Decision 2) |
| §9.1 | "Benchmark gateway receipt-to-trader dispatch p99; target under 5 ms on the deployment host." | The deployment host is the laptop. The target is measured there; it is not yet met (Decision 5) |
| ADR-003, Consequences | "Retention size is a safety parameter, not a tuning knob." | Unchanged. Its value on this host comes from `HOST-BENCH`'s measurement (Decision 4) |

## Consequences

- **The running cost is small.** `LEAN-1` estimates $3-20/month at 1-2
  markets, including electricity. These remain estimates; `HOST-BENCH`
  measures host consumption.
- **A home host has more outages than a data centre.** Windows Update, power,
  the ISP and WSL all cause gaps. Expect several restarts a month.
- **Every trader start is a new run,** as today. A gap shows in the run list and
  as a data-quality incident.
- **Soak evidence needs care.** ADR-019 requires 24 contiguous hours in one
  window. A restart inside a window breaks it. `BURN-IN` counts toward H4 only
  through the runbook §7 governance procedure.
- **Results are host-specific.** Latency and lag on this host are not
  comparable with the desktop's `THROUGHPUT-*` figures.
- **The cloud exit is priced but not chosen.** `LEAN-1` §5.2 prices a Hetzner
  host. Moving to it is a new ruling, not an automatic step.
- **Live trading needs a different host.** A home machine is not a live host
  (Decision 9).

## Evidence

- `docs/handoffs/LEAN-1.md`: §3 (topology), §5 (cost), §6 row H, §8
  (operations), §11 (risks), and "The user's rulings (2026-09-30)".
- `docs/spec/polymarket-bot-orchestrator-handoff.md` §2, §4.1, §4.2, §9.1.
- ADR-003 §5 and Consequences.
- `packages/storage-parquet/src/node-file-system.ts` (`fileSystemObjectStore`)
  and `apps/data-gateway/src/main.ts` (`GATEWAY_RETENTION_EVENTS`).
- No venue fact is used.
