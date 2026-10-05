/**
 * WP-290 r6: a named regression, the verifiers' round-4 reproductions kept in the suite: astra's round-4 reversal probes, as adapted (agreed in rounds 4 to 6: the original setup releases a hold no operator can release).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `astra-r4-reversal.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import {it,expect} from 'vitest';
import {ready,submitOne,reconcileRounds} from '../support/scenario.js';
import {YES,boot,ledgerHoldings,PUSD} from '../support/harness.js';
import {negateDecimal} from '../../../../packages/decimal/src/index.js';
import { trace, type Loose } from "../support/loose.js";
it('R4-C a reversed FAILED fill cannot explain a later unrelated collateral delta',async()=>{
 const r=await ready();await submitOne(r.oms);
 const t=r.u.world.match(r.u.world.receipts.at(-1)!,'0.4',{status:'MINED'})!;
 expect(await reconcileRounds(r,6)).toBe(true);
 t.status='FAILED';r.u.world.adjustPosition(YES,'-0.4');r.u.world.adjustCollateral('0.2');
 expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
 const target=r.u.ledger.transactions().find(x=>x.transaction.eventType==='TRADE_PRINCIPAL')!.transaction;
 const correction=r.u.ledger.append({...target,ledgerTransactionId:r.u.ledgerIds(),eventType:'MANUAL_ADJUSTMENT',source:'internal',reversesLedgerTransactionId:target.ledgerTransactionId,entries:target.entries.map(e=>({...e,amount:negateDecimal(e.amount)}))});
 expect(correction.ok,JSON.stringify(correction)).toBe(true);if(!correction.ok)return;r.u.ledger=correction.value.ledger;
 for(const b of r.p.journal.unresolvedBreaks().filter((v: Loose)=>v.status==='QUARANTINED'))expect((await r.p.coordinator.releaseQuarantine({breakId:b.breakId,operatorRef:'op',reason:'exact compensating reversal durably booked'})).ok).toBe(true);
 expect(await reconcileRounds(r,4)).toBe(true);
 r.u.world.adjustCollateral('0.2');
 const results=[];for(let n=0;n<3;n++){results.push(await r.p.coordinator.reconcile());r.u.clock.t+=r.u.policy.quiescenceHorizonMs+1;}
 const p=await boot(r.u);const restart=await p.coordinator.reconcile();
 trace('R4-C',JSON.stringify({results,restart,breaks:p.journal.breaks(),transactions:r.u.ledger.transactions(),actualCollateral:r.u.world.collateral,projectedCollateral:ledgerHoldings(r.u).get(PUSD)}));
 expect(results.some(x=>x.resumed)).toBe(false);
 expect(p.journal.breaks().some(b=>b.breakClass==='BALANCE_UNATTRIBUTED')).toBe(true);
});

it('R4-C control the same collateral increase without an old FAILED fill becomes UNATTRIBUTED',async()=>{
 const r=await ready();r.u.world.adjustCollateral('0.2');
 for(let n=0;n<3;n++){expect((await r.p.coordinator.reconcile()).resumed).toBe(false);r.u.clock.t+=r.u.policy.holdingConfirmationMs+1;}
 expect(r.p.journal.breaks().some(b=>b.breakClass==='BALANCE_UNATTRIBUTED')).toBe(true);
 expect(ledgerHoldings(r.u).get(PUSD)).toBe('1000.2');
});
