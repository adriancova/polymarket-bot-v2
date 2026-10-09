/**
 * WP-290 r6: a named regression, the verifiers' round-4 reproductions kept in the suite: astra's round-4 findings (R4-A, R4-B).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `astra-r4-new.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { it, expect } from 'vitest';
import { ready, submitOne, sequence, reconcileRounds } from '../support/scenario.js';
import { boot, halted, YES } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

for (const corruption of ['INCOMPLETE','MALFORMED_SIBLING','DUPLICATE']) {
 it(`R4-A ${corruption}: candidates seen in a discarded list must still block uniqueness`, async()=>{
  const r=await ready(); r.u.world.nextTransmission=sequence(['UNKNOWN_EXISTS']);
  const attempt=await submitOne(r.oms);
  const real=r.u.world.orders.get(r.u.world.receipts.at(-1)!)!;
  const twin=r.u.world.placeForeign({tokenId:YES,side:'BUY',price:'0.5',size:'1'});
  r.u.world.faults.listOpenOrders=answer=>{const a=answer() as Loose; return corruption==='INCOMPLETE' ? {...a,complete:false} : {...a,orders:[...a.orders,corruption==='DUPLICATE'?a.orders[0]:{venueOrderId:'broken-sibling'}]};};
  const first=await r.p.coordinator.reconcile();
  expect(first.resumed).toBe(false);
  r.u.world.cancel(twin.venueOrderId);
  const reads:string[]=[];
  r.u.world.faults={readOrder:(id,answer)=>{reads.push(id);return answer();}};
  const resumed=await reconcileRounds(r,4);
  trace('R4-A',JSON.stringify({corruption,attempt,real:real.venueOrderId,twin:twin.venueOrderId,first,reads,resumed,accepted:r.u.accepted,breaks:r.p.journal.breaks()}));
  expect(r.u.accepted.filter(a=>a.attemptId===attempt)).toEqual([]);
  expect(resumed).toBe(false);
 });
}

it('R4-A control: a complete candidate list retains the canceled twin',async()=>{
 const r=await ready();r.u.world.nextTransmission=sequence(['UNKNOWN_EXISTS']);const attempt=await submitOne(r.oms);
 const twin=r.u.world.placeForeign({tokenId:YES,side:'BUY',price:'0.5',size:'1'});
 expect((await r.p.coordinator.reconcile()).resumed).toBe(false);r.u.world.cancel(twin.venueOrderId);
 expect(await reconcileRounds(r,4)).toBe(false);expect(r.u.accepted.filter(a=>a.attemptId===attempt)).toEqual([]);
});

it('R4-B an incomplete list must not lose an unmatched canceled order across restart',async()=>{
 const r=await ready();const foreign=r.u.world.placeForeign({tokenId:YES,side:'BUY',price:'0.5',size:'1'});
 r.u.world.faults.listOpenOrders=answer=>({...answer() as Loose,complete:false});
 expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
 r.u.world.cancel(foreign.venueOrderId);r.u.world.faults={};
 const p=await boot(r.u);const result=await p.coordinator.reconcile();
 trace('R4-B',JSON.stringify({result,breaks:p.journal.breaks(),halts:halted(p)}));
 expect(result.resumed).toBe(false);expect(p.journal.breaks().some(b=>b.breakClass==='ORDER_UNATTRIBUTED')).toBe(true);
});
