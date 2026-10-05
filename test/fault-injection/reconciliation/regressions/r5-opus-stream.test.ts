/**
 * WP-290 r6: a named regression, the verifiers' round-5 reproductions kept in the suite: Opus's round-5 stream control (P5-STREAM-CTL).
 * Its diagnostic logging goes to `trace` (a no-op): it asserted nothing.
 * Source: `r5-stream.probe.ts` (the reviewers' probe, repointed to this tree; `Loose` for its raw-answer rewrites).
 */

import { expect, it } from 'vitest';
import { ready, submitOne, sequence, type Ready } from '../support/scenario.js';
import { streamTrade } from '../support/harness.js';
import { trace, type Loose } from "../support/loose.js";

function unresolved(r: Ready) { return r.p.journal.unresolvedBreaks().map((v) => [v.breakClass, v.status, v.subjectKey]); }

it('P5-STREAM-CTL (pre-existing class): the attempt order x named only by the stream (a partial fill); x then not found by id and not listed', async () => {
  const r = await ready();
  r.u.world.nextTransmission = sequence(['UNKNOWN_EXISTS']);
  const attempt = (await submitOne(r.oms)) as string;
  const salt = r.u.world.receipts.at(-1)!;
  const trade = r.u.world.match(salt, '0.4')!;
  const x = trade.venueOrderId;
  r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade.venueTradeId));
  await r.p.coordinator.settled();
  const retained = r.oms.retainedEvidence().map((e) => e.venueOrderId);
  r.u.world.faults = {
    listOpenOrders: (answer) => { const a = answer() as Loose; return { ...a, orders: a.orders.filter((o: Loose) => o.venueOrderId !== x) }; },
    readOrder: (id, answer) => (id === x ? { route: '/data/order', found: false } : answer()),
    listTrades: (answer) => { const a = answer() as Loose; return { ...a, trades: a.trades.filter((t: Loose) => t.venueTradeId !== trade.venueTradeId) }; },
  };
  const reports = [];
  for (let i = 0; i < 4; i += 1) { reports.push(await r.p.coordinator.reconcile()); r.u.clock.t += r.u.policy.quiescenceHorizonMs + 1; }
  const answers = r.u.accepted.filter((a) => a.attemptId === attempt);
  trace('P5-STREAM-CTL', JSON.stringify({ x, retained,
    runs: reports.flatMap((rep) => rep.runs.map((v) => [v.status, v.resumed, v.detections.map((d) => d.breakClass), v.answers.map((a) => [a.verdict, a.accepted])])),
    answers, unresolved: unresolved(r), paused: r.oms.paused, violations: [...r.u.violations, ...r.u.world.violations] }));
  expect(answers).toEqual([]);
});
