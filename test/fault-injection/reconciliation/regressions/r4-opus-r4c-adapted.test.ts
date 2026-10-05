/**
 * WP-290 r6: a named regression, the verifiers' round-4 reproductions kept in the suite: Opus's round-4 R4-C variants, as adapted (agreed in rounds 4 to 6).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `opus-r4c-variants.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import {it,expect} from 'vitest';
import {ready,submitOne,reconcileRounds} from '../support/scenario.js';
import {YES,boot,ledgerHoldings,PUSD} from '../support/harness.js';
import {negateDecimal} from '../../../../packages/decimal/src/index.js';
import { trace, type Loose } from "../support/loose.js";

async function failAndReverse(r: Loose, priorShares: boolean) {
  if (priorShares) {
    await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1)!, '1', {status:'CONFIRMED'});
    expect(await reconcileRounds(r,6)).toBe(true);
  }
  await submitOne(r.oms);
  const t=r.u.world.match(r.u.world.receipts.at(-1)!,'0.4',{status:'MINED'})!;
  expect(await reconcileRounds(r,6)).toBe(true);
  t.status='FAILED';r.u.world.adjustPosition(YES,'-0.4');r.u.world.adjustCollateral('0.2');
  expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
  const principals=r.u.ledger.transactions().filter((x: Loose)=>x.transaction.eventType==='TRADE_PRINCIPAL');
  const target=principals.at(-1)!.transaction;
  const correction=r.u.ledger.append({...target,ledgerTransactionId:r.u.ledgerIds(),eventType:'MANUAL_ADJUSTMENT',source:'internal',reversesLedgerTransactionId:target.ledgerTransactionId,entries:target.entries.map((e: Loose)=>({...e,amount:negateDecimal(e.amount)}))});
  expect(correction.ok,JSON.stringify(correction)).toBe(true);r.u.ledger=correction.value.ledger;
  for(const b of r.p.journal.unresolvedBreaks().filter((v: Loose)=>v.status==='QUARANTINED'))expect((await r.p.coordinator.releaseQuarantine({breakId:b.breakId,operatorRef:'op',reason:'reversal booked'})).ok).toBe(true);
  expect(await reconcileRounds(r,4)).toBe(true);
}

it('O-R4C-TOKEN-DEPARTURE: after a reversed FAILED BUY, an unrelated departure of 0.4 YES is concealed', async()=>{
  const r=await ready();
  await failAndReverse(r,true);
  r.u.world.adjustPosition(YES,'-0.4');
  const results=[];for(let n=0;n<3;n++){results.push(await r.p.coordinator.reconcile());r.u.clock.t+=r.u.policy.holdingConfirmationMs+r.u.policy.quiescenceHorizonMs+1;}
  const p=await boot(r.u);const restart=await p.coordinator.reconcile();
  trace('O-R4C-TOKEN-DEPARTURE',JSON.stringify({resumed:results.map(x=>x.resumed),restartResumed:restart.resumed,detections:results.flatMap((x: Loose)=>x.runs.flatMap((y: Loose)=>y.detections.map((d: Loose)=>d.breakClass))),actualYes:r.u.world.positions.get(YES),projectedYes:ledgerHoldings(r.u).get(YES),actualC:r.u.world.collateral,projectedC:ledgerHoldings(r.u).get(PUSD)}));
  expect(results.some(x=>x.resumed)||restart.resumed).toBe(false);
});

it('O-R4C-INEXACT: after a reversed FAILED BUY, a +0.1 arrival (not the exact inverse) is held; is it ever booked UNATTRIBUTED?', async()=>{
  const r=await ready();
  await failAndReverse(r,false);
  r.u.world.adjustCollateral('0.1');
  const results=[];for(let n=0;n<4;n++){results.push(await r.p.coordinator.reconcile());r.u.clock.t+=r.u.policy.holdingConfirmationMs+r.u.policy.quiescenceHorizonMs+1;}
  trace('O-R4C-INEXACT',JSON.stringify({resumed:results.map(x=>x.resumed),detections:results.map((x: Loose)=>x.runs.flatMap((y: Loose)=>y.detections.map((d: Loose)=>d.breakClass))),projectedC:ledgerHoldings(r.u).get(PUSD),actualC:r.u.world.collateral}));
  expect(results.some(x=>x.resumed)).toBe(false);
});

it('O-R4C-NO-REVERSAL: releasing the FAILED quarantines without booking the reversal', async()=>{
  const r=await ready();
  await submitOne(r.oms);
  const t=r.u.world.match(r.u.world.receipts.at(-1)!,'0.4',{status:'MINED'})!;
  expect(await reconcileRounds(r,6)).toBe(true);
  t.status='FAILED';r.u.world.adjustPosition(YES,'-0.4');r.u.world.adjustCollateral('0.2');
  expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
  for(const b of r.p.journal.unresolvedBreaks().filter((v: Loose)=>v.status==='QUARANTINED'))expect((await r.p.coordinator.releaseQuarantine({breakId:b.breakId,operatorRef:'op',reason:'released without reversal'})).ok).toBe(true);
  const resumed=await reconcileRounds(r,4);
  trace('O-R4C-NO-REVERSAL',JSON.stringify({resumed,actualC:r.u.world.collateral,projectedC:ledgerHoldings(r.u).get(PUSD),actualYes:r.u.world.positions.get(YES),projectedYes:ledgerHoldings(r.u).get(YES)}));
});
