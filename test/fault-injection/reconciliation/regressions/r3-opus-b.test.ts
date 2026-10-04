/**
 * WP-290 r6: a named regression, the verifiers' round-3 reproductions kept in the suite: Opus's round-3 probes (N1-V3, N1-V4).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `r3-opus-b.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 * - N1-V3: its last assertion adapted as agreed in round 3 (the behaviour is the fix: read by id, PRESENT, resumed consistent).
 */

import { expect, it } from 'vitest';
import { ready, submitOne, reconcileRounds, type Ready } from '../support/scenario.js';
import { YES } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

const ev = (r: Ready) => r.p.journal.events() as Loose[];
const classOf = (r: Ready) => new Map(ev(r).filter((e) => e.kind === 'BREAK_OPENED').map((e) => [e.breakId, e.breakClass]));
const resolutionsAll = (r: Ready) => { const c = classOf(r); return ev(r).filter((e) => e.kind === 'BREAK_RESOLVED').map((e) => [c.get(e.breakId), e.resolution]); };

it('N1-V3 (extends the R2-A pin) list shows the candidate MYSTERY; it is then canceled: never read again, ABSENT, resumed', async () => {
  const r = await ready();
  r.u.world.nextTransmission = () => 'UNKNOWN_EXISTS';
  await submitOne(r.oms);
  r.u.world.settleArrivals();
  const salt = r.u.world.receipts.at(-1)!;
  const x = r.u.world.orders.get(salt)!;
  r.u.world.faults.listOpenOrders = (answer) => { const a = answer() as Loose; return { ...a, orders: a.orders.map((o: Loose) => ({ ...o, status: 'MYSTERY' })) }; };
  const run1 = await r.p.coordinator.reconcile();
  r.u.world.cancel(x.venueOrderId);
  const reads: string[] = [];
  r.u.world.faults = { readOrder: (id, answer) => { reads.push(id); return answer(); } };
  const resumed = await reconcileRounds(r, 4);
  trace('N1-V3', JSON.stringify({ run1: run1.runs.map((z: Loose) => [z.status, z.detections.map((d: Loose) => d.breakClass)]), resumed, reads, accepted: r.u.accepted, resolutions: resolutionsAll(r), violations: r.u.violations }));
  // (adapted, as agreed in round 3: the fault was the order being forgotten; the symptom assertion `resumed` false
  // was not.) The order is read again by id, answered PRESENT (canceled), never ABSENT, and the account resumes
  // consistent.
  expect(reads).toContain(x.venueOrderId);
  expect(r.u.accepted.map((answer) => [answer.verdict, answer.venueOrderId])).toEqual([['PRESENT', x.venueOrderId]]);
  expect(resumed).toBe(true);
  expect(r.u.violations).toEqual([]);
});

it('N1-V4 a recorded SIGNED_IDENTITY_AMBIGUOUS names its candidates; both leave the open list (canceled): cleared without reading them, ABSENT, resumed', async () => {
  const r = await ready();
  r.u.world.nextTransmission = () => 'UNKNOWN_EXISTS';
  await submitOne(r.oms);
  r.u.world.settleArrivals();
  const salt = r.u.world.receipts.at(-1)!;
  const x = r.u.world.orders.get(salt)!;
  const twin = r.u.world.placeForeign({ tokenId: YES, side: 'BUY', price: '0.5', size: '1' });
  const before = await reconcileRounds(r, 3);
  const amb = r.p.journal.unresolvedBreaks().find((v) => v.breakClass === 'SIGNED_IDENTITY_AMBIGUOUS');
  r.u.world.cancel(x.venueOrderId);
  r.u.world.cancel(twin.venueOrderId);
  const reads: string[] = [];
  r.u.world.faults = { readOrder: (id, answer) => { reads.push(id); return answer(); } };
  const resumed = await reconcileRounds(r, 4);
  trace('N1-V4', JSON.stringify({ before, ambDetail: amb?.detail, resumed, reads, accepted: r.u.accepted, resolutions: resolutionsAll(r), violations: r.u.violations }));
  expect(reads).toContain(x.venueOrderId);
});
