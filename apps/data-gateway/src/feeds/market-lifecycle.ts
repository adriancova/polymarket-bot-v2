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
 * ## The response is attributed by REQUEST, not by content (r1, MEDIUM-2)
 *
 * D-30 does not record the `conditionId` property of the response, so this
 * feed may not interpret it and does not: a body is attributed to the
 * configured market whose `gammaMarketId` the request carried. The
 * consequence, stated plainly: a MIS-POINTED `gammaMarketId` opens THIS
 * market on ANOTHER market's readiness, silently, and nothing here can
 * notice — until the next venue round establishes the response's
 * `conditionId`, at which point a mismatch must refuse the poll with an
 * incident. Verifying `gammaMarketId` before enabling the feed is an
 * operator obligation (`infra/compose/data-gateway/README.md`).
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
 * says so): a geo-restricted market with an open book opens. Pinned by
 * `test/integration/data-gateway/univ-4-market-lifecycle.test.ts` (the
 * not-ready → ready → closed sequence; the base pin's absence assertions
 * rewritten into it).
 *
 * **R2 — `openedAt` is STABLE across restarts, and honest.** The fold
 * refuses a `MarketOpened` whose `openedAt` differs from the one already
 * recorded (`packages/universe/src/lifecycle.ts` `applyOpened`). The rule:
 * the configured `openTime` when it is present, already past at the
 * observation, AND no NOT-ready poll was journaled for this market at or
 * after it (r1, LOW-2: a market the venue reported not ready after
 * `openTime` demonstrably did not open at `openTime`; the ledger records the
 * first such observation, `notReadyAfterOpenTimeAt`, so a restart mid-wait
 * keeps the history); otherwise the first ready observation's receipt
 * instant (`firstReadyObservedAt`). BOTH branches are persisted in the
 * lifecycle ledger (`../lifecycle-ledger.ts`) BEFORE the event is
 * dispatched, so a restart re-reads the instant rather than minting one —
 * whether the first emission was published, halted, or lost to a crash
 * between dispatch and confirmation. Configuration-first is honest where it
 * applies: the review fixed the schedule, the venue's own `startDate` has
 * no documented semantics, and a past `openTime` with no contrary
 * observation is the reviewed instant. When the venue is ready BEFORE the
 * configured `openTime`, the venue's state wins over the schedule (R1: the
 * market IS open) and the observation instant is used. On restart a market
 * whose open is CONFIRMED is not re-announced (the trader's own lifecycle
 * marking is unguarded, `apps/trader/src/market-state.ts` `markLifecycle`,
 * so a replay after a `MarketClosing` would regress a CLOSING market to
 * OPEN there); an UNCONFIRMED open is re-emitted with the persisted instant
 * (next section). Pinned by the restart tests, which fail if the ledger read
 * is removed.
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
 * venue's catalog said the market was no longer accepting orders". After it
 * is CONFIRMED, the market is terminal for this feed and is not polled
 * again: nothing further can be emitted (`MarketResolved` is the
 * WebSocket's, from `market_resolved`, not this feed's), and a re-opened
 * book cannot be expressed (the fold refuses `MarketOpened` after CLOSING).
 *
 * **R5 — a market observed `closed === true` or `archived === true` BEFORE
 * it was ever OPEN emits nothing and opens an incident**
 * (`GATEWAY_LIFECYCLE_CONFIG_CONTRADICTED`, NOTIFY): the configuration
 * disagrees with the venue, and the venue is authority on its own state. The
 * market is terminal for this feed, and the incident is raised again at
 * EVERY start that skips it (r1, LOW-5), so a `gammaMarketId` corrected
 * after the fact is not dead silently: the operator sees the standing
 * contradiction and removes the record.
 *
 * **R6 — a readiness that turns FALSE while OPEN through `active === false`
 * or `archived === true` alone** (neither `closed === true` nor
 * `acceptingOrders === false` says so) emits nothing and opens
 * `GATEWAY_LIFECYCLE_STATE_UNEXPECTED` (NOTIFY), naming the exact fields
 * that made the predicate false — a `null` `acceptingOrders` included: the
 * venue documents no transition that reads this way, so the feed reports
 * what it saw rather than inventing an event for it.
 *
 * ## Intent before dispatch; confirmation after publication (r1, HIGH-1)
 *
 * Every event goes through ONE path, `#emit`:
 *
 * 1. the chosen instant is written to the ledger as an INTENT — if that write
 *    fails, a PAGE incident opens (`GATEWAY_LIFECYCLE_LEDGER_WRITE_FAILED`),
 *    the event is NOT dispatched, and the phase does not move: an event
 *    whose instant is not durable is exactly the contradiction the ledger
 *    exists to prevent, so the next poll re-derives and re-attempts;
 * 2. the event is dispatched and the publisher's outcome is AWAITED;
 * 3. `published: true` → the ledger records the CONFIRMATION;
 *    `published: false` — publication halted (including the gateway's
 *    designed recording-only startup mode, `run.ts`), suppressed, refused or
 *    rejected — → a PAGE incident opens (`GATEWAY_LIFECYCLE_EVENT_UNPUBLISHED`)
 *    and the intent stays UNCONFIRMED. The publisher's generic outcome
 *    detail says "the event remains in the WAL", which is true of raw
 *    frames and NOT of this feed's derived events; the incident's own detail
 *    states what is true — the intent is the durable copy and it will be
 *    re-emitted. No retry is attempted in the same epoch: every publication
 *    halt is terminal for the epoch by design and a restart is its recovery.
 *
 * At the next start, an UNCONFIRMED intent is RE-EMITTED with the persisted
 * instant on the first successful poll of that market (so it cites a
 * journaled response of the new epoch, like every other lifecycle
 * envelope), in lifecycle order — opened, scheduled closing, observed
 * closing — and NEVER past a confirmed later event: an OPEN is not re-emitted
 * for a market whose CLOSING is confirmed (the one regression the trader's
 * `markLifecycle` cannot absorb: it refuses only to leave a resolution,
 * `ROLLOVER-1` r4); a same-instant `MarketOpened`
 * replay is idempotent for the universe fold. **The replay STOPS at the
 * first event that is not confirmed** (r2, MEDIUM-R1): an intent write that
 * failed, or a dispatch the publisher did not publish, ends the poll's
 * replay before any LATER event is attempted — after a halt nothing later
 * could publish anyway, and after a non-halting rejection a later event
 * must not overtake an earlier one, because a confirmed later CLOSING would
 * make the guard above (correctly) refuse the OPEN forever. The order the
 * header promises — `MarketOpened` before every `MarketClosing` — is kept by
 * refusing to emit out of order, not by hoping the earlier event lands. The
 * same rule governs a FRESH derivation: a closing derived while the
 * market's open (or its scheduled closing) is unconfirmed has its intent
 * persisted and is NOT dispatched (`eventsHeldBack`); the next epoch
 * replays it behind the event it follows. A
 * terminal market with an unconfirmed closing is polled every interval
 * until that closing is CONFIRMED (budget-bounded: one request per
 * interval). The first round wrote the ledger once, after a fire-and-forget
 * dispatch, so a halt sealed an instant nobody received and the next epoch
 * skipped the market forever (the review's reproduction); this section is
 * what closed it.
 *
 * The `GATEWAY_LIFECYCLE_EVENT_UNPUBLISHED` incident is raised at the END of
 * a poll that left anything unpublished, and its detail lists EVERY
 * unconfirmed intent the ledger then holds for the market (event kind and
 * instant), so an open followed by its scheduled closing in one halted poll
 * is one incident naming both (r2, LOW-R1). The incident registry dedups
 * the key while it is open; when a later poll leaves a DIFFERENT set of
 * intents unconfirmed, the standing incident is closed and a fresh one
 * names the whole set.
 *
 * ## Raw before derived, and nothing silent (acceptances 1–4 inherited)
 *
 * Every response body — 2xx or not, and even one that arrives after
 * `stop()` (r1, LOW-3) — is journaled to the WAL FIRST, as a raw frame with
 * `source: "polymarket"`, the request URL as `endpoint`, a per-request
 * connection id, and `subscriptionGeneration: 0` (a polled surface has no
 * subscription; stated rather than invented). Only then is the status
 * judged and the door run, and every derived event is dispatched with a
 * `causationId` naming the journaled response, through the SAME dispatcher,
 * sequencer and publisher as every other feed. If the WAL refused the
 * frame, NOTHING is derived from it and a PAGE incident opens (the
 * `feeds/polymarket.ts` rule). A poll failure — transport, non-2xx, or a
 * body the door refuses — opens a NOTIFY incident scoped to the market
 * (`GATEWAY_LIFECYCLE_POLL_FAILED` / `GATEWAY_LIFECYCLE_STATE_INVALID`) and
 * derives nothing, and that market's next valid poll closes both
 * (`C1-HALTS`: the close is published, so a consumer un-pauses); `consecutiveFailureThreshold` failed polls in a row is a
 * STALL: `FeedStale` is published and the gateway's `GATEWAY_FEED_STALL`
 * incident opens exactly as it does for a silent socket (acceptance 2), and
 * the next successful poll closes the episode. A poll cycle that would
 * overlap a still-running one is skipped and counted, never stacked.
 *
 * ## The ledger's identity checks at start (r1, LOW-5)
 *
 * A loaded record whose `conditionId`/`gammaMarketId` pair disagrees with
 * the configuration for the same `internalMarketId` REFUSES THE START
 * (`GatewayConfigurationError`, so `DataGateway.create` fails
 * transactionally): a re-used internal id must not inherit another market's
 * phase. A record whose `internalMarketId` the configuration no longer
 * names is carried, never deleted, and named in a NOTIFY incident
 * (`GATEWAY_LIFECYCLE_LEDGER_FOREIGN_RECORD`) at every start.
 *
 * ## Admitted series windows (`ROLLOVER-1`, ADR-030)
 *
 * A window the series-admission feed ADMITS (`./series-admission.ts`) is
 * added to this feed at run time ({@link MarketLifecycleFeedDriver.addMarket})
 * with its `gammaMarketId` — the `Market.id` of the documented keyset read,
 * which is the `id` `GET /markets/{id}` takes (S-D34: the path parameter
 * `pathId` is an integer, the `Market` schema's `id` the market's own id) —
 * and its SCHEDULE as `openTime`/`closeTime`: the interval its title states
 * (ruling Q3), exactly as a reviewed configuration states a configured
 * market's. Every rule above applies to it unchanged. A torn-down window is
 * removed ({@link MarketLifecycleFeedDriver.removeMarket}): it is polled no
 * more, and its ledger record, once its retention has passed, is pruned by
 * the admission feed rather than carried as a FOREIGN record — a record whose
 * internal id is a derived window id (`isAdmittedWindowRecord`) is never
 * reported foreign: its window was admitted, not configured.
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
 * when both are emitted; each event is PUBLISHED at most once per market
 * across restarts, and a re-emission after an unconfirmed attempt carries
 * the same instant; every lifecycle envelope's `causationId` names a
 * journaled raw response of its own epoch with a strictly lower `ingestSeq`.
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
import { GatewayConfigurationError } from "../errors.js";
import { GATEWAY_INTERNAL_CHANNEL } from "../incidents.js";
import type { GatewayJournal } from "../journal.js";
import type { LifecycleLedger, LifecycleLedgerRecord } from "../lifecycle-ledger.js";
import type { CancelScheduled, GatewayClock, GatewayReceipt, GatewayTimers } from "../ports.js";
import { isoFromMs, takeReceipt } from "../ports.js";

/** Where one configured market stands with this feed. */
export type LifecyclePhase =
  /** Configured; the venue has not yet been observed trade-ready. */
  | "PENDING"
  /** The `MarketOpened` intent is persisted (this epoch or a previous one). */
  | "OPEN"
  /** The observed `MarketClosing` intent is persisted; nothing more can be. */
  | "CLOSED_OBSERVED"
  /** Observed closed/archived before ever opening (R5). Not polled. */
  | "CONTRADICTED";

/** The three events this feed can owe a market, in lifecycle order. */
type LifecycleEventKind = "opened" | "scheduledClosing" | "observedClosing";

/** The journaled response an emission cites. */
interface CitedFrame {
  readonly receipt: GatewayReceipt;
  readonly rawFrameIngestSeq: string;
  readonly connectionId: string;
}

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
  /**
   * `ROLLOVER-1`: whether a ledger record belongs to an ADMITTED series window
   * (its internal id is the window's derived id), so it is not reported as a
   * foreign record when the configuration does not name it. Absent: none is.
   */
  readonly isAdmittedWindowRecord?: (record: LifecycleLedgerRecord) => boolean;
}

export interface MarketLifecycleDriverMetrics {
  readonly polls: number;
  readonly pollFailures: number;
  readonly consecutiveFailures: number;
  readonly cyclesSkippedOverlapping: number;
  readonly framesRecorded: number;
  readonly framesRefusedByWal: number;
  /** Responses journaled after `stop()`, deliberately not derived from (LOW-3). */
  readonly framesJournaledAfterStop: number;
  readonly derivationsSuppressedUnrecorded: number;
  /** Fresh intents this epoch dispatched (replays are counted separately). */
  readonly marketOpenedEmitted: number;
  readonly marketClosingScheduledEmitted: number;
  readonly marketClosingObservedEmitted: number;
  /** Unconfirmed intents from an earlier epoch re-emitted with their persisted instant. */
  readonly replaysEmitted: number;
  /** Dispatches the publisher did not publish (halted, suppressed, refused, rejected). */
  readonly eventsUnpublished: number;
  /** The publisher's reason for the most recent unpublished dispatch, verbatim. */
  readonly lastUnpublishedReason: string | undefined;
  /** Intents persisted but NOT dispatched because an earlier event is unconfirmed (r2). */
  readonly eventsHeldBack: number;
  /** Dispatches the publisher confirmed. */
  readonly eventsConfirmed: number;
  readonly contradictions: number;
  readonly stallsObserved: number;
  readonly ledgerWriteFailures: number;
  /** Ledger records at start whose market the configuration no longer names. */
  readonly ledgerForeignRecords: number;
  readonly phases: Readonly<Record<string, LifecyclePhase>>;
}

interface MarketState {
  readonly config: MarketConfig;
  readonly gammaMarketId: string;
  phase: LifecyclePhase;
  /** Unconfirmed intents from an earlier epoch still to be re-emitted this epoch. */
  replayOwed: boolean;
  /** Set by `#emit` when a dispatch of this poll went unpublished; reported once per poll. */
  unpublishedThisPoll: boolean;
  /** The set of unconfirmed intents the standing incident names, so a grown set re-raises. */
  reportedUnconfirmed: string | undefined;
}

/** The phase a ledger record puts a market in at start. */
function phaseFromLedger(record: LifecycleLedgerRecord | undefined): LifecyclePhase {
  if (record === undefined) return "PENDING";
  if (record.contradictedAt !== undefined) return "CONTRADICTED";
  if (record.observedClosesAt !== undefined) return "CLOSED_OBSERVED";
  if (record.openedAt !== undefined) return "OPEN";
  return "PENDING";
}

/**
 * The unconfirmed intents a record still owes, in lifecycle order, never
 * past a confirmed later event (module header, "Intent before dispatch").
 */
function owedReplays(record: LifecycleLedgerRecord): readonly LifecycleEventKind[] {
  if (record.observedClosingConfirmedAt !== undefined) return [];
  const owed: LifecycleEventKind[] = [];
  if (record.scheduledClosingConfirmedAt === undefined) {
    if (record.openedAt !== undefined && record.openedConfirmedAt === undefined) {
      owed.push("opened");
    }
    if (record.scheduledClosesAt !== undefined) {
      owed.push("scheduledClosing");
    }
  }
  if (record.observedClosesAt !== undefined) {
    owed.push("observedClosing");
  }
  return owed;
}

/** Whether a market with this record still needs a poll (terminal AND confirmed → no). */
function stillPolled(phase: LifecyclePhase, record: LifecycleLedgerRecord | undefined): boolean {
  if (phase === "CONTRADICTED") return false;
  if (phase === "CLOSED_OBSERVED") {
    return record?.observedClosingConfirmedAt === undefined;
  }
  return true;
}

export class MarketLifecycleFeedDriver {
  readonly #options: MarketLifecycleDriverOptions;
  #markets: MarketState[];
  readonly #connectionIds: ConnectionIdFactory;
  readonly #foreignRecords: readonly LifecycleLedgerRecord[];
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
  #framesJournaledAfterStop = 0;
  #suppressedUnrecorded = 0;
  #openedEmitted = 0;
  #scheduledClosingEmitted = 0;
  #observedClosingEmitted = 0;
  #replaysEmitted = 0;
  #eventsUnpublished = 0;
  #eventsConfirmed = 0;
  #contradictions = 0;
  #stallsObserved = 0;
  #ledgerWriteFailures = 0;
  #lastUnpublishedReason: string | undefined;
  #eventsHeldBack = 0;

  constructor(options: MarketLifecycleDriverOptions) {
    this.#options = options;
    this.#connectionIds = new ConnectionIdFactory(options.feedId);
    const configured = new Set<string>();
    this.#markets = options.markets.map((config) => {
      configured.add(config.internalMarketId);
      const gammaMarketId = config.gammaMarketId;
      if (gammaMarketId === undefined) {
        // Unreachable through `parseGatewayConfig`, which refuses it; kept so
        // this driver cannot be built into a state it cannot poll from.
        throw new GatewayConfigurationError(
          `the lifecycle feed cannot poll market ${config.internalMarketId}: no gammaMarketId`,
        );
      }
      const record = options.ledger.get(config.internalMarketId);
      if (
        record !== undefined &&
        (record.conditionId !== config.conditionId || record.gammaMarketId !== gammaMarketId)
      ) {
        // LOW-5: a re-used internal id must not inherit another market's phase.
        throw new GatewayConfigurationError(
          "the lifecycle ledger holds a record for this internalMarketId under a different conditionId/gammaMarketId pair; a re-used internal id must not inherit another market's lifecycle — repair the configuration or remove the record",
          {
            internalMarketId: config.internalMarketId,
            configured: { conditionId: config.conditionId, gammaMarketId },
            recorded: { conditionId: record.conditionId, gammaMarketId: record.gammaMarketId },
          },
        );
      }
      return {
        config,
        gammaMarketId,
        phase: phaseFromLedger(record),
        replayOwed: record !== undefined && owedReplays(record).length > 0,
        unpublishedThisPoll: false,
        reportedUnconfirmed: undefined,
      };
    });
    this.#foreignRecords = options.ledger
      .records()
      .filter(
        (record) =>
          !configured.has(record.internalMarketId) && options.isAdmittedWindowRecord?.(record) !== true,
      );
  }

  /**
   * `ROLLOVER-1`: adds an ADMITTED window to the feed (module header). Its
   * `gammaMarketId` and `openTime`/`closeTime` are required. The same identity
   * check as at construction applies: a ledger record for this internal id
   * under another condition/gamma id refuses the window (`GatewayConfigurationError`).
   * Adding a window already polled is a no-op.
   */
  addMarket(config: MarketConfig): void {
    if (this.#markets.some((market) => market.config.internalMarketId === config.internalMarketId)) return;
    const gammaMarketId = config.gammaMarketId;
    if (gammaMarketId === undefined || config.parameters.openTime === undefined || config.parameters.closeTime === undefined) {
      throw new GatewayConfigurationError(
        `the lifecycle feed cannot poll admitted window ${config.internalMarketId}: it needs its gammaMarketId and its scheduled open and close`,
      );
    }
    const record = this.#options.ledger.get(config.internalMarketId);
    if (record !== undefined && (record.conditionId !== config.conditionId || record.gammaMarketId !== gammaMarketId)) {
      throw new GatewayConfigurationError(
        "the lifecycle ledger holds a record for this admitted window's internalMarketId under a different conditionId/gammaMarketId pair",
        {
          internalMarketId: config.internalMarketId,
          admitted: { conditionId: config.conditionId, gammaMarketId },
          recorded: { conditionId: record.conditionId, gammaMarketId: record.gammaMarketId },
        },
      );
    }
    this.#markets = [
      ...this.#markets,
      {
        config,
        gammaMarketId,
        phase: phaseFromLedger(record),
        replayOwed: record !== undefined && owedReplays(record).length > 0,
        unpublishedThisPoll: false,
        reportedUnconfirmed: undefined,
      },
    ];
  }

  /**
   * `ROLLOVER-1`: removes a torn-down window: it is polled no more. Its ledger
   * record is kept (the admission feed prunes it after its retention).
   * Answers whether it was polled.
   */
  removeMarket(internalMarketId: string): boolean {
    const before = this.#markets.length;
    this.#markets = this.#markets.filter((market) => market.config.internalMarketId !== internalMarketId);
    return this.#markets.length !== before;
  }

  /** `ROLLOVER-1`: the lifecycle phase of one polled market, if it is polled. */
  phaseOf(internalMarketId: string): LifecyclePhase | undefined {
    return this.#markets.find((market) => market.config.internalMarketId === internalMarketId)?.phase;
  }

  /**
   * Raises the standing conditions the ledger carries (LOW-5), polls once
   * immediately, then every interval.
   */
  start(): void {
    for (const record of this.#foreignRecords) {
      this.#options.dispatcher.openIncident({
        scope: `${this.#options.feedId}:${record.internalMarketId}`,
        reasonCode: "GATEWAY_LIFECYCLE_LEDGER_FOREIGN_RECORD",
        severity: "NOTIFY",
        detail: `the lifecycle ledger holds a record for market ${record.internalMarketId} (conditionId ${record.conditionId}, gammaMarketId ${record.gammaMarketId}) that the configuration no longer names; it is carried, not deleted, and derives nothing`,
        feedId: this.#options.feedId,
      });
    }
    for (const market of this.#markets) {
      if (market.phase === "CONTRADICTED") {
        this.#openMarketIncident(
          market,
          "GATEWAY_LIFECYCLE_CONFIG_CONTRADICTED",
          "NOTIFY",
          `the lifecycle ledger records this market as contradicted by the venue (closed/archived before it was ever observed open) at ${
            this.#record(market)?.contradictedAt ?? "an unrecorded instant"
          }; it is not polled — review the configuration and remove the record once corrected`,
        );
      }
    }
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
    // A snapshot of the list: an admitted window added or removed during the
    // cycle (`ROLLOVER-1`) takes effect from the next cycle.
    for (const market of [...this.#markets]) {
      if (this.#stopped) return;
      if (!market.replayOwed && !stillPolled(market.phase, this.#record(market))) continue;
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

    // Raw before anything (acceptance 1): the response body is journaled
    // whatever its status — and whether or not `stop()` has been called
    // meanwhile (LOW-3) — and a refused frame derives nothing.
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
    if (this.#stopped) {
      // Journaled, counted, and NOT derived from: the gateway is stopping and
      // its publisher and ledger are about to close.
      this.#framesJournaledAfterStop += 1;
      return;
    }

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
    // `C1-HALTS` (DQ-CLOSE): THIS market's own poll answered with a valid
    // state, so its own poll-failure incidents end here — and only its own:
    // another market's failure is not cleared by this market's success.
    this.#closeMarketPollIncidents(market);
    const frame: CitedFrame = { receipt, rawFrameIngestSeq: outcome.ingestSeq, connectionId };
    if (market.replayOwed) {
      const replayed = await this.#replay(market, frame);
      if (!replayed) {
        // r2 (MEDIUM-R1): an owed event did not land; nothing derived from
        // this poll may overtake it. The poll is reported and ends here.
        this.#reportUnpublished(market);
        return;
      }
    }
    await this.#derive(market, verdict.state, frame);
    this.#reportUnpublished(market);
  }

  /**
   * Raises `GATEWAY_LIFECYCLE_EVENT_UNPUBLISHED` once per poll that left a
   * dispatch unpublished, naming EVERY unconfirmed intent the ledger holds
   * for the market (r2, LOW-R1). A standing incident is closed and re-raised
   * when the set it named has changed.
   */
  #reportUnpublished(market: MarketState): void {
    if (!market.unpublishedThisPoll) return;
    market.unpublishedThisPoll = false;
    const owed = this.#unconfirmedIntents(market);
    const signature = owed.join("|");
    if (market.reportedUnconfirmed === signature) {
      return; // the standing incident already names exactly this set
    }
    if (market.reportedUnconfirmed !== undefined) {
      this.#options.dispatcher.markIncidentClosed(
        `${this.#options.feedId}:${market.config.internalMarketId}`,
        "GATEWAY_LIFECYCLE_EVENT_UNPUBLISHED",
      );
    }
    market.reportedUnconfirmed = signature;
    this.#openMarketIncident(
      market,
      "GATEWAY_LIFECYCLE_EVENT_UNPUBLISHED",
      "PAGE",
      `${String(owed.length)} lifecycle event(s) for market ${market.config.internalMarketId} are owed to the stream — dispatched but not published (${this.#lastUnpublishedReason ?? "no publisher reason recorded"}), or held back behind an unconfirmed earlier event: ${owed.join("; ")}. Each intent is persisted in the lifecycle ledger and will be re-emitted with the same instant, in order, at the next start — the publisher's "remains in the WAL" describes raw frames, not these derived events`,
    );
  }

  /** Every unconfirmed intent the ledger holds for the market, in lifecycle order, rendered. */
  #unconfirmedIntents(market: MarketState): readonly string[] {
    const record = this.#record(market);
    if (record === undefined) return [];
    const owed: string[] = [];
    if (record.openedAt !== undefined && record.openedConfirmedAt === undefined) {
      owed.push(`MarketOpened openedAt ${record.openedAt}`);
    }
    if (record.scheduledClosesAt !== undefined && record.scheduledClosingConfirmedAt === undefined) {
      owed.push(`MarketClosing (scheduled) closesAt ${record.scheduledClosesAt}`);
    }
    if (record.observedClosesAt !== undefined && record.observedClosingConfirmedAt === undefined) {
      owed.push(`MarketClosing (observed) closesAt ${record.observedClosesAt}`);
    }
    return owed;
  }

  /**
   * Re-emits the unconfirmed intents an earlier epoch left, citing this
   * epoch's journaled response. Returns `true` when every owed event was
   * confirmed; `false` the moment one was not — and STOPS there (r2,
   * MEDIUM-R1): a later event must never overtake an earlier one.
   */
  async #replay(market: MarketState, frame: CitedFrame): Promise<boolean> {
    // Attempted once per epoch when DISPATCHED: a publication halt is
    // terminal for the epoch, and the ledger's confirmations carry the truth
    // to the next one. Re-owed below only when the intent write itself
    // failed and nothing was dispatched.
    market.replayOwed = false;
    const record = this.#record(market);
    if (record === undefined) return true;
    for (const kind of owedReplays(record)) {
      const current = this.#record(market);
      if (current === undefined) return false;
      let payload: MarketOpenedPayload | MarketClosingPayload;
      if (kind === "opened") {
        if (current.openedAt === undefined) continue;
        payload = this.#openedPayload(market, current.openedAt);
      } else if (kind === "scheduledClosing") {
        if (current.scheduledClosesAt === undefined) continue;
        payload = this.#closingPayload(market, current.scheduledClosesAt);
      } else {
        if (current.observedClosesAt === undefined) continue;
        payload = this.#closingPayload(market, current.observedClosesAt);
      }
      this.#replaysEmitted += 1;
      const outcome = await this.#emit(market, kind, payload, current, frame);
      if (!outcome.intentPersisted) {
        // The disk refused the intent's (idempotent) write: nothing was
        // dispatched, so the replay is still owed and the next poll retries.
        market.replayOwed = true;
        return false;
      }
      if (!outcome.published) {
        // Dispatched, not published: terminal for this epoch; the ledger's
        // confirmations carry the debt to the next one.
        return false;
      }
    }
    return true;
  }

  async #derive(market: MarketState, state: GammaMarketState, frame: CitedFrame): Promise<void> {
    const ready = isGammaMarketTradeReady(state);
    const observedAt = frame.receipt.receivedAt;
    const { config } = market;

    if (market.phase === "PENDING") {
      if (state.closed === true || state.archived === true) {
        // R5: the configuration disagrees with the venue.
        const written = await this.#persist({
          ...this.#baseRecord(market),
          contradictedAt: observedAt,
        });
        if (!written) return;
        market.phase = "CONTRADICTED";
        this.#contradictions += 1;
        this.#openMarketIncident(
          market,
          "GATEWAY_LIFECYCLE_CONFIG_CONTRADICTED",
          "NOTIFY",
          `the venue reports the market ${state.closed === true ? "closed" : "archived"} before it was ever observed open (configured status ${config.parameters.status}); no lifecycle event is derived and the market is not polled again — review the configuration`,
        );
        return;
      }
      const openTime = config.parameters.openTime;
      const openTimeMs = openTime === undefined ? Number.NaN : Date.parse(openTime);
      const openTimePast = Number.isFinite(openTimeMs) && openTimeMs <= frame.receipt.nowMs;
      if (!ready) {
        // R1: not yet; nothing to say — except, for R2, that the venue was
        // NOT ready at or after the reviewed openTime, which is recorded ONCE
        // so a later open cannot honestly claim openTime.
        const record = this.#baseRecord(market);
        if (openTimePast && record.notReadyAfterOpenTimeAt === undefined) {
          await this.#persist({ ...record, notReadyAfterOpenTimeAt: observedAt });
        }
        return;
      }
      // R1 + R2: the venue is trade-ready; choose the stable, honest instant.
      const record = this.#baseRecord(market);
      const fromConfiguration =
        openTime !== undefined && openTimePast && record.notReadyAfterOpenTimeAt === undefined;
      const openedAt = fromConfiguration ? openTime : observedAt;
      const opened = await this.#emit(
        market,
        "opened",
        this.#openedPayload(market, openedAt),
        {
          ...record,
          openedAt,
          openedAtOrigin: fromConfiguration ? "configuration" : "observation",
          firstReadyObservedAt: observedAt,
        },
        frame,
      );
      if (!opened.intentPersisted) return;
      this.#openedEmitted += 1;
      market.phase = "OPEN";
      // R3, when the schedule is already reached at the open: the market is
      // opening into its own close, so the scheduled closing follows on the
      // same poll, after the open — DISPATCHED only behind a published open
      // (r2, MEDIUM-R1); otherwise its intent is persisted and owed.
      const closeTime = config.parameters.closeTime;
      if (closeTime !== undefined && Date.parse(closeTime) <= frame.receipt.nowMs) {
        const scheduled = await this.#emitBehind(
          market,
          "scheduledClosing",
          this.#closingPayload(market, closeTime),
          { ...this.#baseRecord(market), scheduledClosesAt: closeTime },
          frame,
        );
        if (scheduled.intentPersisted) this.#scheduledClosingEmitted += 1;
      }
      return;
    }

    if (market.phase === "CLOSED_OBSERVED" || market.phase === "CONTRADICTED") {
      // Polled only for the replay above; nothing further is derived.
      return;
    }

    // market.phase === "OPEN". Every closing is dispatched only behind
    // CONFIRMED earlier events (r2, MEDIUM-R1); otherwise its intent is
    // persisted and owed, and the next epoch replays in order.
    const earlier = this.#baseRecord(market);
    if (state.closed === true || state.acceptingOrders === false) {
      // R4: the observed closing, at the observation instant.
      const closing = await this.#emitBehind(
        market,
        "observedClosing",
        this.#closingPayload(market, observedAt),
        { ...earlier, observedClosesAt: observedAt },
        frame,
      );
      if (!closing.intentPersisted) return;
      this.#observedClosingEmitted += 1;
      market.phase = "CLOSED_OBSERVED";
      return;
    }
    const closeTime = config.parameters.closeTime;
    if (
      earlier.scheduledClosesAt === undefined &&
      closeTime !== undefined &&
      Date.parse(closeTime) <= frame.receipt.nowMs
    ) {
      // R3: the reviewed schedule is reached and the venue has not shown its
      // own close first. Once per market, ledger-recorded, so a restart after
      // it never re-announces a confirmed one.
      const scheduled = await this.#emitBehind(
        market,
        "scheduledClosing",
        this.#closingPayload(market, closeTime),
        { ...earlier, scheduledClosesAt: closeTime },
        frame,
      );
      if (scheduled.intentPersisted) this.#scheduledClosingEmitted += 1;
    }
    if (!ready) {
      // R6: readiness fell through `active`/`archived` alone (or a null
      // field). Reported, naming the fields; not acted on.
      const falseBy = [
        ...(state.active === true ? [] : [`active=${String(state.active)}`]),
        ...(state.closed === false ? [] : [`closed=${String(state.closed)}`]),
        ...(state.acceptingOrders === true
          ? []
          : [`acceptingOrders=${String(state.acceptingOrders)}`]),
      ];
      this.#openMarketIncident(
        market,
        "GATEWAY_LIFECYCLE_STATE_UNEXPECTED",
        "NOTIFY",
        `the venue's readiness predicate is false for an OPEN market without closed=true or acceptingOrders=false saying so — made false by ${falseBy.join(", ")} (archived=${String(state.archived)}); no documented transition reads this way, so nothing is derived`,
      );
    }
  }

  // --------------------------------------------------------------------------
  // The one emission path: intent → dispatch → confirmation
  // --------------------------------------------------------------------------

  /**
   * Persists the intent, dispatches, awaits the publisher, and confirms or
   * raises. Returns whether the intent was persisted (the phase moves only
   * when it was) — see the module header, "Intent before dispatch".
   */
  async #emit(
    market: MarketState,
    kind: LifecycleEventKind,
    payload: MarketOpenedPayload | MarketClosingPayload,
    intent: LifecycleLedgerRecord,
    frame: CitedFrame,
  ): Promise<{ readonly intentPersisted: boolean; readonly published: boolean }> {
    const eventType = kind === "opened" ? "MarketOpened" : "MarketClosing";
    // 1. The intent, durably, BEFORE the event exists anywhere else. A record
    //    re-emitted from an earlier epoch is already persisted; the put is
    //    idempotent for it.
    if (!(await this.#persist(intent))) {
      return { intentPersisted: false, published: false };
    }
    // 2. The dispatch, awaited.
    const draft: EnvelopeDraft = {
      eventType,
      schemaVersion: 1,
      source: "polymarket",
      sourceChannel: GAMMA_MARKET_REST_CHANNEL,
      connectionId: frame.connectionId,
      subscriptionGeneration: 0,
      payload,
    };
    const outcome = await this.#options.dispatcher.dispatch(draft, {
      receipt: frame.receipt,
      rawFrameIngestSeq: frame.rawFrameIngestSeq,
    });
    // 3. The verdict.
    if (outcome.published) {
      this.#eventsConfirmed += 1;
      const confirmedAt = isoFromMs(this.#options.clock.nowMs());
      const base = this.#baseRecord(market);
      const confirmed: LifecycleLedgerRecord =
        kind === "opened"
          ? { ...base, openedConfirmedAt: confirmedAt }
          : kind === "scheduledClosing"
            ? { ...base, scheduledClosingConfirmedAt: confirmedAt }
            : { ...base, observedClosingConfirmedAt: confirmedAt };
      // A failed confirmation write is already a PAGE incident; the intent
      // stands and the next epoch re-emits an idempotent replay.
      await this.#persist(confirmed);
      return { intentPersisted: true, published: true };
    }
    this.#eventsUnpublished += 1;
    this.#lastUnpublishedReason = `${outcome.reason}: ${outcome.detail}`;
    // Reported at the end of the poll, naming every owed intent (LOW-R1).
    market.unpublishedThisPoll = true;
    return { intentPersisted: true, published: false };
  }

  /**
   * `#emit` when nothing earlier is still owed for the market (the ledger's
   * `owedReplays` of the current record is empty — the same rule the
   * next epoch's replay applies, so a closing behind a permanently
   * unreplayable open still goes out); otherwise the intent alone is
   * persisted (owed, named in the incident, replayed in order by the next
   * epoch) and nothing is dispatched — a later event never overtakes an
   * unconfirmed earlier one (r2, MEDIUM-R1).
   */
  async #emitBehind(
    market: MarketState,
    kind: LifecycleEventKind,
    payload: MarketOpenedPayload | MarketClosingPayload,
    intent: LifecycleLedgerRecord,
    frame: CitedFrame,
  ): Promise<{ readonly intentPersisted: boolean; readonly published: boolean }> {
    if (owedReplays(this.#baseRecord(market)).length === 0) {
      return await this.#emit(market, kind, payload, intent, frame);
    }
    if (!(await this.#persist(intent))) {
      return { intentPersisted: false, published: false };
    }
    this.#eventsHeldBack += 1;
    market.unpublishedThisPoll = true;
    return { intentPersisted: true, published: false };
  }

  /** Writes one record; a failure is a PAGE incident and `false`. */
  async #persist(record: LifecycleLedgerRecord): Promise<boolean> {
    try {
      await this.#options.ledger.put(record);
      return true;
    } catch (error) {
      this.#ledgerWriteFailures += 1;
      this.#options.dispatcher.openIncident({
        scope: this.#options.feedId,
        reasonCode: "GATEWAY_LIFECYCLE_LEDGER_WRITE_FAILED",
        severity: "PAGE",
        detail: `the lifecycle ledger could not be written (${
          error instanceof Error ? error.message : String(error)
        }); the derivation is held back until it can be — an event whose instant is not durable could contradict itself after a restart`,
        feedId: this.#options.feedId,
      });
      return false;
    }
  }

  #record(market: MarketState): LifecycleLedgerRecord | undefined {
    return this.#options.ledger.get(market.config.internalMarketId);
  }

  /** The market's record, or the identity-only seed for a market the ledger has not seen. */
  #baseRecord(market: MarketState): LifecycleLedgerRecord {
    return (
      this.#record(market) ?? {
        internalMarketId: market.config.internalMarketId,
        conditionId: market.config.conditionId,
        gammaMarketId: market.gammaMarketId,
      }
    );
  }

  #openedPayload(market: MarketState, openedAt: string): MarketOpenedPayload {
    return {
      internalMarketId: market.config.internalMarketId,
      conditionId: market.config.conditionId,
      openedAt,
    };
  }

  #closingPayload(market: MarketState, closesAt: string): MarketClosingPayload {
    return {
      internalMarketId: market.config.internalMarketId,
      conditionId: market.config.conditionId,
      closesAt,
    };
  }

  #pollSucceeded(receipt: GatewayReceipt): void {
    this.#lastSuccessfulPollMs = receipt.nowMs;
    if (this.#consecutiveFailures >= this.#options.consecutiveFailureThreshold) {
      // The stall episode ends; a later one opens a fresh incident.
      this.#options.dispatcher.markIncidentClosed(this.#options.feedId, "GATEWAY_FEED_STALL");
    }
    this.#consecutiveFailures = 0;
  }

  /**
   * `C1-HALTS` (DQ-CLOSE): closes one market's `GATEWAY_LIFECYCLE_POLL_FAILED`
   * and `GATEWAY_LIFECYCLE_STATE_INVALID` keys after its own valid poll. The
   * dispatcher publishes a close only for a key that was open, so a healthy
   * market's every poll publishes nothing.
   */
  #closeMarketPollIncidents(market: MarketState): void {
    const scope = `${this.#options.feedId}:${market.config.internalMarketId}`;
    this.#options.dispatcher.markIncidentClosed(scope, "GATEWAY_LIFECYCLE_POLL_FAILED");
    this.#options.dispatcher.markIncidentClosed(scope, "GATEWAY_LIFECYCLE_STATE_INVALID");
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
      framesJournaledAfterStop: this.#framesJournaledAfterStop,
      derivationsSuppressedUnrecorded: this.#suppressedUnrecorded,
      marketOpenedEmitted: this.#openedEmitted,
      marketClosingScheduledEmitted: this.#scheduledClosingEmitted,
      marketClosingObservedEmitted: this.#observedClosingEmitted,
      replaysEmitted: this.#replaysEmitted,
      eventsUnpublished: this.#eventsUnpublished,
      lastUnpublishedReason: this.#lastUnpublishedReason,
      eventsHeldBack: this.#eventsHeldBack,
      eventsConfirmed: this.#eventsConfirmed,
      contradictions: this.#contradictions,
      stallsObserved: this.#stallsObserved,
      ledgerWriteFailures: this.#ledgerWriteFailures,
      ledgerForeignRecords: this.#foreignRecords.length,
      phases,
    };
  }
}
