/**
 * Every venue fact the emergency commands act on, with its citation (handoff
 * §1.2: current official documentation controls volatile venue facts; "cite
 * it or refuse"). `venue-facts.test.ts` checks every quote against its dated
 * report, whitespace-normalized, so a quote that drifts from the record fails.
 *
 * DOCUMENTARY ONLY. No verification round has exercised an authenticated
 * cancel, an authenticated read or the order heartbeat from this repository
 * (`docs/venue/verified-2026-09-30.md` §13; `docs/handoffs/WP-000.md`). The
 * emergency CLI sends nothing in PAPER: its signer gate refuses first.
 *
 * The heartbeat's timing is WP-320's, imported from its public facts
 * (`HEARTBEAT_VENUE_FACTS.TIMEOUT_AND_SWEEP`), not restated here.
 */

const REPORT_0916 = "docs/venue/verified-2026-09-16.md";
const REPORT_0930 = "docs/venue/verified-2026-09-30.md";

export interface EmergencyVenueFact {
  readonly id: string;
  /** What the emergency CLI does because of it. */
  readonly consequence: string;
  readonly source: string;
  readonly section: string;
  /** Verbatim from `source` (whitespace-normalized). */
  readonly quote: string;
}

export const EMERGENCY_VENUE_FACTS = Object.freeze({
  CANCEL_ENDPOINTS: {
    id: "CANCEL_ENDPOINTS",
    consequence:
      "cancel-order, cancel-market and cancel-all each map to one documented cancel endpoint, reached only through WP-260's secure client; each works in cancel-only mode, so a cancel is always attempted rather than inferred unavailable.",
    source: REPORT_0930,
    section: "§2.5",
    quote:
      '`DELETE /order`, `DELETE /orders`, `DELETE /cancel-market-orders`, `DELETE /cancel-all`: each "Works even in cancel-only mode"',
  },
  CANCEL_REQUEST_SHAPES: {
    id: "CANCEL_REQUEST_SHAPES",
    consequence:
      "cancel-market takes a condition id (`market`) and optionally an asset id; cancel-all takes nothing; the batch sweep of cancel-all sends ids, whose duplicates the venue ignores (the CLI sends none).",
    source: REPORT_0916,
    section: "§5",
    quote:
      '`DELETE /orders` "submit a batch of up to 3,000 IDs. Duplicate IDs in the batch are ignored." (lines 1111–1113); `DELETE /cancel-market-orders` with `{"asset_id": ...}` or `{"market": ...}` (lines 1277, 1303); `DELETE /cancel-all` with no body (line 1362)',
  },
  CANCEL_RESULT: {
    id: "CANCEL_RESULT",
    consequence:
      "Every cancel answer is printed as two lists, canceled and not canceled, each not-canceled id with its reason (WP-260 carries a documented reason verbatim and any other as UNDOCUMENTED); a partial cancel is never summarized away (ADR-008 §6).",
    source: REPORT_0930,
    section: "§2.5",
    quote:
      'response `{canceled: [...], not_canceled: {"<id>": "<reason>"}}` with documented example reasons "Order not found or already canceled", "Order already matched", "Order not found", "Order already canceled".',
  },
  BATCH_CANCEL_LIMIT: {
    id: "BATCH_CANCEL_LIMIT",
    consequence:
      "A batch cancel by id carries at most 1,000 ids (WP-260's MAX_CANCEL_IDS_PER_REQUEST), and fewer when the cancel bucket's burst minus the emergency class's headroom is smaller (WP-310).",
    source: REPORT_0930,
    section: "§11, C-11",
    quote: "**Two official limits.** Use the lower (≤ 1,000) until resolved. Owners `WP-310`, `WP-330` (`cancel-market`/bulk cancel).",
  },
  CANCEL_DEBT: {
    id: "CANCEL_DEBT",
    consequence:
      "cancel-all and cancel-market are completed in the rate-limit budget with the venue's canceled count, so the cancel bucket is debited one token per order canceled; the plan prints the debt, and any later cancel waits for the bucket (D-21).",
    source: REPORT_0916,
    section: "§8, D-21",
    quote:
      "Each request first consumes one cancel token. After the cancellation result is known, the bucket is debited one additional token for every order successfully canceled. For tiers that allow a negative cancel balance, this second debit can put the bucket into debt. Future cancel requests remain blocked until the bucket has enough tokens for the next request. Other tiers floor the post-cancel balance at zero regardless of debit size.",
  },
  CANCELS_NOT_INFERRED: {
    id: "CANCELS_NOT_INFERRED",
    consequence:
      "No cancel is skipped because a placement was answered 503: the CLI always sends the cancel, and only the cancel's own answer is evidence.",
    source: REPORT_0930,
    section: "§9, E-05",
    quote:
      "`WP-330`'s emergency cancel must not infer \"cancels are available\" from a 503 on placement; a cancel attempt is the only evidence.",
  },
  MATCHING_DELAY: {
    id: "MATCHING_DELAY",
    consequence: "An order the venue reports not canceled, or still lists afterwards, is reported as such; the CLI never claims it is gone.",
    source: REPORT_0930,
    section: "§W.3",
    quote: 'per-order cancel failure reasons are free text; orders inside a matching delay "cannot be canceled" (VENUE-2 D-18).',
  },
  ABSENT_IS_NOT_CANCELED: {
    id: "ABSENT_IS_NOT_CANCELED",
    consequence:
      "An order missing from the open-orders list after a cancel is reported as 'not listed', never as 'canceled'; only the cancel answer's canceled list, or a read by id, says canceled.",
    source: REPORT_0930,
    section: "§11, E-14",
    quote: "an order absent from the open-orders list is not proof of cancellation; resolve `SUBMISSION_UNKNOWN` and missing orders by id.",
  },
  DATA_API_V2_ONLY: {
    id: "DATA_API_V2_ONLY",
    consequence: "account-snapshot reads positions and approvals from the Data API `/v2` routes only; an answer tagged with any other route is refused (V3-E15).",
    source: REPORT_0930,
    section: "§11, E-15",
    quote: "**`WP-330`** (account snapshot): use `/v2` only;",
  },
  READS_PER_CREDENTIAL: {
    id: "READS_PER_CREDENTIAL",
    consequence:
      "The emergency credential must be the credential set that placed the orders: venue reads and cancels are per credential, so a different credential would neither see nor cancel them. The CLI checks that the loaded credential names the account the operator confirmed.",
    source: REPORT_0930,
    section: "§11, E-16",
    quote: "venue-truth reads are **per credential**; a reconciler or emergency CLI holding a different credential cannot see those orders.",
  },
} as const satisfies Readonly<Record<string, EmergencyVenueFact>>);
