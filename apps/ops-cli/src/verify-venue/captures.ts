/**
 * V2-9: the gate for the `protocol-v2/` public captures.
 *
 * `VENUE-4` committed public captures of Polymarket Protocol V2 and Data API
 * v2 under `test/fixtures/venue/protocol-v2/` (`docs/venue/verified-2026-10-05.md`
 * §15). They are venue bodies, not the WP-000 envelope, so `fixtures.ts`
 * cannot validate them. This module validates each one against its
 * provenance sidecar `<stem>.provenance.jsonc`:
 *
 * 1. **The sidecar.** Strict JSON with exactly the documented keys; its
 *    `fixture`, `source_id` and `report` name this capture, the catalogue
 *    entry and the check's report; `authenticated` is exactly `false`; the
 *    URL is on an official public host (a CLOB URL on a public market read,
 *    a WebSocket on the market channel), and no Data API URL is keyed by a
 *    wallet. Its route is the route of the URL the report's source index
 *    records for the catalogue's source id; outside the trade and activity
 *    pages, it is that URL (or extends the text before the index's `…`).
 * 2. **The bytes.** Size and sha256 equal `fixture_bytes` and
 *    `fixture_sha256`. A `live-capture` lists no redaction and IS the raw
 *    response; a `live-capture-redacted` lists its redactions and differs
 *    from the raw response; a `documentation-example` names the page lines it
 *    was extracted from.
 * 3. **The report.** The sidecar's `source_id` row in the report's source
 *    index (§14) records the same fetch time, HTTP status, byte count and
 *    sha256. This proves provenance (the bytes are the report's fetch), not
 *    privacy: `scan.ts` scans every file, live captures included.
 * 4. **The parse.** A `.jsonc` capture is one strict JSON document, and a
 *    `.jsonl` capture one record `{t, dir, data}` per line; valid UTF-8, and
 *    no key repeated in one object.
 * 5. **No credential** (the WP-000 credential scan).
 * 6. **Trade and activity pages** (the report's source-index URL is a Data
 *    API feed route), report §15: a closed schema, a labelled synthetic
 *    cursor or none, and redactions that list `timestamp` and `next_cursor`.
 * 7. **The pins.** The venue facts the capture is committed to show, each
 *    citing report ids that the report defines.
 *
 * Offline: local files only. No network, no credential, no order.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { FieldSpec } from "./fixtures.js";
import {
  VENUE_FIXTURE_ROOT,
  isRecord,
  scanForCredentials,
  validateField,
} from "./fixtures.js";

/** A JSON value, as a pin's expected value. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * One venue fact a capture is committed to show, at a path into its parsed
 * view. A path is dotted keys with `[n]` indexes (`markets[0].conditionId`);
 * a `.jsonl` view is the array of its records, each carrying `frame`, the
 * parsed `data` text when that text is JSON (`[2].frame[0].version`).
 *
 * - `equals`: the value deep-equals this JSON value (`null` included);
 * - `absent`: the key is absent;
 * - `spec`: the value meets this field spec (`fixtures.ts` grammar);
 * - `sameAs`: the value deep-equals the value at another path;
 * - `positionIdOf`: the value is a Polymarket Protocol V2 position id whose
 *   condition (`positionId >> 8`, 31 bytes) is the condition id at that path
 *   (31 bytes, or 32 bytes right-padded with a zero final byte) and whose
 *   outcome byte (`positionId & 255`) is `outcomeIndex`
 *   (report F-42, F-43, F-44).
 *
 * `facts` are the report ids the pin illustrates; each must be defined in the
 * report (`reportDefinesId`).
 */
export type CapturePin = {
  readonly path: string;
  readonly facts: readonly string[];
} & (
  | { readonly equals: JsonValue }
  | { readonly absent: true }
  | { readonly spec: FieldSpec }
  | { readonly sameAs: string }
  | { readonly positionIdOf: string; readonly outcomeIndex: 0 | 1 }
);

/** One committed capture and the facts it pins. */
export interface CaptureSpec {
  /** Path relative to `test/fixtures/venue`. */
  readonly fixture: string;
  /** `json`: one strict JSON document; `jsonl`: one JSON record per line. */
  readonly format: "json" | "jsonl";
  /** The report's source-index id the sidecar must carry. */
  readonly sourceId: string;
  readonly pins: readonly CapturePin[];
}

export const CAPTURE_KINDS = ["live-capture", "live-capture-redacted", "documentation-example"] as const;

export type CaptureKind = (typeof CAPTURE_KINDS)[number];

/** The provenance sidecar every capture carries (`protocol-v2/README.md`). */
export interface CaptureSidecar {
  readonly fixture: string;
  readonly kind: CaptureKind;
  readonly source_id: string;
  readonly report: string;
  readonly method: string;
  readonly url: string;
  readonly fetched_utc: string;
  readonly http_status: string;
  readonly raw_bytes: number;
  readonly raw_sha256: string;
  readonly redactions: readonly string[];
  readonly authenticated: false;
  readonly notes: string;
  readonly fixture_bytes: number;
  readonly fixture_sha256: string;
  readonly extract?: {
    readonly lines: readonly number[];
    readonly rule: string;
  };
}

/** The sidecar's key set and types; strict, so an extra key is refused. */
const SIDECAR_SPEC: FieldSpec = {
  type: "object",
  strict: true,
  fields: {
    fixture: { type: "string" },
    kind: { type: "string", enum: CAPTURE_KINDS },
    source_id: { type: "string" },
    report: { type: "string" },
    method: { type: "string", enum: ["GET", "WebSocket session"] },
    url: { type: "string" },
    fetched_utc: { type: "string" },
    http_status: { type: "string" },
    raw_bytes: { type: "integer" },
    raw_sha256: { type: "string" },
    redactions: { type: "array", items: { type: "string" } },
    authenticated: { type: "boolean" },
    notes: { type: "string" },
    fixture_bytes: { type: "integer" },
    fixture_sha256: { type: "string" },
    extract: {
      type: "object",
      optional: true,
      strict: true,
      fields: {
        lines: { type: "array", items: { type: "integer" } },
        rule: { type: "string" },
      },
    },
  },
};

/**
 * The public hosts a capture may come from: the documentation, Gamma, the
 * public CLOB, the Data API and the public market channel
 * (`verified-2026-10-05.md` "Method"). The market channel only: the user
 * channel on the same host is authenticated.
 */
export const CAPTURE_URL_PREFIXES = [
  "https://docs.polymarket.com/",
  "https://gamma-api.polymarket.com/",
  "https://clob.polymarket.com/",
  "https://data-api.polymarket.com/",
  "wss://ws-subscriptions-clob.polymarket.com/ws/market",
] as const;

/**
 * The CLOB host also serves authenticated routes (orders, trades, balances,
 * heartbeats), so a CLOB capture must be one of the public market reads the
 * report observed unauthenticated: F-76 (`/book`, `/tick-size`, `/fee-rate`,
 * `/neg-risk`, `/price`, `/midpoint`, `/markets-by-token`) and O.3
 * (`/clob-markets`). Fail closed: a new public route is added here, with its
 * source, by the package that captures it.
 */
export const CLOB_PUBLIC_PATHS = [
  "/book", "/clob-markets", "/markets-by-token", "/tick-size", "/fee-rate", "/neg-risk", "/price", "/midpoint",
] as const;

/** Query parameters that key a Data API read by an account. */
const WALLET_QUERY_KEYS = ["user", "address", "proxywallet", "wallet"];

/** A key compared without case or separators (`proxy_wallet` = `proxyWallet`). */
export function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The refusals of a sidecar URL's host and route. */
export function captureUrlErrors(url: string): string[] {
  if (!CAPTURE_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return [`sidecar.url: not an official public Polymarket host: ${url}`];
  }
  if (!url.startsWith("https://")) {
    // The market channel: its subscription follows in prose.
    return [];
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return ["sidecar.url: not a parseable URL"];
  }
  const errors: string[] = [];
  if (
    parsed.host === "clob.polymarket.com" &&
    !CLOB_PUBLIC_PATHS.some(
      (path) => parsed.pathname === path || parsed.pathname.startsWith(`${path}/`),
    )
  ) {
    errors.push(`sidecar.url: ${parsed.pathname} is not a public CLOB market read (F-76, O.3)`);
  }
  if (parsed.host === "data-api.polymarket.com") {
    for (const key of parsed.searchParams.keys()) {
      const normalized = normalizedKey(key);
      if (WALLET_QUERY_KEYS.includes(normalized) || normalized.includes("wallet")) {
        errors.push(`sidecar.url: a Data API read keyed by a wallet (${key}=) may not be committed`);
      }
    }
  }
  return errors;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const FETCHED_UTC_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}Z)$/;
const HTTP_STATUS_RE = /^(?:\d{3}|WS)$/;

/** The `.jsonl` record directions (`protocol-v2/README.md`). */
const JSONL_DIRECTIONS = ["open", "send", "recv", "local-close", "close"];

/** `<stem>.jsonc` or `<stem>.jsonl` (or `.json`) → `<stem>.provenance.jsonc`. */
export function sidecarPathOf(fixture: string): string {
  return fixture.replace(/\.(?:jsonc|jsonl|json)$/, ".provenance.jsonc");
}

/**
 * A URL's route: its scheme, host and path, the text before its first `?`,
 * `#`, space or `…`. A report's source-index URL may cut a long query with
 * `…` or follow a WebSocket URL with its subscription in prose.
 */
export function urlRouteOf(url: string): string {
  const end = url.search(/[?# …]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * A sidecar URL's route must be the route of the URL the report's source
 * index records for the catalogue's source id. So the report, not the
 * sidecar, decides whether the capture is a trade or activity page.
 */
export function sourceRouteErrors(url: string, row: SourceIndexRow | undefined): string[] {
  if (row === undefined) {
    return [];
  }
  const expected = urlRouteOf(row.url);
  if (expected.length === 0 || urlRouteOf(url) !== expected) {
    return [
      `sidecar.url: the route (scheme, host and path) must be ${row.id}'s in the report's source index, ${expected}; the sidecar's is ${urlRouteOf(url)}`,
    ];
  }
  return [];
}

/**
 * Outside the trade and activity pages, the sidecar URL is the URL the
 * report's source index records, or extends the text before the index's `…`.
 * So the report vouches for every identifier in it. (A feed page's URL
 * differs from the report's by its redacted cursor, so only its route is
 * bound.)
 */
export function reportUrlErrors(url: string, row: SourceIndexRow | undefined): string[] {
  if (row === undefined) {
    return [];
  }
  const cut = row.url.indexOf("…");
  const bound = cut === -1 ? url === row.url : url.startsWith(row.url.slice(0, cut));
  return bound
    ? []
    : [`sidecar.url: must be ${row.id}'s URL in the report's source index (or extend the text before its …)`];
}

// --- the report -------------------------------------------------------------

/** One row of the report's source index (§14). */
export interface SourceIndexRow {
  readonly id: string;
  /**
   * The URL column, as the report writes it (a long query may be cut by
   * `…`; a WebSocket row adds its subscription in prose). It, not the
   * sidecar's URL, decides whether the capture is a trade or activity page.
   */
  readonly url: string;
  readonly time: string;
  readonly http: string;
  readonly bytes: number;
  readonly sha256: string;
}

const SOURCE_INDEX_ROW_RE =
  /^\| (S-[A-Z]+\d+) \| `([^`]*)` \| (\d{2}:\d{2}:\d{2}Z) \| (\d{3}|WS) \| (\d+) \| `([0-9a-f]{64})` \|/gm;

/**
 * Parses the HTTP and WebSocket rows of a report's source index: `| id |
 * \`url\` | time | HTTP | bytes | \`sha256\` | note |`. An id listed twice
 * with different values is dropped, so it can match no sidecar.
 */
export function parseSourceIndex(
  sectionText: string,
): ReadonlyMap<string, SourceIndexRow> {
  const rows = new Map<string, SourceIndexRow>();
  const conflicting = new Set<string>();
  for (const match of sectionText.matchAll(SOURCE_INDEX_ROW_RE)) {
    const row: SourceIndexRow = {
      id: match[1] as string,
      url: match[2] as string,
      time: match[3] as string,
      http: match[4] as string,
      bytes: Number(match[5]),
      sha256: match[6] as string,
    };
    const earlier = rows.get(row.id);
    if (earlier !== undefined && JSON.stringify(earlier) !== JSON.stringify(row)) {
      conflicting.add(row.id);
    }
    rows.set(row.id, row);
  }
  for (const id of conflicting) {
    rows.delete(id);
  }
  return rows;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether the report DEFINES an id, not merely mentions it:
 * - a fact, conflict, unknown or drift row (`F-62`, `C-21`, `U-38`, `E-21`)
 *   is defined where it is bolded: `**F-62 (OBS)…` or `| **C-21 (new)** |`;
 * - a source (`S-W01`) is defined by its source-index row `| S-W01 |`;
 * - a lettered section (`O.5`) is defined by its heading `### O.5 …`.
 */
export function reportDefinesId(report: string, id: string): boolean {
  const escaped = escapeRegExp(id);
  if (/^[FCUE]-\d+$/.test(id)) {
    return new RegExp(`\\*\\*${escaped}\\b`).test(report);
  }
  if (/^S-[A-Z]+\d+$/.test(id)) {
    return new RegExp(`^\\| ${escaped} \\|`, "m").test(report);
  }
  if (/^[A-Z]\.\d+$/.test(id)) {
    return new RegExp(`^#{2,3} ${escaped}\\.? `, "m").test(report);
  }
  return false;
}

/** `docs/venue/verified-YYYY-MM-DD.md` → `YYYY-MM-DD`. */
export function reportDateOf(reportPath: string): string | null {
  return /verified-(\d{4}-\d{2}-\d{2})\.md$/.exec(reportPath)?.[1] ?? null;
}

// --- synthetic values ----------------------------------------------------------

/**
 * A labelled synthetic hex value: `0x`, then zeros, then at most eight
 * significant hex digits (`0x0000…0101`), at exactly the given width: the
 * parent README's "all-zero or clearly synthetic (`0x0000...`)" form. A real
 * address or hash has 32 or more leading zero hex digits with negligible
 * probability.
 */
export function isLabelledSyntheticHex(value: unknown, hexDigits: number): boolean {
  return (
    typeof value === "string" &&
    value.length === 2 + hexDigits &&
    /^0x0+[0-9a-f]{1,8}$/i.test(value)
  );
}

/**
 * A labelled synthetic text value: `synthetic-` and lowercase slug characters
 * only (`synthetic-name-p1-r1`), so no email, spaced name or base64url cursor
 * fits under the label.
 */
export function isLabelledSyntheticText(value: unknown): boolean {
  return typeof value === "string" && /^synthetic-[a-z0-9-]+$/.test(value);
}

/** The labelled synthetic cursor form the trade captures use. */
export function isLabelledSyntheticCursor(value: unknown): boolean {
  return typeof value === "string" && /^synthetic-cursor-[a-z0-9-]+$/.test(value);
}

/**
 * The field names a redaction entry names before its colon:
 * `"name, pseudonym: replaced …"` → `name`, `pseudonym`;
 * `"pagination.next_cursor (note): …"` → `next_cursor`. An entry with no
 * colon names no field.
 */
export function redactionSubjects(redaction: string): readonly string[] {
  const colon = redaction.indexOf(":");
  if (colon === -1) {
    return [];
  }
  return redaction
    .slice(0, colon)
    .replace(/\([^)]*\)/g, " ")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z_][\w.]*$/.test(part))
    .map((part) => part.slice(part.lastIndexOf(".") + 1));
}

// --- trade and activity pages ---------------------------------------------------

/** The Data API trade and activity feed routes (S-D26 lines 80-82). */
export const FEED_ROUTES = [
  "https://data-api.polymarket.com/v2/trades",
  "https://data-api.polymarket.com/v2/activity",
  "https://data-api.polymarket.com/v2/activity/combos",
] as const;

/**
 * The fields a trade or activity row may carry: S-O06
 * `components.schemas.Trade` and `components.schemas.Activity`. A field
 * outside this list is refused, since it may carry personal data; the
 * package that captures a new field adds it here, with its source. The
 * personal fields' values answer to the person-row rules of `scan.ts`.
 */
export const FEED_ROW_FIELDS: readonly string[] = [
  "bio", "condition_id", "event_slug", "icon", "is_combo", "name", "outcome", "outcome_index",
  "price", "profile_image", "profile_image_optimized", "proxy_wallet", "pseudonym", "side",
  "size", "slug", "timestamp", "title", "token_id", "transaction_hash", "type", "usdc_size",
];

/** S-O06 `Pagination`. */
const PAGINATION_FIELDS = ["limit", "offset", "has_more", "next_cursor"];

const CURSOR_RULE =
  "must be a labelled synthetic value (synthetic-cursor-…): a venue feed cursor carries the seek anchor of the last row (S-O06) and re-fetches the unredacted page";

/**
 * The refusals of a trade or activity page (report §15; plan acceptance 5):
 * - the page is exactly `{data, pagination}`; each row carries only
 *   `FEED_ROW_FIELDS`, and `pagination` only the S-O06 `Pagination` fields;
 * - `next_cursor` is `null` or labelled synthetic, and so is every `cursor`
 *   parameter of the sidecar URL;
 * - a page with a row or a cursor has redactions listing `timestamp` and
 *   `next_cursor`.
 */
export function feedPageErrors(view: unknown, sidecar: CaptureSidecar): string[] {
  const rows = isRecord(view) ? view["data"] : undefined;
  const pagination = isRecord(view) ? view["pagination"] : undefined;
  if (!isRecord(view) || !Array.isArray(rows) || !isRecord(pagination)) {
    return ["$: a trade or activity page is {data: [...], pagination: {...}} (S-O06)"];
  }
  const errors: string[] = [];
  for (const key of Object.keys(view)) {
    if (key !== "data" && key !== "pagination") {
      errors.push(`$.${key}: not a field of a trade or activity page (S-O06: data, pagination)`);
    }
  }
  rows.forEach((row: unknown, index) => {
    const unknown = isRecord(row) ? Object.keys(row).filter((key) => !FEED_ROW_FIELDS.includes(key)) : ["(not an object)"];
    for (const key of unknown) {
      errors.push(`$.data[${index}].${key}: not a Trade or Activity field (S-O06; FEED_ROW_FIELDS)`);
    }
  });
  for (const key of Object.keys(pagination)) {
    if (!PAGINATION_FIELDS.includes(key)) {
      errors.push(`$.pagination.${key}: not a Pagination field (S-O06: ${PAGINATION_FIELDS.join(", ")})`);
    }
  }
  const cursor = pagination["next_cursor"];
  if (cursor !== null && cursor !== undefined && !isLabelledSyntheticCursor(cursor)) {
    errors.push(`$.pagination.next_cursor: ${CURSOR_RULE}`);
  }
  const query = sidecar.url.indexOf("?");
  for (const value of new URLSearchParams(query === -1 ? "" : sidecar.url.slice(query)).getAll("cursor")) {
    if (!isLabelledSyntheticCursor(value)) {
      errors.push(`sidecar.url cursor: ${CURSOR_RULE}`);
    }
  }
  if (rows.length > 0 || typeof cursor === "string") {
    const subjects = new Set(sidecar.redactions.flatMap(redactionSubjects));
    for (const required of ["timestamp", "next_cursor"]) {
      if (!subjects.has(required)) {
        errors.push(`sidecar redactions: a trade or activity page with rows or a cursor must list ${required} (report §15)`);
      }
    }
  }
  return errors;
}

// --- pins ---------------------------------------------------------------------

type PathSegment = string | number;

function parsePath(path: string): readonly PathSegment[] {
  return [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((match) =>
    match[1] !== undefined ? match[1] : Number(match[2]),
  );
}

/** Resolves a pin path; `found` is false when any step is missing. */
export function resolvePath(
  root: unknown,
  path: string,
): { readonly found: boolean; readonly value: unknown } {
  let current: unknown = root;
  for (const segment of parsePath(path)) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[segment] as unknown;
    } else {
      if (!isRecord(current) || !Object.hasOwn(current, segment)) {
        return { found: false, value: undefined };
      }
      current = current[segment];
    }
  }
  return { found: true, value: current };
}

/** Deep equality of parsed JSON values (object key order ignored). */
export function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((entry, index) => jsonEqual(entry, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
    );
  }
  return false;
}

/**
 * The condition and outcome a Polymarket Protocol V2 position id encodes:
 * `conditionId = encodeBytes31(positionId >> 8)`, `outcomeIndex = positionId
 * & 255` (S-D12 lines 659-665; F-42). `null` for a non-decimal id.
 */
export function decodePositionId(
  positionId: unknown,
): { readonly conditionBytes31: string; readonly outcomeIndex: number } | null {
  if (typeof positionId !== "string" || !/^\d+$/.test(positionId)) {
    return null;
  }
  const id = BigInt(positionId);
  if (id >= 1n << 256n) {
    return null;
  }
  return {
    conditionBytes31: `0x${(id >> 8n).toString(16).padStart(62, "0")}`,
    outcomeIndex: Number(id & 255n),
  };
}

/**
 * A V2 condition id narrowed to `bytes31`: the 62-hex form as is, or the
 * 64-hex (`bytes32`) form whose final byte is zero (S-D04 line 54: "For a
 * padded V2 `bytes32` value, validate its final byte is zero before
 * narrowing"). `null` for anything else.
 */
export function narrowConditionId(conditionId: unknown): string | null {
  if (typeof conditionId !== "string" || !/^0x[0-9a-fA-F]+$/.test(conditionId)) {
    return null;
  }
  const lower = conditionId.toLowerCase();
  if (lower.length === 64) {
    return lower;
  }
  if (lower.length === 66 && lower.endsWith("00")) {
    return lower.slice(0, 64);
  }
  return null;
}

function pinErrors(view: unknown, pin: CapturePin): string[] {
  const { found, value } = resolvePath(view, pin.path);
  const where = `pin ${pin.path} (${pin.facts.join(", ")})`;
  if ("absent" in pin) {
    return found ? [`${where}: the key must be absent`] : [];
  }
  if (!found) {
    return [`${where}: missing`];
  }
  if ("equals" in pin) {
    return jsonEqual(value, pin.equals)
      ? []
      : [`${where}: expected ${JSON.stringify(pin.equals)}, got ${JSON.stringify(value)}`];
  }
  if ("spec" in pin) {
    const errors: string[] = [];
    validateField(value, pin.spec, where, errors);
    return errors;
  }
  if ("sameAs" in pin) {
    const other = resolvePath(view, pin.sameAs);
    return other.found && jsonEqual(value, other.value)
      ? []
      : [`${where}: must equal the value at ${pin.sameAs}`];
  }
  const decoded = decodePositionId(value);
  const condition = narrowConditionId(resolvePath(view, pin.positionIdOf).value);
  if (decoded === null || condition === null) {
    return [`${where}: needs a decimal position id and a 31-byte (or zero-padded 32-byte) condition id at ${pin.positionIdOf}`];
  }
  const errors: string[] = [];
  if (decoded.conditionBytes31 !== condition) {
    errors.push(`${where}: positionId >> 8 is ${decoded.conditionBytes31}, not the condition ${condition} at ${pin.positionIdOf}`);
  }
  if (decoded.outcomeIndex !== pin.outcomeIndex) {
    errors.push(`${where}: positionId & 255 is ${decoded.outcomeIndex}, not outcome ${pin.outcomeIndex}`);
  }
  return errors;
}

/** Every pin's refusals against a capture's parsed view. */
export function evaluatePins(
  view: unknown,
  pins: readonly CapturePin[],
): string[] {
  return pins.flatMap((pin) => pinErrors(view, pin));
}

// --- one capture ----------------------------------------------------------------

export interface CaptureContext {
  /** The report the sidecar must name (the check's report). */
  readonly report: string;
  /** That report's text, or `null` when it cannot be read. */
  readonly reportContent: string | null;
  /** Its source index (§14), parsed. */
  readonly sourceIndex: ReadonlyMap<string, SourceIndexRow>;
}

export interface CaptureValidationResult {
  readonly relativePath: string;
  readonly sidecarPath: string;
  readonly ok: boolean;
  readonly errors: readonly string[];
  /** The parsed view the pins read (`null` when the capture did not parse). */
  readonly view: unknown;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The keys that occur twice in one object of a JSON text (which must already
 * parse). `JSON.parse` keeps only the last value of a repeated key, so an
 * earlier one would sit in the committed bytes and escape every check of the
 * parsed view. RFC 8259 §4: the names within an object SHOULD be unique.
 */
export function duplicateKeys(jsonText: string): string[] {
  const objects: (Set<string> | null)[] = [];
  const duplicates: string[] = [];
  let index = 0;
  while (index < jsonText.length) {
    const char = jsonText[index];
    if (char === '"') {
      let end = index + 1;
      while (end < jsonText.length && jsonText[end] !== '"') {
        end += jsonText[end] === "\\" ? 2 : 1;
      }
      const literal = jsonText.slice(index, end + 1);
      index = end + 1;
      let next = index;
      while (next < jsonText.length && /\s/.test(jsonText[next] ?? "")) {
        next += 1;
      }
      const keys = objects.at(-1);
      if (jsonText[next] === ":" && keys !== undefined && keys !== null) {
        const key = JSON.parse(literal) as string;
        if (keys.has(key)) {
          duplicates.push(key);
        } else {
          keys.add(key);
        }
      }
      continue;
    }
    if (char === "{") {
      objects.push(new Set());
    } else if (char === "[") {
      objects.push(null);
    } else if (char === "}" || char === "]") {
      objects.pop();
    }
    index += 1;
  }
  return duplicates;
}

/** The refusal of a repeated key. */
export function duplicateKeyError(where: string, key: string): string {
  return `${where}: the key ${JSON.stringify(key)} occurs twice in one object; JSON.parse keeps only the last value, so an earlier one would escape every check`;
}

/**
 * Parses a capture's bytes into the view its pins read: the JSON document,
 * or the array of `.jsonl` records, each with `frame` when its `data` text is
 * JSON. Every parse uses `JSON.parse`, so a comment or a trailing comma is
 * refused.
 */
export function parseCapture(
  bytes: Uint8Array,
  format: CaptureSpec["format"],
  errors: string[],
): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    errors.push("the capture is not valid UTF-8");
    return null;
  }
  const refuseDuplicates = (jsonText: string, where: string): void => {
    errors.push(...duplicateKeys(jsonText).map((key) => duplicateKeyError(where, key)));
  };
  if (format === "json") {
    let document: unknown;
    try {
      document = JSON.parse(text) as unknown;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`the capture is not one strict JSON document (no comment, no trailing comma): ${message}`);
      return null;
    }
    refuseDuplicates(text, "the capture");
    return document;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const records: unknown[] = [];
  lines.forEach((line, index) => {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      errors.push(`line ${index + 1}: not one strict JSON record`);
      return;
    }
    refuseDuplicates(line, `line ${index + 1}`);
    validateField(
      record,
      {
        type: "object",
        strict: true,
        fields: {
          t: { type: "string" },
          dir: { type: "string", enum: JSONL_DIRECTIONS },
          data: { type: "union", oneOf: [{ type: "string" }, { type: "object", values: { type: "unknown" } }] },
        },
      },
      `line ${index + 1}`,
      errors,
    );
    if (!isRecord(record)) {
      return;
    }
    const data = record["data"];
    let frame: unknown;
    if (typeof data === "string") {
      try {
        frame = JSON.parse(data);
      } catch {
        // A control message (`PING`, `PONG`, the open record's URL): text.
      }
      if (frame !== undefined) {
        refuseDuplicates(data, `line ${index + 1} frame`);
      }
    }
    records.push(frame === undefined ? { ...record } : { ...record, frame });
  });
  return records;
}

/**
 * Validates one capture, given its bytes and its sidecar's text. Pure: the
 * mutant tests call it with altered bytes or sidecars.
 */
export function validateCapture(
  spec: CaptureSpec,
  fixtureBytes: Uint8Array,
  sidecarText: string,
  context: CaptureContext,
): CaptureValidationResult {
  const errors: string[] = [];
  const sidecarPath = sidecarPathOf(spec.fixture);
  const result = (view: unknown): CaptureValidationResult => ({
    relativePath: spec.fixture,
    sidecarPath,
    ok: errors.length === 0,
    errors,
    view,
  });

  if ((spec.format === "jsonl") !== spec.fixture.endsWith(".jsonl")) {
    errors.push(`format ${spec.format} does not match the file suffix`);
  }

  // 1. The sidecar.
  let rawSidecar: unknown;
  try {
    rawSidecar = JSON.parse(sidecarText);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${sidecarPath}: the sidecar is not strict JSON: ${message}`);
    return result(null);
  }
  const sidecarErrors = duplicateKeys(sidecarText).map((key) => duplicateKeyError(sidecarPath, key));
  validateField(rawSidecar, SIDECAR_SPEC, "sidecar", sidecarErrors);
  if (sidecarErrors.length > 0) {
    errors.push(...sidecarErrors);
    return result(null);
  }
  const sidecar = rawSidecar as CaptureSidecar;
  if (sidecar.fixture !== spec.fixture) {
    errors.push(`sidecar.fixture: expected ${JSON.stringify(spec.fixture)}, got ${JSON.stringify(sidecar.fixture)}`);
  }
  if (sidecar.source_id !== spec.sourceId) {
    errors.push(`sidecar.source_id: expected ${spec.sourceId}, got ${sidecar.source_id}`);
  }
  if (sidecar.report !== context.report) {
    errors.push(`sidecar.report: expected ${context.report}, got ${sidecar.report}`);
  }
  if ((sidecar.authenticated as boolean) !== false) {
    errors.push("sidecar.authenticated: must be exactly false (public, unauthenticated reads only)");
  }
  errors.push(...captureUrlErrors(sidecar.url));
  // The catalogue's source id, not the sidecar's, names the report row whose
  // URL binds the route and selects the trade-page rules.
  const reportRow = context.sourceIndex.get(spec.sourceId);
  errors.push(...sourceRouteErrors(sidecar.url, reportRow));
  if (!SHA256_RE.test(sidecar.raw_sha256) || !SHA256_RE.test(sidecar.fixture_sha256)) {
    errors.push("sidecar: raw_sha256 and fixture_sha256 must be 64 lowercase hex digits");
  }
  if (!HTTP_STATUS_RE.test(sidecar.http_status)) {
    errors.push(`sidecar.http_status: expected a 3-digit status or WS, got ${sidecar.http_status}`);
  }
  const fetched = FETCHED_UTC_RE.exec(sidecar.fetched_utc);
  if (fetched === null) {
    errors.push(`sidecar.fetched_utc: expected YYYY-MM-DDTHH:MM:SSZ, got ${sidecar.fetched_utc}`);
  }

  // 2. The kind and the bytes.
  const isRaw =
    sidecar.fixture_sha256 === sidecar.raw_sha256 &&
    sidecar.fixture_bytes === sidecar.raw_bytes;
  switch (sidecar.kind) {
    case "live-capture":
      if (sidecar.redactions.length > 0 || !isRaw || sidecar.extract !== undefined) {
        errors.push("sidecar.kind live-capture: no redaction, no extract, and fixture bytes and sha256 equal to the raw response");
      }
      break;
    case "live-capture-redacted":
      if (sidecar.redactions.length === 0 || isRaw) {
        errors.push("sidecar.kind live-capture-redacted: must list its redactions and differ from the raw response");
      }
      break;
    case "documentation-example": {
      const lines = sidecar.extract?.lines ?? [];
      const [first, last] = lines;
      if (
        !sidecar.url.startsWith("https://docs.polymarket.com/") ||
        lines.length !== 2 ||
        first === undefined ||
        last === undefined ||
        first < 1 ||
        first > last ||
        sidecar.extract?.rule === undefined ||
        sidecar.extract.rule.length === 0
      ) {
        errors.push("sidecar.kind documentation-example: a docs.polymarket.com page, with extract.lines [first, last] and extract.rule");
      }
      break;
    }
  }
  if (fixtureBytes.length !== sidecar.fixture_bytes) {
    errors.push(`bytes: the capture is ${fixtureBytes.length} bytes, the sidecar records ${sidecar.fixture_bytes}`);
  }
  const digest = sha256Hex(fixtureBytes);
  if (digest !== sidecar.fixture_sha256) {
    errors.push(`bytes: the capture's sha256 is ${digest}, the sidecar records ${sidecar.fixture_sha256}`);
  }

  // 3. The report's source index.
  const row = context.sourceIndex.get(sidecar.source_id);
  const reportDate = reportDateOf(context.report);
  if (row === undefined) {
    errors.push(`report: ${sidecar.source_id} has no row in ${context.report}'s source index`);
  } else {
    if (fetched === null || fetched[1] !== reportDate || fetched[2] !== row.time) {
      errors.push(`report: ${sidecar.source_id} was fetched ${reportDate ?? "?"}T${row.time} per the source index, the sidecar says ${sidecar.fetched_utc}`);
    }
    if (row.http !== sidecar.http_status) {
      errors.push(`report: ${sidecar.source_id} has HTTP ${row.http} in the source index, the sidecar says ${sidecar.http_status}`);
    }
    if (row.bytes !== sidecar.raw_bytes || row.sha256 !== sidecar.raw_sha256) {
      errors.push(`report: ${sidecar.source_id} is ${row.bytes} bytes, sha256 ${row.sha256} in the source index; the sidecar's raw response differs`);
    }
  }

  // 4. The parse.
  const parseErrors: string[] = [];
  const view = parseCapture(fixtureBytes, spec.format, parseErrors);
  errors.push(...parseErrors);
  if (parseErrors.length > 0) {
    return result(null);
  }

  // 5. No credential. (Personal data: `scan.ts`, over every file.)
  scanForCredentials(view, "$", errors);

  // 6. Trade and activity pages, as the report's row selects them; any other
  //    capture keeps the report's URL.
  const feed = reportRow !== undefined && (FEED_ROUTES as readonly string[]).includes(urlRouteOf(reportRow.url));
  errors.push(...(feed ? feedPageErrors(view, sidecar) : reportUrlErrors(sidecar.url, reportRow)));

  // 7. The pins, and the ids they cite.
  if (spec.pins.length === 0) {
    errors.push("catalogue: a capture must pin at least one venue fact");
  }
  errors.push(...evaluatePins(view, spec.pins));
  if (context.reportContent === null) {
    errors.push(`report: ${context.report} is unavailable, so the pinned ids cannot be checked`);
  } else {
    const ids = new Set(spec.pins.flatMap((pin) => pin.facts));
    ids.add(spec.sourceId);
    for (const id of ids) {
      if (!reportDefinesId(context.reportContent, id)) {
        errors.push(`report: ${id} is not defined in ${context.report}`);
      }
    }
  }
  return result(view);
}

/**
 * Reads one capture and its sidecar from the fixture tree and validates them.
 * Rejects a path that escapes the tree.
 */
export function loadCapture(
  spec: CaptureSpec,
  context: CaptureContext,
  root: string = VENUE_FIXTURE_ROOT,
): CaptureValidationResult {
  const sidecarPath = sidecarPathOf(spec.fixture);
  const failed = (message: string): CaptureValidationResult => ({
    relativePath: spec.fixture,
    sidecarPath,
    ok: false,
    errors: [message],
    view: null,
  });
  for (const path of [spec.fixture, sidecarPath]) {
    const rel = relative(root, resolve(root, path));
    if (rel.startsWith("..") || rel.includes("..")) {
      return failed(`${path}: path escapes the venue fixture root (traversal rejected)`);
    }
  }
  let bytes: Uint8Array;
  let sidecarText: string;
  try {
    bytes = readFileSync(resolve(root, spec.fixture));
    sidecarText = readFileSync(resolve(root, sidecarPath), "utf8");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(`failed to read the capture or its sidecar: ${message}`);
  }
  return validateCapture(spec, bytes, sidecarText, context);
}
