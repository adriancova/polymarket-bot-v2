/**
 * WP-290 r6: a named regression, the verifiers' round-3 reproductions kept in the suite: Opus's round-3 probes (D-O1 N1-*).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `r3-opus.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { expect, it } from 'vitest';
import { ready, submitOne, reconcileRounds, type Ready } from '../support/scenario.js';
import { YES, halted } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

const ev = (r: Ready) => r.p.journal.events() as Loose[];
const classOf = (r: Ready) => new Map(ev(r).filter((e) => e.kind === 'BREAK_OPENED').map((e) => [e.breakId, e.breakClass]));
const resolutionsAll = (r: Ready) => { const c = classOf(r); return ev(r).filter((e) => e.kind === 'BREAK_RESOLVED').map((e) => [c.get(e.breakId), e.resolution]); };
const opened = (r: Ready) => ev(r).filter((e) => e.kind === 'BREAK_OPENED').map((e) => e.breakClass);

async function seenThenMissing(variant: 'cancel' | 'fill-lag' | 'never-seen' | 'control-sound') {
  const r = await ready();
  r.u.world.nextTransmission = () => 'UNKNOWN_EXISTS';
  await submitOne(r.oms);
  r.u.world.settleArrivals();
  const salt = r.u.world.receipts.at(-1)!;
  const x = r.u.world.orders.get(salt)!;
  const reads: string[] = [];
  let run1: Loose = null;
  if (variant !== 'never-seen') {
    if (variant !== 'control-sound') r.u.world.faults.readOrder = (id, answer) => { if (id === x.venueOrderId) throw new Error('timeout'); return answer(); };
    run1 = await r.p.coordinator.reconcile();
  }
  const collateralBefore = r.u.world.collateral;
  if (variant === 'cancel') r.u.world.cancel(x.venueOrderId);
  if (variant === 'fill-lag' || variant === 'never-seen' || variant === 'control-sound') {
    r.u.world.match(salt, '1');
  }
  r.u.world.faults = {
    readOrder: (id, answer) => { reads.push(id); return answer(); },
  };
  if (variant === 'fill-lag' || variant === 'never-seen' || variant === 'control-sound') {
    r.u.world.faults.listTrades = (answer) => { const a = answer() as Loose; return { ...a, trades: a.trades.filter((t: Loose) => t.ownLegs.every((l: Loose) => l.venueOrderId !== x.venueOrderId)) }; };
    r.u.world.faults.readPositions = (answer) => { const a = answer() as Loose; return { ...a, positions: a.positions.filter((p: Loose) => p.tokenId !== YES) }; };
    r.u.world.faults.readCollateral = (answer) => { const a = answer() as Loose; return { ...a, balance: collateralBefore }; };
  }
  const resumed = await reconcileRounds(r, 4);
  const out = {
    variant,
    run1: run1 ? run1.runs.map((x: Loose) => [x.status, x.resumed, x.detections.map((d: Loose) => d.breakClass)]) : null,
    resumedAfter: resumed,
    byIdReadsAfterRun1: reads,
    xId: x.venueOrderId,
    accepted: r.u.accepted,
    omsOrder: r.oms.orders().map((o) => [o.state, o.venueOrderId, o.filledShares, o.finalSize]),
    venueX: [x.status, x.matched],
    resolutions: resolutionsAll(r),
    opened: opened(r),
    violations: r.u.violations,
    paused: r.oms.paused,
  };
  trace('N1', JSON.stringify(out));
  return { r, x, out };
}

it('N1-V1 a candidate seen in run 1 (its by-id read failed) is canceled before run 2: is it read by id again (E-14)?', async () => {
  const { out } = await seenThenMissing('cancel');
  expect(out.byIdReadsAfterRun1).toContain(out.xId);
});
it('N1-V2 a candidate seen in run 1 (by-id failed) fills fully before run 2, trades and holdings lag: is it read by id again (E-14)?', async () => {
  const { out } = await seenThenMissing('fill-lag');
  expect(out.byIdReadsAfterRun1).toContain(out.xId);
});
it('N1-C1 control: never seen at all, fully filled, trades and holdings lag (the disclosed known risk)', async () => {
  await seenThenMissing('never-seen');
});
it('N1-C2 control: run 1 sound (PRESENT found), then the same fill and lag', async () => {
  await seenThenMissing('control-sound');
});

it('N1-F a foreign order seen in run 1 (its by-id read failed), canceled before run 2: ever UNATTRIBUTED?', async () => {
  const r = await ready();
  const x = r.u.world.placeForeign({ tokenId: YES, side: 'BUY', price: '0.3', size: '2' });
  r.u.world.faults.readOrder = (id, answer) => { if (id === x.venueOrderId) throw new Error('timeout'); return answer(); };
  r.p.coordinator.trigger('PERIODIC_TIMER');
  const run1 = await r.p.coordinator.reconcile();
  r.u.world.cancel(x.venueOrderId);
  const reads: string[] = [];
  r.u.world.faults = { readOrder: (id, answer) => { reads.push(id); return answer(); } };
  const resumed = await reconcileRounds(r, 4);
  trace('N1-F', JSON.stringify({ run1: run1.runs.map((x: Loose) => [x.status, x.detections.map((d: Loose) => d.breakClass)]), resumed, reads, opened: opened(r), resolutions: resolutionsAll(r), halts: halted(r.p).length }));
});
it('N1-F-ctl control: the same foreign order in a sound run 1', async () => {
  const r = await ready();
  const x = r.u.world.placeForeign({ tokenId: YES, side: 'BUY', price: '0.3', size: '2' });
  r.p.coordinator.trigger('PERIODIC_TIMER');
  const run1 = await r.p.coordinator.reconcile();
  trace('N1-F-ctl', JSON.stringify({ run1: run1.runs.map((x: Loose) => [x.status, x.detections.map((d: Loose) => d.breakClass)]), opened: opened(r), halts: halted(r.p).length, xid: x.venueOrderId }));
});
