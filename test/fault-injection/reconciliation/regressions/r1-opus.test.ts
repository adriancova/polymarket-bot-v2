/**
 * WP-290 r6: a named regression, the verifiers' round-1 reproductions kept in the suite: Opus's round-1 probes.
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `opus-own.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { expect, it } from 'vitest';
import { ready, submitOne, reconcileRounds } from '../support/scenario.js';
import { YES } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

class FakeStream {
  readonly pending: Loose[] = [];
  pendingReconciliationRequests() { return [...this.pending]; }
  acknowledgeReconciliationRequest(id: string) { const i = this.pending.findIndex((q) => q.requestId === id); if (i < 0) return false; this.pending.splice(i, 1); return true; }
}

it('CONCURRENT: two same-tick reconcile() calls, then a third during the first run\'s reads', async () => {
  const r = await ready();
  let fired = false; let runningDuring: boolean | null = null; let cPromise: Promise<Loose> | null = null;
  r.u.world.faults.readPositions = (answer) => {
    if (!fired) { fired = true; runningDuring = r.p.coordinator.status().running; cPromise = r.p.coordinator.reconcile(); }
    return answer();
  };
  const [a, b] = await Promise.all([r.p.coordinator.reconcile(), r.p.coordinator.reconcile()]);
  const c: Loose = await (cPromise as Promise<Loose> | null);
  const completions = r.u.journalEvents.filter((e: Loose) => e.kind === 'RUN_COMPLETED').map((e: Loose) => ({ runId: e.runId, status: e.status, detail: e.detail }));
  trace('CONCURRENT', JSON.stringify({ runningDuringFirstRunReads: runningDuring, a: a.runs.map((x: Loose) => [x.status, x.resumed, x.reason]), b: b.runs.map((x: Loose) => [x.status, x.resumed, x.reason]), c: c?.runs.map((x: Loose) => [x.status, x.resumed, x.reason]), completions, paused: r.oms.paused }));
});

it('MALFORMED-stream: one WP-280 request with requestId "" (also left pending in the stream)', async () => {
  const r = await ready();
  const stream = new FakeStream(); r.p.coordinator.bindUserStream(stream as Loose);
  const bad = { requestId: '', cause: 'SOCKET_CLOSED', markets: [] };
  stream.pending.push(bad); r.p.coordinator.onUserStreamOutput({ kind: 'RECONCILIATION_REQUESTED', request: bad });
  const resumed = await reconcileRounds(r, 6);
  const runs = r.u.journalEvents.filter((e: Loose) => e.kind === 'RUN_COMPLETED').slice(1).map((e: Loose) => e.status + ': ' + e.detail);
  const opened = r.u.journalEvents.filter((e: Loose) => e.kind === 'BREAK_OPENED').map((e: Loose) => e.breakClass);
  trace('MALFORMED-stream', JSON.stringify({ resumed, runs, breaksOpened: opened, unresolved: r.p.journal.unresolvedBreaks().map((b) => b.breakClass), paused: r.oms.paused }));
});

it('MALFORMED-stream-once: requestId "" delivered once, NOT left pending in the stream', async () => {
  const r = await ready();
  const stream = new FakeStream(); r.p.coordinator.bindUserStream(stream as Loose);
  r.p.coordinator.onUserStreamOutput({ kind: 'RECONCILIATION_REQUESTED', request: { requestId: '', cause: 'SOCKET_CLOSED', markets: [] } });
  const resumed = await reconcileRounds(r, 6);
  const opened = r.u.journalEvents.filter((e: Loose) => e.kind === 'BREAK_OPENED').map((e: Loose) => e.breakClass);
  const last = r.u.journalEvents.filter((e: Loose) => e.kind === 'RUN_COMPLETED').at(-1) as Loose;
  trace('MALFORMED-stream-once', JSON.stringify({ resumed, lastRun: last.status + ': ' + last.detail, breaksOpened: opened, unresolved: r.p.journal.unresolvedBreaks().map((b) => b.breakClass) }));
});

it('MALFORMED-oms: one OMS-channel request outside the shape', async () => {
  const r = await ready();
  let threw = false;
  try { r.p.coordinator.omsRequester.request({ requestId: 'x' } as Loose); } catch { threw = true; }
  const resumed = await reconcileRounds(r, 6);
  const opened = r.u.journalEvents.filter((e: Loose) => e.kind === 'BREAK_OPENED').map((e: Loose) => e.breakClass);
  const last = r.u.journalEvents.filter((e: Loose) => e.kind === 'RUN_COMPLETED').at(-1) as Loose;
  trace('MALFORMED-oms', JSON.stringify({ threw, resumed, lastRun: last.status + ': ' + last.detail, breaksOpened: opened, unresolved: r.p.journal.unresolvedBreaks().map((b) => b.breakClass) }));
});

it('NOT-REPRODUCED: a run that did not judge holdings clears a holding break', async () => {
  const r = await ready();
  await submitOne(r.oms);
  expect(await reconcileRounds(r, 3)).toBe(true);
  r.u.world.positions.set(YES, '3');
  const run1 = await r.p.coordinator.reconcile();
  const after1 = r.p.journal.unresolvedBreaks().map((b) => b.breakClass);
  r.u.world.match(r.u.world.receipts.at(-1)!, '0.4', { feeAmount: null });
  const run2 = await r.p.coordinator.reconcile();
  const resolvedIn2 = r.u.journalEvents.filter((e: Loose) => e.kind === 'BREAK_RESOLVED' && e.runId === run2.runs[0]?.runId).map((e: Loose) => ({ breakId: e.breakId, resolution: e.resolution, detail: e.detail }));
  const classOf = new Map(r.u.journalEvents.filter((e: Loose) => e.kind === 'BREAK_OPENED').map((e: Loose) => [e.breakId, e.breakClass]));
  trace('NOT-REPRODUCED', JSON.stringify({ run1: run1.runs.map((x: Loose) => [x.status, x.reason]), unresolvedAfterRun1: after1, run2: run2.runs.map((x: Loose) => [x.status, x.reason, x.detections.map((d: Loose) => d.breakClass)]), resolvedInRun2: resolvedIn2.map((e) => ({ ...e, breakClass: classOf.get(e.breakId) })), venueYES: r.u.world.positions.get(YES) }));
});
