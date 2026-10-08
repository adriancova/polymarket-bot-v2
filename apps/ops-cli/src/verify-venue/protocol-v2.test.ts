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
  cursorLikeTokens,
  decodeFeedCursor,
  duplicateKeys,
  evaluatePins,
  isLabelledSyntheticHex,
  isLabelledSyntheticText,
  loadCapture,
  marketReadConditionIds,
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
  PUBLIC_CONTRACT_ADDRESSES,
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
const V2_SOURCE_INDEX = reportSectionText(V2_REPORT, "14") ?? "";

/** The context the gate passes (`index.ts` `runVenueVerification`). */
const CONTEXT: CaptureContext = {
  report: PROTOCOL_V2_REPORT_PATH,
  reportContent: V2_REPORT,
  sourceIndex: parseSourceIndex(V2_SOURCE_INDEX),
  publicAddresses: PUBLIC_CONTRACT_ADDRESSES,
  marketConditionIds: marketReadConditionIds(V2_SOURCE_INDEX),
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
    // Each refused once, by the personal-data scan: the wallet and pseudonym
    // by their keys, the name and hash because a feed row is a person's row.
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

// --- round 1: personal data everywhere (V2-9-R1-01) --------------------------------

/**
 * SYNTHETIC probe values, invented for these mutants (the verifier's round-1
 * probes): a 40-hex address with no leading zeros, a 64-hex hash, a spaced
 * name and an `example.invalid` email. None is a real person or account.
 */
const PROBE_WALLET = `0x${"1234567890".repeat(4)}`;
const PROBE_HASH = `0x${"1234567890abcdef".repeat(4)}`;
const PROBE_NAME = "Reviewer Probe";
const PROBE_EMAIL = "reviewer-probe@example.invalid";
const PROBE_DISCLOSURE = ` Original proxy_wallet: ${PROBE_WALLET}; original name: ${PROBE_NAME}; email: ${PROBE_EMAIL}`;

/**
 * Marks an edited live capture as redacted, so the kind rule (a live-capture
 * IS the raw body) does not mask the rule under test.
 */
function asRedacted(sidecar: Record<string, unknown>): void {
  sidecar["kind"] = "live-capture-redacted";
  sidecar["redactions"] = ["probe: a test mutant edit"];
}

/** Appends one record, whose `data` is this frame text, to a `.jsonl` capture. */
function appendRecord(frameText: string): (text: string) => string {
  return (text) =>
    `${text}${JSON.stringify({ t: "2026-10-05T23:16:26.000Z", dir: "recv", data: frameText })}\n`;
}

describe("V2-9 r1: personal data in sidecars and in every capture field (V2-9-R1-01)", () => {
  it("every committed sidecar's text and every committed capture pass the round-1 policy", () => {
    for (const spec of PROTOCOL_V2_CAPTURES) {
      expect(validateEdited(spec.fixture.replace("protocol-v2/", "")).errors, spec.fixture).toEqual([]);
    }
  });

  it("MUTANT (verifier probe): a trade sidecar's notes disclosing a wallet, a name and an email are refused", () => {
    const result = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["notes"] = `${sidecar["notes"] as string}${PROBE_DISCLOSURE}`;
    });
    expect(result.errors).toEqual([
      "sidecar.notes: an email address may not be committed (personal data)",
      "sidecar.notes: a 0x 40-hex address that is neither a labelled synthetic value (0x00…) nor a documented public contract address; it may be a wallet",
      "sidecar.notes: proxy_wallet is written with a value that is not a labelled synthetic value, a <placeholder> or empty",
      "sidecar.notes: name is written with a value that is not a labelled synthetic value, a <placeholder> or empty",
      "sidecar.notes: email is written with a value that is not a labelled synthetic value, a <placeholder> or empty",
    ]);
    // The refusals never echo the probe values.
    for (const value of [PROBE_WALLET, PROBE_NAME, PROBE_EMAIL]) {
      expect(result.errors.join("\n")).not.toContain(value);
    }
  });

  it("MUTANT: the same disclosure is refused in EVERY sidecar, feed or not", () => {
    for (const spec of PROTOCOL_V2_CAPTURES) {
      const name = spec.fixture.replace("protocol-v2/", "");
      const result = validateEdited(name, undefined, (sidecar) => {
        sidecar["notes"] = `${sidecar["notes"] as string}${PROBE_DISCLOSURE}`;
      });
      expect(hasError(result, "sidecar.notes: an email address"), name).toBe(true);
      expect(hasError(result, "sidecar.notes: a 0x 40-hex address"), name).toBe(true);
      expect(hasError(result, "sidecar.notes: name is written with a value"), name).toBe(true);
    }
  });

  it("MUTANT: a redaction's description, a docs extract rule and the URL are scanned too", () => {
    const redaction = validateEdited("data-v2-trades-v1-page2.jsonc", undefined, (sidecar) => {
      sidecar["redactions"] = [
        ...(sidecar["redactions"] as string[]),
        `pseudonym: the original was pseudonym=Real-Handle, wallet ${PROBE_WALLET}`,
      ];
    });
    expect(hasError(redaction, "sidecar.redactions[9]: a 0x 40-hex address")).toBe(true);
    expect(hasError(redaction, "sidecar.redactions[9]: pseudonym is written with a value")).toBe(true);
    const rule = validateEdited("gamma-market-v2-docs-example.jsonc", undefined, (sidecar) => {
      const extract = sidecar["extract"] as Record<string, unknown>;
      extract["rule"] = `${extract["rule"] as string}; reviewed by ${PROBE_EMAIL}`;
    });
    expect(rule.errors).toEqual([
      "sidecar.extract.rule: an email address may not be committed (personal data)",
    ]);
    const url = validateEdited("data-v2-oi-v2.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}&market=${PROBE_WALLET}&note=${PROBE_EMAIL}`;
    });
    expect(url.errors).toEqual([
      "sidecar.url: an email address may not be committed (personal data)",
      "sidecar.url: a 0x 40-hex address that is neither a labelled synthetic value (0x00…) nor a documented public contract address; it may be a wallet",
    ]);
  });

  it("MUTANT: a live hash in sidecar prose is refused; the condition its URL or capture carries is not", () => {
    const hash = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["notes"] = `${sidecar["notes"] as string} First row's transaction ${PROBE_HASH}.`;
    });
    expect(hash.errors).toEqual([
      "sidecar.notes: a hex id, hash or number of 40 or more digits that is not a labelled synthetic value and that neither the capture nor the URL carries; name it by placeholder (<V1 window>)",
    ]);
    const bare = validateEdited("data-v2-trades-v1-page2.jsonc", undefined, (sidecar) => {
      sidecar["notes"] = `${sidecar["notes"] as string} Wallet ${PROBE_WALLET.slice(2)}.`;
    });
    expect(bare.errors).toEqual(hash.errors);
    const condition = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["notes"] = `${sidecar["notes"] as string} Condition 0xcd5f9f505e0c0182746aa65963f72f01e7463259e5ea9f56672c0fe3a37f348a; synthetic hash 0x${"0".repeat(61)}101; address 0x00…<page><row>.`;
    });
    expect(condition.errors).toEqual([]);
  });

  it("placeholders, empty values and labelled synthetic values may follow a personal key in prose", () => {
    const result = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["notes"] = `${sidecar["notes"] as string} Shape: name: <name>, "pseudonym":"synthetic-pseudonym-p1-r1", bio: "", proxy_wallet=0x0000000000000000000000000000000000000101, user=<wallet>, email: null, transaction_hash: 0x00…<page><row>.`;
    });
    expect(result.errors).toEqual([]);
  });

  it("MUTANT (verifier probe): an email in a feed row, under its own key or inside a public field, is refused", () => {
    const ownKey = validateEdited(
      "data-v2-trades-v1-page1.jsonc",
      editJson((body) => {
        firstRow(body)["email"] = PROBE_EMAIL;
      }),
    );
    expect(ownKey.errors).toEqual([
      "$.data[0].email: an email field must be empty or a labelled synthetic value (synthetic-…)",
      "$.data[0].email: not a Trade or Activity field (S-O06); an unrecognized field may carry personal data, so classify it in FEED_ROW_FIELDS, with its source, before committing it",
    ]);
    const inTitle = validateEdited(
      "data-v2-trades-v1-page1.jsonc",
      editJson((body) => {
        firstRow(body)["title"] = `Bitcoin Up or Down (ask ${PROBE_EMAIL})`;
      }),
    );
    expect(inTitle.errors).toEqual([
      "$.data[0].title: an email address may not be committed (personal data)",
    ]);
  });

  it("MUTANT (verifier probe): a nested name or hash, or any unrecognized field, in a trade or activity page is refused", () => {
    const nested = validateEdited(
      "data-v2-trades-v1-page1.jsonc",
      editJson((body) => {
        firstRow(body)["profile"] = { name: PROBE_NAME, transaction_hash: PROBE_HASH };
      }),
    );
    // The nested name is refused twice over: in a Data API capture every
    // `name` is a wallet's display name (S-O06), and `profile` is no Trade field.
    expect(nested.errors).toEqual([
      "$.data[0].profile.name: a name must be a labelled synthetic value (synthetic-…)",
      "$.data[0].profile: not a Trade or Activity field (S-O06); an unrecognized field may carry personal data, so classify it in FEED_ROW_FIELDS, with its source, before committing it",
    ]);
    const objectInKnownField = validateEdited(
      "data-v2-trades-v1-page2.jsonc",
      editJson((body) => {
        firstRow(body)["title"] = { text: PROBE_NAME };
      }),
    );
    expect(objectInKnownField.errors).toEqual([
      "$.data[0].title: a feed-row field must be a scalar (S-O06 rows are flat)",
    ]);
    const extraPageAndPagination = validateEdited(
      "data-v2-trades-v1-page1.jsonc",
      editJson((body) => {
        body["users"] = [{ handle: "x" }];
        pagination(body)["last_trader"] = "synthetic-x";
      }),
    );
    expect(extraPageAndPagination.errors).toEqual([
      "$.users[0].handle: a user name or handle must be empty or a labelled synthetic value (synthetic-…)",
      "$.users: not a field of a trade or activity page (S-O06: data, pagination)",
      "$.pagination.last_trader: not a Pagination field (S-O06: limit, offset, has_more, next_cursor)",
    ]);
  });

  it("MUTANT: a live address in ANY capture value is refused; a documented contract address is not", () => {
    const live = validateEdited(
      "gamma-market-v1-btc15m.jsonc",
      (text) => text.replace('"marketMakerAddress":""', `"marketMakerAddress":"${PROBE_WALLET}"`),
      asRedacted,
    );
    expect(live.errors).toEqual([
      "$.marketMakerAddress: a 0x 40-hex address that is neither a labelled synthetic value (0x00…) nor a documented public contract address; it may be a wallet",
    ]);
    const router = "0x12121212006e4CD160D18e3f00711DA5c3372600";
    expect(PUBLIC_CONTRACT_ADDRESSES).toContain(router);
    const documented = validateEdited(
      "gamma-market-v1-btc15m.jsonc",
      (text) => text.replace('"marketMakerAddress":""', `"marketMakerAddress":"${router}"`),
      asRedacted,
    );
    expect(documented.errors).toEqual([]);
    const withoutAllowList = validateEdited(
      "gamma-market-v1-btc15m.jsonc",
      (text) => text.replace('"marketMakerAddress":""', `"marketMakerAddress":"${router}"`),
      asRedacted,
      { ...CONTEXT, publicAddresses: [] },
    );
    expect(withoutAllowList.errors).toEqual(live.errors);
  });

  it("MUTANT: an address or a JSON-escaped email inside a WebSocket frame is refused, once", () => {
    // The frame text spells the email's `@` as the JSON escape @, so only
    // the parsed frame shows it: the scan reads the frame, not just the text.
    const frameText = `{"event_type":"probe","maker":"${PROBE_WALLET}","contact":"reviewer-probe\\u0040example.invalid"}`;
    expect(frameText).not.toContain("@");
    const session = validateEdited("ws-market-v2-session.jsonl", appendRecord(frameText));
    expect(session.errors).toEqual([
      "$[16].frame.maker: a 0x 40-hex address that is neither a labelled synthetic value (0x00…) nor a documented public contract address; it may be a wallet",
      "$[16].frame.contact: an email address may not be committed (personal data)",
    ]);
  });

  it("MUTANT: any wallet-named or email-named key in a NON-feed capture is refused, and makes its object a person's row", () => {
    const result = validateEdited(
      "data-v2-resolutions-v2-active.jsonc",
      editJson((body) => {
        firstRow(body)["maker_wallet"] = PROBE_WALLET;
        firstRow(body)["contactEmail"] = "someone";
      }),
      asRedacted,
    );
    // A wallet key makes the resolution row a person's row, so its (empty)
    // transaction hash must now be a labelled synthetic one.
    expect(result.errors).toEqual([
      "$.data[0].transaction_hash: a hash must be a labelled synthetic hash (0x00…)",
      "$.data[0].maker_wallet: a wallet must be a labelled synthetic address (0x00…), not a live value",
      "$.data[0].contactEmail: an email field must be empty or a labelled synthetic value (synthetic-…)",
    ]);
  });

  it("MUTANT: a personal URL parameter, a percent-encoded one, and a full-width email are refused", () => {
    const named = validateEdited("gamma-events-keyset-series10192.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}&name=Reviewer%20Probe`;
    });
    expect(named.errors).toEqual([
      "sidecar.url: name is written with a value that is not a labelled synthetic value, a <placeholder> or empty",
    ]);
    const encoded = validateEdited("gamma-events-keyset-series10192.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}&pseudo%6Eym=Real-Handle`;
    });
    expect(encoded.errors).toEqual([
      "sidecar.url: pseudonym is written with a value that is not a labelled synthetic value, a <placeholder> or empty",
    ]);
    const synthetic = validateEdited("gamma-events-keyset-series10192.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}&name=synthetic-name-p1-r1`;
    });
    expect(synthetic.errors).toEqual([]);
    const fullWidth = validateEdited("book-v1.jsonc", undefined, (sidecar) => {
      sidecar["notes"] = `${sidecar["notes"] as string} Contact reviewer-probe\uFF20example.invalid.`;
    });
    expect(fullWidth.errors).toEqual([
      "sidecar.notes: an email address may not be committed (personal data)",
    ]);
  });

  it("MUTANT: a profile object at any depth of a NON-Data-API capture is a person's row (camelCase keys too)", () => {
    const result = validateEdited(
      "gamma-market-v1-btc15m.jsonc",
      editJson((body) => {
        body["creator"] = {
          proxyWallet: PROBE_WALLET,
          name: PROBE_NAME,
          profileImage: "https://example.invalid/avatar.png",
          xUsername: "reviewer_probe",
        };
      }),
      asRedacted,
    );
    expect(result.errors).toEqual([
      "$.creator.proxyWallet: a wallet must be a labelled synthetic address (0x00…), not a live value",
      "$.creator.name: a name must be a labelled synthetic value (synthetic-…)",
      "$.creator.profileImage: a profile field must be empty or a labelled synthetic value (synthetic-…)",
      "$.creator.xUsername: a user name or handle must be empty or a labelled synthetic value (synthetic-…)",
    ]);
    // Without a profile key, a Gamma `name` is market metadata and stays.
    const metadata = validateEdited(
      "gamma-market-v1-btc15m.jsonc",
      editJson((body) => {
        body["category"] = { name: "Crypto" };
      }),
      asRedacted,
    );
    expect(metadata.errors).toEqual([]);
  });

  it("MUTANT: a synthetic label cannot carry an email, a space, a capital or a base64url cursor", () => {
    expect(isLabelledSyntheticText("synthetic-name-p1-r1")).toBe(true);
    for (const value of [
      "synthetic-reviewer@example.invalid",
      "synthetic-Reviewer Probe",
      "synthetic-Reviewer",
      `synthetic-${SYNTHETIC_SEEK_ANCHOR_CURSOR}`,
    ]) {
      expect(isLabelledSyntheticText(value), value).toBe(false);
    }
    const result = validateEdited(
      "data-v2-trades-v1-page1.jsonc",
      editJson((body) => {
        firstRow(body)["pseudonym"] = "synthetic-reviewer@example.invalid";
      }),
    );
    expect(result.errors).toEqual([
      "$.data[0].pseudonym: a pseudonym must be a labelled synthetic value (synthetic-…)",
    ]);
  });
});

// --- round 1: every URL cursor (V2-9-R1-02) ------------------------------------------

describe("V2-9 r1: every cursor in a trade or activity sidecar URL (V2-9-R1-02)", () => {
  it("MUTANT (verifier probe): a second cursor parameter carrying a seek anchor is refused", () => {
    const result = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}&cursor=synthetic-cursor-test&cursor=${SYNTHETIC_SEEK_ANCHOR_CURSOR}`;
    });
    expect(result.errors).toEqual([
      "sidecar.url: 2 cursor parameters (cursor, cursor); a trade or activity URL carries at most one",
      "sidecar url cursor: the cursor decodes to a venue feed cursor (params l, ts, sq, d), which carries the seek anchor of the last row (S-O06) and re-fetches the unredacted page; replace it with a labelled synthetic value",
      `sidecar url cursor: a trade or activity cursor must be a labelled synthetic value (synthetic-cursor-…), got ${JSON.stringify(SYNTHETIC_SEEK_ANCHOR_CURSOR.slice(0, 24))}…`,
    ]);
  });

  it("MUTANT: a repeated cursor is refused even when both values are labelled synthetic", () => {
    const result = validateEdited("data-v2-trades-v1-page2.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}&cursor=synthetic-cursor-trades-p1-next`;
    });
    expect(result.errors).toEqual([
      "sidecar.url: 2 cursor parameters (cursor, cursor); a trade or activity URL carries at most one",
    ]);
  });

  it("MUTANT: a cursor under another or a percent-encoded name, in the path or fragment, or in sidecar prose, is refused", () => {
    const otherName = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}&type=${SYNTHETIC_SEEK_ANCHOR_CURSOR}`;
    });
    expect(otherName.errors).toEqual([
      "sidecar url type: the value decodes to a JSON object, as a venue cursor does; a trade or activity URL carries a cursor only as a labelled synthetic cursor parameter",
    ]);
    const undocumented = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}&after=${SYNTHETIC_SEEK_ANCHOR_CURSOR}&tx=${PROBE_HASH}`;
    });
    expect(undocumented.errors).toEqual([
      "sidecar url after: not a query parameter S-O06 documents for /v2/trades or /v2/activity",
      "sidecar url after: the value decodes to a JSON object, as a venue cursor does; a trade or activity URL carries a cursor only as a labelled synthetic cursor parameter",
      "sidecar url tx: not a query parameter S-O06 documents for /v2/trades or /v2/activity",
    ]);
    const encodedName = validateEdited("data-v2-trades-v1-page2.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}&%43ursor=${SYNTHETIC_SEEK_ANCHOR_CURSOR}`;
    });
    expect(hasError(encodedName, "sidecar.url: 2 cursor parameters (cursor, Cursor)")).toBe(true);
    expect(hasError(encodedName, "sidecar url Cursor: the cursor decodes to a venue feed cursor")).toBe(true);
    const fragment = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}#${SYNTHETIC_SEEK_ANCHOR_CURSOR}`;
    });
    expect(fragment.errors).toEqual([
      // Round 2: a trade or activity URL carries no fragment at all.
      "sidecar.url: a trade or activity URL is exactly https://data-api.polymarket.com, one of /v2/trades, /v2/activity or /v2/activity/combos, and a query, in canonical form: no other path segment, no fragment, no credential, no port",
      "sidecar.url: a path segment or fragment decodes to a venue cursor (S-O06); a trade or activity URL carries a cursor only as a labelled synthetic cursor parameter",
    ]);
    const prose = validateEdited("data-v2-trades-v1-page2.jsonc", undefined, (sidecar) => {
      sidecar["notes"] = `${sidecar["notes"] as string} The real cursor was ${SYNTHETIC_SEEK_ANCHOR_CURSOR}.`;
    });
    expect(prose.errors).toEqual([
      "sidecar.notes: a token decodes to a venue cursor, which carries the seek anchor of the last row (S-O06); name a cursor by its labelled synthetic value",
    ]);
    const row = validateEdited(
      "data-v2-trades-v1-page1.jsonc",
      editJson((body) => {
        firstRow(body)["slug"] = SYNTHETIC_SEEK_ANCHOR_CURSOR;
      }),
    );
    expect(row.errors).toEqual(["$.data[0].slug: a token decodes to a venue cursor (S-O06)"]);
  });

  it("MUTANT: a repeated key that hides a seek anchor or a live wallet from JSON.parse is refused, in a capture, a frame or a sidecar", () => {
    expect(duplicateKeys('{"a":"x\\"}","a":1}')).toEqual(["a"]);
    expect(duplicateKeys('{"a":{"a":1},"b":[{"a":2},{"a":3}]}')).toEqual([]);
    const cursor = validateEdited("data-v2-trades-v1-page1.jsonc", (text) =>
      text.replace(
        '"next_cursor":"synthetic-cursor-trades-p1-next"',
        `"next_cursor":"${SYNTHETIC_SEEK_ANCHOR_CURSOR}","next_cursor":"synthetic-cursor-trades-p1-next"`,
      ),
    );
    expect(cursor.errors).toEqual([
      'the capture: the key "next_cursor" occurs twice in one object; JSON.parse keeps only the last value, so an earlier one would escape every check',
    ]);
    const wallet = validateEdited("data-v2-trades-v1-page2.jsonc", (text) =>
      text.replace(
        '"proxy_wallet":"0x0000000000000000000000000000000000000201"',
        `"proxy_wallet":"${PROBE_WALLET}","proxy_wallet":"0x0000000000000000000000000000000000000201"`,
      ),
    );
    expect(wallet.errors).toEqual([
      'the capture: the key "proxy_wallet" occurs twice in one object; JSON.parse keeps only the last value, so an earlier one would escape every check',
    ]);
    const frame = validateEdited(
      "ws-market-v2-session.jsonl",
      appendRecord(`{"event_type":"probe","maker":"${PROBE_WALLET}","maker":"synthetic-x"}`),
      asRedacted,
    );
    expect(frame.errors).toEqual([
      'line 17 frame: the key "maker" occurs twice in one object; JSON.parse keeps only the last value, so an earlier one would escape every check',
    ]);
    const spec = captureSpec("data-v2-trades-v1-page1.jsonc");
    const sidecarText = fixtureText(sidecarPathOf(spec.fixture)).replace(
      '"notes": ',
      `"notes": "Original name: ${PROBE_NAME}",\n  "notes": `,
    );
    const sidecar = validateCapture(
      spec,
      Buffer.from(fixtureText(spec.fixture), "utf8"),
      sidecarText,
      CONTEXT,
    );
    expect(sidecar.errors).toEqual([
      'protocol-v2/data-v2-trades-v1-page1.provenance.jsonc: the key "notes" occurs twice in one object; JSON.parse keeps only the last value, so an earlier one would escape every check',
    ]);
  });

  it("a non-feed capture keeps its public time-series cursor (prices-history page 2)", () => {
    const sidecar = sidecarOf(captureSpec("data-v2-prices-history-page2.jsonc"));
    expect(decodeFeedCursor(new URL(sidecar["url"] as string).searchParams.get("cursor") ?? "")).toBeDefined();
    expect(validateEdited("data-v2-prices-history-page2.jsonc").errors).toEqual([]);
  });
});

// --- round 2: cursors in any written form, typed URL values (V2-9-R2-01, -02) -------

/** The trade sidecars' notes refusal (rule 6, prose). */
const NOTES_CURSOR_ERROR =
  "sidecar.notes: a token decodes to a venue cursor, which carries the seek anchor of the last row (S-O06); name a cursor by its labelled synthetic value";

/** The feed URL shape refusal (round 2). */
const FEED_URL_SHAPE_ERROR =
  "sidecar.url: a trade or activity URL is exactly https://data-api.polymarket.com, one of /v2/trades, /v2/activity or /v2/activity/combos, and a query, in canonical form: no other path segment, no fragment, no credential, no port";

/** The synthetic seek anchor's JSON text, and other encodings of it. */
const SEEK_ANCHOR_JSON = Buffer.from(SYNTHETIC_SEEK_ANCHOR_CURSOR, "base64url").toString("utf8");
const SEEK_ANCHOR_BASE64 = Buffer.from(SEEK_ANCHOR_JSON, "utf8").toString("base64");
const SEEK_ANCHOR_HEX = Buffer.from(SEEK_ANCHOR_JSON, "utf8").toString("hex");
const SEEK_ANCHOR_FULL_WIDTH = [...SYNTHETIC_SEEK_ANCHOR_CURSOR]
  .map((char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0))
  .join("");

/** The type refusal of one feed URL parameter (round 2). */
function typeError(key: string): string {
  return `sidecar url ${key}: the value is not`;
}

/** The V2 canary condition, which the report's source index reads as a market (S-L01, S-L04). */
const CANARY_CONDITION = "0x017791f201d5a788e0039e511fc1900e5f000000000000000000000000000000";

describe("V2-9 r2: a cursor in any written form in a trade or activity sidecar (V2-9-R2-01)", () => {
  it("MUTANT (verifier probe): an assignment-form cursor in the notes is refused", () => {
    const result = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["notes"] = `${sidecar["notes"] as string} Original cursor=${SYNTHETIC_SEEK_ANCHOR_CURSOR}`;
    });
    expect(result.errors).toEqual([NOTES_CURSOR_ERROR]);
  });

  it("MUTANT (verifier probe): an assignment-form cursor in the URL fragment is refused", () => {
    const result = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}#cursor=${SYNTHETIC_SEEK_ANCHOR_CURSOR}`;
    });
    expect(result.errors).toEqual([
      FEED_URL_SHAPE_ERROR,
      "sidecar.url: a path segment or fragment decodes to a venue cursor (S-O06); a trade or activity URL carries a cursor only as a labelled synthetic cursor parameter",
    ]);
  });

  it("MUTANT (verifier probe): a cursor written as plain JSON in the notes is refused", () => {
    const result = validateEdited("data-v2-trades-v1-page2.jsonc", undefined, (sidecar) => {
      sidecar["notes"] = `${sidecar["notes"] as string} The real cursor decoded: ${SEEK_ANCHOR_JSON}.`;
    });
    expect(result.errors).toEqual([NOTES_CURSOR_ERROR]);
  });

  it("MUTANT: a cursor percent-encoded, glued to a word, in standard base64, hex or full width, or after a colon, is refused", () => {
    for (const written of [
      `cursor%3D${SYNTHETIC_SEEK_ANCHOR_CURSOR}`,
      `cursor%3d${SYNTHETIC_SEEK_ANCHOR_CURSOR}&limit=2`,
      `cursor${SYNTHETIC_SEEK_ANCHOR_CURSOR}`,
      `x${SYNTHETIC_SEEK_ANCHOR_CURSOR}`,
      `xyz${SYNTHETIC_SEEK_ANCHOR_CURSOR}`,
      `${SYNTHETIC_SEEK_ANCHOR_CURSOR}trailing`,
      `next_cursor:${SYNTHETIC_SEEK_ANCHOR_CURSOR}`,
      `"next_cursor":"${SYNTHETIC_SEEK_ANCHOR_CURSOR}"`,
      `cursor=${SEEK_ANCHOR_BASE64}`,
      `cursor=${SEEK_ANCHOR_HEX}`,
      `cursor＝${SEEK_ANCHOR_FULL_WIDTH}`,
      `cursor=${encodeURIComponent(SEEK_ANCHOR_JSON)}`,
    ]) {
      const result = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
        sidecar["notes"] = `${sidecar["notes"] as string} Original ${written}.`;
      });
      expect(result.errors, written).toContain(NOTES_CURSOR_ERROR);
    }
  });

  it("MUTANT: an assignment-form cursor in a redaction, in a row value, or as a query value, is refused", () => {
    const redaction = validateEdited("data-v2-trades-v1-page2.jsonc", undefined, (sidecar) => {
      (sidecar["redactions"] as string[]).push(`url: the original was ?cursor=${SYNTHETIC_SEEK_ANCHOR_CURSOR}`);
    });
    expect(redaction.errors).toEqual([
      "sidecar.redactions[9]: a token decodes to a venue cursor, which carries the seek anchor of the last row (S-O06); name a cursor by its labelled synthetic value",
    ]);
    const row = validateEdited(
      "data-v2-trades-v1-page1.jsonc",
      editJson((body) => {
        firstRow(body)["title"] = `Bitcoin Up or Down cursor=${SYNTHETIC_SEEK_ANCHOR_CURSOR}`;
      }),
    );
    expect(row.errors).toEqual(["$.data[0].title: a token decodes to a venue cursor (S-O06)"]);
    const queryValue = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}&type=x${SYNTHETIC_SEEK_ANCHOR_CURSOR}`;
    });
    expect(queryValue.errors).toEqual([
      "sidecar url type: the value decodes to a JSON object, as a venue cursor does; a trade or activity URL carries a cursor only as a labelled synthetic cursor parameter",
    ]);
  });

  it("labelled synthetic cursors, public ids and prose are not taken for cursors", () => {
    expect(cursorLikeTokens(`cursor=synthetic-cursor-trades-p1-next`)).toEqual([]);
    expect(cursorLikeTokens(`next_cursor:synthetic-cursor-trades-p1-next; {data, pagination}; {}`)).toEqual([]);
    expect(cursorLikeTokens(CANARY_CONDITION)).toEqual([]);
    expect(
      cursorLikeTokens("25070934348813416902477876984955073880416401960631253331845590271167412497744"),
    ).toEqual([]);
    // The committed trade sidecars' text (the feed captures; a non-feed
    // sidecar may quote a JSON body, a 404 for example, in its notes).
    for (const name of ["data-v2-trades-v1-page1.jsonc", "data-v2-trades-v1-page2.jsonc", "data-v2-trades-v2-empty.jsonc"]) {
      const sidecar = sidecarOf(captureSpec(name));
      for (const text of [sidecar["url"], sidecar["notes"], ...(sidecar["redactions"] as string[])]) {
        expect(cursorLikeTokens(text as string), `${name}: ${String(text).slice(0, 60)}`).toEqual([]);
      }
    }
  });
});

describe("V2-9 r2: every value on a trade or activity URL has its documented type (V2-9-R2-02)", () => {
  it("MUTANT (verifier probe): a 64-hex value under start is refused", () => {
    const result = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}&start=0x${"a".repeat(64)}`;
    });
    expect(result.errors).toEqual([
      "sidecar url start: the value is not a documented sentinel, 0 or 1 (a committed bound is ignored on every URL this gate admits) (S-O06); a value of another shape, a hash for example, may not ride on a trade or activity URL",
    ]);
  });

  it("MUTANT: a hash under any other documented parameter is refused", () => {
    for (const key of [
      "end",
      "event_id",
      "exclude_deposits_withdrawals",
      "filter_amount",
      "filter_type",
      "limit",
      "side",
      "sort_by",
      "sort_direction",
      "taker_only",
      "type",
      "condition",
      "condition_id",
      "conditionId",
    ]) {
      for (const value of [PROBE_HASH, PROBE_HASH.slice(2), `0X${PROBE_HASH.slice(2).toUpperCase()}`]) {
        const result = validateEdited("data-v2-trades-v1-page2.jsonc", undefined, (sidecar) => {
          sidecar["url"] = `${sidecar["url"] as string}&${key}=${value}`;
        });
        expect(hasError(result, typeError(key)), `${key}=${value}`).toBe(true);
      }
    }
  });

  it("MUTANT: a real-looking block timestamp under start or end is refused; the documented sentinels are not", () => {
    for (const bound of ["start=1700000001", "end=1791241200", "start=2", "end=01"]) {
      const result = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
        sidecar["url"] = `${sidecar["url"] as string}&${bound}`;
      });
      expect(hasError(result, typeError(bound.split("=")[0] as string)), bound).toBe(true);
    }
    const sentinels = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}&start=1&end=0`;
    });
    expect(sentinels.errors).toEqual([]);
  });

  it("MUTANT: a condition that no market read and no row carries is refused; a known or labelled synthetic one is not", () => {
    const unknown = validateEdited("data-v2-trades-v2-empty.jsonc", undefined, (sidecar) => {
      sidecar["url"] = (sidecar["url"] as string).replace(CANARY_CONDITION, PROBE_HASH);
    });
    expect(unknown.errors.filter((error) => error.startsWith("sidecar url"))).toEqual([
      "sidecar url condition: the value is not condition ids (0x and 62 or 64 lowercase hex digits, at most 20, comma-separated), each one the report's source index read as a market, one a row carries as condition_id, or a labelled synthetic value (S-O06); a value of another shape, a hash for example, may not ride on a trade or activity URL",
    ]);
    const listed = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["url"] = (sidecar["url"] as string).replace("&limit=2", `,${PROBE_HASH}&limit=2`);
    });
    expect(hasError(listed, typeError("condition"))).toBe(true);
    // The empty page's condition is read as a market by S-L01 and S-L04; with
    // no market read in the context it is refused (the page has no row).
    const noMarketRead = validateEdited("data-v2-trades-v2-empty.jsonc", undefined, undefined, {
      ...CONTEXT,
      marketConditionIds: [],
    });
    expect(hasError(noMarketRead, typeError("condition"))).toBe(true);
    // A page-1 condition its rows carry passes with no market read.
    expect(
      validateEdited("data-v2-trades-v1-page1.jsonc", undefined, undefined, { ...CONTEXT, marketConditionIds: [] })
        .errors,
    ).toEqual([]);
    const known = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
      sidecar["url"] = (sidecar["url"] as string).replace("&limit=2", `,${CANARY_CONDITION},0x${"0".repeat(61)}abc&limit=2`);
    });
    expect(known.errors).toEqual([]);
    expect(marketReadConditionIds(V2_SOURCE_INDEX)).toContain(CANARY_CONDITION);
    expect(
      marketReadConditionIds(
        [
          `| S-X01 | \`https://data-api.polymarket.com/v2/trades?condition=${PROBE_HASH}\` | 00:00:01Z | 200 | 1 | \`${"a".repeat(64)}\` |  |`,
          `| S-X02 | \`https://clob.polymarket.com/clob-markets/${CANARY_CONDITION}\` | 00:00:02Z | 200 | 1 | \`${"b".repeat(64)}\` |  |`,
        ].join("\n"),
      ),
    ).toEqual([CANARY_CONDITION]);
  });

  it("every documented parameter accepts a value of its documented type", () => {
    const result = validateEdited("data-v2-trades-v1-page2.jsonc", undefined, (sidecar) => {
      sidecar["url"] = `${sidecar["url"] as string}&limit=1000&taker_only=false&filter_type=CASH&filter_amount=0.01&side=BUY&event_id=16085,16086&sort_by=TIMESTAMP&sort_direction=ASC&type=TRADE,REDEEM,TIP&exclude_deposits_withdrawals=true`;
    });
    expect(result.errors).toEqual([]);
    for (const bad of ["limit=1001", "side=buy", "filter_amount=1e9", "event_id=0", "type=TRADE,", `type=${[..."ABCDEFGHIJKLMNOPQRSTU"].map((letter) => `TYPE_${letter}`).join(",")}`]) {
      const refused = validateEdited("data-v2-trades-v1-page2.jsonc", undefined, (sidecar) => {
        sidecar["url"] = `${sidecar["url"] as string}&${bad}`;
      });
      expect(hasError(refused, typeError(bad.split("=")[0] as string)), bad).toBe(true);
    }
  });

  it("MUTANT: a hash in an extra path segment or the fragment, and a non-canonical URL, are refused", () => {
    for (const edit of [
      (url: string) => url.replace("/v2/trades?", `/v2/trades/${PROBE_HASH}?`),
      (url: string) => `${url}#${PROBE_HASH}`,
      (url: string) => `${url}#`,
      (url: string) => url.replace("/v2/trades?", `/v2/${PROBE_HASH}/../trades?`),
      (url: string) => url.replace("/v2/trades?", "/v2/./trades?"),
    ]) {
      const result = validateEdited("data-v2-trades-v1-page1.jsonc", undefined, (sidecar) => {
        sidecar["url"] = edit(sidecar["url"] as string);
      });
      expect(result.errors, edit("U")).toContain(FEED_URL_SHAPE_ERROR);
    }
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

  it("round 1: the exception states the enforced personal-data policy, sidecars included, and what the gate cannot check (V2-9-R1-01)", () => {
    const readme = fixtureText("README.md");
    for (const statement of [
      "**Sidecar text** (`url`, `notes`, each redaction, `extract.rule`)",
      "**A person's row**",
      "every cursor parameter of the sidecar URL",
      "at most one cursor parameter, and only the query parameters S-O06 documents",
      "**What the gate cannot check.**",
    ]) {
      expect(readme, statement).toContain(statement);
    }
    expect(readme).not.toContain("The trade size and\n  block timestamp are replaced too.");
  });

  it("round 2: the exception states the cursor forms, the typed trade URL and the new limits (V2-9-R2-01, -02)", () => {
    const readme = fixtureText("README.md");
    for (const statement of [
      "as the value of an assignment (`cursor=…`, `#cursor=…`, `cursor%3D…`)",
      "**Trade and activity URLs** (round 2)",
      "`FEED_PARAMETER_TYPES`",
      "`start` and `end`\n  are only the documented sentinels `0` and `1`",
      "a venue cursor split across tokens or otherwise transformed",
    ]) {
      expect(readme, statement).toContain(statement);
    }
    expect(fixtureText("protocol-v2/README.md")).toContain("round 2 added a\n    cursor in any written form");
  });
});
