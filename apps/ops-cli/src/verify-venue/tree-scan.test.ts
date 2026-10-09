/**
 * V2-9 round 7: the generic walk of every file in the venue fixture tree
 * (`tree-scan.ts`), pinned as a CLASS (the orchestrator's 2026-10-08
 * directive), not one field at a time:
 *
 * - each rule's offending value (an email, an unlabelled wallet, a 64-hex
 *   transaction hash, a trade feed cursor) is planted into EVERY JSON path of
 *   EVERY committed file, one at a time (a string or scalar replaced, a member
 *   added, a key added, an item appended, a key renamed; inside a string's own
 *   JSON text too), and the walk must refuse it at that path;
 * - invalid UTF-8 and a repeated key are planted into every committed file;
 * - the verifier's round-7 probes (V2-9-R7-01, -02, -03), byte for byte;
 * - every fail-closed path of the walk, and the allowlist's exactness.
 *
 * Every mutant is built in memory or in a temporary directory; no committed
 * fixture is written. All planted values are invented. Offline.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { VENUE_FIXTURE_ROOT } from "./fixtures.js";
import { SCAN_ALLOWLIST } from "./scan-allowlist.js";
import type { ScanAllowlistEntry, ScanRule } from "./scan-allowlist.js";
import { memberPath, parseStrictJson, readStrictJsonFile } from "./strict-json.js";
import type { StrictJson } from "./strict-json.js";
import {
  SCAN_RULES,
  allowlistErrors,
  analyzeText,
  listVenueFixtureFiles,
  scanFixtureFile,
  scanFixtureTree,
  urlParts,
} from "./tree-scan.js";
import type { FileScan } from "./tree-scan.js";

// --- invented probe values ------------------------------------------------------

const PROBE_EMAIL = "probe@example.test";
const PROBE_WALLET = `0x${"1a".repeat(20)}`;
const PROBE_HASH = "0x9f2c1a7d3e5b4c6a8d0e2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e";
/** A trade feed cursor shaped as S-O06's (invented anchor), base64url. */
const PROBE_CURSOR = Buffer.from(
  JSON.stringify({ data: { type: "trades", params: { l: 2, ts: 1700000001, sq: 123, d: "desc" } }, sig: "0".repeat(64) }),
).toString("base64url");

/** Each rule the class pin plants, with its offending value. */
const PLANTED: readonly { readonly rule: ScanRule; readonly value: string }[] = [
  { rule: "email", value: PROBE_EMAIL },
  { rule: "wallet", value: PROBE_WALLET },
  { rule: "hash", value: PROBE_HASH },
  { rule: "cursor", value: PROBE_CURSOR },
];

const FILES = listVenueFixtureFiles();

function bytesOf(file: string): Buffer {
  return readFileSync(join(VENUE_FIXTURE_ROOT, file));
}

function refusedAt(scan: FileScan, path: string, rule: ScanRule): boolean {
  return scan.refused.some((finding) => finding.path === path && finding.rule === rule);
}

// --- planting into every JSON path ------------------------------------------------

type Segment =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "json" };

/** One place to plant a value, and the path where the walk must refuse it. */
interface Site {
  readonly description: string;
  readonly at: readonly Segment[];
  readonly plant: (node: StrictJson, value: string) => StrictJson;
  readonly expected: (value: string) => string;
}

/** Applies `edit` to the node at `at`, cloning along the way (a `json` segment re-serializes a string's JSON). */
function editAt(root: StrictJson, at: readonly Segment[], edit: (node: StrictJson) => StrictJson): StrictJson {
  const [head, ...rest] = at;
  if (head === undefined) {
    return edit(root);
  }
  if (head.kind === "json") {
    return JSON.stringify(editAt(parseStrictJson(root as string), rest, edit));
  }
  if (head.kind === "index") {
    const array = [...(root as StrictJson[])];
    array[head.index] = editAt(array[head.index] as StrictJson, rest, edit);
    return array;
  }
  const object = root as { [key: string]: StrictJson };
  const copy: { [key: string]: StrictJson } = {};
  for (const [key, entry] of Object.entries(object)) {
    copy[key] = key === head.key ? editAt(entry, rest, edit) : entry;
  }
  return copy;
}

/** Every plant site of a document: every value, member, key and item, at any depth. */
function sitesOf(node: StrictJson, path: string, at: readonly Segment[], into: Site[] = []): Site[] {
  if (typeof node === "string") {
    into.push({ description: `${path} (the string, replaced)`, at, plant: (_, value) => value, expected: () => path });
    let embedded: StrictJson | undefined;
    if (/^\s*[[{]/.test(node)) {
      try {
        embedded = parseStrictJson(node);
      } catch {
        embedded = undefined;
      }
    }
    if (embedded !== undefined) {
      sitesOf(embedded, `${path}<json>`, [...at, { kind: "json" }], into);
    }
    return into;
  }
  if (Array.isArray(node)) {
    into.push({
      description: `${path} (an item appended)`,
      at,
      plant: (array, value) => [...(array as StrictJson[]), value],
      expected: () => `${path}[${node.length}]`,
    });
    node.forEach((entry, index) => sitesOf(entry, `${path}[${index}]`, [...at, { kind: "index", index }], into));
    return into;
  }
  if (node === null || typeof node !== "object") {
    into.push({ description: `${path} (the scalar, replaced)`, at, plant: (_, value) => value, expected: () => path });
    return into;
  }
  into.push({
    description: `${path} (a member added)`,
    at,
    plant: (object, value) => ({ ...(object as object), planted_probe: value }),
    expected: () => memberPath(path, "planted_probe"),
  });
  into.push({
    description: `${path} (a key added)`,
    at,
    plant: (object, value) => ({ ...(object as object), [value]: 1 }),
    expected: (value) => `${memberPath(path, value)}@key`,
  });
  for (const [key, entry] of Object.entries(node)) {
    into.push({
      description: `${memberPath(path, key)} (the key, renamed)`,
      at,
      plant: (object, value) =>
        Object.fromEntries(Object.entries(object as object).map(([name, item]) => [name === key ? value : name, item])),
      expected: (value) => `${memberPath(path, value)}@key`,
    });
    sitesOf(entry, memberPath(path, key), [...at, { kind: "key", key }], into);
  }
  return into;
}

/** A file's documents, as the walk reads them. */
function documentsOf(file: string): { readonly path: string; readonly value: StrictJson }[] {
  const read = readStrictJsonFile(file, bytesOf(file));
  if (!read.ok) {
    throw new Error(`${file}: ${read.reason}`);
  }
  return [...read.documents];
}

/** A file's bytes from its documents (one JSON document, or one per `.jsonl` line). */
function serialize(file: string, documents: readonly StrictJson[]): Buffer {
  return Buffer.from(
    file.endsWith(".jsonl")
      ? `${documents.map((document) => JSON.stringify(document)).join("\n")}\n`
      : `${JSON.stringify(documents[0], null, 2)}\n`,
  );
}

// --- the committed tree ---------------------------------------------------------

describe("V2-9 r7: the generic walk reads every file of the tree, and the committed tree passes", () => {
  it("passes: every file, with only allowlisted values, and the allowlist is exact and sourced", () => {
    const scan = scanFixtureTree();
    expect(scan.errors).toEqual([]);
    expect(scan.ok).toBe(true);
    expect(scan.files.map((file) => file.relativePath)).toEqual(FILES);
    expect(FILES.length).toBe(59);
    // Every allowlist (file, path) pair is used once: none is stale.
    expect(scan.allowlisted).toBe(SCAN_ALLOWLIST.reduce((sum, entry) => sum + entry.at.length, 0));
    expect(scan.allowlistErrors).toEqual([]);
  });

  it("the rules are the directive's and the README's", () => {
    expect([...SCAN_RULES]).toEqual(["email", "wallet", "hash", "cursor", "assignment", "personal-key", "credential"]);
  });
});

// --- the class pin ------------------------------------------------------------------

describe("V2-9 r7 CLASS PIN: each rule's offending value, planted into every JSON path of every committed file, fails the walk", () => {
  for (const file of FILES) {
    it(`MUTANT: ${file}: every path, one at a time, for an email, a wallet, a hash and a trade cursor`, () => {
      const documents = documentsOf(file);
      const misses: string[] = [];
      let planted = 0;
      documents.forEach((document, documentIndex) => {
        for (const site of sitesOf(document.value, document.path, [])) {
          for (const { rule, value } of PLANTED) {
            const mutant = documents.map((other, index) =>
              index === documentIndex ? editAt(other.value, site.at, (node) => site.plant(node, value)) : other.value,
            );
            const scan = scanFixtureFile(file, serialize(file, mutant));
            planted += 1;
            if (scan.ok || !refusedAt(scan, site.expected(value), rule)) {
              misses.push(`${site.description}: ${rule}`);
            }
          }
        }
      });
      expect(misses).toEqual([]);
      expect(planted).toBeGreaterThan(0);
    }, 120_000);
  }

  it("covers every kind of site: the plant counts are pinned for the committed tree", () => {
    const counts = { files: 0, sites: 0, embedded: 0 };
    for (const file of FILES) {
      counts.files += 1;
      for (const document of documentsOf(file)) {
        const sites = sitesOf(document.value, document.path, []);
        counts.sites += sites.length;
        counts.embedded += sites.filter((site) => site.at.some((segment) => segment.kind === "json")).length;
      }
    }
    expect(counts.files).toBe(59);
    // 1649 strings, 524 other scalars, 436 objects (a member and a key each),
    // 126 arrays, 2338 keys; the embedded JSON texts' sites included.
    expect(counts.sites).toBeGreaterThan(5000);
    expect(counts.embedded).toBeGreaterThan(0);
  });
});

// --- invalid UTF-8 and a repeated key, in every file -----------------------------------

describe("V2-9 r7: invalid UTF-8 and a repeated key fail the walk in every committed file, by name (V2-9-R7-02)", () => {
  it("MUTANT: an invalid byte inside the first string of each file", () => {
    for (const file of FILES) {
      const bytes = bytesOf(file);
      const at = bytes.indexOf(0x22) + 1;
      const mutant = Buffer.concat([bytes.subarray(0, at), Buffer.from([0xff]), bytes.subarray(at)]);
      const scan = scanFixtureFile(file, mutant);
      expect(scan.ok, file).toBe(false);
      expect(scan.failures, file).toEqual([
        "not valid UTF-8, so the scanner cannot decode it and the gate fails closed (round 7)",
      ]);
    }
  });

  it("MUTANT: the first key of each file's first object written twice, an email in the earlier value", () => {
    for (const file of FILES) {
      const text = bytesOf(file).toString("utf8");
      const match = /\{(\s*)"((?:[^"\\]|\\.)*)"\s*:/.exec(text);
      expect(match, file).not.toBeNull();
      const key = (match as RegExpExecArray)[2] as string;
      const at = (match as RegExpExecArray).index + 1;
      const mutant = `${text.slice(0, at)}"${key}":"${PROBE_EMAIL}",${text.slice(at)}`;
      const scan = scanFixtureFile(file, Buffer.from(mutant));
      expect(scan.ok, file).toBe(false);
      expect(scan.failures.join("\n"), file).toContain(`the key ${JSON.stringify(JSON.parse(`"${key}"`))} occurs twice in one object`);
    }
  });

  it("MUTANT: a repeated key inside a string's JSON text (a WebSocket frame) fails, at that path", () => {
    const file = "protocol-v2/ws-market-v2-session.jsonl";
    const lines = bytesOf(file).toString("utf8").split("\n");
    const record = JSON.parse(lines[2] as string) as { data: string };
    record.data = record.data.replace('{"market":', `{"market":"${PROBE_EMAIL}","market":`);
    lines[2] = JSON.stringify(record);
    const scan = scanFixtureFile(file, Buffer.from(lines.join("\n")));
    expect(scan.failures).toEqual([
      '$[2].data<json>[0].market: the key "market" occurs twice in one object; a lenient parse keeps only the last value, so an earlier one would escape every rule',
    ]);
  });

  it("MUTANT: a byte-order mark, a comment, a trailing comma, a lone surrogate and an empty .jsonl line each fail by name", () => {
    const book = "market-ws/book-snapshot-v2.json";
    const text = bytesOf(book).toString("utf8");
    const reasons = [
      `\uFEFF${text}`,
      text.replace("{", "{ // a comment\n"),
      text.replace(/\n}\s*$/, ",\n}\n"),
      text.replace('"notes": "', '"notes": "\\uD800'),
    ].map((mutant) => scanFixtureFile(book, Buffer.from(mutant)).failures.join("\n"));
    expect(reasons[0]).toContain("not strict JSON");
    expect(reasons[1]).toContain("not strict JSON");
    expect(reasons[2]).toContain("not strict JSON");
    expect(reasons[3]).toContain("$.notes: a string that is not well-formed Unicode (a lone surrogate)");
    const session = "protocol-v2/ws-market-v2-session.jsonl";
    const lines = bytesOf(session).toString("utf8").split("\n");
    lines.splice(3, 0, "");
    expect(scanFixtureFile(session, Buffer.from(lines.join("\n"))).failures.join("\n")).toContain("$[3]: expected a JSON value");
  });

});

// --- the verifier's round-7 probes ------------------------------------------------------

const BOOK = "market-ws/book-snapshot-v2.json";
const ROUTER = "positions/router-v2.json";
const TRADE_ANCHOR = PROBE_CURSOR;

function plantJson(file: string, edit: (document: Record<string, unknown>) => void): FileScan {
  const document = JSON.parse(bytesOf(file).toString("utf8")) as Record<string, unknown>;
  edit(document);
  return scanFixtureFile(file, Buffer.from(JSON.stringify(document)));
}

function firstExample(document: Record<string, unknown>): Record<string, unknown> {
  return (document["examples"] as Record<string, unknown>[])[0] as Record<string, unknown>;
}

describe("V2-9 r7: the verifier's probes, byte for byte (V2-9-R7-01, -02, -03)", () => {
  it("MUTANT (R7-01): an envelope `contact` email, an example `wallet`, an envelope `original_cursor`, an example `transactionHash`", () => {
    expect(refusedAt(plantJson(BOOK, (o) => (o["contact"] = PROBE_EMAIL)), "$.contact", "email")).toBe(true);
    expect(
      refusedAt(plantJson(BOOK, (o) => (firstExample(o)["wallet"] = PROBE_WALLET)), "$.examples[0].wallet", "wallet"),
    ).toBe(true);
    expect(
      refusedAt(plantJson(BOOK, (o) => (firstExample(o)["wallet"] = PROBE_WALLET)), "$.examples[0].wallet", "personal-key"),
    ).toBe(true);
    expect(refusedAt(plantJson(ROUTER, (o) => (o["original_cursor"] = TRADE_ANCHOR)), "$.original_cursor", "cursor")).toBe(true);
    expect(
      refusedAt(
        plantJson(ROUTER, (o) => (firstExample(o)["transactionHash"] = `0x${"a".repeat(64)}`)),
        "$.examples[0].transactionHash",
        "hash",
      ),
    ).toBe(true);
  });

  it("MUTANT (R7-02): the verifier's invalid byte in the book notes, and its repeated notes", () => {
    const bytes = Buffer.from(bytesOf(BOOK));
    bytes[bytes.indexOf(Buffer.from("V2-9 (2026"))] = 0xff;
    expect(scanFixtureFile(BOOK, bytes).failures).toEqual([
      "not valid UTF-8, so the scanner cannot decode it and the gate fails closed (round 7)",
    ]);
    const duplicated = bytesOf(BOOK).toString("utf8").replace('"notes":', '"notes":"Contact probe@example.test", "notes":');
    expect(scanFixtureFile(BOOK, Buffer.from(duplicated)).failures).toEqual([
      'not strict JSON ($.notes: the key "notes" occurs twice in one object; a lenient parse keeps only the last value, so an earlier one would escape every rule), so the scanner cannot read it and the gate fails closed (round 7)',
    ]);
  });

  it("MUTANT (R7-03): a transaction hash in the Router source URL's fragment; and in an example name", () => {
    const hash = `0x${"a".repeat(64)}`;
    expect(refusedAt(plantJson(ROUTER, (o) => (o["source"] = `${String(o["source"])}#transaction=${hash}`)), "$.source", "hash")).toBe(true);
    expect(
      refusedAt(plantJson(BOOK, (o) => (firstExample(o)["name"] = `${String(firstExample(o)["name"])}-tx-${hash}`)), "$.examples[0].name", "hash"),
    ).toBe(true);
  });
});

// --- fail closed: every decode path of the walk -----------------------------------------

describe("V2-9 r7: what the walk cannot decode, parse or split fails by name, never by fallback (the 2026-10-08 ruling)", () => {
  const notesFailures = (notes: string): readonly string[] =>
    plantJson(BOOK, (o) => (o["notes"] = notes)).failures;

  it("MUTANT: a run of %XX escapes that is not UTF-8, and percent-encoding nested too deep", () => {
    expect(notesFailures("see %FF%FE")).toEqual([
      "$.notes: the scanner cannot decode it (a run of %XX escapes that is not UTF-8), so the gate fails closed",
    ]);
    expect(notesFailures(`x${"%25".repeat(1)}252525252541`)).toEqual([
      "$.notes: the scanner cannot decode it (percent-encoding nested deeper than 4 layers), so the gate fails closed",
    ]);
  });

  it("MUTANT: a URL that does not parse, and a URL part with a % that begins no escape", () => {
    expect(notesFailures("see https://[not-a-host/x")).toEqual([
      "$.notes: a URL in it does not parse, so the scanner cannot split it and the gate fails closed",
    ]);
    expect(notesFailures("see https://docs.polymarket.com/x?q=100%")).toEqual([
      "$.notes: the URL's query value: the scanner cannot decode it (a % that begins no %XX escape), so the gate fails closed",
    ]);
  });

  it("MUTANT: a percent-encoded email or wallet in a URL part is decoded and refused", () => {
    const email = plantJson(ROUTER, (o) => (o["source"] = `${String(o["source"])}?memo=probe%40example.test`));
    expect(refusedAt(email, "$.source", "email")).toBe(true);
    const wallet = plantJson(ROUTER, (o) => (o["source"] = `${String(o["source"])}#%30%78${"1a".repeat(20)}`));
    expect(refusedAt(wallet, "$.source", "wallet")).toBe(true);
  });

  it("MUTANT: a cursor-shaped object, a credential-shaped key and a personal key are refused at any depth", () => {
    const scan = plantJson(ROUTER, (o) => {
      const payload = firstExample(o)["payload"] as Record<string, unknown>;
      payload["nested"] = { data: { type: "trades", params: { l: 1 } }, sig: "x" };
      payload["apiKey"] = "live-value";
      payload["display_name"] = "Reviewer Probe";
    });
    expect(refusedAt(scan, "$.examples[0].payload.nested", "cursor")).toBe(true);
    expect(refusedAt(scan, "$.examples[0].payload.apiKey", "credential")).toBe(true);
    expect(refusedAt(scan, "$.examples[0].payload.display_name", "personal-key")).toBe(true);
  });

  it("splits a URL as written: user information, host, path, each query name and value, fragment", () => {
    expect(urlParts("https://u:p@host.example:8443/a/b?x=1&y&=z#frag")).toEqual([
      { name: "fragment", text: "frag" },
      { name: "query name 0", text: "x" },
      { name: "query value 0", text: "1" },
      { name: "query name 1", text: "y" },
      { name: "query name 2", text: "" },
      { name: "query value 2", text: "z" },
      { name: "path", text: "/a/b" },
      { name: "user information", text: "u:p" },
      { name: "host", text: "host.example:8443" },
    ]);
    expect(analyzeText(`https://docs.polymarket.com/x?${encodeURIComponent(PROBE_EMAIL)}=1`).matches).toContainEqual([
      "email",
      PROBE_EMAIL,
    ]);
  });
});

// --- the allowlist is exact -------------------------------------------------------------

describe("V2-9 r7: the allowlist is (file, JSON path, exact value), sourced, and never stale", () => {
  const conditionEntry = SCAN_ALLOWLIST.find(
    (entry) => entry.at.some(([file, path]) => file === ROUTER && path === "$.examples[3].payload.request.conditionId"),
  ) as ScanAllowlistEntry;

  it("MUTANT: an allowlisted value moved to another path, or another value at an allowlisted path, fails", () => {
    expect(conditionEntry.rule).toBe("hash");
    const moved = plantJson(ROUTER, (o) => (o["notes"] = `${String(o["notes"])} ${conditionEntry.value}`));
    expect(refusedAt(moved, "$.notes", "hash")).toBe(true);
    const swapped = plantJson(ROUTER, (o) => {
      const request = ((o["examples"] as Record<string, unknown>[])[3]?.["payload"] as Record<string, unknown>)["request"] as Record<string, unknown>;
      request["conditionId"] = PROBE_HASH;
    });
    expect(refusedAt(swapped, "$.examples[3].payload.request.conditionId", "hash")).toBe(true);
    expect(swapped.stale).toEqual([
      "$.examples[3].payload.request.conditionId: the allowlist names a hash value here that the file does not hold (a stale entry; remove it, or restore the value)",
    ]);
  });

  it("MUTANT: an entry that cites an undefined id, an unreadable report, a missing file, an empty reason, a non-token value, a pair twice or no pair fails", () => {
    const base: ScanAllowlistEntry = { ...conditionEntry, at: [] };
    const errors = allowlistErrors(
      [
        { ...base, at: [[ROUTER, "$.probe0"]], source: { report: base.source.report, id: "F-9999" } },
        { ...base, at: [[ROUTER, "$.probe1"]], source: { report: "docs/venue/verified-1999-01-01.md", id: "F-71" } },
        { ...base, at: [["positions/missing.json", "$.notes"]] },
        { ...base, at: [[ROUTER, "$.probe3"]], reason: " " },
        { ...base, at: [[ROUTER, "$.probe4"]], value: "not a hash" },
        { ...base, at: [[ROUTER, "$.notes"], [ROUTER, "$.notes"]] },
        { ...base, at: [[ROUTER, "$.probe6"]], source: { report: "docs/venue/verified-2026-08-24.md", id: "§99" } },
        { ...base },
      ],
      FILES,
    );
    expect(errors).toEqual([
      "allowlist[0] (hash): cites F-9999, which docs/venue/verified-2026-10-05.md does not define",
      "allowlist[1] (hash): cites docs/venue/verified-1999-01-01.md, which cannot be read",
      "allowlist[2] (hash): names positions/missing.json, which is not in the fixture tree (a stale entry)",
      "allowlist[3] (hash): gives no reason",
      "allowlist[4] (hash): its value is not one token its rule refuses, so it can match nothing",
      "allowlist[5] (hash): names positions/router-v2.json $.notes twice",
      "allowlist[6] (hash): cites §99, which docs/venue/verified-2026-08-24.md does not define",
      "allowlist[7] (hash): names no (file, path)",
    ]);
  });

  it("MUTANT: without its allowlist, every committed file that holds a public id fails", () => {
    const failing = FILES.filter((file) => !scanFixtureFile(file, bytesOf(file), []).ok);
    const listed = new Set(SCAN_ALLOWLIST.flatMap((entry) => entry.at.map(([file]) => file)));
    expect(failing).toEqual(FILES.filter((file) => listed.has(file)));
  });

});
