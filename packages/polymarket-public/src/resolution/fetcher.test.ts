/**
 * `V2-3`: the `/v2/resolutions` read (ADR-030 Amendment 2 rules 3 and 4).
 *
 * - The URL is the documented Data API origin's `/v2/resolutions`, keyed by
 *   `condition` in the 32-byte form only (F-70: the 31-byte form is a 400);
 *   any other text is refused before a request.
 * - One GET, no header beyond what the port adds, never retried, never
 *   rejected: a response of any status is returned as received; a transport
 *   failure or no answer within the timeout is `NO_ANSWER`, the request
 *   aborted through its signal.
 */

import { describe, expect, it } from "vitest";

import { PublicMarketConfigurationError } from "../errors.js";
import type { PublicHttpRequest, PublicHttpResponse } from "../ports.js";

import { DATA_API_BASE_URL, dataApiResolutionsUrl, requestDataApiResolutions, type ResolutionReadTimers } from "./fetcher.js";

const PADDED = "0x017791f201d5a788e0039e511fc1900e5f000000000000000000000000000000";

/** A timer port that fires only when the test says so. */
function manualTimers(): ResolutionReadTimers & { fire(): void; pending(): number } {
  const tasks: { run: () => void; cancelled: boolean }[] = [];
  return {
    setTimeout(handler) {
      const task = { run: handler, cancelled: false };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    fire() {
      for (const task of tasks.splice(0)) if (!task.cancelled) task.run();
    },
    pending() {
      return tasks.filter((task) => !task.cancelled).length;
    },
  };
}

describe("V2-3: the /v2/resolutions URL (F-57, F-65, F-70)", () => {
  it("is the documented origin's /v2/resolutions, keyed by condition in the 32-byte form", () => {
    expect(DATA_API_BASE_URL).toBe("https://data-api.polymarket.com");
    expect(dataApiResolutionsUrl(PADDED)).toBe(`https://data-api.polymarket.com/v2/resolutions?condition=${PADDED}`);
    expect(dataApiResolutionsUrl(PADDED, "http://data.stub/")).toBe(`http://data.stub/v2/resolutions?condition=${PADDED}`);
  });

  it("refuses the 31-byte form, any other width and any other text — no request can be built for them", () => {
    for (const bad of [PADDED.slice(0, -2), `${PADDED}0`, `${PADDED}00`, "0xab", "", PADDED.slice(2), `0X${PADDED.slice(2)}`, `${PADDED.slice(0, -1)}g`, `${PADDED}&status=resolved`]) {
      expect(() => dataApiResolutionsUrl(bad)).toThrow(PublicMarketConfigurationError);
    }
    expect(() => dataApiResolutionsUrl(PADDED, "")).toThrow(PublicMarketConfigurationError);
  });
});

describe("V2-3: one read, returned as received, never rejected", () => {
  it("sends exactly one GET with no body, and returns any status with its body as received", async () => {
    for (const status of [200, 400, 404, 429, 500, 503]) {
      const requests: PublicHttpRequest[] = [];
      const timers = manualTimers();
      const answer = await requestDataApiResolutions({
        http: async (request): Promise<PublicHttpResponse> => {
          requests.push(request);
          return { status, body: `{"data":[],"s":${String(status)}}` };
        },
        conditionId: PADDED,
        timers,
        timeoutMs: 5_000,
      });
      expect(answer).toEqual({ kind: "RESPONSE", url: dataApiResolutionsUrl(PADDED), status, bodyUtf8: `{"data":[],"s":${String(status)}}` });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ url: dataApiResolutionsUrl(PADDED), method: "GET" });
      expect(requests[0]?.jsonBody).toBeUndefined();
      expect(Object.keys(requests[0] ?? {}).sort()).toEqual(["method", "signal", "url"]);
      expect(timers.pending()).toBe(0); // the timeout is cancelled once answered
    }
  });

  it("a transport failure, thrown or rejected, is NO_ANSWER — nothing was received", async () => {
    const timers = manualTimers();
    const rejected = await requestDataApiResolutions({
      http: () => Promise.reject(new Error("ECONNRESET")),
      conditionId: PADDED,
      timers,
      timeoutMs: 5_000,
    });
    expect(rejected).toEqual({ kind: "NO_ANSWER", url: dataApiResolutionsUrl(PADDED), detail: "the request failed at the transport level: ECONNRESET" });
    const thrown = await requestDataApiResolutions({
      http: () => {
        throw new Error("no route");
      },
      conditionId: PADDED,
      timers,
      timeoutMs: 5_000,
    });
    expect(thrown).toMatchObject({ kind: "NO_ANSWER", detail: "the request failed at the transport level: no route" });
    expect(timers.pending()).toBe(0);
  });

  it("no answer within the timeout: NO_ANSWER, and the request is ABORTED through its signal; a later answer is discarded", async () => {
    const timers = manualTimers();
    let signal: AbortSignal | undefined;
    let answerLate: ((response: PublicHttpResponse) => void) | undefined;
    const pending = requestDataApiResolutions({
      http: (request) => {
        signal = request.signal;
        return new Promise<PublicHttpResponse>((settle) => {
          answerLate = settle;
        });
      },
      conditionId: PADDED,
      timers,
      timeoutMs: 5_000,
    });
    expect(signal?.aborted).toBe(false);
    timers.fire();
    const answer = await pending;
    expect(answer).toEqual({ kind: "NO_ANSWER", url: dataApiResolutionsUrl(PADDED), detail: "no answer within the read's 5000 ms timeout; the request was aborted" });
    expect(signal?.aborted).toBe(true);
    answerLate?.({ status: 200, body: '{"data":[]}' });
    expect(await pending).toEqual(answer);
  });

  it("refuses a timeout that is not a positive whole number of milliseconds", () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        requestDataApiResolutions({ http: async () => ({ status: 200, body: "{}" }), conditionId: PADDED, timers: manualTimers(), timeoutMs }),
      ).toThrow(PublicMarketConfigurationError);
    }
  });
});
