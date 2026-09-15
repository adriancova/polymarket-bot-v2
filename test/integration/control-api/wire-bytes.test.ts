/**
 * THE BYTES THE CONTROL HTTP SERVER WRITES, OVER REAL HTTP (`SER-3`).
 *
 * `SER-3` routed every byte this process writes through the own-data encoder:
 * `api.ts`'s `json()` (HIGH — a state read, the kill-switch list, a mutation
 * receipt) and `http.ts`'s two transport-level refusal bodies (NOTE, taken for
 * uniformity). This suite's job is the one the unit tier cannot do: prove that
 * the bytes an operator's tool reads OFF THE SOCKET are exactly the
 * clean-process bytes after that change — no framing, indent or trailing-newline
 * drift.
 *
 * WHY THERE IS NO POLLUTION WINDOW HERE. The six-context pins live in
 * `test/unit/control-api/inherited-tojson.test.ts`, which drives the same two
 * functions (`json()`, through the real API; `controlRefusalBody`, the function
 * both `http.ts` sites call) with a window that never yields to the macrotask
 * queue. A window held across socket I/O would corrupt vitest's own worker IPC
 * — measured in this repository's configuration: the main process fails in
 * `deserialize` with `ERR_INVALID_ARG_TYPE`, because the serialized buffer has
 * been replaced by the injected string. An "integration pin" that can poison
 * the reporter is not evidence, so this file asserts the wire bytes in a clean
 * process instead, and says so.
 */

import { afterEach, describe, expect, it } from "vitest";

import { FAKE_OPERATOR_TOKEN } from "@polymarket-bot/control-api/testing";

import { serveControlApi, type ServedApi } from "./support/client.js";

const OPERATORS = [
  {
    operatorId: "operator-a",
    token: FAKE_OPERATOR_TOKEN,
    grants: ["READ", "STRATEGY_CONTROL", "KILL_SWITCH"] as const,
  },
];

let served: ServedApi | undefined;

afterEach(async () => {
  await served?.server.close();
  served = undefined;
});

describe("control-api bytes on the wire (SER-3)", () => {
  it("the 413 and 400 refusal bodies and a state read are byte-exactly the clean-process encodings", async () => {
    served = await serveControlApi({ operators: OPERATORS, maxRequestBodyBytes: 256 });
    const api = served;

    const tooLarge = await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      rawBody: `{"reason":"${"x".repeat(4096)}"}`,
    });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.text).toBe(
      `${JSON.stringify({
        code: "CONTROL_BODY_TOO_LARGE",
        detail: "a request body may not exceed 256 bytes",
        issues: [],
      })}\n`,
    );

    const notJson = await api.call("POST", "/v1/strategies/sb-1/pause", {
      token: FAKE_OPERATOR_TOKEN,
      rawBody: "not json {{{",
    });
    expect(notJson.status).toBe(400);
    const parsedNotJson = notJson.json() as { code: string; detail: string; issues: readonly string[] };
    expect(parsedNotJson.code).toBe("CONTROL_BODY_NOT_JSON");
    expect(parsedNotJson.issues).toHaveLength(1);
    expect(notJson.text).toBe(`${JSON.stringify(parsedNotJson)}\n`);

    const runState = await api.call("GET", "/v1/run-state", { token: FAKE_OPERATOR_TOKEN });
    expect(runState.status).toBe(200);
    // `json()`'s pretty-printed form, unchanged: two-space indent, one trailing newline.
    expect(runState.text).toBe(`${JSON.stringify(runState.json(), null, 2)}\n`);
    expect(runState.text.endsWith("}\n")).toBe(true);
    const state = runState.json() as { allowRealOrders: boolean; runModeIsWritable: boolean };
    expect(state.allowRealOrders).toBe(false);
    expect(state.runModeIsWritable).toBe(false);
  });
});
