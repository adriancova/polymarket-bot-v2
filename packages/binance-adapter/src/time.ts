/**
 * Time at the venue edge: receipt stamping, and venue-epoch conversion.
 *
 * TWO CLOCKS, KEPT APART. The §7.1 envelope carries both a wall-clock instant
 * (`receivedAt`) and a monotonic reading (`receivedMonotonicNs`) because they
 * answer different questions: an instant is comparable with a venue timestamp
 * and with a human's log, while only a monotonic reading gives a trustworthy
 * *elapsed* time when the wall clock is stepped by NTP. This package therefore
 * measures staleness from the monotonic reading and reports instants from the
 * wall clock, and never mixes them.
 *
 * VENUE TIME AND RECEIPT TIME ARE DISTINCT AND BOTH ARE PRESERVED (`WP-080`
 * acceptance: "Venue and receipt timestamps are preserved"). A venue timestamp
 * is the venue's statement about when something happened; a receipt stamp is
 * this process's statement about when it learned. They are never reconciled,
 * averaged, or substituted for one another — the difference between them is
 * itself a reported metric (`venueToReceiptLagMs`), and a negative difference is
 * clock skew, not an error to hide.
 *
 * ONE WALL-CLOCK READ, AT THE DOCUMENTED BOUNDARY. Everything in this package
 * takes the stamp as an argument. The only component that reads a clock is
 * {@link systemClock}, and a caller that wants determinism (replay, tests)
 * supplies its own {@link Clock}. That is what makes the adapter replayable:
 * handoff §6 invariant 15 and §12.4 require the recorded arrival order to be
 * reproducible, which is impossible if a normalizer reads `Date.now()` in the
 * middle of a decode.
 */

import { BinanceTimestampError } from "./errors.js";
import type { BinanceTimeUnit } from "./venue.js";

/**
 * A receipt observation: when this process saw a frame.
 *
 * The field names are the §7.1 envelope's own, so the gateway (`WP-120`) copies
 * them across without a mapping table. This package assigns NOTHING else on the
 * envelope: `gatewayEpoch` and `ingestSeq` are gateway-assigned (ADR-002 §1,
 * §2.1) and no adapter may invent a position in the total order.
 */
export type ReceiptStamp = {
  /** Wall-clock instant, ISO-8601 with an explicit UTC designator or offset. */
  readonly receivedAt: string;
  /** Monotonic nanoseconds as a canonical unsigned integer string (§7.1). */
  readonly receivedMonotonicNs: string;
};

/**
 * The one place a wall clock may be read.
 *
 * Injected everywhere so the adapter itself stays a pure function of (frames,
 * stamps). `systemClock` is the production implementation; the test helper in
 * `./testing/` is a deterministic one.
 */
export type Clock = {
  stamp(): ReceiptStamp;
};

/** Largest millisecond offset an ECMAScript time value can represent. */
const MAX_TIME_VALUE_MS = 8.64e15;

const NS_PER_MS = 1_000_000n;

/**
 * Reads the process wall clock and monotonic clock once, together.
 *
 * `process.hrtime.bigint()` is "the current high-resolution real time in
 * nanoseconds" from an arbitrary past origin; only differences are meaningful,
 * which is exactly what §8.3-style staleness needs. It is unsigned by
 * construction, which is what `UnsignedBigIntStringSchema` requires.
 */
export const systemClock: Clock = {
  stamp(): ReceiptStamp {
    return {
      receivedAt: new Date(Date.now()).toISOString(),
      receivedMonotonicNs: process.hrtime.bigint().toString(),
    };
  },
};

/**
 * Elapsed milliseconds between two receipt stamps, from the monotonic readings.
 *
 * Clamped at zero: two stamps taken from the same monotonic clock cannot go
 * backwards, so a negative result means the caller mixed stamps from different
 * processes, and reporting a negative staleness would be worse than reporting
 * none. The division truncates, which is correct for an age.
 */
export function elapsedMsBetween(earlier: ReceiptStamp, later: ReceiptStamp): number {
  const from = parseMonotonicNs(earlier.receivedMonotonicNs, "earlier.receivedMonotonicNs");
  const to = parseMonotonicNs(later.receivedMonotonicNs, "later.receivedMonotonicNs");
  if (to <= from) {
    return 0;
  }
  return Number((to - from) / NS_PER_MS);
}

function parseMonotonicNs(value: string, label: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new BinanceTimestampError(
      `${label} must be a canonical unsigned integer string, received ${JSON.stringify(value)}`,
      { field: label, value },
    );
  }
  return BigInt(value);
}

/**
 * Converts a Binance epoch field to an ISO-8601 instant.
 *
 * The unit comes from the CONNECTION, not from the frame: "All time and
 * timestamp related fields are **milliseconds by default**. To receive the
 * information in microseconds, please add the parameter `timeUnit=MICROSECOND …`
 * in the URL" (`web-socket-streams.md`, "General WSS information", accessed
 * 2026-08-27). Nothing in a frame identifies its unit, so the caller must state
 * it and this function must be told; defaulting silently would make a
 * microsecond feed read as instants in the year 1970.
 *
 * A microsecond value keeps all six fractional digits. `Date#toISOString`
 * renders three, so the remaining three are appended — truncating them would
 * discard venue precision the caller deliberately asked for.
 *
 * Failure is a typed throw rather than a fallback instant: a fabricated
 * `venueTimestamp` on a recorded event is unrecoverable later.
 */
export function venueEpochToIso(value: number, unit: BinanceTimeUnit): string {
  if (!Number.isSafeInteger(value)) {
    throw new BinanceTimestampError(
      `venue timestamp must be a safe integer (see BNC-U6), received ${String(value)}`,
      { value, unit },
    );
  }
  if (value < 0) {
    throw new BinanceTimestampError(
      `venue timestamp must not be negative, received ${String(value)}`,
      { value, unit },
    );
  }

  if (unit === "MILLISECOND") {
    return isoFromMilliseconds(value, value, unit);
  }

  const milliseconds = Math.floor(value / 1000);
  const microsecondRemainder = value - milliseconds * 1000;
  const base = isoFromMilliseconds(milliseconds, value, unit);
  // "…THH:MM:SS.mmmZ" → "…THH:MM:SS.mmmuuuZ"
  const withoutZ = base.slice(0, -1);
  return `${withoutZ}${String(microsecondRemainder).padStart(3, "0")}Z`;
}

function isoFromMilliseconds(milliseconds: number, original: number, unit: BinanceTimeUnit): string {
  if (Math.abs(milliseconds) > MAX_TIME_VALUE_MS) {
    throw new BinanceTimestampError(
      `venue timestamp ${String(original)} (${unit}) is outside the representable instant range`,
      { value: original, unit },
    );
  }
  return new Date(milliseconds).toISOString();
}

/**
 * Signed milliseconds between a venue instant and the receipt instant.
 *
 * Positive means the frame arrived after the venue stamped it, which is the
 * normal case. The sign is preserved: a negative value is real evidence of clock
 * skew between this host and the venue, and silently clamping it would erase the
 * only signal an operator has for it. Both arguments are ISO instants, so this
 * compares two *wall clocks* and is explicitly not the staleness measure —
 * {@link elapsedMsBetween} is.
 */
export function venueToReceiptLagMs(venueIso: string, receiptIso: string): number {
  const venue = Date.parse(venueIso);
  const receipt = Date.parse(receiptIso);
  if (Number.isNaN(venue) || Number.isNaN(receipt)) {
    throw new BinanceTimestampError("both instants must be parseable ISO-8601 timestamps", {
      venueIso,
      receiptIso,
    });
  }
  return receipt - venue;
}
