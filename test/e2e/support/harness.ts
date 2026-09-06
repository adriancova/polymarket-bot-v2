/**
 * `WP-250`'s harness: assembles the REAL merged composition and drives the
 * scenario through it.
 *
 * ## What is real, and what is not
 *
 * REAL, in every test in this tree: `packages/order-book`, `packages/features`,
 * `packages/strategy-runtime`, `packages/strategies/static-bracket`,
 * `packages/capital-allocator`, `packages/risk`, `packages/execution-planner`,
 * `packages/simulation`'s `SimulatedVenue`, `packages/ledger`, `packages/pnl`,
 * and `apps/trader`'s whole composition root and core loop.
 *
 * DOUBLED, and only these: the §12.1 `Clock`, the §4.2 event transport and the
 * §4.2 durable store — using `apps/trader`'s OWN in-memory implementations
 * (`@polymarket-bot/trader/testing`), which are the same doubles the shipped
 * process's integration suite uses. Nothing in this tree re-implements any
 * subject behaviour.
 *
 * ## The venue wiring is PRODUCTION's, not a fixture's
 *
 * `apps/trader/src/main.ts` gives the `SimulatedVenue` a `books` provider that
 * looks the market up through the trader on every read, and an `ExecutionPolicy`
 * whose `timeInForceFor` asks the trader for the value it recorded at plan time
 * and THROWS when there is none. This harness reproduces both shapes verbatim
 * rather than pre-binding a book map, so the seam under test is the shipped one:
 * a venue that answered either question itself would be a second authority.
 *
 * NO DOCKER. NO NETWORK. NO CREDENTIAL. NO SIGNER. Nothing here opens a socket,
 * reads an ambient environment variable or touches the filesystem.
 */

import {
  SimulatedVenue,
  readFeeScheduleSnapshot,
  tier0Model,
  unmodeledRateLimits,
  type BookView,
  type FeeScheduleSnapshot,
  type PlannedOrderView,
  type SimulatedFill,
  type SimulatedOrder,
  type TimeInForce,
} from "@polymarket-bot/simulation";
import {
  createPaperTrader,
  type CreateTraderResult,
  type PaperTrader,
} from "@polymarket-bot/trader";
import { ManualClock, MemoryEventFeed, MemoryTraderStore } from "@polymarket-bot/trader/testing";

import {
  ID_NAMESPACE,
  T_OPEN,
  feeSnapshot,
  paperEnvironment,
  recordedEvents,
  traderConfig,
} from "./scenario.js";

/** Everything the harness holds after a successful assembly. */
export interface Assembled {
  readonly trader: PaperTrader;
  readonly venue: SimulatedVenue;
  readonly store: MemoryTraderStore;
  readonly feed: MemoryEventFeed;
  readonly clock: ManualClock;
}

export interface AssembleOptions {
  readonly config?: Record<string, unknown>;
  readonly env?: Record<string, string | undefined>;
  readonly idNamespace?: string;
}

/** The venue's view of the trader, filled the instant the trader exists. */
interface VenueWiring {
  trader: PaperTrader | undefined;
}

/** A string field of an unparsed document, or a stated fallback. */
function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * Assembles the system. Returns the composition root's own result, refusal and
 * all, because a refusal is an outcome this suite may need to READ rather than
 * an exception it should hide.
 */
export function assemble(options: AssembleOptions = {}): {
  readonly result: CreateTraderResult;
  readonly parts: Assembled | undefined;
} {
  const document = options.config ?? traderConfig();
  const clock = new ManualClock(T_OPEN);
  const store = new MemoryTraderStore();
  const feed = new MemoryEventFeed();

  /**
   * The venue's three inputs, read from the OPERATOR DOCUMENT as `main.ts`
   * reads them — defensively, because the venue is constructed BEFORE
   * `createPaperTrader` runs its doors and a refusal test hands this function a
   * document that is about to be refused.
   *
   * The fallbacks below are never used by a document that starts a trader:
   * `parseTraderConfig` requires every one of these fields and refuses a
   * document without them, so a venue built on a fallback is a venue that is
   * discarded moments later along with the refusal. Reading them defensively
   * rather than asserting them keeps `createPaperTrader` the SINGLE authority
   * on what a valid configuration is — a second opinion here would be a door
   * this suite invented.
   */
  const simulation = (document["simulation"] ?? {}) as Record<string, unknown>;
  // The cast is safe BECAUSE `readFeeScheduleSnapshot` is a DOOR: it validates
  // every field of whatever it is handed and answers a refusal rather than
  // throwing. Declaring the parameter as the validated type is the simulator's
  // choice; handing it an unparsed document is exactly what it exists for.
  const feeDocument = (simulation["feeSchedule"] ?? feeSnapshot()) as FeeScheduleSnapshot;
  const readFees = readFeeScheduleSnapshot(feeDocument);
  const fees = readFees.ok ? readFees : readFeeScheduleSnapshot(feeSnapshot());
  if (!fees.ok) {
    throw new Error(
      `the scenario's own fee snapshot was refused by the simulator: ${fees.refusal.code}`,
    );
  }

  const wiring: VenueWiring = { trader: undefined };

  const venue = new SimulatedVenue({
    clock,
    runMode: "PAPER",
    model: tier0Model({
      fillModelVersion: readString(simulation["fillModelVersion"], "tier0.unconfigured"),
      fillModelParametersHash: readString(simulation["fillModelParametersHash"], "0".repeat(64)),
    }),
    feeSnapshot: fees.value,
    rateLimits: unmodeledRateLimits(
      "no venue rate-limit budget is modelled: §9.13's budget is WP-310's package and does " +
        "not exist yet. This is the same disclosure apps/trader/src/main.ts carries.",
    ),
    policy: {
      /**
       * The composition root's recorded answer, or a refusal — `main.ts`'s
       * shape exactly. A silently assumed `FAK` would change every unfilled
       * remainder's fate, so an order whose value was never recorded gets no
       * guess. `SimulatedVenue.submit` contains this throw into a REFUSED
       * `ExecutionResult`; it never escapes as an exception.
       */
      timeInForceFor(order: PlannedOrderView): TimeInForce {
        const resolved = wiring.trader?.loop.timeInForceFor(order.plannedOrderId);
        if (resolved === undefined) {
          throw new Error(
            `no time-in-force was recorded for planned order ${order.plannedOrderId}; the ` +
              "composition root refuses to assume one (§12.1 ExecutionPolicy)",
          );
        }
        return resolved;
      },
      statedExpiryNsFor(): bigint | undefined {
        return undefined;
      },
      /**
       * `"NOT_OBSERVED"`, as production answers. A book snapshot is an
       * aggregate per level, so this scenario does not observe size added at a
       * price in the same recorded instant; `"0"` would be a claim it never
       * measured.
       */
      sameInstantAdditionsFor() {
        return "NOT_OBSERVED" as const;
      },
    },
    startingCash: readString(simulation["startingCash"], "0"),
    books: {
      book(input): BookView | undefined {
        const market = wiring.trader?.markets.get(input.marketId);
        if (market === undefined) return undefined;
        const tokenId = input.side === "YES" ? market.config.yesTokenId : market.config.noTokenId;
        return {
          internalMarketId: input.marketId,
          tokenId,
          top() {
            const top = market.bookFor(input.side).topOfBook();
            return {
              ...(top.bestBidPrice === undefined ? {} : { bestBidPrice: top.bestBidPrice }),
              ...(top.bestBidSize === undefined ? {} : { bestBidSize: top.bestBidSize }),
              ...(top.bestAskPrice === undefined ? {} : { bestAskPrice: top.bestAskPrice }),
              ...(top.bestAskSize === undefined ? {} : { bestAskSize: top.bestAskSize }),
              ...(top.spread === undefined ? {} : { spread: top.spread }),
            };
          },
          ladder(side) {
            return market
              .bookFor(input.side)
              .levels(side)
              .map((level) => ({ price: level.price, size: level.size }));
          },
        };
      },
    },
  });

  const result = createPaperTrader({
    env: options.env ?? paperEnvironment(),
    config: document,
    clock,
    venue: venue as unknown as Parameters<typeof createPaperTrader>[0]["venue"],
    store,
    idNamespace: options.idNamespace ?? ID_NAMESPACE,
  });
  if (!result.ok) return { result, parts: undefined };
  wiring.trader = result.trader;
  return { result, parts: { trader: result.trader, venue, store, feed, clock } };
}

export interface Run {
  readonly parts: Assembled;
  readonly trader: PaperTrader;
  /** The venue's orders at the end of the run, in the venue's own order. */
  readonly orders: readonly SimulatedOrder[];
  /** The venue's fills at the end of the run, in production order. */
  readonly fills: readonly SimulatedFill[];
}

/** Assembles, or throws with the refusal an operator would have seen. */
export function assembleOrThrow(options: AssembleOptions = {}): Assembled {
  const { result, parts } = assemble(options);
  if (!result.ok) {
    throw new Error(
      `${result.refusal.code}: ${result.refusal.detail}\n  ${result.refusal.issues.join("\n  ")}`,
    );
  }
  if (parts === undefined) throw new Error("assembled without parts");
  return parts;
}

/**
 * Ingests the scenario's recorded events and drains the loop, exactly as the
 * shipped `pump` does: offer to the bounded queue, then drain.
 */
export async function driveScenario(options: AssembleOptions = {}): Promise<Run> {
  const parts = assembleOrThrow(options);
  for (const event of recordedEvents()) {
    const accepted = parts.trader.loop.ingest(event);
    if (!accepted) {
      throw new Error(
        `the bounded ingest queue refused ${event.envelope.eventType} ` +
          `(${event.envelope.eventId}); §8.3 forbids dropping it, so the run cannot continue`,
      );
    }
  }
  await parts.trader.loop.drain();
  return {
    parts,
    trader: parts.trader,
    orders: parts.venue.ordersSnapshot(),
    fills: parts.venue.fills,
  };
}
