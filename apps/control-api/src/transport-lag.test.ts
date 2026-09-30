/**
 * `THROUGHPUT-1a` — the trader's INPUT STREAM lag through the control API: the
 * door requires the `transport` section (every measured field a union with
 * `null`, never an optional key), and the metrics surface renders it as
 * `trader_transport_lag_entries`, `trader_transport_retention_max_events`,
 * `trader_transport_sample_age_seconds` and `trader_event_time_lag_seconds` —
 * each OMITTED, not zeroed, while the trader has no measurement.
 */

import { describe, expect, it } from "vitest";

import type { ApiRequest } from "./api.js";
import { readTraderHealthReport } from "./health-door.js";
import { FAKE_OPERATOR_TOKEN, bearer, createHarness, healthDocument } from "./testing/index.js";

function request(path: string): ApiRequest {
  return { method: "GET", path, authorization: bearer(FAKE_OPERATOR_TOKEN), body: undefined };
}

function documentWithTransport(transport: unknown): Record<string, unknown> {
  return { ...(JSON.parse(JSON.stringify(healthDocument())) as Record<string, unknown>), transport };
}

const UNMEASURED = {
  attached: false,
  sampleIntervalMs: null,
  samples: 0,
  sampleFailures: 0,
  sampledAt: null,
  sampleAgeMs: null,
  headPosition: null,
  consumerPosition: null,
  committedPosition: null,
  entriesBehindHead: null,
  retentionMaxEvents: null,
  lastEventAt: null,
  eventTimeLagMs: null,
} as const;

async function metricsFor(document: unknown): Promise<string> {
  const { api, health, healthSource } = createHarness();
  healthSource.set(document);
  await health.refresh();
  return (await api.handle(request("/v1/metrics"))).body;
}

describe("the door's transport section", () => {
  it("accepts a measured section and carries it through", () => {
    const result = readTraderHealthReport(healthDocument());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transport.entriesBehindHead).toBe(250);
    expect(result.value.transport.eventTimeLagMs).toBe(1500);
  });

  it("accepts the unmeasured section: null is absent, and the door says so rather than zeroing", () => {
    const result = readTraderHealthReport(documentWithTransport(UNMEASURED));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.transport.entriesBehindHead).toBeNull();
  });

  it("refuses a report WITHOUT the section, rather than defaulting it", () => {
    const document = JSON.parse(JSON.stringify(healthDocument())) as Record<string, unknown>;
    Reflect.deleteProperty(document, "transport");
    expect(readTraderHealthReport(document).ok).toBe(false);
  });

  it("refuses a missing field, an unknown field, a negative lag and a fractional position", () => {
    const withoutLag: Record<string, unknown> = { ...UNMEASURED };
    Reflect.deleteProperty(withoutLag, "entriesBehindHead");
    expect(readTraderHealthReport(documentWithTransport(withoutLag)).ok).toBe(false);
    expect(readTraderHealthReport(documentWithTransport({ ...UNMEASURED, extra: 1 })).ok).toBe(false);
    expect(readTraderHealthReport(documentWithTransport({ ...UNMEASURED, eventTimeLagMs: -1 })).ok).toBe(false);
    expect(readTraderHealthReport(documentWithTransport({ ...UNMEASURED, headPosition: 1.5 })).ok).toBe(false);
  });
});

describe("the metrics surface renders the input stream's lag", () => {
  it("exports the lag in entries, the retention bound, the sample age and the event-time lag", async () => {
    const body = await metricsFor(healthDocument());
    expect(body).toContain("# TYPE trader_transport_lag_entries gauge");
    expect(body).toContain("\ntrader_transport_lag_entries 250\n");
    expect(body).toContain("\ntrader_transport_retention_max_events 100000\n");
    expect(body).toContain("\ntrader_transport_sample_age_seconds 0.6\n");
    expect(body).toContain("# TYPE trader_event_time_lag_seconds gauge");
    expect(body).toContain("\ntrader_event_time_lag_seconds 1.5\n");
  });

  it("OMITS every transport series while the trader has no measurement", async () => {
    const body = await metricsFor(documentWithTransport(UNMEASURED));
    expect(body).toContain("control_trader_health_available 1");
    for (const family of [
      "trader_transport_lag_entries",
      "trader_transport_retention_max_events",
      "trader_transport_sample_age_seconds",
      "trader_event_time_lag_seconds",
    ]) {
      expect(body, family).not.toContain(family);
    }
  });

  it("follows the report: a lag that rises and falls is a series that rises and falls", async () => {
    const at = (entries: number, lagMs: number) =>
      metricsFor(
        documentWithTransport({
          ...UNMEASURED,
          attached: true,
          sampleIntervalMs: 1000,
          samples: 3,
          sampledAt: "2026-09-05T00:00:11.000Z",
          sampleAgeMs: 10,
          headPosition: 1000 + entries,
          consumerPosition: 1000,
          committedPosition: 1000,
          entriesBehindHead: entries,
          retentionMaxEvents: 100_000,
          lastEventAt: "2026-09-05T00:00:10.000Z",
          eventTimeLagMs: lagMs,
        }),
      );
    expect(await at(9000, 12_345)).toContain("\ntrader_transport_lag_entries 9000\n");
    expect(await at(9000, 12_345)).toContain("\ntrader_event_time_lag_seconds 12.345\n");
    expect(await at(0, 40)).toContain("\ntrader_transport_lag_entries 0\n");
    expect(await at(0, 40)).toContain("\ntrader_event_time_lag_seconds 0.04\n");
  });
});
