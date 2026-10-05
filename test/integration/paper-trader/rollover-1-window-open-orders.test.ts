/**
 * `ROLLOVER-1` r1 (R1-FABLE-05) — a series window's OWN working orders reach
 * §9.8's risk input (`openOrders`: check 18's self-trade guard and checks
 * 16-17's lots).
 *
 * The loop keys its order ownership by REGISTRATION (`instances.ts`: a
 * window's key is `<instanceId>|<marketId>`), so `CoreLoop.#openOrdersFor`
 * must read `#instanceOrders` by `instance.key`. `CAP-1` on `main` rewrote
 * that method with `get(instance.instanceId)`; a merge that keeps that line
 * hands risk NO open order of any window — silently. This pins it: the
 * take-profit a window's bracket rests after its entry is in the risk input
 * of the cancel that withdraws it.
 *
 * A pass-through observer on the risk input builder records what each risk
 * evaluation is handed and changes nothing it passes on
 * (`packages/trading-core/src/loop-order-lifecycle.test.ts`'s pattern).
 */

import { describe, expect, it, vi } from "vitest";

import type * as Pipeline from "../../../packages/trading-core/src/pipeline.js";

const riskInputs = vi.hoisted(() => ({
  calls: [] as { readonly marketId: string; readonly intentType: string; readonly openOrders: readonly { readonly orderId: string; readonly marketId: string; readonly action: string }[] }[],
}));
vi.mock("../../../packages/trading-core/src/pipeline.js", async (importOriginal) => {
  const original = await importOriginal<typeof Pipeline>();
  return {
    ...original,
    buildRiskEvaluationInput(context: Parameters<typeof original.buildRiskEvaluationInput>[0]) {
      riskInputs.calls.push({
        marketId: context.marketConfig.marketId,
        intentType: context.intent.type,
        openOrders: context.openOrders.map((open) => ({ orderId: open.orderId, marketId: open.marketId, action: open.action })),
      });
      return original.buildRiskEvaluationInput(context);
    },
  };
});

import { assembleOrThrow } from "./support/run.js";
import { ENTRY_QUOTE, STOP_QUOTE, SeriesStream } from "./support/series-stream.js";
import { seriesConfig, W1 } from "./support/series-windows.js";

describe("ROLLOVER-1 r1 (R1-FABLE-05): a window's own working orders reach risk's openOrders", () => {
  it("the take-profit W1's bracket rests is in the risk input of the cancel that withdraws it", async () => {
    riskInputs.calls.length = 0;
    const stream = new SeriesStream()
      .tick("2026-10-04T22:16:00.000Z")
      .admit(W1, "2026-10-04T22:16:01.000Z")
      .open(W1, "2026-10-04T22:16:02.000Z")
      .book(W1, "2026-10-04T22:16:03.000Z", ENTRY_QUOTE)
      .tick("2026-10-04T22:16:05.000Z")
      .book(W1, "2026-10-04T22:16:10.000Z", STOP_QUOTE)
      .tick("2026-10-04T22:16:12.000Z");
    const run = assembleOrThrow({ config: seriesConfig(), idNamespace: "rollover-1-r1-open-orders" });
    for (const event of stream.events) run.trader.loop.ingest(event);
    await run.trader.loop.drain();

    const takeProfit = run.parts.venue.ordersSnapshot().find((order) => order.action === "SELL" && order.limitPrice === "0.5");
    expect(takeProfit?.state).toBe("CANCELLED");
    const cancel = riskInputs.calls.find((call) => call.intentType === "CANCEL");
    expect(cancel?.marketId).toBe(W1.marketId);
    expect(cancel?.openOrders).toEqual([{ orderId: takeProfit?.simulatedOrderId, marketId: W1.marketId, action: "SELL" }]);
  });
});
