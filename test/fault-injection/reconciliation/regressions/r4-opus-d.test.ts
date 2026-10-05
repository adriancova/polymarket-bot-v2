/**
 * WP-290 r6: a named regression, the verifiers' round-4 reproductions kept in the suite: Opus's round-4 probes (GHOST, restart).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `r4-opus-d.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { expect, it } from 'vitest';
import { ready, submitOne, reconcileRounds, sequence, type Ready } from '../support/scenario.js';
import { boot, streamTrade, YES } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

// An order seen ONLY by id (the OMS retains the stream's fill for it), in an unsound run; then a restart (the
// retained evidence is gone); every other read lags. Only the durable ORDER_UNRESOLVED from the by-id source names it.
it('V4-O1-BYID-ONLY a retained-only order seen by id in an unsound run, then a restart: PRESENT, never ABSENT', async () => {
  const r = await ready();
  r.u.world.nextTransmission = sequence(['UNKNOWN_EXISTS']);
  const attempt = await submitOne(r.oms);
  const salt = r.u.world.receipts.at(-1)!;
  const collateralBefore = r.u.world.collateral;
  const trade = r.u.world.match(salt, '1')!; // fully matched: not in the open-orders list
  r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade.venueTradeId));
  await r.p.coordinator.settled();
  const retained = r.oms.retainedEvidence().map((i) => i.venueOrderId);
  const lag = () => {
    r.u.world.faults.listTrades = (answer) => { const a = answer() as Loose; return { ...a, trades: a.trades.filter((t: Loose) => t.venueTradeId !== trade.venueTradeId) }; };
    r.u.world.faults.readPositions = (answer) => { const a = answer() as Loose; return { ...a, positions: a.positions.filter((p: Loose) => p.tokenId !== YES) }; };
    r.u.world.faults.readCollateral = (answer) => ({ ...(answer() as object), balance: collateralBefore });
  };
  r.u.world.faults = {};
  lag();
  r.u.world.faults.listTrades = () => { throw new Error('timeout'); };
  const run1 = await r.p.coordinator.reconcile();
  r.p.inc.alive = false;
  const p = await boot(r.u);
  const again = { u: r.u, p, oms: p.oms as Loose } as Ready;
  const reads: string[] = [];
  r.u.world.faults = { readOrder: (id, answer) => { reads.push(id); return answer(); } };
  lag();
  const resumed = await reconcileRounds(again, 5);
  trace('V4-O1-BYID-ONLY', JSON.stringify({ retained, run1: run1.runs.map((x) => x.detections.map((d) => d.breakClass)), resumed, reads, accepted: r.u.accepted, violations: [...r.u.violations, ...r.u.world.violations] }));
  expect(r.u.accepted.filter((a) => a.attemptId === attempt).map((a) => a.verdict)).not.toContain('ABSENT');
  expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
});
