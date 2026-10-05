/**
 * WP-290 r6: a named regression, the verifiers' round-5 reproductions kept in the suite: Opus's round-5 leg probe (R5-NAMED).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `r5-leg.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { expect, it } from 'vitest';
import { ready, submitOne, sequence, type Ready } from '../support/scenario.js';
import { boot, YES } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

for (const firstRun of ['INCOMPLETE-trades', 'COMPLETE-trades-ctl'] as const) {
  it('P5-LEG ' + firstRun + ': the attempt order x, fully matched, shown by a valid leg; later every read lags and x is not found by id', async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(['UNKNOWN_EXISTS']);
    const attempt = (await submitOne(r.oms)) as string;
    const salt = r.u.world.receipts.at(-1) as string;
    const before = r.u.world.collateral;
    const trade = r.u.world.match(salt, '1')!;
    const x = trade.venueOrderId;
    if (firstRun === 'INCOMPLETE-trades') r.u.world.faults.listTrades = (answer) => ({ ...(answer() as object), complete: false });
    else r.u.world.faults.readOrder = (id, answer) => { if (id === x) throw new Error('timeout'); return answer(); };
    const run1 = await r.p.coordinator.reconcile();
    const p = await boot(r.u); const again: Ready = { u: r.u, p, oms: p.oms as Loose };
    r.u.world.faults = {
      listTrades: (answer) => { const a = answer() as Loose; return { ...a, trades: a.trades.filter((e: Loose) => e.venueTradeId !== trade.venueTradeId) }; },
      readPositions: (answer) => { const a = answer() as Loose; return { ...a, positions: a.positions.filter((q: Loose) => q.tokenId !== YES) }; },
      readCollateral: (answer) => ({ ...(answer() as object), balance: before }),
      readOrder: (id, answer) => (id === x ? { route: '/data/order', found: false } : answer()),
    };
    const reports = [];
    for (let i = 0; i < 5; i += 1) { reports.push(await again.p.coordinator.reconcile()); r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1; }
    const answers = r.u.accepted.filter((a) => a.attemptId === attempt);
    trace('P5-LEG', firstRun, JSON.stringify({ x, run1: run1.runs.map((v) => [v.status, v.detections.map((d) => d.breakClass + ':' + d.subjectKey)]),
      runs: reports.flatMap((rep) => rep.runs.map((v) => [v.status, v.resumed, v.detections.map((d) => d.breakClass), v.answers.map((a) => [a.verdict, a.accepted])])),
      answers, violations: [...r.u.violations, ...r.u.world.violations] }));
    expect(answers.filter((a) => a.verdict === 'ABSENT')).toEqual([]);
  });
}
