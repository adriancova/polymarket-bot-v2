/**
 * WP-340 r1 (J1, J3): every WP340-F1 release the recovery driver (`releaseKnownFindings`) makes in this suite, by
 * population. Each suite pins its own entry EXACTLY (the runs are deterministic), so a halt the driver releases where
 * none is expected fails the suite that made it; `report.test.ts` checks that the security and recovery report states
 * the same numbers. The day `packages/oms` fixes WP340-F1 (the user's 2026-10-05 ruling: venue-time ordering), every
 * count here becomes 0, and the pins say so.
 *
 * Not counted: the four TODAY tests of `findings.test.ts` release their quarantine by hand, as an operator would.
 *
 * C1-OMS06 (2026-10-09): the coordinator no longer calls a halt port (the live gate reads its quarantines from the
 * journal), so its `halt.market` calls are no longer kill points: MID-ANSWER has 101 port calls instead of 106, and its
 * kill runs release 139 instead of 151; the seeded crash property's kills land elsewhere, and release 70 instead of 71.
 */

/** Per crash-matrix scenario (`mid-order-crash.test.ts`, first `describe`): the no-crash baseline, and the sum over every kill run. */
export const CRASH_MATRIX_F1: Readonly<Record<string, { readonly baseline: number; readonly killed: number }>> = Object.freeze({
  "accepted, partly filled (the user channel and a reconciliation deliver it), canceled": { baseline: 0, killed: 0 },
  "MID-ANSWER: the venue acted and the answer was lost (the SDK's TransportError); found PRESENT by signed identity, then filled": { baseline: 1, killed: 139 },
  "MID-TRANSMISSION: the request never arrived; ABSENT after the quiescence horizon; then a new salt for the group": { baseline: 0, killed: 0 },
  "a late arrival inside the horizon: never ABSENT, found PRESENT": { baseline: 0, killed: 0 },
  "a real 425 restart (WP-260 maps the pinned SDK's 425): held ABSENT, the same signed order resent into the post-only window": { baseline: 0, killed: 0 },
  "`unmatched` (the pinned SDK turns it into an unknown): found PRESENT": { baseline: 0, killed: 0 },
  "a batch whose answer was lost after the venue acted: both PRESENT, one filled": { baseline: 0, killed: 0 },
  "a documented rejection, then a new salt for the group": { baseline: 0, killed: 0 },
});

const matrix = Object.values(CRASH_MATRIX_F1);

/** The populations the report's §5 table lists, in its order. */
export const F1_RELEASES = Object.freeze({
  crashMatrixBaselines: matrix.reduce((sum, entry) => sum + entry.baseline, 0),
  crashMatrixKilled: matrix.reduce((sum, entry) => sum + entry.killed, 0),
  /** `mid-order-crash.test.ts`, second `describe`: the MID-ANSWER-of-a-reconciliation pin's no-crash baseline (route 1). */
  crashNamedPins: 1,
  /** `mid-order-crash.property.test.ts`, 200 seeds, 1,000 runs. */
  crashProperty: 70,
  /** `lost-stream-events.test.ts`: the DELAYED-past-a-read case (route 2). */
  streamNamed: 1,
  /** `lost-stream-events.property.test.ts`, 300 seeds. */
  streamProperty: 59,
  /** `release-driver.test.ts`: the two positive controls and the provenance pin's first, genuine F1. */
  releaseDriver: 3,
});

/** What the round-1 verifiers measured on the r0 suites (every population but `releaseDriver`, which r1 added). */
export const F1_RELEASES_R0_SUITES =
  F1_RELEASES.crashMatrixBaselines + F1_RELEASES.crashMatrixKilled + F1_RELEASES.crashNamedPins + F1_RELEASES.crashProperty + F1_RELEASES.streamNamed + F1_RELEASES.streamProperty;
