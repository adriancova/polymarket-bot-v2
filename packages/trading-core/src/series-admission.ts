/**
 * The trader's SERIES ADMISSIONS (`ROLLOVER-1`; ADR-030 Decisions 1-4; the
 * user's ruling A5 and Q1-Q4): the windows this run has admitted, the
 * RE-JUDGE every admission passes before it is added, the concurrent-window
 * cap, and the window's attach and teardown.
 *
 * ## The re-judge (defence in depth; ADR-030 Decision 1.4-1.5)
 *
 * The gateway admitted the window against ITS copy of the review
 * (`@polymarket-bot/universe`). The trader admits it only if, against ITS OWN
 * copy — the one its run record pins (ruling Q4):
 *
 * 1. the series is one this trader reviews (`UNKNOWN_SERIES`);
 * 2. the event's `seriesConfigHash` is the hash of this trader's review: the
 *    two sides reviewed the same document (`REVIEW_MISMATCH`);
 * 3. a `MarketDiscovered@1` for the same window arrived first and agrees on
 *    its condition id, tokens and series (`DISCOVERY_MISSING`,
 *    `DISCOVERY_DISAGREES`) — the admission is published with the existing
 *    contract (acceptance 5), and the trader holds both to each other;
 * 4. the per-window facts are present and well formed — distinct tokens, a
 *    derived internal id that IS the window's (`windowInternalMarketId`), and
 *    a title that converts to exactly the admitted interval of the reviewed
 *    length (ruling Q3; `MALFORMED`, `IDENTITY_NOT_DERIVED`, `SCHEDULE`);
 * 5. the tick size is one the review accepts (`TICK_SIZE`);
 * 6. it shadows no market this trader already runs (`SHADOWS_KNOWN_MARKET`);
 * 7. the series has fewer live windows than its reviewed cap
 *    (`CAP_REACHED`; ADR-030 Decision 1.8 — the trader enforces the cap
 *    itself, whatever the gateway admitted).
 *
 * An identical admission seen again (a replayed stream, a gateway re-emission)
 * is a `DUPLICATE` and changes nothing; a different one under the same id is
 * refused. Every refusal is counted by code, with its detail kept (bounded),
 * and the window is NOT traded: fail closed.
 *
 * ## Attach and teardown
 *
 * An admitted window gets what a configured market gets at startup — its
 * `MarketState`, its token assets, its §9.7 allocation market — built from
 * the event's per-window facts and the review's parameters, and, for every
 * series-bound instance of its series, a runtime of its own on the instance's
 * run (the run's shared evaluation sequence, ruling Q2). The loop tears a
 * window down once its resolution was handled — or, never resolved, once the
 * reviewed `unresolvedTeardownSeconds` have passed since its close — and it
 * holds no working order: its books, features, strategy state and cadence
 * entry are released; its ledger rows, token assets and allocation scope stay
 * (ADR-030 Decision 4.4: "Its ledger rows stay").
 *
 * Everything here runs on EVENT time, from the stream, so a replay of the same
 * envelopes admits and tears down the same windows (acceptance 3).
 */

import type { MarketConfig, ConfiguredSeries } from "./config.js";
import { deriveWindowSchedule, epochMsOfInstant, windowInternalMarketId } from "./series.js";

/** Why the trader did not admit a window. */
export type AdmissionRefusalCode =
  | "UNKNOWN_SERIES"
  | "REVIEW_MISMATCH"
  | "DISCOVERY_MISSING"
  | "DISCOVERY_DISAGREES"
  | "MALFORMED"
  | "IDENTITY_NOT_DERIVED"
  | "SCHEDULE"
  | "TICK_SIZE"
  | "SHADOWS_KNOWN_MARKET"
  | "CAP_REACHED"
  | "DUPLICATE_DISAGREES"
  | "STORE_UNAVAILABLE"
  | "ATTACH_FAILED";

/** One window this run admitted. */
export interface AdmittedWindow {
  readonly seriesId: string;
  readonly marketId: string;
  readonly conditionId: string;
  readonly yesTokenId: string;
  readonly noTokenId: string;
  readonly openAt: string;
  readonly closeAt: string;
  readonly closeEpochMs: number;
  readonly tickSize: string;
  readonly windowTitle: string;
  readonly unresolvedTeardownSeconds: number;
  /** The admission's facts as the event stated them: a later duplicate is compared with it. */
  readonly signature: string;
  /** The market as the loop runs it (`config.ts` `MarketConfig`). */
  readonly market: MarketConfig;
  /** The review's catalog statements, for the window's catalog row. */
  readonly catalog: {
    readonly yesLabel: string;
    readonly noLabel: string;
    readonly negRisk: boolean;
    readonly tradingDelaySeconds: number;
  };
}

export type AdmissionVerdict =
  | { readonly kind: "ADMIT"; readonly window: AdmittedWindow }
  | { readonly kind: "DUPLICATE"; readonly marketId: string }
  | { readonly kind: "REFUSE"; readonly code: AdmissionRefusalCode; readonly detail: string; readonly marketId: string | undefined };

/** How a window is attached to and detached from the process (`trader.ts` binds it). */
export interface WindowAttachment {
  /** Builds the window's state and registers its runtimes; `detail` when it could not. */
  attach(window: AdmittedWindow): { readonly ok: true } | { readonly ok: false; readonly detail: string };
  /** Releases the window's books, features and runtimes (ledger rows stay). */
  detach(window: AdmittedWindow): void;
}

/** What the loop is told about each admission and teardown (output only). */
export type AdmissionNotice =
  | { readonly kind: "ADMITTED"; readonly window: AdmittedWindow }
  | { readonly kind: "REFUSED"; readonly code: AdmissionRefusalCode; readonly detail: string; readonly marketId: string | undefined }
  | { readonly kind: "TORN_DOWN"; readonly window: AdmittedWindow; readonly reason: "RESOLVED" | "UNRESOLVED_AFTER_CLOSE" };

export interface AdmissionMetrics {
  readonly admitted: number;
  readonly duplicates: number;
  readonly refusals: Readonly<Record<string, number>>;
  readonly tornDownResolved: number;
  readonly tornDownUnresolved: number;
  readonly teardownsBlocked: number;
  readonly live: number;
  /** The most recent refusals, newest last (bounded). */
  readonly lastRefusals: readonly string[];
}

/** How many `MarketDiscovered` the admissions remember while their admission is awaited. */
const MAX_PENDING_DISCOVERIES = 256;
/** How many refusal details the metrics keep. */
const MAX_KEPT_REFUSALS = 32;

interface Discovered {
  readonly conditionId: string;
  readonly yesTokenId: string;
  readonly noTokenId: string;
  readonly seriesId: string | undefined;
}

function ownString(record: unknown, key: string): string | undefined {
  if (typeof record !== "object" || record === null || !Object.hasOwn(record, key)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

const TOKEN = /^(?:0|[1-9][0-9]*)$/u;

export class SeriesWindowAdmissions {
  readonly #series: ReadonlyMap<string, ConfiguredSeries>;
  readonly #attachment: WindowAttachment;
  readonly #isKnownMarket: (marketId: string, conditionId: string, tokenIds: readonly string[]) => boolean;
  readonly #discovered = new Map<string, Discovered>();
  readonly #live = new Map<string, AdmittedWindow>();
  /** Every window this run ever admitted, by market id: a duplicate is judged against it. */
  readonly #seen = new Map<string, string>();
  readonly #refusals = new Map<string, number>();
  readonly #lastRefusals: string[] = [];
  #admitted = 0;
  #duplicates = 0;
  #tornDownResolved = 0;
  #tornDownUnresolved = 0;
  #teardownsBlocked = 0;

  constructor(options: {
    readonly series: readonly ConfiguredSeries[];
    readonly attachment: WindowAttachment;
    /** Whether a market id, condition id or token belongs to a market this trader already runs. */
    readonly isKnownMarket: (marketId: string, conditionId: string, tokenIds: readonly string[]) => boolean;
  }) {
    this.#series = new Map(options.series.map((entry) => [entry.series.seriesId, entry]));
    this.#attachment = options.attachment;
    this.#isKnownMarket = options.isKnownMarket;
  }

  /** Remembers one `MarketDiscovered@1` of a reviewed series (bounded; the oldest is forgotten first). */
  observeDiscovered(payload: unknown): void {
    const marketId = ownString(payload, "internalMarketId");
    const conditionId = ownString(payload, "conditionId");
    const yesTokenId = ownString(payload, "yesTokenId");
    const noTokenId = ownString(payload, "noTokenId");
    const seriesId = ownString(payload, "seriesId");
    if (marketId === undefined || conditionId === undefined || yesTokenId === undefined || noTokenId === undefined) return;
    if (seriesId === undefined || !this.#series.has(seriesId)) return; // not a window of a series this trader reviews
    this.#discovered.delete(marketId);
    this.#discovered.set(marketId, { conditionId, yesTokenId, noTokenId, seriesId });
    while (this.#discovered.size > MAX_PENDING_DISCOVERIES) {
      const oldest = this.#discovered.keys().next().value;
      if (oldest === undefined) break;
      this.#discovered.delete(oldest);
    }
  }

  /** The RE-JUDGE of one `SeriesWindowAdmitted@1` payload (module header). Pure apart from counters. */
  judge(payload: unknown): AdmissionVerdict {
    const marketId = ownString(payload, "internalMarketId");
    const refuse = (code: AdmissionRefusalCode, detail: string): AdmissionVerdict => this.#refuse(code, detail, marketId);
    const conditionId = ownString(payload, "conditionId");
    const seriesId = ownString(payload, "seriesId");
    const hash = ownString(payload, "seriesConfigHash");
    const yesTokenId = ownString(payload, "yesTokenId");
    const noTokenId = ownString(payload, "noTokenId");
    const openAt = ownString(payload, "scheduledOpenAt");
    const closeAt = ownString(payload, "scheduledCloseAt");
    const tickSize = ownString(payload, "tickSize");
    const title = ownString(payload, "windowTitle");
    if (
      marketId === undefined ||
      conditionId === undefined ||
      seriesId === undefined ||
      hash === undefined ||
      yesTokenId === undefined ||
      noTokenId === undefined ||
      openAt === undefined ||
      closeAt === undefined ||
      tickSize === undefined ||
      title === undefined
    ) {
      return refuse("MALFORMED", "the admission lacks a field its contract requires");
    }
    const signature = [conditionId, seriesId, hash, yesTokenId, noTokenId, openAt, closeAt, tickSize, title].join("|");
    const seen = this.#seen.get(marketId);
    if (seen !== undefined) {
      if (seen === signature) {
        this.#duplicates += 1;
        return { kind: "DUPLICATE", marketId };
      }
      return refuse("DUPLICATE_DISAGREES", `window ${marketId} was admitted before with other facts; an admission is never rewritten`);
    }
    const configured = this.#series.get(seriesId);
    if (configured === undefined) {
      return refuse("UNKNOWN_SERIES", `series ${seriesId} is not one this trader reviews; its windows are never admitted here`);
    }
    if (hash !== configured.configHash) {
      return refuse(
        "REVIEW_MISMATCH",
        `the window was admitted under review ${hash}, but this trader's run pins review ${configured.configHash} of ${seriesId}; ` +
          "the gateway and the trader must review the same document (ADR-030 Decision 4.2)",
      );
    }
    const discovered = this.#discovered.get(marketId);
    if (discovered === undefined) {
      return refuse("DISCOVERY_MISSING", `no MarketDiscovered@1 for window ${marketId} preceded its admission`);
    }
    if (
      discovered.conditionId !== conditionId ||
      discovered.yesTokenId !== yesTokenId ||
      discovered.noTokenId !== noTokenId ||
      discovered.seriesId !== seriesId
    ) {
      return refuse("DISCOVERY_DISAGREES", `MarketDiscovered@1 and SeriesWindowAdmitted@1 disagree about window ${marketId}`);
    }
    if (!TOKEN.test(yesTokenId) || !TOKEN.test(noTokenId) || yesTokenId === noTokenId || conditionId === "") {
      return refuse("MALFORMED", `window ${marketId}: the tokens must be two distinct canonical token ids and the condition id present`);
    }
    const review = configured.series;
    const schedule = deriveWindowSchedule(title, review.window, openAt, closeAt);
    if (!schedule.ok) {
      return refuse("SCHEDULE", `window ${marketId}: ${schedule.problems.join("; ")}`);
    }
    if (windowInternalMarketId(conditionId, schedule.openEpochMs) !== marketId) {
      return refuse("IDENTITY_NOT_DERIVED", `window ${marketId} is not the derived id of condition ${conditionId} opening ${schedule.openAt}`);
    }
    if (!review.parameters.allowedTickSizes.includes(tickSize)) {
      return refuse("TICK_SIZE", `window ${marketId}: tick size ${tickSize} is not one of the reviewed ${JSON.stringify(review.parameters.allowedTickSizes)}`);
    }
    if (this.#isKnownMarket(marketId, conditionId, [yesTokenId, noTokenId])) {
      return refuse("SHADOWS_KNOWN_MARKET", `window ${marketId} (condition ${conditionId}) shadows a market this trader already runs`);
    }
    const live = [...this.#live.values()].filter((window) => window.seriesId === seriesId).length;
    if (live >= review.maximumConcurrentWindows) {
      return refuse(
        "CAP_REACHED",
        `series ${seriesId} has ${String(live)} live windows, its reviewed cap (maximumConcurrentWindows ${String(review.maximumConcurrentWindows)}, ADR-030 Decision 1.8)`,
      );
    }
    const closeEpochMs = epochMsOfInstant(schedule.closeAt);
    if (closeEpochMs === undefined) return refuse("SCHEDULE", `window ${marketId}: the close is not an instant`);
    return {
      kind: "ADMIT",
      window: {
        seriesId,
        marketId,
        conditionId,
        yesTokenId,
        noTokenId,
        openAt: schedule.openAt,
        closeAt: schedule.closeAt,
        closeEpochMs,
        tickSize,
        windowTitle: title,
        unresolvedTeardownSeconds: review.unresolvedTeardownSeconds,
        signature,
        market: {
          marketId,
          conditionId,
          yesTokenId,
          noTokenId,
          tickSize,
          minimumOrderSize: review.parameters.minimumOrderSize,
          makerFeeRate: review.trading.makerFeeRate,
          takerFeeRate: review.trading.takerFeeRate,
          openTime: schedule.openAt,
          closeTime: schedule.closeAt,
          // §6 invariant 9: the admission is the window's first parameter
          // version, the version the gateway's TradingParametersChanged@1 names.
          parametersVersion: 1,
          settlementReadiness: { modelDependentActivationAllowed: review.settlement.modelDependentActivationAllowed },
          seriesKey: review.trading.seriesKey,
          underlyingKey: review.trading.underlyingKey,
          resolutionWindowKey: review.trading.resolutionWindowKey,
        },
        catalog: {
          yesLabel: review.outcomes[0] ?? "YES",
          noLabel: review.outcomes[1] ?? "NO",
          negRisk: review.parameters.negRisk,
          tradingDelaySeconds: review.parameters.catalogTradingDelaySeconds,
        },
      },
    };
  }

  /** Attaches an ADMIT verdict's window (after its catalog row is durable) and records it live. */
  attach(window: AdmittedWindow): { readonly ok: true } | { readonly ok: false; readonly detail: string } {
    const attached = this.#attachment.attach(window);
    if (!attached.ok) {
      this.#refuse("ATTACH_FAILED", `window ${window.marketId} could not be attached: ${attached.detail}`, window.marketId);
      return attached;
    }
    this.#live.set(window.marketId, window);
    this.#seen.set(window.marketId, window.signature);
    this.#discovered.delete(window.marketId);
    this.#admitted += 1;
    return { ok: true };
  }

  /** Records a refusal the loop decided (a store failure) for one window. */
  refuse(code: AdmissionRefusalCode, detail: string, marketId: string | undefined): void {
    this.#refuse(code, detail, marketId);
  }

  /** Tears one live window down (the loop judged it due and idle). */
  detach(marketId: string, reason: "RESOLVED" | "UNRESOLVED_AFTER_CLOSE"): AdmittedWindow | undefined {
    const window = this.#live.get(marketId);
    if (window === undefined) return undefined;
    this.#attachment.detach(window);
    this.#live.delete(marketId);
    if (reason === "RESOLVED") this.#tornDownResolved += 1;
    else this.#tornDownUnresolved += 1;
    return window;
  }

  /** Counts a teardown the loop postponed because the window still holds work. */
  noteTeardownBlocked(): void {
    this.#teardownsBlocked += 1;
  }

  /** The live windows, in admission order. */
  liveWindows(): readonly AdmittedWindow[] {
    return [...this.#live.values()];
  }

  isLive(marketId: string): boolean {
    return this.#live.has(marketId);
  }

  metrics(): AdmissionMetrics {
    return Object.freeze({
      admitted: this.#admitted,
      duplicates: this.#duplicates,
      refusals: Object.freeze(Object.fromEntries([...this.#refusals].sort(([left], [right]) => (left < right ? -1 : 1)))),
      tornDownResolved: this.#tornDownResolved,
      tornDownUnresolved: this.#tornDownUnresolved,
      teardownsBlocked: this.#teardownsBlocked,
      live: this.#live.size,
      lastRefusals: Object.freeze([...this.#lastRefusals]),
    });
  }

  #refuse(code: AdmissionRefusalCode, detail: string, marketId: string | undefined): AdmissionVerdict {
    this.#refusals.set(code, (this.#refusals.get(code) ?? 0) + 1);
    this.#lastRefusals.push(`${code}: ${detail}`);
    if (this.#lastRefusals.length > MAX_KEPT_REFUSALS) this.#lastRefusals.shift();
    return { kind: "REFUSE", code, detail, marketId };
  }
}
