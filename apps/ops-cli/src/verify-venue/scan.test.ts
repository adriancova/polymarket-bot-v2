/**
 * V2-9: the scan of every file under `test/fixtures/venue/` (`scan.ts`).
 *
 * It passes on the committed tree, and refuses each pattern and rule when a
 * mutant plants it. Mutants are built in memory from the committed bytes; no
 * committed fixture is written. The planted values are SYNTHETIC: invented
 * for these tests, no real person, account or venue cursor.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { VENUE_CHECKS, reportOf } from "./checks.js";
import { REPO_ROOT, VENUE_FIXTURE_ROOT, isRecord } from "./fixtures.js";
import { listFixtureFiles } from "./index.js";
import { PUBLIC_VALUES, scanFixtureFile, scanFixtureTree } from "./scan.js";

const REPORTS = [...new Set(VENUE_CHECKS.map(reportOf))].map((path) =>
  readFileSync(join(REPO_ROOT, path), "utf8"),
);

const PROBE_EMAIL = "reviewer-probe@example.invalid";
const PROBE_WALLET = `0x${"1234567890".repeat(4)}`;
const PROBE_HASH = `0x${"1234567890abcdef".repeat(4)}`;
/** A SYNTHETIC trade cursor: the venue's structure, invented values, a zero signature. */
const PROBE_CURSOR = Buffer.from(
  JSON.stringify({ data: { type: "trades", params: { l: 2, ts: 1700000001, sq: "synthetic", d: 2 } }, sig: "0".repeat(32) }),
).toString("base64url");

const MESSAGES = {
  email: "an email address may not be committed",
  hex: "a hex value of 40 or more digits",
  cursor: "a token that decodes to a venue cursor",
};

function bytesOf(relativePath: string): Buffer {
  return readFileSync(join(VENUE_FIXTURE_ROOT, relativePath));
}

function scan(relativePath: string, text: string): string[] {
  return scanFixtureFile(relativePath, Buffer.from(text, "utf8"), REPORTS);
}

/** The committed file's documents (one, or one per `.jsonl` line). */
function documentsOf(relativePath: string): unknown[] {
  const text = bytesOf(relativePath).toString("utf8");
  return relativePath.endsWith(".jsonl")
    ? text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as unknown)
    : [JSON.parse(text) as unknown];
}

function serialize(documents: readonly unknown[]): string {
  return documents.map((document) => JSON.stringify(document)).join("\n");
}

/** Appends ` <token>` to every string and every key, counting them. */
function plant(value: unknown, token: string, count: { n: number }): unknown {
  if (typeof value === "string") {
    count.n += 1;
    return `${value} ${token}`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => plant(entry, token, count));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        count.n += 1;
        return [`${key} ${token}`, plant(entry, token, count)];
      }),
    );
  }
  return value;
}

/** Edits a JSON fixture in memory and scans it. */
function scanEdited(relativePath: string, edit: (body: Record<string, unknown>) => void): string[] {
  const body = JSON.parse(bytesOf(relativePath).toString("utf8")) as Record<string, unknown>;
  edit(body);
  return scan(relativePath, JSON.stringify(body));
}

function firstRow(body: Record<string, unknown>): Record<string, unknown> {
  return (body["data"] as Record<string, unknown>[])[0] as Record<string, unknown>;
}

describe("V2-9 scan: every file of the fixture tree", () => {
  it("the committed tree passes, every file but README.md read", () => {
    const tree = scanFixtureTree(REPORTS);
    expect(tree.errors).toEqual([]);
    expect(tree.ok).toBe(true);
    expect(tree.files).toBe(listFixtureFiles().length);
  });

  it("MUTANT (plant): each pattern appended to EVERY string and key of EVERY file is refused at each one", () => {
    const tokens = { email: PROBE_EMAIL, hex: PROBE_WALLET, hash: PROBE_HASH, cursor: PROBE_CURSOR };
    for (const relativePath of listFixtureFiles()) {
      for (const [pattern, token] of Object.entries(tokens)) {
        const count = { n: 0 };
        const planted = documentsOf(relativePath).map((document) => plant(document, token, count));
        const message = MESSAGES[pattern === "hash" ? "hex" : (pattern as keyof typeof MESSAGES)];
        const refused = scan(relativePath, serialize(planted)).filter((error) => error.includes(message));
        expect(refused.length, `${relativePath} ${pattern}`).toBe(count.n);
      }
    }
  });

  it("MUTANT: a cursor glued to a label (cursor_eyJ…), in prose or a URL, is refused; the public prices_history cursor is not", () => {
    const notes = scanEdited("market-ws/book-snapshot-v2.json", (body) => {
      body["notes"] = `${body["notes"] as string} next page cursor_${PROBE_CURSOR}`;
    });
    expect(notes.some((error) => error.includes("$.notes: a token that decodes to a venue cursor (type trades)"))).toBe(true);
    const url = scanEdited("protocol-v2/data-v2-oi-v2.provenance.jsonc", (body) => {
      body["url"] = `${body["url"] as string}&cursor=${PROBE_CURSOR}`;
    });
    expect(url.some((error) => error.includes("$.url: a token that decodes to a venue cursor"))).toBe(true);
    expect(scan("protocol-v2/data-v2-prices-history-page2.provenance.jsonc", bytesOf("protocol-v2/data-v2-prices-history-page2.provenance.jsonc").toString("utf8"))).toEqual([]);
  });

  it("the hex allowances: labelled synthetic, a whole public id under its key, a value the report contains, and PUBLIC_VALUES", () => {
    const path = "protocol-v2/data-v2-oi-v2.jsonc";
    const market = "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75";
    expect(REPORTS.join("\n").toLowerCase().includes(market)).toBe(false);
    const errors = (row: Record<string, unknown>): string[] => scanEdited(path, (body) => Object.assign(firstRow(body), row));
    expect(errors({ synthetic: `0x${"0".repeat(61)}101`, market, condition_id: market })).toEqual([]);
    expect(errors({ notes: `market ${market}` }).length).toBe(1);
    expect(errors({ notes: `the Router 0x12121212006e4CD160D18e3f00711DA5c3372600, and ${PUBLIC_VALUES[0]?.value ?? ""}` })).toEqual([]);
    expect(PUBLIC_VALUES.length).toBe(1);
  });
});

describe("V2-9 scan: the object rules, in every file", () => {
  it("MUTANT: a credential-shaped key in a capture body is refused", () => {
    const errors = scanEdited("protocol-v2/data-v2-oi-v2.jsonc", (body) => {
      firstRow(body)["api_secret"] = "c29tZS1yZWFsaXN0aWMtc2VjcmV0";
    });
    expect(errors).toEqual([
      "protocol-v2/data-v2-oi-v2.jsonc $.data[0].api_secret: a credential-shaped key whose value is not a sanitized placeholder",
    ]);
  });

  it("MUTANT: a live name or pseudonym in a person's row of a NON-trade capture is refused", () => {
    const path = "protocol-v2/data-v2-resolutions-v2-active.jsonc";
    const name = scanEdited(path, (body) => {
      Object.assign(firstRow(body), { proxy_wallet: "0x0000000000000000000000000000000000000401", name: "Probe Holder" });
    });
    expect(name).toContain(`${path} $.data[0].name: a name in a person's row must be a labelled synthetic value (synthetic-…)`);
    const pseudonym = scanEdited(path, (body) => {
      firstRow(body)["pseudonym"] = "Probe-Pseudonym";
    });
    expect(pseudonym).toContain(`${path} $.data[0].pseudonym: a pseudonym must be a labelled synthetic value (synthetic-…)`);
  });

  it("MUTANT: a live wallet, name, pseudonym or transaction hash in a trade row is refused", () => {
    const path = "protocol-v2/data-v2-trades-v1-page1.jsonc";
    const errors = scanEdited(path, (body) => {
      Object.assign(firstRow(body), { proxy_wallet: PROBE_WALLET, name: "Probe Trader", pseudonym: "Probe-Trader", transaction_hash: PROBE_HASH });
    });
    for (const key of ["proxy_wallet", "name", "pseudonym", "transaction_hash"]) {
      expect(errors.some((error) => error.startsWith(`${path} $.data[0].${key}: a `)), key).toBe(true);
    }
  });
});

describe("V2-9 scan: the read", () => {
  it("MUTANT: invalid UTF-8 is refused", () => {
    const path = "positions/router-v2.json";
    const bytes = Buffer.concat([bytesOf(path), Buffer.from([0xff])]);
    expect(scanFixtureFile(path, bytes, REPORTS)).toEqual([`${path}: not valid UTF-8`]);
  });

  it("MUTANT: a repeated key, which JSON.parse would hide, is refused; so is text that is not JSON", () => {
    const path = "market-ws/book-snapshot-v2.json";
    const text = bytesOf(path).toString("utf8").replace('"notes":', '"notes":"Contact the author", "notes":');
    expect(scan(path, text)).toEqual([
      `${path} $: the key "notes" occurs twice in one object; JSON.parse keeps only the last value, so an earlier one would escape every check`,
    ]);
    expect(scan(path, "{")[0]).toContain(`${path} $: not JSON`);
  });
});
