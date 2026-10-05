/**
 * WP-290 r6: a named regression, the verifiers' round-1 reproductions kept in the suite: astra's round-1 probes (I-01 .. I-14).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `astra-r1.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 * - dropped "R4 stream fill arriving after holdings read must block resume until compared": I-01b: withdrawn by both verifiers in round 2 (joint r2: "I-01b stays withdrawn").
 */

import { expect, it } from 'vitest';
import { ready, submitOne, reconcileRounds } from '../support/scenario.js';
import { boot, streamTrade } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

it('R1 a request arriving during RUN_COMPLETED must block resume', async () => {
 const r = await ready();
 const append = r.p.journal.append.bind(r.p.journal);
 let injected = false;
 r.p.journal.append = async (event: Loose) => {
  if (!injected && event.kind === 'RUN_COMPLETED' && event.status === 'PASSED') {
   injected = true;
   r.p.coordinator.onUserStreamOutput({kind:'RECONCILIATION_REQUESTED',request:{requestId:'late-gap',cause:'SOCKET_CLOSED',markets:[]}});
  }
  return append(event);
 };
 const report = await r.p.coordinator.reconcile();
 trace('R1',JSON.stringify({report,status:r.p.coordinator.status(),paused:r.oms.paused}));
 expect(report.runs[0]?.resumed).toBe(false);
});

it('R2 trade facts differing at equal total shares must not resume', async () => {
 const r = await ready();
 await submitOne(r.oms);
 r.u.world.match(r.u.world.receipts.at(-1)!, '0.4');
 expect(await reconcileRounds(r,3)).toBe(true);
 r.u.world.faults.listTrades = (answer) => {
  const raw=answer() as Loose;
  return {...raw,trades:raw.trades.map((t: Loose)=>({...t, ownLegs:t.ownLegs.map((l: Loose)=>({...l,price:'0.49',feeAmount:'0.004',feeAssetId:r.u.policy.collateralAssetId}))}))};
 };
 const report=await r.p.coordinator.reconcile();
 trace('R2',JSON.stringify({report, fills:r.u.store.snapshotSync().fills}));
 expect(report.resumed).toBe(false);
});

it('R3 a missing trade for a terminal filled order after restart must not resume', async () => {
 const r=await ready();
 await submitOne(r.oms);
 r.u.world.match(r.u.world.receipts.at(-1)!, '1');
 expect(await reconcileRounds(r,4)).toBe(true);
 r.u.world.faults.listTrades=()=>({route:'/data/trades',complete:true,trades:[]});
 const restarted=await boot(r.u);
 const report=await restarted.coordinator.reconcile();
 trace('R3',JSON.stringify({report,orders:restarted.oms?.orders()}));
 expect(report.resumed).toBe(false);
});


it('R5 startup stale settlement behind durable OMS must not resume', async()=>{
 const r=await ready();
 await submitOne(r.oms);
 const t=r.u.world.match(r.u.world.receipts.at(-1)!, '0.4')!;
 expect(await reconcileRounds(r,4)).toBe(true);
 t.status='MATCHED';
 const restarted=await boot(r.u);
 const report=await restarted.coordinator.reconcile();
 trace('R5',JSON.stringify({report,settlements:r.u.store.snapshotSync().settlements}));
 expect(report.resumed).toBe(false);
});

it('R6 changed trade identity with equal shares must not resume', async()=>{
 const r=await ready();
 await submitOne(r.oms);
 r.u.world.match(r.u.world.receipts.at(-1)!, '0.4');
 expect(await reconcileRounds(r,4)).toBe(true);
 r.u.world.faults.listTrades=(answer)=>{
  const raw=answer() as Loose;
  return {...raw,trades:raw.trades.map((t: Loose)=>({...t,venueTradeId:'replacement-trade'}))};
 };
 const report=await r.p.coordinator.reconcile();
 trace('R6',JSON.stringify({report,fills:r.u.store.snapshotSync().fills}));
 expect(report.resumed).toBe(false);
});

it('R7 tracked order changed token must not resolve or resume', async()=>{
 const r=await ready();
 await submitOne(r.oms);
 r.u.world.faults.listOpenOrders=(answer)=>{
  const raw=answer() as Loose;
  return {...raw,orders:raw.orders.map((o: Loose)=>({...o,tokenId:'12345'}))};
 };
 r.u.world.faults.readOrder=(_id,answer)=>{
  const raw=answer() as Loose;
  return {...raw,order:{...raw.order,tokenId:'12345'}};
 };
 expect((await r.oms.requestOrderReconciliation(r.oms.orders()[0]!.orderId)).ok).toBe(true);
 const report=await r.p.coordinator.reconcile();
 trace('R7',JSON.stringify({report,accepted:r.u.accepted}));
 expect(report.resumed).toBe(false);
});

it('R8 operator release must not waive persistent fixed fact contradiction', async()=>{
 const r=await ready();
 await submitOne(r.oms);
 r.u.world.faults.listOpenOrders=(answer)=>{
  const raw=answer() as Loose;
  return {...raw,orders:raw.orders.map((o: Loose)=>({...o,price:'0.51'}))};
 };
 expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
 const b=r.p.journal.unresolvedBreaks().find(b=>b.breakClass==='ORDER_FACTS_MISMATCH')!;
 expect((await r.p.coordinator.releaseQuarantine({breakId:b.breakId,operatorRef:'reviewer',reason:'acknowledged'})).ok).toBe(true);
 const report=await r.p.coordinator.reconcile();
 trace('R8',JSON.stringify({report,breaks:r.p.journal.breaks()}));
 expect(report.resumed).toBe(false);
});

import { consistencyProblems } from '../support/harness.js';
it('R4-post: after the buffered fill is flushed, is the account consistent?', async () => {
 const r=await ready();
 await submitOne(r.oms);
 const append=r.p.journal.append.bind(r.p.journal);
 let injected=false;
 r.p.journal.append=async(event: Loose)=>{
  if(!injected && event.kind==='RUN_COMPLETED' && event.status==='PASSED') {
   injected=true;
   const t=r.u.world.match(r.u.world.receipts.at(-1)!, '0.4')!;
   r.p.coordinator.onUserStreamOutput(streamTrade(r.u,t.venueTradeId));
  }
  return append(event);
 };
 const report=await r.p.coordinator.reconcile();
 const atResume=[...r.u.violations];
 await r.p.coordinator.settled();
 const after=consistencyProblems(r.u, r.oms);
 trace('R4-post',JSON.stringify({resumed:report.resumed,atResume,afterSettled:after, filled:r.oms.orders().map(o=>o.filledShares)}));
});
