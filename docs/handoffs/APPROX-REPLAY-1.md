# APPROX-REPLAY-1: approximate replay over the research tier (ADR-029)

**Status:** Complete (2026-10-03). Merged `86830d9` (PR #48; CI run `37103978626` green).
**Reviewer:** Codex gpt-6-astra. Round 1 was CHANGES REQUIRED with two HIGHs. **ACCEPT at round 2 on `2d06217`.**
**Base:** `315fe80`. The branch merged `main` at `2c070b4` before the PR. **Paths:** `apps/backtest-cli/**`.
**Posture:** PAPER only.

## summary

`backtest-cli approx-run` replays a verified research-tier dataset through the same core (`assembleBacktestCore`) and driver (`replayDrivenCoreLoop`) as the exact `run`. Every output is labelled approximate.

- **Reading.** It reads only through `storage-parquet`'s `verifyResearchTierDataset` and `readResearchTableObject`. An unverified dataset is refused. Every decoded object is digested against its verified pin, and nothing is written to the store.
- **Order.** Samples are consumed in `sampleOrdinal` order, checked against the release `ingestSeq` and downsampling v1's fixed tie order. They are never sorted by instant, and any disagreement refuses. Four span rules that are visible from samples are enforced.
- **One epoch.** A cross-epoch input stops and asks (`APPROX_REPLAY_CROSS_EPOCH`, exit 4) before any sample is read.
- **Translation.** Samples become the envelopes the core consumes (`backtest-cli/research-tier-samples/v1`, pinned as the run's normalizer version), each checked by the core's own event door.
- **The clock.** It is positioned at each sample's receipt instant, so ADR-031's process lag reads 0.
- **Labels.** Every printed line and every artifact line carries the manifest's fidelity. The admissibility text is printed verbatim. Approximate runs have their own format ids.
- **The exact tools are untouched in what they accept.** `verify`, `run`, `runBacktest` and `runBacktestCore` still refuse an approximate manifest (`REPLAY_MANIFEST_APPROXIMATE`). The exact renderer now refuses any non-exact result.

## Rounds

| Round | Candidate | Verdict | Findings |
|---|---|---|---|
| 1 | `cdd6bfe` | CHANGES REQUIRED | APPROX-R1-H1: multiline manifest text escaped the approximate label. APPROX-R1-H2: the public core renderer exported approximate results without fidelity |
| 2 | `2d06217` | **ACCEPT** | none |

## tests_run

- **Gates:**
  - `typecheck`, `lint` and `check:deps` exit 0;
  - `test`: 435 files, 9801 tests;
  - `test:e2e`: 9/212;
  - `test:replay`: 3/17, with the exact static-bracket golden unchanged.
  - backtest-cli itself went from 75 to 131 tests.
- **Mutation:** 30 of 30 killed.
- **End to end, on a copy of H1 run 7's WAL:**
  - the STORAGE-1 extractor built one research dataset (7,803 samples) and an exact pin;
  - `approx-run` delivered 2,449 release frames and 2,449 decisions;
  - one entry intent was refused `RISK_SETTLEMENT_UNVERIFIED`, matching live run 7's single refusal and its code;
  - the artifact was byte-identical across three runs;
  - `~/pmb-h1` checksums are unchanged.
- **CI:** GitHub CI on the PR #48 merge ref was green before the merge: run `37103978626`.

## assumptions
- Gamma market ids are given by the operator, with `--gamma-markets`.
- Synthesized book snapshots carry no `connectionId`, so ADR-023's session freshness never applies in approximate replay.

## deviations
- None beyond the work plan.

## known_risks

Approximate replay cannot reproduce:
- per-frame evaluation (2,449 decisions against 189,828 live);
- book moves within one second, levels below the fifth, or queue position;
- exact book ages;
- the live process's lag, so lag-driven refusals cannot appear;
- the poll-timed close;
- `market_resolved` and gateway incidents.

No exact core replay of an H1 window exists to compare against: the exact `run` needs a normalized-envelope recording.

## follow_up
- An exact-replay source over the WAL pins, if exact replays of pinned windows are wanted.

## commit_sha
`2d062174cd24900f3293ade645099906d09a74af`
