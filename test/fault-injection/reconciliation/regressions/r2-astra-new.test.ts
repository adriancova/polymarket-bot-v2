/**
 * WP-290 r6: a named regression, the verifiers' round-2 reproductions kept in the suite: astra's round-2 findings (R2-N1, R2-N2).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `astra-r2-new.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 * - R2-N2: adapted in r6 (class A): the replaced trade id is held as a READ_CONFLICT (evidence), where it was a
 *   FILL_MISMATCH; the assertion (a skipped run does not clear it) is unchanged.
 */

import {it,expect} from 'vitest';
import {ready,submitOne,reconcileRounds} from '../support/scenario.js';
import { trace, type Loose } from "../support/loose.js";
it('R2-N1 unknown listed status must not be erased by a by-id read',async()=>{
 const r=await ready(); r.u.world.nextTransmission=()=> 'UNKNOWN_EXISTS'; await submitOne(r.oms);
 r.u.world.faults.listOpenOrders=(answer)=>{const a=answer() as Loose;return {...a,orders:a.orders.map((o: Loose)=>({...o,status:'MYSTERY'}))};};
 const report=await r.p.coordinator.reconcile();
 trace('R2-N1',JSON.stringify({report,accepted:r.u.accepted,paused:r.oms.paused}));
 expect(report.resumed).toBe(false); expect(r.u.accepted).toEqual([]);
});
it('R2-N2 skipped fill comparison must not clear existing fill mismatch',async()=>{
 const r=await ready();await submitOne(r.oms);r.u.world.match(r.u.world.receipts.at(-1)!,'0.4');expect(await reconcileRounds(r,4)).toBe(true);
 r.u.world.faults.listTrades=(answer)=>{const a=answer() as Loose;return {...a,trades:a.trades.map((t: Loose)=>({...t,venueTradeId:'replacement-id'}))};};
 await r.p.coordinator.reconcile();const b=r.p.journal.unresolvedBreaks().find(b=>b.breakClass==='READ_CONFLICT')!;expect(b).toBeDefined();
 r.u.seams.tokenOfGroup=()=>null;
 const report=await r.p.coordinator.reconcile();
 const after=r.p.journal.breaks().find(x=>x.breakId===b.breakId);
 trace('R2-N2',JSON.stringify({report,after}));
 expect(after?.status).toBe('OPEN');
});
