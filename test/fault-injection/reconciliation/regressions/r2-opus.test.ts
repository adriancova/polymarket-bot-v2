/**
 * WP-290 r6: a named regression, the verifiers' round-2 reproductions kept in the suite: Opus's round-2 probes.
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `opus-r2.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { expect, it } from 'vitest';
import { ready, submitOne, reconcileRounds, type Ready } from '../support/scenario.js';
import { boot, halted } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

const ev = (r: Ready) => r.p.journal.events() as Loose[];
const classOf = (r: Ready) => new Map(ev(r).filter((e) => e.kind === 'BREAK_OPENED').map((e) => [e.breakId, e.breakClass]));
function resolvedIn(r: Ready, runIds: string[]) {
  const cls = classOf(r);
  return ev(r).filter((e) => e.kind === 'BREAK_RESOLVED' && runIds.includes(e.runId)).map((e) => ({ cls: cls.get(e.breakId), resolution: e.resolution }));
}

it('P-A persistent work during every PASSED write: never resumes; OMS paused', async () => {
  const r = await ready();
  const append = r.p.journal.append.bind(r.p.journal);
  let fired = 0;
  r.p.journal.append = async (event: Loose) => {
    if (event.kind === 'RUN_COMPLETED' && event.status === 'PASSED') { fired += 1; r.p.coordinator.trigger('MARKET_STREAM_GAP'); }
    return append(event);
  };
  r.p.coordinator.trigger('PERIODIC_TIMER');
  const report = await r.p.coordinator.reconcile();
  const id = await submitOne(r.oms);
  trace('P-A', JSON.stringify({ fired, runs: report.runs.map((x) => [x.status, x.resumed, x.rerun]), paused: r.oms.paused, submitAccepted: id !== null, refused: ev(r).filter((e) => e.kind === 'RESUME_REFUSED').length }));
  expect(report.resumed).toBe(false);
  expect(r.oms.paused).toBe(true);
});

it('P-B wallet request during the PASSED write: that run does not resume', async () => {
  const r = await ready();
  const append = r.p.journal.append.bind(r.p.journal);
  let fired = false;
  r.p.journal.append = async (event: Loose) => {
    if (!fired && event.kind === 'RUN_COMPLETED' && event.status === 'PASSED') {
      fired = true;
      r.p.coordinator.walletRequester.request({ requestId: 'w-1', trigger: 'WALLET_OPERATION_UNKNOWN', walletOperationId: 'op-1', accountRef: 'paper-account-1', reason: 'x', transactionHashes: ['0xabc'], transactionIds: [], unresolvedTransactions: [] } as Loose);
    }
    return append(event);
  };
  r.p.coordinator.trigger('PERIODIC_TIMER');
  const report = await r.p.coordinator.reconcile();
  trace('P-B', JSON.stringify({ fired, runs: report.runs.map((x) => [x.status, x.resumed, x.rerun, x.reason]), paused: r.oms.paused }));
  expect(report.runs[0]?.resumed).toBe(false);
});

it('P-D an order-scoped HOLD break cleared NOT_REPRODUCED by a run that skipped the order (group token unknown)', async () => {
  const r = await ready();
  await submitOne(r.oms);
  r.u.world.match(r.u.world.receipts.at(-1)!, '1');
  expect(await reconcileRounds(r, 4)).toBe(true);
  r.u.world.faults.listTrades = () => ({ route: '/data/trades', complete: true, trades: [] });
  r.p.coordinator.trigger('PERIODIC_TIMER');
  await r.p.coordinator.reconcile();
  const unresolvedA = r.p.journal.unresolvedBreaks().map((b) => b.breakClass);
  r.u.seams.tokenOfGroup = () => null;
  r.p.coordinator.trigger('PERIODIC_TIMER');
  const b = await r.p.coordinator.reconcile();
  const runIdsB = b.runs.map((x) => x.runId as string);
  const resolvedB = resolvedIn(r, runIdsB);
  trace('P-D', JSON.stringify({ unresolvedA, runsB: b.runs.map((x) => [x.status, x.reason, x.detections.map((d) => d.breakClass)]), resolvedB, unresolvedAfterB: r.p.journal.unresolvedBreaks().map((v) => v.breakClass), tradesStillEmpty: true }));
  delete r.u.seams.tokenOfGroup;
  const c = await r.p.coordinator.reconcile();
  trace('P-D/after', JSON.stringify({ runsC: c.runs.map((x) => [x.status, x.resumed, x.detections.map((d) => d.breakClass)]) }));
  expect(c.resumed).toBe(false);
});

it('P-E an order-scoped HOLD break cleared NOT_REPRODUCED by a run that skipped the order (facts mismatch)', async () => {
  const r = await ready();
  await submitOne(r.oms);
  r.u.world.match(r.u.world.receipts.at(-1)!, '0.4');
  expect(await reconcileRounds(r, 4)).toBe(true);
  r.u.world.faults.listTrades = () => ({ route: '/data/trades', complete: true, trades: [] });
  r.p.coordinator.trigger('PERIODIC_TIMER');
  await r.p.coordinator.reconcile();
  const unresolvedA = r.p.journal.unresolvedBreaks().map((b) => b.breakClass);
  r.u.world.faults.listOpenOrders = (answer: Loose) => { const raw = answer(); return { ...raw, orders: raw.orders.map((o: Loose) => ({ ...o, price: '0.51' })) }; };
  r.p.coordinator.trigger('PERIODIC_TIMER');
  const b = await r.p.coordinator.reconcile();
  const resolvedB = resolvedIn(r, b.runs.map((x) => x.runId as string));
  trace('P-E', JSON.stringify({ unresolvedA, runsB: b.runs.map((x) => [x.status, x.detections.map((d) => d.breakClass)]), resolvedB }));
});

it('P-F a second halting alert of the same kind on the same order, after the first was released', async () => {
  const r = await ready();
  await submitOne(r.oms);
  const salt = r.u.world.receipts.at(-1)!;
  const t1 = r.u.world.match(salt, '0.4', { status: 'MINED' })!;
  const t2 = r.u.world.match(salt, '0.3', { status: 'MINED' })!;
  const warm = await reconcileRounds(r, 6);
  const settlementsWarm = r.u.store.snapshotSync().settlements.map((s: Loose) => [s.venueTradeId, s.state]);
  t1.status = 'FAILED';
  r.p.coordinator.trigger('PERIODIC_TIMER');
  const a = await r.p.coordinator.reconcile();
  const alertBreak = r.p.journal.unresolvedBreaks().find((v) => v.breakClass === 'OMS_HALTING_ALERT');
  const rel = alertBreak ? await r.p.coordinator.releaseQuarantine({ breakId: alertBreak.breakId, operatorRef: 'op', reason: 'reversal booked' }) : null;
  const afterRelease = await reconcileRounds(r, 4);
  const haltsBefore = halted(r.p).length;
  t2.status = 'FAILED';
  r.p.coordinator.trigger('PERIODIC_TIMER');
  const b = await r.p.coordinator.reconcile();
  trace('P-F', JSON.stringify({
    warm, settlementsWarm,
    runA: a.runs.map((x) => [x.status, x.resumed, x.detections.map((d) => d.breakClass)]),
    released: rel?.ok ?? null, afterRelease,
    runB: b.runs.map((x) => [x.status, x.resumed, x.detections.map((d) => d.breakClass)]),
    alerts: r.oms.alerts().map((x) => [x.kind, x.haltMarket, x.detail]),
    settlements: r.u.store.snapshotSync().settlements.map((s: Loose) => [s.venueTradeId, s.state]),
    newHalts: halted(r.p).length - haltsBefore, paused: r.oms.paused,
  }));
});

it('P-G probe writes settlements from a read set found unsound (regression on another order)', async () => {
  const r = await ready();
  await submitOne(r.oms);
  const sA = r.u.world.receipts.at(-1)!;
  await submitOne(r.oms);
  const sB = r.u.world.receipts.at(-1)!;
  const tA = r.u.world.match(sA, '0.4', { status: 'CONFIRMED' })!;
  const tB = r.u.world.match(sB, '0.4', { status: 'MATCHED' })!;
  expect(await reconcileRounds(r, 6)).toBe(true);
  const before = r.u.store.snapshotSync().settlements.map((s: Loose) => [s.venueTradeId, s.state]);
  tA.status = 'MATCHED';
  tB.status = 'CONFIRMED';
  const p = await boot(r.u);
  const again = { u: r.u, p, oms: p.oms as Loose } as Ready;
  const rep = await again.p.coordinator.reconcile();
  trace('P-G', JSON.stringify({ tA: tA.venueTradeId, tB: tB.venueTradeId, before, runs: rep.runs.map((x) => [x.status, x.resumed, x.detections.map((d) => d.breakClass)]), after: r.u.store.snapshotSync().settlements.map((s: Loose) => [s.venueTradeId, s.state]) }));
});
