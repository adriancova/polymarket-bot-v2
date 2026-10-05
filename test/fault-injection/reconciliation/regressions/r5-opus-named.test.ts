/**
 * WP-290 r6: a named regression, the verifiers' round-5 reproductions kept in the suite: Opus's round-5 named probe (R5-NAMED).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `r5-named.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { expect, it } from 'vitest';
import { ready, submitOne, sequence, type Ready } from '../support/scenario.js';
import { trace, type Loose } from "../support/loose.js";

function unresolved(r: Ready) { return r.p.journal.unresolvedBreaks().map((v) => [v.breakClass, v.status, v.subjectKey]); }

async function setup(firstRun: 'INCOMPLETE' | 'DUPLICATE' | 'COMPLETE') {
  const r = await ready();
  r.u.world.nextTransmission = sequence(['UNKNOWN_EXISTS']);
  const attempt = (await submitOne(r.oms)) as string;
  const salt = r.u.world.receipts.at(-1)!;
  const x = r.u.world.orders.get(salt)!.venueOrderId;
  if (firstRun === 'INCOMPLETE') r.u.world.faults.listOpenOrders = (answer) => ({ ...(answer() as object), complete: false });
  if (firstRun === 'DUPLICATE') r.u.world.faults.listOpenOrders = (answer) => { const a = answer() as Loose; return { ...a, orders: [...a.orders, a.orders[0]] }; };
  if (firstRun === 'COMPLETE') r.u.world.faults.readOrder = (id, answer) => { if (id === x) throw new Error('timeout'); return answer(); };
  if (firstRun === 'COMPLETE') r.u.world.faults.listTrades = () => { throw new Error('timeout'); };
  const run1 = await r.p.coordinator.reconcile();
  const after1 = unresolved(r);
  // From now on, two reads disagree with run 1's valid row: the list no longer shows x, and its by-id read does not find it.
  r.u.world.faults = {
    listOpenOrders: (answer) => { const a = answer() as Loose; return { ...a, orders: a.orders.filter((o: Loose) => o.venueOrderId !== x) }; },
    readOrder: (id, answer) => (id === x ? { route: '/data/order', found: false } : answer()),
  };
  return { r, attempt, x, run1, after1 };
}

for (const variant of ['INCOMPLETE', 'DUPLICATE', 'COMPLETE'] as const) {
  it('P5-NAMED-ABSENT ' + variant + ': a fully valid row of x (the attempt order) then x not found by id: is ABSENT answered?', async () => {
    const { r, attempt, x, run1, after1 } = await setup(variant);
    const reports = [];
    for (let i = 0; i < 4; i += 1) { reports.push(await r.p.coordinator.reconcile()); r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1; }
    const answers = r.u.accepted.filter((a) => a.attemptId === attempt);
    trace('P5-NAMED-ABSENT', variant, JSON.stringify({
      x,
      run1: run1.runs.map((v) => [v.status, v.detections.map((d) => d.breakClass)]),
      after1,
      runs: reports.flatMap((rep) => rep.runs.map((v) => [v.status, v.resumed, v.detections.map((d) => d.breakClass), v.answers.map((a) => [a.verdict, a.accepted])])),
      answers,
      unresolved: unresolved(r),
      paused: r.oms.paused,
      venueHasX: [...r.u.world.orders.values()].some((o) => o.venueOrderId === x && o.status === 'LIVE'),
      violations: [...r.u.violations, ...r.u.world.violations],
    }));
    expect(answers.filter((a) => a.verdict === 'ABSENT')).toEqual([]);
  });
}
