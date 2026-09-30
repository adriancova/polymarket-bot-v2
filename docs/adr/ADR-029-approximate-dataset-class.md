# ADR-029: The approximate dataset class

- **Status:** Accepted. The user ruled on 2026-09-30 (`LEAN-1`, ruling A4).
- **Date:** 2026-09-30
- **Recorded by:** `LEAN-GOV`
- **Implemented by:** `STORAGE-1` (the research tier and its manifest) and
  `APPROX-REPLAY-1` (the replay source). Not yet implemented.
- **Supersedes / Superseded by:** none. It **amends** handoff §8.4, §12.4 and
  §12.5, and the ADR-017 manifest format (a version bump). It adds a rank
  below ADR-012's tiers.
- **Handoff sections:** §6 (invariant 15), §7.1, §8.4, §12.2-§12.6, §17.
  **ADRs:** ADR-012, ADR-017, ADR-019, ADR-028.

## Context

1. ADR-028 keeps a downsampled research tier forever and deletes most raw WAL
   after 72 hours.
2. The research tier holds, per token, top of book on change at most every
   1 s, five levels a side every 1 s, a full book every 60 s, every trade, and
   lifecycle and incidents. Per asset, it holds 1 s bars of Binance and
   Coinbase trades and every Chainlink tick (`LEAN-1` §4).
3. Backtests on it are cheap. They can also overstate an edge: they cannot see
   queue position or moves inside one second.
4. Every dataset today is exact. The manifest format
   `polymarket-bot/dataset-manifest/v1` (`DATASET_MANIFEST_VERSION = 1`) has
   no field that says otherwise (ADR-017).
5. ADR-012 ranks fill-model evidence in three tiers. All of them assume exact
   data.

## The ruling

The user's ruling A4 (`docs/handoffs/LEAN-1.md`, "The user's rulings
(2026-09-30)"):

> **A4 + A5: yes to both.** An "approximate" research dataset class, never
> admissible as proof.

The proposal the user accepted (`LEAN-1` §6, row A4):

> Add an "approximate" dataset class built from the research tier, never
> admissible as determinism, calibration or promotion evidence.

## Decision

### 1. A `fidelity` field in the dataset manifest

1. Every dataset manifest states `fidelity`: `exact` or `approximate`.
2. This changes the manifest's field set, so the manifest version moves:
   `DATASET_MANIFEST_VERSION` 1 → 2 (ADR-017, Consequences). `STORAGE-1`
   states whether the format id (`polymarket-bot/dataset-manifest/v1`) moves
   with it.
3. A version 1 manifest has no `fidelity` field. A reader treats it as
   `exact`, because every version 1 dataset was compacted from raw WAL.
4. A research-tier dataset is `approximate`. Its manifest pins the research-tier
   objects and their digests, and the downsampling version. An approximate
   replay reads these, not raw segments.
5. The manifest also lists every source segment the research tier was built
   from, with its `segmentSha256` and `segmentFileSha256`. This is provenance,
   and the deletion-time identity that ADR-028 Decision 2.6 needs. An
   approximate replay does not read the segments.
6. The field is required in version 2. A reader refuses a version 2 manifest
   without it.

### 2. What an approximate dataset may never be used for

An approximate dataset, and any result computed from it, is never admissible
as:

1. **determinism evidence** (§12.4), including any CI golden;
2. **calibration evidence** (ADR-012's execution calibration model, `WP-360`);
3. **promotion evidence** (§17 Phase 4 and later gates, `WP-370`);
4. **soak evidence** (ADR-019).

It is for research: screening ideas and comparing parameters.

### 3. Its rank

1. Any result on an approximate dataset ranks **below every tier of ADR-012**,
   including Tier 0.
2. When an exact and an approximate result disagree, the exact one controls.

### 4. Labels

1. Every report, run record and export from an approximate dataset says
   "approximate".
2. The label is carried in the run's manifest, not inferred from a file name.
3. A tool that builds evidence for §2's uses refuses an approximate input.

### 5. §6 invariant 15 is kept, at sample resolution

§6 invariant 15: "Replay follows information arrival order. It must not use
future venue timestamps unavailable to the live process."

Order comes from the recorded dispatch order, not from instants. Within one
gateway epoch, `ingestSeq` is that order (§7.1). Receipt instants can repeat
or step backwards (ADR-026, Context 5), so sorting by instant could replay a
later arrival first.

1. **The release frame.** Every research-tier sample has a release frame: the
   recorded frame at which a live process would hold all of its information.
   - A sample taken on change (a top-of-book change, a trade, a lifecycle
     event, an incident, a Chainlink tick) is released at its last
     contributing frame.
   - A sample that summarizes a span up to a boundary (a 1 s bar, a periodic
     book sample, a full book) is released at the first frame, in dispatch
     order, whose receipt instant is at or after the boundary. Only then does
     a live process know the span is over. A bar is never released at its
     open. A sample with no such frame in its epoch is not replayed.
2. **What a sample carries.** Its release frame's `gatewayEpoch` and
   `ingestSeq`, and that frame's receipt instant as its available instant.
   The available instant is event time for the replay, as `receivedAt` is
   for an exact replay. It is never used to order samples.
3. **The order.** Approximate replay consumes samples in the dispatch order
   of their release frames: by `ingestSeq`, within one gateway epoch. Several
   samples released at one frame are consumed in a fixed order that the
   downsampling version defines, for example by sample kind and then by token
   or asset id. So samples replay in arrival order, and ties always break the
   same way. For example, a sample released at `ingestSeq` 1 with instant
   10,000 ms comes before one released at `ingestSeq` 2 with instant
   9,999 ms.
4. **One epoch at a time.** `wal-format.md` §12.1 defines no order across
   gateway epochs. An approximate replay covers one epoch, as the compactor
   does. A replay across epochs needs that order first: new recorded evidence
   and an ADR-004 amendment (§12.1 rule 5). `APPROX-REPLAY-1` stops and asks
   if it needs one.

### 6. Determinism inside the class

1. An approximate replay is still deterministic: the same approximate dataset,
   code, settings and seed give the same output.
2. That only shows the replay is repeatable. It is not evidence about exact
   data (Decision 2).

## What it amends

| Text | As written | How it now reads |
| --- | --- | --- |
| Handoff §8.4 | "Replay consumes the same normalized event envelopes in the exact recorded dispatch order." | Unchanged for exact datasets. Approximate replay consumes research-tier samples in the recorded dispatch order of their release frames, within one gateway epoch, with a fixed tie order. It never sorts by instant (Decision 5) |
| Handoff §12.4 | "A fixed dataset, code commit, config, feature version, model version, simulator version, and seed must produce byte-identical …" | Unchanged. Only an `exact` dataset can be determinism evidence (Decision 2) |
| Handoff §12.5 | "Every replay run pins: raw segment IDs and checksums …" | An exact replay pins these. An approximate replay pins research-tier objects and checksums and the downsampling version instead, plus every other §12.5 item. Its manifest still lists the source segments' checksums (Decision 1.5) |
| ADR-017 (manifest format) | `polymarket-bot/dataset-manifest/v1`, `DATASET_MANIFEST_VERSION = 1`, no `fidelity` field | Version 2 adds the required `fidelity` field. Version 1 reads as `exact` (Decision 1) |
| ADR-012 §1 | three tiers: Tier 0, Tier 1, execution calibration | Unchanged. An approximate result ranks below all three (Decision 3) |

Not amended: §6 invariant 15 (Decision 5), and ADR-012 §2's evidence rule.

## Consequences

- **Cheap backtests of new ideas,** over months of data, on one laptop.
- **They can overstate an edge.** They are labelled and barred from
  calibration and promotion (`LEAN-1` §11, risk 7).
- **A manifest version bump.** `STORAGE-1` writes version 2. In the same
  round, before any version 2 manifest is written, it moves every reader to
  accept both versions:
  - `packages/storage-parquet/src/dataset-manifest.ts`, the writer's own
    reader;
  - `packages/simulation/src/manifest.ts`, the exact replay door that the
    backtest uses (`apps/backtest-cli/src/assembly.ts`). Today it accepts
    version 1 only, and its strict field list has no `fidelity`. It must
    accept version 1 and version 2 `exact` manifests, and refuse a version 2
    `approximate` manifest (Decision 4.3);
  - `python/research/compaction/manifest.py`.
  Version 1 fixtures and goldens stay version 1 and keep passing.

## Evidence

- `docs/handoffs/LEAN-1.md` §4, §6 row A4, §11 risk 7, and "The user's rulings
  (2026-09-30)".
- `docs/spec/polymarket-bot-orchestrator-handoff.md` §6 invariant 15, §8.4,
  §12.2, §12.4, §12.5, §17.
- ADR-012 §1 and §2; ADR-017 Context and Consequences; ADR-019.
- `packages/storage-parquet/src/constants.ts` (`DATASET_MANIFEST_VERSION`);
  `packages/simulation/src/manifest.ts` (`SUPPORTED_DATASET_MANIFEST_VERSION`).
- `docs/contracts/wal-format.md` §12.1 (no cross-epoch order); handoff §7.1
  (`gatewayEpoch` and `ingestSeq`).
- No venue fact is used.
