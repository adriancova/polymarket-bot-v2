/**
 * Classifying market windows (ADR-028 Decisions 2.3 and 3).
 *
 * A window is **classified** when it is known whether it is pinned, and how.
 * Until then, no raw segment it could overlap may expire.
 *
 * - A window **a trader is responsible for** is classified when it has closed
 *   **and** the trader's decision, order, fill and halt rows for it are
 *   durable. Durable is read from the database the trader writes: the
 *   trader's event-time frontier — the newest instant its persisted decisions
 *   carry — must have passed the window's end (plus a grace margin). A trader
 *   that lags or is stopped has not passed it, so the window stays
 *   unclassified; whether the process is running does not matter.
 * - A window **only the gateway records** is classified when it has closed.
 *   It has no intent, fill, refusal or halt, so only an operator pin keeps it.
 *
 * A classified window is pinned when it had a fill (kept forever), or an
 * intent, a refusal or a halt (30 days). The pin holds the whole window plus
 * the reference lead-in, **widened** so that every evidence instant — above
 * all, the source event of every decision that could be in a fill's chain —
 * lies inside it (Decision 3.4), then preceded by the lead-in.
 */

import type { MarketWindow } from "./windows.js";

/** One decision with intents, with what is known of its source event. */
export type IntentEvidence = {
  readonly evaluatedAtMs: number;
  readonly sourceEventId: string | null;
  readonly gatewayEpoch: string | null;
  readonly ingestSeq: string | null;
};

/** The trader's durable rows for one market. */
export type MarketEvidence = {
  readonly fillsAtMs: readonly number[];
  readonly intents: readonly IntentEvidence[];
  readonly refusalsAtMs: readonly number[];
  readonly haltsAtMs: readonly number[];
};

/**
 * The read-only source of the trader's durable rows. The PostgreSQL adapter is
 * `evidence-postgres.ts`; it only ever reads.
 */
export interface TraderEvidenceSource {
  /**
   * The event-time instant through which EVERY listed instance's rows are
   * durable — the minimum over the instances of each one's newest durable
   * instant — or `null` when any instance has none.
   */
  durableThroughMs(instanceIds: readonly string[]): Promise<number | null>;
  /** Every durable intent, fill, refusal and halt for one market. */
  marketEvidence(window: MarketWindow, instanceIds: readonly string[]): Promise<MarketEvidence>;
}

/** The pin classes of ADR-028 Decision 3.1. */
export type PinClass = "fill" | "halt" | "refusal" | "intent";

/** 30 days, the non-fill pin horizon (ADR-028 Decision 3.5). */
export const NON_FILL_PIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a pin of a class lasts: `null` is forever (ADR-028 Decision 3.5, 3.7). */
export function pinRetentionMs(pinClass: PinClass): number | null {
  return pinClass === "fill" ? null : NON_FILL_PIN_RETENTION_MS;
}

/** A window's classification. */
export type WindowClassification =
  | { readonly windowId: string; readonly state: "unclassified"; readonly reason: string }
  | {
      readonly windowId: string;
      readonly state: "classified";
      readonly pinClass: PinClass | null;
      /** The pinned range, in receipt instants, or `null` when unpinned. */
      readonly pinFromMs: number | null;
      readonly pinToMs: number | null;
      /** When the pin may lapse; `null` is forever (or unpinned). */
      readonly keepUntilMs: number | null;
      /** Source events that must lie inside the pin (Decision 3.4). */
      readonly sourceEvents: readonly IntentEvidence[];
      readonly evidenceCounts: {
        readonly fills: number;
        readonly intents: number;
        readonly refusals: number;
        readonly halts: number;
      };
    };

export type ClassifyOptions = {
  readonly nowMs: number;
  /** The reference lead-in before a pinned range (the longest feature lookback). */
  readonly leadInMs: number;
  /** Margin the trader's frontier must pass the window's end by. */
  readonly durabilityGraceMs: number;
  readonly evidence: TraderEvidenceSource;
};

/** Classify one window. */
export async function classifyWindow(window: MarketWindow, options: ClassifyOptions): Promise<WindowClassification> {
  if (options.nowMs < window.windowEndMs) {
    return { windowId: window.windowId, state: "unclassified", reason: "the window has not closed" };
  }
  if (window.responsibility.kind === "gateway-only") {
    return {
      windowId: window.windowId,
      state: "classified",
      pinClass: null,
      pinFromMs: null,
      pinToMs: null,
      keepUntilMs: null,
      sourceEvents: [],
      evidenceCounts: { fills: 0, intents: 0, refusals: 0, halts: 0 },
    };
  }
  const instanceIds = window.responsibility.instanceIds;
  const durable = await options.evidence.durableThroughMs(instanceIds);
  if (durable === null || durable < window.windowEndMs + options.durabilityGraceMs) {
    return {
      windowId: window.windowId,
      state: "unclassified",
      reason:
        durable === null
          ? "the responsible trader has no durable rows yet"
          : "the responsible trader's durable rows have not passed the window's end",
    };
  }
  const evidence = await options.evidence.marketEvidence(window, instanceIds);
  const pinClass: PinClass | null =
    evidence.fillsAtMs.length > 0
      ? "fill"
      : evidence.haltsAtMs.length > 0
        ? "halt"
        : evidence.refusalsAtMs.length > 0
          ? "refusal"
          : evidence.intents.length > 0
            ? "intent"
            : null;
  const evidenceCounts = {
    fills: evidence.fillsAtMs.length,
    intents: evidence.intents.length,
    refusals: evidence.refusalsAtMs.length,
    halts: evidence.haltsAtMs.length,
  };
  if (pinClass === null) {
    return {
      windowId: window.windowId,
      state: "classified",
      pinClass: null,
      pinFromMs: null,
      pinToMs: null,
      keepUntilMs: null,
      sourceEvents: [],
      evidenceCounts,
    };
  }
  // The whole window, widened to hold every evidence instant — every decision
  // with intents, whose source event could be in a fill's chain — and then
  // preceded by the lead-in (Decision 3.2, 3.4).
  const instants = [
    ...evidence.fillsAtMs,
    ...evidence.intents.map((intent) => intent.evaluatedAtMs),
    ...evidence.refusalsAtMs,
    ...evidence.haltsAtMs,
  ];
  const fromMs = Math.min(window.windowStartMs, ...instants) - options.leadInMs;
  const toMs = Math.max(window.windowEndMs, ...instants);
  const retention = pinRetentionMs(pinClass);
  return {
    windowId: window.windowId,
    state: "classified",
    pinClass,
    pinFromMs: fromMs,
    pinToMs: toMs,
    keepUntilMs: retention === null ? null : window.windowEndMs + retention,
    sourceEvents: evidence.intents,
    evidenceCounts,
  };
}

/**
 * The range an UNCLASSIFIED window could still pin: from the lead-in before
 * the earliest instant a responsible trader could have acted, to the window's
 * end. Every segment overlapping it is held.
 */
export function potentialRange(window: MarketWindow, leadInMs: number): { fromMs: number; toMs: number } {
  return { fromMs: window.responsibleFromMs - leadInMs, toMs: window.windowEndMs };
}

/** An in-memory evidence source, for tests and for a deployment with no trader. */
export function staticEvidenceSource(input: {
  readonly durableThroughMs: ReadonlyMap<string, number>;
  readonly evidence: ReadonlyMap<string, MarketEvidence>;
}): TraderEvidenceSource {
  return {
    async durableThroughMs(instanceIds: readonly string[]): Promise<number | null> {
      // Every responsible instance must have passed: the minimum, and none
      // when any instance has no durable rows at all.
      const values = instanceIds.map((id) => input.durableThroughMs.get(id));
      if (values.length === 0 || values.some((value) => value === undefined)) return null;
      return Math.min(...(values as number[]));
    },
    async marketEvidence(window: MarketWindow): Promise<MarketEvidence> {
      return input.evidence.get(window.marketId) ?? { fillsAtMs: [], intents: [], refusalsAtMs: [], haltsAtMs: [] };
    },
  };
}
