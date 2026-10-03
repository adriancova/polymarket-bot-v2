/**
 * Every venue fact the rate-limit budget acts on, with its citation ("cite
 * it or refuse"; handoff §1.2; the WP-270 `VENUE_FACTS` convention).
 *
 * Two kinds of source, in the precedence of handoff §1.1:
 *
 * - `REPORT`: a dated verification report under `docs/venue/`. The quote
 *   appears there verbatim (whitespace-normalized).
 * - `PINNED_SDK`: the type declarations of the pinned official SDK,
 *   `@polymarket/client@0.11.0` (the only version `packages/polymarket-secure`
 *   may install). Used ONLY where the reports name a header but do not state
 *   its unit or meaning (the reports quote the header names; the SDK
 *   documents `reset` and `remaining`). The quote appears verbatim in the
 *   installed package's `.d.ts` once its JSDoc `*` prefixes are removed.
 *
 * `venue-facts.test.ts` checks every quote against its source. Behaviour no
 * row supports is not implemented: an undocumented header is flagged and
 * never interpreted (`headers.ts`).
 */

export interface RateLimitVenueFact {
  readonly id: string;
  /** What the budget does because of it. */
  readonly consequence: string;
  readonly sourceKind: "REPORT" | "PINNED_SDK";
  /** A report path relative to the repository root, or the pinned SDK package. */
  readonly source: string;
  readonly section: string;
  /** Verbatim from `source` (whitespace-normalized; JSDoc prefixes removed for the SDK). */
  readonly quote: string;
}

const REPORT_0824 = "docs/venue/verified-2026-08-24.md";
const REPORT_0916 = "docs/venue/verified-2026-09-16.md";
const REPORT_0930 = "docs/venue/verified-2026-09-30.md";
/** The pinned SDK (`packages/polymarket-secure/package.json`). */
export const PINNED_SDK = "@polymarket/client@0.11.0";

export const RATE_LIMIT_VENUE_FACTS = Object.freeze({
  LIMITS_ARE_SNAPSHOTS: {
    id: "LIMITS_ARE_SNAPSHOTS",
    consequence: "Every limit, rate, burst and cost is read from a configuration snapshot with a source and an effective time; none is a constant.",
    sourceKind: "REPORT",
    source: REPORT_0916,
    section: "§8",
    quote: "they must be stored as configuration with source and effective time, never hardcoded.",
  },
  LIMITS_UNCHANGED_0930: {
    id: "LIMITS_UNCHANGED_0930",
    consequence: "The fixture snapshot is effective 2026-09-30 with the 2026-09-16 values; the negative cancel balance and all-or-nothing batch admission are modelled.",
    sourceKind: "REPORT",
    source: REPORT_0930,
    section: "§W.7",
    quote: "keep the negative cancel balance (D-21) and the all-or-nothing batch admission; limits stay configuration snapshots (unchanged values, effective 2026-09-30).",
  },
  ENFORCEMENT_ASSUMED: {
    id: "ENFORCEMENT_ASSUMED",
    consequence: "The per-signer limits are budgeted as if enforced (U-14): nothing is sent on the expectation of a warning instead of a 429.",
    sourceKind: "REPORT",
    source: REPORT_0930,
    section: "§8 (U-14)",
    quote: "Treat as enforced.",
  },
  IP_THROTTLED: {
    id: "IP_THROTTLED",
    consequence:
      "IP endpoint classes are budgeted locally as sliding windows: an excess request is queued by Cloudflare, not refused, so a lower class could otherwise delay a heartbeat or a safety cancel without any error to react to.",
    sourceKind: "REPORT",
    source: REPORT_0916,
    section: "§8",
    quote: "requests are throttled (delayed/queued) rather than immediately rejected",
  },
  SEPARATE_SIGNER_BUCKETS: {
    id: "SEPARATE_SIGNER_BUCKETS",
    consequence: "Each signer has an order bucket and a cancel bucket of its own; placements draw only on the first and cancels only on the second.",
    sourceKind: "REPORT",
    source: REPORT_0916,
    section: "§8",
    quote: "separate order and cancel buckets per signer address",
  },
  TOKEN_COSTS: {
    id: "TOKEN_COSTS",
    consequence: "An operation's token cost is `base + perEntry × entries`, plus `perCanceled` per canceled order debited after the answer; the numbers are snapshot data.",
    sourceKind: "REPORT",
    source: REPORT_0916,
    section: "§8",
    quote:
      'token costs `POST /order` 1, `POST /orders` "Number of orders in a non-empty batch", `DELETE /order` 1, `DELETE /orders` "Number of submitted order IDs", `DELETE /cancel-all` and `DELETE /cancel-market-orders` "1 plus the number of … orders canceled"',
  },
  BATCH_ALL_OR_NOTHING: {
    id: "BATCH_ALL_OR_NOTHING",
    consequence: "A request is granted only when every budget can pay its whole cost; a cost above a bucket's burst is refused (split the request).",
    sourceKind: "REPORT",
    source: REPORT_0916,
    section: "§8",
    quote: "a batch is admitted only when the bucket contains enough tokens for every entry. Otherwise, the entire request is rejected and no entries are processed.",
  },
  CANCEL_DEBIT_AND_DEBT: {
    id: "CANCEL_DEBIT_AND_DEBT",
    consequence:
      "cancel-all and cancel-market-orders take their base cost when granted and are debited per canceled order on completion; on a tier with a negative cancel balance the bucket may go into debt and later cancels wait; other tiers floor at zero.",
    sourceKind: "REPORT",
    source: REPORT_0916,
    section: "§8, D-21",
    quote:
      "Each request first consumes one cancel token. After the cancellation result is known, the bucket is debited one additional token for every order successfully canceled. For tiers that allow a negative cancel balance, this second debit can put the bucket into debt. Future cancel requests remain blocked until the bucket has enough tokens for the next request. Other tiers floor the post-cancel balance at zero regardless of debit size.",
  },
  NEGATIVE_BALANCE_TIERS: {
    id: "NEGATIVE_BALANCE_TIERS",
    consequence: "`negativeCancelBalance` is per tier in the snapshot.",
    sourceKind: "REPORT",
    source: REPORT_0916,
    section: "§8, D-21",
    quote: "`Yes` for Standard, Copper, Bronze, Silver, Gold; `No` for Platinum, Diamond, Elite",
  },
  DOCUMENTED_HEADERS: {
    id: "DOCUMENTED_HEADERS",
    consequence: "Exactly these five headers are read; every other header is flagged and never interpreted.",
    sourceKind: "REPORT",
    source: REPORT_0916,
    section: "§8",
    quote: "headers `Poly-RateLimit-Remaining`, `Poly-RateLimit-Reset`, `Poly-RateLimit-Tier`, `Retry-After` on 429, `Poly-RateLimit-Warning: true` in warning mode",
  },
  REMAINING_MAY_BE_NEGATIVE: {
    id: "REMAINING_MAY_BE_NEGATIVE",
    consequence: "`Poly-RateLimit-Remaining` is read as a signed integer and may put the local estimate into debt.",
    sourceKind: "REPORT",
    source: REPORT_0916,
    section: "§8, D-21",
    quote: "`Poly-RateLimit-Remaining` can be negative after `DELETE /cancel-all` or `DELETE /cancel-market-orders` for tiers that allow a negative cancel balance.",
  },
  REMAINING_MEANING: {
    id: "REMAINING_MEANING",
    consequence:
      "`Poly-RateLimit-Remaining` caps the local estimate of the applicable signer bucket; a zero alone lowers the estimate but imposes no wait.",
    sourceKind: "PINNED_SDK",
    source: PINNED_SDK,
    section: "RateLimitUpdate.remaining",
    quote:
      "Token balance remaining in the applicable rate-limit bucket after the request was accounted for. Can be negative for tiers that allow a negative cancellation balance. A value of `0` alone does not prove the bucket is exhausted because it can also be reported when no active limit applies; do not back off solely because this value is zero.",
  },
  RESET_MEANING: {
    id: "RESET_MEANING",
    consequence:
      "`Poly-RateLimit-Reset` is Unix seconds; it imposes a wait only while the bucket is in a wait period (a negative balance, or a 429 without `Retry-After`), capped by the snapshot's `maxHeaderWaitMs`.",
    sourceKind: "PINNED_SDK",
    source: PINNED_SDK,
    section: "RateLimitUpdate.reset",
    quote: "Unix timestamp, in seconds, when the current rate-limit wait period ends.",
  },
  WARNING_MEANING: {
    id: "WARNING_MEANING",
    consequence: "`Poly-RateLimit-Warning: true` means enforcement would have rejected the request: the bucket estimate drops to at most zero and the warning is counted.",
    sourceKind: "REPORT",
    source: REPORT_0824,
    section: "§8",
    quote: "`Poly-RateLimit-Warning: true` when a request would have failed once enforcement applies",
  },
  TIER_FROM_RESPONSES: {
    id: "TIER_FROM_RESPONSES",
    consequence: "A signer's tier is the one `Poly-RateLimit-Tier` names; until then (or for a name the snapshot lacks) the snapshot's assumed tier.",
    sourceKind: "REPORT",
    source: REPORT_0916,
    section: "§8, D-22",
    quote: "so `Poly-RateLimit-Tier` must be read from responses rather than assumed",
  },
  RETRY_AFTER_SECONDS: {
    id: "RETRY_AFTER_SECONDS",
    consequence: "A 429's `Retry-After` is a whole number of seconds; the charged bucket waits exactly that long.",
    sourceKind: "PINNED_SDK",
    source: PINNED_SDK,
    section: "RateLimitError.retryAfter",
    quote: "Server-requested delay in seconds before retrying, when the response provided one.",
  },
  RETRY_AFTER_ON_425: {
    id: "RETRY_AFTER_ON_425",
    consequence: "`Retry-After` is also read on a 425 (for the restricted-mode detector), never on an undocumented status.",
    sourceKind: "REPORT",
    source: REPORT_0930,
    section: "§9, E-06",
    quote: "Honor `Retry-After` when the response includes it; otherwise, apply bounded exponential backoff before resubmitting the signed request.",
  },
  RETRY_AFTER_ON_POST_ONLY: {
    id: "RETRY_AFTER_ON_POST_ONLY",
    consequence: "`Retry-After` is also read on the post-only 503.",
    sourceKind: "REPORT",
    source: REPORT_0930,
    section: "§2.4",
    quote: 'with a `Retry-After` header "Seconds to wait before retrying when provided by post-only mode"',
  },
} satisfies Readonly<Record<string, RateLimitVenueFact>>);
