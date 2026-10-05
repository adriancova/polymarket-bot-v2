/**
 * WP-290 r6: a named regression, the verifiers' round-5 reproductions kept in the suite: astra's round-5 new probes.
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `r5-new.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 * - dropped "R5 age after reads: a slow completion must not resume using expired reads": not promoted by astra in round 5 (maxReadSpanMs bounds the reads' duration, not their age at the completion); the round-6 Opus report carries that ruling.
 */

import { expect, it } from 'vitest';
import { ready, submitOne, sequence } from '../support/scenario.js';
import { boot, YES } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

for(const mode of ['COMPLETE','INCOMPLETE','MALFORMED_SIBLING','DUPLICATE'] as const) {
 for(const restart of [false,true]) it(`R5 provenance ${mode} restart=${restart}: an observed real order missing by id cannot make the foreign twin unique`,async()=>{
  const r=await ready();
  r.u.world.nextTransmission=sequence(['UNKNOWN_EXISTS']);
  const attempt=await submitOne(r.oms);
  const real=r.u.world.orders.get(r.u.world.receipts.at(-1)!)!.venueOrderId;
  const twin=r.u.world.placeForeign({tokenId:YES,side:'BUY',price:'0.5',size:'1'}).venueOrderId;
  r.u.world.faults.listOpenOrders=answer=>{
   const a=answer() as Loose;
   if(mode==='INCOMPLETE') return {...a,complete:false};
   if(mode==='MALFORMED_SIBLING') return {...a,orders:[...a.orders,{venueOrderId:'garbage-sibling'}]};
   if(mode==='DUPLICATE') return {...a,orders:[...a.orders,a.orders[0]]};
   return a;
  };
  expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
  r.u.world.cancel(real);
  r.u.world.faults={readOrder:(id,answer)=>id===real?{route:'/data/order',found:false,order:null}:answer()};
  const p=restart?await boot(r.u):r.p;
  const report=await p.coordinator.reconcile();
  trace('R5-PROVENANCE',JSON.stringify({mode,restart,real,twin,accepted:r.u.accepted,violations:r.u.violations,report,breaks:p.journal.unresolvedBreaks()}));
  expect(r.u.accepted.filter(a=>a.attemptId===attempt)).toEqual([]);
 });
}


for (const fault of ['BACKWARD','UNREADABLE'] as const) it(`R5 clock ${fault} after read validation: must stay held`,async()=>{
 const r=await ready();
 await submitOne(r.oms);
 expect((await r.oms.requestOrderReconciliation(r.oms.orders()[0]!.orderId)).ok).toBe(true);
 r.u.seams.applyReconciliation=async(raw,real)=>{const a=await real(raw);r.u.clock.t=fault==='BACKWARD'?r.u.clock.t-1:NaN;return a;};
 const report=await r.p.coordinator.reconcile();
 trace('R5-CLOCK',JSON.stringify({fault,report,paused:r.oms.paused}));
 expect(report.resumed).toBe(false);
});
