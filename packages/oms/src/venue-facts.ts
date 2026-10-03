/**
 * Every venue fact the OMS acts on, with its citation (handoff §1.2: venue
 * facts are volatile; ADR-007's "Retry the same signed order only when safe
 * and supported" is answered from these and nothing else).
 *
 * Each `quote` appears verbatim (whitespace-normalized) in the cited dated
 * report; `test/unit/oms/venue-facts.test.ts` checks every one. A behaviour
 * that no row supports is refused, never assumed.
 */

export interface VenueFact {
  readonly id: string;
  /** What the OMS does because of it. */
  readonly consequence: string;
  /** The dated report, relative to the repository root. */
  readonly source: string;
  readonly section: string;
  /** Verbatim from `source` (whitespace-normalized). */
  readonly quote: string;
}

const REPORT_0930 = "docs/venue/verified-2026-09-30.md";
const REPORT_0916 = "docs/venue/verified-2026-09-16.md";

export const VENUE_FACTS = Object.freeze({
  BATCH_LIMIT: {
    id: "BATCH_LIMIT",
    consequence: "A batch placement carries 1 to 15 signed orders; a larger batch is refused before signing.",
    source: REPORT_0930,
    section: "§W.3",
    quote: "batch 1–15 orders",
  },
  RESTART_RESUBMIT: {
    id: "RESTART_RESUBMIT",
    consequence:
      "The only documented resubmission of a signed request is after an HTTP 425 restart. The OMS allows the same signed order (same salt) to be retransmitted only on that path, and only after an authoritative read finds it absent.",
    source: REPORT_0930,
    section: "§9, E-06",
    quote: "otherwise, apply bounded exponential backoff before resubmitting the signed request.",
  },
  RETRY_ONLY_RESTART: {
    id: "RETRY_ONLY_RESTART",
    consequence: "No other failure kind is retried with the same signed order.",
    source: REPORT_0930,
    section: "§9, E-07",
    quote: "Retry only restart rejections",
  },
  POST_ONLY_NO_UNCHANGED_RETRY: {
    id: "POST_ONLY_NO_UNCHANGED_RETRY",
    consequence:
      "After a post-only-mode refusal of a non-post-only order, neither that signed order nor a re-signed copy is sent again; changing it to post-only is a new plan (ADR-007 §7).",
    source: REPORT_0930,
    section: "§9",
    quote: "Do not retry the same non-post-only order unchanged.",
  },
  POST_ONLY_AFTER_RESTART: {
    id: "POST_ONLY_AFTER_RESTART",
    consequence: "In a POST_ONLY venue mode only post-only orders are placed; cancels stay available.",
    source: REPORT_0930,
    section: "§9",
    quote: "enters post-only mode for two minutes: cancels remain available, but new orders must be eligible maker orders submitted as post-only",
  },
  TRADING_UNAVAILABLE_CANCELS_UNKNOWN: {
    id: "TRADING_UNAVAILABLE_CANCELS_UNKNOWN",
    consequence:
      "In a TRADING_UNAVAILABLE venue mode no placement is made; a cancel is still attempted, because a cancel attempt is the only evidence of whether cancels work.",
    source: REPORT_0930,
    section: "§9, E-05",
    quote: "this response does not establish whether cancels are available",
  },
  CANCELS_IN_CANCEL_ONLY: {
    id: "CANCELS_IN_CANCEL_ONLY",
    consequence: "Cancels are never gated by the venue mode.",
    source: REPORT_0930,
    section: "§2.5",
    quote: "Works even in cancel-only mode",
  },
  READ_BY_ID_ANY_STATUS: {
    id: "READ_BY_ID_ANY_STATUS",
    consequence:
      "An order known by its venue id is read by id; an authoritative 'absent' for a known venue id contradicts the documented read and is an evidence conflict.",
    source: REPORT_0930,
    section: "§W.9, E-14",
    quote: "Filtering by id returns that order regardless of status, including canceled or fully matched orders.",
  },
  ABSENT_FROM_OPEN_LIST: {
    id: "ABSENT_FROM_OPEN_LIST",
    consequence: "The OMS never infers cancellation or absence from a list; only a reconciliation verdict does.",
    source: REPORT_0930,
    section: "§W.9, E-14",
    quote: "an order absent from the open-orders list is not proof of cancellation",
  },
  DELAYED_IS_NOT_A_FILL: {
    id: "DELAYED_IS_NOT_A_FILL",
    consequence: "An accepted `delayed` placement is DELAYED, never a fill.",
    source: REPORT_0916,
    section: "§2.2",
    quote: "Treat it as a pending order rather than a fill.",
  },
  UNMATCHED_ACCEPTED_NOT_FILLED: {
    id: "UNMATCHED_ACCEPTED_NOT_FILLED",
    consequence:
      "An `unmatched` observation is an accepted, unfilled order (LIVE); it never derives a cancel or a rejection. The pinned SDK reports an `unmatched` placement as UNKNOWN, which the OMS reconciles.",
    source: REPORT_0916,
    section: "§11, C-6",
    quote: 'must treat `unmatched` as "accepted, resting or pending, not filled" under either reading, and must not derive a cancel/reject from it.',
  },
  DELAY_CANNOT_CANCEL: {
    id: "DELAY_CANNOT_CANCEL",
    consequence: "A cancel of a DELAYED order is still sent; a not-canceled answer leads to reconciliation, never to an assumed state.",
    source: REPORT_0916,
    section: "§7, D-18",
    quote: "During either delay, the order is pending and cannot be canceled.",
  },
  BATCH_STATUS_ON_FAILURE: {
    id: "BATCH_STATUS_ON_FAILURE",
    consequence: "A failed batch entry's status is never read as a placement status.",
    source: REPORT_0930,
    section: "§2.2",
    quote: "a batch entry's `status` is not meaningful when `success` is false or `errorMsg` is non-empty",
  },
  NO_CLIENT_ORDER_ID: {
    id: "NO_CLIENT_ORDER_ID",
    consequence: "Idempotency is keyed on the persisted signed order (salt and signed fields), never on an invented client order id (handoff §9.11).",
    source: REPORT_0916,
    section: "§12",
    quote: "**Still none documented for the CLOB**",
  },
} satisfies Readonly<Record<string, VenueFact>>);

/** The venue's batch placement limit (VENUE_FACTS.BATCH_LIMIT). */
export const MAX_ORDERS_PER_BATCH = 15;
