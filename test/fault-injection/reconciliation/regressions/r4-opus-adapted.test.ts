/**
 * WP-290 r6: a named regression, the verifiers' round-4 reproductions kept in the suite: Opus's round-4 probes, as adapted (agreed in rounds 4 to 6).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `r4-opus.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { expect, it } from 'vitest';
import { ready, submitOne, reconcileRounds, sequence, type Ready } from '../support/scenario.js';
import { boot, bookReversal, halted } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

async function releaseAll(r: Ready) {
  for (const v of r.p.journal.unresolvedBreaks()) {
    if (v.status !== 'QUARANTINED') continue;
    const x = await r.p.coordinator.releaseQuarantine({ breakId: v.breakId, operatorRef: 'op', reason: 'handled' });
    expect(x.ok).toBe(true);
  }
}

// X-PF adapted to r3's two-quarantines-per-FAILED: release BOTH for trade-1, then trade-2 FAILS.
it('V4-XPF second FAILED trade on the same order after every quarantine of the first was released: must not resume', async () => {
  const r = await ready();
  await submitOne(r.oms);
  const salt = r.u.world.receipts.at(-1)!;
  const t1 = r.u.world.match(salt, '0.4', { status: 'MINED' })!;
  const t2 = r.u.world.match(salt, '0.3', { status: 'MINED' })!;
  expect(await reconcileRounds(r, 6)).toBe(true);
  r.u.world.failTrade(t1);
  r.p.coordinator.trigger('PERIODIC_TIMER');
  const a = await r.p.coordinator.reconcile();
  const firstClasses = r.p.journal.unresolvedBreaks().map((v) => v.breakClass).sort();
  // release only the alert: still held by the trade's own break
  const alertB = r.p.journal.unresolvedBreaks().find((v) => v.breakClass === 'OMS_HALTING_ALERT')!;
  await r.p.coordinator.releaseQuarantine({ breakId: alertB.breakId, operatorRef: 'op', reason: 'x' });
  const afterAlertOnly = await reconcileRounds(r, 2);
  await releaseAll(r);
  bookReversal(r.u, t1.venueTradeId, t1.venueOrderId);
  expect(await reconcileRounds(r, 4)).toBe(true);
  const haltsBefore = halted(r.p).length;
  r.u.world.failTrade(t2);
  r.p.coordinator.trigger('PERIODIC_TIMER');
  const b = await r.p.coordinator.reconcile();
  const sf = r.p.journal.unresolvedBreaks().filter((v) => v.breakClass === 'SETTLEMENT_FAILED');
  trace('V4-XPF', JSON.stringify({ runA: a.runs.map((x) => [x.status, x.resumed]), firstClasses, afterAlertOnly, runB: b.runs.map((x) => [x.status, x.resumed, x.detections.map((d) => d.breakClass)]), sf: sf.map((v) => [v.subjectKey, v.status, v.marketId]), newHalts: halted(r.p).length - haltsBefore, paused: r.oms.paused, violations: [...r.u.violations, ...r.u.world.violations] }));
  expect(afterAlertOnly).toBe(false);
  expect(b.resumed).toBe(false);
  expect(sf.length).toBe(1);
  expect(sf[0]!.subjectKey).toContain(t2.venueTradeId);
  expect(halted(r.p).length - haltsBefore).toBeGreaterThan(0);
});

// After a restart, a released FAILED trade is acknowledged, a NEW FAILED trade on the same order is not.
it('V4-A1-RESTART trade-1 FAILED and released; restart; trade-2 FAILS: its own quarantine, never resumed', async () => {
  const r = await ready();
  await submitOne(r.oms);
  const salt = r.u.world.receipts.at(-1)!;
  const t1 = r.u.world.match(salt, '0.4', { status: 'MINED' })!;
  const t2 = r.u.world.match(salt, '0.3', { status: 'MINED' })!;
  expect(await reconcileRounds(r, 6)).toBe(true);
  r.u.world.failTrade(t1);
  r.p.coordinator.trigger('PERIODIC_TIMER');
  await r.p.coordinator.reconcile();
  await releaseAll(r);
  bookReversal(r.u, t1.venueTradeId, t1.venueOrderId);
  expect(await reconcileRounds(r, 4)).toBe(true);
  const p = await boot(r.u);
  const again = { u: r.u, p, oms: p.oms as Loose } as Ready;
  const s = await p.coordinator.reconcile();
  const startupResumed = s.resumed;
  r.u.world.failTrade(t2);
  p.coordinator.trigger('PERIODIC_TIMER');
  const b = await reconcileRounds(again, 3);
  const sf = p.journal.unresolvedBreaks().filter((v) => v.breakClass === 'SETTLEMENT_FAILED');
  trace('V4-A1-RESTART', JSON.stringify({ startupResumed, resumedAfterT2: b, sf: sf.map((v) => [v.subjectKey, v.status]), unresolved: p.journal.unresolvedBreaks().map((v) => v.breakClass), violations: [...r.u.violations, ...r.u.world.violations] }));
  expect(startupResumed).toBe(true);
  expect(b).toBe(false);
  expect(sf.map((v) => v.subjectKey).join()).toContain(t2.venueTradeId);
  expect(sf.map((v) => v.subjectKey).join()).not.toContain(t1.venueTradeId + ';');
});

// Crash after the OMS durably recorded FAILED; on restart, the trades read FAILS for two runs, then recovers.
it('V4-A1-UNSOUND crash after durable FAILED; restart with the trades read failing: never resumes; quarantine opens once readable', async () => {
  const r = await ready(); await submitOne(r.oms);
  const t = r.u.world.match(r.u.world.receipts.at(-1)!, '0.4', { status: 'MINED' })!;
  expect(await reconcileRounds(r, 6)).toBe(true);
  t.status = 'FAILED';
  const apply = r.u.store.apply.bind(r.u.store);
  r.u.store.apply = async (writes: Loose) => {
    const result = await apply(writes);
    if (writes.some((w: Loose) => w.kind === 'APPEND_SETTLEMENT' && w.settlement.state === 'FAILED')) { r.p.inc.alive = false; throw new Error('crash'); }
    return result;
  };
  try { await r.p.coordinator.reconcile(); } catch { /* a killed process: expected */ }
  r.u.store.apply = apply;
  const p = await boot(r.u);
  const again = { u: r.u, p, oms: p.oms as Loose } as Ready;
  r.u.world.faults.listTrades = () => { throw new Error('timeout'); };
  const early = await reconcileRounds(again, 2);
  r.u.world.faults = {};
  const later = await reconcileRounds(again, 3);
  const sf = p.journal.unresolvedBreaks().filter((v) => v.breakClass === 'SETTLEMENT_FAILED');
  trace('V4-A1-UNSOUND', JSON.stringify({ early, later, sf: sf.map((v) => [v.status, v.marketId]), halts: halted(p).filter((h) => h.breakId === sf[0]?.breakId).length }));
  expect(early).toBe(false); expect(later).toBe(false);
  expect(sf.length).toBe(1); expect(sf[0]!.status).toBe('QUARANTINED');
});

// A BALANCE booking: the booking's break subject equals the recovery's (no second quarantine), release -> resumes; across a restart too.
it('V4-A3-BALANCE collateral booking subject agrees with recovery (no extra LEDGER_UNATTRIBUTED_ARRIVAL), across a restart', async () => {
  const r = await ready();
  r.u.world.adjustCollateral('25');
  r.p.coordinator.trigger('PERIODIC_TIMER');
  await r.p.coordinator.reconcile();
  r.u.clock.t += r.u.policy.holdingConfirmationMs;
  r.p.coordinator.trigger('PERIODIC_TIMER');
  await r.p.coordinator.reconcile();
  await r.p.coordinator.reconcile();
  const p = await boot(r.u);
  await p.coordinator.reconcile();
  const classes = p.journal.unresolvedBreaks().map((v) => v.breakClass);
  trace('V4-A3-BALANCE', JSON.stringify({ classes, opened: (p.journal.events() as Loose[]).filter((e) => e.kind === 'BREAK_OPENED').map((e) => e.breakClass) }));
  expect(classes).toEqual(['BALANCE_UNATTRIBUTED']);
  const again = { u: r.u, p, oms: p.oms as Loose } as Ready;
  for (const v of p.journal.unresolvedBreaks()) await p.coordinator.releaseQuarantine({ breakId: v.breakId, operatorRef: 'op', reason: 'x' });
  expect(await reconcileRounds(again, 3)).toBe(true);
});

// Ghost id: the stream names a venue order the venue does not have; the OMS retains it; one unsound run watches it.
it('V4-O1-GHOST a retained venue id the venue never had, seen by-id (not found) in an unsound run: is it watched forever?', async () => {
  const r = await ready();
  r.u.world.nextTransmission = sequence(['UNKNOWN_ABSENT']);
  await submitOne(r.oms);
  r.p.coordinator.onUserStreamOutput({ kind: 'TRADE', oms: { fills: [{ venueTradeId: 'ghost-trade', venueOrderId: 'venue-ghost', shares: '0.1', price: '0.5', liquidityRole: 'MAKER', feeAmount: '0', feeAssetId: null, matchedAt: '2026-10-03T00:00:00Z' }], settlements: [], shortfalls: [] } });
  await r.p.coordinator.settled();
  const retained = r.oms.retainedEvidence().map((i) => i.venueOrderId);
  r.u.world.faults.listTrades = () => { throw new Error('timeout'); };
  const run1 = await r.p.coordinator.reconcile();
  r.u.world.faults = {};
  const reports: Loose[] = [];
  for (let i = 0; i < 6; i += 1) { r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1; const rep = await r.p.coordinator.reconcile(); reports.push(rep.runs.map((x) => [x.status, x.resumed, x.detections.map((d) => d.breakClass)])); }
  trace('V4-O1-GHOST', JSON.stringify({ retained, run1: run1.runs.map((x) => x.detections.map((d) => [d.breakClass, d.subjectKey])), reports: reports.slice(-2), accepted: r.u.accepted, retainedAfter: r.oms.retainedEvidence().length, alerts: r.oms.alerts().map((a) => a.kind), unresolved: r.p.journal.unresolvedBreaks().map((v) => [v.breakClass, v.subjectKey, v.status]) }));
});
// Control: the same without the unsound run.
it('V4-O1-GHOST-ctl the same without the unsound run', async () => {
  const r = await ready();
  r.u.world.nextTransmission = sequence(['UNKNOWN_ABSENT']);
  await submitOne(r.oms);
  r.p.coordinator.onUserStreamOutput({ kind: 'TRADE', oms: { fills: [{ venueTradeId: 'ghost-trade', venueOrderId: 'venue-ghost', shares: '0.1', price: '0.5', liquidityRole: 'MAKER', feeAmount: '0', feeAssetId: null, matchedAt: '2026-10-03T00:00:00Z' }], settlements: [], shortfalls: [] } });
  await r.p.coordinator.settled();
  const reports: Loose[] = [];
  for (let i = 0; i < 6; i += 1) { r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1; const rep = await r.p.coordinator.reconcile(); reports.push(rep.runs.map((x) => [x.status, x.resumed, x.detections.map((d) => d.breakClass)])); }
  trace('V4-O1-GHOST-ctl', JSON.stringify({ reports: reports.slice(-2), accepted: r.u.accepted, retainedAfter: r.oms.retainedEvidence().length, alerts: r.oms.alerts().map((a) => a.kind), unresolved: r.p.journal.unresolvedBreaks().map((v) => [v.breakClass, v.subjectKey, v.status]) }));
});

// A FAILED trade the OMS never recorded as a fill (reported FAILED straight away): quarantined (conservative)?
it('V4-A1-NEVER-FILLED a trade first seen FAILED (the OMS never booked it): observed handling', async () => {
  const r = await ready(); await submitOne(r.oms);
  r.u.world.match(r.u.world.receipts.at(-1)!, '0.4', { status: 'FAILED' });
  r.p.coordinator.trigger('PERIODIC_TIMER');
  const rounds = await reconcileRounds(r, 3);
  trace('V4-A1-NEVER-FILLED', JSON.stringify({ rounds, fills: r.u.store.snapshotSync().fills.length, unresolved: r.p.journal.unresolvedBreaks().map((v) => [v.breakClass, v.status]) }));
});
