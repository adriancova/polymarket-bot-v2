/**
 * WP-290 r6: a named regression, the verifiers' round-5 reproductions kept in the suite: Opus's round-5 clock probes (R5-02).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `r5-clock.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { expect, it } from 'vitest';
import { ready, submitOne, sequence } from '../support/scenario.js';
import { YES } from '../support/harness.js';
import { group, ticket } from '../../../unit/oms/support/harness.js';
import { trace } from "../support/loose.js";

// Opus re-run of astra's R5-02 probes, plus a BACKWARD variant of the two-ABSENT case.
for (const fault of ['BACKWARD', 'UNREADABLE', 'SOUND'] as const) it(`OPUS-R5-02 single answer, clock ${fault} after the answer is applied: must stay held`, async () => {
  const r = await ready();
  await submitOne(r.oms);
  expect((await r.oms.requestOrderReconciliation(r.oms.orders()[0]!.orderId)).ok).toBe(true);
  r.u.seams.applyReconciliation = async (raw, real) => { const a = await real(raw); if (fault !== 'SOUND') r.u.clock.t = fault === 'BACKWARD' ? r.u.clock.t - 1 : NaN; return a; };
  const report = await r.p.coordinator.reconcile();
  trace('OPUS-R5-CLOCK', JSON.stringify({ fault, runs: report.runs.map((x) => ({ status: x.status, resumed: x.resumed, detections: x.detections.map((d) => d.breakClass), answers: x.answers, reason: x.reason })), resumed: report.resumed, paused: r.oms.paused }));
  expect(report.resumed).toBe(fault === 'SOUND');
});

for (const fault of ['BACKWARD', 'UNREADABLE', 'SOUND'] as const) it(`OPUS-R5-02 two ABSENT answers, clock ${fault} after the first: the second must be withheld`, async () => {
  const r = await ready();
  const a = group(9001, { tokenId: YES, plannedShares: '5' }), b = group(9002, { tokenId: YES, plannedShares: '5' });
  expect((await r.oms.registerGroup(b)).ok).toBe(true);
  r.u.world.nextTransmission = sequence(['UNKNOWN_ABSENT', 'UNKNOWN_ABSENT']);
  expect((await r.oms.submitBatch([ticket(a, { n: 950, shares: '1' }), ticket(b, { n: 951, shares: '1' })])).ok).toBe(true);
  r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1;
  let first = true;
  r.u.seams.applyReconciliation = async (raw, real) => { const result = await real(raw); if (first) { first = false; if (fault !== 'SOUND') r.u.clock.t = fault === 'BACKWARD' ? r.u.clock.t - 1 : NaN; } return result; };
  const report = await r.p.coordinator.reconcile();
  trace('OPUS-R5-CLOCK-ABSENT', JSON.stringify({ fault, accepted: r.u.accepted, violations: r.u.violations, runs: report.runs.map((x) => ({ status: x.status, resumed: x.resumed, detections: x.detections.map((d) => d.breakClass), answers: x.answers.map((y) => [y.verdict, y.accepted]) })), resumed: report.resumed, paused: r.oms.paused }));
  if (fault === 'SOUND') { expect(r.u.accepted.length).toBe(2); expect(report.resumed).toBe(true); }
  else { expect(r.u.accepted.length).toBe(1); expect(report.resumed).toBe(false); }
});
