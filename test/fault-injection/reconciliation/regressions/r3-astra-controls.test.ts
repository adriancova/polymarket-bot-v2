/**
 * WP-290 r6: a named regression, the verifiers' round-3 reproductions kept in the suite: astra's round-3 controls.
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `astra-r3-controls.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import {it,expect} from 'vitest';
import {ready,submitOne,reconcileRounds} from '../support/scenario.js';
import {boot,halted,ACCOUNT,YES,NO,MARKET,MARKET_NO} from '../support/harness.js';
import {projectLedger,projectedHoldings} from '../../../../packages/ledger/src/index.js';
import { trace, type Loose } from "../support/loose.js";

it('R3-B control no crash and restart after durable quarantine both hold',async()=>{
 const r=await ready();await submitOne(r.oms);
 const t=r.u.world.match(r.u.world.receipts.at(-1)!,'0.4',{status:'MINED'})!;
 expect(await reconcileRounds(r,6)).toBe(true);t.status='FAILED';
 expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
 expect(r.p.journal.unresolvedBreaks().some(x=>x.breakClass==='OMS_HALTING_ALERT')).toBe(true);
 const p=await boot(r.u);expect((await p.coordinator.reconcile()).resumed).toBe(false);
 expect(p.journal.unresolvedBreaks().some(x=>x.breakClass==='OMS_HALTING_ALERT')).toBe(true);
});

it('R3-A control a fresh matching trade really clears the regression',async()=>{
 const r=await ready();await submitOne(r.oms);r.u.world.match(r.u.world.receipts.at(-1)!,'0.4',{status:'CONFIRMED'});
 expect(await reconcileRounds(r,6)).toBe(true);const p=await boot(r.u);
 r.u.world.faults.listTrades=answer=>{const a=answer() as Loose;return {...a,trades:a.trades.map((x: Loose)=>({...x,status:'MATCHED'}))}};
 expect((await p.coordinator.reconcile()).resumed).toBe(false);
 const b=p.journal.unresolvedBreaks().find(x=>x.breakClass==='READ_REGRESSION')!;expect(b).toBeDefined();
 delete r.u.world.faults.listTrades;
 expect((await p.coordinator.reconcile()).resumed).toBe(true);
 expect(p.journal.breaks().find(x=>x.breakId===b.breakId)?.status).toBe('RESOLVED');
});

it('I-12 foreign twin is still adopted and is disclosed',async()=>{
 const r=await ready();r.u.world.nextTransmission=()=> 'UNKNOWN_ABSENT';await submitOne(r.oms);
 const foreign=r.u.world.placeForeign({tokenId:YES,side:'BUY',price:'0.5',size:'1'});
 const result=await r.p.coordinator.reconcile();
 expect(result.resumed).toBe(true);expect(r.u.accepted.at(-1)?.venueOrderId).toBe(foreign.venueOrderId);
 trace('I-12',JSON.stringify({resumed:result.resumed,accepted:r.u.accepted}));
});

it('R3-C every asset and market arrival of one transaction needs its own halt',async()=>{
 const r=await ready();const id=r.u.ledgerIds();
 const entries=[{assetId:YES,marketId:MARKET},{assetId:NO,marketId:MARKET_NO}].flatMap(({assetId,marketId})=>[
  {scope:'ACTUAL_ACCOUNT',accountRef:ACCOUNT,assetId,assetKind:'OUTCOME_TOKEN',marketId,amount:'3'},
  {scope:'EXTERNAL_CLEARING',accountRef:'clearing-venue',assetId,assetKind:'OUTCOME_TOKEN',marketId,amount:'-3'},
  {scope:'UNATTRIBUTED',accountRef:ACCOUNT,assetId,assetKind:'OUTCOME_TOKEN',marketId,amount:'3'},
  {scope:'EXTERNAL_CLEARING',accountRef:'clearing-attribution',assetId,assetKind:'OUTCOME_TOKEN',marketId,amount:'-3'},
 ]);
 const appended=r.u.ledger.append({ledgerTransactionId:id,eventType:'RECONCILIATION_CORRECTION',environment:'PAPER',accountRef:ACCOUNT,source:'internal',occurredAt:'2026-10-03T00:00:00Z',entries});
 expect(appended.ok,JSON.stringify(appended)).toBe(true);if(!appended.ok)return;r.u.ledger=appended.value.ledger;
 r.u.world.adjustPosition(YES,'3');r.u.world.adjustPosition(NO,'3');
 const arrivals=projectedHoldings(projectLedger(r.u.ledger),ACCOUNT).unattributedArrivals;
 expect(arrivals).toHaveLength(2);
 await r.p.coordinator.reconcile();const breaks=r.p.journal.unresolvedBreaks();const halts=halted(r.p);
 for(const b of breaks)await r.p.coordinator.releaseQuarantine({breakId:b.breakId,operatorRef:'operator',reason:'acknowledge only the arrival named by this break'});
 const result=await r.p.coordinator.reconcile();
 trace('R3-C',JSON.stringify({arrivals,breaks,halts,result}));
 expect(new Set(halts.map(x=>x.marketId))).toEqual(new Set([MARKET,MARKET_NO]));
});
