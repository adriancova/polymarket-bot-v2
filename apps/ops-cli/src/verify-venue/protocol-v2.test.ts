/**
 * V2-9: the Protocol V2 fixture catalogue under the offline venue gate.
 *
 * Every rule V2-9 adds is shown twice: it passes on the committed tree, and
 * it refuses a mutant. The mutants are built in memory (`validateCapture`,
 * `evaluatePins`, the `assert` hooks, a temporary directory for the coverage
 * walk); no committed fixture is written. Offline: no network, no
 * credential, no order.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  decodeFeedCursor,
  evaluatePins,
  isLabelledSyntheticHex,
  loadCapture,
  parseSourceIndex,
  redactionSubjects,
  reportDefinesId,
  resolvePath,
  sidecarPathOf,
  validateCapture,
} from "./captures.js";
import type {
  CaptureContext,
  CapturePin,
  CaptureSpec,
  CaptureValidationResult,
} from "./captures.js";
import {
  PROTOCOL_V2_CAPTURES,
  PROTOCOL_V2_REPORT_PATH,
  VENUE_CHECKS,
  assertBookV2,
  assertHeartbeatNotesCiteC20,
  assertRouterV2,
  reportOf,
} from "./checks.js";
import type { VenueCheck } from "./checks.js";
import {
  REPO_ROOT,
  VENUE_FIXTURE_ROOT,
  loadFixture,
  validateFixtureDocument,
} from "./fixtures.js";
import type { FixtureFile } from "./fixtures.js";
import {
  claimedFixturePaths,
  fixtureCoverage,
  formatVenueVerificationReport,
  listFixtureFiles,
  reportSectionText,
  runVenueVerification,
  validateCheckReport,
} from "./index.js";

const V2_REPORT = readFileSync(join(REPO_ROOT, PROTOCOL_V2_REPORT_PATH), "utf8");

const CONTEXT: CaptureContext = {
  report: PROTOCOL_V2_REPORT_PATH,
  reportContent: V2_REPORT,
  sourceIndex: parseSourceIndex(reportSectionText(V2_REPORT, "14") ?? ""),
};

function checkById(id: string): VenueCheck {
  const check = VENUE_CHECKS.find((candidate) => candidate.id === id);
  expect(check, id).toBeDefined();
  return check as VenueCheck;
}

function captureSpec(name: string): CaptureSpec {
  const spec = PROTOCOL_V2_CAPTURES.find(
    (candidate) => candidate.fixture === `protocol-v2/${name}`,
  );
  expect(spec, name).toBeDefined();
  return spec as CaptureSpec;
}

function fixtureText(relativePath: string): string {
  return readFileSync(join(VENUE_FIXTURE_ROOT, relativePath), "utf8");
}

function sidecarOf(spec: CaptureSpec): Record<string, unknown> {
  return JSON.parse(fixtureText(sidecarPathOf(spec.fixture))) as Record<string, unknown>;
}

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * Validates a capture whose text and sidecar are edited in memory. The
 * sidecar's `fixture_bytes` and `fixture_sha256` are recomputed for the new
 * text, so a digest refusal never masks the rule under test.
 */
function validateEdited(
  name: string,
  editText: (text: string) => string = (text) => text,
  editSidecar: (sidecar: Record<string, unknown>) => void = () => undefined,
  context: CaptureContext = CONTEXT,
): CaptureValidationResult {
  const spec = captureSpec(name);
  const text = editText(fixtureText(spec.fixture));
  const sidecar = sidecarOf(spec);
  sidecar["fixture_bytes"] = Buffer.byteLength(text, "utf8");
  sidecar["fixture_sha256"] = sha256(text);
  editSidecar(sidecar);
  return validateCapture(
    spec,
    Buffer.from(text, "utf8"),
    JSON.stringify(sidecar),
    context,
  );
}

function hasError(result: { readonly errors: readonly string[] }, fragment: string): boolean {
  return result.errors.some((error) => error.includes(fragment));
}

/** A JSON edit of a `json` capture, re-serialized compactly. */
function editJson(mutate: (body: Record<string, unknown>) => void): (text: string) => string {
  return (text) => {
    const body = JSON.parse(text) as Record<string, unknown>;
    mutate(body);
    return JSON.stringify(body);
  };
}

function firstRow(body: Record<string, unknown>): Record<string, unknown> {
  return (body["data"] as Record<string, unknown>[])[0] as Record<string, unknown>;
}

function pagination(body: Record<string, unknown>): Record<string, unknown> {
  return body["pagination"] as Record<string, unknown>;
}

/**
 * A SYNTHETIC cursor with the venue's feed-cursor structure:
 * base64url(`{"data":{"type":"trades","params":{l,ts,sq,d}},"sig":…}`). Its
 * values are invented and its signature is zeros, so it re-fetches nothing;
 * it exists to show the decoder refuses the structure.
 */
const SYNTHETIC_SEEK_ANCHOR_CURSOR = Buffer.from(
  JSON.stringify({
    data: { type: "trades", params: { l: 2, ts: 1700000001, sq: "synthetic", d: 2 } },
    sig: "00000000000000000000000000000000",
  }),
).toString("base64url");

// --- coverage ---------------------------------------------------------------

describe("V2-9 coverage: every file under test/fixtures/venue is claimed (plan row D9)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "v2-9-coverage-"));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("the protocol-v2 captures and sidecars are on disk and claimed, whatever their suffix", () => {
    const onDisk = listFixtureFiles();
    const v2 = onDisk.filter((path) => path.startsWith("protocol-v2/"));
    expect(v2.length).toBe(40);
    expect(v2.filter((path) => path.endsWith(".jsonc")).length).toBe(39);
    expect(v2.filter((path) => path.endsWith(".jsonl"))).toEqual([
      "protocol-v2/ws-market-v2-session.jsonl",
    ]);
    const coverage = fixtureCoverage(onDisk, claimedFixturePaths());
    expect(coverage).toEqual({
      ok: true,
      unclaimed: [],
      claimedTwice: [],
      missing: [],
      claimed: onDisk.length,
    });
  });

  it("the walk lists every suffix and skips only README.md", () => {
    mkdirSync(join(scratch, "protocol-v2"));
    for (const name of ["a.json", "protocol-v2/b.jsonc", "protocol-v2/c.jsonl", "protocol-v2/d.txt", "README.md", "protocol-v2/README.md"]) {
      writeFileSync(join(scratch, name), "{}\n");
    }
    expect(listFixtureFiles(scratch)).toEqual([
      "a.json",
      "protocol-v2/b.jsonc",
      "protocol-v2/c.jsonl",
      "protocol-v2/d.txt",
    ]);
  });

  it("MUTANT: an unclaimed .jsonc, a doubly claimed file and a missing claim each fail coverage", () => {
    const onDisk = [...listFixtureFiles(), "protocol-v2/smuggled.jsonc"].sort();
    const claimed = claimedFixturePaths();
    const unclaimed = fixtureCoverage(onDisk, claimed);
    expect(unclaimed.ok).toBe(false);
    expect(unclaimed.unclaimed).toEqual(["protocol-v2/smuggled.jsonc"]);

    const twice = fixtureCoverage(listFixtureFiles(), [...claimed, "protocol-v2/book-v2.jsonc"]);
    expect(twice.ok).toBe(false);
    expect(twice.claimedTwice).toEqual(["protocol-v2/book-v2.jsonc"]);

    const missing = fixtureCoverage(
      listFixtureFiles().filter((path) => path !== "positions/router-v2.json"),
      claimed,
    );
    expect(missing.ok).toBe(false);
    expect(missing.missing).toEqual(["positions/router-v2.json"]);
  });

  it("the gate itself reports coverage, and fails overall on an incomplete claim", () => {
    const report = runVenueVerification();
    expect(report.coverage.ok).toBe(true);
    expect(report.ok).toBe(true);
    expect(formatVenueVerificationReport(report)).toContain(
      `Fixture coverage: OK (${listFixtureFiles().length} files claimed)`,
    );
    const failing = formatVenueVerificationReport({
      ...report,
      ok: false,
      coverage: fixtureCoverage(["protocol-v2/smuggled.jsonc"], []),
    });
    expect(failing).toContain("Fixture coverage: INCOMPLETE");
    expect(failing).toContain("unclaimed: protocol-v2/smuggled.jsonc");
  });
});

// --- the captures -------------------------------------------------------------

describe("V2-9 captures: each committed capture passes against its sidecar and the report", () => {
  it("the catalogue lists the 20 captures of protocol-v2/README.md, each with pins", () => {
    expect(PROTOCOL_V2_CAPTURES.length).toBe(20);
    expect(new Set(PROTOCOL_V2_CAPTURES.map((spec) => spec.sourceId)).size).toBe(20);
    for (const spec of PROTOCOL_V2_CAPTURES) {
      expect(spec.pins.length, spec.fixture).toBeGreaterThan(0);
      expect(fixtureText("protocol-v2/README.md")).toContain(
        // The README index names each capture by its stem (the two-page
        // walks as `<stem>-page1`, `-page2`).
        spec.fixture.replace(/^protocol-v2\//, "").replace(/\.(?:jsonc|jsonl)$/, "").replace(/-page2$/, "-page1"),
      );
    }
  });

  for (const spec of PROTOCOL_V2_CAPTURES) {
    it(`${spec.fixture} passes (${spec.sourceId})`, () => {
      const result = loadCapture(spec, CONTEXT);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }

  it("no .jsonc held a comment: every capture and sidecar is one strict JSON document, so nothing moved and no digest changed", () => {
    for (const path of listFixtureFiles().filter((file) => file.endsWith(".jsonc"))) {
      expect(() => JSON.parse(fixtureText(path)), path).not.toThrow();
    }
    // A capture with neither a redaction nor an extract IS the raw response:
    // its committed digest equals the raw digest the report's source index
    // records (checked against §14 by the gate).
    for (const spec of PROTOCOL_V2_CAPTURES) {
      const sidecar = sidecarOf(spec);
      const untouched =
        (sidecar["redactions"] as unknown[]).length === 0 &&
        sidecar["extract"] === undefined;
      if (untouched) {
        expect(sidecar["fixture_sha256"], spec.fixture).toBe(sidecar["raw_sha256"]);
      }
    }
  });

  it("the source index parses one row per HTTP or WebSocket source", () => {
    expect(CONTEXT.sourceIndex.get("S-W01")).toEqual({
      id: "S-W01",
      time: "23:15:25Z",
      http: "WS",
      bytes: 35316,
      sha256: "3024eabbb25ef7f514bba9b93deee7b5b96690f72fc4cf3a8eba41f2a5293445",
    });
    expect(CONTEXT.sourceIndex.get("S-L02")?.http).toBe("404");
    // A duplicated id with different values matches nothing.
    const twice = parseSourceIndex(
      [
        "| S-X01 | `u` | 00:00:01Z | 200 | 1 | `" + "a".repeat(64) + "` |  |",
        "| S-X01 | `u` | 00:00:01Z | 200 | 2 | `" + "a".repeat(64) + "` |  |",
      ].join("\n"),
    );
    expect(twice.has("S-X01")).toBe(false);
  });
});

describe("V2-9 captures: MUTANTS of the sidecar, the bytes, the parse and the report", () => {
  it("MUTANT: one changed byte with the old digest is refused", () => {
    const spec = captureSpec("book-v2.jsonc");
    const text = fixtureText(spec.fixture).replace('"version":"v2"', '"version":"v3"');
    const result = validateCapture(
      spec,
      Buffer.from(text, "utf8"),
      fixtureText(sidecarPathOf(spec.fixture)),
      CONTEXT,
    );
    expect(hasError(result, "the capture's sha256 is")).toBe(true);
  });

  it("MUTANT: a JSONC comment is refused even when the digest matches", () => {
    const result = validateEdited("clob-markets-v1.jsonc", (text) => `// a comment\n${text}`);
    expect(hasError(result, "not one strict JSON document")).toBe(true);
  });

  it("MUTANT: a trailing comma is refused", () => {
    const result = validateEdited("data-v2-oi-v2.jsonc", (text) => text.replace("}]}", "},]}"));
    expect(hasError(result, "not one strict JSON document")).toBe(true);
  });

  it("MUTANT: invalid UTF-8 is refused", () => {
    const spec = captureSpec("book-v1.jsonc");
    const bytes = Buffer.concat([readFileSync(join(VENUE_FIXTURE_ROOT, spec.fixture)), Buffer.from([0xff])]);
    const sidecar = sidecarOf(spec);
    sidecar["fixture_bytes"] = bytes.length;
    sidecar["fixture_sha256"] = createHash("sha256").update(bytes).digest("hex");
    const result = validateCapture(spec, bytes, JSON.stringify(sidecar), CONTEXT);
    expect(hasError(result, "not valid UTF-8")).toBe(true);
  });

  it("MUTANT: a malformed .jsonl line, and a record with an unknown direction, are refused", () => {
    const broken = validateEdited("ws-market-v2-session.jsonl", (text) => `${text}{"t":"x",\n`);
    expect(hasError(broken, "not one strict JSON record")).toBe(true);
    const direction = validateEdited("ws-market-v2-session.jsonl", (text) =>
      text.replace('"dir":"open"', '"dir":"sideways"'),
    );
    expect(hasError(direction, 'line 1.dir: value "sideways" not in enum')).toBe(true);
  });

  it("MUTANT: a sidecar naming another fixture, source or report is refused", () => {
    const result = validateEdited("book-v2.jsonc", undefined, (sidecar) => {
      sidecar["fixture"] = "protocol-v2/book-v1.jsonc";
      sidecar["source_id"] = "S-L11";
      sidecar["report"] = "docs/venue/verified-2026-10-04.md";
    });
    expect(hasError(result, "sidecar.fixture: expected")).toBe(true);
    expect(hasError(result, "sidecar.source_id: expected S-L03")).toBe(true);
    expect(hasError(result, "sidecar.report: expected")).toBe(true);
  });

  it("MUTANT: an undeclared sidecar key is refused", () => {
    const result = validateEdited("book-v2.jsonc", undefined, (sidecar) => {
      sidecar["api_key"] = "sanitized-x";
    });
    expect(hasError(result, "sidecar.api_key: unexpected key")).toBe(true);
  });

  it("MUTANT: an authenticated capture is refused", () => {
    const result = validateEdited("book-v2.jsonc", undefined, (sidecar) => {
      sidecar["authenticated"] = true;
    });
    expect(hasError(result, "authenticated: must be exactly false")).toBe(true);
  });

  it("MUTANT: a non-official host, and a wallet-keyed Data API read, are refused", () => {
    const host = validateEdited("book-v2.jsonc", undefined, (sidecar) => {
      sidecar["url"] = "https://clob.polymarket.com.evil.example/book";
    });
    expect(hasError(host, "not an official public Polymarket host")).toBe(true);
    const wallet = validateEdited("data-v2-oi-v2.jsonc", undefined, (sidecar) => {
      sidecar["url"] = "https://data-api.polymarket.com/v2/positions?user=0x0000000000000000000000000000000000000001";
    });
    expect(hasError(wallet, "keyed by a wallet (user=)")).toBe(true);
  });

  it("MUTANT: an authenticated route on a public host (CLOB trades, the user channel) is refused", () => {
    const trades = validateEdited("book-v2.jsonc", undefined, (sidecar) => {
      sidecar["url"] = "https://clob.polymarket.com/data/trades?market=0x00";
    });
    expect(hasError(trades, "/data/trades is not a public CLOB market read")).toBe(true);
    const userChannel = validateEdited("ws-market-v2-session.jsonl", undefined, (sidecar) => {
      sidecar["url"] = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
    });
    expect(hasError(userChannel, "not an official public Polymarket host")).toBe(true);
    const bookPrefix = validateEdited("book-v2.jsonc", undefined, (sidecar) => {
      sidecar["url"] = "https://clob.polymarket.com/books";
    });
    expect(hasError(bookPrefix, "/books is not a public CLOB market read")).toBe(true);
  });

  it("MUTANT: the kind rules refuse a live-capture that is not the raw body, a redacted one with no redaction, and a docs example with no extract", () => {
    const notRaw = validateEdited("book-v1.jsonc", (text) => text.replace('"hash":"', '"hash":"0'));
    expect(hasError(notRaw, "sidecar.kind live-capture")).toBe(true);
    const listed = validateEdited("book-v1.jsonc", undefined, (sidecar) => {
      sidecar["redactions"] = ["hash: replaced"];
    });
    expect(hasError(listed, "sidecar.kind live-capture")).toBe(true);
    const unredacted = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["redactions"] = [];
    });
    expect(hasError(unredacted, "sidecar.kind live-capture-redacted")).toBe(true);
    const noExtract = validateEdited("gamma-market-v2-docs-example.jsonc", undefined, (sidecar) => {
      delete sidecar["extract"];
    });
    expect(hasError(noExtract, "sidecar.kind documentation-example")).toBe(true);
  });

  it("MUTANT: a sidecar whose raw digest, size, status, time or source differs from the report's source index is refused", () => {
    const digest = validateEdited("book-v2.jsonc", undefined, (sidecar) => {
      sidecar["raw_sha256"] = "0".repeat(64);
    });
    expect(hasError(digest, "report: S-L03 is 361 bytes")).toBe(true);
    const status = validateEdited("clob-markets-v2-62hex-not-found.jsonc", undefined, (sidecar) => {
      sidecar["http_status"] = "200";
    });
    expect(hasError(status, "report: S-L02 has HTTP 404")).toBe(true);
    const time = validateEdited("book-v2.jsonc", undefined, (sidecar) => {
      sidecar["fetched_utc"] = "2026-10-05T23:09:02Z";
    });
    expect(hasError(time, "report: S-L03 was fetched 2026-10-05T23:09:01Z")).toBe(true);
    const unknown = validateEdited("book-v2.jsonc", undefined, (sidecar) => {
      sidecar["source_id"] = "S-L99";
    });
    expect(hasError(unknown, "S-L99 has no row")).toBe(true);
  });

  it("MUTANT: a credential-shaped value anywhere in a capture is refused", () => {
    const result = validateEdited(
      "data-v2-oi-v2.jsonc",
      editJson((body) => {
        firstRow(body)["apiKey"] = "realistic-secret-value-123";
      }),
    );
    expect(hasError(result, "credential/secret-shaped field")).toBe(true);
  });

  it("MUTANT: a live wallet or pseudonym in a NON-feed capture is refused too", () => {
    const result = validateEdited(
      "data-v2-resolutions-v2-active.jsonc",
      editJson((body) => {
        firstRow(body)["proxy_wallet"] = "0x56687bf447db6ffa42ffe2204a05edaa20f55839";
        firstRow(body)["pseudonym"] = "Some-Person";
      }),
    );
    expect(hasError(result, "proxy_wallet: a wallet must be a labelled synthetic address")).toBe(true);
    expect(hasError(result, "pseudonym: a pseudonym must be a labelled synthetic value")).toBe(true);
  });

  it("MUTANT: a pinned id that the report does not define is refused", () => {
    const stripped = V2_REPORT.replace("**F-62 (OBS)", "F-62 (OBS)");
    const result = validateEdited("book-v1.jsonc", undefined, undefined, {
      ...CONTEXT,
      reportContent: stripped,
    });
    expect(result.errors).toEqual([]);
    const session = validateEdited("ws-market-v2-session.jsonl", undefined, undefined, {
      ...CONTEXT,
      reportContent: stripped,
    });
    expect(session.errors).toEqual([
      `report: F-62 is not defined in ${PROTOCOL_V2_REPORT_PATH}`,
    ]);
  });
});

// --- trade and activity feeds ---------------------------------------------------

describe("V2-9 trade and activity captures (report §15; plan acceptance 5)", () => {
  it("the committed trade pages pass, and their sidecars list timestamp and next_cursor", () => {
    for (const name of ["data-v2-trades-v1-page1.jsonc", "data-v2-trades-v1-page2.jsonc"]) {
      expect(validateEdited(name).errors, name).toEqual([]);
      const subjects = (sidecarOf(captureSpec(name))["redactions"] as string[]).flatMap(redactionSubjects);
      expect(subjects, name).toContain("timestamp");
      expect(subjects, name).toContain("next_cursor");
    }
  });

  it("the decoder recognizes the venue's cursor structure and not the labelled synthetic one", () => {
    // The committed prices-history cursor (a public time-series cursor, not a
    // trade feed) has the venue's encoding: base64url JSON {data:{type,params},sig}.
    const venueCursor = resolvePath(
      JSON.parse(fixtureText("protocol-v2/data-v2-prices-history-page1.jsonc")),
      "pagination.next_cursor",
    ).value as string;
    expect(resolvePath(decodeFeedCursor(venueCursor), "data.type").value).toBe("prices_history");
    expect(resolvePath(decodeFeedCursor(SYNTHETIC_SEEK_ANCHOR_CURSOR), "data.params.ts").found).toBe(true);
    expect(decodeFeedCursor("synthetic-cursor-trades-p1-next")).toBeUndefined();
    expect(decodeFeedCursor('{"anchor":1}')).toEqual({ anchor: 1 });
  });

  it("MUTANT: a next_cursor that decodes to a feed seek anchor is refused", () => {
    const result = validateEdited(
      "data-v2-trades-v1-page1.jsonc",
      editJson((body) => {
        pagination(body)["next_cursor"] = SYNTHETIC_SEEK_ANCHOR_CURSOR;
      }),
    );
    expect(result.errors).toEqual([
      "$.pagination.next_cursor: the cursor decodes to a venue feed cursor (params l, ts, sq, d), which carries the seek anchor of the last row (S-O06) and re-fetches the unredacted page; replace it with a labelled synthetic value",
      `$.pagination.next_cursor: a trade or activity cursor must be a labelled synthetic value (synthetic-cursor-…), got ${JSON.stringify(SYNTHETIC_SEEK_ANCHOR_CURSOR.slice(0, 24))}…`,
    ]);
  });

  it("MUTANT: a seek-anchor cursor in the sidecar URL is refused", () => {
    const result = validateEdited("data-v2-trades-v1-page2.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `https://data-api.polymarket.com/v2/trades?condition=0xcd5f9f505e0c0182746aa65963f72f01e7463259e5ea9f56672c0fe3a37f348a&cursor=${SYNTHETIC_SEEK_ANCHOR_CURSOR}`;
    });
    expect(hasError(result, "sidecar url cursor: the cursor decodes to a venue feed cursor")).toBe(true);
  });

  it("MUTANT: an unlabelled cursor is refused even when it decodes to nothing", () => {
    const result = validateEdited(
      "data-v2-trades-v1-page1.jsonc",
      editJson((body) => {
        pagination(body)["next_cursor"] = "opaque123";
      }),
    );
    expect(result.errors).toEqual([
      '$.pagination.next_cursor: a trade or activity cursor must be a labelled synthetic value (synthetic-cursor-…), got "opaque123"…',
    ]);
  });

  it("MUTANT: a live-looking wallet, name, pseudonym or transaction hash in a trade row is refused", () => {
    const result = validateEdited(
      "data-v2-trades-v1-page1.jsonc",
      editJson((body) => {
        const row = firstRow(body);
        row["proxy_wallet"] = "0x56687bf447db6ffa42ffe2204a05edaa20f55839";
        row["name"] = "a-real-looking-name";
        row["pseudonym"] = "Real-Looking-Pseudonym";
        row["transaction_hash"] = "0x9f2c1a7d3e5b4c6a8d0e2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e";
      }),
    );
    // Each refused once: the wallet and pseudonym by the personal-key scan,
    // the name and hash by the feed rule.
    expect(result.errors.length).toBe(4);
    for (const fragment of [
      "$.data[0].proxy_wallet: a wallet must be a labelled synthetic address",
      "$.data[0].name: a name must be a labelled synthetic value",
      "$.data[0].pseudonym: a pseudonym must be a labelled synthetic value",
      "$.data[0].transaction_hash: a hash must be a labelled synthetic hash",
    ]) {
      expect(hasError(result, fragment), fragment).toBe(true);
    }
  });

  it("MUTANT: an EMPTY name, or an all-zero-looking but full-width live hash, is not a labelled synthetic value", () => {
    expect(isLabelledSyntheticHex("0x0000000000000000000000000000000000000101", 40)).toBe(true);
    expect(isLabelledSyntheticHex("0x0000000000000000000000000000000000000000", 40)).toBe(true);
    expect(isLabelledSyntheticHex("0x00000000000Fb5C9ADea0298D729A0CB3823Cc07", 40)).toBe(false);
    expect(isLabelledSyntheticHex("0x0000000000000000000000000000000000000101", 64)).toBe(false);
    const result = validateEdited(
      "data-v2-trades-v1-page2.jsonc",
      editJson((body) => {
        firstRow(body)["name"] = "";
      }),
    );
    expect(hasError(result, "$.data[0].name: a name must be a labelled synthetic value")).toBe(true);
  });

  it("MUTANT: a sidecar whose redactions do not list timestamp, or next_cursor, is refused", () => {
    const withoutTimestamp = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["redactions"] = (sidecar["redactions"] as string[]).filter((entry) => !entry.startsWith("timestamp"));
    });
    expect(withoutTimestamp.errors).toEqual([
      "sidecar redactions: a trade or activity page with rows or a cursor must list timestamp (report §15)",
    ]);
    const withoutCursor = validateEdited("data-v2-trades-v1-page2.jsonc", undefined, (sidecar) => {
      sidecar["redactions"] = (sidecar["redactions"] as string[]).filter((entry) => !entry.startsWith("pagination.next_cursor"));
    });
    expect(withoutCursor.errors).toEqual([
      "sidecar redactions: a trade or activity page with rows or a cursor must list next_cursor (report §15)",
    ]);
  });

  it("the empty page (no row, null cursor) is the raw body and needs no redaction; MUTANT: a row added to it needs both", () => {
    expect(validateEdited("data-v2-trades-v2-empty.jsonc").errors).toEqual([]);
    const withRow = validateEdited(
      "data-v2-trades-v2-empty.jsonc",
      editJson((body) => {
        (body["data"] as unknown[]).push({
          proxy_wallet: "0x0000000000000000000000000000000000000301",
          name: "synthetic-name-p3-r1",
          transaction_hash: `0x${"0".repeat(61)}301`,
          timestamp: 1700000009,
        });
      }),
    );
    expect(hasError(withRow, "must list timestamp")).toBe(true);
    expect(hasError(withRow, "must list next_cursor")).toBe(true);
  });

  it("MUTANT: feed rules apply to a capture whose rows carry a wallet even when its URL is not a feed route", () => {
    const result = validateEdited(
      "data-v2-oi-v2.jsonc",
      editJson((body) => {
        firstRow(body)["proxy_wallet"] = "0x0000000000000000000000000000000000000401";
        firstRow(body)["transaction_hash"] = "0x9f2c1a7d3e5b4c6a8d0e2f4a6c8e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c4e";
      }),
    );
    expect(hasError(result, "$.data[0].transaction_hash: a hash must be a labelled synthetic hash")).toBe(true);
    expect(hasError(result, "must list timestamp")).toBe(true);
  });

  it("redaction subjects are the field names before the colon", () => {
    expect(redactionSubjects("name, pseudonym: replaced with …")).toEqual(["name", "pseudonym"]);
    expect(redactionSubjects("pagination.next_cursor (round 1): replaced …")).toEqual(["next_cursor"]);
    expect(redactionSubjects("timestamp (round 1): replaced …")).toEqual(["timestamp"]);
    expect(redactionSubjects("every other byte (market fields, side) is unchanged")).toEqual([]);
  });
});

// --- the pins ---------------------------------------------------------------------

/** Writes `value` at a pin path in a cloned view (creating the last key). */
function setPath(root: unknown, path: string, value: unknown): unknown {
  const clone = structuredClone(root);
  const segments = [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((match) =>
    match[1] !== undefined ? match[1] : Number(match[2]),
  );
  let current = clone as Record<string | number, unknown>;
  segments.slice(0, -1).forEach((segment) => {
    current = current[segment] as Record<string | number, unknown>;
  });
  current[segments.at(-1) as string | number] = value;
  return clone;
}

describe("V2-9 pins: each capture's pinned V2 facts", () => {
  for (const spec of PROTOCOL_V2_CAPTURES) {
    for (const pin of spec.pins) {
      it(`MUTANT: ${spec.fixture} pin ${pin.path} refuses a changed value`, () => {
        const view = loadCapture(spec, CONTEXT).view;
        expect(evaluatePins(view, [pin])).toEqual([]);
        const mutant = setPath(view, pin.path, { mutant: true });
        expect(evaluatePins(mutant, [pin]).length).toBeGreaterThan(0);
      });
    }
  }

  it("every pinned id is defined in the V2 report", () => {
    const ids = new Set(PROTOCOL_V2_CAPTURES.flatMap((spec) => [spec.sourceId, ...spec.pins.flatMap((pin) => pin.facts)]));
    for (const id of ids) {
      expect(reportDefinesId(V2_REPORT, id), id).toBe(true);
    }
    expect(reportDefinesId(V2_REPORT, "F-99")).toBe(false);
    expect(reportDefinesId(V2_REPORT, "O.9")).toBe(false);
  });

  it("MUTANT: swapping the position ids, or one id off by 256, breaks the derivation pins", () => {
    const spec = captureSpec("clob-markets-v2.jsonc");
    const view = loadCapture(spec, CONTEXT).view;
    const pins = spec.pins.filter((pin) => "positionIdOf" in pin);
    expect(pins.length).toBe(2);
    const first = resolvePath(view, "t[0].t").value as string;
    const second = resolvePath(view, "t[1].t").value as string;
    const swapped = setPath(setPath(view, "t[0].t", second), "t[1].t", first);
    expect(evaluatePins(swapped, pins).filter((error) => error.includes("positionId & 255")).length).toBe(2);
    const shifted = setPath(view, "t[0].t", (BigInt(first) + 256n).toString());
    expect(evaluatePins(shifted, pins).some((error) => error.includes("positionId >> 8"))).toBe(true);
  });

  it("an absent pin refuses the key once it appears", () => {
    const pin: CapturePin = { path: "version", absent: true, facts: ["C-21"] };
    const view = loadCapture(captureSpec("book-v1.jsonc"), CONTEXT).view;
    expect(evaluatePins(view, [pin])).toEqual([]);
    expect(evaluatePins(setPath(view, "version", "v2"), [pin])).toEqual([
      "pin version (C-21): the key must be absent",
    ]);
  });
});

// --- the V2 book frame (plan row D8) -----------------------------------------------

function loadedFixture(path: string): FixtureFile {
  const result = loadFixture(path, {});
  expect(result.fixture, result.errors.join("; ")).not.toBeNull();
  return structuredClone(result.fixture as FixtureFile);
}

function bookErrors(mutate: (payload: Record<string, unknown>) => void): string[] {
  const fixture = loadedFixture("market-ws/book-snapshot-v2.json");
  const payload = (fixture.examples[0] as { payload: Record<string, unknown> }).payload;
  mutate(payload);
  const check = checkById("market-ws-book-v2");
  return [
    ...validateFixtureDocument(fixture, "market-ws/book-snapshot-v2", check.payloadSpec).errors,
    ...(check.assert?.(fixture) ?? []),
  ];
}

describe("V2-9 market-ws-book-v2: the V2 book frame with its version (C-21)", () => {
  it("passes: the committed capture's frame, with version v2 and a derivable asset id", () => {
    expect(bookErrors(() => undefined)).toEqual([]);
  });

  it("MUTANT: a frame without version, or with another version, is refused", () => {
    expect(bookErrors((payload) => {
      delete payload["version"];
    })).toContain("examples[0].payload.version: missing required key");
    expect(bookErrors((payload) => {
      payload["version"] = "v3";
    }).some((error) => error.includes('value "v3" not in enum [v2]'))).toBe(true);
  });

  it("MUTANT: any value that differs from the committed capture is refused", () => {
    expect(bookErrors((payload) => {
      payload["timestamp"] = "1791238858576";
    })).toEqual([
      "examples book-snapshot-v2-position-id: must equal element 0 of the frame on line 3 of protocol-v2/ws-market-v2-session.jsonl, value for value",
    ]);
  });

  it("MUTANT: an asset id whose condition is not the frame's market is refused", () => {
    const errors = bookErrors((payload) => {
      payload["asset_id"] = (BigInt(payload["asset_id"] as string) + 256n).toString();
    });
    expect(errors).toContain(
      "examples book-snapshot-v2-position-id: asset_id >> 8 must be the market's condition narrowed to 31 bytes (F-42, F-44)",
    );
  });

  it("MUTANT: an example traced to no capture line is refused", () => {
    const fixture = loadedFixture("market-ws/book-snapshot-v2.json");
    (fixture.examples[0] as { name: string }).name = "book-from-nowhere";
    expect(assertBookV2(fixture)).toContain(
      "examples book-from-nowhere: not traced to a committed capture line",
    );
  });

  it("the V1 book check still refuses a version key (its SDK field list is unchanged)", () => {
    const fixture = loadedFixture("market-ws/book-snapshot-v2.json");
    expect(
      validateFixtureDocument(fixture, "market-ws/book-snapshot-v2", checkById("market-ws-book").payloadSpec).errors,
    ).toContain("examples[0].payload.version: unexpected key (schema is frozen against its official source)");
  });
});

// --- the V2 Router fixtures (plan row D7, the V2 half) --------------------------------

function routerErrors(mutate: (fixture: FixtureFile) => void): string[] {
  const fixture = loadedFixture("positions/router-v2.json");
  mutate(fixture);
  const check = checkById("position-operations-v2");
  return [
    ...validateFixtureDocument(fixture, "positions/router-v2", check.payloadSpec).errors,
    ...(check.assert?.(fixture) ?? []),
  ];
}

function exampleOf(fixture: FixtureFile, name: string): Record<string, unknown> {
  const example = fixture.examples.find((candidate) => candidate.name === name);
  expect(example, name).toBeDefined();
  return (example as { payload: Record<string, unknown> }).payload;
}

function requestOf(fixture: FixtureFile, name: string): Record<string, unknown> {
  return exampleOf(fixture, name)["request"] as Record<string, unknown>;
}

describe("V2-9 position-operations-v2: Router and PositionManager from the documentation", () => {
  it("passes: documented addresses, ABI signatures, derivations and one redeem per outcome", () => {
    expect(routerErrors(() => undefined)).toEqual([]);
    expect(assertRouterV2(loadedFixture("positions/router-v2.json"))).toEqual([]);
  });

  it("MUTANT: an outcome index other than 0 or 1 is refused", () => {
    expect(routerErrors((fixture) => {
      requestOf(fixture, "redeem-no-synthetic-amount")["outcomeIndex"] = 2;
    })).toContain(
      "examples redeem-no-synthetic-amount: outcomeIndex must be 0 (YES) or 1 (NO) (S-D04 line 56)",
    );
  });

  it("MUTANT: dropping the NO redeem breaks one call per outcome", () => {
    expect(routerErrors((fixture) => {
      (fixture as { examples: FixtureFile["examples"] }).examples = fixture.examples.filter(
        (example) => example.name !== "redeem-no-synthetic-amount",
      );
    })).toContain("redeem: one call per outcome, outcomes 0 and 1 each once (S-D12 lines 625, 754)");
  });

  it("MUTANT: a padded bytes32 condition in a Router call is refused (Router takes bytes31)", () => {
    expect(routerErrors((fixture) => {
      const request = requestOf(fixture, "split-documented-amount");
      request["conditionId"] = `${request["conditionId"] as string}00`;
    }).some((error) => error.includes("request.conditionId: expected a 0x-prefixed hex string of length [64], got 66"))).toBe(true);
  });

  it("MUTANT: a condition id that is not the documentation's is refused", () => {
    expect(routerErrors((fixture) => {
      requestOf(fixture, "merge-synthetic-amount")["conditionId"] = `0x${"1".repeat(62)}`;
    })).toContain(
      "examples merge-synthetic-amount: conditionId must be the documentation's V2 condition (S-D17 line 281)",
    );
  });

  it("MUTANT: an address that is not the documented proxy is refused", () => {
    expect(routerErrors((fixture) => {
      exampleOf(fixture, "split-documented-amount")["target"] = "0x91fA5E2F12a308A13DefdB6aaF80B71DBe9B7696";
    }).some((error) => error.includes("target: value") && error.includes("not in enum"))).toBe(true);
  });

  it("MUTANT: a derivation with the wrong outcome, or a non-documented id, is refused", () => {
    expect(routerErrors((fixture) => {
      exampleOf(fixture, "derive-no-from-documented-position-id")["outcome_index"] = 0;
    })).toContain("examples derive-no-from-documented-position-id: outcome_index must be position_id & 255");
    expect(routerErrors((fixture) => {
      requestOf(fixture, "payout-read-synthetic-amount")["positionId"] = "1";
    })).toContain(
      "examples payout-read-synthetic-amount: positionId must be one of the documentation's (S-D16)",
    );
  });

  it("MUTANT: narrowing a bytes32 whose final byte is not zero is refused", () => {
    expect(routerErrors((fixture) => {
      const payload = exampleOf(fixture, "narrow-padded-documented-condition");
      payload["condition_id_bytes32"] = `${(payload["condition_id_bytes32"] as string).slice(0, -2)}01`;
    })).toContain(
      "examples narrow-padded-documented-condition: a bytes32 condition narrows only when its final byte is zero, to its first 31 bytes (S-D04 line 54)",
    );
  });

  it("MUTANT: an operator approval that is not true, and a zero amount, are refused", () => {
    expect(routerErrors((fixture) => {
      exampleOf(fixture, "operator-approval-for-merge-and-redeem")["approved"] = false;
    })).toContain("examples operator-approval-for-merge-and-redeem: approved must be true (S-D04 line 40)");
    expect(routerErrors((fixture) => {
      requestOf(fixture, "split-documented-amount")["amount"] = "0";
    })).toContain("examples split-documented-amount: amount must be positive base units");
  });

  it("labels every synthetic value it carries", () => {
    const fixture = loadedFixture("positions/router-v2.json");
    expect(fixture.notes).toContain("SYNTHETIC");
    for (const name of [
      "approve-pusd-for-split",
      "merge-synthetic-amount",
      "redeem-yes-synthetic-amount",
      "redeem-no-synthetic-amount",
      "payout-read-synthetic-amount",
    ]) {
      expect(exampleOf(fixture, name)["description"], name).toContain("SYNTHETIC");
    }
    expect(fixture.examples.length).toBe(11);
  });

  it("leaves the CTF fixture as it was: V1 operations only, retrieved 2026-08-24", () => {
    const ctf = loadedFixture("positions/split-merge-redeem.json");
    expect(ctf.retrieved).toBe("2026-08-24");
    expect(ctf.examples.map((example) => example.payload["operation"])).not.toContain("contract-addresses-v2");
  });
});

// --- the heartbeat note (plan acceptance 3) ---------------------------------------------

describe("V2-9 heartbeat: the notes cite C-20", () => {
  it("passes: the committed notes cite C-20 and its report, and keep the timing", () => {
    const fixture = loadedFixture("heartbeat/heartbeat.json");
    expect(assertHeartbeatNotesCiteC20(fixture)).toEqual([]);
    expect(fixture.notes).toContain("10 seconds");
    expect(fixture.notes).toContain("5 seconds");
  });

  it("MUTANT: notes that do not cite C-20, or its report, are refused", () => {
    const fixture = loadedFixture("heartbeat/heartbeat.json");
    const noConflict = { ...fixture, notes: fixture.notes.replaceAll("C-20", "C-2O") };
    expect(assertHeartbeatNotesCiteC20(noConflict)).toEqual([
      "notes: must cite conflict C-20 (the 400 key is error_msg in the guide and error in the CLOB OpenAPI; POST /heartbeats is a second documented route)",
    ]);
    const noReport = { ...fixture, notes: fixture.notes.replaceAll(PROTOCOL_V2_REPORT_PATH, "the report") };
    expect(assertHeartbeatNotesCiteC20(noReport)).toEqual([
      `notes: must name the report that records C-20 (${PROTOCOL_V2_REPORT_PATH})`,
    ]);
  });
});

// --- the V2 report (plan acceptance 6) ----------------------------------------------

describe("V2-9 report: the V2 checks are validated against verified-2026-10-05.md", () => {
  const v2Checks = VENUE_CHECKS.filter((check) => reportOf(check) === PROTOCOL_V2_REPORT_PATH);

  it("three checks, each citing ids the report defines, in a section it has", () => {
    expect(v2Checks.map((check) => check.id)).toEqual([
      "market-ws-book-v2",
      "position-operations-v2",
      "protocol-v2-captures",
    ]);
    for (const check of v2Checks) {
      expect(check.facts?.length, check.id).toBeGreaterThan(0);
      expect(validateCheckReport(check, V2_REPORT), check.id).toEqual([]);
    }
  });

  it("MUTANT: an undefined id, no ids, a missing section, or no report are refused", () => {
    const check = checkById("market-ws-book-v2");
    expect(validateCheckReport(check, V2_REPORT.replace("| **C-21 (new)** |", "| C-21 (new) |"))).toEqual([
      `C-21 is not defined in ${PROTOCOL_V2_REPORT_PATH}`,
    ]);
    expect(validateCheckReport({ ...check, facts: [] }, V2_REPORT)).toEqual([
      `a check of ${PROTOCOL_V2_REPORT_PATH} must cite the ids it pins (facts)`,
    ]);
    expect(validateCheckReport({ ...check, reportSection: "99" }, V2_REPORT)).toEqual([
      `report ${PROTOCOL_V2_REPORT_PATH} has no section 99`,
    ]);
    expect(validateCheckReport(check, null)).toEqual([
      `report ${PROTOCOL_V2_REPORT_PATH} is unavailable`,
    ]);
  });

  it("the baseline checks keep the frozen 2026-08-24 report", () => {
    for (const check of VENUE_CHECKS.filter((candidate) => !v2Checks.includes(candidate))) {
      expect(reportOf(check), check.id).toBe("docs/venue/verified-2026-08-24.md");
      expect(validateCheckReport(check, null), check.id).toEqual([]);
    }
  });

  it("the run validates every capture and every V2 fixture, and passes", () => {
    const report = runVenueVerification();
    const captures = report.results.find((result) => result.check.id === "protocol-v2-captures");
    expect(captures?.status).toBe("PASS");
    expect(captures?.captureResults.length).toBe(20);
    expect(captures?.captureResults.every((result) => result.ok)).toBe(true);
    for (const id of ["market-ws-book-v2", "position-operations-v2", "heartbeat"]) {
      expect(report.results.find((result) => result.check.id === id)?.status, id).toBe("PASS");
    }
  });
});

// --- the parent fixture rules (plan acceptance 4) ------------------------------------

describe("V2-9 parent fixture rules: the dated, scoped exception", () => {
  it("the parent README carries the dated exception for sanitized live public captures", () => {
    const readme = fixtureText("README.md");
    expect(readme).toContain("## Exception 2026-10-06 (V2-9): sanitized live public captures");
    expect(readme).toContain("protocol-v2/");
    expect(readme).toContain("market-ws/book-snapshot-v2.json");
  });
});
