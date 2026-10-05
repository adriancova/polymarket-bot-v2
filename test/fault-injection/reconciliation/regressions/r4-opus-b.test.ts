/**
 * WP-290 r6: a named regression, the verifiers' round-4 reproductions kept in the suite: Opus's round-4 probes (BYID-SOURCE).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `r4-opus-b.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { expect, it } from 'vitest';
import { ready, submitOne, reconcileRounds, type Ready } from '../support/scenario.js';
import { boot } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

// The stream reports FAILED first; the process dies before any run journaled the alert; after the restart the REST
// trades read still lags (MINED). Then the REST read catches up.
it('V4-A1-STREAM-LAG stream FAILED, crash, REST lags at MINED after restart: never resumes; quarantine once REST shows FAILED', async () => {
  const r = await ready(); await submitOne(r.oms);
  const t = r.u.world.match(r.u.world.receipts.at(-1)!, '0.4', { status: 'MINED' })!;
  expect(await reconcileRounds(r, 6)).toBe(true);
  // Deliver straight to the OMS (as WP-280's projection would), no coordinator run afterwards: the alert lives only in memory.
  const out = await r.oms.applySettlement({ venueTradeId: t.venueTradeId, venueOrderId: t.venueOrderId, status: 'FAILED', transactionHash: t.transactionHash, observedAt: '2026-10-03T00:00:01Z' });
  const stored = r.u.store.snapshotSync().settlements.map((s: Loose) => s.state);
  r.p.inc.alive = false;
  const p = await boot(r.u);
  const again = { u: r.u, p, oms: p.oms as Loose } as Ready;
  const lagging = await reconcileRounds(again, 3);
  const lagClasses = p.journal.unresolvedBreaks().map((v) => [v.breakClass, v.status]);
  t.status = 'FAILED';
  p.coordinator.trigger('PERIODIC_TIMER');
  const caught = await reconcileRounds(again, 3);
  const sf = p.journal.unresolvedBreaks().filter((v) => v.breakClass === 'SETTLEMENT_FAILED');
  trace('V4-A1-STREAM-LAG', JSON.stringify({ applied: (out as Loose).ok, stored, lagging, lagClasses, caught, sf: sf.map((v) => [v.status, v.marketId]), unresolved: p.journal.unresolvedBreaks().map((v) => [v.breakClass, v.status]), violations: [...r.u.violations, ...r.u.world.violations] }));
  expect(lagging).toBe(false);
  expect(caught).toBe(false);
  expect(sf.length).toBe(1);
});
