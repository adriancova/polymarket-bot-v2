/**
 * WP-290 r6: a named regression, the verifiers' round-2 reproductions kept in the suite: astra's round-2 controls (N1, N2, N2b, I-12).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `astra-r2-controls.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 * - N2 control and N2b: adapted in r6 (class A): the replaced trade id is evidence, held as a READ_CONFLICT for good,
 *   so the control's "clears" becomes "stays held", and N2b finds that hold where it found FILL_MISMATCH.
 */

import {it,expect} from 'vitest';
import {ready,submitOne,reconcileRounds} from '../support/scenario.js';
import {YES} from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";
it('N1 control: a later clean run passes after an unrecognized status is removed',async()=>{
 const r=await ready();r.u.world.nextTransmission=()=> 'UNKNOWN_EXISTS';await submitOne(r.oms);
 const report=await r.p.coordinator.reconcile();expect(report.resumed).toBe(true);
});
it('N2 control (adapted in r6): a replaced trade id is evidence; restoring the original identity does not clear it',async()=>{
 const r=await ready();await submitOne(r.oms);r.u.world.match(r.u.world.receipts.at(-1)!,'0.4');expect(await reconcileRounds(r,4)).toBe(true);
 r.u.world.faults.listTrades=(answer)=>{const a=answer() as Loose;return {...a,trades:a.trades.map((t: Loose)=>({...t,venueTradeId:'replacement-id'}))};};
 expect((await r.p.coordinator.reconcile()).resumed).toBe(false);delete r.u.world.faults.listTrades;
 // r6, class A: the venue showed two distinct trades on the order (the original, the replacement), summing more than its
 // matched size; no later read can explain that away, so the account stays held (READ_CONFLICT), never resumed.
 expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
 expect(r.p.journal.unresolvedBreaks().map((view)=>view.breakClass)).toContain('READ_CONFLICT');
});
it('I-12 foreign twin still adopted as disclosed',async()=>{
 const r=await ready();r.u.world.nextTransmission=()=> 'UNKNOWN_ABSENT';await submitOne(r.oms);
 const foreign=r.u.world.placeForeign({tokenId:YES,side:'BUY',price:'0.5',size:'1'});
 const report=await r.p.coordinator.reconcile();trace('I-12',JSON.stringify({resumed:report.resumed,accepted:r.u.accepted,violations:r.u.violations}));
 expect(r.u.accepted[0]?.venueOrderId).toBe(foreign.venueOrderId);
});
it('N2b changing fixed facts also clears a fill mismatch without judging it',async()=>{
 const r=await ready();await submitOne(r.oms);r.u.world.match(r.u.world.receipts.at(-1)!,'0.4');expect(await reconcileRounds(r,4)).toBe(true);
 r.u.world.faults.listTrades=(answer)=>{const a=answer() as Loose;return {...a,trades:a.trades.map((t: Loose)=>({...t,venueTradeId:'replacement-id'}))};};
 await r.p.coordinator.reconcile();const b=r.p.journal.unresolvedBreaks().find(b=>b.breakClass==='READ_CONFLICT')!;
 r.u.world.faults.listOpenOrders=(answer)=>{const a=answer() as Loose;return {...a,orders:a.orders.map((o: Loose)=>({...o,price:'0.51'}))};};
 const report=await r.p.coordinator.reconcile();const after=r.p.journal.breaks().find(x=>x.breakId===b.breakId);
 trace('N2b',JSON.stringify({resumed:report.resumed,after}));expect(after?.status).toBe('OPEN');
});
