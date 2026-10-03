/**
 * Every venue fact the restricted-mode detector acts on, quoted verbatim
 * (whitespace-normalized) from a dated report ("cite it or refuse"; the
 * WP-270 `VENUE_FACTS` convention, whose rows this module also relies on:
 * `RESTART_RESUBMIT`, `RETRY_ONLY_RESTART`, `POST_ONLY_NO_UNCHANGED_RETRY`,
 * `POST_ONLY_AFTER_RESTART`, `TRADING_UNAVAILABLE_CANCELS_UNKNOWN`,
 * `CANCELS_IN_CANCEL_ONLY`). `hygiene.test.ts` checks every quote.
 */

import type { VenueFact } from "../venue-facts.js";

const REPORT_0916 = "docs/venue/verified-2026-09-16.md";
const REPORT_0930 = "docs/venue/verified-2026-09-30.md";

export const RESTRICTED_MODE_FACTS = Object.freeze({
  RESTART_IS_425: {
    id: "RESTART_IS_425",
    consequence: "A 425 on a placement or a cancel starts (or continues) a RESTARTING episode.",
    source: REPORT_0930,
    section: "§9, E-06",
    quote: "An order-related request returns HTTP `425` while the matching engine is restarting.",
  },
  RESTART_KEYED_ON_425: {
    id: "RESTART_KEYED_ON_425",
    consequence: "RESTARTING is keyed on the status (WP-260's `ENGINE_RESTARTING`), with its optional `Retry-After`.",
    source: REPORT_0930,
    section: "§W.7",
    quote: "key restart handling on 425 (honour optional `Retry-After`)",
  },
  RESTART_RETRY_AFTER_OR_BACKOFF: {
    id: "RESTART_RETRY_AFTER_OR_BACKOFF",
    consequence: "RESTARTING lasts exactly `Retry-After` when given; otherwise the snapshot's bounded exponential backoff.",
    source: REPORT_0930,
    section: "§9, E-06",
    quote: "Honor `Retry-After` when the response includes it; otherwise, apply bounded exponential backoff before resubmitting the signed request.",
  },
  RESTART_BACKOFF_START: {
    id: "RESTART_BACKOFF_START",
    consequence: "The fixture snapshot's restart backoff starts at 1 s and grows per failed attempt.",
    source: REPORT_0916,
    section: "§9",
    quote: "Start at 1–2 seconds and increase the interval on each retry",
  },
  RESTART_BACKOFF_CAP: {
    id: "RESTART_BACKOFF_CAP",
    consequence: "The fixture snapshot's restart backoff doubles and is capped at 30 s, as the official SDK example does.",
    source: REPORT_0930,
    section: "§9, E-06",
    quote: "honour `error.retryAfter` with a doubling fallback capped at 30 s",
  },
  RESTART_SCOPE: {
    id: "RESTART_SCOPE",
    consequence: "Only the restart condition clears a retransmission of the same signed order; a 503, a 5xx, a 429 never do.",
    source: REPORT_0930,
    section: "§9, E-07",
    quote: "the restart-retry path is scoped to `restriction === RESTARTING` (SDK) / status 425 (wire) only; it must not absorb 503s or 5xx.",
  },
  POST_ONLY_WINDOW: {
    id: "POST_ONLY_WINDOW",
    consequence:
      "After a restart the detector reports POST_ONLY until the engine is seen back (an answer to a request sent after the last 425), then for the snapshot's `postOnlyWindowMs` (two minutes in the fixture) from that answer.",
    source: REPORT_0930,
    section: "§9",
    quote: "enters post-only mode for two minutes: cancels remain available, but new orders must be eligible maker orders submitted as post-only",
  },
  POST_ONLY_KEYED_ON_CODE: {
    id: "POST_ONLY_KEYED_ON_CODE",
    consequence: "POST_ONLY is keyed on the documented code (WP-260's `POST_ONLY_MODE`) and lasts its `Retry-After` / `retry_after_seconds`.",
    source: REPORT_0930,
    section: "§W.7",
    quote: 'post-only on `code: "post_only_mode"` (header or `retry_after_seconds`)',
  },
  POST_ONLY_BATCH_ENTRY: {
    id: "POST_ONLY_BATCH_ENTRY",
    consequence: "A batch entry rejected with the post-only code (`POST_ONLY_MODE`) signals POST_ONLY too (no delay is carried: the window applies).",
    source: REPORT_0930,
    section: "§9",
    quote: 'batch post-only entries with `"success": true` and a non-empty `errorMsg`',
  },
  POST_ONLY_NO_UNCHANGED_RETRY: {
    id: "POST_ONLY_NO_UNCHANGED_RETRY",
    consequence: "While POST_ONLY holds, no gate clears a non-post-only order, new or retransmitted.",
    source: REPORT_0930,
    section: "§9",
    quote: "Do not retry the same non-post-only order unchanged.",
  },
  UNCLASSIFIED_503: {
    id: "UNCLASSIFIED_503",
    consequence: "A 503 without a documented code is TRADING_UNAVAILABLE: no placement; cancels are still attempted.",
    source: REPORT_0930,
    section: "§W.7",
    quote: 'treat an unclassified 503 on placement as "trading unavailable; cancels not established"',
  },
  PAUSE_NEW_SUBMISSIONS: {
    id: "PAUSE_NEW_SUBMISSIONS",
    consequence: "TRADING_UNAVAILABLE pauses new submissions for a policy duration (the venue gives none); it never blocks a cancel.",
    source: REPORT_0930,
    section: "§9, E-05",
    quote: "Pause new submissions; this response does not establish whether cancels are available.",
  },
  NEVER_BY_TEXT: {
    id: "NEVER_BY_TEXT",
    consequence: "No mode is ever derived from the venue's `error` text; only from the status and the documented code.",
    source: REPORT_0930,
    section: "§9, E-05",
    quote: "mode detection must key on status + absence of `code`, never on the `error` text",
  },
  CLOSED_ONLY_NO_RESUBMIT: {
    id: "CLOSED_ONLY_NO_RESUBMIT",
    consequence:
      "A closed-only rejection (a 400 without a documented code: WP-260's `REQUEST_REJECTED`) moves no mode and never clears a resend: only `ENGINE_RESTARTING` does.",
    source: REPORT_0916,
    section: "§9, D-24",
    quote: "mode-aware retry must not resubmit an opening order after this rejection",
  },
  CANCELS_WORK_IN_CANCEL_ONLY: {
    id: "CANCELS_WORK_IN_CANCEL_ONLY",
    consequence: "The cancel gate always allows a cancel.",
    source: REPORT_0930,
    section: "§2.5",
    quote: "Works even in cancel-only mode",
  },
} satisfies Readonly<Record<string, VenueFact>>);
