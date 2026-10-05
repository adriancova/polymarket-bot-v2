/**
 * WP-330 r1, WP330-V1-01 = CX330-R1-01: every audit record is bounded BY
 * CONSTRUCTION below `MAX_AUDIT_LINE_BYTES`, so a large cancel-all keeps its
 * OUTCOME record. At fb9edcc the OUTCOME of a sweep of a few thousand orders
 * (every batch's ids, twice) exceeded the bound, the sink refused it, and the
 * command still exited COMPLETED with only INVOKED and ACTING in the log.
 *
 * 1. The realistic case, end to end through the REAL file sink: a sweep of
 *    3,000 orders whose ids are 66 characters (`0x` and 64 hex digits, the
 *    shape both verifiers reproduced with).
 * 2. The worst case, by construction: any number of attempts, ids and entries,
 *    each field as hostile as its type allows (over-long, every character
 *    JSON must escape, non-ASCII), under the longest header the grammar admits.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { BudgetEffect, CancelOutcome } from "@polymarket-bot/polymarket-secure";
import { installNetworkTripwire, type NetworkTripwire } from "@polymarket-bot/polymarket-secure/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AUDIT_SCHEMA, createFileAuditLog, encodeAuditLine, MAX_AUDIT_LINE_BYTES, type AuditRecord, type AuditValue } from "./audit-log.js";
import { auditAttempts, MAX_AUDITED_ATTEMPTS, type CancelAttempt } from "./commands/cancel.js";
import { auditedIds, auditId, auditText, MAX_AUDITED_ID_LENGTH, MAX_AUDITED_IDS } from "./context.js";
import { MAX_REASON_LENGTH } from "./grammar.js";
import { ACCOUNT, args, DESTRUCTIVE_REASON, harness, order } from "./harness.test-support.js";
import { runOpsCli } from "./run.js";

let tripwire: NetworkTripwire;
let scratch: string;
beforeEach(async () => {
  tripwire = installNetworkTripwire();
  scratch = await mkdtemp(path.join(tmpdir(), "ops-cli-bounds-"));
});
afterEach(async () => {
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
  await rm(scratch, { recursive: true, force: true });
});

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

describe("WP330-V1-01: a large cancel-all keeps its OUTCOME record (the real file sink)", () => {
  it("a sweep of 3,000 orders with 66-character ids: INVOKED, ACTING and OUTCOME are all in the file, each line within MAX_AUDIT_LINE_BYTES, with the full detail", async () => {
    const h = harness({});
    const ids = Array.from({ length: 3_000 }, (_, index) => `0x${index.toString(16).padStart(64, "0")}`);
    expect(ids.every((id) => id.length === 66)).toBe(true);
    h.venue.add(...ids.map((id) => order(id)));
    // The venue's DELETE /cancel-all leaves every order listed, so all 3,000 are swept by id (the case both verifiers ran).
    for (const id of ids) h.venue.ignoreCancelAll.add(id);
    const file = path.join(scratch, "audit.jsonl");
    const outcome = await runOpsCli(
      h.deps(args("cancel-all", ...DESTRUCTIVE_REASON, "--confirm", `cancel-all:${ACCOUNT}`, "--audit-log", file), { openAuditLog: (target) => createFileAuditLog(target) }),
    );
    expect(outcome.exitName).toBe("COMPLETED");
    expect(h.venue.open()).toEqual([]);
    const batches = h.venue.callsOf("cancelOrders").length;
    expect(batches).toBe(25); // Standard's cancel burst 120 minus 0‰ headroom

    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    const records = lines.map((line) => JSON.parse(line) as AuditRecord);
    expect(records.map((record) => record.phase)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
    for (const line of lines) expect(bytes(line) + 1).toBeLessThanOrEqual(MAX_AUDIT_LINE_BYTES);
    expect(h.text()).toContain("3 record(s) written and fsynced to");

    const detail = records[2]?.detail as Record<string, unknown>;
    expect(detail["detailOmitted"]).toBeUndefined();
    expect(detail).toMatchObject({
      exit: "COMPLETED",
      verified: true,
      attempts: { count: 1 + batches, sent: 1 + batches, requestedIds: 3_000, truncated: true },
      canceled: { count: 3_000, truncated: true },
      notCanceled: { count: 0, entries: [], truncated: false },
      stillListed: { count: 0, ids: [], truncated: false },
    });
    expect((detail["attempts"] as { itemized: unknown[] }).itemized).toHaveLength(MAX_AUDITED_ATTEMPTS);
    expect((detail["canceled"] as { ids: string[] }).ids).toEqual(ids.slice(0, MAX_AUDITED_IDS));
  });
});

describe("WP330-V1-01: the worst case, by construction", () => {
  /** Every character JSON escapes to six bytes, or to two, plus three-byte and over-long text. */
  const hostile = (length: number, salt: string): string => `${salt}"\\\u0000\u001f\ud800€`.repeat(Math.ceil(length / 7)).slice(0, length);

  it("auditId and auditText: an accepted venue order id is unchanged; anything else is reduced to a bounded, escape-free form", () => {
    const venueOrderId = `0x${"ab".repeat(32)}`;
    expect(auditId(venueOrderId)).toBe(venueOrderId);
    expect(auditId("A-z_0:9.")).toBe("A-z_0:9.");
    const reduced = auditId(hostile(5_000, "id"));
    expect(reduced.length).toBe(MAX_AUDITED_ID_LENGTH);
    expect(reduced).toMatch(/^[A-Za-z0-9_\-:.?]+$/u);
    expect(bytes(JSON.stringify(reduced))).toBe(MAX_AUDITED_ID_LENGTH + 2);
    const text = auditText(hostile(5_000, "tx"), 64);
    expect(text.length).toBe(64);
    expect(text).toMatch(/^[\x20-\x7e]+$/u);
    expect(auditText("Order already matched", 64)).toBe("Order already matched");
  });

  it("a cancel OUTCOME from 5,000 attempts of 1,000 hostile ids each, under the longest header, is one line within MAX_AUDIT_LINE_BYTES", () => {
    // Shared arrays (the content, not the identity, is what is measured): 5,000 attempts of their own would be gigabytes.
    const hostileIds = Array.from({ length: 1_000 }, (_, entry) => hostile(400, `i${String(entry)}`));
    const hostileEntries = hostileIds.map((orderId) => ({ orderId, reason: hostile(10_000, "r") }));
    const effects = Array.from({ length: 100 }, (_, index) => ({ kind: hostile(500, `e${String(index)}`) }) as unknown as BudgetEffect);
    const completed: CancelOutcome = { kind: "COMPLETED", canceled: hostileIds, notCanceled: hostileEntries };
    const unknown = { kind: "UNKNOWN", error: { kind: hostile(10_000, "k") } } as unknown as CancelOutcome;
    const attempts: CancelAttempt[] = Array.from({ length: 5_000 }, (_, index) => ({
      endpoint: "DELETE /orders",
      operationId: "clob.cancel_orders",
      requested: hostileIds,
      sent: true,
      notSent: hostile(10_000, "s"),
      waitedMs: Number.MAX_SAFE_INTEGER,
      outcome: index % 2 === 0 ? completed : unknown,
      canceledCount: Number.MAX_SAFE_INTEGER,
      effects,
      unanswered: true,
    }));
    const stillListed = Array.from({ length: 100_000 }, (_, index) => hostileIds[index % hostileIds.length] ?? "");
    const record: AuditRecord = {
      schema: AUDIT_SCHEMA,
      recordId: "01a10bef-6200-7000-8000-000000000003",
      invocationId: "01a10bef-6200-7000-8000-ffffffffffff",
      sequence: Number.MAX_SAFE_INTEGER,
      phase: "OUTCOME",
      at: "2026-10-05T12:00:00.000Z",
      command: "cancel-market",
      // The grammar's REFERENCE bound (200), and its --reason bound in the most expensive characters it admits.
      operator: `o${"-".repeat(199)}`,
      accountRef: `a${"-".repeat(199)}`,
      reason: "\ud800".repeat(MAX_REASON_LENGTH),
      runMode: "EXECUTION_PROBE",
      detail: {
        exit: "OUTCOME_UNRECORDED",
        exitCode: 18,
        target: `0x${"c".repeat(64)}`,
        asset: "9".repeat(78),
        ...auditAttempts(attempts),
        stillListed: auditedIds(stillListed),
        stillListedInAsset: auditedIds(stillListed),
        finalReadComplete: false,
        verified: false,
      },
    };
    const line = encodeAuditLine(record);
    expect(bytes(line)).toBeLessThanOrEqual(MAX_AUDIT_LINE_BYTES);
    // NON-VACUOUS: the same inputs, unbounded (fb9edcc's shape: every attempt's ids), are far over the bound.
    const fb9edccShape = attempts.slice(0, 2).map((attempt) => ({ requested: attempt.requested, outcome: attempt.outcome })) as unknown as AuditValue;
    const unbounded = encodeAuditLine({ ...record, detail: { attempts: fb9edccShape } });
    expect(bytes(unbounded)).toBeGreaterThan(MAX_AUDIT_LINE_BYTES);
  });
});
