/**
 * WP-290 r6: a named regression, the verifiers' round-5 reproductions kept in the suite: Opus's round-5 late-arrival clock probe (R5-02).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `r5-clock-late.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { expect, it } from 'vitest';
import { ready, sequence } from '../support/scenario.js';
import { YES } from '../support/harness.js';
import { group, ticket } from '../../../unit/oms/support/harness.js';
import { trace } from "../support/loose.js";

// Venue (true) time stays on the harness's original clock object; the coordinator's local clock is decoupled
// by swapping u.clock (harness.ts:543 reads u.clock.t on every call; the world closes over the original object).
// The local clock jumps forward by the horizon; true time does not move, so B's LATE_ARRIVAL (lateMs 1000 < 5000)
// is still pending. CORRECTED: the local clock steps back to true time after the first ABSENT answer is applied,
// so the coordinator DETECTS the fault (#recordAnswer -> #now -> #clockFault) before it answers B.
for (const mode of ['CORRECTED', 'UNDETECTED'] as const) it(`OPUS-R5-02-LATE ${mode}: a late order is answered ABSENT after the clock fault is detected`, async () => {
  const r = await ready();
  const a = group(9001, { tokenId: YES, plannedShares: '5' }), b = group(9002, { tokenId: YES, plannedShares: '5' });
  expect((await r.oms.registerGroup(b)).ok).toBe(true);
  r.u.world.nextTransmission = sequence(['UNKNOWN_ABSENT', 'LATE_ARRIVAL']);
  expect((await r.oms.submitBatch([ticket(a, { n: 960, shares: '1' }), ticket(b, { n: 961, shares: '1' })])).ok).toBe(true);
  const trueClock = r.u.clock;
  const local = { t: trueClock.t + r.u.policy.quiescenceHorizonMs + 1 };
  (r.u as unknown as { clock: { t: number } }).clock = local;
  let first = true;
  r.u.seams.applyReconciliation = async (raw, real) => { const result = await real(raw); if (first) { first = false; if (mode === 'CORRECTED') local.t = trueClock.t; } return result; };
  const report = await r.p.coordinator.reconcile();
  trace('OPUS-R5-CLOCK-LATE', JSON.stringify({ mode, accepted: r.u.accepted, violations: r.u.violations, worldViolations: r.u.world.violations, runs: report.runs.map((x) => ({ status: x.status, resumed: x.resumed, detections: x.detections.map((d) => d.breakClass), answers: x.answers.map((y) => [y.subjectId, y.verdict, y.accepted]) })), resumed: report.resumed }));
  // UNDETECTED is the out-of-scope control (no reading can reveal a forward jump that is never corrected).
  if (mode === 'CORRECTED') { expect(r.u.violations).toEqual([]); expect(report.resumed).toBe(false); }
});
