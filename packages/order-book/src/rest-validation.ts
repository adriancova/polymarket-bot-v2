/**
 * Validation of reconstructed state against a periodic REST snapshot (§9.4:
 * "Validate reconstructed state against periodic REST snapshots").
 *
 * This is a PURE comparison function: the snapshot is handed in, already
 * normalized by the adapter that owns the wire format
 * (`packages/polymarket-public`'s REST book normalizer). No HTTP exists in
 * this package.
 *
 * ## Robust to the recorded GET /book ordering contradictions
 *
 * `docs/venue/verified-2026-09-02.md` §6 records that the venue's two
 * first-party sources state OPPOSITE orders for both book sides (OpenAPI:
 * bids descending / asks ascending; the prose page: bids ascending / asks
 * descending), as of 2026-09-02. The venue therefore promises no order this
 * function may assume. Both sides are CANONICALIZED into price-keyed sets
 * before comparison; array order never influences the verdict.
 *
 * ## Byte-exact on canonical forms
 *
 * Levels compare as canonical decimal strings — `===` on the canonical
 * spelling, never numeric tolerance. A snapshot level that is not canonical
 * is itself a named finding (the adapter owns normalization, ADR-001 §3;
 * this function refuses to guess), and the comparison fails closed.
 *
 * ## Hashes are reported, never judged across surfaces
 *
 * The book's tracked hash comes from WebSocket book events; the snapshot's
 * comes from the REST surface. No current official source states the two are
 * computed by one algorithm over one serialization (the venue documents the
 * REST hash for comparison BETWEEN successive REST reads, and its published
 * hash lengths are self-contradictory — `WP-070` `known_risks` 3). Both
 * values are carried in the report; equality across surfaces is NOT asserted
 * either way. Divergence verdicts rest on levels alone.
 */

import { compareDecimal, isCanonicalDecimalString } from "@polymarket-bot/decimal";
import type { DecimalString } from "@polymarket-bot/domain";

import type { OutcomeTokenBook } from "./book.js";

/** One level as handed in from the normalized REST snapshot. */
export interface RestSnapshotLevel {
  readonly price: string;
  readonly size: string;
}

/** The normalized REST snapshot input. Identity fields are optional; when
 * present they are checked against the book's. */
export interface RestSnapshotInput {
  readonly internalMarketId?: string;
  readonly tokenId?: string;
  readonly bids: readonly RestSnapshotLevel[];
  readonly asks: readonly RestSnapshotLevel[];
  readonly venueBookHash?: string;
}

export type SnapshotDivergenceKind =
  /** The snapshot names a different market/token than the book. */
  | "SNAPSHOT_IDENTITY_MISMATCH"
  /** A snapshot price or size is not a canonical decimal string. */
  | "SNAPSHOT_LEVEL_NOT_CANONICAL"
  /** One snapshot side carries the same price twice. */
  | "SNAPSHOT_DUPLICATE_LEVEL"
  /** The snapshot holds a level the reconstruction lacks. */
  | "LEVEL_MISSING_FROM_BOOK"
  /** The reconstruction holds a level the snapshot lacks. */
  | "LEVEL_NOT_IN_SNAPSHOT"
  /** Both hold the level; the canonical sizes differ byte-for-byte. */
  | "LEVEL_SIZE_MISMATCH";

export interface SnapshotDivergence {
  readonly kind: SnapshotDivergenceKind;
  readonly side?: "BID" | "ASK";
  readonly price?: string;
  readonly bookSize?: string;
  readonly snapshotSize?: string;
  readonly detail: string;
}

export interface SnapshotComparisonReport {
  /** True when the comparison ran to completion and found no divergence. */
  readonly ok: boolean;
  readonly divergences: readonly SnapshotDivergence[];
  /** Levels present on both sides and byte-identical. */
  readonly levelsAgreed: number;
  /** The book's tracked venue hash (WS surface), reported, not judged. */
  readonly bookVenueBookHash?: string;
  /** The snapshot's venue hash (REST surface), reported, not judged. */
  readonly snapshotVenueBookHash?: string;
  /**
   * Always false: no official source states the WS and REST hashes share an
   * algorithm, so cross-surface equality is neither asserted nor denied.
   */
  readonly hashesComparableAcrossSurfaces: false;
}

interface CanonicalSide {
  readonly levels: Map<DecimalString, DecimalString>;
  readonly divergences: readonly SnapshotDivergence[];
}

function canonicalizeSide(
  side: "BID" | "ASK",
  levels: readonly RestSnapshotLevel[],
): CanonicalSide {
  const map = new Map<DecimalString, DecimalString>();
  const divergences: SnapshotDivergence[] = [];
  for (const level of levels) {
    if (!isCanonicalDecimalString(level.price) || !isCanonicalDecimalString(level.size)) {
      divergences.push({
        kind: "SNAPSHOT_LEVEL_NOT_CANONICAL",
        side,
        price: level.price,
        snapshotSize: level.size,
        detail:
          "snapshot level price/size is not canonical; normalization belongs to the adapter (ADR-001 §3) and this comparison does not guess",
      });
      continue;
    }
    if (compareDecimal(level.size, "0") === 0) {
      // An empty level asserts absence (ADR-013 zero-removal); it cannot
      // disagree with a reconstruction that stores no empty levels.
      continue;
    }
    if (map.has(level.price)) {
      divergences.push({
        kind: "SNAPSHOT_DUPLICATE_LEVEL",
        side,
        price: level.price,
        detail: "one snapshot side carries the same price twice; depth at that price is ambiguous",
      });
      continue;
    }
    map.set(level.price, level.size);
  }
  return { levels: map, divergences };
}

function compareSide(
  side: "BID" | "ASK",
  book: ReadonlyMap<DecimalString, DecimalString>,
  snapshot: ReadonlyMap<DecimalString, DecimalString>,
  divergences: SnapshotDivergence[],
): number {
  let agreed = 0;
  for (const [price, size] of snapshot) {
    const held = book.get(price);
    if (held === undefined) {
      divergences.push({
        kind: "LEVEL_MISSING_FROM_BOOK",
        side,
        price,
        snapshotSize: size,
        detail: "the snapshot holds a level the reconstruction lacks",
      });
    } else if (held !== size) {
      divergences.push({
        kind: "LEVEL_SIZE_MISMATCH",
        side,
        price,
        bookSize: held,
        snapshotSize: size,
        detail: "canonical sizes differ byte-for-byte at this price",
      });
    } else {
      agreed += 1;
    }
  }
  for (const [price, size] of book) {
    if (!snapshot.has(price)) {
      divergences.push({
        kind: "LEVEL_NOT_IN_SNAPSHOT",
        side,
        price,
        bookSize: size,
        detail: "the reconstruction holds a level the snapshot lacks",
      });
    }
  }
  return agreed;
}

/**
 * Compares the book's reconstructed levels against a normalized REST
 * snapshot. Pure; findings are returned, never raised.
 */
export function compareAgainstRestSnapshot(
  book: OutcomeTokenBook,
  snapshot: RestSnapshotInput,
): SnapshotComparisonReport {
  const divergences: SnapshotDivergence[] = [];
  const bookVenueBookHash = book.venueBookHash();
  const hashFields = {
    ...(bookVenueBookHash === undefined ? {} : { bookVenueBookHash }),
    ...(snapshot.venueBookHash === undefined
      ? {}
      : { snapshotVenueBookHash: snapshot.venueBookHash }),
  };

  if (
    (snapshot.internalMarketId !== undefined && snapshot.internalMarketId !== book.internalMarketId) ||
    (snapshot.tokenId !== undefined && snapshot.tokenId !== book.tokenId)
  ) {
    divergences.push({
      kind: "SNAPSHOT_IDENTITY_MISMATCH",
      detail: `snapshot names (${snapshot.internalMarketId ?? "?"}, ${snapshot.tokenId ?? "?"}) but the book is (${book.internalMarketId}, ${book.tokenId}); books are never mixed (§9.4)`,
    });
    return {
      ok: false,
      divergences,
      levelsAgreed: 0,
      ...hashFields,
      hashesComparableAcrossSurfaces: false,
    };
  }

  // Canonicalize both snapshot sides order-independently (module header:
  // the venue's two sources contradict each other on array order).
  const snapshotBids = canonicalizeSide("BID", snapshot.bids);
  const snapshotAsks = canonicalizeSide("ASK", snapshot.asks);
  divergences.push(...snapshotBids.divergences, ...snapshotAsks.divergences);

  const bookBids = new Map<DecimalString, DecimalString>(
    book.levels("BID").map((level) => [level.price, level.size]),
  );
  const bookAsks = new Map<DecimalString, DecimalString>(
    book.levels("ASK").map((level) => [level.price, level.size]),
  );

  let levelsAgreed = 0;
  levelsAgreed += compareSide("BID", bookBids, snapshotBids.levels, divergences);
  levelsAgreed += compareSide("ASK", bookAsks, snapshotAsks.levels, divergences);

  return {
    ok: divergences.length === 0,
    divergences,
    levelsAgreed,
    ...hashFields,
    hashesComparableAcrossSurfaces: false,
  };
}
