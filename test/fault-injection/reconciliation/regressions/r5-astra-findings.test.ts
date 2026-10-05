/**
 * WP-290 r6: a named regression, the verifiers' round-5 reproductions kept in the suite: astra's round-5 findings (R5-NAMED provenance).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `astra-r5-findings.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
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

for (const fault of ['BACKWARD','UNREADABLE','SOUND'] as const) it(`R5 clock ${fault} after read validation: must stay held`,async()=>{
 const r=await ready();
 await submitOne(r.oms);
 expect((await r.oms.requestOrderReconciliation(r.oms.orders()[0]!.orderId)).ok).toBe(true);
 r.u.seams.applyReconciliation=async(raw,real)=>{const a=await real(raw);if(fault!=='SOUND') r.u.clock.t=fault==='BACKWARD'?r.u.clock.t-1:NaN;return a;};
 const report=await r.p.coordinator.reconcile();
 trace('R5-CLOCK',JSON.stringify({fault,report,paused:r.oms.paused}));
 expect(report.resumed).toBe(fault==='SOUND');
});

import { group, ticket } from '../../../unit/oms/support/harness.js';
it('R5 clock fault between two ABSENT answers invalidates the second quiescence attestation',async()=>{
 const r=await ready();
 const a=group(9001,{tokenId:YES,plannedShares:'5'}),b=group(9002,{tokenId:YES,plannedShares:'5'});
 expect((await r.oms.registerGroup(b)).ok).toBe(true);
 r.u.world.nextTransmission=sequence(['UNKNOWN_ABSENT','UNKNOWN_ABSENT']);
 expect((await r.oms.submitBatch([ticket(a,{n:950,shares:'1'}),ticket(b,{n:951,shares:'1'})])).ok).toBe(true);
 r.u.clock.t+=r.u.policy.quiescenceHorizonMs+1;
 let first=true;
 r.u.seams.applyReconciliation=async(raw,real)=>{const result=await real(raw);if(first){first=false;r.u.clock.t=NaN;}return result;};
 const report=await r.p.coordinator.reconcile();
 trace('R5-CLOCK-ABSENT',JSON.stringify({report,accepted:r.u.accepted,paused:r.oms.paused}));
 expect(r.u.accepted.length).toBe(1);
 expect(report.resumed).toBe(false);
});
