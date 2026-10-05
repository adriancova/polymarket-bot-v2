/**
 * Every venue fact the order-heartbeat controller acts on, with its citation
 * (handoff §1.2, "cite it or refuse"; the `RATE_LIMIT_VENUE_FACTS` convention).
 * `venue-facts.test.ts` checks every quote against its report, whitespace-
 * normalized.
 *
 * DOCUMENTARY ONLY. "The 5-second cadence, the 10-second timeout and the
 * 5-second sweep are documented figures; whether the venue enforces them at
 * those exact values in practice can only be established by an authenticated
 * observation" (`docs/venue/verified-2026-09-16.md` §5). No verification round
 * has observed the protocol, and this package never sends a heartbeat: the
 * transport is an injected port with no binding (ADR-033 D2, D5).
 *
 * THE OPEN CONFLICT (ADR-033 Context 3). The manage-orders guide (S-D17) gives
 * an L2-signed `POST /v1/heartbeats` whose success carries the next id; the
 * API reference (S-D18) gives `POST /heartbeats` whose `200` is
 * `{"status":"ok"}`, with no id. The controller follows the guide
 * (provisional, ADR-033 D2), and reads a success WITHOUT an id as
 * unconfirmed (ADR-033 D6): it fails closed until the venue round resolves
 * the conflict.
 */

const REPORT_0916 = "docs/venue/verified-2026-09-16.md";
const REPORT_0930 = "docs/venue/verified-2026-09-30.md";

export interface HeartbeatVenueFact {
  readonly id: string;
  /** What the controller does because of it. */
  readonly consequence: string;
  readonly source: string;
  readonly section: string;
  /** Verbatim from `source` (whitespace-normalized). */
  readonly quote: string;
}

export const HEARTBEAT_VENUE_FACTS = Object.freeze({
  CADENCE: {
    id: "CADENCE",
    consequence: "The controller sends one heartbeat every 5 s, measured from the previous send.",
    source: REPORT_0916,
    section: "§5 (S-D17)",
    quote: 'Send a heartbeat every **5 seconds**."',
  },
  TIMEOUT_AND_SWEEP: {
    id: "TIMEOUT_AND_SWEEP",
    consequence:
      "The heartbeat has lapsed 10 s after the send time of the last confirmed heartbeat (ADR-033 D6); a lapse end waits 5 s more for the venue's sweep (ADR-033 D6 step 4).",
    source: REPORT_0916,
    section: "§5 (S-D17)",
    quote:
      "if a valid heartbeat is not received within 10 seconds, all open orders owned by those CLOB API credentials are canceled. The cancellation check runs every five seconds, so cancellation may occur up to five seconds after the timeout.",
  },
  BOOTSTRAP_EMPTY_ID: {
    id: "BOOTSTRAP_EMPTY_ID",
    consequence: "With no id to resume, the first request carries an empty heartbeat_id.",
    source: REPORT_0916,
    section: "§5 (S-D17)",
    quote: "Send an empty `heartbeat_id` to `POST /v1/heartbeats`",
  },
  ID_ROTATION: {
    id: "ID_ROTATION",
    consequence: "Each confirmed response's heartbeat_id is the id of the next request; a success without one confirms nothing.",
    source: REPORT_0916,
    section: "§5 (S-D17)",
    quote: "Each successful response returns a new ID to use for the following heartbeat",
  },
  INVALID_ID_RECOVERY: {
    id: "INVALID_ID_RECOVERY",
    consequence: "A 400 carrying the expected id is answered by ONE new request with that id; repeated 400s raise the live-fencing-conflict alert (ADR-008 §4).",
    source: REPORT_0916,
    section: "§5 (S-D17)",
    quote:
      'If the ID is invalid or expired, the CLOB responds with `400 Bad Request` and supplies the expected ID. Sign a new request with that ID and retry: `{"error_msg": "Invalid Heartbeat ID", "heartbeat_id": "<expected_heartbeat_id>"}`".',
  },
  NO_SDK_METHOD: {
    id: "NO_SDK_METHOD",
    consequence: "No transport is written: the controller sits behind the OrderHeartbeatTransport port until the user rules ADR-033 D5.",
    source: REPORT_0930,
    section: "§5",
    quote: "the authenticated request client `secureClob` is marked `@internal` (S-H-client_clients lines 669–672). Conflict **C-12** (§11).",
  },
} satisfies Record<string, HeartbeatVenueFact>);

/** S-D17: "Send a heartbeat every 5 seconds." */
export const HEARTBEAT_CADENCE_MS = 5_000;
/** S-D17: a valid heartbeat not received within 10 seconds cancels every open order under the credentials. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;
/** S-D17: "The cancellation check runs every five seconds, so cancellation may occur up to five seconds after the timeout." */
export const VENUE_CANCELLATION_CHECK_INTERVAL_MS = 5_000;
/** S-D17: the bootstrap request carries an empty `heartbeat_id`. */
export const BOOTSTRAP_HEARTBEAT_ID = "";
/** The ONE `RateLimitBudget` operation a heartbeat is filed as (ADR-033 D3; the `rate-limits-2026-09-30` snapshot gives it kind `HEARTBEAT`). */
export const HEARTBEAT_OPERATION_ID = "clob.heartbeat";
/** §9.13 rank 1; `PERMITTED_PRIORITIES.HEARTBEAT` allows nothing else (ADR-033 D3). */
export const HEARTBEAT_PRIORITY = "ORDER_HEARTBEAT" as const;
/**
 * The longest heartbeat id the controller accepts from a response. The venue
 * documents no bound; this is a guard, and a longer id is read as no id
 * (unconfirmed), never truncated.
 */
export const MAX_HEARTBEAT_ID_LENGTH = 512;
