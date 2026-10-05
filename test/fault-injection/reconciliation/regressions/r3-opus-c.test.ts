/**
 * WP-290 r6: a named regression, the verifiers' round-3 reproductions kept in the suite: Opus's round-3 probes (N1-F).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `r3-opus-c.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { it } from 'vitest';
import { ready, submitOne, reconcileRounds, type Ready } from '../support/scenario.js';
import { trace, type Loose } from "../support/loose.js";

const ev = (r: Ready) => r.p.journal.events() as Loose[];
const classOf = (r: Ready) => new Map(ev(r).filter((e) => e.kind === 'BREAK_OPENED').map((e) => [e.breakId, e.breakClass]));
const resolutionsAll = (r: Ready) => { const c = classOf(r); return ev(r).filter((e) => e.kind === 'BREAK_RESOLVED').map((e) => [c.get(e.breakId), e.resolution]); };

it('N1-V5 the candidate is listed in a run made unsound by another read (the trades read fails); it is canceled before the next run', async () => {
  const r = await ready();
  r.u.world.nextTransmission = () => 'UNKNOWN_EXISTS';
  await submitOne(r.oms);
  r.u.world.settleArrivals();
  const salt = r.u.world.receipts.at(-1)!;
  const x = r.u.world.orders.get(salt)!;
  r.u.world.faults.listTrades = () => { throw new Error('timeout'); };
  const run1 = await r.p.coordinator.reconcile();
  r.u.world.cancel(x.venueOrderId);
  const reads: string[] = [];
  r.u.world.faults = { readOrder: (id, answer) => { reads.push(id); return answer(); } };
  const resumed = await reconcileRounds(r, 4);
  trace('N1-V5', JSON.stringify({ run1: run1.runs.map((z: Loose) => [z.status, z.detections.map((d: Loose) => d.breakClass)]), resumed, reads, accepted: r.u.accepted, resolutions: resolutionsAll(r), violations: r.u.violations }));
});
