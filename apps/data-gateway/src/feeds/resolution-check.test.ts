/**
 * `V2-3`: the resolution check's judgement, journal and memory (ADR-030
 * Amendment 2, rules 4 and 5, the orchestrator's interim ruling for PAPER and
 * BACKTEST), on the public captures of `VENUE-4`
 * (`test/fixtures/venue/protocol-v2/data-v2-resolutions-*.jsonc`) and fakes.
 * The gateway suite (`test/integration/data-gateway/v2-resolution.test.ts`)
 * drives the same rules through the real `DataGateway`.
 *
 * - **What a read finds:** every kind — Publishable, Pending, Failed, Refused
 *   — and every refusal reason rule 5 lists, by name.
 * - **The payouts:** compared by value as fixed integer vectors; index 0 is
 *   YES; the SDK's collateral-unit `["1","0"]` is refused, never read a
 *   millionfold low.
 * - **Journal before derive, and replay:** a response is journaled before it
 *   is judged; one the WAL refuses derives nothing; the journaled record alone
 *   re-derives the same finding.
 * - **The marker** of a refused row, and the budget door.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PublicHttpResponse } from "@polymarket-bot/polymarket-public";
import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { reviewedBtc15mSeriesDocument } from "@polymarket-bot/universe/testing";
import { describe, expect, it, vi } from "vitest";

import type { AdmissionLedgerRecord } from "../admission-ledger.js";
import { AdmissionLedger } from "../admission-ledger.js";
import { parseGatewayConfig } from "../config.js";
import { GatewayConfigurationError } from "../errors.js";
import type { GatewayReceipt } from "../ports.js";
import { ManualGatewayClock, ManualGatewayTimers } from "../testing/index.js";

import {
  isWellFormedInstant,
  judgeResolutionAnswer,
  PENDING_RESOLUTION_STATUSES,
  readResolutionOnce,
  replayJournaledResolutionAnswer,
  RESOLUTION_READ_TIMEOUT_MS,
  resolutionReadEndpoint,
  ResolutionRowPaths,
  rowRefusalMarker,
  rowRefusalMarkerKey,
  rowRefusalMarkerOf,
  type ResolutionFinding,
} from "./resolution-check.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const capture = (name: string): string => readFileSync(resolve(repoRoot, "test/fixtures/venue/protocol-v2", `${name}.jsonc`), "utf8");

/** S-A11's resolved V2 canary, and S-L04's open one (each `condition_id` is the 32-byte form, F-44). */
const RESOLVED_V2 = "0x015ecdbafe90dfcb60b2f38afe44f4be85000000000000000000000000000000";
const ACTIVE_V2 = "0x017791f201d5a788e0039e511fc1900e5f000000000000000000000000000000";
const RESOLVED_V1 = "0x156b8d520e362e159d70d7428f08371ecc9dc91d3437a903d97ae97908f73bec";

const ok = (body: string): { kind: "RESPONSE"; status: number; bodyUtf8: string } => ({ kind: "RESPONSE", status: 200, bodyUtf8: body });

/** One synthetic row for `RESOLVED_V2`, the S-A11 row with `overrides` (a value of `undefined` deletes the key). */
function rowBody(overrides: Record<string, unknown> = {}, rows = 1): string {
  const base: Record<string, unknown> = {
    condition_id: RESOLVED_V2,
    status: "resolved",
    payouts: [1_000_000, 0],
    resolved_at: "2026-10-05T21:35:56Z",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return JSON.stringify({ data: Array.from({ length: rows }, () => base) });
}

/** A row body with a RAW payouts lexeme (so `1e6` and `["1","0"]` reach the door exactly as spelled). */
function rawPayoutsBody(payouts: string): string {
  return `{"data":[{"condition_id":"${RESOLVED_V2}","status":"resolved","payouts":${payouts},"resolved_at":"2026-10-05T21:35:56Z"}]}`;
}

function refusedWith(finding: ResolutionFinding, pattern: RegExp): void {
  expect(finding.kind).toBe("REFUSED");
  expect(finding.detail).toMatch(pattern);
}

describe("V2-3: Publishable — rule 5's conditions, on the captures", () => {
  it("S-A11: the resolved V2 canary — its only row, its condition, resolved, [1000000,0]: YES_WIN, resolvedAt = resolved_at unchanged", () => {
    expect(judgeResolutionAnswer(ok(capture("data-v2-resolutions-v2-resolved")), RESOLVED_V2)).toEqual({
      kind: "PUBLISHABLE",
      outcome: "YES_WIN",
      resolvedAt: "2026-10-05T21:35:56Z",
      detail: "a resolved row with payouts [1000000,0] (YES_WIN), resolved_at 2026-10-05T21:35:56Z",
    });
  });

  it("S-A10: a resolved V1 window — [0,1000000] is NO_WIN (index 0 is YES, F-40); rule 5 applies to V1 windows too", () => {
    expect(judgeResolutionAnswer(ok(capture("data-v2-resolutions-v1-resolved")), RESOLVED_V1)).toMatchObject({
      kind: "PUBLISHABLE",
      outcome: "NO_WIN",
      resolvedAt: "2026-10-05T23:00:53Z",
    });
  });

  it("compared BY VALUE as fixed integer vectors: 1e6 and 1000000.0 are 1000000 (ADR-009 §8 item 3)", () => {
    expect(judgeResolutionAnswer(ok(rawPayoutsBody("[1e6,0]")), RESOLVED_V2)).toMatchObject({ kind: "PUBLISHABLE", outcome: "YES_WIN" });
    expect(judgeResolutionAnswer(ok(rawPayoutsBody("[0,1000000.0]")), RESOLVED_V2)).toMatchObject({ kind: "PUBLISHABLE", outcome: "NO_WIN" });
  });

  it("the condition is compared as bytes: the row's hex case does not matter; the 0x prefix and width do", () => {
    expect(judgeResolutionAnswer(ok(rowBody({ condition_id: RESOLVED_V2.toUpperCase().replace("0X", "0x") })), RESOLVED_V2).kind).toBe("PUBLISHABLE");
  });

  it("any 2xx status is a response to judge", () => {
    expect(judgeResolutionAnswer({ kind: "RESPONSE", status: 203, bodyUtf8: rowBody() }, RESOLVED_V2).kind).toBe("PUBLISHABLE");
  });
});

describe("V2-3: Pending — a documented miss, or a non-terminal status (rule 5 kind 2)", () => {
  it('{"data": []} (F-57) and {"data": null} (F-65; V2-0 R2-OPUS-L3) are Pending, never refused', () => {
    expect(judgeResolutionAnswer(ok('{"data":[]}'), RESOLVED_V2)).toEqual({ kind: "PENDING", detail: 'a documented miss, {"data": []} (F-57)' });
    expect(judgeResolutionAnswer(ok('{"data":null}'), RESOLVED_V2)).toEqual({ kind: "PENDING", detail: 'a documented miss, {"data": null} (F-65)' });
    expect(judgeResolutionAnswer(ok('{"data":null,"pagination":{}}'), RESOLVED_V2).kind).toBe("PENDING");
  });

  it("S-L04: the open V2 canary's row, status active with no payouts, is Pending", () => {
    expect(judgeResolutionAnswer(ok(capture("data-v2-resolutions-v2-active")), ACTIVE_V2)).toMatchObject({ kind: "PENDING", detail: expect.stringMatching(/"active"/u) as unknown });
  });

  it("every other F-57 status is Pending — with or without payouts; a disputed row publishes nothing (ADR-009 §4)", () => {
    expect(PENDING_RESOLUTION_STATUSES).toEqual(["initialized", "posed", "proposed", "challenged", "reproposed", "disputed", "active", "arbitration"]);
    for (const status of PENDING_RESOLUTION_STATUSES) {
      expect(judgeResolutionAnswer(ok(rowBody({ status })), RESOLVED_V2).kind).toBe("PENDING");
      expect(judgeResolutionAnswer(ok(rowBody({ status, payouts: undefined, resolved_at: undefined })), RESOLVED_V2).kind).toBe("PENDING");
    }
    expect(judgeResolutionAnswer(ok(rowBody({ status: "disputed" })), RESOLVED_V2).detail).toMatch(/a disputed row publishes no resolution, ADR-009 §4/u);
  });
});

describe("V2-3: Failed — no answer, an error status, or a body that is not JSON (rule 5 kind 3)", () => {
  it("no answer: a timeout or a transport failure", () => {
    expect(judgeResolutionAnswer({ kind: "NO_ANSWER", detail: "no answer within the read's 5000 ms timeout" }, RESOLVED_V2)).toEqual({
      kind: "FAILED",
      detail: "no answer within the read's 5000 ms timeout",
    });
  });

  it("an HTTP status outside 2xx is Failed WHATEVER its body — even a publishable one", () => {
    for (const status of [199, 301, 400, 404, 429, 500, 503]) {
      expect(judgeResolutionAnswer({ kind: "RESPONSE", status, bodyUtf8: rowBody() }, RESOLVED_V2)).toEqual({ kind: "FAILED", detail: `the read returned HTTP ${String(status)}` });
    }
    // S-L05: the 400 the 31-byte form gets (F-70).
    expect(judgeResolutionAnswer({ kind: "RESPONSE", status: 400, bodyUtf8: capture("data-v2-resolutions-62hex-invalid") }, RESOLVED_V2).kind).toBe("FAILED");
  });

  it("a 2xx body that is not JSON", () => {
    for (const body of ["", "<html>bad gateway</html>", "{\"data\":["]) {
      expect(judgeResolutionAnswer(ok(body), RESOLVED_V2).kind).toBe("FAILED");
    }
  });
});

describe("V2-3: Refused — anything else (rule 5 kind 4)", () => {
  it("more than one row", () => {
    refusedWith(judgeResolutionAnswer(ok(rowBody({}, 2)), RESOLVED_V2), /carries 2 rows; a row publishes only as the response's only row/u);
  });

  it("a row for another condition: another id, the 31-byte form, another width, no condition_id", () => {
    refusedWith(judgeResolutionAnswer(ok(rowBody()), ACTIVE_V2), /the row is for condition .*0x015ecd.*, not the window's 0x017791/u);
    refusedWith(judgeResolutionAnswer(ok(rowBody({ condition_id: RESOLVED_V2.slice(0, -2) })), RESOLVED_V2), /the row is for condition/u);
    refusedWith(judgeResolutionAnswer(ok(rowBody({ condition_id: `${RESOLVED_V2}00` })), RESOLVED_V2), /the row is for condition/u);
    refusedWith(judgeResolutionAnswer(ok(rowBody({ condition_id: undefined })), RESOLVED_V2), /condition_id is absent/u);
    refusedWith(judgeResolutionAnswer(ok(rowBody({ condition_id: null })), RESOLVED_V2), /condition_id is null/u);
  });

  it("a row that is not an object, and a status outside F-57's list (case and spelling included) or not a string", () => {
    refusedWith(judgeResolutionAnswer(ok('{"data":["resolved"]}'), RESOLVED_V2), /a Resolution row is a JSON object/u);
    for (const status of ["Resolved", "RESOLVED", "settled", "", " resolved"]) {
      refusedWith(judgeResolutionAnswer(ok(rowBody({ status })), RESOLVED_V2), /is outside F-57's list/u);
    }
    refusedWith(judgeResolutionAnswer(ok(rowBody({ status: undefined })), RESOLVED_V2), /status is absent/u);
    refusedWith(judgeResolutionAnswer(ok(rowBody({ status: 1 })), RESOLVED_V2), /status is not a string/u);
  });

  it("a collateral-unit tuple [\"1\",\"0\"] (F-78) is REFUSED — never read a millionfold low as YES_WIN", () => {
    const finding = judgeResolutionAnswer(ok(rawPayoutsBody('["1","0"]')), RESOLVED_V2);
    refusedWith(finding, /carries strings, not the wire's integer micro-USDC per share .* collateral-unit form \["1","0"\] \(F-78\) is refused, never read as a payout a millionfold low/u);
    expect(JSON.stringify(finding)).not.toContain("YES_WIN");
    refusedWith(judgeResolutionAnswer(ok(rawPayoutsBody('["0","1"]')), RESOLVED_V2), /carries strings/u);
    refusedWith(judgeResolutionAnswer(ok(rawPayoutsBody('["1000000","0"]')), RESOLVED_V2), /carries strings/u);
  });

  it("[1,0] and [0,1] — collateral units as numbers — are refused too: a vector is never scaled", () => {
    refusedWith(judgeResolutionAnswer(ok(rawPayoutsBody("[1,0]")), RESOLVED_V2), /payouts \[1,0\] is neither \[1000000,0\] \(YES_WIN\) nor \[0,1000000\] \(NO_WIN\)/u);
    refusedWith(judgeResolutionAnswer(ok(rawPayoutsBody("[0,1]")), RESOLVED_V2), /is neither/u);
  });

  it("FABLE-R1-02: a non-integer near a target is REFUSED — compared exactly, never rounded nor within a tolerance (ADR-009 §8, note of 2026-10-05)", () => {
    for (const payouts of ["[1000000.4,0]", "[999999.6,0.4]", "[0,1000000.000001]", "[1000000.0000000001,0]", "[0.4,999999.6]", "[1000000,0.4]", "[999999.5,0]", "[1000000.5,0]"]) {
      const finding = judgeResolutionAnswer(ok(rawPayoutsBody(payouts)), RESOLVED_V2);
      refusedWith(finding, /payouts .* is (neither|a split)/u);
      expect(finding).not.toHaveProperty("outcome");
    }
  });

  it("a split payout (F-73; plan D18), and every other vector", () => {
    refusedWith(judgeResolutionAnswer(ok(rawPayoutsBody("[500000,500000]")), RESOLVED_V2), /is a split payout \(F-73; plan D18\)/u);
    refusedWith(judgeResolutionAnswer(ok(rawPayoutsBody("[999999,1]")), RESOLVED_V2), /is a split payout/u);
    for (const payouts of ["[1000000,0,0]", "[1000000]", "[]", "[0,0]", "[1000000,1000000]", "[1000001,0]", "[1000000,-1]", "[2000000,0]", "[1000000,null]", "[0.5,0.5]"]) {
      refusedWith(judgeResolutionAnswer(ok(rawPayoutsBody(payouts)), RESOLVED_V2), /payouts .* is (neither|a split)/u);
    }
  });

  it("a resolved row whose payouts are missing, null or not a list", () => {
    refusedWith(judgeResolutionAnswer(ok(rowBody({ payouts: undefined })), RESOLVED_V2), /a "resolved" row's payouts are absent/u);
    refusedWith(judgeResolutionAnswer(ok(rowBody({ payouts: null })), RESOLVED_V2), /payouts are null/u);
    // FABLE-R1-05: a payouts that is neither a list nor null is named as not a LIST.
    refusedWith(judgeResolutionAnswer(ok(rowBody({ payouts: "[1000000,0]" })), RESOLVED_V2), /a "resolved" row's payouts are not a list \(a string\)/u);
    refusedWith(judgeResolutionAnswer(ok(rowBody({ payouts: { 0: 1_000_000, 1: 0 } })), RESOLVED_V2), /a "resolved" row's payouts are not a list \(an object\)/u);
    refusedWith(judgeResolutionAnswer(ok(rowBody({ payouts: 1_000_000 })), RESOLVED_V2), /a "resolved" row's payouts are not a list \(a number\)/u);
    expect(judgeResolutionAnswer(ok(rowBody({ payouts: {} })), RESOLVED_V2).detail).not.toMatch(/not a string/u);
  });

  it("a resolved row without a well-formed resolved_at — nothing stands in for it", () => {
    refusedWith(judgeResolutionAnswer(ok(rowBody({ resolved_at: undefined })), RESOLVED_V2), /resolved_at is absent, and MarketResolved\.resolvedAt has no substitute/u);
    refusedWith(judgeResolutionAnswer(ok(rowBody({ resolved_at: null })), RESOLVED_V2), /resolved_at is null/u);
    for (const text of ["", "2026-10-05", "2026-10-05T21:35:56", "2026-02-31T00:00:00Z", "2026-10-05T24:00:00Z", "yesterday", "1791236156"]) {
      refusedWith(judgeResolutionAnswer(ok(rowBody({ resolved_at: text })), RESOLVED_V2), /is not a well-formed instant/u);
    }
    refusedWith(judgeResolutionAnswer(ok(rowBody({ resolved_at: 1_791_236_156 })), RESOLVED_V2), /resolved_at is not a string/u);
  });

  it("names EVERY problem of a resolved row at once: a split AND no resolved_at", () => {
    const finding = judgeResolutionAnswer(ok(rowBody({ payouts: [500_000, 500_000], resolved_at: undefined })), RESOLVED_V2);
    refusedWith(finding, /split payout.*; its resolved_at is absent/u);
  });

  it("a JSON body without the documented data list (F-65): no data, data of another type, not an object", () => {
    for (const body of ["{}", '{"data":{}}', '{"data":"x"}', "[]", "null", '{"error":"x"}']) {
      refusedWith(judgeResolutionAnswer(ok(body), RESOLVED_V2), /data|JSON object/u);
    }
  });

  it("well-formed instants: the domain's ISO timestamp with an offset, on the calendar", () => {
    for (const text of ["2026-10-05T21:35:56Z", "2026-10-05T21:35:56.123Z", "2026-10-05T21:35:56+00:00"]) expect(isWellFormedInstant(text)).toBe(true);
    for (const text of ["2026-02-30T00:00:00Z", "2026-10-05 21:35:56Z", "2026-10-05T21:35:56"]) expect(isWellFormedInstant(text)).toBe(false);
  });
});

describe("V2-3: journal before derive, and replay without the venue (rule 4 items 2 and 3)", () => {
  const receipt: GatewayReceipt = { receivedAt: "2026-10-04T22:31:00.000Z", receivedMonotonicNs: "1", nowMs: Date.parse("2026-10-04T22:31:00Z") };

  async function readWith(response: PublicHttpResponse | Error, journalAccepts = true) {
    const order: string[] = [];
    const journaled: { endpoint: string; body: string }[] = [];
    const clock = new ManualGatewayClock(Date.parse("2026-10-04T22:31:00Z"));
    // V23-R1-CODEX-02: derivation is OBSERVED — the judgement's first step is
    // the door's parse of the response body; only a parse of THIS body counts.
    const parse = JSON.parse.bind(JSON);
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]): unknown => {
      if (!(response instanceof Error) && text === response.body) order.push("derive");
      return parse(text, reviver);
    });
    const read = await readResolutionOnce({
      http: async (request) => {
        order.push(`GET ${request.url}`);
        if (response instanceof Error) throw response;
        return response;
      },
      baseUrl: "http://data.stub",
      timers: new ManualGatewayTimers(clock),
      timeoutMs: RESOLUTION_READ_TIMEOUT_MS,
      paddedConditionId: RESOLVED_V2,
      journal: (endpoint, body) => {
        order.push("journal");
        journaled.push({ endpoint, body });
        return journalAccepts ? { receipt, rawFrameIngestSeq: "7", connectionId: "c-1" } : undefined;
      },
    }).finally(() => {
      spy.mockRestore();
    });
    return { read, order, journaled };
  }

  it("every response is journaled FIRST — a publishable row, a miss, an error, a refused row — with the URL and its status", async () => {
    for (const [status, body] of [
      [200, capture("data-v2-resolutions-v2-resolved")],
      [200, '{"data":[]}'],
      [400, capture("data-v2-resolutions-62hex-invalid")],
      [200, rawPayoutsBody('["1","0"]')],
      [200, "<html>"],
    ] as const) {
      const { read, order, journaled } = await readWith({ status, body });
      // V23-R1-CODEX-02: journaled, THEN derived (a 2xx body is parsed; an error status is Failed unparsed).
      expect(order).toEqual([`GET http://data.stub/v2/resolutions?condition=${RESOLVED_V2}`, "journal", ...(status === 200 ? ["derive"] : [])]);
      expect(journaled).toEqual([{ endpoint: `http://data.stub/v2/resolutions?condition=${RESOLVED_V2}#http-status=${String(status)}`, body }]);
      expect(read.frame).toEqual({ receipt, rawFrameIngestSeq: "7", connectionId: "c-1" });
    }
  });

  it("FABLE-R1-03: the RAW body is journaled byte for byte — whitespace, a trailing newline, the 1e6 spelling — never a re-serialization", async () => {
    const body = `{ "data" : [\n  { "condition_id": "${RESOLVED_V2}", "status": "resolved",\n    "payouts": [ 1e6, 0.0 ], "resolved_at": "2026-10-05T21:35:56Z", "extra": "\\u00e9" }\n] }\n`;
    const { read, order, journaled } = await readWith({ status: 200, body });
    expect(journaled).toHaveLength(1);
    expect(journaled[0]?.body).toBe(body);
    expect(Buffer.from(journaled[0]?.body ?? "", "utf8").equals(Buffer.from(body, "utf8"))).toBe(true);
    expect(order).toEqual([`GET http://data.stub/v2/resolutions?condition=${RESOLVED_V2}`, "journal", "derive"]);
    expect(read.finding).toMatchObject({ kind: "PUBLISHABLE", outcome: "YES_WIN", resolvedAt: "2026-10-05T21:35:56Z" });
  });

  it("a response the WAL refuses derives NOTHING — even a publishable row is only Failed, and its body is never parsed", async () => {
    const { read, order } = await readWith({ status: 200, body: capture("data-v2-resolutions-v2-resolved") }, false);
    expect(read).toEqual({ finding: { kind: "FAILED", detail: "the WAL refused the response, so nothing is derived from it" }, frame: undefined });
    // V23-R1-CODEX-02: no derivation at all, before or after the refused journal.
    expect(order).toEqual([`GET http://data.stub/v2/resolutions?condition=${RESOLVED_V2}`, "journal"]);
  });

  it("no answer journals nothing (nothing was received), and is Failed", async () => {
    const { read, journaled } = await readWith(new Error("ECONNREFUSED"));
    expect(journaled).toEqual([]);
    expect(read).toEqual({ finding: { kind: "FAILED", detail: "the request failed at the transport level: ECONNREFUSED" }, frame: undefined });
  });

  it("a read that cannot be built (a condition not in the 32-byte form) makes no request and is Failed", async () => {
    const order: string[] = [];
    const clock = new ManualGatewayClock(0);
    const read = await readResolutionOnce({
      http: async () => {
        order.push("GET");
        return { status: 200, body: "{}" };
      },
      baseUrl: undefined,
      timers: new ManualGatewayTimers(clock),
      timeoutMs: RESOLUTION_READ_TIMEOUT_MS,
      paddedConditionId: RESOLVED_V2.slice(0, -2),
      journal: () => undefined,
    });
    expect(order).toEqual([]);
    expect(read.finding.kind).toBe("FAILED");
  });

  it("REPLAY: the journaled record alone re-derives the live finding, for every kind — the venue is never asked", async () => {
    for (const [status, body] of [
      [200, capture("data-v2-resolutions-v2-resolved")],
      [200, rowBody({ payouts: [0, 1_000_000] })],
      [200, '{"data":null}'],
      [200, capture("data-v2-resolutions-v2-active")],
      [503, rowBody()],
      [200, "not json"],
      [200, rawPayoutsBody('["1","0"]')],
      [200, rowBody({}, 2)],
    ] as const) {
      const { read, journaled } = await readWith({ status, body });
      const record = journaled[0];
      if (record === undefined) throw new Error("not journaled");
      const replayed = replayJournaledResolutionAnswer({ endpoint: record.endpoint, payloadUtf8: record.body });
      expect(replayed).toEqual({ paddedConditionId: RESOLVED_V2, status, finding: read.finding });
      // Deterministic: a second replay of the same bytes derives the same.
      expect(replayJournaledResolutionAnswer({ endpoint: record.endpoint, payloadUtf8: record.body })).toEqual(replayed);
    }
  });

  it("replay recognizes only the records this check journaled", () => {
    const url = `http://data.stub/v2/resolutions?condition=${RESOLVED_V2}`;
    expect(resolutionReadEndpoint(url, 200)).toBe(`${url}#http-status=200`);
    for (const endpoint of [url, `${url}#http-status=`, `${url}#http-status=20`, `${url}#http-status=0200`, `http://clob.stub/clob-markets/${RESOLVED_V2}#http-status=200`, "wss://x#http-status=200"]) {
      expect(replayJournaledResolutionAnswer({ endpoint, payloadUtf8: "{}" })).toBeUndefined();
    }
  });
});

describe("V2-3 (R2-OPUS-L2): a refused row's marker, in the existing admission ledger", () => {
  const window: AdmissionLedgerRecord = {
    key: "0x017791f201d5a788e0039e511fc1900e5f0000000000000000000000000000",
    seriesId: "btc-15m-updown",
    seriesConfigHash: "a".repeat(64),
    status: "ADMITTED",
    judgedAt: "2026-10-04T22:20:00.000Z",
    closeAt: "2026-10-04T22:30:00.000Z",
    admissionConfirmedAt: "2026-10-04T22:20:00.000Z",
    window: {
      internalMarketId: "019bb5d0-0000-7000-8000-000000000001",
      conditionId: "0x017791f201d5a788e0039e511fc1900e5f0000000000000000000000000000",
      gammaEventId: "1",
      gammaMarketId: "2",
      yesTokenId: "3",
      noTokenId: "4",
      scheduledOpenAt: "2026-10-04T22:15:00.000Z",
      scheduledCloseAt: "2026-10-04T22:30:00.000Z",
      tickSize: "0.01",
      windowTitle: "Bitcoin Up or Down - October 4, 6:15PM-6:30PM ET",
      parameterVersionRef: "p",
      keysetRawIngestSeq: "1",
      clobRawIngestSeq: "2",
    },
  };

  it("is a REFUSED record in its own key namespace, closing with the window, which the ledger writes, reads back and prunes", async () => {
    const marker = rowRefusalMarker(window, "2026-10-04T22:31:00.000Z", "a split payout");
    expect(marker).toEqual({
      key: rowRefusalMarkerKey(window.key),
      seriesId: window.seriesId,
      seriesConfigHash: window.seriesConfigHash,
      status: "REFUSED",
      judgedAt: "2026-10-04T22:31:00.000Z",
      closeAt: "2026-10-04T22:30:00.000Z",
      mismatches: ["resolution row refused for admitted window 019bb5d0-0000-7000-8000-000000000001 (V2-3; ADR-030 Amendment 2 rule 5): a split payout"],
    });
    expect(marker.key).toBe(`resolution-row-refused:${window.key}`);
    const fileSystem = createMemoryFileSystem();
    const ledger = await AdmissionLedger.open({ fileSystem, walRootPath: "/wal" });
    await ledger.put(window);
    await ledger.put(marker);
    const reopened = await AdmissionLedger.open({ fileSystem, walRootPath: "/wal" });
    expect(reopened.get(marker.key)).toEqual(marker);
    expect(reopened.liveWindows().map((record) => record.key)).toEqual([window.key]);
    expect(rowRefusalMarkerOf(marker)).toEqual({ windowKey: window.key, reason: marker.mismatches?.[0] });
    // Pruned with the window's close, after the ledger's retention (2 days).
    const pruned = await reopened.prune(Date.parse("2026-10-06T22:30:01Z"));
    expect(pruned.map((record) => record.key)).toEqual([marker.key]);
  });

  it("only a REFUSED record in the namespace is a marker", () => {
    expect(rowRefusalMarkerOf(window)).toBeUndefined();
    expect(rowRefusalMarkerOf({ ...window, key: "event:1", status: "REFUSED", window: undefined, mismatches: ["x"] })).toBeUndefined();
    expect(rowRefusalMarkerOf({ ...rowRefusalMarker(window, "2026-10-04T22:31:00.000Z", "x"), key: "resolution-row-refused:" })).toBeUndefined();
  });

  it("the row paths remember the first reason, and forget a retired window", () => {
    const paths = new ResolutionRowPaths();
    paths.end("k", "first");
    paths.end("k", "second");
    expect(paths.endedWhy("k")).toBe("first");
    paths.note("k", { at: "t", kind: "PENDING", detail: "d", rawFrameIngestSeq: undefined });
    expect(paths.latest("k")).toMatchObject({ kind: "PENDING" });
    paths.forget("k");
    expect(paths.endedWhy("k")).toBeUndefined();
    expect(paths.latest("k")).toBeUndefined();
  });
});

describe("V2-3: the /v2/resolutions budget at the configuration door (§9.13)", () => {
  function config(pollIntervalMs: number, caps: readonly number[]): Record<string, unknown> {
    const series = caps.map((cap, index) => {
      const document = reviewDocument();
      return { ...document, seriesId: `s-${String(index)}`, venue: { gammaSeriesId: String(10_192 + index), seriesSlug: `slug-${String(index)}` }, maximumConcurrentWindows: cap };
    });
    return {
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [],
      polymarket: { customFeatureEnabled: true },
      lifecycle: { baseUrl: "http://gamma.stub", pollIntervalMs: 120_000 },
      seriesAdmission: { pollIntervalMs, maximumPages: 1, admissionLeadSeconds: 900, series },
    };
  }

  it("Σ maximumConcurrentWindows × 10 000 / pollIntervalMs must stay within 5 % of the Data API v2's 800 / 10 s: 40", () => {
    // 20 windows at the 5 s floor: exactly 40 per 10 s — admitted.
    expect(() => parseGatewayConfig(config(5_000, [10, 10]))).not.toThrow();
    // 21 windows at 5 s: 42 per 10 s — refused, naming the Data API's figure.
    expect(() => parseGatewayConfig(config(5_000, [11, 10]))).toThrow(GatewayConfigurationError);
    expect(() => parseGatewayConfig(config(5_000, [11, 10]))).toThrow(/Data API \/v2\/resolutions requests per 10 s .* over its budget of 40 .* 800 \/ 10 s/u);
    // At the default 30 s, 120 windows fit (the lifecycle budget is relaxed above to isolate this one).
    expect(() => parseGatewayConfig(config(30_000, [64, 56]))).not.toThrow();
    expect(() => parseGatewayConfig(config(30_000, [64, 57]))).toThrow(/Data API \/v2\/resolutions/u);
  });

  it("accepts a dataApiBaseUrl, and refuses an empty one", () => {
    const base = config(30_000, [2]);
    const block = base["seriesAdmission"] as Record<string, unknown>;
    expect(parseGatewayConfig({ ...base, seriesAdmission: { ...block, dataApiBaseUrl: "http://data.stub" } }).seriesAdmission?.dataApiBaseUrl).toBe("http://data.stub");
    expect(() => parseGatewayConfig({ ...base, seriesAdmission: { ...block, dataApiBaseUrl: "" } })).toThrow(GatewayConfigurationError);
  });
});

/** The sample review (`@polymarket-bot/universe/testing`). */
function reviewDocument(): Record<string, unknown> {
  return reviewedBtc15mSeriesDocument();
}
