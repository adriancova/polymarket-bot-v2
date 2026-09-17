/**
 * The market lifecycle feed (`UNIV-4`, closeout blocker B10): the ONLY
 * producer of `MarketOpened` and `MarketClosing` in the repository, derived
 * from the venue's documented POLLED market-state surface.
 *
 * ## The whole venue licence (`docs/venue/verified-2026-09-16.md` D-30)
 *
 * The venue PUSHES no open/close/closing signal: the market WebSocket's
 * lifecycle events are exactly `new_market` and `market_resolved` (§3,
 * U-12). It DOCUMENTS a polled surface,
 * `GET https://gamma-api.polymarket.com/markets/{id}` (S-D34; S-D23),
 * returning a `Market` with `MarketState { active, closed, archived,
 * acceptingOrders, enableOrderBook, negRisk, startDate, endDate, closedTime }`
 * (all nullable) and the documented readiness predicate
 * `isTradeReady = active && !closed && acceptingOrders`. Six fields carry
 * documented semantics — `active` "Market is deployed and not archived.",
 * `closed` "Market has resolved or been closed, so no further trading is
 * possible.", `acceptingOrders` "Order book is open for new limit and market
 * orders.", `restricted` "Market is geo-restricted for some jurisdictions.",
 * `archived` "Market is archived and read-only: no trading, no resolution
 * updates.", `gameStartTime` "Scheduled start time of the underlying game
 * for a sports market." Every other field (`acceptingOrdersTimestamp`,
 * `ready`, `funded`, `automaticallyActive`, `clearBookOnStart`,
 * `manualActivation`, `closedTime`, `enableOrderBook`, `startDate`,
 * `endDate`, `umaEndDate`, `new`, `startDateIso`/`endDateIso`) carries NO
 * documented semantics beyond its name: read and recorded, never
 * interpreted — in particular `endDate` is a schedule, not an observation.
 * Gamma's general limit is 4,000 requests / 10 s and `/markets` 300 / 10 s
 * (§8). A polled field is a statement about the venue's catalog at poll
 * time, NOT an observed closure event (U-12 stands). Nothing beyond these
 * facts is used here; where a fact was missing (which identifier `{id}`
 * takes) it became configuration (`gammaMarketId`), not a guess.
 *
 * ## The derivation rules, each argued and each pinned
 *
 * **R1 — `MarketOpened` is emitted ONCE per market, when the documented
 * predicate is observed TRUE at poll time for a market the configuration
 * lists.** Never from configuration alone: `parameters.status: "OPEN"` and
 * `openTime` are the review's SCHEDULE, and "subscriptions and the universe
 * directory are configuration, not discovery" (§9.2) — configuration says
 * nothing about the venue's state, and a market opened by its schedule while
 * the venue's book is closed would admit entries nothing can fill. Never for
 * an unconfigured market: the feed polls only the configured list; the venue
 * cannot add a market to it. `restricted` is RECORDED, not acted on (the row
 * says so): a geo-restricted market with an open book opens. Pinned by the
 * reproduction that flipped (`test/integration/data-gateway/univ-4-market-lifecycle.test.ts`)
 * and by the not-ready → ready → closed sequence there.
 *
 * **R2 — `openedAt` is STABLE across restarts.** The fold refuses a
 * `MarketOpened` whose `openedAt` differs from the one already recorded
 * (`packages/universe/src/lifecycle.ts` `applyOpened`). The rule: the
 * configured `openTime`, when present and already past at the observation,
 * IS the instant; otherwise the first observation's receipt instant,
 * persisted in the gateway's lifecycle ledger (`../lifecycle-ledger.ts`) so
 * a restart re-reads it rather than minting a new one. Configuration-first
 * is the honest choice, not merely the convenient one: the review fixed the
 * schedule, and the venue's own `startDate` has no documented semantics, so
 * a configured, past `openTime` is the only instant that is both stable BY
 * CONSTRUCTION (no ledger needed) and reviewed. When the venue is ready
 * BEFORE the configured `openTime`, the venue's state wins over the schedule
 * (R1: the market IS open) and the observation instant is used — the honest
 * instant is the one at which the fact was observed, not a future one. On a
 * restart, a market the ledger records as opened is treated as OPEN and
 * `MarketOpened` is NOT re-emitted: the trader's own lifecycle marking is
 * unguarded (`apps/trader/src/market-state.ts` `markLifecycle`), so a replay
 * after a `MarketClosing` would regress a CLOSING market to OPEN there even
 * though the universe fold would accept the same-instant replay as
 * unchanged. Pinned by the restart test, which fails if the ledger read is
 * removed (a second `MarketOpened` appears in the second epoch).
 *
 * **R3 — the scheduled `MarketClosing` is emitted from the configured
 * `closeTime`, once the market is OPEN, by the first poll whose receipt
 * instant is at or past `closeTime`,** with `closesAt = closeTime`: the
 * reviewed close schedule, which is what `onMarketClosing(ctx,
 * secondsRemaining)` needs (§9.6). It is emitted WHEN the schedule is
 * reached, not at the open, because the frozen contract defines
 * `MarketClosing` as the record that the closing transition "has actually
 * been observed" (`packages/domain/src/events/market-lifecycle.ts`), the
 * universe fold ranks CLOSING above OPEN, and the trader maps CLOSING to §9.8
 * `CLOSE_ONLY` (`apps/trader/src/pipeline.ts` `marketStatusOf`), on which
 * the risk engine refuses every entry (`RISK_MARKET_CLOSE_ONLY`) — an
 * announcement at the open would close every market for entries the moment
 * it opened, which is the B10 symptom by another route. The strategy's own
 * entry and exit cutoffs before the close read the reviewed `closeTime` from
 * the trader's configuration (`observation.market.closeTimeMs`), so nothing
 * is lost by waiting: the event fires at the instant the cutoff arithmetic
 * already counts down to, and `secondsRemaining` is then zero — the
 * end-of-market policy's trigger. A market with no configured `closeTime`
 * gets no scheduled `MarketClosing`. A market first observed ready AFTER its
 * `closeTime` gets `MarketOpened` and the scheduled `MarketClosing` on the
 * same poll, in that order (the fold would refuse the reverse as a
 * regression): the schedule says it is already closing. The scheduled
 * closing does not end polling — R4 may still observe the venue's own close
 * afterwards and reschedule to the observed instant.
 *
 * **R4 — `MarketClosing` is RE-emitted with `closesAt` = the observation's
 * receipt instant when a poll shows `closed === true` or
 * `acceptingOrders === false` while the market is OPEN** — a reschedule the
 * fold accepts ("a close instant is a SCHEDULE, and §9.2 versions
 * `close_time`"). The instant is the poll's receipt, not the venue's
 * `closedTime`, because `closedTime` has no documented semantics and a poll
 * is not an observed event: the honest statement is "at this instant the
 * venue's catalog said the market was no longer accepting orders". After it,
 * the market is terminal for this feed and is not polled again: nothing
 * further can be emitted (`MarketResolved` is the WebSocket's, from
 * `market_resolved`, not this feed's), and a re-opened book cannot be
 * expressed (the fold refuses `MarketOpened` after CLOSING).
 *
 * **R5 — a market observed `closed === true` or `archived === true` BEFORE
 * it was ever OPEN emits nothing and opens an incident**
 * (`GATEWAY_LIFECYCLE_CONFIG_CONTRADICTED`, NOTIFY): the configuration
 * disagrees with the venue, and the venue is authority on its own state. The
 * market is terminal for this feed; the incident is the operator's signal to
 * review the configuration.
 *
 * **R6 — a readiness that turns FALSE while OPEN through `active === false`
 * or `archived === true` alone** (neither `closed` nor `acceptingOrders`
 * says so) emits nothing and opens `GATEWAY_LIFECYCLE_STATE_UNEXPECTED`
 * (NOTIFY): the venue documents no transition that reads this way, so the
 * feed reports what it saw rather than inventing an event for it.
 *
 * ## Raw before derived, and nothing silent (acceptances 1–4 inherited)
 *
 * Every response body — 2xx or not — is journaled to the WAL FIRST, as a raw
 * frame with `source: "polymarket"`, the request URL as `endpoint`, a
 * per-request connection id, and `subscriptionGeneration: 0` (a polled
 * surface has no subscription; stated rather than invented). Only then is
 * the status judged and the door run, and every derived event is dispatched
 * with a `causationId` naming the journaled response, through the SAME
 * dispatcher, sequencer and publisher as every other feed. If the WAL
 * refused the frame, NOTHING is derived from it and a PAGE incident opens
 * (the `feeds/polymarket.ts` rule). A poll failure — transport, non-2xx, or
 * a body the door refuses — opens a NOTIFY incident scoped to the market
 * (`GATEWAY_LIFECYCLE_POLL_FAILED` / `GATEWAY_LIFECYCLE_STATE_INVALID`) and
 * derives nothing; `consecutiveFailureThreshold` failed polls in a row is a
 * STALL: `FeedStale` is published and the gateway's `GATEWAY_FEED_STALL`
 * incident opens exactly as it does for a silent socket (acceptance 2), and
 * the next successful poll closes the episode. A poll cycle that would
 * overlap a still-running one is skipped and counted, never stacked.
 *
 * ## The ordering guarantee, relative to the market-data feed
 *
 * The sequencer and publisher are shared, so every envelope this feed
 * publishes is totally ordered with the market-data feed's by
 * `(gatewayEpoch, ingestSeq)`. But the two feeds are independent producers:
 * the WebSocket delivers the first `BookSnapshot` on subscription, while the
 * first poll's answer arrives after an HTTP round trip. A consumer may
 * therefore NOT assume that `MarketOpened` precedes the first `BookSnapshot`
 * for a market, and must hold a book for a PENDING market — which is what
 * §9.8's fail-closed `PENDING → UNKNOWN` already requires. What a consumer
 * MAY assume: for one market, this feed's `MarketOpened` precedes every
 * `MarketClosing` it emits; a scheduled `MarketClosing` (`closesAt` =
 * `closeTime`) precedes an observed one (`closesAt` = a receipt instant)
 * when both are emitted; at most one of each per market, ever, across
 * restarts; every lifecycle envelope's `causationId` names a journaled raw
 * response with a strictly lower `ingestSeq`.
 *
 * ## What a poll cannot tell an operator
 *
 * A market closed between two polls is seen late by up to one interval; a
 * market that closed and reopened inside one interval is not seen at all.
 * The venue's `endDate` is NOT used, because it has no documented semantics
 * and is a schedule, not an observation — the reviewed `closeTime` carries
 * the schedule. No poll is ever presented as a venue event.
 */

import type { PublicHttpClient } from "@polymarket-bot/polymarket-public";
import {
  GAMMA_MARKET_REST_CHANNEL,
  gammaMarketUrl,
  isGammaMarketTradeReady,
  readGammaMarketBody,
  requestGammaMarket,
  type GammaMarketState,
} from "@polymarket-bot/polymarket-public";
import type {
  DataQualityIncidentOpenedPayload,
  FeedStalePayload,
  IncidentSeverity,
  MarketClosingPayload,
  MarketOpenedPayload,
} from "@polymarket-bot/domain";

import type { MarketConfig } from "../config.js";
import { ConnectionIdFactory } from "../connection-ids.js";
import type { GatewayDispatcher } from "../dispatcher.js";
import type { EnvelopeDraft } from "../envelope.js";
import { GATEWAY_INTERNAL_CHANNEL } from "../incidents.js";
import type { GatewayJournal } from "../journal.js";
import type { LifecycleLedger, LifecycleLedgerRecord } from "../lifecycle-ledger.js";
import type { CancelScheduled, GatewayClock, GatewayReceipt, GatewayTimers } from "../ports.js";
import { isoFromMs, takeReceipt } from "../ports.js";

/** Where one configured market stands with this feed. */
export type LifecyclePhase =
  /** Configured; the venue has not yet been observed trade-ready. */
  | "PENDING"
  /** `MarketOpened` emitted (this epoch or a previous one, per the ledger). */
  | "OPEN"
  /** The observed `MarketClosing` emitted; nothing more can be. Not polled. */
  | "CLOSED_OBSERVED"
  /** Observed closed/archived before ever opening (R5). Not polled. */
  | "CONTRADICTED";

export interface MarketLifecycleDriverOptions {
  readonly feedId: string;
  /** Gamma origin; the URL journaled as `endpoint` is built from it. */
  readonly baseUrl: string | undefined;
  readonly pollIntervalMs: number;
  readonly consecutiveFailureThreshold: number;
  readonly markets: readonly MarketConfig[];
  readonly http: PublicHttpClient;
  readonly journal: GatewayJournal;
  readonly dispatcher: GatewayDispatcher;
  readonly clock: GatewayClock;
  readonly timers: GatewayTimers;
  readonly ledger: LifecycleLedger;
}

export interface MarketLifecycleDriverMetrics {
  readonly polls: number;
  readonly pollFailures: number;
  readonly consecutiveFailures: number;
  readonly cyclesSkippedOverlapping: number;
  readonly framesRecorded: number;
  readonly framesRefusedByWal: number;
  readonly derivationsSuppressedUnrecorded: number;
  readonly marketOpenedEmitted: number;
  readonly marketClosingScheduledEmitted: number;
  readonly marketClosingObservedEmitted: number;
  readonly contradictions: number;
  readonly stallsObserved: number;
  readonly ledgerWriteFailures: number;
  readonly phases: Readonly<Record<string, LifecyclePhase>>;
}

interface MarketState {
  readonly config: MarketConfig;
  readonly gammaMarketId: string;
  phase: LifecyclePhase;
  scheduledClosingEmitted: boolean;
}

/** The phase a ledger record puts a market in at start. */
function phaseFromLedger(record: LifecycleLedgerRecord | undefined): LifecyclePhase {
  if (record === undefined) return "PENDING";
  if (record.contradictedAt !== undefined) return "CONTRADICTED";
  if (record.observedClosesAt !== undefined) return "CLOSED_OBSERVED";
  if (record.openedAt !== undefined) return "OPEN";
  return "PENDING";
}

export class MarketLifecycleFeedDriver {
  readonly #options: MarketLifecycleDriverOptions;
  readonly #markets: MarketState[];
  readonly #connectionIds: ConnectionIdFactory;
  #cancelInterval: CancelScheduled | undefined;
  #cycle: Promise<void> | undefined;
  #stopped = false;
  #lastSuccessfulPollMs: number | undefined;

  #polls = 0;
  #pollFailures = 0;
  #consecutiveFailures = 0;
  #cyclesSkipped = 0;
  #framesRecorded = 0;
  #framesRefusedByWal = 0;
  #suppressedUnrecorded = 0;
  #openedEmitted = 0;
  #scheduledClosingEmitted = 0;
  #observedClosingEmitted = 0;
  #contradictions = 0;
  #stallsObserved = 0;
  #ledgerWriteFailures = 0;

  constructor(options: MarketLifecycleDriverOptions) {
    this.#options = options;
    this.#connectionIds = new ConnectionIdFactory(options.feedId);
    this.#markets = options.markets.map((config) => {
      const gammaMarketId = config.gammaMarketId;
      if (gammaMarketId === undefined) {
        // Unreachable through `parseGatewayConfig`, which refuses it; kept so
        // this driver cannot be built into a state it cannot poll from.
        throw new Error(
          `the lifecycle feed cannot poll market ${config.internalMarketId}: no gammaMarketId`,
        );
      }
      const record = options.ledger.get(config.internalMarketId);
      return {
        config,
        gammaMarketId,
        phase: phaseFromLedger(record),
        scheduledClosingEmitted: record?.scheduledClosesAt !== undefined,
      };
    });
  }

  /** Polls once immediately, then every interval. */
  start(): void {
    this.#kick();
    this.#cancelInterval = this.#options.timers.setInterval(() => {
      this.#kick();
    }, this.#options.pollIntervalMs);
  }

  stop(): void {
    this.#stopped = true;
    this.#cancelInterval?.();
    this.#cancelInterval = undefined;
  }

  /** Waits for an in-flight poll cycle and every ledger rewrite (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.#cycle !== undefined) {
      const cycle = this.#cycle;
      await cycle;
      if (this.#cycle === cycle) break;
    }
    await this.#options.ledger.settle();
  }

  #kick(): void {
    if (this.#stopped) return;
    if (this.#cycle !== undefined) {
      // A cycle still in flight (a slow venue): never stack requests.
      this.#cyclesSkipped += 1;
      return;
    }
    const cycle = this.#runCycle().finally(() => {
      if (this.#cycle === cycle) this.#cycle = undefined;
    });
    this.#cycle = cycle;
  }

  async #runCycle(): Promise<void> {
    // Sequential, never parallel: the fetcher precedent (`snapshot/fetcher.ts`)
    // and the same reason — a fan-out at a rate-limited surface is how a poll
    // becomes a throttled poll.
    for (const market of this.#markets) {
      if (this.#stopped) return;
      if (market.phase === "CLOSED_OBSERVED" || market.phase === "CONTRADICTED") continue;
      await this.#pollMarket(market);
    }
  }

  async #pollMarket(market: MarketState): Promise<void> {
    this.#polls += 1;
    const url = gammaMarketUrl(market.gammaMarketId, this.#options.baseUrl);
    let response;
    try {
      response = await requestGammaMarket({
        http: this.#options.http,
        marketId: market.gammaMarketId,
        ...(this.#options.baseUrl === undefined ? {} : { baseUrl: this.#options.baseUrl }),
      });
    } catch (error) {
      this.#pollFailed(
        market,
        "GATEWAY_LIFECYCLE_POLL_FAILED",
        `the market-state request failed at the transport level: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (this.#stopped) return;

    // Raw before anything (acceptance 1): the response body is journaled
    // whatever its status, and a refused frame derives nothing.
    const receipt = takeReceipt(this.#options.clock);
    const connectionId = this.#connectionIds.next();
    const outcome = this.#options.journal.record({
      source: "polymarket",
      endpoint: url,
      connectionId,
      subscriptionGeneration: 0,
      receipt,
      payloadUtf8: response.bodyUtf8,
    });
    if (!outcome.recorded) {
      this.#framesRefusedByWal += 1;
      this.#suppressedUnrecorded += 1;
      this.#options.dispatcher.openIncident({
        scope: this.#options.feedId,
        reasonCode: "GATEWAY_WAL_FRAME_REFUSED",
        severity: "PAGE",
        detail: `the WAL refused a market-state response (${outcome.reason}): ${outcome.detail}; nothing is derived from an unrecorded response`,
        feedId: this.#options.feedId,
      });
      return;
    }
    this.#framesRecorded += 1;

    if (response.status < 200 || response.status >= 300) {
      this.#pollFailed(
        market,
        "GATEWAY_LIFECYCLE_POLL_FAILED",
        `the market-state request returned HTTP ${String(response.status)}`,
      );
      return;
    }
    const verdict = readGammaMarketBody(response.bodyUtf8);
    if (verdict.status === "invalid") {
      this.#pollFailed(
        market,
        "GATEWAY_LIFECYCLE_STATE_INVALID",
        `the market-state body did not match the documented Market shape: ${verdict.issues.join("; ")}`,
      );
      return;
    }
    this.#pollSucceeded(receipt);
    await this.#derive(market, verdict.state, receipt, outcome.ingestSeq, connectionId);
  }

  async #derive(
    market: MarketState,
    state: GammaMarketState,
    receipt: GatewayReceipt,
    rawFrameIngestSeq: string,
    connectionId: string,
  ): Promise<void> {
    const ready = isGammaMarketTradeReady(state);
    const observedAt = receipt.receivedAt;
    const { config } = market;

    if (market.phase === "PENDING") {
      if (state.closed === true || state.archived === true) {
        // R5: the configuration disagrees with the venue.
        market.phase = "CONTRADICTED";
        this.#contradictions += 1;
        this.#openMarketIncident(
          market,
          "GATEWAY_LIFECYCLE_CONFIG_CONTRADICTED",
          "NOTIFY",
          `the venue reports the market ${state.closed === true ? "closed" : "archived"} before it was ever observed open (configured status ${config.parameters.status}); no lifecycle event is derived and the market is not polled again — review the configuration`,
        );
        await this.#persist({
          ...this.#ledgerRecord(config.internalMarketId),
          contradictedAt: observedAt,
        });
        return;
      }
      if (!ready) {
        return; // R1: not yet; nothing to say.
      }
      // R1 + R2: the venue is trade-ready; choose the stable instant.
      const openTime = config.parameters.openTime;
      const openTimeMs = openTime === undefined ? Number.NaN : Date.parse(openTime);
      const fromConfiguration =
        openTime !== undefined && Number.isFinite(openTimeMs) && openTimeMs <= receipt.nowMs;
      const openedAt = fromConfiguration && openTime !== undefined ? openTime : observedAt;
      const openedPayload: MarketOpenedPayload = {
        internalMarketId: config.internalMarketId,
        conditionId: config.conditionId,
        openedAt,
      };
      this.#dispatch("MarketOpened", openedPayload, receipt, rawFrameIngestSeq, connectionId);
      this.#openedEmitted += 1;
      market.phase = "OPEN";
      let record: LifecycleLedgerRecord = {
        ...this.#ledgerRecord(config.internalMarketId),
        openedAt,
        openedAtOrigin: fromConfiguration ? "configuration" : "observation",
        firstReadyObservedAt: observedAt,
      };
      // R3, when the schedule is already reached at the open: the market is
      // opening into its own close, so the scheduled closing follows on the
      // same poll, after the open.
      const closeTime = config.parameters.closeTime;
      if (closeTime !== undefined && Date.parse(closeTime) <= receipt.nowMs) {
        this.#dispatchScheduledClosing(market, closeTime, receipt, rawFrameIngestSeq, connectionId);
        record = { ...record, scheduledClosesAt: closeTime };
      }
      await this.#persist(record);
      return;
    }

    // market.phase === "OPEN"
    if (state.closed === true || state.acceptingOrders === false) {
      // R4: the observed closing, at the observation instant.
      const closingPayload: MarketClosingPayload = {
        internalMarketId: config.internalMarketId,
        conditionId: config.conditionId,
        closesAt: observedAt,
      };
      this.#dispatch("MarketClosing", closingPayload, receipt, rawFrameIngestSeq, connectionId);
      this.#observedClosingEmitted += 1;
      market.phase = "CLOSED_OBSERVED";
      await this.#persist({
        ...this.#ledgerRecord(config.internalMarketId),
        observedClosesAt: observedAt,
      });
      return;
    }
    const closeTime = config.parameters.closeTime;
    if (
      !market.scheduledClosingEmitted &&
      closeTime !== undefined &&
      Date.parse(closeTime) <= receipt.nowMs
    ) {
      // R3: the reviewed schedule is reached and the venue has not shown its
      // own close first. Once per market, ledger-recorded, so a restart after
      // it never re-announces it.
      this.#dispatchScheduledClosing(market, closeTime, receipt, rawFrameIngestSeq, connectionId);
      await this.#persist({
        ...this.#ledgerRecord(config.internalMarketId),
        scheduledClosesAt: closeTime,
      });
    }
    if (!ready) {
      // R6: readiness fell through `active`/`archived` alone. Reported, not acted on.
      this.#openMarketIncident(
        market,
        "GATEWAY_LIFECYCLE_STATE_UNEXPECTED",
        "NOTIFY",
        `the venue's readiness predicate is false for an OPEN market without closed or acceptingOrders saying so (active=${String(state.active)}, archived=${String(state.archived)}); no documented transition reads this way, so nothing is derived`,
      );
    }
  }

  #dispatchScheduledClosing(
    market: MarketState,
    closeTime: string,
    receipt: GatewayReceipt,
    rawFrameIngestSeq: string,
    connectionId: string,
  ): void {
    const closingPayload: MarketClosingPayload = {
      internalMarketId: market.config.internalMarketId,
      conditionId: market.config.conditionId,
      closesAt: closeTime,
    };
    this.#dispatch("MarketClosing", closingPayload, receipt, rawFrameIngestSeq, connectionId);
    this.#scheduledClosingEmitted += 1;
    market.scheduledClosingEmitted = true;
  }

  #ledgerRecord(internalMarketId: string): LifecycleLedgerRecord {
    return this.#options.ledger.get(internalMarketId) ?? { internalMarketId };
  }

  async #persist(record: LifecycleLedgerRecord): Promise<void> {
    try {
      await this.#options.ledger.put(record);
    } catch (error) {
      // The emitted event is already in the stream; what is at risk is the
      // NEXT epoch's stability. Loud, PAGE: an operator must repair the ledger
      // before the next restart.
      this.#ledgerWriteFailures += 1;
      this.#options.dispatcher.openIncident({
        scope: this.#options.feedId,
        reasonCode: "GATEWAY_LIFECYCLE_LEDGER_WRITE_FAILED",
        severity: "PAGE",
        detail: `the lifecycle ledger could not be written (${
          error instanceof Error ? error.message : String(error)
        }); a restart before it is repaired could mint a contradicting openedAt`,
        feedId: this.#options.feedId,
      });
    }
  }

  #dispatch(
    eventType: "MarketOpened" | "MarketClosing",
    payload: MarketOpenedPayload | MarketClosingPayload,
    receipt: GatewayReceipt,
    rawFrameIngestSeq: string,
    connectionId: string,
  ): void {
    const draft: EnvelopeDraft = {
      eventType,
      schemaVersion: 1,
      source: "polymarket",
      sourceChannel: GAMMA_MARKET_REST_CHANNEL,
      connectionId,
      subscriptionGeneration: 0,
      payload,
    };
    void this.#options.dispatcher.dispatch(draft, { receipt, rawFrameIngestSeq });
  }

  #pollSucceeded(receipt: GatewayReceipt): void {
    this.#lastSuccessfulPollMs = receipt.nowMs;
    if (this.#consecutiveFailures >= this.#options.consecutiveFailureThreshold) {
      // The stall episode ends; a later one opens a fresh incident.
      this.#options.dispatcher.markIncidentClosed(this.#options.feedId, "GATEWAY_FEED_STALL");
    }
    this.#consecutiveFailures = 0;
  }

  #pollFailed(market: MarketState, reasonCode: string, detail: string): void {
    this.#pollFailures += 1;
    this.#consecutiveFailures += 1;
    this.#openMarketIncident(market, reasonCode, "NOTIFY", detail);
    if (this.#consecutiveFailures === this.#options.consecutiveFailureThreshold) {
      this.#stallsObserved += 1;
      const nowMs = this.#options.clock.nowMs();
      const stale: FeedStalePayload = {
        feedId: this.#options.feedId,
        detectedAt: isoFromMs(nowMs),
        ...(this.#lastSuccessfulPollMs === undefined
          ? {}
          : { lastMessageAt: isoFromMs(this.#lastSuccessfulPollMs) }),
        stalenessMs:
          this.#lastSuccessfulPollMs === undefined
            ? 0
            : Math.max(0, nowMs - this.#lastSuccessfulPollMs),
      };
      void this.#options.dispatcher.dispatch({
        eventType: "FeedStale",
        schemaVersion: 1,
        source: "polymarket",
        sourceChannel: GAMMA_MARKET_REST_CHANNEL,
        payload: stale,
      });
      this.#options.dispatcher.openIncident({
        scope: this.#options.feedId,
        reasonCode: "GATEWAY_FEED_STALL",
        severity: "NOTIFY",
        detail: `${String(this.#consecutiveFailures)} consecutive market-state polls failed; the lifecycle feed is stalled and no market can open or close through it until a poll succeeds`,
        feedId: this.#options.feedId,
      });
    }
  }

  /** A NOTIFY/PAGE incident scoped to one market, carrying `affectedMarketIds`. */
  #openMarketIncident(
    market: MarketState,
    reasonCode: string,
    severity: IncidentSeverity,
    detail: string,
  ): void {
    const scope = `${this.#options.feedId}:${market.config.internalMarketId}`;
    this.#options.dispatcher.openIncident(
      { scope, reasonCode, severity, detail, feedId: this.#options.feedId },
      (incidentId) => {
        const payload: DataQualityIncidentOpenedPayload = {
          incidentId,
          openedAt: isoFromMs(this.#options.clock.nowMs()),
          reasonCode,
          severity,
          detail: detail.slice(0, 2000),
          feedId: this.#options.feedId,
          affectedMarketIds: [market.config.internalMarketId],
        };
        return {
          eventType: "DataQualityIncidentOpened",
          schemaVersion: 1,
          source: "internal",
          sourceChannel: GATEWAY_INTERNAL_CHANNEL,
          payload,
        };
      },
    );
  }

  metrics(): MarketLifecycleDriverMetrics {
    const phases: Record<string, LifecyclePhase> = {};
    for (const market of this.#markets) {
      phases[market.config.internalMarketId] = market.phase;
    }
    return {
      polls: this.#polls,
      pollFailures: this.#pollFailures,
      consecutiveFailures: this.#consecutiveFailures,
      cyclesSkippedOverlapping: this.#cyclesSkipped,
      framesRecorded: this.#framesRecorded,
      framesRefusedByWal: this.#framesRefusedByWal,
      derivationsSuppressedUnrecorded: this.#suppressedUnrecorded,
      marketOpenedEmitted: this.#openedEmitted,
      marketClosingScheduledEmitted: this.#scheduledClosingEmitted,
      marketClosingObservedEmitted: this.#observedClosingEmitted,
      contradictions: this.#contradictions,
      stallsObserved: this.#stallsObserved,
      ledgerWriteFailures: this.#ledgerWriteFailures,
      phases,
    };
  }
}
