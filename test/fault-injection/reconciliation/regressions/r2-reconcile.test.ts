/**
 * WP-290 r6: a named regression, the verifiers' round-2 reproductions kept in the suite: the round-2 reconciliation probes (X-*).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `reconcile-r2.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 * - dropped "X-PF second SETTLEMENT_FAILED on the same order after the first was released: must not resume": its setup releases a hold no operator can release (agreed in rounds 4 to 6); its adapted version is V4-XPF in r4-opus-adapted.test.ts.
 * - X-N2: adapted in r6 (class A): the replaced trade id is held as a READ_CONFLICT (evidence), where it was a
 *   FILL_MISMATCH; the assertion (a run with the group's token unknown does not clear it) is unchanged.
 */

import { expect, it } from 'vitest';
import { ready, submitOne, reconcileRounds, type Ready } from '../support/scenario.js';
import { boot } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

const ev = (r: Ready) => r.p.journal.events() as Loose[];

// ---- astra R2-N1, reproduced by Opus (DIVIDED item D-A1) ----
it('X-N1 (astra R2-N1) listed MYSTERY status, by-id LIVE: must not resume', async () => {
  const r = await ready();
  r.u.world.nextTransmission = () => 'UNKNOWN_EXISTS';
  await submitOne(r.oms);
  r.u.world.faults.listOpenOrders = (answer: Loose) => { const a = answer() as Loose; return { ...a, orders: a.orders.map((o: Loose) => ({ ...o, status: 'MYSTERY' })) }; };
  const report = await r.p.coordinator.reconcile();
  trace('X-N1', JSON.stringify({ runs: report.runs.map((x) => [x.status, x.resumed, x.detections.map((d) => d.breakClass), x.answers.map((a) => [a.verdict, a.accepted])]), accepted: r.u.accepted, paused: r.oms.paused }));
  expect(report.resumed).toBe(false);
});
it('X-N1-ctl the same order with the listed status left alone resumes (control)', async () => {
  const r = await ready();
  r.u.world.nextTransmission = () => 'UNKNOWN_EXISTS';
  await submitOne(r.oms);
  const report = await r.p.coordinator.reconcile();
  trace('X-N1-ctl', JSON.stringify({ resumed: report.resumed, accepted: r.u.accepted.map((a: Loose) => a.verdict) }));
  expect(report.resumed).toBe(true);
});
it('X-N1-both MYSTERY in both reads: held (proves the vocabulary check works when not erased)', async () => {
  const r = await ready();
  r.u.world.nextTransmission = () => 'UNKNOWN_EXISTS';
  await submitOne(r.oms);
  r.u.world.faults.listOpenOrders = (answer: Loose) => { const a = answer() as Loose; return { ...a, orders: a.orders.map((o: Loose) => ({ ...o, status: 'MYSTERY' })) }; };
  r.u.world.faults.readOrder = (answer: Loose) => { const a = answer() as Loose; return a && a.order ? { ...a, order: { ...a.order, status: 'MYSTERY' } } : a; };
  const report = await r.p.coordinator.reconcile();
  trace('X-N1-both', JSON.stringify({ runs: report.runs.map((x) => [x.status, x.resumed, x.detections.map((d) => d.breakClass)]), accepted: r.u.accepted }));
});
it('X-N1-lifecycle listed CANCELED, by-id LIVE (status regression between two reads of one run)', async () => {
  const r = await ready();
  r.u.world.nextTransmission = () => 'UNKNOWN_EXISTS';
  await submitOne(r.oms);
  r.u.world.faults.listOpenOrders = (answer: Loose) => { const a = answer() as Loose; return { ...a, orders: a.orders.map((o: Loose) => ({ ...o, status: 'CANCELED' })) }; };
  const report = await r.p.coordinator.reconcile();
  trace('X-N1-lifecycle', JSON.stringify({ runs: report.runs.map((x) => [x.status, x.resumed, x.detections.map((d) => d.breakClass), x.answers.map((a) => [a.verdict, a.accepted])]), accepted: r.u.accepted, paused: r.oms.paused }));
});

// ---- astra R2-N2 / N2b = Opus P-D / P-E (DIVIDED item D-O2, severity only) ----
it('X-N2 (astra R2-N2) FILL_MISMATCH resolved NOT_REPRODUCED by a run with the group token unknown', async () => {
  const r = await ready(); await submitOne(r.oms); r.u.world.match(r.u.world.receipts.at(-1)!, '0.4'); expect(await reconcileRounds(r, 4)).toBe(true);
  r.u.world.faults.listTrades = (answer: Loose) => { const a = answer() as Loose; return { ...a, trades: a.trades.map((t: Loose) => ({ ...t, venueTradeId: 'replacement-id' })) }; };
  await r.p.coordinator.reconcile();
  const b = r.p.journal.unresolvedBreaks().find((v) => v.breakClass === 'READ_CONFLICT')!; expect(b).toBeDefined();
  r.u.seams.tokenOfGroup = () => null;
  const report = await r.p.coordinator.reconcile();
  const after = r.p.journal.breaks().find((x) => x.breakId === b.breakId)!;
  trace('X-N2', JSON.stringify({ runs: report.runs.map((x) => [x.status, x.resumed, x.detections.map((d) => d.breakClass)]), status: after.status, resolution: after.resolution, resolvedBy: after.resolvedByRunId, mismatchStillInRead: true }));
  expect(after.status).toBe('OPEN');
});

// ---- Opus P-F (DIVIDED item D-O1) ----
it('X-PF-same-run two SETTLEMENT_FAILED alerts in one run collapse into one break', async () => {
  const r = await ready();
  await submitOne(r.oms);
  const salt = r.u.world.receipts.at(-1)!;
  const t1 = r.u.world.match(salt, '0.4', { status: 'MINED' })!;
  const t2 = r.u.world.match(salt, '0.3', { status: 'MINED' })!;
  expect(await reconcileRounds(r, 6)).toBe(true);
  t1.status = 'FAILED'; t2.status = 'FAILED';
  r.p.coordinator.trigger('PERIODIC_TIMER');
  await r.p.coordinator.reconcile();
  const opened = ev(r).filter((e) => e.kind === 'BREAK_OPENED' && e.breakClass === 'OMS_HALTING_ALERT');
  trace('X-PF-same-run', JSON.stringify({ alerts: r.oms.alerts().filter((x) => x.haltMarket).length, breaksOpened: opened.length, detail: opened.map((e) => e.detail) }));
  expect(opened.length).toBe(r.oms.alerts().filter((x) => x.haltMarket).length);
});

// ---- Opus P-G (DIVIDED item D-O3) ----
it('X-PG settlement written into the OMS from a run whose order reads are unsound', async () => {
  const r = await ready();
  await submitOne(r.oms); const sA = r.u.world.receipts.at(-1)!;
  await submitOne(r.oms); const sB = r.u.world.receipts.at(-1)!;
  const tA = r.u.world.match(sA, '0.4', { status: 'CONFIRMED' })!;
  const tB = r.u.world.match(sB, '0.4', { status: 'MATCHED' })!;
  expect(await reconcileRounds(r, 6)).toBe(true);
  tA.status = 'MATCHED'; tB.status = 'CONFIRMED';
  const p = await boot(r.u);
  const again = { u: r.u, p, oms: p.oms as Loose } as Ready;
  const rep = await again.p.coordinator.reconcile();
  const after = r.u.store.snapshotSync().settlements.map((s: Loose) => [s.venueTradeId, s.state]);
  trace('X-PG', JSON.stringify({ runs: rep.runs.map((x) => [x.status, x.resumed, x.detections.map((d) => d.breakClass)]), after }));
});
