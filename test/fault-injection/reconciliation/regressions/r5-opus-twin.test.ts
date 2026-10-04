/**
 * WP-290 r6: a named regression, the verifiers' round-5 reproductions kept in the suite: Opus's round-5 twin probe (R5-NAMED).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `r5-twin.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { expect, it } from 'vitest';
import { ready, submitOne, sequence, type Ready } from '../support/scenario.js';
import { boot, YES } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

function unresolved(r: Ready) { return r.p.journal.unresolvedBreaks().map((v) => [v.breakClass, v.status, v.subjectKey]); }

for (const variant of ['INCOMPLETE', 'COMPLETE-ctl'] as const) {
  for (const restart of [false, true]) {
    it('P5-TWIN ' + variant + (restart ? ' +restart' : '') + ': two candidates in run 1; the real one then not found by id, the twin canceled: PRESENT on the twin?', async () => {
      const r0 = await ready();
      r0.u.world.nextTransmission = sequence(['UNKNOWN_EXISTS']);
      const attempt = (await submitOne(r0.oms)) as string;
      const real = r0.u.world.orders.get(r0.u.world.receipts.at(-1)!)!.venueOrderId;
      const twin = r0.u.world.placeForeign({ tokenId: YES, side: 'BUY', price: '0.5', size: '1' }).venueOrderId;
      if (variant === 'INCOMPLETE') r0.u.world.faults.listOpenOrders = (answer) => ({ ...(answer() as object), complete: false });
      else r0.u.world.faults.listTrades = () => { throw new Error('timeout'); };
      const run1 = await r0.p.coordinator.reconcile();
      let r = r0;
      if (restart) { const p = await boot(r0.u); r = { u: r0.u, p, oms: p.oms as Loose }; }
      r.u.world.cancel(twin);
      r.u.world.faults = {
        listOpenOrders: (answer) => { const a = answer() as Loose; return { ...a, orders: a.orders.filter((o: Loose) => o.venueOrderId !== real) }; },
        readOrder: (id, answer) => (id === real ? { route: '/data/order', found: false } : answer()),
      };
      const reports = [];
      for (let i = 0; i < 4; i += 1) { reports.push(await r.p.coordinator.reconcile()); r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1; }
      const answers = r.u.accepted.filter((a) => a.attemptId === attempt);
      trace('P5-TWIN', variant, restart, JSON.stringify({ real, twin,
        run1: run1.runs.map((v) => [v.status, v.detections.map((d) => d.breakClass)]),
        runs: reports.flatMap((rep) => rep.runs.map((v) => [v.status, v.resumed, v.detections.map((d) => d.breakClass), v.answers.map((a) => [a.verdict, a.accepted])])),
        answers, unresolved: unresolved(r), paused: r.oms.paused, violations: [...r.u.violations, ...r.u.world.violations] }));
      expect(answers).toEqual([]);
    });
  }
}
