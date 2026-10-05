/**
 * The SERIES-ADMISSION feed (`ROLLOVER-1`; ADR-030; the user's ruling A5 and
 * Q1-Q4): in PAPER and BACKTEST only, a REVIEWED series admits each new window
 * that matches it exactly, so one run spans many windows without a restart.
 *
 * ## The whole cycle
 *
 * Every `pollIntervalMs`, per reviewed series:
 *
 * 1. **Teardown first** (ADR-030 Decision 4.4). A live window whose
 *    `MarketResolved` this gateway dispatched is RETIRED: its tokens are
 *    unsubscribed, the lifecycle feed stops polling it, the directory releases
 *    it, and its ledger record becomes `RETIRED`. A window still unresolved
 *    `unresolvedTeardownSeconds` (reviewed) after its scheduled close is
 *    retired the same way, with a NOTIFY incident.
 * 2. **Discovery** — `GET /events/keyset?series_id=…&closed=false&order=endDate&ascending=true&limit=…&end_date_min=<now>`
 *    and its `after_cursor` pages, up to `maximumPages`
 *    (`docs/venue/verified-2026-10-04.md` F-07, §A2; never `series_slug`,
 *    U-30; never the `new_market` push, U-23/F-13). EVERY response body is
 *    journaled to the WAL BEFORE anything is read from it (ADR-030 Decision
 *    3.1, the `UNIV-4` rule); a refused frame derives nothing.
 * 3. **Candidates.** A window already in the admission ledger is never judged
 *    again (a refusal is final: Decision 1.4). A window that ends at or before
 *    now is late and skipped; one whose `eventStartTime` is more than
 *    `admissionLeadSeconds` ahead is not yet due. A window whose condition id
 *    or token a configured market already holds is skipped (never shadowed).
 * 4. **The cap** (Decision 1.8): with `maximumConcurrentWindows` live windows of
 *    the series, nothing more is admitted; a NOTIFY incident naming the held
 *    window stands until room frees, and the window is reconsidered next
 *    cycle.
 * 5. **The CLOB read** — `GET /clob-markets/{condition_id}` (S-D65), journaled
 *    first like every response — for the explicit pairing and `itode`.
 * 6. **The judge** (`@polymarket-bot/universe` `judgeSeriesWindow`): exact
 *    match on the reviewed pattern and every reviewed parameter; per-window
 *    facts for presence and form only (Decision 1.2). A REFUSED window is
 *    recorded in the ledger FIRST, then a NOTIFY incident names every
 *    mismatch (Decision 1.4, acceptance 1); it waits for a human review.
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
import type {
  DataQualityIncidentOpenedPayload,
  FeedStalePayload,
  IncidentSeverity,
  MarketDiscoveredPayload,
  SeriesWindowAdmittedPayload,
  TradingParametersChangedPayload,
} from "@polymarket-bot/domain";
import {
  admissionRunModeProblem,
  epochMsOfInstant,
  judgeSeriesWindow,
  windowInternalMarketId,
  type AdmittedWindowFacts,
  type ReviewedSeries,
} from "@polymarket-bot/universe";

import {
  boundedMismatches,
  type AdmissionLedger,
  type AdmissionLedgerRecord,
  type AdmittedWindowRecord,
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
  readonly windowsRetiredUnresolved: number;
  readonly windowsSkippedLate: number;
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
  /** Windows whose `MarketResolved` was dispatched (from the market feed). */
  readonly #resolved = new Set<string>();
  /** Unconfirmed admissions from an earlier epoch, re-emitted on the first successful poll. */
  #replayOwed: boolean;
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
  #retiredUnresolved = 0;
  #skippedLate = 0;
  #skippedKnown = 0;
  #heldByCap = 0;
  #unidentified = 0;
  /** The last keyset failure (counted, not published: see {@link #requestFailed}). */
  #lastRequestFailure: string | undefined;
  #unpublished = 0;
  #replayed = 0;
  #ledgerWriteFailures = 0;

  constructor(options: SeriesAdmissionDriverOptions) {
    // ADR-030 Decision 2.1 (acceptance 2): refuse to START outside PAPER/BACKTEST.
    const modeProblem = admissionRunModeProblem(options.runMode);
    if (modeProblem !== undefined) {
      throw new GatewayConfigurationError(modeProblem, { runMode: typeof options.runMode === "string" ? options.runMode : typeof options.runMode });
    }
    this.#options = options;
    this.#connectionIds = new ConnectionIdFactory(options.feedId);
    this.#seriesById = new Map(options.series.map((entry) => [entry.series.seriesId, entry]));
    // Re-register every live window in the directory, so the market feed can
    // attribute its tokens; attach only the CONFIRMED ones now (an unconfirmed
    // window is attached after its admission is re-published — module header).
    let owed = false;
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
    }
    this.#replayOwed = owed;
  }

  /** `ROLLOVER-1`: the market feed dispatched a `MarketResolved` for this market. */
  noteResolved(internalMarketId: string): void {
    this.#resolved.add(internalMarketId);
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

  /** Waits for an in-flight cycle and every ledger rewrite (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.#cycle !== undefined) {
      const cycle = this.#cycle;
      await cycle;
      if (this.#cycle === cycle) break;
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

  async #tearDown(nowMs: number): Promise<void> {
    for (const record of this.#options.ledger.liveWindows()) {
      const window = record.window;
      const entry = this.#seriesById.get(record.seriesId);
      if (window === undefined || entry === undefined) continue;
      const resolved = this.#resolved.has(window.internalMarketId);
      const closeMs = Date.parse(window.scheduledCloseAt);
      const overdue = Number.isFinite(closeMs) && nowMs >= closeMs + entry.series.unresolvedTeardownSeconds * 1000;
      if (!resolved && !overdue) continue;
      const reason = resolved ? "RESOLVED" : "UNRESOLVED_AFTER_CLOSE";
      const retired: AdmissionLedgerRecord = { ...record, status: "RETIRED", retiredAt: isoFromMs(nowMs), retiredReason: reason };
      if (!(await this.#persist(retired))) continue;
      this.#options.windows.detach(record);
      this.#resolved.delete(window.internalMarketId);
      if (resolved) {
        this.#retiredResolved += 1;
      } else {
        this.#retiredUnresolved += 1;
        this.#openWindowIncident(
          `${this.#options.feedId}:${window.internalMarketId}`,
          "GATEWAY_SERIES_WINDOW_UNRESOLVED",
          "NOTIFY",
          `admitted window ${window.internalMarketId} (${window.windowTitle}, condition ${window.conditionId}) had no MarketResolved ${String(entry.series.unresolvedTeardownSeconds)} s after its scheduled close ${window.scheduledCloseAt}; it is torn down unresolved (ADR-030 Decision 4.4) — reconcile its resolution by hand`,
          [window.internalMarketId],
        );
      }
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
        this.#requestFailed(entry, "GATEWAY_SERIES_DISCOVERY_FAILED", `the Gamma events-keyset request failed at the transport level: ${describe(error)}`);
        return;
      }
      const frame = this.#journal(url, response.bodyUtf8);
      if (frame === undefined || this.#stopped) return;
      if (response.status < 200 || response.status >= 300) {
        this.#requestFailed(entry, "GATEWAY_SERIES_DISCOVERY_FAILED", `the Gamma events-keyset request returned HTTP ${String(response.status)}`);
        return;
      }
      const verdict = readGammaSeriesEventsBody(response.bodyUtf8);
      if (verdict.status === "invalid") {
        this.#requestFailed(entry, "GATEWAY_SERIES_DISCOVERY_INVALID", `the Gamma events-keyset body was not the documented KeysetEventsResponse: ${verdict.issues.join("; ")}`);
        return;
      }
      this.#pagesRead += 1;
      this.#requestSucceeded(frame.receipt);
      if (this.#replayOwed) {
        const replayed = await this.#replay(frame);
        if (!replayed) return;
      }
      for (const event of verdict.events) candidates.push({ event, frame });
      if (verdict.nextCursor === null) break;
      cursor = verdict.nextCursor;
    }
    for (const candidate of candidates) {
      if (this.#stopped) return;
      await this.#consider(entry, candidate.event, candidate.frame);
    }
  }

  async #consider(entry: AdmittedSeries, event: SeriesWindowEventReading, keysetFrame: CitedFrame): Promise<void> {
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
    const nowMs = keysetFrame.receipt.nowMs;
    const endMs = market?.endDate === null || market === null ? undefined : epochMsOfInstant(market.endDate);
    if (endMs !== undefined && endMs <= nowMs) {
      this.#skippedLate += 1;
      return;
    }
    const startMs = market?.eventStartTime === null || market === null ? undefined : epochMsOfInstant(market.eventStartTime);
    if (startMs !== undefined && startMs - nowMs > this.#options.admissionLeadSeconds * 1000) return; // not yet due
    const tokens = market === null ? [] : parseTokenPair(market.clobTokenIds);
    if (conditionId !== null && this.#options.windows.knows(conditionId, tokens)) {
      this.#skippedKnown += 1;
      return;
    }
    const live = this.#options.ledger.liveWindows(entry.series.seriesId).length;
    const capScope = `${this.#options.feedId}:${entry.series.seriesId}:cap`;
    if (live >= entry.series.maximumConcurrentWindows) {
      this.#heldByCap += 1;
      // Named by the HELD window's derived id — a market no consumer runs, so
      // the incident neither pauses a live window nor taints the epoch.
      this.#openWindowIncident(
        capScope,
        "GATEWAY_SERIES_CAP_REACHED",
        "NOTIFY",
        `series ${entry.series.seriesId} has ${String(live)} live windows, its reviewed cap (maximumConcurrentWindows ${String(entry.series.maximumConcurrentWindows)}, ADR-030 Decision 1.8); window ${conditionId ?? key} is held until one is torn down`,
        derivedWindowIds(conditionId, startMs),
      );
      return;
    }
    this.#options.dispatcher.markIncidentClosed(capScope, "GATEWAY_SERIES_CAP_REACHED");

    // The CLOB read — journaled first, like every response.
    let clob: ReturnType<typeof readClobMarketInfoBody> | undefined;
    let clobFrame: CitedFrame | undefined;
    if (conditionId !== null && conditionId !== "" && conditionId.length <= 200) {
      const url = clobMarketInfoUrl(conditionId, this.#options.clobBaseUrl);
      let response;
      try {
        response = await requestClobMarketInfo({
          http: this.#options.http,
          conditionId,
          ...(this.#options.clobBaseUrl === undefined ? {} : { baseUrl: this.#options.clobBaseUrl }),
        });
      } catch (error) {
        this.#requestFailed(entry, "GATEWAY_SERIES_CLOB_READ_FAILED", `the CLOB market-info request for ${conditionId} failed at the transport level: ${describe(error)}; the window is reconsidered next cycle`, derivedWindowIds(conditionId, startMs));
        return;
      }
      clobFrame = this.#journal(url, response.bodyUtf8);
      if (clobFrame === undefined || this.#stopped) return;
      if (response.status < 200 || response.status >= 300) {
        this.#requestFailed(entry, "GATEWAY_SERIES_CLOB_READ_FAILED", `the CLOB market-info request for ${conditionId} returned HTTP ${String(response.status)}; the window is reconsidered next cycle`, derivedWindowIds(conditionId, startMs));
        return;
      }
      clob = readClobMarketInfoBody(response.bodyUtf8);
      if (clob.status === "invalid") {
        this.#requestFailed(entry, "GATEWAY_SERIES_CLOB_READ_INVALID", `the CLOB market-info body for ${conditionId} was not the documented ClobMarketDetails: ${clob.issues.join("; ")}; the window is reconsidered next cycle`, derivedWindowIds(conditionId, startMs));
        return;
      }
      this.#clobReads += 1;
      this.#requestSucceeded(clobFrame.receipt);
    }

    const verdict = judgeSeriesWindow(entry.series, entry.configHash, event, clob?.status === "ok" ? clob.reading : undefined);
    const judgedAt = (clobFrame ?? keysetFrame).receipt.receivedAt;
    if (verdict.verdict === "REFUSE") {
      await this.#refuse(entry, key, event, verdict.mismatches, judgedAt);
      return;
    }
    if (clobFrame === undefined) return; // unreachable: an admitted window always had its CLOB read
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
   * not published. A window whose unresolved-teardown bound has passed is
   * retired instead: there is nothing left to admit it into.
   */
  async #replay(frame: CitedFrame): Promise<boolean> {
    this.#replayOwed = false;
    for (const record of this.#options.ledger.liveWindows()) {
      if (record.admissionConfirmedAt !== undefined) continue;
      const window = record.window;
      const entry = this.#seriesById.get(record.seriesId);
      if (window === undefined || entry === undefined) continue;
      const closeMs = Date.parse(window.scheduledCloseAt);
      if (Number.isFinite(closeMs) && frame.receipt.nowMs >= closeMs + entry.series.unresolvedTeardownSeconds * 1000) {
        await this.#persist({ ...record, status: "RETIRED", retiredAt: frame.receipt.receivedAt, retiredReason: "UNRESOLVED_AFTER_CLOSE" });
        this.#options.windows.detach(record);
        continue;
      }
      this.#replayed += 1;
      if (!(await this.#publish(entry, record, window, frame))) return false;
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
   * that window (`windowIds`); a keyset read is about no window, so it is only
   * COUNTED — a market-less incident per transient failure would taint every
   * book of the epoch (ADR-023 D2 rule 4) — and `consecutiveFailureThreshold`
   * of them in a row is the STALL below, raised exactly as the lifecycle
   * feed's is.
   */
  #requestFailed(entry: AdmittedSeries, reasonCode: string, detail: string, windowIds: readonly string[] = []): void {
    this.#requestFailures += 1;
    this.#consecutiveFailures += 1;
    if (windowIds.length > 0) {
      this.#openWindowIncident(`${this.#options.feedId}:${entry.series.seriesId}:${reasonCode}`, reasonCode, "NOTIFY", detail, windowIds);
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
      windowsRetiredUnresolved: this.#retiredUnresolved,
      windowsSkippedLate: this.#skippedLate,
      windowsSkippedKnown: this.#skippedKnown,
      windowsHeldByCap: this.#heldByCap,
      windowsUnidentified: this.#unidentified,
      lastRequestFailure: this.#lastRequestFailure ?? null,
      admissionsUnpublished: this.#unpublished,
      admissionsReplayed: this.#replayed,
      ledgerWriteFailures: this.#ledgerWriteFailures,
      liveWindows: this.#options.ledger.liveWindows().length,
    };
  }
}

/** The JSON-encoded `clobTokenIds` pair, or `[]` when unreadable (for the collision check only). */
function parseTokenPair(text: string | null): readonly string[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
