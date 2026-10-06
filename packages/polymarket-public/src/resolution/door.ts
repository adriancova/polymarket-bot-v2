/**
 * THE `/v2/resolutions` DOOR (`V2-3`; ADR-030 Amendment 2, rules 4 and 5):
 * read one response body into a plain reading — the envelope and, for each
 * row, the four fields rule 5 judges, each AS STATED — and judge nothing.
 * The gateway's `feeds/resolution-check.ts` applies rule 5 to the reading.
 *
 * ## What is read, and from where (`docs/venue/verified-2026-10-05.md`)
 *
 * - **The envelope (F-65):** "Every v2 response wraps its payload in `data`
 *   … A documented miss is `data: null` or an empty list, never an error."
 *   F-57: "Misses return `{ "data": [] }`." So `data` is read as `null`, a
 *   list, or neither — and a body without an own `data` key is reported as
 *   having none.
 * - **Each row** (S-O06 `components.schemas.Resolution`, F-57; observed
 *   F-59, F-44):
 *   - `status`: documented, "initialized, posed, proposed, challenged,
 *     reproposed, disputed or resolved; condition-keyed rows can also serve
 *     active and arbitration";
 *   - `payouts`: documented, "Per-outcome payout in micro-USDC per share,
 *     `[outcome0, outcome1]`; present on resolved condition-keyed rows";
 *   - `condition_id`: OBSERVED on `/v2/resolutions` answers (F-44, S-L04;
 *     F-59), not among the fields the report quotes from the documented
 *     `Resolution` (F-57). Rule 5 condition 1 uses it ONLY to refuse;
 *   - `resolved_at`: OBSERVED (F-59, S-A11), likewise not quoted from the
 *     documented schema. Reading it is part of rule 5's interim ruling ("The
 *     resolution instant").
 *   Every other key (`reporter`, `market_type`, `transaction_hash`,
 *   `log_index`, `resolution_source`, …) stays in the journaled raw body and
 *   is read by nothing.
 *
 * ## `payouts` exactly as the wire states it, after `JSON.parse`
 *
 * ADR-009 §8 (note of 2026-10-05) item 3: "Our door reads it after
 * `JSON.parse`. A spelling that parses to the same integers, such as `1e6`, is
 * that vector." Each element is reported as the JSON NUMBER it parsed to, or
 * as the STRING it was, or as something else — never converted. In
 * particular the SDK's collateral-unit form `["1","0"]` (F-78) reads as two
 * strings, and `[1,0]` as the numbers one and zero: neither is ever scaled, so
 * neither can be read "a millionfold low". The vector is compared by value by
 * the gateway (ADR-009 §8 item 3; rule 5 condition 3), and no amount is taken
 * from it.
 *
 * ## A reading is not a verdict
 *
 * A field that is absent, `null` or of another type is REPORTED as such
 * (`ABSENT`, `NULL`, `UNREADABLE`), never defaulted. A body that is not JSON
 * is `NOT_JSON`; JSON that is not the documented envelope is `NOT_ENVELOPE`.
 * Which of rule 5's four kinds each is (Publishable, Pending, Failed,
 * Refused) is the gateway's judgement, not this door's.
 *
 * ## What this door performs (`docs/contracts/schema-boundary.md` §4)
 *
 * - **D1** — the body is parsed and rebuilt prototype-free by
 *   `../venue/wire-door.ts`'s `readOwnWireValue` before any read; an accessor
 *   is refused, never invoked.
 * - **D2** — not applicable: there is no library parse.
 * - **D3/D4** — every value is read from the materialized tree by
 *   own-property access, and every reading is emitted frozen.
 * - **TOTAL** — never throws.
 */

import { isOwnWireRecord, readOwnWireValue, type OwnWireRecord } from "../venue/wire-door.js";

/** One field of a row: absent, `null`, a value of the expected kind, or something else. */
export type DataApiFieldReading<T> =
  | { readonly kind: "ABSENT" }
  | { readonly kind: "NULL" }
  | { readonly kind: "VALUE"; readonly value: T }
  | { readonly kind: "UNREADABLE"; readonly detail: string };

/** One element of `payouts`, as `JSON.parse` left it. */
export type DataApiPayoutElement =
  | { readonly kind: "NUMBER"; readonly value: number }
  | { readonly kind: "STRING"; readonly value: string }
  | { readonly kind: "OTHER"; readonly detail: string };

/** One `Resolution` row: the four fields rule 5 judges, as stated. */
export interface DataApiResolutionRowReading {
  readonly kind: "ROW";
  /** `condition_id` (observed, F-44): a string, or why not. */
  readonly conditionId: DataApiFieldReading<string>;
  /** `status` (F-57): a string, or why not. */
  readonly status: DataApiFieldReading<string>;
  /** `payouts` (F-57): a JSON array, each element as parsed; or why not. */
  readonly payouts: DataApiFieldReading<readonly DataApiPayoutElement[]>;
  /** `resolved_at` (observed, F-59): a string, or why not. */
  readonly resolvedAt: DataApiFieldReading<string>;
}

/** A `data` element that is not a JSON object. */
export interface DataApiNotARowReading {
  readonly kind: "NOT_A_ROW";
  readonly detail: string;
}

export type DataApiResolutionsBodyReading =
  | {
      /** The body does not parse as JSON. */
      readonly status: "NOT_JSON";
      readonly detail: string;
    }
  | {
      /** JSON, but not the documented `{ "data": … }` envelope with `data` a list or `null` (F-65). */
      readonly status: "NOT_ENVELOPE";
      readonly detail: string;
    }
  | {
      /** The envelope, with `data` `null` or a list (F-65; F-57). */
      readonly status: "ENVELOPE";
      /** `null` for `{"data": null}`; otherwise every element, in order. */
      readonly rows: readonly (DataApiResolutionRowReading | DataApiNotARowReading)[] | null;
    };

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  return Object.freeze(value);
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function member(record: OwnWireRecord, key: string): { readonly present: boolean; readonly value: unknown } {
  return Object.hasOwn(record, key) ? { present: true, value: record[key] } : { present: false, value: undefined };
}

function textOf(record: OwnWireRecord, key: string): DataApiFieldReading<string> {
  const field = member(record, key);
  if (!field.present) return { kind: "ABSENT" };
  if (field.value === null) return { kind: "NULL" };
  return typeof field.value === "string" ? { kind: "VALUE", value: field.value } : { kind: "UNREADABLE", detail: kindOf(field.value) };
}

function payoutsOf(record: OwnWireRecord): DataApiFieldReading<readonly DataApiPayoutElement[]> {
  const field = member(record, "payouts");
  if (!field.present) return { kind: "ABSENT" };
  if (field.value === null) return { kind: "NULL" };
  if (!Array.isArray(field.value)) return { kind: "UNREADABLE", detail: kindOf(field.value) };
  return {
    kind: "VALUE",
    value: (field.value as readonly unknown[]).map((element): DataApiPayoutElement => {
      if (typeof element === "number") return { kind: "NUMBER", value: element };
      if (typeof element === "string") return { kind: "STRING", value: element };
      return { kind: "OTHER", detail: kindOf(element) };
    }),
  };
}

function readRow(element: unknown): DataApiResolutionRowReading | DataApiNotARowReading {
  if (!isOwnWireRecord(element)) return { kind: "NOT_A_ROW", detail: `a Resolution row is a JSON object; this element is ${kindOf(element)}` };
  return {
    kind: "ROW",
    conditionId: textOf(element, "condition_id"),
    status: textOf(element, "status"),
    payouts: payoutsOf(element),
    resolvedAt: textOf(element, "resolved_at"),
  };
}

/** Reads one `GET /v2/resolutions` body. TOTAL: never throws. */
export function readDataApiResolutionsBody(bodyUtf8: string): DataApiResolutionsBodyReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyUtf8);
  } catch (error) {
    return freeze({ status: "NOT_JSON", detail: `the body is not JSON (${error instanceof Error ? error.message : "unparsable"})` });
  }
  const read = readOwnWireValue(parsed);
  if (!read.ok) return freeze({ status: "NOT_ENVELOPE", detail: `the body is not plain JSON data: ${read.detail}` });
  if (!isOwnWireRecord(read.value)) {
    return freeze({ status: "NOT_ENVELOPE", detail: `a Data API v2 response is a JSON object wrapping its payload in data (F-65); the body is ${kindOf(read.value)}` });
  }
  const data = member(read.value, "data");
  if (!data.present) return freeze({ status: "NOT_ENVELOPE", detail: "the body has no data member, which every Data API v2 response carries (F-65)" });
  if (data.value === null) return freeze({ status: "ENVELOPE", rows: null });
  if (!Array.isArray(data.value)) {
    return freeze({ status: "NOT_ENVELOPE", detail: `data is ${kindOf(data.value)}, not the documented list of Resolution rows (F-57, F-65)` });
  }
  return freeze({ status: "ENVELOPE", rows: (data.value as readonly unknown[]).map(readRow) });
}
