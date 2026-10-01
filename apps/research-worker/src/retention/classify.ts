/**
 * Classifying market windows (ADR-028 Decisions 2.3 and 3).
 *
 * A window is **classified** when it is known whether it is pinned, and how.
 * Until then, no raw segment it could overlap may expire.
 *
 * - A window **a trader is responsible for** is classified when it has closed
 *   **and** the trader's decision, order, fill and halt rows for it are
 *   durable. That is established in **dispatch order**, never from receipt
 *   instants (which can step backwards, ADR-026 Context 5): every responsible
 *   instance's durable frontier — the largest `(gatewayEpoch, ingestSeq)` its
 *   persisted decisions carry — must have passed every sealed frame that could
 *   be stamped inside the window's range (`wal-index.ts`,
 *   `dispatchRequirements`). A trader that lags or is stopped has not passed
 *   it, and a trader whose decisions carry no dispatch position
 *   (`H1R1-PROVENANCE`) cannot show that it has, so the window stays
 *   unclassified; whether the process is running does not matter.
 * - A window **only the gateway records** is classified when it has closed.
 *   It has no intent, fill, refusal or halt, so only an operator pin keeps it.
 *
 * A classified window is pinned when it had a fill (kept forever), or an
 * intent, a refusal or a halt (30 days). The pin holds the whole window plus
 * the reference lead-in, **widened** so that every evidence instant — above
 * all, the source event of every decision that could be in a fill's chain —
 * lies inside it (Decision 3.4), then preceded by the lead-in. A source event
 * named by its dispatch identity widens the pin to the whole span of the
 * sealed segment that holds it; one whose segment is not sealed and verified
 * yet keeps the window unclassified.
 */

import type { DispatchFrontier, WalIndex } from "./wal-index.js";
import { dispatchRequirements, locateSourceEvent, meetsRequirement } from "./wal-index.js";
import type { MarketWindow } from "./windows.js";

export type { DispatchFrontier } from "./wal-index.js";

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
   * Each listed instance's durable dispatch-order frontier. An instance none
   * of whose durable decisions carries a dispatch position is ABSENT from the
   * map: its processing cannot be established, so its windows stay
   * unclassified.
   */
  dispatchFrontiers(instanceIds: readonly string[]): Promise<ReadonlyMap<string, DispatchFrontier>>;
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
  /**
   * How long after its end a window's market can still produce evidence: the
   * trader must have processed every frame stamped up to the end plus this.
   */
  readonly durabilityGraceMs: number;
  readonly evidence: TraderEvidenceSource;
  /** The sealed WAL in dispatch order (`wal-index.ts`). */
  readonly wal: WalIndex;
};

/** Classify one window. */
export async function classifyWindow(window: MarketWindow, options: ClassifyOptions): Promise<WindowClassification> {
  const unclassified = (reason: string): WindowClassification => ({ windowId: window.windowId, state: "unclassified", reason });
  if (options.nowMs < window.windowEndMs) return unclassified("the window has not closed");
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
  const range = potentialRange(window, options.leadInMs, options.durabilityGraceMs);
  if (options.nowMs < range.toMs) return unclassified("the durability grace after the window's end has not passed");

  // -- The trader's rows are durable: established in dispatch order. --------
  const required = dispatchRequirements(options.wal, range);
  if (!required.ok) return unclassified(required.reason);
  const instanceIds = window.responsibility.instanceIds;
  const frontiers = await options.evidence.dispatchFrontiers(instanceIds);
  for (const instanceId of instanceIds) {
    const frontier = frontiers.get(instanceId);
    if (frontier === undefined) {
      return unclassified(
        `instance ${instanceId} has no durable decision carrying a dispatch position (gatewayEpoch, ingestSeq): its processing of the window cannot be established`,
      );
    }
    for (const requirement of required.requirements) {
      if (!meetsRequirement(frontier, requirement)) {
        return unclassified(
          `instance ${instanceId} has not durably processed epoch ${requirement.gatewayEpoch} past ingestSeq ${requirement.ingestSeq}`,
        );
      }
    }
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
  // with intents, whose source event could be in a fill's chain — and the
  // whole span of every segment that holds a source event named by its
  // dispatch identity; then preceded by the lead-in (Decision 3.2, 3.4).
  let fromMs = window.windowStartMs;
  let toMs = window.windowEndMs;
  const widen = (atMs: number): void => {
    if (atMs < fromMs) fromMs = atMs;
    if (atMs > toMs) toMs = atMs;
  };
  for (const atMs of evidence.fillsAtMs) widen(atMs);
  for (const atMs of evidence.refusalsAtMs) widen(atMs);
  for (const atMs of evidence.haltsAtMs) widen(atMs);
  for (const intent of evidence.intents) {
    widen(intent.evaluatedAtMs);
    if (intent.gatewayEpoch === null || intent.ingestSeq === null) continue;
    const location = locateSourceEvent(options.wal, intent.gatewayEpoch, intent.ingestSeq);
    if (location.status === "pending") {
      return unclassified(
        `the source event (${intent.gatewayEpoch}, ${intent.ingestSeq}) of a decision in its chain is not sealed and verified yet: ${location.reason}`,
      );
    }
    if (location.status === "located") {
      widen(location.span.fromMs);
      widen(location.span.toMs);
    }
    // "lost": the pin records it as outside, and the planner keeps every
    // segment the pin overlaps (`pin-trace-incomplete`).
  }
  const retention = pinRetentionMs(pinClass);
  return {
    windowId: window.windowId,
    state: "classified",
    pinClass,
    pinFromMs: fromMs - options.leadInMs,
    pinToMs: toMs,
    keepUntilMs: retention === null ? null : window.windowEndMs + retention,
    sourceEvents: evidence.intents,
    evidenceCounts,
  };
}

/**
 * The range an UNCLASSIFIED window could still pin, and the range a trader
 * must have processed before it is classified: from the lead-in before the
 * earliest instant a responsible trader could have acted, to the window's end
 * plus the durability grace. Every segment overlapping it is held.
 */
export function potentialRange(
  window: MarketWindow,
  leadInMs: number,
  durabilityGraceMs: number,
): { fromMs: number; toMs: number } {
  return { fromMs: window.responsibleFromMs - leadInMs, toMs: window.windowEndMs + durabilityGraceMs };
}

/** An in-memory evidence source, for tests and for a deployment with no trader. */
export function staticEvidenceSource(input: {
  /** Each instance's dispatch frontier; an absent instance has none. */
  readonly frontiers: ReadonlyMap<string, DispatchFrontier>;
  readonly evidence: ReadonlyMap<string, MarketEvidence>;
}): TraderEvidenceSource {
  return {
    async dispatchFrontiers(instanceIds: readonly string[]): Promise<ReadonlyMap<string, DispatchFrontier>> {
      const out = new Map<string, DispatchFrontier>();
      for (const id of instanceIds) {
        const frontier = input.frontiers.get(id);
        if (frontier !== undefined) out.set(id, frontier);
      }
      return out;
    },
    async marketEvidence(window: MarketWindow): Promise<MarketEvidence> {
      return input.evidence.get(window.marketId) ?? { fillsAtMs: [], intents: [], refusalsAtMs: [], haltsAtMs: [] };
    },
  };
}

/** A frontier from `{ epoch: ingestSeq }`, with the epochs completed within a run. */
export function dispatchFrontier(byEpoch: Readonly<Record<string, string>>, completedEpochs: readonly string[] = []): DispatchFrontier {
  return { byEpoch: new Map(Object.entries(byEpoch)), completedEpochs: new Set(completedEpochs) };
}
