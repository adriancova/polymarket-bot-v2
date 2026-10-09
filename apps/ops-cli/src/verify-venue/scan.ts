/**
 * V2-9: the personal-data and credential scan of every file under
 * `test/fixtures/venue/` (`README.md` excepted): captures, sidecars and
 * fixture envelopes alike.
 *
 * The threat model: an ACCIDENTAL commit of obvious personal data or a
 * credential by a trusted author, whose fixtures are also reviewed in the
 * pull request. Deliberate obfuscation (an encoded, split or disguised value,
 * an unusual mailbox syntax) is out of scope; PR review covers the rest.
 *
 * Each file is read with a fatal UTF-8 decode and `JSON.parse` (one document,
 * or one per `.jsonl` line), with no key repeated in one object. Then every
 * key and every string, at any depth, answers to three patterns (a string
 * that is itself JSON text, a WebSocket frame for example, is parsed and
 * walked instead):
 * - **email**: an email address;
 * - **hex**: 40 or more hex digits (a wallet, a transaction hash), unless it is
 *   labelled synthetic (`0x00…`), the whole value under a public-id key
 *   (`PUBLIC_ID_KEYS`), text the venue reports contain, or in `PUBLIC_VALUES`;
 * - **cursor**: a base64url JSON object (`eyJ…`, glued or not) that is not a
 *   public `prices_history` cursor: a trade or activity cursor carries the
 *   seek anchor of a feed's last row (S-O06).
 * And every object answers to:
 * - **credential**: a credential-shaped key holds a sanitized placeholder;
 * - **personal keys** (`PERSONAL_KEY_RULES`) hold labelled synthetic or empty
 *   values, and an object carrying one is a person's row, whose `name` and
 *   transaction hash do too (`PERSON_ROW_RULES`).
 *
 * Offline: local files only. No network, no credential, no order.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  duplicateKeyError,
  duplicateKeys,
  isLabelledSyntheticHex,
  isLabelledSyntheticText,
  normalizedKey,
} from "./captures.js";
import {
  VENUE_FIXTURE_ROOT,
  isCredentialShapedKey,
  isRecord,
  isSanitizedPlaceholder,
} from "./fixtures.js";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const HEX_RE = /(?:0x)?[0-9a-f]{40,}(?![0-9a-f])/gi;
const CURSOR_RE = /eyJ[A-Za-z0-9_-]{16,}/g;

/**
 * Keys whose whole value is a public market or content id: a condition,
 * question or book hash, or a fixture's own digest.
 */
const PUBLIC_ID_KEYS = new Set([
  "market", "conditionid", "questionid", "hash", "fixturesha256", "conditionidbytes32",
]);

/** Public hex values that neither the reports nor a public-id key vouch for. */
export const PUBLIC_VALUES: readonly { readonly value: string; readonly reason: string }[] = [
  {
    value: "0x3f8f1bc229eb5740645a6df7037adec23d95a3cb0c0236bbe22cd62331b89a00",
    reason: "the on-chain resolution transaction of the V1 window in protocol-v2/data-v2-resolutions-v1-resolved.jsonc (S-A10): an oracle's report, not a trader's",
  },
];

interface PersonalKeyRule {
  readonly applies: (normalized: string) => boolean;
  readonly allows: (value: unknown) => boolean;
  readonly message: string;
}

const isBlankOrSynthetic = (value: unknown): boolean =>
  value === "" || value === null || isLabelledSyntheticText(value);

/** Personal keys, anywhere; each also makes its object a person's row. */
export const PERSONAL_KEY_RULES: readonly PersonalKeyRule[] = [
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
    applies: (key) =>
      key.endsWith("username") || key === "displayname" || key === "screenname" || key === "handle",
    allows: isBlankOrSynthetic,
    message: "a user name or handle must be empty or a labelled synthetic value (synthetic-…)",
  },
];

/** The keys of a person's row: S-O06 uses `name` for the wallet's display name. */
export const PERSON_ROW_RULES: readonly PersonalKeyRule[] = [
  {
    applies: (key) => key === "name",
    allows: isLabelledSyntheticText,
    message: "a name in a person's row must be a labelled synthetic value (synthetic-…)",
  },
  {
    applies: (key) => key === "transactionhash" || key === "txhash",
    allows: (value) => isLabelledSyntheticHex(value, 64),
    message: "a transaction hash in a person's row must be a labelled synthetic hash (0x00…)",
  },
];

/** The type a token decodes to as a venue cursor, or `undefined` when it decodes to no JSON. */
function cursorType(token: string): string | undefined {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    const data = isRecord(decoded) ? decoded["data"] : undefined;
    const type = isRecord(data) ? data["type"] : undefined;
    return typeof type === "string" ? type : "(none)";
  } catch {
    return undefined;
  }
}

/** The pattern refusals of one key or string; `key`: its normalized key, for a whole value. */
function textErrors(text: string, where: string, key: string, known: string): string[] {
  const errors: string[] = [];
  if (text.includes("@") && EMAIL_RE.test(text)) {
    errors.push(`${where}: an email address may not be committed (personal data)`);
  }
  for (const [token] of text.matchAll(HEX_RE)) {
    const lower = token.toLowerCase();
    const allowed =
      (!lower.startsWith("0x") && !/[a-f]/.test(lower)) || // a decimal id (a token or position id)
      /^0x0+[0-9a-f]{1,8}$/.test(lower) ||
      (token === text && PUBLIC_ID_KEYS.has(key)) ||
      known.includes(lower) ||
      PUBLIC_VALUES.some((entry) => entry.value === lower);
    if (!allowed) {
      errors.push(`${where}: a hex value of 40 or more digits that is not labelled synthetic (0x00…), a public id or in the venue report; it may be a wallet or a transaction hash`);
      break;
    }
  }
  for (const [token] of text.matchAll(CURSOR_RE)) {
    const type = cursorType(token);
    if (type !== undefined && type !== "prices_history") {
      errors.push(`${where}: a token that decodes to a venue cursor (type ${type}), which may carry the seek anchor of a feed's last row (S-O06)`);
      break;
    }
  }
  return errors;
}

/** The credential and personal-key refusals of one object. */
function objectErrors(record: Readonly<Record<string, unknown>>, path: string): string[] {
  const errors: string[] = [];
  const keys = Object.keys(record).map(normalizedKey);
  const personRow = keys.some((key) => PERSONAL_KEY_RULES.some((rule) => rule.applies(key)));
  for (const [key, entry] of Object.entries(record)) {
    if (isCredentialShapedKey(key) && !isSanitizedPlaceholder(entry)) {
      errors.push(`${path}.${key}: a credential-shaped key whose value is not a sanitized placeholder`);
    }
    const normalized = normalizedKey(key);
    const rule =
      PERSONAL_KEY_RULES.find((candidate) => candidate.applies(normalized)) ??
      (personRow ? PERSON_ROW_RULES.find((candidate) => candidate.applies(normalized)) : undefined);
    if (rule !== undefined && !rule.allows(entry)) {
      errors.push(`${path}.${key}: ${rule.message}`);
    }
  }
  return errors;
}

function walk(value: unknown, path: string, key: string, known: string, errors: string[]): void {
  if (typeof value === "string") {
    let embedded: unknown;
    if (/^\s*[[{]/.test(value)) {
      try {
        embedded = JSON.parse(value);
      } catch {
        // Not JSON: scanned as text.
      }
    }
    if (embedded === undefined) {
      errors.push(...textErrors(value, path, key, known));
    } else {
      walk(embedded, `${path}<json>`, key, known, errors);
    }
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, `${path}[${index}]`, key, known, errors));
  } else if (isRecord(value)) {
    errors.push(...objectErrors(value, path));
    for (const [member, entry] of Object.entries(value)) {
      errors.push(...textErrors(member, `${path}.${member} (the key)`, "", known));
      walk(entry, `${path}.${member}`, normalizedKey(member), known, errors);
    }
  }
}

/**
 * The refusals of one file's bytes, each prefixed by its path (relative to
 * the fixture root). `reports`: the venue reports' text, whose hex values
 * are public.
 */
export function scanFixtureFile(relativePath: string, bytes: Uint8Array, reports: readonly string[]): string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return [`${relativePath}: not valid UTF-8`];
  }
  const documents = relativePath.endsWith(".jsonl")
    ? text.split("\n").filter((line) => line !== "").map((line, index) => ({ text: line, path: `$[${index}]` }))
    : [{ text, path: "$" }];
  const known = reports.join("\n").toLowerCase();
  const errors: string[] = [];
  for (const document of documents) {
    let value: unknown;
    try {
      value = JSON.parse(document.text);
    } catch (error: unknown) {
      errors.push(`${document.path}: not JSON (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    errors.push(...duplicateKeys(document.text).map((key) => duplicateKeyError(document.path, key)));
    walk(value, document.path, "", known, errors);
  }
  return errors.map((error) => `${relativePath} ${error}`);
}

/**
 * Every file in the fixture tree, relative and `/`-separated, sorted, except
 * `README.md` files, whatever its suffix.
 */
export function listVenueFixtureFiles(root: string = VENUE_FIXTURE_ROOT): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      if (statSync(absolute).isDirectory()) {
        visit(absolute);
      } else if (entry !== "README.md") {
        files.push(relative(root, absolute).split(sep).join("/"));
      }
    }
  };
  visit(root);
  return files.sort();
}

/** The scan of the whole tree. */
export interface TreeScan {
  readonly ok: boolean;
  readonly files: number;
  readonly errors: readonly string[];
}

/** Scans every file of the fixture tree (`README.md` excepted). */
export function scanFixtureTree(reports: readonly string[], root: string = VENUE_FIXTURE_ROOT): TreeScan {
  const files = listVenueFixtureFiles(root);
  const errors = files.flatMap((file) => scanFixtureFile(file, readFileSync(join(root, file)), reports));
  return { ok: errors.length === 0, files: files.length, errors };
}
