/**
 * V2-9 round 7: ONE generic walk over every file of the venue fixture tree.
 *
 * Seven review rounds each found another field or path that the field-by-field
 * personal-data scan missed (an envelope property, an example property, a
 * duplicate key, an invalid byte, a source URL). The orchestrator's
 * 2026-10-08 directive closes the class: every file under
 * `test/fixtures/venue/` except a `README.md` (captures, sidecars, fixtures
 * and their examples alike) goes through the same walk, and no field is
 * exempt by name:
 *
 * 1. **Strict read** (`strict-json.ts`): UTF-8 with `fatal`, and RFC 8259
 *    JSON (one document, or one per `.jsonl` line) that refuses a repeated
 *    key and an ill-formed string. Any failure fails the gate, by name.
 * 2. **Every key and every string, at any depth**, in every reading the
 *    scanner decodes (`textReadings`: as written, NFKC-normalized, and each
 *    percent-decoded layer; what it cannot decode fails by name). A string
 *    that is itself JSON text (a WebSocket frame, Gamma's `outcomes`) is also
 *    parsed strictly and walked. Every URL in a string must parse, and is
 *    split into its user information, host, path, each query name and value,
 *    and fragment; each part is read strictly (`textReadings(part, true)`)
 *    and scanned. Each reading answers to every rule:
 *    - `email`: an email address;
 *    - `wallet`: a `0x` 40-hex address that is not labelled synthetic;
 *    - `hash`: `0x` and more than 40 hex digits, or 40 or more bare hex
 *      digits with a letter, not labelled synthetic;
 *    - `cursor`: a token that decodes to a venue cursor (JSON text, base64,
 *      base64url or hex, glued or not);
 *    - `assignment`: a personal field written with a value (`name: …`).
 *    Every object answers to the object rules:
 *    - `personal-key`: a wallet, pseudonym, profile, email or user-name key,
 *      and in a person's row its `name` and transaction hash, hold labelled
 *      synthetic or empty values;
 *    - `credential`: a credential-shaped key holds a sanitized placeholder;
 *    - `cursor`: the object itself is not shaped as a venue cursor.
 * 3. **Exceptions** are the explicit allowlist `SCAN_ALLOWLIST`
 *    (`scan-allowlist.ts`): (file, JSON path, exact value) entries, each with
 *    its rule, a cited report id the report defines, and a reason. A finding
 *    not allowlisted fails the gate; an allowlist entry that matches nothing
 *    fails it too (stale), so the list stays exact. A failure to read or
 *    decode is never allowlistable.
 *
 * The threat model (the 2026-10-08 ruling): defense in depth against an
 * accidental commit by a trusted author, whose fixtures are also reviewed. A
 * deliberately crafted encoding is out of scope (LOW, follow-up).
 *
 * Offline: local files only. No network, no credential, no order.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  emailTokens,
  hashTokens,
  isVenueCursorShaped,
  personalAssignmentTokens,
  personalKeyFindings,
  reportDefinesId,
  textReadings,
  unlabelledAddressTokens,
  venueCursorTokens,
} from "./captures.js";
import {
  REPO_ROOT,
  VENUE_FIXTURE_ROOT,
  isCredentialShapedKey,
  isRecord,
  isSanitizedPlaceholder,
} from "./fixtures.js";
import { SCAN_ALLOWLIST } from "./scan-allowlist.js";
import type { ScanAllowlistEntry, ScanRule } from "./scan-allowlist.js";
import { StrictJsonError, memberPath, parseStrictJson, readStrictJsonFile } from "./strict-json.js";

export type { ScanAllowlistEntry, ScanRule } from "./scan-allowlist.js";
export { SCAN_RULES } from "./scan-allowlist.js";

/** What each rule refuses (the value itself is never echoed). */
export const SCAN_RULE_MESSAGES: Readonly<Record<ScanRule, string>> = {
  email: "an email address may not be committed (personal data)",
  wallet: "a 0x 40-hex address that is not a labelled synthetic value (0x00…); it may be a wallet",
  hash: "a hash (0x and more than 40 hex digits, or 40 or more bare hex digits with a letter) that is not a labelled synthetic value; a transaction hash names its sender on chain",
  cursor: "a token or object that decodes to a venue cursor, which may carry the seek anchor of a feed's last row (S-O06)",
  assignment: "a personal field written with a value that is not a labelled synthetic value, a <placeholder> or empty",
  "personal-key": "a personal key whose value is not a labelled synthetic value or empty",
  credential: "a credential/secret-shaped key whose value is not a sanitized placeholder",
};

/** One rule match: where, which rule, and the exact token it refused. */
export interface ScanFinding {
  /** The JSON path; `…@key` is the key itself, `…<json>` a string's own JSON text. */
  readonly path: string;
  readonly rule: ScanRule;
  readonly token: string;
  readonly message: string;
}

/** The walk of one file. */
export interface FileScan {
  readonly relativePath: string;
  readonly ok: boolean;
  /** What the scanner cannot read or decode (never allowlistable). */
  readonly failures: readonly string[];
  /** Rule matches that no allowlist entry names: each fails the gate. */
  readonly refused: readonly ScanFinding[];
  /** Rule matches an allowlist entry names. */
  readonly allowlisted: readonly ScanFinding[];
  /** Allowlist entries of this file that matched nothing (stale). */
  readonly stale: readonly string[];
  /** How many strings and keys the walk read. */
  readonly strings: number;
  readonly keys: number;
  /** Every refusal, each prefixed by the file's path. */
  readonly errors: readonly string[];
}

/** The walk of the whole tree. */
export interface TreeScan {
  readonly ok: boolean;
  readonly files: readonly FileScan[];
  /** Allowlist entries that are malformed, cite an undefined id, or name no file on disk. */
  readonly allowlistErrors: readonly string[];
  readonly errors: readonly string[];
  readonly strings: number;
  readonly keys: number;
  readonly allowlisted: number;
}

// --- the readings of one text ---------------------------------------------------

/** A text's rule matches and decode failures, memoized (the rules are pure). */
interface TextAnalysis {
  readonly matches: readonly (readonly [ScanRule, string])[];
  readonly failures: readonly string[];
}

const ANALYSES = new Map<string, TextAnalysis>();
const MAX_ANALYSES = 200_000;

/** A URL anywhere in a text: a scheme, `://`, and the run of characters up to a space or a quote. */
const URL_CANDIDATE_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`]*/g;

/**
 * The parts of a URL as written (not as WHATWG re-serializes it, which
 * percent-encodes some characters and decodes others): user information,
 * host and port, path, each query name and value, and fragment.
 */
export function urlParts(url: string): { readonly name: string; readonly text: string }[] {
  const parts: { name: string; text: string }[] = [];
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  if (hashAt !== -1) {
    parts.push({ name: "fragment", text: url.slice(hashAt + 1) });
  }
  const queryAt = beforeHash.indexOf("?");
  const beforeQuery = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  if (queryAt !== -1) {
    beforeHash
      .slice(queryAt + 1)
      .split("&")
      .forEach((pair, index) => {
        const equals = pair.indexOf("=");
        const name = equals === -1 ? pair : pair.slice(0, equals);
        parts.push({ name: `query name ${index}`, text: name });
        if (equals !== -1) {
          parts.push({ name: `query value ${index}`, text: pair.slice(equals + 1) });
        }
      });
  }
  const afterScheme = beforeQuery.slice(beforeQuery.indexOf("://") + 3);
  const slashAt = afterScheme.indexOf("/");
  const authority = slashAt === -1 ? afterScheme : afterScheme.slice(0, slashAt);
  parts.push({ name: "path", text: slashAt === -1 ? "" : afterScheme.slice(slashAt) });
  const atAt = authority.lastIndexOf("@");
  if (atAt !== -1) {
    parts.push({ name: "user information", text: authority.slice(0, atAt) });
  }
  parts.push({ name: "host", text: authority.slice(atAt + 1) });
  return parts;
}

/** The token rules of one reading. */
function readingMatches(reading: string): (readonly [ScanRule, string])[] {
  return [
    ...emailTokens(reading).map((token) => ["email", token] as const),
    ...unlabelledAddressTokens(reading).map((token) => ["wallet", token] as const),
    ...hashTokens(reading).map((token) => ["hash", token] as const),
    ...venueCursorTokens(reading).map((token) => ["cursor", token] as const),
    ...personalAssignmentTokens(reading).map((token) => ["assignment", token] as const),
  ];
}

/**
 * Every rule match of one text, in every reading, and in every part of every
 * URL it holds; and what cannot be decoded or parsed. Memoized by text.
 */
export function analyzeText(text: string): TextAnalysis {
  const cached = ANALYSES.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const matches = new Map<string, readonly [ScanRule, string]>();
  const failures: string[] = [];
  const addReadings = (readings: readonly string[]): void => {
    for (const reading of readings) {
      for (const match of readingMatches(reading)) {
        matches.set(`${match[0]}\u0000${match[1]}`, match);
      }
    }
  };
  const { readings, failure } = textReadings(text);
  if (failure !== undefined) {
    failures.push(`the scanner cannot decode it (${failure}), so the gate fails closed`);
  }
  addReadings(readings);
  const urls = new Set(readings.flatMap((reading) => [...reading.matchAll(URL_CANDIDATE_RE)].map(([url]) => url)));
  for (const url of urls) {
    try {
      new URL(url);
    } catch {
      failures.push("a URL in it does not parse, so the scanner cannot split it and the gate fails closed");
      continue;
    }
    for (const part of urlParts(url)) {
      const forms = part.name.startsWith("query") ? [part.text, part.text.replace(/\+/g, " ")] : [part.text];
      for (const form of forms) {
        const partReadings = textReadings(form, true);
        if (partReadings.failure !== undefined) {
          failures.push(
            `the URL's ${part.name.replace(/ \d+$/, "")}: the scanner cannot decode it (${partReadings.failure}), so the gate fails closed`,
          );
        }
        addReadings(partReadings.readings);
      }
    }
  }
  const analysis: TextAnalysis = { matches: [...matches.values()], failures: [...new Set(failures)] };
  if (ANALYSES.size >= MAX_ANALYSES) {
    ANALYSES.clear();
  }
  ANALYSES.set(text, analysis);
  return analysis;
}

// --- the walk -------------------------------------------------------------------

interface WalkState {
  readonly findings: ScanFinding[];
  readonly failures: string[];
  strings: number;
  keys: number;
}

function addFinding(state: WalkState, path: string, rule: ScanRule, token: string, message?: string): void {
  if (!state.findings.some((finding) => finding.path === path && finding.rule === rule && finding.token === token)) {
    state.findings.push({ path, rule, token, message: message ?? SCAN_RULE_MESSAGES[rule] });
  }
}

function scanText(state: WalkState, path: string, text: string): void {
  const analysis = analyzeText(text);
  for (const failure of analysis.failures) {
    state.failures.push(`${path}: ${failure}`);
  }
  for (const [rule, token] of analysis.matches) {
    addFinding(state, path, rule, token);
  }
}

/** A string that may be JSON text: its first non-space character opens an object or an array. */
const JSON_TEXT_RE = /^\s*[[{]/;

function walkValue(state: WalkState, path: string, value: unknown): void {
  if (typeof value === "string") {
    state.strings += 1;
    scanText(state, path, value);
    if (JSON_TEXT_RE.test(value)) {
      // A string that is JSON text is also walked as JSON, so its escapes
      // (`@`) and repeated keys cannot hide a value.
      let embedded: unknown;
      try {
        embedded = parseStrictJson(value);
      } catch (error: unknown) {
        if (error instanceof StrictJsonError && error.kind !== "syntax") {
          state.failures.push(`${path}<json>${error.message.replace(/^\$/, "")}`);
        }
        // Not JSON: prose that opens with a bracket, judged as text above.
        return;
      }
      walkValue(state, `${path}<json>`, embedded);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkValue(state, `${path}[${index}]`, entry));
    return;
  }
  if (!isRecord(value)) {
    // A number, a boolean or null: no rule's value is written so.
    return;
  }
  if (isVenueCursorShaped(value)) {
    addFinding(state, path, "cursor", JSON.stringify(value));
  }
  for (const finding of personalKeyFindings(value)) {
    addFinding(state, memberPath(path, finding.key), "personal-key", finding.key, finding.message);
  }
  for (const [key, entry] of Object.entries(value)) {
    const member = memberPath(path, key);
    if (isCredentialShapedKey(key) && !isSanitizedPlaceholder(entry)) {
      addFinding(state, member, "credential", key);
    }
    state.keys += 1;
    scanText(state, `${member}@key`, key);
    walkValue(state, member, entry);
  }
}

/** The allowlist's (file, path, rule, value) quadruples, keyed for lookup. */
function allowlistKey(file: string, path: string, rule: ScanRule, value: string): string {
  return JSON.stringify([file, path, rule, value]);
}

/**
 * The walk of one file's bytes (`relativePath`: relative to the fixture
 * root, `/`-separated). Pure: the pins call it with planted bytes.
 */
export function scanFixtureFile(
  relativePath: string,
  bytes: Uint8Array,
  allowlist: readonly ScanAllowlistEntry[] = SCAN_ALLOWLIST,
): FileScan {
  const state: WalkState = { findings: [], failures: [], strings: 0, keys: 0 };
  const read = readStrictJsonFile(relativePath, bytes);
  if (!read.ok) {
    state.failures.push(read.reason);
  } else {
    for (const document of read.documents) {
      walkValue(state, document.path, document.value);
    }
  }
  const entries = new Map<string, ScanAllowlistEntry>();
  for (const entry of allowlist) {
    for (const [file, path] of entry.at) {
      if (file === relativePath) {
        entries.set(allowlistKey(file, path, entry.rule, entry.value), entry);
      }
    }
  }
  const used = new Set<string>();
  const refused: ScanFinding[] = [];
  const allowlisted: ScanFinding[] = [];
  for (const finding of state.findings) {
    const key = allowlistKey(relativePath, finding.path, finding.rule, finding.token);
    if (entries.has(key)) {
      used.add(key);
      allowlisted.push(finding);
    } else {
      refused.push(finding);
    }
  }
  const stale = read.ok
    ? [...entries.keys()]
        .filter((key) => !used.has(key))
        .map((key) => {
          const [, path, rule] = JSON.parse(key) as [string, string, string, string];
          return `${path}: the allowlist names a ${rule} value here that the file does not hold (a stale entry; remove it, or restore the value)`;
        })
    : [];
  const errors = [
    ...state.failures,
    ...refused.map((finding) => `${finding.path}: [${finding.rule}] ${finding.message}`),
    ...stale,
  ].map((error) => `${relativePath} ${error}`);
  return {
    relativePath,
    ok: errors.length === 0,
    failures: state.failures,
    refused,
    allowlisted,
    stale,
    strings: state.strings,
    keys: state.keys,
    errors,
  };
}

// --- the tree -------------------------------------------------------------------

/**
 * Every file in the fixture tree, relative and `/`-separated, sorted, except
 * `README.md` files, whatever its suffix (`index.ts` `listFixtureFiles`).
 */
export function listVenueFixtureFiles(root: string = VENUE_FIXTURE_ROOT): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
      } else if (entry !== "README.md") {
        files.push(relative(root, absolute).split(sep).join("/"));
      }
    }
  };
  walk(root);
  return files.sort();
}

/** A cited section: `§3`, `§10.2`. */
const SECTION_ID_RE = /^§(\d+(?:\.\d+)*)$/;

/**
 * The refusals of the allowlist itself: an entry with no `at`, no reason, a
 * value its rule does not produce on its own, a repeated quadruple, a cited
 * report that cannot be read, or an id that report does not define (a fact,
 * conflict or source id, or a `§` section heading); and an `at` file that is
 * not in the tree.
 */
export function allowlistErrors(
  allowlist: readonly ScanAllowlistEntry[],
  files: readonly string[],
  readReport: (path: string) => string | null = readRepoFile,
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  const present = new Set(files);
  allowlist.forEach((entry, index) => {
    const where = `allowlist[${index}] (${entry.rule})`;
    if (entry.at.length === 0) {
      errors.push(`${where}: names no (file, path)`);
    }
    if (entry.reason.trim().length === 0) {
      errors.push(`${where}: gives no reason`);
    }
    const produced = analyzeText(entry.value).matches.some(([rule, token]) => rule === entry.rule && token === entry.value);
    if (entry.rule !== "personal-key" && entry.rule !== "credential" && !produced) {
      errors.push(`${where}: its value is not one token its rule refuses, so it can match nothing`);
    }
    const report = readReport(entry.source.report);
    const section = SECTION_ID_RE.exec(entry.source.id)?.[1];
    if (report === null) {
      errors.push(`${where}: cites ${entry.source.report}, which cannot be read`);
    } else if (
      section === undefined
        ? !reportDefinesId(report, entry.source.id)
        : !new RegExp(`^#{2,3} ${section.replace(/\./g, "\\.")}\\.? `, "m").test(report)
    ) {
      errors.push(`${where}: cites ${entry.source.id}, which ${entry.source.report} does not define`);
    }
    for (const [file, path] of entry.at) {
      const key = allowlistKey(file, path, entry.rule, entry.value);
      if (seen.has(key)) {
        errors.push(`${where}: names ${file} ${path} twice`);
      }
      seen.add(key);
      if (!present.has(file)) {
        errors.push(`${where}: names ${file}, which is not in the fixture tree (a stale entry)`);
      }
    }
  });
  return errors;
}

const REPORTS = new Map<string, string | null>();

function readRepoFile(path: string): string | null {
  if (!REPORTS.has(path)) {
    try {
      REPORTS.set(path, readFileSync(join(REPO_ROOT, path), "utf8"));
    } catch {
      REPORTS.set(path, null);
    }
  }
  return REPORTS.get(path) ?? null;
}

/** The walk of every file of the fixture tree (`README.md` excepted), and of the allowlist. */
export function scanFixtureTree(
  root: string = VENUE_FIXTURE_ROOT,
  allowlist: readonly ScanAllowlistEntry[] = SCAN_ALLOWLIST,
): TreeScan {
  const fileNames = listVenueFixtureFiles(root);
  const files = fileNames.map((relativePath) => {
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(join(root, relativePath));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = `cannot be read (${message}), so the gate fails closed`;
      return {
        relativePath,
        ok: false,
        failures: [failure],
        refused: [],
        allowlisted: [],
        stale: [],
        strings: 0,
        keys: 0,
        errors: [`${relativePath} ${failure}`],
      } satisfies FileScan;
    }
    return scanFixtureFile(relativePath, bytes, allowlist);
  });
  const listErrors = allowlistErrors(allowlist, fileNames);
  const errors = [...listErrors, ...files.flatMap((file) => file.errors)];
  return {
    ok: errors.length === 0,
    files,
    allowlistErrors: listErrors,
    errors,
    strings: files.reduce((sum, file) => sum + file.strings, 0),
    keys: files.reduce((sum, file) => sum + file.keys, 0),
    allowlisted: files.reduce((sum, file) => sum + file.allowlisted.length, 0),
  };
}
