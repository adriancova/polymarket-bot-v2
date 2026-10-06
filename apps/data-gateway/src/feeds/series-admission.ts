/**
 * The SERIES-ADMISSION feed (`ROLLOVER-1`; ADR-030; the user's ruling A5 and
 * Q1-Q4): in PAPER and BACKTEST only, a REVIEWED series admits each new window
 * that matches it exactly, so one run spans many windows without a restart.
 *
 * ## The whole cycle
 *
 * Every `pollIntervalMs`, per reviewed series:
 *
 * 1. **Teardown first** (ADR-030 Decision 4.4: "A closed window is torn down
 *    after its resolution is handled"). A live window whose `MarketResolved`
 *    was PUBLISHED is RETIRED `RESOLVED`: its tokens are unsubscribed, the
 *    lifecycle feed stops polling it, the directory releases it, and its
 *    ledger record becomes `RETIRED`, carrying the published resolution.
 *    `ROLLOVER-1` r3 (R3-ASTRA-01): DISPATCHED is not enough. The market
 *    feed hands this feed each resolution with its publication's outcome
 *    (`feeds/polymarket.ts`); the resolution is first recorded on the
 *    window's ledger record as an OBLIGATION, and only a `published: true`
 *    outcome discharges it. A resolution a publication halt swallowed (a halt
 *    is terminal for the epoch, `publisher.ts`) leaves the window ADMITTED,
 *    attached and registered, with a PAGE incident
 *    (`GATEWAY_SERIES_RESOLUTION_UNPUBLISHED`), and the next epoch
 *    re-publishes the recorded payload before anything else is admitted
 *    (step 7); r2 retired the window at dispatch, so the resolution reached
 *    no consumer and a trader holding the window kept it HELD for the rest of
 *    its run. `ROLLOVER-1` r4 (R4-FABLE-01): a resolution whose ledger write
 *    fails is held in memory, owed exactly like a recorded one, and written
 *    again at the start of every cycle until the ledger holds it
 *    (`resolutionsUnrecorded`); its PAGE says whether the resolution is in the
 *    ledger, and that a stop before the write succeeds loses it (the window
 *    then awaits its resolution like one never observed, below).
 *
 *    A window still unresolved `unresolvedTeardownSeconds` (reviewed) after
 *    its scheduled close is NOT retired by a timer (`ROLLOVER-1` r1,
 *    R1-04): a trader may hold a position in it, and only this gateway can
 *    still deliver its resolution. It stays ADMITTED, subscribed and
 *    registered in the directory, AWAITING its resolution, with a NOTIFY
 *    incident naming it (`GATEWAY_SERIES_WINDOW_UNRESOLVED`), and it KEEPS
 *    its cap slot (step 4; `ROLLOVER-1` r2, R2-ASTRA-01 and R2-ASTRA-02): it
 *    is still an admitted market (ADR-030 Decision 1.8), and it is never
 *    abandoned to make room. So at the cap the series DEFERS further
 *    admissions until a resolution is handled; the cap incident says how many
 *    live windows await theirs.
 *
 *    **A resolution never observed** — the gateway was down, asleep or
 *    disconnected at the resolution instant, and the market channel is not
 *    documented to replay it — would hold its window's slot for good.
 *    `ROLLOVER-1` r3 (R3-FABLE-01): the reviewed recovery is the OPERATOR'S
 *    RETIREMENT. A `seriesAdmission.operatorRetirements` entry names the
 *    window and says why; it is applied here, and only to a live window past
 *    its unresolved bound with NO resolution owed (an observed one is
 *    re-published instead, and retires the window `RESOLVED`). The window is
 *    retired `OPERATOR` with the operator's reason, detached exactly like a
 *    resolved one, and announced by a NOTIFY incident naming it
 *    (`GATEWAY_SERIES_WINDOW_RETIRED_BY_OPERATOR`). An entry for a window not
 *    yet retirable waits, named once (`GATEWAY_SERIES_OPERATOR_RETIREMENT_DEFERRED`);
 *    one that names no window the ledger holds is reported
 *    (`GATEWAY_SERIES_OPERATOR_RETIREMENT_UNMATCHED`). Nothing else retires a
 *    window. The operator's act frees the GATEWAY slot only: a trader that
 *    holds inventory in that window receives no resolution, keeps it HELD,
 *    and recovers with a new run (`apps/trader`, `HELD_UNRESOLVED`).
 * 2. **Discovery** — `GET /events/keyset?series_id=…&closed=false&order=endDate&ascending=true&limit=…&end_date_min=<now>`
 *    and its `after_cursor` pages, up to `maximumPages`
 *    (`docs/venue/verified-2026-10-04.md` F-07, §A2; never `series_slug`,
 *    U-30; never the `new_market` push, U-23/F-13). EVERY response body is
 *    journaled to the WAL BEFORE anything is read from it (ADR-030 Decision
 *    3.1, the `UNIV-4` rule); a refused frame derives nothing.
 * 3. **Candidates.** A window already in the admission ledger is never judged
 *    again (a refusal is final: Decision 1.4). A window that ends at or before
 *    now — the gateway clock when it is considered, not the keyset read's
 *    receipt — is late and skipped; one whose `eventStartTime` is more than
 *    `admissionLeadSeconds` ahead is not yet due. A window whose condition id
 *    or token a configured market already holds is skipped (never shadowed).
 *    `V2-1` (ADR-030 Amendment 2 rule 1; plan row A8): the tokens checked are
 *    the trading ids the window's `version` selects (`selectTradingIds`), never
 *    the other field's; a window whose ids cannot be selected is checked by its
 *    condition id only, and the judge refuses it.
 * 4. **The cap** (Decision 1.8): with `maximumConcurrentWindows` live
 *    (ADMITTED, not retired) windows of the series — every one, including a
 *    window awaiting its resolution past its bound (step 1; `ROLLOVER-1` r2,
 *    R2-ASTRA-01) — nothing more is admitted; a NOTIFY incident naming the
 *    held window stands until room frees, and the window is reconsidered
 *    next cycle (or skipped as late once it has closed).
 * 5. **The CLOB read** — `GET /clob-markets/{condition_id}` (S-D65), journaled
 *    first like every response — for the explicit pairing and `itode`. At
 *    most `maximumConcurrentWindows` are ATTEMPTED per series per cycle,
 *    whatever their outcome (`ROLLOVER-1` r1, R1-FABLE-04): the configuration
 *    door budgets exactly that figure, and a candidate past it waits for the
 *    next cycle (`windowsDeferredByReadBudget`). `V2-1` (ADR-030 Amendment 2
 *    rule 3): the read sends the condition id's 32-byte form
 *    (`paddedConditionId`): a 31-byte id (62 hex digits, Gamma's documented V2
 *    form, F-43) right-padded with one zero byte, a 32-byte id unchanged —
 *    `/clob-markets` answers the 31-byte form with 404 (F-70). An id of any
 *    other width gets NO read (and spends no budget); the judge refuses it by
 *    name. Gamma's text stays the window's identity everywhere else: the
 *    ledger key, the incident scopes, the derived id and the events.
 * 6. **The judge** (`@polymarket-bot/universe` `judgeSeriesWindow`): exact
 *    match on the reviewed pattern and every reviewed parameter; per-window
 *    facts for presence and form only (Decision 1.2). A REFUSED window is
 *    recorded in the ledger FIRST, then a NOTIFY incident names every
 *    mismatch (Decision 1.4, acceptance 1); it waits for a human review.
 *    `ROLLOVER-1` r1 (R1-03): a window that MATCHES is admitted only if it is
 *    still open — its derived close strictly after the receipt of the CLOB
 *    read it was judged from (the instant its admission events carry as
 *    `receivedAt`, so the trader's re-judge refuses on the same instant,
 *    `WINDOW_CLOSED`, and a replay decides the same), and after the gateway
 *    clock just before the admission is committed. A window that closed
 *    during discovery is skipped, not recorded (`windowsClosedBeforeAdmission`):
 *    discovery's `end_date_min` and the late rule never offer it again.
 * 7. **Admission** — intent before dispatch, confirmation after publication:
 *    the window is registered in the directory, its admission is written to
 *    the ledger as an INTENT, and then ONE frame — `MarketDiscovered@1`,
 *    `TradingParametersChanged@1` (version 1) and `SeriesWindowAdmitted@1`
 *    (the user's ruling Q1) — is dispatched through the shared dispatcher,
 *    sequencer and publisher, citing the journaled CLOB response
 *    (`causationId`). Only when all three are PUBLISHED is the admission
 *    confirmed and the window ATTACHED: its two tokens subscribed with the
 *    documented dynamic `subscribe` frame (which opens the gap whose
 *    authoritative snapshot the market feed then fetches) and the window
 *    added to the lifecycle feed. So no book event of a window ever precedes
 *    its admission in the stream. An unpublished admission stays an intent
 *    and pages; the next epoch re-emits it, unchanged, before it attaches.
 *    Then the next epoch re-publishes every OWED resolution (step 1), citing
 *    the same journaled keyset response the admission replay cites, with the
 *    recorded payload unchanged; the ledger keeps the WAL position of the
 *    market-channel frame it was first derived from. So the re-publication
 *    waits for that epoch's first SUCCESSFUL keyset read: while Gamma's keyset
 *    read fails, an owed resolution stays owed (and its window in its slot).
 *
 * ## PAPER or BACKTEST only (Decision 2; acceptance 2)
 *
 * The constructor refuses any run mode but `PAPER` and `BACKTEST`
 * (`admissionRunModeProblem`): a gateway that would admit windows for a live
 * mode does not start. Admission is NEVER auto-approval for live trading
 * (§9.2's rule stands word for word above PAPER).
 *
 * ## Bounded and loud (§8.3)
 *
 * Every request is one GET, sequential, never stacked (an overlapping cycle is
 * skipped and counted); the configuration door budgets the cadence against the
 * documented limits. Failures (transport, non-2xx, a body the door cannot
 * read) derive nothing: a CLOB read's failure opens a NOTIFY incident naming
 * its window; a keyset read's is counted (`requestFailures`,
 * `lastRequestFailure`), and `consecutiveFailureThreshold` failures in a row
 * is a STALL (`FeedStale` plus `GATEWAY_FEED_STALL`), as for the lifecycle
 * feed. Retired and refused records are pruned after their retention
 * (`../admission-ledger.ts`).
 *
 * ## Incidents name a window
 *
 * A consumer treats a data-quality incident that names NO market as a loss of
 * the gateway's market data, and taints every book of the epoch for the rest
 * of it (ADR-023 D2 rule 4). Nothing the admission feed sees — a held window,
 * a refused one, a failed read — is about the delivery of any book, and the
 * cap is reached in the ordinary course of a run (two live windows and the
 * next one due). So every routine admission incident NAMES THE WINDOW it is
 * about, by its derived id (`windowInternalMarketId`): a market no consumer
 * runs until it is admitted, so the incident neither pauses a live window nor
 * taints the epoch; with no window to derive (no condition id or no start
 * locator) it names its scope's reference id ({@link incidentReferenceId}).
 * A condition that is about no window — a keyset read's failure, an event
 * with no identity at all — is counted instead. Only what the
 * lifecycle feed also raises market-less stays market-less: the STALL, a WAL
 * refusal and a ledger write failure (both PAGE).
 *
 * `ROLLOVER-1` r1 (R1-FABLE-03): a failed CLOB read's incident is scoped to
 * its WINDOW (`<feedId>:<condition id>`), and closed by that window's next
 * successful read — it used to be scoped to the series and reason, never
 * closed, so every later window's failure was a suppressed repeat no incident
 * named.
 */

import {
  readClobMarketInfoBody,
  readGammaSeriesEventsBody,
  requestClobMarketInfo,
  requestGammaSeriesEvents,
  SERIES_ADMISSION_REST_CHANNEL,
  clobMarketInfoUrl,
  gammaSeriesEventsUrl,
  type PublicHttpClient,
  type SeriesWindowEventReading,
} from "@polymarket-bot/polymarket-public";
import {
  IsoTimestampSchema,
  MarketResolvedPayloadSchema,
  type DataQualityIncidentOpenedPayload,
  type FeedStalePayload,
  type IncidentSeverity,
  type MarketDiscoveredPayload,
  type SeriesWindowAdmittedPayload,
  type TradingParametersChangedPayload,
} from "@polymarket-bot/domain";
import {
  admissionRunModeProblem,
  epochMsOfInstant,
  judgeSeriesWindow,
  paddedConditionId,
  selectTradingIds,
  windowInternalMarketId,
  type AdmittedWindowFacts,
  type ReviewedSeries,
} from "@polymarket-bot/universe";

import {
  boundedMismatches,
  type AdmissionLedger,
  type AdmissionLedgerRecord,
  type AdmittedWindowRecord,
  type WindowResolutionRecord,
} from "../admission-ledger.js";
import { ConnectionIdFactory } from "../connection-ids.js";
import type { AdmittedWindowRegistration, AdmittedWindowRegistrationResult } from "../directory.js";
import type { FrameDispatchEntry, GatewayDispatcher } from "../dispatcher.js";
import type { EnvelopeDraft } from "../envelope.js";
import { GatewayConfigurationError } from "../errors.js";
import { GATEWAY_INTERNAL_CHANNEL } from "../incidents.js";
import type { GatewayJournal } from "../journal.js";
import type { CancelScheduled, GatewayClock, GatewayReceipt, GatewayTimers } from "../ports.js";
import { isoFromMs, takeReceipt } from "../ports.js";
import type { PublishOutcome } from "../publisher.js";

import type { DispatchedResolution } from "./polymarket.js";

/** One reviewed series as the configuration door parsed it. */
export interface AdmittedSeries {
  readonly series: ReviewedSeries;
  readonly configHash: string;
}

/** What the gateway does to attach and detach a window (`gateway.ts` binds it). */
export interface AdmittedWindowSink {
  /** Whether a condition id or token is already known: a configured market or a live window. */
  knows(conditionId: string, tokenIds: readonly string[]): boolean;
  /** Registers the window in the directory; answers its first parameter version. */
  register(window: AdmittedWindowRegistration): AdmittedWindowRegistrationResult;
  /** Subscribes the window's tokens and adds it to the lifecycle feed. */
  attach(record: AdmissionLedgerRecord): void;
  /** Unsubscribes the window, stops its lifecycle polling, releases its directory entry. */
  detach(record: AdmissionLedgerRecord): void;
  /** Removes the lifecycle ledger record of a window whose retention has passed. */
  forgetLifecycleRecord(internalMarketId: string): Promise<void>;
}

export interface SeriesAdmissionDriverOptions {
  readonly feedId: string;
  readonly gammaBaseUrl: string | undefined;
  readonly clobBaseUrl: string | undefined;
  readonly pollIntervalMs: number;
  readonly consecutiveFailureThreshold: number;
  readonly pageLimit: number;
  readonly maximumPages: number;
  readonly admissionLeadSeconds: number;
  readonly series: readonly AdmittedSeries[];
  /** The process's run mode; anything but PAPER or BACKTEST refuses the start. */
  readonly runMode: unknown;
  readonly http: PublicHttpClient;
  readonly journal: GatewayJournal;
  readonly dispatcher: GatewayDispatcher;
  readonly clock: GatewayClock;
  readonly timers: GatewayTimers;
  readonly ledger: AdmissionLedger;
  readonly windows: AdmittedWindowSink;
  /** The gateway epoch, recorded with a resolution's raw-frame position (R3-ASTRA-01). */
  readonly gatewayEpoch: string;
  /** `ROLLOVER-1` r3 (R3-FABLE-01): the operator's named retirements (`config.ts`). */
  readonly operatorRetirements?: readonly OperatorRetirement[];
}

/** One `seriesAdmission.operatorRetirements` entry. */
export interface OperatorRetirement {
  readonly internalMarketId: string;
  readonly reason: string;
}

export interface SeriesAdmissionDriverMetrics {
  readonly cycles: number;
  readonly cyclesSkippedOverlapping: number;
  readonly pagesRead: number;
  readonly clobReads: number;
  readonly requestFailures: number;
  readonly consecutiveFailures: number;
  readonly framesRecorded: number;
  readonly framesRefusedByWal: number;
  readonly windowsAdmitted: number;
  readonly windowsRefused: number;
  readonly windowsRetiredResolved: number;
  /**
   * Live windows past their unresolved bound, subscribed and awaiting their
   * resolution (R1-04). Each still holds its cap slot (`ROLLOVER-1` r2).
   */
  readonly windowsAwaitingResolution: number;
  readonly windowsSkippedLate: number;
  /** Matching windows that closed during discovery, so were not admitted (R1-03). */
  readonly windowsClosedBeforeAdmission: number;
  /** Candidates left for the next cycle because the cycle's CLOB read budget was spent (R1-FABLE-04). */
  readonly windowsDeferredByReadBudget: number;
  readonly windowsSkippedKnown: number;
  readonly windowsHeldByCap: number;
  /** Keyset events with neither a condition id nor an event id: never admitted, counted. */
  readonly windowsUnidentified: number;
  /** The last keyset-read failure, bounded; `null` when none happened. */
  readonly lastRequestFailure: string | null;
  readonly admissionsUnpublished: number;
  readonly admissionsReplayed: number;
  readonly ledgerWriteFailures: number;
  readonly liveWindows: number;
  /** `ROLLOVER-1` r3 (R3-ASTRA-01): resolutions of live windows the market feed dispatched. */
  readonly resolutionsObserved: number;
  /** ... of which the publisher did NOT publish (each pages; the next epoch re-publishes it). */
  readonly resolutionsUnpublished: number;
  /** Owed resolutions an earlier epoch left, re-published by this one. */
  readonly resolutionsReplayed: number;
  /** Live windows whose observed resolution is still owed publication. */
  readonly resolutionsOwed: number;
  /**
   * `ROLLOVER-1` r4 (R4-FABLE-01): observed resolutions the admission ledger
   * could not record yet — held in memory and written again every cycle. While
   * it is above 0, a stop loses them (their PAGE says so).
   */
  readonly resolutionsUnrecorded: number;
  /** `ROLLOVER-1` r3 (R3-FABLE-01): windows retired by an operator's named retirement. */
  readonly windowsRetiredByOperator: number;
  /** Operator retirements naming a live window not yet retirable (before its bound, or a resolution owed). */
  readonly operatorRetirementsDeferred: number;
  /** Operator retirements naming no window the ledger holds. */
  readonly operatorRetirementsUnmatched: number;
}

/** A journaled response the derived events cite. */
interface CitedFrame {
  readonly receipt: GatewayReceipt;
  readonly rawFrameIngestSeq: string;
  readonly connectionId: string;
}

/** The trading parameters version 1 of an admitted window carries. */
const ADMISSION_CHANGED_PARAMETERS = Object.freeze([
  "tick_size",
  "minimum_order_size",
  "fee_schedule",
  "trading_delay",
  "neg_risk",
  "open_time",
  "close_time",
] as const);

/** The admission frame's three payloads, from a ledger record (so a replay is byte-for-byte the intent). */
/**
 * The derived id of the window a keyset event describes, as a one-element
 * list, or `[]` when it cannot be derived (no condition id or no start
 * locator). An admission incident names this — a market no consumer runs
 * until it is admitted — so it neither pauses a live window nor taints the
 * epoch (module header, "Incidents name a window").
 */
function derivedWindowIds(conditionId: string | null, startMs: number | undefined): readonly string[] {
  if (conditionId === null || conditionId === "" || startMs === undefined) return [];
  const id = windowInternalMarketId(conditionId, startMs);
  return id === undefined ? [] : [id];
}

/**
 * The id an admission incident names when there is no window to derive (no
 * condition id or no start locator): a UUIDv7 derived from the incident's
 * scope with timestamp 0, so it is stable, distinct per scope, and names no
 * market any process runs — the incident is reported without tainting the
 * epoch (module header).
 */
export function incidentReferenceId(scope: string): string {
  return windowInternalMarketId(`series-admission-incident|${scope}`, 0) ?? "00000000-0000-7000-8000-000000000000";
}

export function admissionPayloads(
  record: AdmissionLedgerRecord,
  window: AdmittedWindowRecord,
  minimumOrderSize: string,
): {
  readonly discovered: MarketDiscoveredPayload;
  readonly parameters: TradingParametersChangedPayload;
  readonly admitted: SeriesWindowAdmittedPayload;
} {
  const reference = { internalMarketId: window.internalMarketId, conditionId: window.conditionId };
  return {
    discovered: {
      ...reference,
      yesTokenId: window.yesTokenId,
      noTokenId: window.noTokenId,
      seriesId: record.seriesId,
      metadataVersion: 1,
    },
    parameters: {
      ...reference,
      parametersVersion: 1,
      parameterVersionRef: window.parameterVersionRef,
      changedParameters: [...ADMISSION_CHANGED_PARAMETERS],
      tickSize: window.tickSize,
      minimumOrderSize,
    },
    admitted: {
      ...reference,
      seriesId: record.seriesId,
      seriesConfigHash: record.seriesConfigHash,
      yesTokenId: window.yesTokenId,
      noTokenId: window.noTokenId,
      scheduledOpenAt: window.scheduledOpenAt,
      scheduledCloseAt: window.scheduledCloseAt,
      tickSize: window.tickSize,
      windowTitle: window.windowTitle,
    },
  };
}

export class SeriesAdmissionFeedDriver {
  readonly #options: SeriesAdmissionDriverOptions;
  readonly #connectionIds: ConnectionIdFactory;
  readonly #seriesById: ReadonlyMap<string, AdmittedSeries>;
  /**
   * `ROLLOVER-1` r3 (R3-ASTRA-01): resolutions PUBLISHED in this epoch, by
   * window id, with `publishedAt` — what teardown retires on even when the
   * ledger write that records the publication failed.
   */
  readonly #published = new Map<string, WindowResolutionRecord & { readonly publishedAt: string }>();
  /**
   * `ROLLOVER-1` r4 (R4-FABLE-01): observed resolutions whose ledger write has
   * not succeeded yet, by ledger key — kept in memory, owed exactly like a
   * recorded one, and written again at the start of every cycle until the
   * ledger holds them (or the window is no longer live). r3 wrote the evidence
   * once: when that write AND the publication failed, the resolution was kept
   * nowhere, while its PAGE said it was in the ledger.
   */
  readonly #unrecorded = new Map<string, WindowResolutionRecord>();
  /** `ROLLOVER-1` r3 (R3-FABLE-01): the operator's named retirements, by window id. */
  readonly #operatorRetirements: ReadonlyMap<string, string>;
  #operatorRetirementsChecked = false;
  /** Serializes every read-modify-write of a live record (the resolution and retirement paths). */
  #mutations: Promise<unknown> = Promise.resolve();
  /** Unconfirmed admissions from an earlier epoch, re-emitted on the first successful poll. */
  #replayOwed: boolean;
  /** `ROLLOVER-1` r3: owed resolutions from an earlier epoch, re-published right after them. */
  #resolutionReplayOwed: boolean;
  #cancelInterval: CancelScheduled | undefined;
  #cycle: Promise<void> | undefined;
  #stopped = false;
  #lastSuccessMs: number | undefined;

  #cycles = 0;
  #cyclesSkipped = 0;
  #pagesRead = 0;
  #clobReads = 0;
  #requestFailures = 0;
  #consecutiveFailures = 0;
  #framesRecorded = 0;
  #framesRefusedByWal = 0;
  #admitted = 0;
  #refused = 0;
  #retiredResolved = 0;
  #awaitingResolution = 0;
  #skippedLate = 0;
  #closedBeforeAdmission = 0;
  #deferredByReadBudget = 0;
  #skippedKnown = 0;
  #heldByCap = 0;
  #unidentified = 0;
  /** The last keyset failure (counted, not published: see {@link #requestFailed}). */
  #lastRequestFailure: string | undefined;
  #unpublished = 0;
  #replayed = 0;
  #ledgerWriteFailures = 0;
  #resolutionsObserved = 0;
  #resolutionsUnpublished = 0;
  #resolutionsReplayed = 0;
  #resolutionsOwed = 0;
  #retiredByOperator = 0;
  #operatorDeferred = 0;
  #operatorUnmatched = 0;

  constructor(options: SeriesAdmissionDriverOptions) {
    // ADR-030 Decision 2.1 (acceptance 2): refuse to START outside PAPER/BACKTEST.
    const modeProblem = admissionRunModeProblem(options.runMode);
    if (modeProblem !== undefined) {
      throw new GatewayConfigurationError(modeProblem, { runMode: typeof options.runMode === "string" ? options.runMode : typeof options.runMode });
    }
    this.#options = options;
    this.#connectionIds = new ConnectionIdFactory(options.feedId);
    this.#seriesById = new Map(options.series.map((entry) => [entry.series.seriesId, entry]));
    this.#operatorRetirements = new Map((options.operatorRetirements ?? []).map((entry) => [entry.internalMarketId, entry.reason]));
    // Re-register every live window in the directory, so the market feed can
    // attribute its tokens; attach only the CONFIRMED ones now (an unconfirmed
    // window is attached after its admission is re-published — module header).
    let owed = false;
    let resolutionOwed = false;
    for (const record of options.ledger.liveWindows()) {
      const window = record.window;
      const entry = this.#seriesById.get(record.seriesId);
      if (window === undefined || entry === undefined) {
        throw new GatewayConfigurationError(
          "the series admission ledger holds a live window of a series this configuration no longer reviews; a window is never carried without its review — restore the series or retire the window",
          { key: record.key, seriesId: record.seriesId },
        );
      }
      if (record.seriesConfigHash !== entry.configHash) {
        throw new GatewayConfigurationError(
          "the series admission ledger holds a live window admitted under another version of its reviewed series; a changed review is a new run (ADR-030 Decision 4.3) — retire the window before starting under the new review",
          { key: record.key, seriesId: record.seriesId, admittedUnder: record.seriesConfigHash, configured: entry.configHash },
        );
      }
      const registered = options.windows.register(this.#registration(record, window, entry.series, record.judgedAt));
      if (!registered.ok) {
        throw new GatewayConfigurationError("a live admitted window could not be re-registered in the directory", {
          key: record.key,
          detail: registered.detail,
        });
      }
      if (record.admissionConfirmedAt === undefined) owed = true;
      if (record.resolution !== undefined && record.resolution.publishedAt === undefined) resolutionOwed = true;
    }
    this.#replayOwed = owed;
    this.#resolutionReplayOwed = resolutionOwed;
  }

  /**
   * `ROLLOVER-1` r3 (R3-ASTRA-01): the market feed DISPATCHED a
   * `MarketResolved`; `resolution.published` says whether it was published.
   * For a live window, the resolution is recorded on its ledger record as an
   * obligation at once, and discharged (`publishedAt`) only by a
   * `published: true` outcome; teardown retires the window only then
   * (module header, step 1). A configured market's resolution is not this
   * feed's, and is ignored here.
   */
  noteResolution(resolution: DispatchedResolution): void {
    if (this.#stopped) return;
    const parsed = MarketResolvedPayloadSchema.safeParse(resolution.payload);
    if (!parsed.success) return; // the dispatcher refuses such an envelope too
    const payload = parsed.data;
    const record = this.#options.ledger
      .liveWindows()
      .find((candidate) => candidate.window?.internalMarketId === payload.internalMarketId);
    if (record === undefined) return;
    this.#resolutionsObserved += 1;
    const evidence: WindowResolutionRecord = {
      payload,
      ...(resolution.venueTimestamp !== undefined && IsoTimestampSchema.safeParse(resolution.venueTimestamp).success
        ? { venueTimestamp: resolution.venueTimestamp }
        : {}),
      observedAt: resolution.receivedAt,
      ...(resolution.rawFrameIngestSeq === undefined
        ? {}
        : { rawFrame: { gatewayEpoch: this.#options.gatewayEpoch, ingestSeq: resolution.rawFrameIngestSeq } }),
    };
    // Recorded at once (the obligation), on the serial mutation chain; held in
    // memory until the ledger holds it (r4, R4-FABLE-01). The first observed
    // resolution of a window stands.
    if (!this.#unrecorded.has(record.key)) this.#unrecorded.set(record.key, evidence);
    const recorded = this.#recordResolution(record.key);
    void resolution.published.then(async (outcome) => {
      // The outcome is judged once the first write has settled, so its PAGE
      // says truthfully whether the resolution is in the ledger.
      await recorded;
      await this.#resolutionOutcome(record.key, evidence, outcome);
    });
  }

  /**
   * `ROLLOVER-1` r4 (R4-FABLE-01): writes a held resolution onto its window's
   * ledger record, and forgets the in-memory copy once the ledger holds it —
   * or once it is no longer needed (the record already carries a resolution,
   * or is no longer live). A failed write keeps the copy for the next cycle.
   */
  async #recordResolution(key: string): Promise<void> {
    const evidence = this.#unrecorded.get(key);
    if (evidence === undefined) return;
    const attempt = { needed: false };
    const written = await this.#mutate(key, (current) => {
      if (current?.status !== "ADMITTED" || current.resolution !== undefined) return undefined;
      attempt.needed = true;
      return { ...current, resolution: evidence };
    });
    if ((written !== undefined || !attempt.needed) && this.#unrecorded.get(key) === evidence) this.#unrecorded.delete(key);
  }

  /** Writes every held resolution again (each cycle, before teardown; R4-FABLE-01). */
  async #recordUnrecorded(): Promise<void> {
    for (const key of [...this.#unrecorded.keys()]) {
      if (this.#stopped) return;
      await this.#recordResolution(key);
    }
  }

  /** Discharges a resolution's obligation on publication, or pages that it is owed. */
  async #resolutionOutcome(key: string, evidence: WindowResolutionRecord, outcome: PublishOutcome): Promise<void> {
    const id = evidence.payload.internalMarketId;
    if (!outcome.published) {
      this.#resolutionsUnpublished += 1;
      const failure = `the resolution of admitted window ${id} (condition ${evidence.payload.conditionId}, ${evidence.payload.outcome}) was dispatched but not published (${outcome.reason}: ${outcome.detail}); the window stays admitted, subscribed and in its cap slot`;
      // r4 (R4-FABLE-01): the text says where the resolution IS kept.
      this.#openWindowIncident(
        `${this.#options.feedId}:${id}:resolution`,
        "GATEWAY_SERIES_RESOLUTION_UNPUBLISHED",
        "PAGE",
        this.#unrecorded.has(key)
          ? `${failure}. Its resolution is NOT in the admission ledger: the ledger write failed (GATEWAY_SERIES_LEDGER_WRITE_FAILED), so it is held in memory only and written again every admission cycle (resolutionsUnrecorded). Once that write succeeds, the next start re-publishes it before the window is retired; if this gateway stops first, the resolution is LOST — the window then awaits its resolution like one never observed, and its recovery is the operator's named retirement (seriesAdmission.operatorRetirements)`
          : `${failure}, its resolution is kept in the admission ledger, and the next start re-publishes it before the window is retired`,
        [id],
      );
      return;
    }
    // After a stop nothing more is written: the next epoch re-publishes the
    // resolution, which a consumer that already handled it ignores.
    if (this.#stopped) return;
    await this.#discharge(key, evidence);
  }

  /** Records a resolution PUBLISHED (in memory at once; durably on the chain). */
  async #discharge(key: string, evidence: WindowResolutionRecord): Promise<void> {
    const publishedAt = isoFromMs(this.#options.clock.nowMs());
    this.#published.set(evidence.payload.internalMarketId, { ...evidence, publishedAt });
    await this.#mutate(key, (current) =>
      current?.status === "ADMITTED" && current.resolution?.publishedAt === undefined
        ? { ...current, resolution: { ...(current.resolution ?? evidence), publishedAt } }
        : undefined,
    );
  }

  /**
   * One read-modify-write of a record, serialized with every other: `change`
   * sees the record as the ledger holds it once every earlier write has
   * settled, and answers the record to write (or `undefined`: nothing to do).
   * Resolves to the record written, or `undefined` (nothing, or a failed write).
   */
  #mutate(
    key: string,
    change: (current: AdmissionLedgerRecord | undefined) => AdmissionLedgerRecord | undefined,
  ): Promise<AdmissionLedgerRecord | undefined> {
    const run = this.#mutations.then(async () => {
      await this.#options.ledger.settle();
      const next = change(this.#options.ledger.get(key));
      if (next === undefined) return undefined;
      return (await this.#persist(next)) ? next : undefined;
    });
    this.#mutations = run.catch(() => undefined);
    return run;
  }

  /** The live, CONFIRMED windows: what `gateway.ts` attaches at start. */
  confirmedLiveWindows(): readonly AdmissionLedgerRecord[] {
    return this.#options.ledger.liveWindows().filter((record) => record.admissionConfirmedAt !== undefined);
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

  /**
   * Waits for an in-flight cycle and every ledger rewrite (tests, shutdown).
   * It does NOT wait for a publication's outcome (a stalled transport must not
   * hold the WAL family's shutdown, `gateway.ts` `stop`): a resolution whose
   * outcome arrives later is written then, or — after `stop()` — re-published
   * by the next epoch.
   */
  async settle(): Promise<void> {
    while (this.#cycle !== undefined) {
      const cycle = this.#cycle;
      await cycle;
      if (this.#cycle === cycle) break;
    }
    for (;;) {
      const mutations = this.#mutations;
      await mutations;
      if (this.#mutations === mutations) break;
    }
    await this.#options.ledger.settle();
  }

  /** Runs one cycle now and waits for it (tests). */
  async runCycleForTest(): Promise<void> {
    this.#kick();
    await this.settle();
  }

  #kick(): void {
    if (this.#stopped) return;
    if (this.#cycle !== undefined) {
      this.#cyclesSkipped += 1;
      return;
    }
    const cycle = this.#runCycle().finally(() => {
      if (this.#cycle === cycle) this.#cycle = undefined;
    });
    this.#cycle = cycle;
  }

  async #runCycle(): Promise<void> {
    this.#cycles += 1;
    const nowMs = this.#options.clock.nowMs();
    await this.#recordUnrecorded();
    await this.#tearDown(nowMs);
    await this.#prune(nowMs);
    for (const entry of this.#options.series) {
      if (this.#stopped) return;
      await this.#discover(entry);
    }
  }

  // --------------------------------------------------------------------------
  // Teardown and pruning
  // --------------------------------------------------------------------------

  /**
   * Is a live window past its reviewed unresolved bound at `nowMs`? Such a
   * window awaits its resolution, named by an incident, and keeps its cap slot
   * (module header, steps 1 and 4).
   */
  #pastUnresolvedBound(window: AdmittedWindowRecord, entry: AdmittedSeries, nowMs: number): boolean {
    const closeMs = Date.parse(window.scheduledCloseAt);
    return Number.isFinite(closeMs) && nowMs >= closeMs + entry.series.unresolvedTeardownSeconds * 1000;
  }

  /** The incident scope of a window still unresolved past its bound. */
  #unresolvedScope(window: AdmittedWindowRecord): string {
    return `${this.#options.feedId}:${window.internalMarketId}`;
  }

  /** The incident scope of an operator retirement that cannot be applied yet. */
  #operatorScope(window: AdmittedWindowRecord): string {
    return `${this.#options.feedId}:${window.internalMarketId}:operator`;
  }

  /**
   * Retires every live window whose resolution was PUBLISHED (`RESOLVED`) and
   * every window an operator's named retirement may retire (`OPERATOR`), and
   * names every one still unresolved past its bound. Nothing else retires a
   * window (`ROLLOVER-1` r2, R2-ASTRA-02: r1 retired the OLDEST awaiting
   * window once more than `maximumConcurrentWindows` awaited, which cut its
   * resolution's route; r3, R3-ASTRA-01: r2 retired a window whose resolution
   * was dispatched but never published; R3-FABLE-01: the operator's
   * retirement is the reviewed recovery for a resolution never observed).
   */
  async #tearDown(nowMs: number): Promise<void> {
    this.#checkOperatorRetirements();
    let awaiting = 0;
    let owed = 0;
    let deferred = 0;
    for (const record of this.#options.ledger.liveWindows()) {
      const window = record.window;
      const entry = this.#seriesById.get(record.seriesId);
      if (window === undefined || entry === undefined) continue;
      const published =
        record.resolution?.publishedAt === undefined ? this.#published.get(window.internalMarketId) : { ...record.resolution, publishedAt: record.resolution.publishedAt };
      if (published !== undefined) {
        // Its resolution was PUBLISHED: retired, as ADR-030 Decision 4.4 says.
        const retired = await this.#mutate(record.key, (current) =>
          current?.status === "ADMITTED"
            ? {
                ...current,
                status: "RETIRED",
                retiredAt: isoFromMs(nowMs),
                retiredReason: "RESOLVED",
                resolution: current.resolution?.publishedAt === undefined ? published : current.resolution,
              }
            : undefined,
        );
        if (retired === undefined) continue;
        this.#detach(retired);
        this.#retiredResolved += 1;
        continue;
      }
      const pastBound = this.#pastUnresolvedBound(window, entry, nowMs);
      const operatorReason = this.#operatorRetirements.get(window.internalMarketId);
      if (record.resolution !== undefined || this.#unrecorded.has(record.key)) {
        // Observed, NOT published (R3-ASTRA-01): owed. It keeps its route and
        // its slot; the next epoch re-publishes it, and only then is it retired.
        // r4 (R4-FABLE-01): a resolution held in memory, its ledger write not
        // yet successful, is owed too, and no operator retirement overrides it.
        owed += 1;
        if (operatorReason !== undefined) {
          deferred += 1;
          this.#openWindowIncident(
            this.#operatorScope(window),
            "GATEWAY_SERIES_OPERATOR_RETIREMENT_DEFERRED",
            "NOTIFY",
            `the operator's retirement of window ${window.internalMarketId} (${window.windowTitle}) is not applied: its resolution was observed and is owed publication, so it is re-published and the window retired RESOLVED instead`,
            [window.internalMarketId],
          );
        }
        continue;
      }
      if (operatorReason !== undefined) {
        if (!pastBound) {
          deferred += 1;
          this.#openWindowIncident(
            this.#operatorScope(window),
            "GATEWAY_SERIES_OPERATOR_RETIREMENT_DEFERRED",
            "NOTIFY",
            `the operator's retirement of window ${window.internalMarketId} (${window.windowTitle}, closing ${window.scheduledCloseAt}) is not applied yet: a window is retired by an operator only once it is unresolved ${String(entry.series.unresolvedTeardownSeconds)} s after its close; until then its resolution may still arrive`,
            [window.internalMarketId],
          );
          continue;
        }
        // R3-FABLE-01: the operator's NAMED act — a window past its bound whose
        // resolution never reached this gateway — retired with the reason.
        const retired = await this.#mutate(record.key, (current) =>
          current?.status === "ADMITTED" && current.resolution === undefined
            ? { ...current, status: "RETIRED", retiredAt: isoFromMs(nowMs), retiredReason: "OPERATOR", operatorReason }
            : undefined,
        );
        if (retired === undefined) continue;
        this.#detach(retired);
        this.#retiredByOperator += 1;
        this.#openWindowIncident(
          `${this.#options.feedId}:${window.internalMarketId}:retired`,
          "GATEWAY_SERIES_WINDOW_RETIRED_BY_OPERATOR",
          "NOTIFY",
          `admitted window ${window.internalMarketId} (${window.windowTitle}, condition ${window.conditionId}) had no resolution ${String(entry.series.unresolvedTeardownSeconds)} s after its close ${window.scheduledCloseAt} and was RETIRED by the operator's named retirement: ${operatorReason}. It is unsubscribed and its cap slot is free; no resolution of it is published, so a trader holding it keeps it held until a new run`,
          [window.internalMarketId],
        );
        continue;
      }
      if (!pastBound) continue;
      // R1-04 and r2: NOT retired by a timer, however long it waits. A trader
      // may hold a position in it, and only this gateway can still deliver
      // its resolution; it stays subscribed, registered, and in its cap slot.
      // The incident is opened once (the registry suppresses a repeat while open).
      awaiting += 1;
      this.#openWindowIncident(
        this.#unresolvedScope(window),
        "GATEWAY_SERIES_WINDOW_UNRESOLVED",
        "NOTIFY",
        `admitted window ${window.internalMarketId} (${window.windowTitle}, condition ${window.conditionId}) had no MarketResolved ${String(entry.series.unresolvedTeardownSeconds)} s after its scheduled close ${window.scheduledCloseAt}; it stays subscribed, awaiting its resolution (ADR-030 Decision 4.4), and keeps its cap slot until its resolution is handled — the series admits no window in its place (Decision 1.8). A resolution missed while the gateway was down or disconnected is not redelivered: to recover the slot, name this window in seriesAdmission.operatorRetirements with a reason and restart`,
        [window.internalMarketId],
      );
    }
    this.#awaitingResolution = awaiting;
    this.#resolutionsOwed = owed;
    this.#operatorDeferred = deferred;
  }

  /** Tears a RETIRED window down in this process and closes its window incidents. */
  #detach(record: AdmissionLedgerRecord): void {
    const window = record.window;
    this.#options.windows.detach(record);
    if (window === undefined) return;
    this.#published.delete(window.internalMarketId);
    this.#options.dispatcher.markIncidentClosed(this.#unresolvedScope(window), "GATEWAY_SERIES_WINDOW_UNRESOLVED");
    this.#options.dispatcher.markIncidentClosed(this.#operatorScope(window), "GATEWAY_SERIES_OPERATOR_RETIREMENT_DEFERRED");
  }

  /**
   * Once per epoch, at the first cycle: reports every operator retirement that
   * names no window the ledger holds (a typo, or a record already pruned). A
   * window already RETIRED needs nothing.
   */
  #checkOperatorRetirements(): void {
    if (this.#operatorRetirementsChecked) return;
    this.#operatorRetirementsChecked = true;
    if (this.#operatorRetirements.size === 0) return;
    const known = new Set(this.#options.ledger.records().flatMap((record) => (record.window === undefined ? [] : [record.window.internalMarketId])));
    for (const [id, reason] of this.#operatorRetirements) {
      if (known.has(id)) continue;
      this.#operatorUnmatched += 1;
      this.#openWindowIncident(
        `${this.#options.feedId}:${id}:operator-unmatched`,
        "GATEWAY_SERIES_OPERATOR_RETIREMENT_UNMATCHED",
        "NOTIFY",
        `seriesAdmission.operatorRetirements names window ${id} (${reason}), but the admission ledger holds no window with that id: nothing is retired for it`,
        [id],
      );
    }
  }

  async #prune(nowMs: number): Promise<void> {
    let pruned: readonly AdmissionLedgerRecord[];
    try {
      pruned = await this.#options.ledger.prune(nowMs);
    } catch (error) {
      this.#ledgerFailed(error);
      return;
    }
    for (const record of pruned) {
      const id = record.window?.internalMarketId;
      if (id === undefined) continue;
      try {
        await this.#options.windows.forgetLifecycleRecord(id);
      } catch (error) {
        this.#ledgerFailed(error);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Discovery, judgement, admission
  // --------------------------------------------------------------------------

  async #discover(entry: AdmittedSeries): Promise<void> {
    const nowMs = this.#options.clock.nowMs();
    const candidates: { readonly event: SeriesWindowEventReading; readonly frame: CitedFrame }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < this.#options.maximumPages; page += 1) {
      if (this.#stopped) return;
      const query = {
        gammaSeriesId: entry.series.venue.gammaSeriesId,
        endDateMin: isoFromMs(nowMs),
        limit: this.#options.pageLimit,
        ...(cursor === undefined ? {} : { afterCursor: cursor }),
        ...(this.#options.gammaBaseUrl === undefined ? {} : { baseUrl: this.#options.gammaBaseUrl }),
      };
      const url = gammaSeriesEventsUrl(query);
      let response;
      try {
        response = await requestGammaSeriesEvents({ http: this.#options.http, query });
      } catch (error) {
        this.#requestFailed("GATEWAY_SERIES_DISCOVERY_FAILED", `the Gamma events-keyset request failed at the transport level: ${describe(error)}`);
        return;
      }
      const frame = this.#journal(url, response.bodyUtf8);
      if (frame === undefined || this.#stopped) return;
      if (response.status < 200 || response.status >= 300) {
        this.#requestFailed("GATEWAY_SERIES_DISCOVERY_FAILED", `the Gamma events-keyset request returned HTTP ${String(response.status)}`);
        return;
      }
      const verdict = readGammaSeriesEventsBody(response.bodyUtf8);
      if (verdict.status === "invalid") {
        this.#requestFailed("GATEWAY_SERIES_DISCOVERY_INVALID", `the Gamma events-keyset body was not the documented KeysetEventsResponse: ${verdict.issues.join("; ")}`);
        return;
      }
      this.#pagesRead += 1;
      this.#requestSucceeded(frame.receipt);
      if (this.#replayOwed) {
        const replayed = await this.#replay(frame);
        if (!replayed) return;
      }
      if (this.#resolutionReplayOwed) {
        const replayed = await this.#replayResolutions(frame);
        if (!replayed) return;
      }
      for (const event of verdict.events) candidates.push({ event, frame });
      if (verdict.nextCursor === null) break;
      cursor = verdict.nextCursor;
    }
    // R1-FABLE-04: the cycle's CLOB read budget for this series — the figure
    // the configuration door budgets (`config.ts`, `checkSeriesAdmission`).
    const budget = { remaining: entry.series.maximumConcurrentWindows };
    for (const candidate of candidates) {
      if (this.#stopped) return;
      await this.#consider(entry, candidate.event, candidate.frame, budget);
    }
  }

  async #consider(
    entry: AdmittedSeries,
    event: SeriesWindowEventReading,
    keysetFrame: CitedFrame,
    budget: { remaining: number },
  ): Promise<void> {
    const market = event.market;
    const conditionId = market?.conditionId ?? null;
    const key = conditionId ?? (event.eventId === null ? undefined : `event:${event.eventId}`);
    if (key === undefined) {
      // No condition id and no event id: nothing identifies the window, so it
      // cannot be recorded or judged once, and it is never admitted. It is
      // COUNTED (`windowsUnidentified`), not published as an incident: an
      // incident must name a market, and a market-less one taints every book
      // of the epoch for every consumer (ADR-023 D2 rule 4) — for a fact about
      // no book (see "Incidents name a window" in the module header).
      this.#unidentified += 1;
      return;
    }
    if (this.#options.ledger.get(key) !== undefined) return; // judged once, never again
    // R1-03: NOW, not the keyset read's receipt — candidates are considered
    // one by one after every page is read, each after the CLOB reads before it.
    const nowMs = this.#options.clock.nowMs();
    const endMs = market?.endDate === null || market === null ? undefined : epochMsOfInstant(market.endDate);
    if (endMs !== undefined && endMs <= nowMs) {
      this.#skippedLate += 1;
      return;
    }
    const startMs = market?.eventStartTime === null || market === null ? undefined : epochMsOfInstant(market.eventStartTime);
    if (startMs !== undefined && startMs - nowMs > this.#options.admissionLeadSeconds * 1000) return; // not yet due
    const tokens = market === null ? [] : selectedTokenPair(market);
    if (conditionId !== null && this.#options.windows.knows(conditionId, tokens)) {
      this.#skippedKnown += 1;
      return;
    }
    // The cap counts EVERY live window of the series (ADR-030 Decision 1.8),
    // one awaiting its resolution past its bound included (`ROLLOVER-1` r2,
    // R2-ASTRA-01: r1 excluded those, so a series could hold more admitted,
    // subscribed windows than its reviewed cap). At the cap, admissions are
    // DEFERRED; no live window is ever evicted to make room (R2-ASTRA-02).
    const liveRecords = this.#options.ledger.liveWindows(entry.series.seriesId);
    const live = liveRecords.length;
    const capScope = `${this.#options.feedId}:${entry.series.seriesId}:cap`;
    if (live >= entry.series.maximumConcurrentWindows) {
      this.#heldByCap += 1;
      const awaiting = liveRecords.filter(
        (record) => record.window !== undefined && record.resolution === undefined && this.#pastUnresolvedBound(record.window, entry, nowMs),
      ).length;
      const owedHere = liveRecords.filter((record) => record.resolution !== undefined).length;
      // Named by the HELD window's derived id — a market no consumer runs, so
      // the incident neither pauses a live window nor taints the epoch.
      this.#openWindowIncident(
        capScope,
        "GATEWAY_SERIES_CAP_REACHED",
        "NOTIFY",
        `series ${entry.series.seriesId} has ${String(live)} live windows, its reviewed cap (maximumConcurrentWindows ${String(entry.series.maximumConcurrentWindows)}, ADR-030 Decision 1.8), ${String(awaiting)} of them past their unresolved bound and awaiting their resolution, ${String(owedHere)} with a resolution owed publication; window ${conditionId ?? key} is held until one is torn down after its resolution is published (or an operator retires one)`,
        derivedWindowIds(conditionId, startMs),
      );
      return;
    }
    this.#options.dispatcher.markIncidentClosed(capScope, "GATEWAY_SERIES_CAP_REACHED");

    // The CLOB read — journaled first, like every response. It sends the
    // condition id's 32-byte form (ADR-030 Amendment 2 rule 3); an id of any
    // other width gets no read, and the judge refuses it by name.
    let clob: ReturnType<typeof readClobMarketInfoBody> | undefined;
    let clobFrame: CitedFrame | undefined;
    const venueCondition = conditionId === null ? undefined : paddedConditionId(conditionId);
    if (conditionId !== null && venueCondition?.ok === true) {
      // R1-FABLE-04: every ATTEMPTED read counts, whatever its outcome.
      if (budget.remaining <= 0) {
        this.#deferredByReadBudget += 1;
        return;
      }
      budget.remaining -= 1;
      const clobScope = { scope: `${this.#options.feedId}:${conditionId}`, ids: derivedWindowIds(conditionId, startMs) };
      const sentAs = venueCondition.padded ? ` (sent right-padded to 32 bytes as ${venueCondition.conditionId}, ADR-030 Amendment 2 rule 3)` : "";
      const url = clobMarketInfoUrl(venueCondition.conditionId, this.#options.clobBaseUrl);
      let response;
      try {
        response = await requestClobMarketInfo({
          http: this.#options.http,
          conditionId: venueCondition.conditionId,
          ...(this.#options.clobBaseUrl === undefined ? {} : { baseUrl: this.#options.clobBaseUrl }),
        });
      } catch (error) {
        this.#requestFailed("GATEWAY_SERIES_CLOB_READ_FAILED", `the CLOB market-info request for ${conditionId}${sentAs} failed at the transport level: ${describe(error)}; the window is reconsidered next cycle`, clobScope);
        return;
      }
      clobFrame = this.#journal(url, response.bodyUtf8);
      if (clobFrame === undefined || this.#stopped) return;
      if (response.status < 200 || response.status >= 300) {
        this.#requestFailed("GATEWAY_SERIES_CLOB_READ_FAILED", `the CLOB market-info request for ${conditionId}${sentAs} returned HTTP ${String(response.status)}; the window is reconsidered next cycle`, clobScope);
        return;
      }
      clob = readClobMarketInfoBody(response.bodyUtf8);
      if (clob.status === "invalid") {
        this.#requestFailed("GATEWAY_SERIES_CLOB_READ_INVALID", `the CLOB market-info body for ${conditionId}${sentAs} was not the documented ClobMarketDetails: ${clob.issues.join("; ")}; the window is reconsidered next cycle`, clobScope);
        return;
      }
      this.#clobReads += 1;
      this.#requestSucceeded(clobFrame.receipt);
      // R1-FABLE-03: this window's read succeeded — its failure incidents end,
      // so a later failure of the same window opens a NEW incident (pinned,
      // R2-FABLE-02(a): the gateway suite's "fail, succeed, fail again").
      this.#options.dispatcher.markIncidentClosed(clobScope.scope, "GATEWAY_SERIES_CLOB_READ_FAILED");
      this.#options.dispatcher.markIncidentClosed(clobScope.scope, "GATEWAY_SERIES_CLOB_READ_INVALID");
    }

    const verdict = judgeSeriesWindow(entry.series, entry.configHash, event, clob?.status === "ok" ? clob.reading : undefined);
    const judgedAt = (clobFrame ?? keysetFrame).receipt.receivedAt;
    if (verdict.verdict === "REFUSE") {
      await this.#refuse(entry, key, event, verdict.mismatches, judgedAt);
      return;
    }
    if (clobFrame === undefined) return; // unreachable: an admitted window always had its CLOB read
    // R1-03: still OPEN at the receipt of the CLOB read it was judged from —
    // the instant its admission events carry, on which the trader's re-judge
    // refuses too (`WINDOW_CLOSED`) — and at the gateway clock now, just
    // before the admission is committed. Not recorded: discovery never offers
    // a closed window again (`end_date_min`, the late rule).
    const closeMs = epochMsOfInstant(verdict.window.scheduledCloseAt);
    if (closeMs === undefined || closeMs <= clobFrame.receipt.nowMs || closeMs <= this.#options.clock.nowMs()) {
      this.#closedBeforeAdmission += 1;
      return;
    }
    await this.#admit(entry, verdict.window, keysetFrame, clobFrame);
  }

  async #refuse(
    entry: AdmittedSeries,
    key: string,
    event: SeriesWindowEventReading,
    mismatches: readonly string[],
    judgedAt: string,
  ): Promise<void> {
    const endDate = event.market?.endDate ?? null;
    const closeMs = endDate === null ? undefined : epochMsOfInstant(endDate);
    const record: AdmissionLedgerRecord = {
      key,
      seriesId: entry.series.seriesId,
      seriesConfigHash: entry.configHash,
      status: "REFUSED",
      judgedAt,
      ...(closeMs === undefined ? {} : { closeAt: isoFromMs(closeMs) }),
      mismatches: [...boundedMismatches(mismatches)],
    };
    // Recorded FIRST: a refusal is final, so it is durable before it is reported.
    if (!(await this.#persist(record))) return;
    this.#refused += 1;
    // The incident names the window by its DERIVED id when one can be derived
    // (so it taints no gateway epoch for a consumer, ADR-023 D2 rule 4);
    // otherwise it names no market.
    const startText = event.market?.eventStartTime ?? null;
    const startMs = startText === null ? undefined : epochMsOfInstant(startText);
    const conditionId = event.market?.conditionId ?? null;
    const derived = conditionId === null || startMs === undefined ? undefined : windowInternalMarketId(conditionId, startMs);
    this.#openWindowIncident(
      `${this.#options.feedId}:${key}`,
      "GATEWAY_SERIES_WINDOW_REFUSED",
      "NOTIFY",
      `series ${entry.series.seriesId} REFUSED window ${JSON.stringify(event.eventTitle)} (condition ${conditionId ?? "unreadable"}, event ${event.eventId ?? "unreadable"}): it does not match the review exactly, so it is not admitted and waits for a human review (ADR-030 Decision 1.4) — ${mismatches.join(" | ")}`,
      derived === undefined ? [] : [derived],
    );
  }

  #registration(
    record: Pick<AdmissionLedgerRecord, "seriesId">,
    window: Pick<AdmittedWindowRecord, "internalMarketId" | "conditionId" | "yesTokenId" | "noTokenId" | "tickSize" | "scheduledOpenAt" | "scheduledCloseAt">,
    series: ReviewedSeries,
    observedAt: string,
  ): AdmittedWindowRegistration {
    void record;
    return {
      internalMarketId: window.internalMarketId,
      conditionId: window.conditionId,
      yesTokenId: window.yesTokenId,
      noTokenId: window.noTokenId,
      tickSize: window.tickSize,
      minimumOrderSize: series.parameters.minimumOrderSize,
      // The judge admitted the window only if its own `Market.negRisk` (and its
      // event's flag) is exactly this reviewed value (`ROLLOVER-1` r5,
      // R5-ASTRA-01), so the reviewed value IS the venue's statement.
      negRisk: series.parameters.negRisk,
      tradingDelaySeconds: series.parameters.catalogTradingDelaySeconds,
      openTime: window.scheduledOpenAt,
      closeTime: window.scheduledCloseAt,
      observedAt,
    };
  }

  async #admit(entry: AdmittedSeries, facts: AdmittedWindowFacts, keysetFrame: CitedFrame, clobFrame: CitedFrame): Promise<void> {
    const judgedAt = clobFrame.receipt.receivedAt;
    const registered = this.#options.windows.register(this.#registration({ seriesId: entry.series.seriesId }, facts, entry.series, judgedAt));
    if (!registered.ok) {
      // A collision the `knows` check did not see (a race with nothing — the
      // cycle is sequential) or a universe refusal: not admitted, reported.
      this.#openWindowIncident(
        `${this.#options.feedId}:${facts.conditionId}`,
        "GATEWAY_SERIES_WINDOW_NOT_REGISTERED",
        "NOTIFY",
        `window ${facts.internalMarketId} (condition ${facts.conditionId}) matched its review but the directory refused it: ${registered.detail}; it is not admitted`,
        [facts.internalMarketId],
      );
      return;
    }
    const window: AdmittedWindowRecord = {
      internalMarketId: facts.internalMarketId,
      conditionId: facts.conditionId,
      gammaEventId: facts.gammaEventId,
      gammaMarketId: facts.gammaMarketId,
      yesTokenId: facts.yesTokenId,
      noTokenId: facts.noTokenId,
      scheduledOpenAt: facts.scheduledOpenAt,
      scheduledCloseAt: facts.scheduledCloseAt,
      tickSize: facts.tickSize,
      windowTitle: facts.windowTitle,
      parameterVersionRef: registered.parameterVersionRef,
      keysetRawIngestSeq: keysetFrame.rawFrameIngestSeq,
      clobRawIngestSeq: clobFrame.rawFrameIngestSeq,
    };
    const intent: AdmissionLedgerRecord = {
      key: facts.conditionId,
      seriesId: entry.series.seriesId,
      seriesConfigHash: entry.configHash,
      status: "ADMITTED",
      judgedAt,
      closeAt: facts.scheduledCloseAt,
      window,
    };
    // 1. The intent, durably, before the admission exists anywhere else.
    if (!(await this.#persist(intent))) {
      // Not admitted: the directory entry is released so the window can be
      // judged again once the ledger can be written.
      this.#options.windows.detach(intent);
      return;
    }
    this.#admitted += 1;
    await this.#publish(entry, intent, window, clobFrame);
  }

  /**
   * Dispatches the admission frame and, when all three events are PUBLISHED,
   * confirms the intent and attaches the window. Answers whether it published.
   */
  async #publish(entry: AdmittedSeries, record: AdmissionLedgerRecord, window: AdmittedWindowRecord, frame: CitedFrame): Promise<boolean> {
    const payloads = admissionPayloads(record, window, entry.series.parameters.minimumOrderSize);
    const draft = (eventType: string, payload: unknown): FrameDispatchEntry => ({
      draft: {
        eventType,
        schemaVersion: 1,
        source: "polymarket",
        sourceChannel: SERIES_ADMISSION_REST_CHANNEL,
        connectionId: frame.connectionId,
        subscriptionGeneration: 0,
        payload,
      } satisfies EnvelopeDraft,
      context: { receipt: frame.receipt, rawFrameIngestSeq: frame.rawFrameIngestSeq },
    });
    const outcomes = await Promise.all(
      this.#options.dispatcher.dispatchFrame([
        draft("MarketDiscovered", payloads.discovered),
        draft("TradingParametersChanged", payloads.parameters),
        draft("SeriesWindowAdmitted", payloads.admitted),
      ]),
    );
    const unpublished = outcomes.find((outcome) => !outcome.published);
    if (unpublished !== undefined && !unpublished.published) {
      this.#unpublished += 1;
      this.#openWindowIncident(
        `${this.#options.feedId}:${window.internalMarketId}`,
        "GATEWAY_SERIES_ADMISSION_UNPUBLISHED",
        "PAGE",
        `the admission of window ${window.internalMarketId} (${window.windowTitle}) was dispatched but not published (${unpublished.reason}: ${unpublished.detail}); its intent is in the admission ledger, it is NOT attached (no subscription, no lifecycle polling), and the next start re-emits it unchanged`,
        [window.internalMarketId],
      );
      return false;
    }
    const confirmed: AdmissionLedgerRecord = { ...record, admissionConfirmedAt: isoFromMs(this.#options.clock.nowMs()) };
    // A failed confirmation write is a PAGE incident; the intent stands and the
    // next epoch re-emits an identical admission, which consumers treat as the
    // same window. The window is attached either way: it IS published.
    await this.#persist(confirmed);
    this.#options.windows.attach(confirmed);
    return true;
  }

  /**
   * Re-emits the unconfirmed admissions an earlier epoch left, in scheduled
   * order, citing this epoch's journaled response; stops at the first that is
   * not published.
   *
   * `ROLLOVER-1` r1 (R1-04): every one, closed or not. An unconfirmed intent
   * may have been PUBLISHED before the earlier epoch ended (a crash between
   * dispatch and confirmation), so a trader may hold a position in its window;
   * retiring it here would stop delivering that window's resolution. A
   * re-emission is not a new judgement: a trader that holds the window sees a
   * `DUPLICATE`, and one that does not refuses a window already closed at the
   * re-emission's instant (`WINDOW_CLOSED`, R1-03). Once attached, the window
   * awaits its resolution like any other (`#tearDown`), in its cap slot
   * (`ROLLOVER-1` r2). Pinned by name (R2-FABLE-02(b)): the gateway suite's
   * "re-emits an unconfirmed intent even past its bound".
   */
  async #replay(frame: CitedFrame): Promise<boolean> {
    this.#replayOwed = false;
    for (const record of this.#options.ledger.liveWindows()) {
      if (record.admissionConfirmedAt !== undefined) continue;
      const window = record.window;
      const entry = this.#seriesById.get(record.seriesId);
      if (window === undefined || entry === undefined) continue;
      this.#replayed += 1;
      if (!(await this.#publish(entry, record, window, frame))) return false;
    }
    return true;
  }

  /**
   * `ROLLOVER-1` r3 (R3-ASTRA-01): re-publishes every OWED resolution an
   * earlier epoch left — observed, recorded, never published — with its
   * recorded payload unchanged, citing this epoch's journaled response (as
   * the admission replay does); the ledger keeps the WAL position of the
   * market-channel frame it was first derived from. Stops at the first that
   * is not published. A consumer that already handled the resolution (it was
   * published, but the epoch ended before that was recorded) ignores a repeat.
   */
  async #replayResolutions(frame: CitedFrame): Promise<boolean> {
    this.#resolutionReplayOwed = false;
    for (const record of this.#options.ledger.liveWindows()) {
      const resolution = record.resolution;
      if (resolution === undefined || resolution.publishedAt !== undefined) continue;
      this.#resolutionsReplayed += 1;
      const outcome = await this.#options.dispatcher.dispatch(
        {
          eventType: "MarketResolved",
          schemaVersion: 1,
          source: "polymarket",
          sourceChannel: SERIES_ADMISSION_REST_CHANNEL,
          ...(resolution.venueTimestamp === undefined ? {} : { venueTimestamp: resolution.venueTimestamp }),
          connectionId: frame.connectionId,
          subscriptionGeneration: 0,
          payload: resolution.payload,
        },
        { receipt: frame.receipt, rawFrameIngestSeq: frame.rawFrameIngestSeq },
      );
      if (!outcome.published) {
        await this.#resolutionOutcome(record.key, resolution, outcome);
        return false;
      }
      await this.#discharge(record.key, resolution);
    }
    return true;
  }

  // --------------------------------------------------------------------------
  // The journal, the ledger, the incidents
  // --------------------------------------------------------------------------

  /** Journals one response body FIRST; `undefined` (and a PAGE) when the WAL refused it. */
  #journal(endpoint: string, bodyUtf8: string): CitedFrame | undefined {
    const receipt = takeReceipt(this.#options.clock);
    const connectionId = this.#connectionIds.next();
    const outcome = this.#options.journal.record({
      source: "polymarket",
      endpoint,
      connectionId,
      subscriptionGeneration: 0,
      receipt,
      payloadUtf8: bodyUtf8,
    });
    if (!outcome.recorded) {
      this.#framesRefusedByWal += 1;
      this.#options.dispatcher.openIncident({
        scope: this.#options.feedId,
        reasonCode: "GATEWAY_WAL_FRAME_REFUSED",
        severity: "PAGE",
        detail: `the WAL refused a series-admission response (${outcome.reason}): ${outcome.detail}; nothing is derived from an unrecorded response`,
        feedId: this.#options.feedId,
      });
      return undefined;
    }
    this.#framesRecorded += 1;
    return { receipt, rawFrameIngestSeq: outcome.ingestSeq, connectionId };
  }

  async #persist(record: AdmissionLedgerRecord): Promise<boolean> {
    try {
      await this.#options.ledger.put(record);
      return true;
    } catch (error) {
      this.#ledgerFailed(error);
      return false;
    }
  }

  #ledgerFailed(error: unknown): void {
    this.#ledgerWriteFailures += 1;
    this.#options.dispatcher.openIncident({
      scope: this.#options.feedId,
      reasonCode: "GATEWAY_SERIES_LEDGER_WRITE_FAILED",
      severity: "PAGE",
      detail: `the series admission ledger could not be written (${describe(error)}); nothing that depends on the write is done — a window is never admitted or retired without its record`,
      feedId: this.#options.feedId,
    });
  }

  #requestSucceeded(receipt: GatewayReceipt): void {
    this.#lastSuccessMs = receipt.nowMs;
    if (this.#consecutiveFailures >= this.#options.consecutiveFailureThreshold) {
      this.#options.dispatcher.markIncidentClosed(this.#options.feedId, "GATEWAY_FEED_STALL");
    }
    this.#consecutiveFailures = 0;
  }

  /**
   * One failed request. A CLOB read is about ONE window, so its incident names
   * that window and is SCOPED to it (`window`; R1-FABLE-03: closed by that
   * window's next successful read); a keyset read is about no window, so it is
   * only COUNTED — a market-less incident per transient failure would taint
   * every book of the epoch (ADR-023 D2 rule 4) — and
   * `consecutiveFailureThreshold` of them in a row is the STALL below, raised
   * exactly as the lifecycle feed's is.
   */
  #requestFailed(
    reasonCode: string,
    detail: string,
    window: { readonly scope: string; readonly ids: readonly string[] } | undefined = undefined,
  ): void {
    this.#requestFailures += 1;
    this.#consecutiveFailures += 1;
    if (window !== undefined && window.ids.length > 0) {
      this.#openWindowIncident(window.scope, reasonCode, "NOTIFY", detail, window.ids);
    } else {
      this.#lastRequestFailure = `${reasonCode}: ${detail}`.slice(0, 500);
    }
    if (this.#consecutiveFailures !== this.#options.consecutiveFailureThreshold) return;
    const nowMs = this.#options.clock.nowMs();
    const stale: FeedStalePayload = {
      feedId: this.#options.feedId,
      detectedAt: isoFromMs(nowMs),
      ...(this.#lastSuccessMs === undefined ? {} : { lastMessageAt: isoFromMs(this.#lastSuccessMs) }),
      stalenessMs: this.#lastSuccessMs === undefined ? 0 : Math.max(0, nowMs - this.#lastSuccessMs),
    };
    void this.#options.dispatcher.dispatch({
      eventType: "FeedStale",
      schemaVersion: 1,
      source: "polymarket",
      sourceChannel: SERIES_ADMISSION_REST_CHANNEL,
      payload: stale,
    });
    this.#options.dispatcher.openIncident({
      scope: this.#options.feedId,
      reasonCode: "GATEWAY_FEED_STALL",
      severity: "NOTIFY",
      detail: `${String(this.#consecutiveFailures)} consecutive series-admission requests failed; no window can be admitted until one succeeds`,
      feedId: this.#options.feedId,
    });
  }

  /** An incident whose envelope names the window(s) it is about (`affectedMarketIds`). */
  #openWindowIncident(
    scope: string,
    reasonCode: string,
    severity: IncidentSeverity,
    detail: string,
    windowIds: readonly string[],
  ): void {
    // Never market-less (module header, "Incidents name a window"): with no
    // window to derive, the incident names its scope's REFERENCE id.
    const affectedMarketIds = windowIds.length > 0 ? windowIds : [incidentReferenceId(scope)];
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
          affectedMarketIds: [...affectedMarketIds],
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

  metrics(): SeriesAdmissionDriverMetrics {
    return {
      cycles: this.#cycles,
      cyclesSkippedOverlapping: this.#cyclesSkipped,
      pagesRead: this.#pagesRead,
      clobReads: this.#clobReads,
      requestFailures: this.#requestFailures,
      consecutiveFailures: this.#consecutiveFailures,
      framesRecorded: this.#framesRecorded,
      framesRefusedByWal: this.#framesRefusedByWal,
      windowsAdmitted: this.#admitted,
      windowsRefused: this.#refused,
      windowsRetiredResolved: this.#retiredResolved,
      windowsAwaitingResolution: this.#awaitingResolution,
      windowsSkippedLate: this.#skippedLate,
      windowsClosedBeforeAdmission: this.#closedBeforeAdmission,
      windowsDeferredByReadBudget: this.#deferredByReadBudget,
      windowsSkippedKnown: this.#skippedKnown,
      windowsHeldByCap: this.#heldByCap,
      windowsUnidentified: this.#unidentified,
      lastRequestFailure: this.#lastRequestFailure ?? null,
      admissionsUnpublished: this.#unpublished,
      admissionsReplayed: this.#replayed,
      ledgerWriteFailures: this.#ledgerWriteFailures,
      liveWindows: this.#options.ledger.liveWindows().length,
      resolutionsObserved: this.#resolutionsObserved,
      resolutionsUnpublished: this.#resolutionsUnpublished,
      resolutionsReplayed: this.#resolutionsReplayed,
      resolutionsOwed: this.#resolutionsOwed,
      resolutionsUnrecorded: this.#unrecorded.size,
      windowsRetiredByOperator: this.#retiredByOperator,
      operatorRetirementsDeferred: this.#operatorDeferred,
      operatorRetirementsUnmatched: this.#operatorUnmatched,
    };
  }
}

/**
 * The trading ids the window's `version` selects (ADR-030 Amendment 2 rule 1;
 * plan row A8), or `[]` when they cannot be selected — for the collision
 * check only. The field the version does not select is never read as an id.
 */
function selectedTokenPair(market: NonNullable<SeriesWindowEventReading["market"]>): readonly string[] {
  const selection = selectTradingIds(market);
  return selection.ok ? [selection.yesTokenId, selection.noTokenId] : [];
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
