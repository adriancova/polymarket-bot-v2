/**
 * THE RESOLUTION CHECK (`V2-3`; ADR-030 Amendment 2, rules 4 and 5, the
 * orchestrator's interim ruling for PAPER and BACKTEST): a journaled,
 * condition-keyed `GET /v2/resolutions` read for an admitted window whose
 * resolution the market channel has not delivered, and the judgement of what
 * each answer found. The series-admission feed (`./series-admission.ts`)
 * drives the reads in its cycle and acts on each finding; this module holds
 * what is judged, read and remembered.
 *
 * ## Why (plan row A13)
 *
 * The market channel's `market_resolved` is unobserved for V2 markets (U-38).
 * Without another source, every V2 window of a series would hold its cap slot
 * until an operator retired it (Amendment 1, rules 1 and 4), and PAPER on the
 * series would stall after the switchover.
 *
 * ## When a window is read (rule 4 item 1; rule 5, "Polling and the incident")
 *
 * A live, CONFIRMED admitted window (its admission published: an unconfirmed
 * intent has reached no consumer, and is not subscribed) is read when:
 * - the gateway clock is at or past its scheduled close — no grace period
 *   (item 5: an early read finds a miss or a pending row, which publishes
 *   nothing);
 * - no resolution of it is owed or published, in the ledger or in memory
 *   (Amendment 1, rule 2) — a frame observed first is the resolution, and
 *   then no row is read;
 * - its row path has not ended: no row of it was refused, and none published.
 *
 * It is read again every admission cycle while that stays so: after a
 * pending or a failed read, with no incident of its own (item 1).
 *
 * ## The interval, and the budget (§9.13)
 *
 * **The interval is the admission cycle's `pollIntervalMs`** (default 30 s,
 * floor 5 s), one read per eligible window per cycle, after discovery. Why:
 * - **Bounded by the venue's documented limit.** The Data API v2 "General
 *   (all `/v2` endpoints)" limit is 800 requests per 10 s
 *   (`docs/venue/verified-2026-09-16.md` §8, S-D24 lines 57-66; the page is
 *   byte-identical on 2026-10-05, `docs/venue/verified-2026-10-05.md` S-D34).
 *   `/v2/resolutions` has no row of its own, so the general figure governs.
 *   The configuration door (`../config.ts`) refuses a configuration whose
 *   `Σ maximumConcurrentWindows × 10 000 / pollIntervalMs` exceeds the 5 %
 *   share every other admission read uses (40 per 10 s), and the feed
 *   ENFORCES that bound per cycle: at most `maximumConcurrentWindows` reads
 *   are attempted per series per cycle, whatever their outcome, and a window
 *   past it waits for the next cycle (`resolutionReadsDeferredByBudget`).
 * - **Timely enough.** An up/down window resolves from Chainlink after its
 *   close (F-58, F-59). Reading every cycle frees a resolved window's slot at
 *   most about one interval after its row turns `"resolved"` — the same
 *   latency as a frame's resolution, which is also retired at the next cycle.
 * - **No new cadence.** The read runs inside the one sequential cycle, after
 *   the ledger's teardown and discovery, so it never races a retirement and
 *   an overlapping cycle is skipped and counted, never stacked. A slow Data
 *   API delays only the reads behind it, not that cycle's admissions.
 *
 * Each read has a {@link RESOLUTION_READ_TIMEOUT_MS} timeout: past it the
 * request is aborted and the read is Failed.
 *
 * ## Journal before derive (rule 4 items 2 and 3; Decision 3.1 and 3.4)
 *
 * Every RESPONSE — a miss, an error status, a refused row, all of them — is
 * journaled to the WAL BEFORE it is judged ({@link readResolutionOnce}). A
 * response the WAL refuses derives nothing. A read that received nothing (a
 * transport failure or the timeout) has no body to journal, and derives
 * nothing but "Failed". The journaled `endpoint` is the request URL with the
 * response's HTTP status as a fragment (`#http-status=200`;
 * {@link resolutionReadEndpoint}). A fragment is never sent in a request
 * (RFC 3986 §3.5), so the text before `#` is the URL read, exactly; the status
 * is there because rule 5 judges it (an error status is Failed whatever the
 * body), and the WAL record has no other place for it. So a REPLAY derives the
 * same finding from the journal alone, never asking the venue
 * ({@link replayJournaledResolutionAnswer}).
 *
 * ## What a read finds (rule 5, "What a read finds"; {@link judgeResolutionAnswer})
 *
 * 1. **Publishable:** the response's ONLY row; its `condition_id` the
 *    window's 32-byte condition (rule 3; compared as bytes: `0x` and 64 hex
 *    digits, hex case ignored); `status` `"resolved"` (F-56); raw `payouts`
 *    exactly `[1000000,0]` (`YES_WIN`) or `[0,1000000]` (`NO_WIN`), mapped by
 *    index (index 0 is YES, F-40) and compared BY VALUE as fixed integer
 *    vectors (ADR-009 §8, note of 2026-10-05: `1e6` is that vector); and a
 *    well-formed `resolved_at` (the domain's ISO instant with an offset, and a
 *    real calendar instant), which becomes `resolvedAt` UNCHANGED — no other
 *    time stands in for it.
 * 2. **Pending:** a documented miss — `{"data": []}` (F-57) or
 *    `{"data": null}` (F-65: "A documented miss is `data: null` or an empty
 *    list"; V2-0's R2-OPUS-L3) — or the single row for the window's condition
 *    whose `status` is another of F-57's values (`initialized`, `posed`,
 *    `proposed`, `challenged`, `reproposed`, `disputed`, `active`,
 *    `arbitration`). A `disputed` row publishes nothing (ADR-009 §4).
 * 3. **Failed:** no answer within the timeout, a transport failure, an HTTP
 *    status outside 2xx, or a body that is not JSON.
 * 4. **Refused:** anything else — more than one row; a row that is not an
 *    object, or for another condition, or without a readable
 *    `condition_id`; a `status` outside F-57's list; a `"resolved"` row whose
 *    `payouts` are missing or any other vector (a split, F-73 and plan D18;
 *    the SDK's collateral-unit `["1","0"]`, F-78, which is two STRINGS and is
 *    never read a millionfold low; `[1,0]`, `[1000000,0,0]`), or without a
 *    well-formed `resolved_at`; and a JSON body without the documented `data`
 *    list (F-65).
 *
 * A disagreement with a `market_resolved` frame (rule 5 condition 6) is the
 * feed's to judge, because it needs the window's standing resolution: see
 * `./series-admission.ts`, "Two sources".
 *
 * ## A refusal ends the row path, and survives a restart (V2-0's R2-OPUS-L2)
 *
 * A refused row ends the window's row path: no more reads, and no row
 * publishes for it (rule 5, "Polling and the incident", item 4). The feed
 * remembers it in memory AND durably, in the existing admission ledger, as a
 * `REFUSED` record under its own key namespace,
 * `resolution-row-refused:<the window's ledger key>` ({@link rowRefusalMarker}).
 * The ledger's `REFUSED` semantics are exactly a row-path refusal's: judged
 * once, final, durable before the next read, never a window's admission (the
 * key cannot collide with a condition id or an `event:` key), and pruned with
 * the window's close after the ledger's retention (2 days). At start the feed
 * reloads every such record, so a restart never reads a window whose row was
 * refused before it. Two residuals, each SAID where it happens:
 * - if the marker's write fails, the PAGE (`GATEWAY_SERIES_LEDGER_WRITE_FAILED`)
 *   fires and the refusal incident says a restart will read the window again;
 * - a window still live two days after its close has its marker pruned, and a
 *   restart after that reads it again. Such a window is past its unresolved
 *   bound and named by an incident; its recovery is the operator's retirement.
 *
 * ## PAPER and BACKTEST only, and no credential
 *
 * The read is the public Data API v2 ("**Auth**: none", F-67) on our own
 * client (`@polymarket-bot/polymarket-public`'s `requestDataApiResolutions`),
 * never the SDK (rule 4 item 4). It runs inside the series-admission feed,
 * which refuses to start in any other mode (Decision 2.1).
 */

import { IsoTimestampSchema, type MarketResolvedPayload } from "@polymarket-bot/domain";
import {
  readDataApiResolutionsBody,
  requestDataApiResolutions,
  type DataApiPayoutElement,
  type DataApiResolutionsAnswer,
  type PublicHttpClient,
} from "@polymarket-bot/polymarket-public";

import { boundedMismatches, type AdmissionLedgerRecord } from "../admission-ledger.js";
import type { GatewayReceipt, GatewayTimers } from "../ports.js";

/** How long one `/v2/resolutions` read may take before it is aborted and Failed. */
export const RESOLUTION_READ_TIMEOUT_MS = 5_000;

/** The only `status` a row may publish from (F-56: "Use payouts only from a row whose `status` is `"resolved"`"). */
export const RESOLVED_STATUS = "resolved";

/** F-57's other values: a row in any of them is Pending. */
export const PENDING_RESOLUTION_STATUSES: readonly string[] = Object.freeze([
  "initialized",
  "posed",
  "proposed",
  "challenged",
  "reproposed",
  "disputed",
  "active",
  "arbitration",
]);

/** One share's payout, in micro-USDC (F-57: "Per-outcome payout in micro-USDC per share"). */
const ONE_SHARE_MICRO_USDC = 1_000_000;

/** The outcome a publishable row maps to. */
export type RowOutcome = Extract<MarketResolvedPayload["outcome"], "YES_WIN" | "NO_WIN">;

/**
 * The two vectors a row may publish from, compared by value, element by
 * element (ADR-009 §8, note of 2026-10-05, item 3). Index 0 is YES (F-40).
 */
export const PUBLISHABLE_PAYOUTS: readonly { readonly payouts: readonly [number, number]; readonly outcome: RowOutcome }[] = Object.freeze([
  Object.freeze({ payouts: Object.freeze([ONE_SHARE_MICRO_USDC, 0] as const), outcome: "YES_WIN" as const }),
  Object.freeze({ payouts: Object.freeze([0, ONE_SHARE_MICRO_USDC] as const), outcome: "NO_WIN" as const }),
]);

/** What one read found (rule 5, "What a read finds"). */
export type ResolutionFinding =
  | { readonly kind: "PUBLISHABLE"; readonly outcome: RowOutcome; readonly resolvedAt: string; readonly detail: string }
  | { readonly kind: "PENDING"; readonly detail: string }
  | { readonly kind: "FAILED"; readonly detail: string }
  | { readonly kind: "REFUSED"; readonly detail: string };

/** One answer as it reaches the judgement: a response (any status) or none. */
export type ResolutionAnswer =
  | { readonly kind: "RESPONSE"; readonly status: number; readonly bodyUtf8: string }
  | { readonly kind: "NO_ANSWER"; readonly detail: string };

const CONDITION_ID_32_BYTES = /^0x[0-9a-fA-F]{64}$/u;

/** Is `text` a well-formed instant: the domain's ISO timestamp with an offset, on the calendar? */
export function isWellFormedInstant(text: string): boolean {
  return IsoTimestampSchema.safeParse(text).success && Number.isFinite(Date.parse(text));
}

function payoutText(elements: readonly DataApiPayoutElement[]): string {
  return `[${elements
    .map((element) => (element.kind === "NUMBER" ? String(element.value) : element.kind === "STRING" ? JSON.stringify(element.value) : `<${element.detail}>`))
    .join(",")}]`;
}

/** The outcome a payout vector selects, or why it selects none (rule 5 condition 3). */
function outcomeOfPayouts(elements: readonly DataApiPayoutElement[]): { readonly ok: true; readonly outcome: RowOutcome } | { readonly ok: false; readonly problem: string } {
  const text = payoutText(elements);
  for (const candidate of PUBLISHABLE_PAYOUTS) {
    if (
      elements.length === candidate.payouts.length &&
      elements.every((element, index) => element.kind === "NUMBER" && element.value === candidate.payouts[index])
    ) {
      return { ok: true, outcome: candidate.outcome };
    }
  }
  if (elements.some((element) => element.kind === "STRING")) {
    return {
      ok: false,
      problem:
        `payouts ${text} carries strings, not the wire's integer micro-USDC per share (F-57); a string tuple such as the SDK's ` +
        'collateral-unit form ["1","0"] (F-78) is refused, never read as a payout a millionfold low',
    };
  }
  const numbers = elements.flatMap((element) => (element.kind === "NUMBER" ? [element.value] : []));
  if (elements.length === 2 && numbers.length === 2 && numbers.every((value) => value > 0) && numbers[0]! + numbers[1]! === ONE_SHARE_MICRO_USDC) {
    return {
      ok: false,
      problem: `payouts ${text} is a split payout (F-73; plan D18): a row publishes only [1000000,0] (YES_WIN) or [0,1000000] (NO_WIN)`,
    };
  }
  return {
    ok: false,
    problem: `payouts ${text} is neither [1000000,0] (YES_WIN) nor [0,1000000] (NO_WIN), compared by value as micro-USDC per share (F-57; ADR-009 §8)`,
  };
}

/**
 * How a field that is not a usable value is named: absent, `null`, or not of
 * the kind the field holds — `expected` is that kind ("a string" for a text
 * field, "a list" for `payouts`; V2-3 r1, FABLE-R1-05).
 */
function fieldText(reading: { readonly kind: string; readonly detail?: string }, expected = "a string"): string {
  return reading.kind === "ABSENT" ? "absent" : reading.kind === "NULL" ? "null" : `not ${expected} (${reading.detail ?? "unreadable"})`;
}

/**
 * THE JUDGEMENT (rule 5, "What a read finds"; module header). PURE and TOTAL:
 * the same answer for the same window always finds the same, which is what
 * lets a replay re-derive it from the journal.
 */
export function judgeResolutionAnswer(answer: ResolutionAnswer, paddedConditionId: string): ResolutionFinding {
  if (answer.kind === "NO_ANSWER") return { kind: "FAILED", detail: answer.detail };
  if (!Number.isInteger(answer.status) || answer.status < 200 || answer.status >= 300) {
    return { kind: "FAILED", detail: `the read returned HTTP ${String(answer.status)}` };
  }
  const reading = readDataApiResolutionsBody(answer.bodyUtf8);
  if (reading.status === "NOT_JSON") return { kind: "FAILED", detail: reading.detail };
  if (reading.status === "NOT_ENVELOPE") return { kind: "REFUSED", detail: reading.detail };
  const rows = reading.rows;
  if (rows === null) return { kind: "PENDING", detail: 'a documented miss, {"data": null} (F-65)' };
  if (rows.length === 0) return { kind: "PENDING", detail: 'a documented miss, {"data": []} (F-57)' };
  if (rows.length > 1) {
    return { kind: "REFUSED", detail: `the response carries ${String(rows.length)} rows; a row publishes only as the response's only row (rule 5 condition 1)` };
  }
  const row = rows[0]!;
  if (row.kind === "NOT_A_ROW") return { kind: "REFUSED", detail: row.detail };
  if (row.conditionId.kind !== "VALUE") {
    return { kind: "REFUSED", detail: `the row's condition_id is ${fieldText(row.conditionId)}; a row must name the window's condition (rule 5 condition 1)` };
  }
  const rowCondition = row.conditionId.value;
  if (!CONDITION_ID_32_BYTES.test(rowCondition) || rowCondition.toLowerCase() !== paddedConditionId.toLowerCase()) {
    return {
      kind: "REFUSED",
      detail: `the row is for condition ${JSON.stringify(rowCondition)}, not the window's ${paddedConditionId} (rule 5 condition 1; rule 3 item 5)`,
    };
  }
  if (row.status.kind !== "VALUE") {
    return { kind: "REFUSED", detail: `the row's status is ${fieldText(row.status)}, not one of F-57's values` };
  }
  const status = row.status.value;
  if (PENDING_RESOLUTION_STATUSES.includes(status)) {
    return {
      kind: "PENDING",
      detail: `the row's status is ${JSON.stringify(status)}${status === "disputed" ? " (a disputed row publishes no resolution, ADR-009 §4)" : ""}, not "resolved"`,
    };
  }
  if (status !== RESOLVED_STATUS) {
    return { kind: "REFUSED", detail: `the row's status ${JSON.stringify(status)} is outside F-57's list` };
  }
  const problems: string[] = [];
  let outcome: RowOutcome | undefined;
  if (row.payouts.kind !== "VALUE") {
    problems.push(`a "resolved" row's payouts are ${fieldText(row.payouts, "a list")} (F-57: "present on resolved condition-keyed rows")`);
  } else {
    const mapped = outcomeOfPayouts(row.payouts.value);
    if (mapped.ok) outcome = mapped.outcome;
    else problems.push(mapped.problem);
  }
  let resolvedAt: string | undefined;
  if (row.resolvedAt.kind !== "VALUE") {
    problems.push(`its resolved_at is ${fieldText(row.resolvedAt)}, and MarketResolved.resolvedAt has no substitute ("The resolution instant")`);
  } else if (!isWellFormedInstant(row.resolvedAt.value)) {
    problems.push(`its resolved_at ${JSON.stringify(row.resolvedAt.value)} is not a well-formed instant ("The resolution instant")`);
  } else {
    resolvedAt = row.resolvedAt.value;
  }
  if (problems.length > 0 || outcome === undefined || resolvedAt === undefined) {
    return { kind: "REFUSED", detail: problems.length > 0 ? problems.join("; ") : "the resolved row is incomplete" };
  }
  return {
    kind: "PUBLISHABLE",
    outcome,
    resolvedAt,
    detail: `a resolved row with payouts ${outcome === "YES_WIN" ? "[1000000,0]" : "[0,1000000]"} (${outcome}), resolved_at ${resolvedAt}`,
  };
}

// ---------------------------------------------------------------------------
// The journal, and replay
// ---------------------------------------------------------------------------

const STATUS_FRAGMENT = "#http-status=";

/** The journaled `endpoint` of one answer: the URL read, and its HTTP status as a fragment (module header). */
export function resolutionReadEndpoint(url: string, status: number): string {
  return `${url}${STATUS_FRAGMENT}${String(status)}`;
}

/**
 * Re-derives one journaled answer's finding from the WAL record alone
 * (Decision 3.4: replay never asks the venue): the URL and status from its
 * `endpoint`, the condition from the URL's `condition` parameter, the body
 * from `payloadUtf8`. `undefined` for a record that is not a `/v2/resolutions`
 * answer this module journaled.
 */
export function replayJournaledResolutionAnswer(record: {
  readonly endpoint: string;
  readonly payloadUtf8: string;
}): { readonly paddedConditionId: string; readonly status: number; readonly finding: ResolutionFinding } | undefined {
  const cut = record.endpoint.lastIndexOf(STATUS_FRAGMENT);
  if (cut < 0) return undefined;
  const statusText = record.endpoint.slice(cut + STATUS_FRAGMENT.length);
  if (!/^[1-9][0-9]{2}$/u.test(statusText)) return undefined;
  let url: URL;
  try {
    url = new URL(record.endpoint.slice(0, cut));
  } catch {
    return undefined;
  }
  const condition = url.searchParams.get("condition");
  if (!url.pathname.endsWith("/v2/resolutions") || condition === null) return undefined;
  const status = Number(statusText);
  return { paddedConditionId: condition, status, finding: judgeResolutionAnswer({ kind: "RESPONSE", status, bodyUtf8: record.payloadUtf8 }, condition) };
}

/** A journaled response that derived events cite. */
export interface JournaledAnswerFrame {
  readonly receipt: GatewayReceipt;
  readonly rawFrameIngestSeq: string;
  readonly connectionId: string;
}

/** One read: what it found, and the journaled frame it was judged from (none when nothing was recorded). */
export interface ResolutionRead {
  readonly finding: ResolutionFinding;
  readonly frame: JournaledAnswerFrame | undefined;
}

/**
 * Makes ONE `/v2/resolutions` read for a window's 32-byte condition, journals
 * the response FIRST, then judges it (module header). Never rejects.
 */
export async function readResolutionOnce(options: {
  readonly http: PublicHttpClient;
  readonly baseUrl: string | undefined;
  readonly timers: GatewayTimers;
  readonly timeoutMs: number;
  readonly paddedConditionId: string;
  /** Journals one response body; `undefined` when the WAL refused it (the caller pages). */
  readonly journal: (endpoint: string, bodyUtf8: string) => JournaledAnswerFrame | undefined;
}): Promise<ResolutionRead> {
  let answer: DataApiResolutionsAnswer;
  try {
    answer = await requestDataApiResolutions({
      http: options.http,
      conditionId: options.paddedConditionId,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      timers: options.timers,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    // Only a configuration defect (a condition not in the 32-byte form, or an
    // empty base url) throws, before any request: nothing was received.
    return { finding: { kind: "FAILED", detail: `no read was made: ${error instanceof Error ? error.message : String(error)}` }, frame: undefined };
  }
  if (answer.kind === "NO_ANSWER") return { finding: judgeResolutionAnswer(answer, options.paddedConditionId), frame: undefined };
  // Journaled BEFORE anything is derived from it (rule 4 item 2).
  const frame = options.journal(resolutionReadEndpoint(answer.url, answer.status), answer.bodyUtf8);
  if (frame === undefined) {
    return { finding: { kind: "FAILED", detail: "the WAL refused the response, so nothing is derived from it" }, frame: undefined };
  }
  return { finding: judgeResolutionAnswer(answer, options.paddedConditionId), frame };
}

// ---------------------------------------------------------------------------
// The row paths: the latest read of each window, and the ended ones
// ---------------------------------------------------------------------------

/** The latest read of one window, for the unresolved-window incident's text. */
export interface LatestResolutionRead {
  readonly at: string;
  readonly kind: ResolutionFinding["kind"];
  readonly detail: string;
  readonly rawFrameIngestSeq: string | undefined;
}

/**
 * Per window (by its ledger key): the latest read, and whether its row path
 * has ENDED (a row refused, or published) and why. In memory; a refusal is
 * also durable as a ledger marker (module header).
 */
export class ResolutionRowPaths {
  readonly #latest = new Map<string, LatestResolutionRead>();
  readonly #ended = new Map<string, string>();

  note(windowKey: string, read: LatestResolutionRead): void {
    this.#latest.set(windowKey, read);
  }

  latest(windowKey: string): LatestResolutionRead | undefined {
    return this.#latest.get(windowKey);
  }

  /** Ends the window's row path; the first reason stands. */
  end(windowKey: string, why: string): void {
    if (!this.#ended.has(windowKey)) this.#ended.set(windowKey, why);
  }

  endedWhy(windowKey: string): string | undefined {
    return this.#ended.get(windowKey);
  }

  /** Forgets a retired window (its row path can never be read again: it is not live). */
  forget(windowKey: string): void {
    this.#latest.delete(windowKey);
    this.#ended.delete(windowKey);
  }

  get endedCount(): number {
    return this.#ended.size;
  }
}

// ---------------------------------------------------------------------------
// The durable marker of a refused row (R2-OPUS-L2)
// ---------------------------------------------------------------------------

/** The admission-ledger key namespace of row-refusal markers. */
export const ROW_REFUSAL_MARKER_PREFIX = "resolution-row-refused:";

/** The marker key of a window's refused row. */
export function rowRefusalMarkerKey(windowKey: string): string {
  return `${ROW_REFUSAL_MARKER_PREFIX}${windowKey}`;
}

/**
 * The admission-ledger record that remembers a window's refused row across a
 * restart: `REFUSED`, keyed in its own namespace, naming the reason, closing
 * with the window (so pruned with it).
 */
export function rowRefusalMarker(window: AdmissionLedgerRecord, judgedAt: string, reason: string): AdmissionLedgerRecord {
  const closeAt = window.window?.scheduledCloseAt ?? window.closeAt;
  return {
    key: rowRefusalMarkerKey(window.key),
    seriesId: window.seriesId,
    seriesConfigHash: window.seriesConfigHash,
    status: "REFUSED",
    judgedAt,
    ...(closeAt === undefined ? {} : { closeAt }),
    mismatches: [
      ...boundedMismatches([
        `resolution row refused for admitted window ${window.window?.internalMarketId ?? window.key} (V2-3; ADR-030 Amendment 2 rule 5): ${reason}`,
      ]),
    ],
  };
}

/** The window key and reason a ledger record marks, when it is a row-refusal marker. */
export function rowRefusalMarkerOf(record: AdmissionLedgerRecord): { readonly windowKey: string; readonly reason: string } | undefined {
  if (record.status !== "REFUSED" || !record.key.startsWith(ROW_REFUSAL_MARKER_PREFIX)) return undefined;
  const windowKey = record.key.slice(ROW_REFUSAL_MARKER_PREFIX.length);
  if (windowKey === "") return undefined;
  return { windowKey, reason: record.mismatches?.[0] ?? "(no reason recorded)" };
}
