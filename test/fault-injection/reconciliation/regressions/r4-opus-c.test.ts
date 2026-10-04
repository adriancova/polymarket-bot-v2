/**
 * WP-290 r6: a named regression, the verifiers' round-4 reproductions kept in the suite: Opus's round-4 probes (GHOST).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `r4-opus-c.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { expect, it } from 'vitest';
import { ready, submitOne, reconcileRounds, sequence, type Ready } from '../support/scenario.js';
import { boot } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

it('V4-O1-GHOST-RESTART the ghost id, then a restart: still stalled? (no release exists for a hold)', async () => {
  const r = await ready();
  r.u.world.nextTransmission = sequence(['UNKNOWN_ABSENT']);
  await submitOne(r.oms);
  r.p.coordinator.onUserStreamOutput({ kind: 'TRADE', oms: { fills: [{ venueTradeId: 'ghost-trade', venueOrderId: 'venue-ghost', shares: '0.1', price: '0.5', liquidityRole: 'MAKER', feeAmount: '0', feeAssetId: null, matchedAt: '2026-10-03T00:00:00Z' }], settlements: [], shortfalls: [] } });
  await r.p.coordinator.settled();
  r.u.world.faults.listTrades = () => { throw new Error('timeout'); };
  await r.p.coordinator.reconcile();
  r.u.world.faults = {};
  r.p.inc.alive = false;
  const p = await boot(r.u);
  const again = { u: r.u, p, oms: p.oms as Loose } as Ready;
  const resumed = await reconcileRounds(again, 8);
  const unresolved = p.journal.unresolvedBreaks().map((v) => [v.breakClass, v.subjectKey, v.status]);
  const releasable = p.journal.unresolvedBreaks().filter((v) => v.status === 'QUARANTINED').length;
  const conflict = p.journal.unresolvedBreaks().find((v) => v.breakClass === 'READ_CONFLICT');
  trace('V4-O1-GHOST-RESTART', JSON.stringify({ resumed, retainedAfterRestart: p.oms!.retainedEvidence().length, unresolved, releasable, conflictDetail: conflict?.detail, accepted: r.u.accepted }));
  expect(resumed).toBe(false);
});
