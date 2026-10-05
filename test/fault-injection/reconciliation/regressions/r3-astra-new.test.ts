/**
 * WP-290 r6: a named regression, the verifiers' round-3 reproductions kept in the suite: astra's round-3 findings (D-A1 .. D-A3).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `astra-r3-new.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import {it,expect} from 'vitest';
import {ready,submitOne,reconcileRounds} from '../support/scenario.js';
import {boot} from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

it('R3-A a missing trade cannot resolve its prior settlement regression',async()=>{
 const r=await ready();await submitOne(r.oms);
 r.u.world.match(r.u.world.receipts.at(-1)!,'0.4',{status:'CONFIRMED'});
 expect(await reconcileRounds(r,6)).toBe(true);
 const p=await boot(r.u);
 r.u.world.faults.listTrades=(answer)=>{const a=answer() as Loose;return {...a,trades:a.trades.map((x: Loose)=>({...x,status:'MATCHED'}))};};
 await p.coordinator.reconcile();
 const b=p.journal.unresolvedBreaks().find(x=>x.breakClass==='READ_REGRESSION')!;expect(b).toBeDefined();
 r.u.world.faults.listTrades=(answer)=>({...answer() as Loose,trades:[]});
 const result=await p.coordinator.reconcile();
 const after=p.journal.breaks().find(x=>x.breakId===b.breakId);
 trace('R3-A',JSON.stringify({result,after}));
 expect(after?.status).toBe('OPEN');
});

it('R3-B FAILED settlement persisted before a crash still requires quarantine on restart',async()=>{
 const r=await ready();await submitOne(r.oms);
 const t=r.u.world.match(r.u.world.receipts.at(-1)!,'0.4',{status:'MINED'})!;
 expect(await reconcileRounds(r,6)).toBe(true);
 t.status='FAILED';
 const apply=r.u.store.apply.bind(r.u.store);
 let killed=false;
 r.u.store.apply=async(writes: Loose)=>{
   const result=await apply(writes);
   if(writes.some((w: Loose)=>w.kind==='APPEND_SETTLEMENT'&&w.settlement.state==='FAILED')){killed=true;r.p.inc.alive=false;throw new Error('crash after durable FAILED');}
   return result;
 };
 await r.p.coordinator.reconcile();
 r.u.store.apply=apply;
 expect(killed).toBe(true);
 const p=await boot(r.u);
 const result=await p.coordinator.reconcile();
 trace('R3-B',JSON.stringify({result,alerts:p.oms?.alerts(),breaks:p.journal.breaks(),halts:r.u.halts,settlements:r.u.store.snapshotSync().settlements}));
 expect(result.resumed).toBe(false);
 expect(p.journal.unresolvedBreaks().length).toBeGreaterThan(0);
});
