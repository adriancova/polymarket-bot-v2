/**
 * Book reconstruction checked against recorded authoritative snapshots
 * (`WP-140`'s "snapshot comparison job"; Wave 1 closeout item "Book
 * reconstruction is checked against snapshots"; Phase-1 operational gate
 * "Book reconstruction agrees with independent snapshots").
 *
 * ## What it does
 *
 * The recorder's WAL holds every raw Polymarket market frame. The venue's
 * market channel interleaves full `book` snapshots ("Full orderbook snapshot
 * sent on subscribe or after a trade") with `price_change` deltas ("New
 * aggregate size (0 means level removed)") — see
 * `packages/polymarket-public/src/venue/market-events.ts` for the verified
 * schemas. That interleaving is itself the independent check: starting from
 * one snapshot and applying every delta must land exactly on the NEXT
 * snapshot. This module performs that comparison, per outcome token
 * (`asset_id`), over frames supplied **in recorded ingest order**.
 *
 * ## What it is not
 *
 * It is NOT the `WP-150` order book (`packages/order-book`, Wave 2): no
 * queries, no staleness, no tick-size logic. It reconstructs level maps by
 * the venue's own published delta semantics and reports agreement — a
 * validation job in the exact shape of the WP-130 validator: findings are
 * RETURNED, never raised, each with a `check` class
 * (`validation-findings.ts` lists them).
 *
 * ## Purity
 *
 * Pure: frames in, report out. The I/O driver that reads WAL segments and
 * feeds this function lives in the soak harness (`test/soak/recorder/`),
 * which is where filesystem access belongs. Prices and sizes are compared as
 * **canonical decimal strings** — no float ever touches an economic value.
 */

export interface RecordedFrameInput {
  /** The WAL `ingestSeq`, carried into findings for traceability. */
  readonly ingestSeq: string;
  /** The exact recorded frame payload (WAL `payloadUtf8`). */
  readonly payloadUtf8: string;
}

export interface BookComparisonFinding {
  readonly check:
    | "book-divergence"
    | "book-frame-unparseable"
    | "book-level-grammar"
    | "book-delta-before-snapshot"
    | "book-crossed-reconstruction";
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly details: Readonly<Record<string, string | number>>;
}

export interface BookComparisonReport {
  /** True when no error-severity finding was produced. */
  readonly ok: boolean;
  readonly framesSeen: number;
  /** Frames carrying at least one `book`/`price_change` event. */
  readonly framesUsed: number;
  /** Events of other types (trades, tick-size, lifecycle) — not an error. */
  readonly eventsSkipped: number;
  readonly assetsSeen: number;
  /** Snapshot arrivals verified against a reconstruction. */
  readonly snapshotsVerified: number;
  readonly snapshotsDiverged: number;
  /** Snapshot arrivals that only (re)established a baseline. */
  readonly baselinesEstablished: number;
  readonly deltasApplied: number;
  readonly findings: readonly BookComparisonFinding[];
}

const DECIMAL_GRAMMAR = /^\d+(?:\.\d+)?$/u;

/**
 * Canonicalize a non-negative decimal string without leaving string space:
 * strip leading integer zeros and trailing fractional zeros. Returns `null`
 * when the value does not match the venue's decimal grammar.
 */
export function canonicalDecimal(value: string): string | null {
  if (!DECIMAL_GRAMMAR.test(value)) {
    return null;
  }
  const dot = value.indexOf(".");
  let integer = dot === -1 ? value : value.slice(0, dot);
  let fraction = dot === -1 ? "" : value.slice(dot + 1);
  integer = integer.replace(/^0+(?=\d)/u, "");
  fraction = fraction.replace(/0+$/u, "");
  return fraction === "" ? integer : `${integer}.${fraction}`;
}

const isZero = (canonical: string): boolean => canonical === "0";

interface SideState {
  /** canonical price -> canonical size (never zero). */
  readonly levels: Map<string, string>;
}

interface AssetState {
  readonly bids: SideState;
  readonly asks: SideState;
  /** ingestSeq of the frame that established the current baseline. */
  baselineIngestSeq: string;
  deltasSinceBaseline: number;
}

interface VenueLevel {
  readonly price?: unknown;
  readonly size?: unknown;
}

function levelsToMap(
  levels: readonly VenueLevel[],
  context: { readonly ingestSeq: string; readonly assetId: string; readonly side: string },
  findings: BookComparisonFinding[],
): Map<string, string> | null {
  const map = new Map<string, string>();
  for (const level of levels) {
    if (typeof level.price !== "string" || typeof level.size !== "string") {
      findings.push({
        check: "book-level-grammar",
        severity: "error",
        message: "book level price/size is not a string",
        details: { ingestSeq: context.ingestSeq, assetId: context.assetId, side: context.side },
      });
      return null;
    }
    const price = canonicalDecimal(level.price);
    const size = canonicalDecimal(level.size);
    if (price === null || size === null) {
      findings.push({
        check: "book-level-grammar",
        severity: "error",
        message: "book level price/size does not match the venue decimal grammar",
        details: {
          ingestSeq: context.ingestSeq,
          assetId: context.assetId,
          side: context.side,
          price: level.price,
          size: level.size,
        },
      });
      return null;
    }
    if (isZero(size)) {
      // A zero-size level in a snapshot is an empty level; normalize it away
      // so set-comparison against a reconstruction (where zero deletes) holds.
      continue;
    }
    map.set(price, size);
  }
  return map;
}

function compareSides(
  reconstructed: Map<string, string>,
  snapshot: Map<string, string>,
): { readonly missing: number; readonly extra: number; readonly sizeMismatches: number } {
  let missing = 0;
  let extra = 0;
  let sizeMismatches = 0;
  for (const [price, size] of snapshot) {
    const held = reconstructed.get(price);
    if (held === undefined) {
      missing += 1;
    } else if (held !== size) {
      sizeMismatches += 1;
    }
  }
  for (const price of reconstructed.keys()) {
    if (!snapshot.has(price)) {
      extra += 1;
    }
  }
  return { missing, extra, sizeMismatches };
}

/** Numeric comparison of canonical decimal strings without float conversion. */
function compareCanonical(a: string, b: string): number {
  const [aInt = "0", aFrac = ""] = a.split(".");
  const [bInt = "0", bFrac = ""] = b.split(".");
  if (aInt.length !== bInt.length) {
    return aInt.length < bInt.length ? -1 : 1;
  }
  if (aInt !== bInt) {
    return aInt < bInt ? -1 : 1;
  }
  const width = Math.max(aFrac.length, bFrac.length);
  const aPadded = aFrac.padEnd(width, "0");
  const bPadded = bFrac.padEnd(width, "0");
  if (aPadded === bPadded) {
    return 0;
  }
  return aPadded < bPadded ? -1 : 1;
}

function bestPrice(side: Map<string, string>, want: "max" | "min"): string | null {
  let best: string | null = null;
  for (const price of side.keys()) {
    if (best === null) {
      best = price;
      continue;
    }
    const order = compareCanonical(price, best);
    if ((want === "max" && order > 0) || (want === "min" && order < 0)) {
      best = price;
    }
  }
  return best;
}

interface ParsedEventLike {
  readonly event_type?: unknown;
  readonly asset_id?: unknown;
  readonly bids?: unknown;
  readonly asks?: unknown;
  readonly price_changes?: unknown;
}

/**
 * Compare reconstructed book state against every recorded authoritative
 * snapshot in `frames` (which must be in recorded ingest order). Pure; see
 * the module header.
 */
export function compareRecordedBooks(
  frames: Iterable<RecordedFrameInput>,
): BookComparisonReport {
  const findings: BookComparisonFinding[] = [];
  const assets = new Map<string, AssetState>();
  let framesSeen = 0;
  let framesUsed = 0;
  let eventsSkipped = 0;
  let snapshotsVerified = 0;
  let snapshotsDiverged = 0;
  let baselinesEstablished = 0;
  let deltasApplied = 0;

  const checkCrossed = (assetId: string, state: AssetState, ingestSeq: string): void => {
    const bestBid = bestPrice(state.bids.levels, "max");
    const bestAsk = bestPrice(state.asks.levels, "min");
    if (bestBid !== null && bestAsk !== null && compareCanonical(bestBid, bestAsk) >= 0) {
      findings.push({
        check: "book-crossed-reconstruction",
        severity: "warning",
        message: "reconstructed book is crossed at comparison time",
        details: { ingestSeq, assetId, bestBid, bestAsk },
      });
    }
  };

  for (const frame of frames) {
    framesSeen += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.payloadUtf8);
    } catch {
      findings.push({
        check: "book-frame-unparseable",
        severity: "error",
        message: "recorded frame payload is not JSON",
        details: { ingestSeq: frame.ingestSeq },
      });
      continue;
    }
    // The venue multiplexes: a frame is one event object or an array of them
    // (the official SDK branches on Array.isArray; see
    // packages/polymarket-public/src/venue/frames.ts).
    const events: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    let used = false;
    for (const rawEvent of events) {
      if (typeof rawEvent !== "object" || rawEvent === null) {
        eventsSkipped += 1;
        continue;
      }
      const event = rawEvent as ParsedEventLike;
      if (event.event_type === "book") {
        used = true;
        const assetId = typeof event.asset_id === "string" ? event.asset_id : null;
        if (assetId === null || !Array.isArray(event.bids) || !Array.isArray(event.asks)) {
          findings.push({
            check: "book-frame-unparseable",
            severity: "error",
            message: "book event lacks asset_id/bids/asks",
            details: { ingestSeq: frame.ingestSeq },
          });
          continue;
        }
        const bids = levelsToMap(
          event.bids as readonly VenueLevel[],
          { ingestSeq: frame.ingestSeq, assetId, side: "bids" },
          findings,
        );
        const asks = levelsToMap(
          event.asks as readonly VenueLevel[],
          { ingestSeq: frame.ingestSeq, assetId, side: "asks" },
          findings,
        );
        if (bids === null || asks === null) {
          continue;
        }
        const state = assets.get(assetId);
        if (state === undefined) {
          assets.set(assetId, {
            bids: { levels: bids },
            asks: { levels: asks },
            baselineIngestSeq: frame.ingestSeq,
            deltasSinceBaseline: 0,
          });
          baselinesEstablished += 1;
          continue;
        }
        // The comparison: the reconstruction (baseline + deltas) against this
        // authoritative snapshot.
        checkCrossed(assetId, state, frame.ingestSeq);
        const bidDiff = compareSides(state.bids.levels, bids);
        const askDiff = compareSides(state.asks.levels, asks);
        const divergences =
          bidDiff.missing +
          bidDiff.extra +
          bidDiff.sizeMismatches +
          askDiff.missing +
          askDiff.extra +
          askDiff.sizeMismatches;
        if (divergences === 0) {
          snapshotsVerified += 1;
        } else {
          snapshotsDiverged += 1;
          findings.push({
            check: "book-divergence",
            severity: "error",
            message: "reconstructed book disagrees with the recorded authoritative snapshot",
            details: {
              ingestSeq: frame.ingestSeq,
              assetId,
              baselineIngestSeq: state.baselineIngestSeq,
              deltasSinceBaseline: state.deltasSinceBaseline,
              bidsMissing: bidDiff.missing,
              bidsExtra: bidDiff.extra,
              bidSizeMismatches: bidDiff.sizeMismatches,
              asksMissing: askDiff.missing,
              asksExtra: askDiff.extra,
              askSizeMismatches: askDiff.sizeMismatches,
            },
          });
        }
        // Either way the snapshot is authoritative from here (§7.1: a
        // snapshot resets state; a divergence is reported, not carried).
        assets.set(assetId, {
          bids: { levels: bids },
          asks: { levels: asks },
          baselineIngestSeq: frame.ingestSeq,
          deltasSinceBaseline: 0,
        });
        continue;
      }
      if (event.event_type === "price_change") {
        used = true;
        if (!Array.isArray(event.price_changes)) {
          findings.push({
            check: "book-frame-unparseable",
            severity: "error",
            message: "price_change event lacks price_changes",
            details: { ingestSeq: frame.ingestSeq },
          });
          continue;
        }
        for (const rawChange of event.price_changes as readonly unknown[]) {
          if (typeof rawChange !== "object" || rawChange === null) {
            findings.push({
              check: "book-frame-unparseable",
              severity: "error",
              message: "price_change entry is not an object",
              details: { ingestSeq: frame.ingestSeq },
            });
            continue;
          }
          const change = rawChange as {
            readonly asset_id?: unknown;
            readonly price?: unknown;
            readonly size?: unknown;
            readonly side?: unknown;
          };
          if (
            typeof change.asset_id !== "string" ||
            typeof change.price !== "string" ||
            typeof change.size !== "string" ||
            typeof change.side !== "string"
          ) {
            findings.push({
              check: "book-frame-unparseable",
              severity: "error",
              message: "price_change entry lacks asset_id/price/size/side",
              details: { ingestSeq: frame.ingestSeq },
            });
            continue;
          }
          const state = assets.get(change.asset_id);
          if (state === undefined) {
            // Recording started mid-stream for this asset: deltas cannot be
            // applied without a baseline. Informational — the venue sends a
            // snapshot on subscribe, so this indicates a truncated capture,
            // not a recorder defect.
            findings.push({
              check: "book-delta-before-snapshot",
              severity: "info",
              message: "price_change before any book snapshot for this asset; skipped",
              details: { ingestSeq: frame.ingestSeq, assetId: change.asset_id },
            });
            continue;
          }
          const price = canonicalDecimal(change.price);
          const size = canonicalDecimal(change.size);
          if (price === null || size === null) {
            findings.push({
              check: "book-level-grammar",
              severity: "error",
              message: "price_change price/size does not match the venue decimal grammar",
              details: {
                ingestSeq: frame.ingestSeq,
                assetId: change.asset_id,
                price: change.price,
                size: change.size,
              },
            });
            continue;
          }
          const sideKey = change.side.toUpperCase();
          const side =
            sideKey === "BUY"
              ? state.bids.levels
              : sideKey === "SELL"
                ? state.asks.levels
                : null;
          if (side === null) {
            findings.push({
              check: "book-frame-unparseable",
              severity: "error",
              message: `price_change side is neither BUY nor SELL: ${change.side}`,
              details: { ingestSeq: frame.ingestSeq, assetId: change.asset_id },
            });
            continue;
          }
          if (isZero(size)) {
            side.delete(price);
          } else {
            side.set(price, size);
          }
          state.deltasSinceBaseline += 1;
          deltasApplied += 1;
        }
        continue;
      }
      eventsSkipped += 1;
    }
    if (used) {
      framesUsed += 1;
    }
  }

  return {
    ok: !findings.some((finding) => finding.severity === "error"),
    framesSeen,
    framesUsed,
    eventsSkipped,
    assetsSeen: assets.size,
    snapshotsVerified,
    snapshotsDiverged,
    baselinesEstablished,
    deltasApplied,
    findings,
  };
}
