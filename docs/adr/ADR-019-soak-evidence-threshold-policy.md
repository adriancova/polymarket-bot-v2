# ADR-019: The soak-evidence threshold — 24 contiguous hours, one window, no summing

- **Status:** Accepted
- **Date:** 2026-09-02
- **Recorded by:** `GOV-1C` (orchestrator-authorized contract-owner governance
  round at Wave 1 closeout), ratifying `WP-140` assumption 1 on the ruling its
  `follow_up` 5 requested
- **Implemented by:** `WP-140`
  (`packages/observability/src/recorder/soak-evidence.ts`) — **already shipped
  and merged**; the ratified value equals the shipped constant, so **no code
  changes**
- **Supersedes / Superseded by:** none

## Context

Handoff §16.7 and §17 (Phase 1 exit) require a "sustained recording soak" and
forbid claiming one without real evidence (`AGENTS.md`), but neither the
handoff nor the work plan states a duration. `WP-140` shipped an evaluator
with `SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS = 24 * 60 * 60 * 1000` and disclosed
it as **assumption 1** — "a one-line reviewed edit if the orchestrator rules
otherwise" — and its known-risk 5 disclosed the stricter half: the evaluator
"sums nothing and forgives nothing", so operational restarts reset the
qualifying window, and "if the orchestrator later rules that N windows
totalling T qualify, that is a reviewed evaluator change". This record is that
ruling.

## Decision

1. **The repository's soak-evidence threshold is 24 contiguous hours — one
   window.** `QUALIFYING_WINDOW_FOUND` requires a **single contiguous
   qualifying window ≥ 24 h** in which the recorder demonstrably recorded,
   shut down cleanly on request, and reported zero unexplained-gap signals.
   The shipped constant is ratified as policy; it is no longer
   assumption-backed.
2. **No summing, ever, under this record.** N shorter windows totalling ≥ 24 h
   do not qualify, whatever N. "Sustained" means the process stayed up; a
   deploy, host reboot, or crash resets the window by design, which is what
   makes 24 h a real operational bar rather than an accounting exercise
   (`WP-140` known-risk 5). Adopting any window-composition rule is a
   **superseding ADR plus a reviewed evaluator change**, not a config knob.
3. **The bar is the evaluator's fail-closed reading of the evidence, not the
   number alone.** The ratified policy includes the shipped semantics: a
   malformed, unknown-keyed, contradictory, or future-dated record poisons the
   evidence set to `INVALID`; a short window is `PENDING` with the arithmetic
   stated; and the conservative gap rule stands — WAL recording failures AND
   any incident whose reason code contains `GAP` are unexplained-gap signals,
   so **even a venue-side gap keeps a window from qualifying** until an
   operator reviews and either re-runs or documents the explanation
   (`WP-140` assumption 2: harder to satisfy, never easier).
4. **`QUALIFYING_WINDOW_FOUND` is a candidate, not completion.** The evaluator
   enforces internal consistency of records inside its own filesystem trust
   domain; it cannot prove provenance. Closing the soak gate remains an
   out-of-band governance record in `IMPLEMENTATION_STATUS.md` after review
   of the evidence's provenance (`WP-140` remediation round 1's
   forged-file finding is why). Nothing in this ratification weakens that,
   and no soak is claimed by this record — none has been run.
5. **Operational guidance stands:** request ≥ 26 h of runtime so a qualifying
   24 h window survives operational slack (`docs/runbooks/recorder.md` §7).
   The 26 h figure is guidance, not a second threshold.

## Consequences

- The evaluator constant is **policy-backed**: changing the threshold value or
  adopting summing now requires superseding this ADR *and* a reviewed edit to
  `soak-evidence.ts`, in that order — the reverse of an assumption quietly
  drifting.
- The bar is deliberately expensive: a single infrastructure restart at hour
  23 costs a full re-run. That is accepted — under-claiming costs re-runs;
  over-claiming costs a false Phase-1 exit (`AGENTS.md`: no soak may be
  claimed without real evidence), and the repository consistently buys the
  first failure direction.
- Venue-side gaps keep windows unqualified (decision 3), so a noisy venue
  week can stall the gate; the sanctioned path is the operator review named
  in decision 3, never a threshold relaxation.
- **No code changes; no `schemaVersion` movement** (no domain contract is
  involved). If a different bar had been ruled, the change would have been the
  one-line reviewed evaluator edit `WP-140` assumption 1 reserved — it was
  not needed.

## Evidence

- `packages/observability/src/recorder/soak-evidence.ts` —
  `SOAK_ELAPSED_EVIDENCE_THRESHOLD_MS = 24 * 60 * 60 * 1000` and the
  evaluation semantics (read 2026-09-02).
- `docs/handoffs/WP-140.md` — assumption 1 (the threshold and its "one-line
  reviewed edit" reservation), assumption 2 (the conservative gap rule),
  known-risk 5 (no summing; restarts reset; the reviewed-change reservation),
  `follow_up` 5 (the request for this ruling), summary item 3
  (`QUALIFYING_WINDOW_FOUND` is a candidate; the loopback smoke can never
  qualify), and remediation round 1 (the forged-evidence BLOCKER that
  produced decision 4's out-of-band rule).
- `docs/runbooks/recorder.md` §7 (the 26 h request guidance; the real-soak
  procedure).
- Handoff §16.7, §17 (the sustained-soak requirement with no stated duration);
  `AGENTS.md` (no unearned soak claims).
- **Venue facts:** none — this record asserts no venue behavior, and no soak,
  execution probe, or live result is claimed.
- **Safety:** no run-mode default is touched (ADR-010).
