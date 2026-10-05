/**
 * Handoff §16.3's "Heartbeat protocol" contract test, beside the code (ADR-033
 * D2: `WP-320`'s allowed paths have no `test/contract/**` entry). It drives
 * the controller and its reader with the documented shapes the fixture
 * `test/fixtures/venue/heartbeat/heartbeat.json` records (S-D17, retrieved
 * 2026-08-24; `docs/venue/verified-2026-09-30.md` §15: "valid, unchanged"),
 * through a FAKE port. The protocol is documentary only: no round has
 * observed it, and nothing here sends a heartbeat.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createOrderHeartbeatController } from "./controller.js";
import { budgetFrom, CONTRACT_SNAPSHOT_PATH, EventLog, FakeHeartbeatTransport, LIVE_SHAPED_CONTEXT, ManualTime, SwitchableGate } from "./fakes.test-support.js";
import { classifyHeartbeatAnswer } from "./protocol.js";
import { BOOTSTRAP_HEARTBEAT_ID, HEARTBEAT_CADENCE_MS } from "./venue-facts.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

interface Fixture {
  readonly fixture: string;
  readonly source: string;
  readonly examples: readonly { readonly name: string; readonly payload: Record<string, string> }[];
}

const FIXTURE = JSON.parse(readFileSync(path.join(REPO_ROOT, "test/fixtures/venue/heartbeat/heartbeat.json"), "utf8")) as Fixture;
const SNAPSHOT: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, CONTRACT_SNAPSHOT_PATH), "utf8"));

function example(name: string): Record<string, string> {
  const found = FIXTURE.examples.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`the fixture has no example ${name}`);
  return found.payload;
}

describe("the heartbeat protocol against the venue fixture (S-D17)", () => {
  it("reads the fixture this test is about", () => {
    expect(FIXTURE.fixture).toBe("heartbeat/heartbeat");
    expect(FIXTURE.source).toBe("https://docs.polymarket.com/trading/manage-orders");
    expect(FIXTURE.examples.map((entry) => entry.name)).toEqual([
      "bootstrap-request-empty-id",
      "bootstrap-response-new-id",
      "continuation-request",
      "continuation-response-rotated-id",
      "response-400-invalid-id-recovery",
    ]);
  });

  it("a success carrying heartbeat_id is CONFIRMED with that id as the next one", () => {
    expect(classifyHeartbeatAnswer({ kind: "RESPONSE", httpStatus: 200, body: example("bootstrap-response-new-id") })).toEqual({
      kind: "CONFIRMED",
      nextHeartbeatId: example("bootstrap-response-new-id")["heartbeat_id"],
    });
  });

  it("the documented 400 is INVALID_ID with the expected id, read from heartbeat_id (never from error_msg)", () => {
    const body = example("response-400-invalid-id-recovery");
    expect(classifyHeartbeatAnswer({ kind: "RESPONSE", httpStatus: 400, body })).toEqual({ kind: "INVALID_ID", expectedHeartbeatId: body["heartbeat_id"] });
    expect(classifyHeartbeatAnswer({ kind: "RESPONSE", httpStatus: 400, body: { ...body, error_msg: "some other text" } }).kind).toBe("INVALID_ID");
    expect(classifyHeartbeatAnswer({ kind: "RESPONSE", httpStatus: 400, body: { error_msg: body["error_msg"] } }).kind).toBe("REJECTED");
  });

  it("S-D18's documented success, {status: ok}, carries no id: SUCCESS_WITHOUT_ID, never CONFIRMED (ADR-033 D6)", () => {
    expect(classifyHeartbeatAnswer({ kind: "RESPONSE", httpStatus: 200, body: { status: "ok" } }).kind).toBe("SUCCESS_WITHOUT_ID");
    expect(classifyHeartbeatAnswer({ kind: "RESPONSE", httpStatus: 200, body: { heartbeat_id: "" } }).kind).toBe("SUCCESS_WITHOUT_ID");
    expect(classifyHeartbeatAnswer({ kind: "RESPONSE", httpStatus: 200, body: { heartbeat_id: 7 } }).kind).toBe("SUCCESS_WITHOUT_ID");
    expect(classifyHeartbeatAnswer({ kind: "RESPONSE", httpStatus: 200, body: { heartbeat_id: "a\u0000b" } }).kind).toBe("SUCCESS_WITHOUT_ID");
    expect(classifyHeartbeatAnswer({ kind: "RESPONSE", httpStatus: 200, body: Object.defineProperty({}, "heartbeat_id", { get: () => "x" }) }).kind).toBe(
      "SUCCESS_WITHOUT_ID",
    );
  });

  it("anything outside the port's shapes is UNKNOWN, and nothing throws", () => {
    for (const answer of [undefined, null, 7, "RESPONSE", { kind: "RESPONSE" }, { kind: "RESPONSE", httpStatus: 99, body: {} }, { kind: "OTHER" }, example("bootstrap-response-new-id")]) {
      expect(classifyHeartbeatAnswer(answer).kind).toBe("UNKNOWN");
    }
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("trap");
        },
      },
    );
    expect(classifyHeartbeatAnswer(hostile).kind).toBe("UNKNOWN");
  });

  it("the controller speaks the fixture's chain: bootstrap with an empty id, then each returned id", async () => {
    const time = new ManualTime();
    const transport = new FakeHeartbeatTransport(time);
    const log = new EventLog();
    transport.script.push(
      { answer: { kind: "RESPONSE", httpStatus: 200, body: example("bootstrap-response-new-id") } },
      { answer: { kind: "RESPONSE", httpStatus: 200, body: example("continuation-response-rotated-id") } },
      { answer: { kind: "RESPONSE", httpStatus: 400, body: example("response-400-invalid-id-recovery") } },
    );
    const controller = createOrderHeartbeatController({
      runModeContext: LIVE_SHAPED_CONTEXT,
      transport,
      gate: new SwitchableGate(),
      budget: budgetFrom(SNAPSHOT),
      clock: time,
      timers: time,
      onEvent: log.listener,
    });
    controller.start();
    await time.advance(0);
    await time.advance(HEARTBEAT_CADENCE_MS);
    await time.advance(HEARTBEAT_CADENCE_MS);
    const sent = transport.requests.map((request) => ({ heartbeat_id: request.heartbeatId }));
    expect(sent[0]).toEqual(example("bootstrap-request-empty-id"));
    expect(sent[0]?.heartbeat_id).toBe(BOOTSTRAP_HEARTBEAT_ID);
    expect(sent[1]).toEqual(example("continuation-request"));
    expect(sent[2]).toEqual({ heartbeat_id: example("continuation-response-rotated-id")["heartbeat_id"] });
    // The 400's expected id is sent at once, in ONE recovery request.
    expect(sent[3]).toEqual({ heartbeat_id: example("response-400-invalid-id-recovery")["heartbeat_id"] });
    controller.close();
  });
});
