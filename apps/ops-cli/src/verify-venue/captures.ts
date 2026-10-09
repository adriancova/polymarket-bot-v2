/**
 * V2-9: the gate for the `protocol-v2/` public captures.
 *
 * `VENUE-4` committed sanitized public captures of Polymarket Protocol V2 and
 * Data API v2 under `test/fixtures/venue/protocol-v2/`
 * (`docs/venue/verified-2026-10-05.md` §15). They are venue bodies, not the
 * WP-000 envelope `{fixture, source, retrieved, sanitized, notes, examples}`,
 * so `fixtures.ts` cannot validate them. Until V2-9 nothing did: they used the
 * `.jsonc` and `.jsonl` suffixes to stay outside the `.json`-only file claim
 * (migration plan row D9; `CLOSEOUT-3` L11). This module validates each one
 * against its provenance sidecar `<stem>.provenance.jsonc`:
 *
 * 1. **The sidecar.** Strict JSON with exactly the documented keys; its
 *    `fixture`, `source_id` and `report` name this capture, the catalogue
 *    entry and the check's report; `authenticated` is exactly `false`; the
 *    URL is on an official public host (a CLOB URL on a public market read,
 *    a WebSocket on the market channel), and no Data API URL is keyed by a
 *    wallet. An `https` URL is in canonical form, with no percent-encoding
 *    in its path, and its route (scheme, host, path) is the route of the
 *    URL the report's source index records for the catalogue's source id
 *    (round 4).
 * 2. **The bytes.** Size and sha256 equal `fixture_bytes` and
 *    `fixture_sha256`. A `live-capture` lists no redaction and IS the raw
 *    response (`fixture_*` equal `raw_*`); a `live-capture-redacted` lists its
 *    redactions and differs from the raw response; a `documentation-example`
 *    names the page lines it was extracted from.
 * 3. **The report.** The sidecar's `source_id` row in the report's source
 *    index (§14) records the same fetch date and time, HTTP status, byte count
 *    and sha256. So a committed capture cannot drift from the report that
 *    cites it.
 * 4. **The parse.** A `.jsonc` capture is ONE strict RFC 8259 JSON document
 *    (`JSON.parse`, which refuses comments and trailing commas), and a
 *    `.jsonl` capture is one strict JSON record `{t, dir, data}` per line.
 *    The text must be valid UTF-8. No object of a capture, a frame or a
 *    sidecar repeats a key (round 1): `JSON.parse` would keep only the last
 *    value, and an earlier one would escape every check below.
 * 5. **No credential and no unlabelled personal data**, in any capture or
 *    sidecar (the policy is set out at "personal data" below): the WP-000
 *    credential scan; the personal keys (any `…wallet…` key, `pseudonym`,
 *    `bio`, `profile_image…`, any `…email…` key, a user name or handle)
 *    carry labelled synthetic values; no email address and no unlabelled
 *    `0x` 40-hex address in any capture value or sidecar text; a person's
 *    row (a feed row, or an object with a personal key) carries a labelled
 *    synthetic name and transaction hash; and sidecar text writes no
 *    personal field with a live value and no unlabelled long id that the
 *    capture or URL does not carry.
 * 6. **Trade and activity feeds** (the report's source-index URL is Data
 *    API `/v2/trades` or `/v2/activity…`, the sidecar URL reads as one under
 *    any spelling, or the `data` rows carry a wallet; round 4: the
 *    sidecar's spelling cannot opt out), report §15:
 *    - a cursor (the page's `next_cursor`, or any cursor parameter of the
 *      sidecar URL, every occurrence) that decodes to a venue feed cursor is
 *      refused, because a feed cursor carries the seek anchor of the last
 *      row (S-O06) and re-fetches the unredacted page; any other cursor must
 *      be a labelled synthetic value; the URL carries at most one cursor, and
 *      no other URL part, row value or sidecar prose token may hide one: a
 *      plain JSON object, or an encoded run however it is glued, assigned
 *      (`cursor=…`) or escaped (round 2, `cursorLikeTokens`);
 *    - the sidecar URL is exactly a feed route on the Data API host, with no
 *      fragment, in canonical form, and each query parameter is one S-O06
 *      documents, holding a value of its documented type; a `condition` is
 *      one the report read as a market, a row's `condition_id`, or labelled
 *      synthetic (round 2, `FEED_PARAMETER_TYPES`);
 *    - the page carries only the S-O06 fields (`data`, `pagination`; the
 *      `Trade` and `Activity` row fields, flat; the `Pagination` fields), so
 *      an unrecognized field is refused;
 *    - each row is a person's row, so its wallet, pseudonym, profile
 *      fields, name and transaction hash must be labelled synthetic values
 *      (rule 5);
 *    - a page that carries a row or a cursor must have a sidecar whose
 *      redactions list `timestamp` and `next_cursor`.
 * 7. **The pins.** The venue facts the capture is committed to show (a
 *    `"version":"v2"` key, a 404, a derivation from a position id), each
 *    citing the report ids it illustrates. Every cited id must be defined in
 *    the report.
 * 8. **Fail closed** (round 5, V2-9-R5-01): what the scanner cannot parse,
 *    decode or read fails the gate with a named reason, never a fallback to
 *    the raw text and never a skip: percent-encoding that is malformed or
 *    nested deeper than `MAX_PERCENT_LAYERS` in sidecar text or in any text
 *    a cursor scan reads (`textReadings`); an unparseable URL; a fragment or
 *    credential in an `https` sidecar URL; a query parameter the gate does
 *    not know for its route (`SIDECAR_QUERY_PARAMETERS`); a wallet key that
 *    holds neither an address string nor `null`; a `.jsonl` data text that
 *    is neither JSON nor a known control message; and a sidecar that is not
 *    UTF-8.
 * 9. **Outside the feeds, and in fixture envelopes** (round 6): a capture
 *    that is not a trade or activity page keeps the URL its report's source
 *    index records (or extends the text before the index's `…`), each query
 *    value has its listed type (`nonFeedUrlErrors`), and no sidecar text or
 *    capture string hides a venue cursor that is not a public market cursor
 *    classified for its route (`PUBLIC_MARKET_CURSORS`,
 *    `venueCursorAnchorErrors`; V2-9-R6-02). Every WP-000 fixture envelope
 *    answers to the personal-data, cursor and long-id scan
 *    (`fixturePersonalDataErrors`, wired by `index.ts`; V2-9-R6-01).
 * 10. **One walk over every file** (round 7, V2-9-R7-01..03): the rules
 *    above name fields; `tree-scan.ts` also reads every file of the tree
 *    strictly and runs the token rules below (`emailTokens`,
 *    `unlabelledAddressTokens`, `hashTokens`, `venueCursorTokens`,
 *    `personalAssignmentTokens`, `personalKeyFindings`) on every key and
 *    string at any depth, with the explicit allowlist `scan-allowlist.ts`
 *    as the only exception.
 *
 * Offline: local files only. No network, no credential, no order.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { FieldSpec, FixtureFile } from "./fixtures.js";
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

export const CAPTURE_KINDS = [
  "live-capture",
  "live-capture-redacted",
  "documentation-example",
] as const;

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
  "/book",
  "/clob-markets",
  "/markets-by-token",
  "/tick-size",
  "/fee-rate",
  "/neg-risk",
  "/price",
  "/midpoint",
] as const;

/**
 * The refusals of a sidecar URL's host and route. Round 4: an `https` URL is
 * also written in its one canonical spelling (the WHATWG serialization,
 * `new URL(url).href`, is the URL itself: no `:443`, no `.` or `..` segment,
 * no capitalized or percent-encoded host) with no percent-encoding in its
 * path, so `/v2/%74rades` cannot stand for `/v2/trades`.
 *
 * Round 5, fail closed: every URL must parse, the market channel's
 * included; an `https` URL carries no fragment and no credential, which the
 * scanner does not interpret; and each query parameter is one
 * `SIDECAR_QUERY_PARAMETERS` lists for the URL's route, so a parameter the
 * gate does not know, or a query on a route it lists none for, is refused.
 */
export function captureUrlErrors(url: string): string[] {
  if (!CAPTURE_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return [`sidecar.url: not an official public Polymarket host: ${url}`];
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [UNPARSEABLE_URL_ERROR];
  }
  if (!url.startsWith("https://")) {
    // The market channel: its route is bound to the report's
    // (`sourceRouteErrors`), and its subscription follows in prose.
    return [];
  }
  const errors: string[] = [];
  if (parsed.href !== url || parsed.pathname.includes("%")) {
    errors.push(
      `sidecar.url: not in canonical form (the URL is its own WHATWG serialization, with no percent-encoding in the path): ${url}`,
    );
  }
  if (parsed.hash !== "" || url.includes("#") || parsed.username !== "" || parsed.password !== "") {
    errors.push(
      "sidecar.url: a fragment or a credential, which the scanner does not interpret, so the gate fails closed (round 5)",
    );
  }
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
  errors.push(...queryParameterErrors(parsed));
  return errors;
}

/** The refusal of a sidecar URL that does not parse (round 5: named, never skipped). */
export const UNPARSEABLE_URL_ERROR =
  "sidecar.url: not a parseable URL, so the scanner cannot read it and the gate fails closed";

/**
 * The query parameters the gate knows, by route (`origin` and path), round 5.
 * Fail closed: a parameter not listed for its route, or a query on a route
 * not listed, is refused, because the scanner does not know what it holds.
 * The package that commits a capture with a new parameter lists it here,
 * with its source. Sources: the URLs the report's source index (§14)
 * records, and the committed sidecars of VENUE-4 (`limit` and the
 * `prices_history` `cursor` of S-A02 and S-A03, which the index cuts at
 * `…`). The trade and activity feed routes are not listed: a URL on one is
 * always a feed (`readsAsFeedRoute`), and `feedUrlErrors` refuses every
 * parameter S-O06 does not document for them (`FEED_QUERY_PARAMETERS`).
 */
export const SIDECAR_QUERY_PARAMETERS: readonly {
  readonly route: RegExp;
  readonly parameters: readonly string[];
}[] = [
  { route: /^https:\/\/clob\.polymarket\.com\/book$/, parameters: ["token_id"] },
  {
    route: /^https:\/\/data-api\.polymarket\.com\/v2\/(?:oi|resolutions)$/,
    parameters: ["condition"],
  },
  {
    route: /^https:\/\/data-api\.polymarket\.com\/v2\/prices-history$/,
    parameters: ["token_id", "interval", "bucket_seconds", "limit", "cursor"],
  },
  {
    route: /^https:\/\/gamma-api\.polymarket\.com\/events\/keyset$/,
    parameters: ["series_id", "closed", "limit"],
  },
];

/**
 * The value type of each parameter `SIDECAR_QUERY_PARAMETERS` lists (round
 * 6, V2-9-R6-02), so that no value of another shape, a transaction hash for
 * example, rides on a known parameter of a capture that is not a feed. These
 * are the shapes the gate admits, taken from the committed values and the
 * report's source-index URLs; they claim no venue rule. Fail closed: a
 * value of another shape is refused until its package widens the type, with
 * its source. A market id must also be one the report read
 * (`nonFeedUrlErrors`).
 */
export const SIDECAR_PARAMETER_TYPES: Readonly<
  Record<string, { readonly accepts: (value: string, route: string) => boolean; readonly description: string }>
> = {
  token_id: { accepts: (value) => TOKEN_ID_RE.test(value), description: "a decimal token id" },
  condition: {
    accepts: (value) => CONDITION_ID_RE.test(value),
    description: "a condition id (0x and 62 or 64 lowercase hex digits)",
  },
  interval: {
    accepts: (value) => /^[1-9][0-9]{0,2}[mhdw]$/.test(value),
    description: "a short duration (1 to 3 digits and m, h, d or w)",
  },
  bucket_seconds: { accepts: (value) => /^[1-9][0-9]{0,6}$/.test(value), description: "a positive integer of at most 7 digits" },
  limit: { accepts: (value) => /^(?:0|[1-9][0-9]{0,3})$/.test(value), description: "an integer of at most 4 digits" },
  series_id: { accepts: (value) => /^[1-9][0-9]{0,18}$/.test(value), description: "a decimal series id of at most 19 digits" },
  closed: { accepts: (value) => value === "true" || value === "false", description: "true or false" },
  cursor: {
    accepts: (value, route) => {
      const type = venueCursorType(decodeFeedCursor(value));
      return type !== undefined && isClassifiedMarketCursor(type, route);
    },
    description: "a public market cursor classified for the route (PUBLIC_MARKET_CURSORS)",
  },
};

/**
 * The URL refusals of a capture that is not a trade or activity page (round
 * 6, V2-9-R6-02). The report, not the sidecar, vouches for the URL's
 * identifiers:
 *
 * - the sidecar URL is the URL the report's source index records for the
 *   catalogue source id, character for character; or, when the index cuts
 *   that URL with `…`, it extends the text before the `…`;
 * - each query value of an `https` URL has the type its parameter is listed
 *   with (`SIDECAR_PARAMETER_TYPES`), and, but for a classified market
 *   cursor, carries no hash-shaped run that is not a market id the report
 *   read (`unexplainedHashRuns`).
 *
 * So a transaction hash, a wallet or a feed cursor cannot replace a token id,
 * a condition or a path id, nor ride on the part of the URL the report cuts.
 */
export function nonFeedUrlErrors(
  url: string,
  row: SourceIndexRow | undefined,
  ids: FeedMarketIds = NO_MARKET_IDS,
): string[] {
  const errors: string[] = [];
  if (row !== undefined) {
    const cut = row.url.indexOf("…");
    const bound = cut === -1 ? url === row.url : url.startsWith(row.url.slice(0, cut));
    if (!bound) {
      errors.push(
        `sidecar.url: must be ${row.id}'s URL in the report's source index${cut === -1 ? "" : " (or extend the text before its …)"}, so that the report vouches for every identifier in it (round 6)`,
      );
    }
  }
  if (!url.startsWith("https://")) {
    return errors;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // `captureUrlErrors` names the failure.
    return errors;
  }
  const route = urlRouteOf(url);
  for (const [key, value] of parsed.searchParams) {
    const type = Object.hasOwn(SIDECAR_PARAMETER_TYPES, key) ? SIDECAR_PARAMETER_TYPES[key] : undefined;
    if (type === undefined) {
      // `queryParameterErrors` refuses an unknown parameter.
      continue;
    }
    if (!type.accepts(value, route)) {
      errors.push(
        `sidecar url ${key}: the value is not ${type.description}, so the gate cannot judge it and fails closed (round 6)`,
      );
    } else if (key !== "cursor" && unexplainedHashRuns(value, ids).length > 0) {
      errors.push(
        `sidecar url ${key}: the value carries a hash-shaped run that is not a market id the report read (round 6)`,
      );
    }
  }
  return errors;
}

/** Round 5: each query parameter of an `https` URL is one its route lists. */
function queryParameterErrors(parsed: URL): string[] {
  const keys = [...new Set(parsed.searchParams.keys())];
  if (keys.length === 0 && parsed.search === "") {
    return [];
  }
  const route = `${parsed.origin}${parsed.pathname}`;
  if (FEED_ROUTE_RE.test(`${route}?`) && FEED_URL_PATHS.includes(parsed.pathname)) {
    // `feedUrlErrors` judges each parameter of a feed route.
    return [];
  }
  const known = SIDECAR_QUERY_PARAMETERS.find((entry) => entry.route.test(route));
  if (known === undefined) {
    return [
      `sidecar.url: the gate knows no query parameter of ${route} (SIDECAR_QUERY_PARAMETERS), so it cannot judge the query and fails closed (round 5)`,
    ];
  }
  return keys
    .filter((key) => !known.parameters.includes(key))
    .map(
      (key) =>
        `sidecar url ${key}: not a query parameter the gate knows for ${route} (SIDECAR_QUERY_PARAMETERS), so it fails closed (round 5)`,
    );
}

/** Query parameters that key a Data API read by an account. */
const WALLET_QUERY_KEYS = ["user", "address", "proxywallet", "wallet"];

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
 * `#`, space or `…` (round 4). A report's source-index URL may cut a long
 * query with `…` or follow a WebSocket URL with its subscription in prose;
 * its route is still whole.
 */
export function urlRouteOf(url: string): string {
  const end = url.search(/[?# \u2026]/);
  return end === -1 ? url : url.slice(0, end);
}

/**
 * Round 4: a sidecar URL's route must be the route of the URL the report's
 * source index records for the catalogue's source id. The sidecar may
 * redact or replace a query value (a feed cursor, for example), but not
 * respell the route: so the report, not the sidecar, decides which rules
 * the capture answers to (`isFeedCapture`).
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

// --- the report -------------------------------------------------------------

/** One row of the report's source index (§14). */
export interface SourceIndexRow {
  readonly id: string;
  /**
   * The URL column, as the report writes it (a long query may be cut by
   * `…`; a WebSocket row adds its subscription in prose). Round 4: a
   * sidecar URL's route must equal this URL's route (`urlRouteOf`), and
   * this URL, not the sidecar's, decides whether the capture is a feed.
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

/** A source-index row's id and URL (the second column). */
const SOURCE_INDEX_URL_RE = /^\| (S-[A-Z]+\d+) \| `([^`]*)` \|/gm;

/**
 * The condition ids the report's source index (§14) read as a market: every
 * `0x` 62- or 64-hex token in the URL of a row that is not a trade or
 * activity feed read (`/clob-markets/<id>`, `/v2/resolutions?condition=`,
 * `/v2/oi?condition=`, Gamma `condition_ids=`). A feed URL's `condition`
 * value and a feed row's `condition_id` must be one of these or a labelled
 * synthetic value (V2-9 rounds 2 and 3; a feed row no longer corroborates
 * itself): so a hash of another kind, a transaction hash for example, cannot
 * pose as a condition. Lowercased.
 */
export function marketReadConditionIds(sectionText: string): readonly string[] {
  const ids = new Set<string>();
  for (const match of sectionText.matchAll(SOURCE_INDEX_URL_RE)) {
    const url = match[2] ?? "";
    if (FEED_ROUTE_RE.test(url)) {
      continue;
    }
    for (const [token] of url.matchAll(/(?<![0-9A-Za-z_])0x[0-9a-fA-F]{62}(?:[0-9a-fA-F]{2})?(?![0-9a-fA-F])/g)) {
      ids.add(token.toLowerCase());
    }
  }
  return [...ids];
}

/**
 * The token ids the report's source index (§14) read as a market: every
 * whole decimal `token_id=` value in the URL of a row that is not a trade or
 * activity feed read (`/book?token_id=`, `/v2/prices-history?token_id=`). A
 * value the index truncates (`…`) is not taken. With the tokens of the
 * report's CLOB market reads (`catalogueTokenIds`), a feed row's `token_id`
 * must be one of these or labelled synthetic (V2-9 round 3).
 */
export function marketReadTokenIds(sectionText: string): readonly string[] {
  const ids = new Set<string>();
  for (const match of sectionText.matchAll(SOURCE_INDEX_URL_RE)) {
    const url = match[2] ?? "";
    if (FEED_ROUTE_RE.test(url)) {
      continue;
    }
    for (const [, token] of url.matchAll(/[?&]token_id=([0-9]{1,78})(?=[&#]|$)/g)) {
      if (token !== undefined) {
        ids.add(token);
      }
    }
  }
  return [...ids];
}

/** A CLOB market read: `https://clob.polymarket.com/clob-markets/<condition>`. */
const CLOB_MARKET_URL_RE = /^https:\/\/clob\.polymarket\.com\/clob-markets\/(0x[0-9a-f]{62}(?:[0-9a-f]{2})?)$/;

/**
 * The token ids of one validated capture that the report anchors (V2-9
 * round 3): a CLOB market read (`/clob-markets/<condition>`, a condition the
 * source index read) kept as a `live-capture`, whose bytes are the raw
 * response, whose digest is the one the report's source index records. Its
 * tokens (`t[].t`, the compact market shape) are then the report's own.
 * Anything else contributes none.
 */
function anchoredMarketTokenIds(
  sidecar: CaptureSidecar,
  view: unknown,
  conditionIds: ReadonlySet<string>,
): readonly string[] {
  const condition = CLOB_MARKET_URL_RE.exec(sidecar.url)?.[1];
  if (sidecar.kind !== "live-capture" || condition === undefined || !conditionIds.has(condition)) {
    return [];
  }
  const tokens = isRecord(view) ? view["t"] : undefined;
  if (!Array.isArray(tokens)) {
    return [];
  }
  return tokens
    .map((token: unknown) => (isRecord(token) ? token["t"] : undefined))
    .filter((token): token is string => typeof token === "string" && TOKEN_ID_RE.test(token));
}

/**
 * The token ids a check's validated captures carry as report-anchored CLOB
 * market reads (`CaptureValidationResult.marketTokenIds`).
 */
export function catalogueTokenIds(results: readonly CaptureValidationResult[]): readonly string[] {
  return [...new Set(results.flatMap((result) => result.marketTokenIds ?? []))];
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

// --- synthetic values and feed cursors --------------------------------------

/**
 * A labelled synthetic hex value: `0x`, then zeros, then at most eight
 * significant hex digits (`0x0000…0101`), at exactly the given width. This is
 * the parent README's "all-zero or clearly synthetic (`0x0000...`)" form, as
 * the trade sidecars label it ("a synthetic, labelled address 0x00…<page><row>
 * (all leading zeros)"). A real address or hash has 32 or more leading zero
 * hex digits with negligible probability.
 */
export function isLabelledSyntheticHex(
  value: unknown,
  hexDigits: number,
): boolean {
  return (
    typeof value === "string" &&
    value.length === 2 + hexDigits &&
    /^0x0+[0-9a-f]{1,8}$/i.test(value)
  );
}

/**
 * A labelled synthetic text value: `synthetic-` and lowercase slug characters
 * only (`synthetic-name-p1-r1`). Round 1: no `@`, `.`, space or capital, so
 * neither an email (`synthetic-alice@mail.example`) nor a base64url venue
 * cursor (`synthetic-eyJ…`) can pass under the label.
 */
export function isLabelledSyntheticText(value: unknown): boolean {
  return typeof value === "string" && /^synthetic-[a-z0-9-]+$/.test(value);
}

/** The labelled synthetic cursor form the trade captures use. */
export function isLabelledSyntheticCursor(value: unknown): boolean {
  return typeof value === "string" && /^synthetic-cursor-[a-z0-9-]+$/.test(value);
}

/**
 * Decodes a cursor the way the venue encodes its feed cursors: base64url (or
 * base64) of a JSON object, `{"data":{"type":…,"params":{…}},"sig":…}`, whose
 * params are the seek anchor of the last row and the page size (S-O06: "The
 * `trades`/`activity` feed cursors carry only the seek anchor and page
 * size"). Plain JSON text is decoded too. Returns the decoded object, or
 * `undefined` when the cursor decodes to no JSON object.
 */
export function decodeFeedCursor(cursor: string): unknown {
  const candidates = [cursor];
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(cursor)) {
    candidates.push(Buffer.from(cursor, "base64url").toString("utf8"));
    candidates.push(Buffer.from(cursor, "base64").toString("utf8"));
  }
  for (const text of candidates) {
    try {
      const decoded: unknown = JSON.parse(text);
      if (typeof decoded === "object" && decoded !== null) {
        return decoded;
      }
    } catch {
      // not JSON in this encoding
    }
  }
  return undefined;
}

/** The cursor refusals of rule 6, for one cursor value at `where`. */
export function feedCursorErrors(cursor: unknown, where: string): string[] {
  if (cursor === null || cursor === undefined) {
    return [];
  }
  if (typeof cursor !== "string") {
    return [`${where}: a feed cursor must be a string or null`];
  }
  const errors: string[] = [];
  const decoded = decodeFeedCursor(cursor);
  if (decoded !== undefined) {
    const data = isRecord(decoded) ? decoded["data"] : undefined;
    const params = isRecord(data) ? data["params"] : undefined;
    const anchor = isRecord(params)
      ? ` (params ${Object.keys(params).join(", ")})`
      : "";
    errors.push(
      `${where}: the cursor decodes to a venue feed cursor${anchor}, which carries the seek anchor of the last row (S-O06) and re-fetches the unredacted page; replace it with a labelled synthetic value`,
    );
  }
  if (!isLabelledSyntheticCursor(cursor)) {
    errors.push(
      `${where}: a trade or activity cursor must be a labelled synthetic value (synthetic-cursor-…), got ${JSON.stringify(cursor.slice(0, 24))}…`,
    );
  }
  return errors;
}

/**
 * The field names a redaction entry names before its colon:
 * `"name, pseudonym: replaced …"` → `name`, `pseudonym`;
 * `"pagination.next_cursor (round 1): …"` → `next_cursor`. An entry with no
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

// --- personal data -----------------------------------------------------------
//
// The personal-data policy (V2-9 round 1), enforced in every capture and every
// sidecar. Keys compare normalized (lowercase letters and digits), so
// `proxy_wallet`, `proxyWallet` and `Proxy-Wallet` are one key.
//
// - **Personal keys, at any depth of any capture:**
//   - a key containing `wallet`, holding a string: a labelled synthetic
//     address;
//   - `pseudonym`: a labelled synthetic value;
//   - `bio`, `profile_image…`, a key containing `email`, and a user name or
//     handle (a key ending in `username`, `display_name`, `screen_name`,
//     `handle`): empty, `null` or a labelled synthetic value.
// - **A person's row:** a trade or activity row, or any object carrying one of
//   the keys above. Its `name` (S-O06: "Profile display name of the wallet")
//   and its `transaction_hash` (it names the wallet on chain) hold labelled
//   synthetic values. In a Data API capture every `name` does: S-O06 uses
//   `name` for the wallet's display name in `Trade`, `Activity`, `Holder` and
//   `Position`.
// - **Personal values, anywhere in a capture or its sidecar's text** (keys
//   included, after NFKC normalization, and in each percent-decoded layer,
//   round 5): no email address, and no `0x` 40-hex
//   address other than a labelled synthetic one or a documented public
//   contract address (`CaptureContext.publicAddresses`).
// - **Trade and activity pages** carry only the S-O06 fields
//   (`FEED_ROW_FIELDS`, rule 6); an unrecognized field is refused.
// - **Sidecar text** (`url`, `notes`, each redaction, `extract.rule`):
//   - no personal field written with a value (`name: …`, `name=…`,
//     `"name":"…"`, or a URL query parameter) other than a labelled synthetic
//     value, a `<placeholder>`, `null` or an empty string;
//   - in prose, no hex id, hash or number of 40 or more digits that is not a
//     labelled synthetic value, unless the capture or the URL carries it or it
//     is the sidecar's own digest;
//   - for a trade or activity capture, no token that decodes to a venue cursor.
//
// The limit, stated in `test/fixtures/venue/README.md`: a person's name
// written as plain prose with no field label, or encoded, is not
// machine-detectable. Sidecar prose names personal values by placeholder or
// synthetic label only, and the reviewer reads it.

/** An email address, anywhere in a string. */
const EMAIL_RE = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/;

/**
 * A `0x` 40-hex token (an address), not the prefix of a longer hex run (the
 * lookahead). Round 3 (V2-9-R3-03): nothing is required before the `0x`, so
 * a label glued to it (`wallet_0x…`, `retained0x…`) does not hide the
 * address. No longer identifier ends in an address literal: `x` is not a hex
 * digit, so a `0x` never sits inside a hex run.
 */
const ADDRESS_TOKEN_RE = /0[xX][0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/**
 * A long id in prose: `0x` and more than 40 hex digits (an id or a hash), or
 * 40 or more bare hex or decimal digits (an unprefixed address or hash, a
 * position id). Round 3 (V2-9-R3-03): a glued label (`hash_0x…`, `id…`) does
 * not hide it. A match is leftmost and greedy, so it takes a whole hex run;
 * the bare form is not read after a `0x`, which leaves an address (`0x` and
 * exactly 40 hex digits) to `ADDRESS_TOKEN_RE`.
 */
const LONG_ID_TOKEN_RE =
  /(?:0[xX][0-9a-fA-F]{41,}|(?<!0[xX])[0-9a-fA-F]{40,})(?![0-9a-fA-F])/g;

/** A key compared without case or separators. */
function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isUserNameKey(normalized: string): boolean {
  return (
    normalized.endsWith("username") ||
    normalized === "displayname" ||
    normalized === "screenname" ||
    normalized === "handle"
  );
}

const isBlankOrSynthetic = (value: unknown): boolean =>
  value === "" || value === null || isLabelledSyntheticText(value);

interface PersonalKeyRule {
  readonly applies: (normalized: string) => boolean;
  readonly allows: (value: unknown) => boolean;
  readonly message: string;
}

/** Personal keys anywhere; each also marks its object as a person's row. */
const PERSONAL_KEY_RULES: readonly PersonalKeyRule[] = [
  {
    applies: (key) => key.includes("wallet"),
    allows: (value) => typeof value !== "string" || isLabelledSyntheticHex(value, 40),
    message: "a wallet must be a labelled synthetic address (0x00…), not a live value",
  },
  {
    applies: (key) => key === "pseudonym",
    allows: isLabelledSyntheticText,
    message: "a pseudonym must be a labelled synthetic value (synthetic-…)",
  },
  {
    applies: (key) => key === "bio" || key.startsWith("profileimage"),
    allows: isBlankOrSynthetic,
    message: "a profile field must be empty or a labelled synthetic value (synthetic-…)",
  },
  {
    applies: (key) => key.includes("email"),
    allows: isBlankOrSynthetic,
    message: "an email field must be empty or a labelled synthetic value (synthetic-…)",
  },
  {
    applies: isUserNameKey,
    allows: isBlankOrSynthetic,
    message: "a user name or handle must be empty or a labelled synthetic value (synthetic-…)",
  },
];

/** The keys of a person's row (see the policy above). */
const PERSON_ROW_RULES: readonly PersonalKeyRule[] = [
  {
    applies: (key) => key === "name",
    allows: isLabelledSyntheticText,
    message: "a name must be a labelled synthetic value (synthetic-…)",
  },
  {
    applies: (key) => key === "transactionhash" || key === "txhash",
    allows: (value) => isLabelledSyntheticHex(value, 64),
    message: "a hash must be a labelled synthetic hash (0x00…)",
  },
];

/** What the personal-data scan of one capture knows. */
interface PersonalDataPolicy {
  /** Documented public contract addresses, lowercased. */
  readonly publicAddresses: ReadonlySet<string>;
  /** The capture's trade or activity rows (person's rows by position). */
  readonly feedRows: ReadonlySet<unknown>;
  /** A Data API capture: every `name` is a wallet's display name (S-O06). */
  readonly dataApi: boolean;
}

/**
 * The refusals of one string, wherever it sits: an email address, or a `0x`
 * 40-hex address that is neither labelled synthetic nor a documented public
 * contract address. NFKC-normalized first, so a full-width `＠` counts. The
 * value itself is never echoed.
 */
export function personalValueErrors(
  text: string,
  where: string,
  publicAddresses: ReadonlySet<string> = new Set(),
): string[] {
  const normalized = text.normalize("NFKC");
  const errors: string[] = [];
  if (EMAIL_RE.test(normalized)) {
    errors.push(`${where}: an email address may not be committed (personal data)`);
  }
  for (const [token] of normalized.matchAll(ADDRESS_TOKEN_RE)) {
    if (!isLabelledSyntheticHex(token, 40) && !publicAddresses.has(token.toLowerCase())) {
      errors.push(
        `${where}: a 0x 40-hex address that is neither a labelled synthetic value (0x00…) nor a documented public contract address; it may be a wallet`,
      );
      break;
    }
  }
  return errors;
}

/**
 * `personalValueErrors` of every reading of a capture string (round 5,
 * `textReadings`: also each percent-decoded layer), and the named failure
 * when the string cannot be decoded. A string with no escape is read as
 * before.
 */
function decodedValueErrors(
  text: string,
  where: string,
  publicAddresses: ReadonlySet<string>,
): string[] {
  const { readings, failure } = textReadings(text);
  return [
    ...(failure === undefined ? [] : [undecodableError(where, failure)]),
    ...errorsOfReadings(readings, (reading) => personalValueErrors(reading, where, publicAddresses)),
  ];
}

/**
 * Rule 5: every personal key and every string (keys included) of a capture.
 * A value under a personal key is judged by its key's rule alone, so each
 * field is refused once.
 */
function scanPersonalData(
  value: unknown,
  path: string,
  errors: string[],
  policy: PersonalDataPolicy,
): void {
  if (typeof value === "string") {
    errors.push(...decodedValueErrors(value, path, policy.publicAddresses));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      scanPersonalData(entry, `${path}[${index}]`, errors, policy);
    });
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const keys = Object.keys(value).map(normalizedKey);
  const personRow =
    policy.feedRows.has(value) ||
    keys.some((key) => PERSONAL_KEY_RULES.some((rule) => rule.applies(key)));
  for (const [key, entry] of Object.entries(value)) {
    const where = `${path}.${key}`;
    const normalized = normalizedKey(key);
    errors.push(...decodedValueErrors(key, `${path} key`, policy.publicAddresses));
    const rule =
      PERSONAL_KEY_RULES.find((candidate) => candidate.applies(normalized)) ??
      (personRow || (policy.dataApi && normalized === "name")
        ? PERSON_ROW_RULES.find((candidate) => candidate.applies(normalized))
        : undefined);
    if (normalized.includes("wallet") && typeof entry !== "string" && entry !== null) {
      // Round 5, fail closed: the scanner reads a wallet only as a string
      // (an address) or null, not as a number, a boolean, a list or an
      // object, whose contents it would not judge as an address.
      errors.push(
        `${where}: a wallet key holds ${Array.isArray(entry) ? "an array" : typeof entry === "object" ? "an object" : `a ${typeof entry}`}; the scanner reads only an address string or null, so the gate fails closed (round 5)`,
      );
    }
    if (rule !== undefined) {
      if (!rule.allows(entry)) {
        errors.push(`${where}: ${rule.message}`);
      }
      if (typeof entry === "string") {
        continue;
      }
    }
    scanPersonalData(entry, where, errors, policy);
  }
}

/**
 * The view the personal-data scan walks: a `.jsonl` record whose `data` text
 * parsed is scanned through its parsed `frame` (JSON escapes decoded), so its
 * `data` text is not scanned twice.
 */
function personalScanTarget(view: unknown, format: CaptureSpec["format"]): unknown {
  if (format !== "jsonl" || !Array.isArray(view)) {
    return view;
  }
  return view.map((record: unknown) => {
    if (!isRecord(record) || !Object.hasOwn(record, "frame")) {
      return record;
    }
    return Object.fromEntries(Object.entries(record).filter(([key]) => key !== "data"));
  });
}

/**
 * Personal keys written with a value in sidecar text: `name: v`, `name=v`,
 * `"name":"v"` (case-insensitive, `_` or `-` optional). Group 1 is the key,
 * group 2 the value token. Round 3 (V2-9-R3-03): a key glued to a label by
 * `_` or `-` (`x_wallet=`, `the-name:`) is still read; only a letter or a
 * digit before it (`filename:`) makes it part of another word.
 */
const PERSONAL_ASSIGNMENT_RE = new RegExp(
  `(?<![A-Za-z0-9])(proxy[_-]?wallet|wallet|x[_-]?user[_-]?name|user[_-]?name|display[_-]?name|screen[_-]?name|handle|user|address|name|pseudonym|bio|profile[_-]?image(?:[_-]?optimized)?|e-?mail|transaction[_-]?hash|tx[_-]?hash)["']?\\s*[:=]\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;)\\]}&#]*)`,
  "gi",
);

/**
 * Whether a value written after a personal key is not personal: empty,
 * `null`, a `<placeholder>`, a labelled synthetic value, or the elided
 * synthetic form `0x00…`.
 */
function isProsePlaceholder(token: string): boolean {
  const value = token.replace(/^["']/, "").replace(/["']$/, "");
  return (
    value === "" ||
    value === "null" ||
    value.startsWith("<") ||
    isLabelledSyntheticText(value) ||
    isLabelledSyntheticCursor(value) ||
    isLabelledSyntheticHex(value, value.length - 2) ||
    /^0x0+(?:…|\.\.\.)/.test(value)
  );
}

function personalAssignmentErrors(text: string, where: string, hashKeys = true): string[] {
  const errors: string[] = [];
  for (const match of text.normalize("NFKC").matchAll(PERSONAL_ASSIGNMENT_RE)) {
    if (!hashKeys && /hash$/i.test(match[1] ?? "")) {
      // A fixture envelope judges a hash by its value (the long-id rule of
      // `fixturePersonalDataErrors`), not by its label: the frozen V1 CTF
      // notes type `outcome.transactionHash: TxHash`.
      continue;
    }
    if (!isProsePlaceholder(match[2] ?? "")) {
      errors.push(
        `${where}: ${(match[1] ?? "").toLowerCase()} is written with a value that is not a labelled synthetic value, a <placeholder> or empty`,
      );
    }
  }
  return errors;
}

// --- fail closed: what the scanner cannot decode ------------------------------
//
// Round 5 (V2-9-R5-01, and the orchestrator's 2026-10-08 ruling): the scanner
// is defense in depth against an accidental commit, and anything it cannot
// parse, decode or normalize fails the gate with a named reason. It never
// falls back to the raw text, and never skips. Each decode path of this
// module does so: the percent-decoding of sidecar text and of every cursor
// scan (`textReadings`), the feed classification (`readsAsFeedRoute`), the
// URL parse (`captureUrlErrors`, `feedUrlErrors`), the query parameters
// (`SIDECAR_QUERY_PARAMETERS`), a wallet key's type (`scanPersonalData`), a
// `.jsonl` data text (`parseCapture`) and the sidecar's bytes
// (`loadCapture`).

/** The deepest nesting of percent-encoding the scanner decodes (round 5). */
export const MAX_PERCENT_LAYERS = 4;

/** Every reading of a text the scanner judges (round 5). */
export interface TextReadings {
  /**
   * The text as written first, then its NFKC normalization and each
   * percent-decoded layer, each once. When `failure` is set, a reading could
   * not be decoded further, and the gate must fail.
   */
  readonly readings: readonly string[];
  /** Why the scanner cannot decode the text; `undefined` when it can. */
  readonly failure?: string;
}

/** Decodes every run of `%XX` escapes once; `undefined` when a run is not UTF-8. */
function decodePercentRuns(text: string): string | undefined {
  let failed = false;
  const decoded = text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      failed = true;
      return run;
    }
  });
  return failed ? undefined : decoded;
}

/**
 * Every reading the scanner judges of one text (round 5): the text, and,
 * layer by layer to a fixpoint, the NFKC normalization of each reading (so
 * a full-width `％` is an escape, and a decoded full-width letter is
 * folded) and its percent-decoding. `url`: the text is a URL, where a `%`
 * that begins no `%XX` escape is malformed.
 *
 * Strict, so it fails closed: a run of `%XX` escapes that is not UTF-8,
 * percent-encoding nested deeper than `MAX_PERCENT_LAYERS` layers, or such a
 * malformed `%` in a URL sets `failure`, and the caller fails the gate with
 * that reason. The raw text is never judged in place of its decoding.
 * (Before round 5, one undecodable escape anywhere left a whole URL
 * undecoded, and the scan read only the raw text.)
 */
export function textReadings(text: string, url = false): TextReadings {
  const readings: string[] = [];
  let failure: string | undefined;
  let frontier = [text];
  for (let depth = 0; frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const reading of frontier) {
      for (const form of [reading, reading.normalize("NFKC")]) {
        if (readings.includes(form)) {
          continue;
        }
        readings.push(form);
        if (url && depth === 0 && /%(?![0-9A-Fa-f]{2})/.test(form)) {
          failure ??= "a % that begins no %XX escape";
          continue;
        }
        if (!/%[0-9A-Fa-f]{2}/.test(form)) {
          continue;
        }
        if (depth === MAX_PERCENT_LAYERS) {
          failure ??= `percent-encoding nested deeper than ${MAX_PERCENT_LAYERS} layers`;
          continue;
        }
        const decoded = decodePercentRuns(form);
        if (decoded === undefined) {
          failure ??= "a run of %XX escapes that is not UTF-8";
          continue;
        }
        next.push(decoded);
      }
    }
    frontier = next;
  }
  return failure === undefined ? { readings } : { readings, failure };
}

/** The named refusal of a text the scanner cannot decode (round 5). */
export function undecodableError(where: string, failure: string): string {
  return `${where}: the scanner cannot decode it (${failure}), so the gate fails closed; write the value plainly, or as a labelled synthetic value`;
}

/**
 * The errors of every reading of a text (`textReadings`), each once, in the
 * order the readings first give them. A single reading gives exactly its
 * own errors, duplicates included.
 */
function errorsOfReadings(
  readings: readonly string[],
  errorsOf: (reading: string) => readonly string[],
): string[] {
  const [first = "", ...rest] = readings;
  const errors = [...errorsOf(first)];
  for (const reading of rest) {
    for (const error of errorsOf(reading)) {
      if (!errors.includes(error)) {
        errors.push(error);
      }
    }
  }
  return errors;
}

/**
 * Whether a text embeds a non-empty JSON object anywhere in it: a `{`, and a
 * later `}`, whose span `JSON.parse` reads as an object with a key. Garbage
 * before or after the object (a glued prefix, the tail of a decoded run) does
 * not hide it. `{}` is not counted, so random decoded bytes do not match.
 */
function embedsJsonObject(text: string): boolean {
  return embeddedJsonObjects(text, true).length > 0;
}

/**
 * The non-empty JSON objects a text embeds (see `embedsJsonObject`): every
 * span `JSON.parse` reads as an object with a key. With `first`, only the
 * first one found. Round 6: the venue-cursor scan classifies each one
 * (`venueCursorAnchorErrors`).
 */
function embeddedJsonObjects(text: string, first = false): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const opens: number[] = [];
  const closes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{") {
      opens.push(index);
    } else if (text[index] === "}") {
      closes.push(index);
    }
  }
  for (const open of opens) {
    for (const close of closes) {
      if (close <= open) {
        continue;
      }
      try {
        const value: unknown = JSON.parse(text.slice(open, close + 1));
        if (isRecord(value) && Object.keys(value).length > 0) {
          found.push(value);
          if (first) {
            return found;
          }
        }
      } catch {
        // not one JSON object at this span
      }
    }
  }
  return found;
}

/** A run of base64 or base64url characters; `=` (padding, assignment) ends it. */
const BASE64_RUN_RE = /[A-Za-z0-9+/_-]{16,}/g;

/** A run of hex digits long enough to hold an encoded JSON object. */
const HEX_RUN_RE = /[0-9a-fA-F]{32,}/g;

/**
 * Whether one run of encoded characters hides a JSON object: decoded whole
 * (`decodeFeedCursor`), or decoded as base64 from each of its first four
 * offsets (so a glued prefix such as `cursor` in `cursoreyJ…` cannot shift
 * the alignment) or as hex from each of its first two, with the object
 * anywhere in the decoded text (so a glued suffix cannot hide it either).
 */
function runHidesJsonObject(run: string): boolean {
  return runJsonObjects(run, true).length > 0;
}

/**
 * The JSON objects one run of encoded characters hides (see
 * `runHidesJsonObject`); with `first`, only the first one found (round 6).
 */
function runJsonObjects(run: string, first = false): unknown[] {
  const found: unknown[] = [];
  const whole = decodeFeedCursor(run);
  if (whole !== undefined) {
    found.push(whole);
    if (first) {
      return found;
    }
  }
  const decodings = [
    ...[0, 1, 2, 3].map((offset) => Buffer.from(run.slice(offset), "base64").toString("utf8")),
    ...[...run.matchAll(HEX_RUN_RE)].flatMap(([hexRun]) =>
      [0, 1].map((offset) => Buffer.from(hexRun.slice(offset), "hex").toString("utf8")),
    ),
  ];
  for (const decoded of decodings) {
    found.push(...embeddedJsonObjects(decoded, first));
    if (first && found.length > 0) {
      return found;
    }
  }
  return found;
}

/**
 * The tokens of a text that hide a JSON object, as a venue cursor does
 * (`decodeFeedCursor`: base64url of `{"data":{…},"sig":…}`), wherever the
 * cursor sits (round 2, V2-9-R2-01). The text is read as is, NFKC-normalized
 * and with its percent-escapes decoded; in each reading:
 *
 * - a JSON object written as plain text is a token;
 * - so is every run of 16 or more base64 or base64url characters that hides
 *   a JSON object (`runHidesJsonObject`). `=` ends a run, so the value of an
 *   assignment (`cursor=eyJ…`, `#cursor=eyJ…`, `cursor%3DeyJ…`) is a run of
 *   its own; a glued prefix or suffix is decoded through.
 *
 * Round 5: the readings are `textReadings`' (every percent-decoded layer).
 * Fail closed: a text whose percent-encoding does not decode yields the
 * token `UNDECODABLE_TOKEN`, so no caller can read it as clean
 * (`cursorScan` names the failure).
 *
 * Not caught: a cursor split across tokens or otherwise transformed (the
 * README's "What the gate cannot check").
 */
export function cursorLikeTokens(text: string): string[] {
  const scan = cursorScan(text);
  return scan.failure === undefined ? [...scan.tokens] : [...scan.tokens, UNDECODABLE_TOKEN];
}

/** The token `cursorLikeTokens` yields for a text it cannot decode (round 5). */
export const UNDECODABLE_TOKEN = "<undecodable percent-encoding>";

/**
 * The cursor scan of one text (round 5): the tokens that hide a JSON object
 * (see `cursorLikeTokens`), and why the text could not be decoded, if so.
 */
export function cursorScan(text: string): {
  readonly tokens: readonly string[];
  readonly failure?: string;
} {
  const { readings, failure } = textReadings(text);
  const tokens = new Set<string>();
  for (const reading of readings) {
    if (embedsJsonObject(reading)) {
      tokens.add("<a JSON object written as text>");
    }
    for (const [run] of reading.matchAll(BASE64_RUN_RE)) {
      if (runHidesJsonObject(run)) {
        tokens.add(run);
      }
    }
  }
  return failure === undefined ? { tokens: [...tokens] } : { tokens: [...tokens], failure };
}

/**
 * The cursor refusals of one text at `where` (round 5): `message` when a
 * token hides a JSON object, and the named failure when the text cannot be
 * decoded.
 */
function cursorScanErrors(text: string, where: string, message: string): string[] {
  const scan = cursorScan(text);
  return [
    ...(scan.failure === undefined ? [] : [undecodableError(`${where} (cursor scan)`, scan.failure)]),
    ...(scan.tokens.length > 0 ? [message] : []),
  ];
}

// --- venue cursors outside the feeds (round 6) --------------------------------
//
// V2-9-R6-02: a trade or activity cursor pasted into the provenance of a
// capture that is not a feed (a sidecar's notes, URL, redactions or extract
// rule), into such a capture's strings, or into a fixture envelope, carries
// the seek anchor of a feed's last row (S-O06) just the same. The feed rules
// (rule 6) refuse every cursor-like token; outside the feeds a public market
// cursor is legitimate (the `prices_history` cursor of S-A03), so there the
// scan refuses each token that decodes to a venue cursor unless its type is
// one `PUBLIC_MARKET_CURSORS` classifies for the capture's route.

/**
 * The public market cursors the gate admits outside the trade and activity
 * feeds, by type and route. Source: the committed VENUE-4 captures
 * `protocol-v2/data-v2-prices-history-page{1,2}` (S-A02, S-A03): the page's
 * `next_cursor` and the page-2 URL's `cursor` decode to
 * `{"data":{"type":"prices_history","params":{…}},"sig":…}`, a public price
 * series of a market, not of an account. Fail closed: another type, or this
 * type on another route, is refused until the package that captures it
 * classifies it here, with its source.
 */
export const PUBLIC_MARKET_CURSORS: readonly {
  readonly type: string;
  readonly route: string;
}[] = [{ type: "prices_history", route: "https://data-api.polymarket.com/v2/prices-history" }];

/**
 * Whether a decoded object has the shape of a venue cursor (S-O06; the
 * committed cursors): a `sig`, or a `data` object with a `type` or `params`.
 * Returns its `data.type` (`""` when it has none), or `undefined` when the
 * object is not cursor-shaped.
 */
function venueCursorType(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const data = value["data"];
  const shaped =
    Object.hasOwn(value, "sig") ||
    (isRecord(data) && (Object.hasOwn(data, "type") || Object.hasOwn(data, "params")));
  if (!shaped) {
    return undefined;
  }
  const type = isRecord(data) ? data["type"] : undefined;
  return typeof type === "string" ? type : "";
}

/**
 * Whether a venue-cursor type is a public market cursor classified for a
 * route (`PUBLIC_MARKET_CURSORS`). `route`: `urlRouteOf` of the URL; `""`
 * for a text with no route (a fixture envelope), where none is classified.
 */
function isClassifiedMarketCursor(type: string, route: string): boolean {
  return PUBLIC_MARKET_CURSORS.some((entry) => entry.type === type && entry.route === route);
}

/**
 * The venue-cursor types one text hides that are not classified for
 * `route` (round 6), in every reading (`textReadings`): JSON written as text,
 * and every base64, base64url or hex run, decoded through a glued prefix or
 * suffix, as `cursorLikeTokens` reads them. Also why the text cannot be
 * decoded, if so (fail closed).
 */
export function unclassifiedVenueCursors(
  text: string,
  route: string,
): { readonly types: readonly string[]; readonly failure?: string } {
  const { readings, failure } = textReadings(text);
  const types = new Set<string>();
  for (const reading of readings) {
    const objects: unknown[] = [];
    if (reading.includes("{")) {
      objects.push(...embeddedJsonObjects(reading));
    }
    for (const [run] of reading.matchAll(BASE64_RUN_RE)) {
      objects.push(...runJsonObjects(run));
    }
    for (const object of objects) {
      const type = venueCursorType(object);
      if (type !== undefined && !isClassifiedMarketCursor(type, route)) {
        types.add(type);
      }
    }
  }
  return failure === undefined ? { types: [...types] } : { types: [...types], failure };
}

/**
 * The refusals of one text outside the feeds (round 6, V2-9-R6-02): a token
 * that decodes to a venue cursor not classified for `route`, and the named
 * failure when the text cannot be decoded.
 */
export function venueCursorAnchorErrors(text: string, where: string, route: string): string[] {
  const scan = unclassifiedVenueCursors(text, route);
  return [
    ...(scan.failure === undefined ? [] : [undecodableError(`${where} (cursor scan)`, scan.failure)]),
    ...(scan.types.length === 0
      ? []
      : [
          `${where}: a token decodes to a venue cursor (type ${scan.types.map((type) => JSON.stringify(type)).join(", ")}), which carries the seek anchor of a feed's last row (S-O06); outside the trade and activity feeds only a public market cursor classified for the route (PUBLIC_MARKET_CURSORS) may be committed`,
        ]),
  ];
}

/**
 * Rule 5 for the sidecar: its free text (`url`, `notes`, each redaction,
 * `extract.rule`); see the policy above. A redaction's subject list, before
 * its first colon, names fields and is not a value.
 *
 * Round 5 (V2-9-R5-01): each text is judged in every reading
 * (`textReadings`: as written, NFKC-normalized, and each percent-decoded
 * layer), and a text the scanner cannot decode fails the gate with a named
 * reason. Before round 5, one malformed escape anywhere in the URL (an
 * unrelated `&unused=%FF`) left the whole URL undecoded, so a
 * percent-encoded email or wallet in it passed.
 */
export function sidecarPersonalDataErrors(
  sidecar: CaptureSidecar,
  captureText: string,
  feed: boolean,
  publicAddresses: ReadonlySet<string> = new Set(),
): string[] {
  const errors: string[] = [];
  const url = sidecar.url.toLowerCase();
  const capture = captureText.toLowerCase();
  const urlReadings = textReadings(sidecar.url, true);
  if (urlReadings.failure !== undefined) {
    errors.push(undecodableError("sidecar.url", urlReadings.failure));
  }
  errors.push(
    ...errorsOfReadings(urlReadings.readings, (reading) => [
      ...personalValueErrors(reading, "sidecar.url", publicAddresses),
      ...personalAssignmentErrors(reading, "sidecar.url"),
    ]),
  );
  const prose: { readonly where: string; readonly text: string; readonly values: string }[] = [
    { where: "sidecar.notes", text: sidecar.notes, values: sidecar.notes },
    ...sidecar.redactions.map((entry, index) => ({
      where: `sidecar.redactions[${index}]`,
      text: entry,
      values: entry.includes(":") ? entry.slice(entry.indexOf(":") + 1) : entry,
    })),
    ...(sidecar.extract === undefined
      ? []
      : [{ where: "sidecar.extract.rule", text: sidecar.extract.rule, values: sidecar.extract.rule }]),
  ];
  for (const { where, text, values } of prose) {
    const readings = textReadings(text);
    if (readings.failure !== undefined) {
      errors.push(undecodableError(where, readings.failure));
    }
    errors.push(
      ...errorsOfReadings(readings.readings, (reading) =>
        personalValueErrors(reading, where, publicAddresses),
      ),
    );
    for (const [token] of text.normalize("NFKC").matchAll(LONG_ID_TOKEN_RE)) {
      const lower = token.toLowerCase();
      if (
        !isLabelledSyntheticHex(token, token.length - 2) &&
        !url.includes(lower) &&
        !capture.includes(lower) &&
        lower !== sidecar.raw_sha256 &&
        lower !== sidecar.fixture_sha256
      ) {
        errors.push(
          `${where}: a hex id, hash or number of 40 or more digits that is not a labelled synthetic value and that neither the capture nor the URL carries; name it by placeholder (<V1 window>)`,
        );
        break;
      }
    }
    errors.push(
      ...errorsOfReadings(textReadings(values).readings, (reading) =>
        personalAssignmentErrors(reading, where),
      ),
    );
    // The text's decode failure, if any, is named above, once.
    if (feed && cursorScan(text).tokens.length > 0) {
      errors.push(
        `${where}: a token decodes to a venue cursor, which carries the seek anchor of the last row (S-O06); name a cursor by its labelled synthetic value`,
      );
    }
    if (!feed) {
      // Round 6 (V2-9-R6-02): outside the feeds too, a venue cursor that is
      // not a classified public market cursor is refused.
      errors.push(...unclassifiedCursorErrors(text, where, urlRouteOf(sidecar.url)));
    }
  }
  if (!feed) {
    errors.push(...unclassifiedCursorErrors(sidecar.url, "sidecar.url", urlRouteOf(sidecar.url)));
  }
  return errors;
}

/**
 * `venueCursorAnchorErrors` without the decode failure, for a text whose
 * failure the caller has already named once.
 */
function unclassifiedCursorErrors(text: string, where: string, route: string): string[] {
  return venueCursorAnchorErrors(text, where, route).filter(
    (error) => !error.startsWith(`${where} (cursor scan)`),
  );
}

const FEED_ROUTE_RE =
  /^https:\/\/data-api\.polymarket\.com\/v2\/(?:trades|activity)(?:[/?]|$)/;

/**
 * Whether a URL reads as a Data API feed route under any spelling (round 4):
 * parsed by WHATWG (which lowercases and percent-decodes the host and drops
 * a default port), its host and path in every reading (`textReadings`:
 * NFKC-normalized and each percent-decoded layer), lowercased, with
 * repeated slashes collapsed.
 *
 * Fail closed (round 5): a URL that does not parse, or whose host or path
 * cannot be decoded, reads as a feed, so it answers to every feed rule; it
 * is never read as raw text instead. `captureUrlErrors` and
 * `sidecarPersonalDataErrors` name the failure.
 */
export function readsAsFeedRoute(url: string): boolean {
  if (FEED_ROUTE_RE.test(url)) {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  const host = textReadings(parsed.hostname, true);
  const path = textReadings(parsed.pathname, true);
  if (host.failure !== undefined || path.failure !== undefined) {
    return true;
  }
  const fold = (text: string): string => text.toLowerCase().replace(/\/{2,}/g, "/");
  return (
    host.readings.some((reading) => fold(reading) === "data-api.polymarket.com") &&
    path.readings.some((reading) => /^\/v2\/(?:trades|activity)(?![a-z0-9_])/.test(fold(reading)))
  );
}

/**
 * A trade or activity feed capture (round 4: the report decides, not the
 * sidecar's spelling):
 * - the report's source-index URL for the catalogue's source id
 *   (`reportUrl`) is a Data API feed route (S-D26 lines 80-82: `/v2/trades`,
 *   `/v2/activity`, `/v2/activity/combos`);
 * - or the sidecar URL reads as one under any spelling (`readsAsFeedRoute`);
 * - or its `data` rows carry a wallet or pseudonym, as feed rows do.
 */
export function isFeedCapture(url: string, view: unknown, reportUrl = ""): boolean {
  if (FEED_ROUTE_RE.test(reportUrl) || readsAsFeedRoute(url)) {
    return true;
  }
  const rows = isRecord(view) ? view["data"] : undefined;
  return (
    Array.isArray(rows) &&
    rows.some(
      (row) =>
        isRecord(row) &&
        (Object.hasOwn(row, "proxy_wallet") || Object.hasOwn(row, "pseudonym")),
    )
  );
}

/**
 * The fields a trade or activity row may carry: S-O06
 * `components.schemas.Trade` and `components.schemas.Activity` (the Data API
 * v2 OpenAPI, report §14), every one a scalar of the type S-O06 declares
 * (`FEED_ROW_FIELD_TYPES`, round 3). Their personal fields (`proxy_wallet`,
 * `name`, `pseudonym`, `bio`, `profile_image`, `profile_image_optimized`,
 * `transaction_hash`) must hold labelled synthetic values (rules 5 and 6). A
 * field outside this list is refused: it may carry personal data (an email,
 * a nested profile). Fail closed: the package that captures a new field
 * classifies it here, with its source. `ComboActivity` rows
 * (`/v2/activity/combos`, nested legs) are not classified, so are refused.
 */
export const FEED_ROW_FIELDS = [
  "bio",
  "condition_id",
  "event_slug",
  "icon",
  "is_combo",
  "name",
  "outcome",
  "outcome_index",
  "price",
  "profile_image",
  "profile_image_optimized",
  "proxy_wallet",
  "pseudonym",
  "side",
  "size",
  "slug",
  "timestamp",
  "title",
  "token_id",
  "transaction_hash",
  "type",
  "usdc_size",
] as const;

/** S-O06 `TradesPage`, `ActivityPage`: `{ data, pagination }`, both required. */
const FEED_PAGE_FIELDS = ["data", "pagination"];

/**
 * The activity types S-O06 names: the `/v2/activity` `type` parameter
 * ("TRADE, SPLIT, MERGE, REDEEM, …", and the opt-in `TIP`) and
 * `Activity.type` ("TRADE, SPLIT, MERGE, REDEEM, REWARD, CONVERSION, …").
 * Closed (round 3, V2-9-R3-02): another upper-case word, a hash written in
 * capitals for example, is refused. The package that captures another type
 * adds it here, with its source.
 */
export const ACTIVITY_TYPES = [
  "TRADE",
  "SPLIT",
  "MERGE",
  "REDEEM",
  "REWARD",
  "CONVERSION",
  "TIP",
] as const;

/**
 * The market identifiers a trade or activity capture may carry, each
 * corroborated by the report, independently of the capture (round 3,
 * V2-9-R3-02): a row's `condition_id` and `token_id`, a URL's `condition`.
 */
export interface FeedMarketIds {
  /** Lowercased condition ids the report's source index read as a market. */
  readonly conditionIds: ReadonlySet<string>;
  /** Decimal token ids the report read as a market (`CaptureContext.marketTokenIds`). */
  readonly tokenIds: ReadonlySet<string>;
}

const NO_MARKET_IDS: FeedMarketIds = { conditionIds: new Set(), tokenIds: new Set() };

/** A condition id: `0x` and 62 hex digits (bytes31), or 64 (padded). */
const CONDITION_ID_RE = /^0x[0-9a-f]{62}(?:[0-9a-f]{2})?$/;

/** A token id: a decimal uint256 (S-O06: "CLOB asset id"), no leading zero. */
const TOKEN_ID_RE = /^(?:0|[1-9][0-9]{0,77})$/;

/** A condition id the report read as a market, or a labelled synthetic one. */
function isCorroboratedConditionId(value: string, ids: FeedMarketIds): boolean {
  return (
    CONDITION_ID_RE.test(value) &&
    (isLabelledSyntheticHex(value, value.length - 2) || ids.conditionIds.has(value))
  );
}

/** A token id the report read as a market, or a labelled synthetic text. */
function isCorroboratedTokenId(value: string, ids: FeedMarketIds): boolean {
  return isLabelledSyntheticText(value) || (TOKEN_ID_RE.test(value) && ids.tokenIds.has(value));
}

/**
 * A hash-shaped run (round 3): `0x` and 20 or more hex digits, or 20 or more
 * bare hex or decimal digits. Twenty hex digits are 80 bits, more than a
 * double carries, so no price, size, time, slug, title or documented query
 * value of a feed needs one; only a market identifier does, and it is
 * corroborated (`FeedMarketIds`). A match is leftmost and greedy, so it takes
 * a whole run, glued label or not; the bare form is not read after a `0x`.
 */
const HASH_RUN_RE = /0[xX][0-9a-fA-F]{20,}|(?<!0[xX])[0-9a-fA-F]{20,}/g;

/**
 * The hash-shaped runs of a text (NFKC-normalized, so full-width digits
 * count) that are neither a labelled synthetic hex value nor a market
 * identifier the report corroborates.
 */
export function unexplainedHashRuns(text: string, ids: FeedMarketIds = NO_MARKET_IDS): string[] {
  return [...text.normalize("NFKC").matchAll(HASH_RUN_RE)]
    .map(([run]) => run)
    .filter(
      (run) =>
        !isLabelledSyntheticHex(run, run.length - 2) &&
        !ids.conditionIds.has(run.toLowerCase()) &&
        !ids.tokenIds.has(run),
    );
}

/** One documented field type: a test, and its description for the refusal. */
interface FeedFieldType {
  readonly accepts: (value: unknown, ids: FeedMarketIds) => boolean;
  readonly description: string;
}

const INT32_MAX = 2_147_483_647;

/** A string judged by the personal-data rules (rule 5), not here. */
const FEED_STRING: FeedFieldType = {
  accepts: (value) => typeof value === "string",
  description: "a string",
};

/** Free text: a string with no hash-shaped run the report does not corroborate. */
const FEED_TEXT: FeedFieldType = {
  accepts: (value, ids) => typeof value === "string" && unexplainedHashRuns(value, ids).length === 0,
  description:
    "a string with no hash-shaped run (0x and 20 or more hex digits, or 20 or more bare hex or decimal digits) other than a labelled synthetic value or a market id the report read",
};

const FEED_NUMBER: FeedFieldType = {
  accepts: (value) => typeof value === "number" && Number.isFinite(value),
  description: "a number (double)",
};

const FEED_INT32: FeedFieldType = {
  accepts: (value) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= INT32_MAX,
  description: "a non-negative integer (int32)",
};

const FEED_INT64: FeedFieldType = {
  accepts: (value) => Number.isSafeInteger(value) && (value as number) >= 0,
  description: "a non-negative integer (int64, epoch seconds)",
};

const FEED_BOOLEAN: FeedFieldType = {
  accepts: (value) => typeof value === "boolean",
  description: "a boolean",
};

const feedEnum = (description: string, ...values: readonly string[]): FeedFieldType => ({
  accepts: (value) => typeof value === "string" && values.includes(value),
  description,
});

/**
 * The type S-O06 declares for each row field (`components.schemas.Trade` and
 * `Activity`, `properties.*.type`, `format` and description), narrowed where
 * the description states a shape (round 3, V2-9-R3-01):
 *
 * - `condition_id` and `token_id` are market ids that the report read
 *   (`FeedMarketIds`), or labelled synthetic: so no hash poses as one;
 * - `side`: `BUY` or `SELL`, empty where a side does not apply, `IN` or
 *   `OUT` on a tip (the `/v2/activity` `type` parameter's description);
 * - `type`: `ACTIVITY_TYPES`;
 * - the personal fields: a string, whose value rule 5 judges;
 * - the other strings: free text with no unexplained hash-shaped run.
 */
const FEED_ROW_FIELD_TYPES: Readonly<Record<(typeof FEED_ROW_FIELDS)[number], FeedFieldType>> = {
  bio: FEED_STRING,
  condition_id: {
    accepts: (value, ids) => typeof value === "string" && isCorroboratedConditionId(value, ids),
    description:
      "a condition id (0x and 62 or 64 lowercase hex digits) that the report's source index read as a market, or a labelled synthetic one",
  },
  event_slug: FEED_TEXT,
  icon: FEED_TEXT,
  is_combo: FEED_BOOLEAN,
  name: FEED_STRING,
  outcome: FEED_TEXT,
  outcome_index: FEED_INT32,
  price: FEED_NUMBER,
  profile_image: FEED_STRING,
  profile_image_optimized: FEED_STRING,
  proxy_wallet: FEED_STRING,
  pseudonym: FEED_STRING,
  side: feedEnum("BUY, SELL, IN, OUT or empty", "BUY", "SELL", "IN", "OUT", ""),
  size: FEED_NUMBER,
  slug: FEED_TEXT,
  timestamp: FEED_INT64,
  title: FEED_TEXT,
  token_id: {
    accepts: (value, ids) => typeof value === "string" && isCorroboratedTokenId(value, ids),
    description:
      "a token id (a decimal uint256) that the report read as a market, or a labelled synthetic value",
  },
  transaction_hash: FEED_STRING,
  type: feedEnum(`an activity type (${ACTIVITY_TYPES.join(", ")})`, ...ACTIVITY_TYPES),
  usdc_size: FEED_NUMBER,
};

/** S-O06 `components.schemas.Pagination`, typed (round 3). */
const FEED_PAGINATION_TYPES: Readonly<Record<string, FeedFieldType>> = {
  limit: FEED_INT32,
  offset: FEED_INT32,
  has_more: FEED_BOOLEAN,
  next_cursor: {
    accepts: (value) => value === null || typeof value === "string",
    description: "a string or null",
  },
};

/**
 * The query parameters S-O06 documents for `/v2/trades`, `/v2/activity` and
 * `/v2/activity/combos` (`paths.*.get.parameters`), with the combos page's
 * stated aliases `condition_id` and `conditionId`. `user` is documented but
 * refused (`captureUrlErrors`: a read keyed by a wallet).
 */
export const FEED_QUERY_PARAMETERS = [
  "condition",
  "condition_id",
  "conditionId",
  "cursor",
  "end",
  "event_id",
  "exclude_deposits_withdrawals",
  "filter_amount",
  "filter_type",
  "limit",
  "side",
  "sort_by",
  "sort_direction",
  "start",
  "taker_only",
  "type",
  "user",
] as const;

function isCursorParameter(key: string): boolean {
  return /cursor/i.test(key);
}

/** The feed routes (S-D26 lines 80-82), exactly. */
const FEED_URL_PATHS = ["/v2/trades", "/v2/activity", "/v2/activity/combos"];

/** One documented value type: a test, and its description for the refusal. */
interface FeedParameterType {
  readonly accepts: (value: string, ids: FeedMarketIds) => boolean;
  readonly description: string;
}

/** A comma-separated list of at most 20 distinct values, each accepted. */
function commaList(
  accepts: (item: string, ids: FeedMarketIds) => boolean,
): (value: string, ids: FeedMarketIds) => boolean {
  return (value, ids) => {
    const items = value.split(",");
    return new Set(items).size <= 20 && items.every((item) => accepts(item, ids));
  };
}

const enumOf =
  (...values: readonly string[]) =>
  (value: string): boolean =>
    values.includes(value);

const CONDITION_PARAMETER: FeedParameterType = {
  accepts: commaList(isCorroboratedConditionId),
  description:
    "condition ids (0x and 62 or 64 lowercase hex digits, at most 20, comma-separated), each one the report's source index read as a market, or a labelled synthetic value",
};

/**
 * The documented value type of each feed query parameter (S-O06
 * `paths./v2/trades|/v2/activity|/v2/activity/combos.get.parameters`, schema
 * and description), so that no value of another shape, a transaction hash
 * for example, rides on an allowed parameter (V2-9-R2-02). Fail closed: the
 * shapes are the narrowest the documentation states, and none admits a
 * hash-shaped run but a corroborated condition. `cursor` is checked by
 * `feedCursorErrors`; `user` is refused by `captureUrlErrors`.
 *
 * `start` and `end` are epoch seconds (`int64`), but S-O06 says the trades
 * feed honors them "on the `user` shape only" and the activity feed is
 * user-anchored ("Required"), and this gate refuses every `user` read. So a
 * committed bound changes no response, and any value but the documented
 * sentinels `0` ("floors to three years back" / "now plus one day") and
 * `1` ("full history") could only be a real block timestamp, which rule 6
 * replaces in the rows.
 */
const FEED_PARAMETER_TYPES: Readonly<Record<string, FeedParameterType>> = {
  condition: CONDITION_PARAMETER,
  condition_id: CONDITION_PARAMETER,
  conditionId: CONDITION_PARAMETER,
  end: { accepts: enumOf("0", "1"), description: "a documented sentinel, 0 or 1 (a committed bound is ignored on every URL this gate admits)" },
  event_id: {
    accepts: commaList((item) => /^[1-9][0-9]{0,18}$/.test(item)),
    description: "Gamma event ids (decimal integers of at most 19 digits, at most 20, comma-separated)",
  },
  exclude_deposits_withdrawals: { accepts: enumOf("true", "false"), description: "a boolean, true or false" },
  filter_amount: {
    accepts: (value) => /^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,6})?$/.test(value),
    description: "a decimal amount (at most 15 integer and 6 fraction digits)",
  },
  filter_type: { accepts: enumOf("CASH", "TOKENS"), description: "CASH or TOKENS" },
  limit: {
    accepts: (value) => /^(?:0|[1-9][0-9]{0,3})$/.test(value) && Number(value) <= 1000,
    description: "an integer from 0 to 1000",
  },
  side: { accepts: enumOf("BUY", "SELL"), description: "BUY or SELL" },
  sort_by: { accepts: enumOf("TIMESTAMP"), description: "TIMESTAMP (the only supported value)" },
  sort_direction: { accepts: enumOf("ASC", "DESC"), description: "ASC or DESC" },
  start: { accepts: enumOf("0", "1"), description: "a documented sentinel, 0 or 1 (a committed bound is ignored on every URL this gate admits)" },
  taker_only: { accepts: enumOf("true", "false"), description: "a boolean, true or false" },
  type: {
    accepts: commaList((item) => (ACTIVITY_TYPES as readonly string[]).includes(item)),
    description: `activity types S-O06 names (${ACTIVITY_TYPES.join(", ")}; at most 20, comma-separated)`,
  },
};

/**
 * The URL refusals of a trade or activity sidecar:
 *
 * - the URL is exactly `https://data-api.polymarket.com` and one feed route,
 *   in canonical form, with no fragment, credential or port (round 2);
 * - a query parameter S-O06 does not document for the feeds is refused, and
 *   a documented one must hold a value of its documented type
 *   (`FEED_PARAMETER_TYPES`, round 2), so no other value, a transaction hash
 *   for example, rides on the URL;
 * - each parameter occurs once (round 3; a server's handling of a repeated
 *   parameter is not assumed): every cursor parameter (any name containing
 *   `cursor`, every occurrence), at most one of them, is checked by
 *   `feedCursorErrors`;
 * - no other query value carries a hash-shaped run that is not a market id
 *   the report read (round 3), and none, nor the path or fragment, hides a
 *   venue cursor.
 *
 * Round 5, fail closed: a URL that does not parse is refused by name (it was
 * skipped), and so is a query key or value whose percent-encoding does not
 * decode strictly (WHATWG's `searchParams` decodes leniently, replacing a
 * malformed escape by U+FFFD), or whose cursor scan cannot decode it.
 */
export function feedUrlErrors(url: string, ids: FeedMarketIds = NO_MARKET_IDS): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [UNPARSEABLE_URL_ERROR];
  }
  const errors: string[] = [];
  for (const pair of parsed.search.slice(1).split("&")) {
    const failure = textReadings(pair.replace(/\+/g, " "), true).failure;
    if (failure !== undefined) {
      errors.push(undecodableError("sidecar.url query", failure));
      break;
    }
  }
  if (
    parsed.origin !== "https://data-api.polymarket.com" ||
    !FEED_URL_PATHS.includes(parsed.pathname) ||
    parsed.hash !== "" ||
    url.includes("#") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.href !== url
  ) {
    errors.push(
      "sidecar.url: a trade or activity URL is exactly https://data-api.polymarket.com, one of /v2/trades, /v2/activity or /v2/activity/combos, and a query, in canonical form: no other path segment, no fragment, no credential, no port",
    );
  }
  const keys = [...parsed.searchParams.keys()];
  const cursorKeys = keys.filter(isCursorParameter);
  if (cursorKeys.length > 1) {
    errors.push(
      `sidecar.url: ${cursorKeys.length} cursor parameters (${cursorKeys.join(", ")}); a trade or activity URL carries at most one`,
    );
  }
  for (const key of new Set(keys)) {
    const count = keys.filter((candidate) => candidate === key).length;
    if (count > 1 && !isCursorParameter(key)) {
      errors.push(
        `sidecar url ${key}: occurs ${count} times; a trade or activity URL carries each parameter once`,
      );
    }
  }
  for (const [key, value] of parsed.searchParams) {
    if (!(FEED_QUERY_PARAMETERS as readonly string[]).includes(key)) {
      errors.push(
        `sidecar url ${key}: not a query parameter S-O06 documents for /v2/trades or /v2/activity`,
      );
    }
    const type = Object.hasOwn(FEED_PARAMETER_TYPES, key) ? FEED_PARAMETER_TYPES[key] : undefined;
    if (isCursorParameter(key)) {
      errors.push(...feedCursorErrors(value, `sidecar url ${key}`));
    } else if (decodeFeedCursor(value) !== undefined || cursorLikeTokens(value).length > 0) {
      const failure = cursorScan(value).failure;
      errors.push(
        failure === undefined
          ? `sidecar url ${key}: the value decodes to a JSON object, as a venue cursor does; a trade or activity URL carries a cursor only as a labelled synthetic cursor parameter`
          : undecodableError(`sidecar url ${key} (cursor scan)`, failure),
      );
    } else if (type !== undefined && !type.accepts(value, ids)) {
      errors.push(
        `sidecar url ${key}: the value is not ${type.description} (S-O06); a value of another shape, a hash for example, may not ride on a trade or activity URL`,
      );
    } else if (type !== undefined && unexplainedHashRuns(value, ids).length > 0) {
      // Defense in depth: no documented type admits one. An undocumented
      // parameter is refused above whatever its value.
      errors.push(
        `sidecar url ${key}: the value carries a hash-shaped run (0x and 20 or more hex digits, or 20 or more bare hex or decimal digits) that is not a market id the report read`,
      );
    }
  }
  errors.push(
    ...cursorScanErrors(
      `${parsed.pathname} ${parsed.hash}`,
      "sidecar.url path or fragment",
      "sidecar.url: a path segment or fragment decodes to a venue cursor (S-O06); a trade or activity URL carries a cursor only as a labelled synthetic cursor parameter",
    ),
  );
  return errors;
}

// --- fixture envelopes (round 6) ----------------------------------------------

/**
 * V2-9-R6-01: the personal-data, cursor and long-id scan of a WP-000 fixture
 * envelope (`{fixture, source, retrieved, sanitized, notes, examples}`), the
 * rules captures and sidecars answer to (rule 5, and the round-6 cursor
 * scan), applied to every fixture-kind check by `index.ts`:
 *
 * - every envelope text (`fixture`, `source`, `retrieved`, `notes`, each
 *   example `name`) and every payload string and key, in every reading
 *   (`textReadings`; a text the scanner cannot decode fails by name): no
 *   email address, and no `0x` 40-hex address other than a labelled
 *   synthetic one or a documented public contract address;
 * - every payload: the personal keys (`scanPersonalData`), so a wallet,
 *   pseudonym, profile, email or user name holds a labelled synthetic value;
 * - the notes and every payload text: no personal field written with a
 *   value (`name: …`), and no token that decodes to a venue cursor (none is
 *   classified outside a capture's route);
 * - a value under a transaction-hash key (`transaction_hash`,
 *   `transactionHash`, `tx_hash`, `transactionsHashes`), at any depth: a
 *   labelled synthetic hash or empty;
 * - the notes, and every payload string with a space (prose): no hex id,
 *   hash or number of 40 or more digits that is not labelled synthetic,
 *   unless a payload carries it as a whole value (an id its payload spec and
 *   `assert` hook judge) or the check's report (`vouchingText`) records it.
 *
 * So a wallet, an email, a feed cursor or a transaction hash pasted into a
 * fixture's notes or payload prose fails the gate, as it does in a sidecar.
 */
export function fixturePersonalDataErrors(
  fixture: FixtureFile,
  publicAddresses: readonly string[],
  vouchingText: string,
): string[] {
  const errors: string[] = [];
  // The documented contract addresses, and those the check's report records
  // (the 2026-08-24 report records the V1 CTF contracts).
  const addresses = new Set([
    ...publicAddresses.map((address) => address.toLowerCase()),
    ...[...vouchingText.matchAll(ADDRESS_TOKEN_RE)].map(([address]) => address.toLowerCase()),
  ]);
  const policy: PersonalDataPolicy = { publicAddresses: addresses, feedRows: new Set(), dataApi: false };
  const payloadStrings = fixture.examples.flatMap((example) =>
    stringsWithPaths(example.payload, `examples ${example.name} payload`),
  );
  const wholeValues = new Set(
    payloadStrings.map(([, text]) => text).filter((text) => !/\s/.test(text)).map((text) => text.toLowerCase()),
  );
  const vouching = vouchingText.toLowerCase();
  const prose = (text: string): boolean => /\s/.test(text);
  const hasUnexplainedLongId = (readings: readonly string[]): boolean =>
    readings.some((reading) =>
      [...reading.matchAll(LONG_ID_TOKEN_RE)].some(([token]) => {
        const lower = token.toLowerCase();
        return (
          !isLabelledSyntheticHex(token, token.length - 2) &&
          !wholeValues.has(lower) &&
          !vouching.includes(lower)
        );
      }),
    );
  const scanText = (where: string, text: string, isProse: boolean): void => {
    const { readings, failure } = textReadings(text);
    if (failure !== undefined) {
      errors.push(undecodableError(where, failure));
    }
    errors.push(
      ...errorsOfReadings(readings, (reading) => [
        ...personalValueErrors(reading, where, addresses),
        ...personalAssignmentErrors(reading, where, false),
      ]),
    );
    if (isProse && hasUnexplainedLongId(readings)) {
      errors.push(
        `${where}: a hex id, hash or number of 40 or more digits that is not a labelled synthetic value, that no payload carries as a value and that the report does not record; name it by placeholder`,
      );
    }
    errors.push(...unclassifiedCursorErrors(text, where, ""));
  };
  scanText("fixture", fixture.fixture, false);
  scanText("source", fixture.source, false);
  scanText("retrieved", fixture.retrieved, false);
  scanText("notes", fixture.notes, true);
  for (const example of fixture.examples) {
    scanText(`examples ${example.name} name`, example.name, false);
    // The personal keys, and the decoded personal values of every string.
    scanPersonalData(example.payload, `examples ${example.name} payload`, errors, policy);
  }
  // A transaction hash names its sender on chain: under a transaction-hash
  // key, at any depth of any payload (not only a person's row), a value is a
  // labelled synthetic hash or empty. Every committed one is (0x00…0501).
  const hashKeyErrors = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => hashKeyErrors(entry, `${path}[${index}]`));
    } else if (isRecord(value)) {
      for (const [key, entry] of Object.entries(value)) {
        const where = `${path}.${key}`;
        if (/^(?:transactions?|tx)hash(?:es)?$/.test(normalizedKey(key))) {
          const values = Array.isArray(entry) ? entry : [entry];
          if (values.some((item) => item !== "" && item !== null && !isLabelledSyntheticHex(item, 64))) {
            errors.push(`${where}: a transaction hash must be a labelled synthetic hash (0x00…) or empty`);
          }
          continue;
        }
        hashKeyErrors(entry, where);
      }
    }
  };
  for (const example of fixture.examples) {
    hashKeyErrors(example.payload, `examples ${example.name} payload`);
  }
  for (const [where, text] of payloadStrings) {
    // Personal values are judged by `scanPersonalData` above.
    errors.push(
      ...errorsOfReadings(textReadings(text).readings, (reading) => personalAssignmentErrors(reading, where, false)),
    );
    if (prose(text) && hasUnexplainedLongId(textReadings(text).readings)) {
      errors.push(
        `${where}: a hex id, hash or number of 40 or more digits in prose that is not a labelled synthetic value, that no payload carries as a value and that the report does not record; name it by placeholder`,
      );
    }
    errors.push(...unclassifiedCursorErrors(text, where, ""));
  }
  return errors;
}

// --- the token rules of the generic walk (round 7) ------------------------------
//
// The orchestrator's 2026-10-08 directive: one generic walk (`tree-scan.ts`)
// reads every key and every string of every file in the fixture tree, at any
// depth, and runs each rule below on every reading of it. Each rule returns
// the exact tokens it refuses, so that the walk's allowlist can name a
// (file, JSON path, exact value) exception.

/** Every email address in one reading. */
export function emailTokens(reading: string): string[] {
  return [...reading.matchAll(new RegExp(EMAIL_RE.source, "g"))].map(([token]) => token);
}

/**
 * Every `0x` 40-hex address in one reading that is not a labelled synthetic
 * one (rule 5; a label glued before it does not hide it).
 */
export function unlabelledAddressTokens(reading: string): string[] {
  return [...reading.matchAll(ADDRESS_TOKEN_RE)]
    .map(([token]) => token)
    .filter((token) => !isLabelledSyntheticHex(token, 40));
}

/**
 * Every hash in one reading (round 7): `0x` and more than 40 hex digits (a
 * transaction hash, a condition id, a signature), or a bare run of 40 or more
 * hex digits holding a letter (a digest written without `0x`), that is not a
 * labelled synthetic value. A run of decimal digits alone is a decimal id or
 * a number, not a hash. Glued labels do not hide a hash.
 */
export function hashTokens(reading: string): string[] {
  const prefixed = [...reading.matchAll(/0[xX][0-9a-fA-F]{41,}(?![0-9a-fA-F])/g)]
    .map(([token]) => token)
    .filter((token) => !isLabelledSyntheticHex(token, token.length - 2));
  const bare = [...reading.matchAll(/(?<![0-9a-fA-F])(?<!0[xX])[0-9a-fA-F]{40,}(?![0-9a-fA-F])/g)]
    .map(([token]) => token)
    .filter((token) => /[a-fA-F]/.test(token) && !isLabelledSyntheticHex(`0x${token}`, token.length));
  return [...prefixed, ...bare];
}

/**
 * Every token of one reading that decodes to a venue cursor (`venueCursorType`:
 * a `sig`, or a `data` object with a `type` or `params`), whatever its type:
 * a JSON object written as text (the token is its span), or a base64,
 * base64url or hex run, decoded through a glued prefix or suffix (the token
 * is the run), as `cursorScan` reads them. The walk refuses each one unless
 * it is allowlisted (the committed `prices_history` cursors of S-A02, S-A03).
 */
export function venueCursorTokens(reading: string): string[] {
  const tokens = new Set<string>();
  if (reading.includes("{")) {
    for (const [span, object] of embeddedJsonSpans(reading)) {
      if (venueCursorType(object) !== undefined) {
        tokens.add(span);
      }
    }
  }
  for (const [run] of reading.matchAll(BASE64_RUN_RE)) {
    if (runJsonObjects(run).some((object) => venueCursorType(object) !== undefined)) {
      tokens.add(run);
    }
  }
  return [...tokens];
}

/** Whether a parsed object has the shape of a venue cursor (round 7, the walk). */
export function isVenueCursorShaped(value: unknown): boolean {
  return venueCursorType(value) !== undefined;
}

/**
 * Every personal field written with a value in one reading that is not a
 * labelled synthetic value, a `<placeholder>`, `null` or empty (the sidecar
 * prose rule, `PERSONAL_ASSIGNMENT_RE`): the whole assignment, as written.
 */
export function personalAssignmentTokens(reading: string): string[] {
  return [...reading.matchAll(PERSONAL_ASSIGNMENT_RE)]
    .filter((match) => !isProsePlaceholder(match[2] ?? ""))
    .map(([token]) => token);
}

/**
 * The personal-key refusals of one object (rule 5, without the Data API
 * `name` rule, which only a capture's route can apply): a personal key whose
 * value its rule does not allow, a wallet key that holds neither a string nor
 * `null`, and, when the object carries a personal key, a `name` or a
 * transaction hash that is not labelled synthetic. Each names the key.
 */
export function personalKeyFindings(
  record: Readonly<Record<string, unknown>>,
): { readonly key: string; readonly message: string }[] {
  const findings: { key: string; message: string }[] = [];
  const keys = Object.keys(record).map(normalizedKey);
  const personRow = keys.some((key) => PERSONAL_KEY_RULES.some((rule) => rule.applies(key)));
  for (const [key, entry] of Object.entries(record)) {
    const normalized = normalizedKey(key);
    const rule =
      PERSONAL_KEY_RULES.find((candidate) => candidate.applies(normalized)) ??
      (personRow ? PERSON_ROW_RULES.find((candidate) => candidate.applies(normalized)) : undefined);
    if (normalized.includes("wallet") && typeof entry !== "string" && entry !== null) {
      findings.push({
        key,
        message: "a wallet key holds neither an address string nor null, so the scanner cannot judge it",
      });
    }
    if (rule !== undefined && !rule.allows(entry)) {
      findings.push({ key, message: rule.message });
    }
  }
  return findings;
}

/**
 * The JSON objects a text embeds with their spans (see `embeddedJsonObjects`):
 * every `{…}` span `JSON.parse` reads as an object with a key.
 */
function embeddedJsonSpans(text: string): [string, Record<string, unknown>][] {
  const found: [string, Record<string, unknown>][] = [];
  const opens: number[] = [];
  const closes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "{") {
      opens.push(index);
    } else if (text[index] === "}") {
      closes.push(index);
    }
  }
  for (const open of opens) {
    for (const close of closes) {
      if (close <= open) {
        continue;
      }
      const span = text.slice(open, close + 1);
      try {
        const value: unknown = JSON.parse(span);
        if (isRecord(value) && Object.keys(value).length > 0) {
          found.push([span, value]);
        }
      } catch {
        // not one JSON object at this span
      }
    }
  }
  return found;
}

/** Every string of a parsed JSON value (keys included), with its path (round 6). */
function stringsWithPaths(value: unknown, path: string, into: [string, string][] = []): [string, string][] {
  if (typeof value === "string") {
    into.push([path, value]);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => stringsWithPaths(entry, `${path}[${index}]`, into));
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      into.push([`${path} key`, key]);
      stringsWithPaths(entry, `${path}.${key}`, into);
    }
  }
  return into;
}

/** Every string of a parsed JSON value (keys included). */
function collectStrings(value: unknown, into: string[]): string[] {
  if (typeof value === "string") {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) {
      collectStrings(entry, into);
    }
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      into.push(key);
      collectStrings(entry, into);
    }
  }
  return into;
}

/**
 * Rule 6: the trade and activity feed refusals. `ids`: the market ids the
 * report corroborates (`CaptureContext.marketConditionIds` and
 * `marketTokenIds`). `captureText`: the capture's bytes as text, whose
 * numbers and escapes the parsed view no longer shows.
 */
export function feedErrors(
  view: unknown,
  sidecar: CaptureSidecar,
  ids: FeedMarketIds = NO_MARKET_IDS,
  captureText = "",
): string[] {
  const errors: string[] = [];
  const rows = isRecord(view) ? view["data"] : undefined;
  if (!isRecord(view) || !Array.isArray(rows)) {
    return ["$.data: a trade or activity capture must carry its data[] rows"];
  }
  for (const key of Object.keys(view)) {
    if (!FEED_PAGE_FIELDS.includes(key)) {
      errors.push(`$.${key}: not a field of a trade or activity page (S-O06: data, pagination)`);
    }
  }
  rows.forEach((row, index) => {
    const where = `$.data[${index}]`;
    if (!isRecord(row)) {
      errors.push(`${where}: a feed row must be an object`);
      return;
    }
    for (const [key, entry] of Object.entries(row)) {
      if (!(FEED_ROW_FIELDS as readonly string[]).includes(key)) {
        errors.push(
          `${where}.${key}: not a Trade or Activity field (S-O06); an unrecognized field may carry personal data, so classify it in FEED_ROW_FIELDS, with its source, before committing it`,
        );
        continue;
      }
      if (entry !== null && typeof entry === "object") {
        errors.push(`${where}.${key}: a feed-row field must be a scalar (S-O06 rows are flat)`);
        continue;
      }
      const type = FEED_ROW_FIELD_TYPES[key as (typeof FEED_ROW_FIELDS)[number]];
      if (!type.accepts(entry, ids)) {
        errors.push(`${where}.${key}: not ${type.description} (S-O06 types the field so)`);
      }
      if (typeof entry === "string") {
        errors.push(
          ...cursorScanErrors(entry, `${where}.${key}`, `${where}.${key}: a token decodes to a venue cursor (S-O06)`),
        );
      }
    }
    // The row's wallet, pseudonym, profile, name and transaction hash are
    // refused by the personal-data scan (rule 5): a feed row is a person's
    // row. `name` and `transaction_hash` are generic keys elsewhere (a
    // resolution's transaction is public).
  });
  const pagination = view["pagination"];
  if (!isRecord(pagination)) {
    errors.push("$.pagination: a trade or activity page carries its pagination object (S-O06: required)");
  } else {
    for (const [key, entry] of Object.entries(pagination)) {
      const type = Object.hasOwn(FEED_PAGINATION_TYPES, key) ? FEED_PAGINATION_TYPES[key] : undefined;
      if (type === undefined) {
        errors.push(`$.pagination.${key}: not a Pagination field (S-O06: limit, offset, has_more, next_cursor)`);
        continue;
      }
      if (entry !== null && typeof entry === "object") {
        errors.push(`$.pagination.${key}: a Pagination field must be a scalar (S-O06)`);
        continue;
      }
      if (!type.accepts(entry, ids)) {
        errors.push(`$.pagination.${key}: not ${type.description} (S-O06 types the field so)`);
      }
      // `next_cursor` has its own rules (`feedCursorErrors`, below).
      if (key !== "next_cursor" && typeof entry === "string") {
        errors.push(
          ...cursorScanErrors(
            entry,
            `$.pagination.${key}`,
            `$.pagination.${key}: a token decodes to a venue cursor (S-O06)`,
          ),
        );
      }
    }
  }
  const cursor = isRecord(pagination) ? pagination["next_cursor"] : undefined;
  errors.push(...feedCursorErrors(cursor, "$.pagination.next_cursor"));
  // The bytes: a hash-shaped run outside every string (a number of 20 or
  // more digits) or written with escapes, which the typed fields above do
  // not see.
  const stringRuns = new Set(
    collectStrings(view, []).flatMap((text) =>
      [...text.normalize("NFKC").matchAll(HASH_RUN_RE)].map(([run]) => run),
    ),
  );
  if (unexplainedHashRuns(captureText, ids).some((run) => !stringRuns.has(run))) {
    errors.push(
      "bytes: a hash-shaped run (20 or more hex or decimal digits) outside every string or behind an escape, which no S-O06 field type admits",
    );
  }
  errors.push(...feedUrlErrors(sidecar.url, ids));
  // A page with nothing to replace (no row, no cursor) may be the raw body;
  // the kind rules then require it to equal the raw response byte for byte.
  if (rows.length > 0 || typeof cursor === "string") {
    const subjects = new Set(sidecar.redactions.flatMap(redactionSubjects));
    for (const required of ["timestamp", "next_cursor"]) {
      if (!subjects.has(required)) {
        errors.push(
          `sidecar redactions: a trade or activity page with rows or a cursor must list ${required} (report §15)`,
        );
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
  /**
   * Documented public contract addresses a capture or sidecar may carry as
   * `0x` 40-hex values (rule 5). Any other 40-hex address must be a labelled
   * synthetic value. Absent: none.
   */
  readonly publicAddresses?: readonly string[];
  /**
   * The condition ids the report's source index read as a market
   * (`marketReadConditionIds`): a trade or activity URL's `condition` value
   * must be one of these, a row's `condition_id`, or labelled synthetic
   * (rule 6, round 2). Round 3: a trade or activity row's `condition_id`
   * too, and a row no longer corroborates the URL. Absent: none.
   */
  readonly marketConditionIds?: readonly string[];
  /**
   * The token ids the report read as a market (`marketReadTokenIds` and
   * `catalogueTokenIds`): a trade or activity row's `token_id` must be one of
   * these or labelled synthetic (rule 6, round 3). Absent: none.
   */
  readonly marketTokenIds?: readonly string[];
}

export interface CaptureValidationResult {
  readonly relativePath: string;
  readonly sidecarPath: string;
  readonly ok: boolean;
  readonly errors: readonly string[];
  /** The parsed view the pins read (`null` when the capture did not parse). */
  readonly view: unknown;
  /**
   * The token ids this capture carries as a report-anchored CLOB market read
   * (`anchoredMarketTokenIds`), when it passed every check (round 3).
   */
  readonly marketTokenIds?: readonly string[];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The keys that occur twice in one object of a JSON text (which must already
 * parse). `JSON.parse` keeps only the last value of a repeated key, so an
 * earlier one, a live wallet or a venue cursor for example, would sit in the
 * committed bytes and escape every check of the parsed view. RFC 8259 §4: the
 * names within an object SHOULD be unique.
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

/**
 * The `.jsonl` data texts that are not JSON and that the scanner knows
 * (round 5; `protocol-v2/README.md`: `data` is the frame text as received,
 * `PING` and `PONG` included): a `PING` or `PONG` heartbeat sent or
 * received, the market channel's URL on the `open` record, and a
 * `local-close` reason word (`timer`). Any other text that is not JSON
 * fails closed: it was scanned only as raw text.
 */
function isKnownControlText(dir: unknown, data: string): boolean {
  switch (dir) {
    case "send":
    case "recv":
      return data === "PING" || data === "PONG";
    case "open":
      return data === "wss://ws-subscriptions-clob.polymarket.com/ws/market";
    case "local-close":
      return /^[a-z]{1,16}(?:-[a-z]{1,16}){0,3}$/.test(data);
    default:
      return false;
  }
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
    for (const key of duplicateKeys(jsonText)) {
      errors.push(
        `${where}: the key ${JSON.stringify(key)} occurs twice in one object; JSON.parse keeps only the last value, so an earlier one would escape every check`,
      );
    }
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
    const recordErrors: string[] = [];
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
      recordErrors,
    );
    errors.push(...recordErrors);
    if (!isRecord(record)) {
      return;
    }
    const data = record["data"];
    let frame: unknown;
    if (typeof data === "string") {
      try {
        frame = JSON.parse(data);
      } catch {
        frame = undefined;
      }
      if (frame !== undefined) {
        refuseDuplicates(data, `line ${index + 1} frame`);
      } else if (!isKnownControlText(record["dir"], data)) {
        errors.push(
          `line ${index + 1}: the data text is neither a JSON frame nor a known control message (PING or PONG; the open record's market-channel URL; a local-close reason word), so the scanner cannot parse it and the gate fails closed (round 5)`,
        );
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
  const result = (
    view: unknown,
    marketTokenIds: readonly string[] = [],
  ): CaptureValidationResult => ({
    relativePath: spec.fixture,
    sidecarPath,
    ok: errors.length === 0,
    errors,
    view,
    marketTokenIds: errors.length === 0 ? marketTokenIds : [],
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
  const sidecarErrors: string[] = [];
  for (const key of duplicateKeys(sidecarText)) {
    sidecarErrors.push(
      `${sidecarPath}: the key ${JSON.stringify(key)} occurs twice in one object; JSON.parse keeps only the last value, so an earlier one would escape every check`,
    );
  }
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
  // Round 4: the catalogue's source id, not the sidecar's, names the report
  // row whose URL binds the route and selects the feed rules.
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

  // 5. Credentials and personal data, everywhere: the capture and the
  //    sidecar's text.
  const feed = isFeedCapture(sidecar.url, view, reportRow?.url);
  const feedRows = isRecord(view) && Array.isArray(view["data"]) ? view["data"] : [];
  const policy: PersonalDataPolicy = {
    publicAddresses: new Set(
      (context.publicAddresses ?? []).map((address) => address.toLowerCase()),
    ),
    feedRows: new Set<unknown>(feed ? feedRows : []),
    dataApi: [sidecar.url, reportRow?.url ?? ""].some((url) =>
      url.startsWith("https://data-api.polymarket.com/"),
    ),
  };
  scanForCredentials(view, "$", errors);
  scanPersonalData(personalScanTarget(view, spec.format), "$", errors, policy);
  errors.push(
    ...sidecarPersonalDataErrors(
      sidecar,
      new TextDecoder("utf-8").decode(fixtureBytes),
      feed,
      policy.publicAddresses,
    ),
  );

  // 6. Trade and activity feeds.
  const marketIds: FeedMarketIds = {
    conditionIds: new Set((context.marketConditionIds ?? []).map((id) => id.toLowerCase())),
    tokenIds: new Set(context.marketTokenIds ?? []),
  };
  if (feed) {
    errors.push(
      ...feedErrors(view, sidecar, marketIds, new TextDecoder("utf-8").decode(fixtureBytes)),
    );
  } else {
    // Round 6 (V2-9-R6-02): outside the feeds, the report vouches for the
    // URL's identifiers, and no capture string hides a venue cursor that is
    // not a classified public market cursor.
    errors.push(...nonFeedUrlErrors(sidecar.url, reportRow, marketIds));
    // A string that cannot be decoded is named once, by the personal scan.
    for (const [where, text] of stringsWithPaths(personalScanTarget(view, spec.format), "$")) {
      errors.push(...unclassifiedCursorErrors(text, where, urlRouteOf(sidecar.url)));
    }
  }

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
  return result(view, anchoredMarketTokenIds(sidecar, view, marketIds.conditionIds));
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
  let sidecarBytes: Uint8Array;
  try {
    bytes = readFileSync(resolve(root, spec.fixture));
    sidecarBytes = readFileSync(resolve(root, sidecarPath));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(`failed to read the capture or its sidecar: ${message}`);
  }
  // Round 5, fail closed: the sidecar is decoded strictly (a lenient read
  // replaced an invalid byte by U+FFFD, which no rule judges); a byte-order
  // mark is kept, so `JSON.parse` refuses it as before.
  let sidecarText: string;
  try {
    sidecarText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(sidecarBytes);
  } catch {
    return failed(
      `${sidecarPath}: the sidecar is not valid UTF-8, so the scanner cannot decode it and the gate fails closed (round 5)`,
    );
  }
  return validateCapture(spec, bytes, sidecarText, context);
}
