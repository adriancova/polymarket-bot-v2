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
 *    wallet.
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
 * 6. **Trade and activity feeds** (Data API `/v2/trades`, `/v2/activity…`,
 *    or any capture whose `data` rows carry a wallet), report §15:
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

/** The refusals of a sidecar URL's host and route. */
export function captureUrlErrors(url: string): string[] {
  if (!CAPTURE_URL_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return [`sidecar.url: not an official public Polymarket host: ${url}`];
  }
  if (!url.startsWith("https://")) {
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
      if (WALLET_QUERY_KEYS.includes(key.toLowerCase())) {
        errors.push(`sidecar.url: a Data API read keyed by a wallet (${key}=) may not be committed`);
      }
    }
  }
  return errors;
}

/** Query parameters that key a Data API read by an account. */
const WALLET_QUERY_KEYS = ["user", "address", "proxy_wallet", "wallet"];

const SHA256_RE = /^[0-9a-f]{64}$/;
const FETCHED_UTC_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}Z)$/;
const HTTP_STATUS_RE = /^(?:\d{3}|WS)$/;

/** The `.jsonl` record directions (`protocol-v2/README.md`). */
const JSONL_DIRECTIONS = ["open", "send", "recv", "local-close", "close"];

/** `<stem>.jsonc` or `<stem>.jsonl` (or `.json`) → `<stem>.provenance.jsonc`. */
export function sidecarPathOf(fixture: string): string {
  return fixture.replace(/\.(?:jsonc|jsonl|json)$/, ".provenance.jsonc");
}

// --- the report -------------------------------------------------------------

/** One row of the report's source index (§14). */
export interface SourceIndexRow {
  readonly id: string;
  readonly time: string;
  readonly http: string;
  readonly bytes: number;
  readonly sha256: string;
}

const SOURCE_INDEX_ROW_RE =
  /^\| (S-[A-Z]+\d+) \| `[^`]*` \| (\d{2}:\d{2}:\d{2}Z) \| (\d{3}|WS) \| (\d+) \| `([0-9a-f]{64})` \|/gm;

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
      time: match[2] as string,
      http: match[3] as string,
      bytes: Number(match[4]),
      sha256: match[5] as string,
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
 * value must be one of these, a labelled synthetic value, or a row's
 * `condition_id` (V2-9 round 2): so a hash of another kind, a transaction
 * hash for example, cannot ride on the URL as a condition. Lowercased.
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
//   included, after NFKC normalization): no email address, and no `0x` 40-hex
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

/** A `0x` 40-hex token (an address), not part of a longer hex run. */
const ADDRESS_TOKEN_RE = /(?<![0-9A-Za-z_])0[xX][0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/**
 * A long id in prose: `0x` and more than 40 hex digits (an id or a hash), or
 * 40 or more bare hex or decimal digits (an unprefixed address or hash, a
 * position id).
 */
const LONG_ID_TOKEN_RE =
  /(?<![0-9A-Za-z_])(?:0[xX][0-9a-fA-F]{41,}|[0-9a-fA-F]{40,})(?![0-9a-fA-F])/g;

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
    errors.push(...personalValueErrors(value, path, policy.publicAddresses));
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
    errors.push(...personalValueErrors(key, `${path} key`, policy.publicAddresses));
    const rule =
      PERSONAL_KEY_RULES.find((candidate) => candidate.applies(normalized)) ??
      (personRow || (policy.dataApi && normalized === "name")
        ? PERSON_ROW_RULES.find((candidate) => candidate.applies(normalized))
        : undefined);
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
 * group 2 the value token.
 */
const PERSONAL_ASSIGNMENT_RE = new RegExp(
  `(?<![\\w-])(proxy[_-]?wallet|wallet|x[_-]?user[_-]?name|user[_-]?name|display[_-]?name|screen[_-]?name|handle|user|address|name|pseudonym|bio|profile[_-]?image(?:[_-]?optimized)?|e-?mail|transaction[_-]?hash|tx[_-]?hash)["']?\\s*[:=]\\s*("(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s,;)\\]}&#]*)`,
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

function personalAssignmentErrors(text: string, where: string): string[] {
  const errors: string[] = [];
  for (const match of text.normalize("NFKC").matchAll(PERSONAL_ASSIGNMENT_RE)) {
    if (!isProsePlaceholder(match[2] ?? "")) {
      errors.push(
        `${where}: ${(match[1] ?? "").toLowerCase()} is written with a value that is not a labelled synthetic value, a <placeholder> or empty`,
      );
    }
  }
  return errors;
}

/** Decodes every run of percent-escapes that decodes; leaves the rest. */
function decodePercentEscapes(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * Whether a text embeds a non-empty JSON object anywhere in it: a `{`, and a
 * later `}`, whose span `JSON.parse` reads as an object with a key. Garbage
 * before or after the object (a glued prefix, the tail of a decoded run) does
 * not hide it. `{}` is not counted, so random decoded bytes do not match.
 */
function embedsJsonObject(text: string): boolean {
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
          return true;
        }
      } catch {
        // not one JSON object at this span
      }
    }
  }
  return false;
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
  if (decodeFeedCursor(run) !== undefined) {
    return true;
  }
  for (let offset = 0; offset < 4; offset += 1) {
    if (embedsJsonObject(Buffer.from(run.slice(offset), "base64").toString("utf8"))) {
      return true;
    }
  }
  for (const [hexRun] of run.matchAll(HEX_RUN_RE)) {
    for (let offset = 0; offset < 2; offset += 1) {
      if (embedsJsonObject(Buffer.from(hexRun.slice(offset), "hex").toString("utf8"))) {
        return true;
      }
    }
  }
  return false;
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
 * Not caught: a cursor split across tokens or otherwise transformed (the
 * README's "What the gate cannot check").
 */
export function cursorLikeTokens(text: string): string[] {
  const nfkc = text.normalize("NFKC");
  const readings = new Set([text, nfkc, decodePercentEscapes(text), decodePercentEscapes(nfkc)]);
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
  return [...tokens];
}

function safeDecodeUri(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * Rule 5 for the sidecar: its free text (`url`, `notes`, each redaction,
 * `extract.rule`); see the policy above. A redaction's subject list, before
 * its first colon, names fields and is not a value.
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
  const decodedUrl = safeDecodeUri(sidecar.url);
  errors.push(
    ...personalValueErrors(decodedUrl, "sidecar.url", publicAddresses),
    ...personalAssignmentErrors(decodedUrl, "sidecar.url"),
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
    errors.push(...personalValueErrors(text, where, publicAddresses));
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
    errors.push(...personalAssignmentErrors(values, where));
    if (feed && cursorLikeTokens(text).length > 0) {
      errors.push(
        `${where}: a token decodes to a venue cursor, which carries the seek anchor of the last row (S-O06); name a cursor by its labelled synthetic value`,
      );
    }
  }
  return errors;
}

const FEED_ROUTE_RE =
  /^https:\/\/data-api\.polymarket\.com\/v2\/(?:trades|activity)(?:[/?]|$)/;

/**
 * A trade or activity feed capture: its URL is a Data API feed route
 * (S-D26 lines 80-82: `/v2/trades`, `/v2/activity`, `/v2/activity/combos`),
 * or its `data` rows carry a wallet or pseudonym, as feed rows do.
 */
export function isFeedCapture(url: string, view: unknown): boolean {
  if (FEED_ROUTE_RE.test(url)) {
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
 * v2 OpenAPI, report §14), every one a scalar. Their personal fields
 * (`proxy_wallet`, `name`, `pseudonym`, `bio`, `profile_image`,
 * `profile_image_optimized`, `transaction_hash`) must hold labelled synthetic
 * values (rules 5 and 6). A field outside this list is refused: it may carry
 * personal data (an email, a nested profile). Fail closed: the package that
 * captures a new field classifies it here, with its source. `ComboActivity`
 * rows (`/v2/activity/combos`, nested legs) are not classified, so are
 * refused.
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

/** S-O06 `TradesPage`, `ActivityPage`: `{ data, pagination }`. */
const FEED_PAGE_FIELDS = ["data", "pagination"];

/** S-O06 `components.schemas.Pagination`. */
const FEED_PAGINATION_FIELDS = ["limit", "offset", "has_more", "next_cursor"];

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

/** A condition id: `0x` and 62 hex digits (bytes31), or 64 (padded). */
const CONDITION_ID_RE = /^0x[0-9a-f]{62}(?:[0-9a-f]{2})?$/;

/** What a feed URL's `condition` value may be checked against. */
interface FeedUrlContext {
  /** Lowercased condition ids the report read as a market, or a row carries. */
  readonly knownConditionIds: ReadonlySet<string>;
}

/** One documented value type: a test, and its description for the refusal. */
interface FeedParameterType {
  readonly accepts: (value: string, context: FeedUrlContext) => boolean;
  readonly description: string;
}

/** A comma-separated list of at most 20 distinct values, each accepted. */
function commaList(
  accepts: (item: string, context: FeedUrlContext) => boolean,
): (value: string, context: FeedUrlContext) => boolean {
  return (value, context) => {
    const items = value.split(",");
    return new Set(items).size <= 20 && items.every((item) => accepts(item, context));
  };
}

const enumOf =
  (...values: readonly string[]) =>
  (value: string): boolean =>
    values.includes(value);

const CONDITION_PARAMETER: FeedParameterType = {
  accepts: commaList(
    (item, context) =>
      CONDITION_ID_RE.test(item) &&
      (isLabelledSyntheticHex(item, item.length - 2) || context.knownConditionIds.has(item)),
  ),
  description:
    "condition ids (0x and 62 or 64 lowercase hex digits, at most 20, comma-separated), each one the report's source index read as a market, one a row carries as condition_id, or a labelled synthetic value",
};

/**
 * The documented value type of each feed query parameter (S-O06
 * `paths./v2/trades|/v2/activity|/v2/activity/combos.get.parameters`, schema
 * and description), so that no value of another shape, a transaction hash
 * for example, rides on an allowed parameter (V2-9-R2-02). Fail closed: the
 * shapes are the narrowest the documentation states. `cursor` is checked by
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
    accepts: commaList((item) => /^[A-Z]+(?:_[A-Z]+)*$/.test(item)),
    description: "activity type names (upper-case words such as TRADE or REDEEM, at most 20, comma-separated)",
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
 * - every cursor parameter (any name containing `cursor`, every occurrence),
 *   at most one of them, is checked by `feedCursorErrors`;
 * - no other query value, path segment or fragment hides a venue cursor.
 *
 * A server's handling of a repeated parameter is not assumed.
 */
export function feedUrlErrors(
  url: string,
  knownConditionIds: ReadonlySet<string> = new Set(),
): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const errors: string[] = [];
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
  const cursorKeys = [...parsed.searchParams.keys()].filter(isCursorParameter);
  if (cursorKeys.length > 1) {
    errors.push(
      `sidecar.url: ${cursorKeys.length} cursor parameters (${cursorKeys.join(", ")}); a trade or activity URL carries at most one`,
    );
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
      errors.push(
        `sidecar url ${key}: the value decodes to a JSON object, as a venue cursor does; a trade or activity URL carries a cursor only as a labelled synthetic cursor parameter`,
      );
    } else if (type !== undefined && !type.accepts(value, { knownConditionIds })) {
      errors.push(
        `sidecar url ${key}: the value is not ${type.description} (S-O06); a value of another shape, a hash for example, may not ride on a trade or activity URL`,
      );
    }
  }
  if (cursorLikeTokens(`${parsed.pathname} ${parsed.hash}`).length > 0) {
    errors.push(
      "sidecar.url: a path segment or fragment decodes to a venue cursor (S-O06); a trade or activity URL carries a cursor only as a labelled synthetic cursor parameter",
    );
  }
  return errors;
}

/**
 * Rule 6: the trade and activity feed refusals. `marketConditionIds`: the
 * condition ids the report's source index read as a market
 * (`CaptureContext.marketConditionIds`).
 */
export function feedErrors(
  view: unknown,
  sidecar: CaptureSidecar,
  marketConditionIds: readonly string[] = [],
): string[] {
  const errors: string[] = [];
  const rows = isRecord(view) ? view["data"] : undefined;
  if (!Array.isArray(rows)) {
    return ["$.data: a trade or activity capture must carry its data[] rows"];
  }
  for (const key of Object.keys(view as Record<string, unknown>)) {
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
      } else if (entry !== null && typeof entry === "object") {
        errors.push(`${where}.${key}: a feed-row field must be a scalar (S-O06 rows are flat)`);
      } else if (typeof entry === "string" && cursorLikeTokens(entry).length > 0) {
        errors.push(`${where}.${key}: a token decodes to a venue cursor (S-O06)`);
      }
    }
    // The row's wallet, pseudonym, profile, name and transaction hash are
    // refused by the personal-data scan (rule 5): a feed row is a person's
    // row. `name` and `transaction_hash` are generic keys elsewhere (a
    // resolution's transaction is public).
  });
  const pagination = isRecord(view) ? view["pagination"] : undefined;
  if (isRecord(pagination)) {
    for (const [key, entry] of Object.entries(pagination)) {
      if (!FEED_PAGINATION_FIELDS.includes(key)) {
        errors.push(`$.pagination.${key}: not a Pagination field (S-O06: limit, offset, has_more, next_cursor)`);
      } else if (entry !== null && typeof entry === "object") {
        errors.push(`$.pagination.${key}: a Pagination field must be a scalar (S-O06)`);
      }
    }
  }
  const cursor = isRecord(pagination) ? pagination["next_cursor"] : undefined;
  errors.push(...feedCursorErrors(cursor, "$.pagination.next_cursor"));
  const knownConditionIds = new Set(marketConditionIds.map((id) => id.toLowerCase()));
  for (const row of rows) {
    const conditionId = isRecord(row) ? row["condition_id"] : undefined;
    if (typeof conditionId === "string") {
      knownConditionIds.add(conditionId.toLowerCase());
    }
  }
  errors.push(...feedUrlErrors(sidecar.url, knownConditionIds));
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
   * (rule 6, round 2). Absent: none.
   */
  readonly marketConditionIds?: readonly string[];
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
  const feed = isFeedCapture(sidecar.url, view);
  const feedRows = isRecord(view) && Array.isArray(view["data"]) ? view["data"] : [];
  const policy: PersonalDataPolicy = {
    publicAddresses: new Set(
      (context.publicAddresses ?? []).map((address) => address.toLowerCase()),
    ),
    feedRows: new Set<unknown>(feed ? feedRows : []),
    dataApi: sidecar.url.startsWith("https://data-api.polymarket.com/"),
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
  if (feed) {
    errors.push(...feedErrors(view, sidecar, context.marketConditionIds));
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
