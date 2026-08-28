import { describe, expect, it } from "vitest";

import { COINBASE_ANOMALY_SEVERITY, type CoinbaseAnomalyCode } from "./anomalies.js";
import { elapsedMs } from "./metrics.js";

describe("elapsedMs", () => {
  it("converts a nanosecond delta to whole milliseconds", () => {
    expect(elapsedMs(0n, 1_000_000n)).toBe(1);
    expect(elapsedMs(0n, 2_500_000n)).toBe(2);
    expect(elapsedMs(1_000_000_000n, 3_000_000_000n)).toBe(2_000);
  });

  it("truncates rather than rounds, so a fresh feed is never reported stale", () => {
    expect(elapsedMs(0n, 999_999n)).toBe(0);
    expect(elapsedMs(0n, 1_999_999n)).toBe(1);
  });

  it("clamps at zero rather than reporting a negative staleness", () => {
    expect(elapsedMs(5_000_000n, 0n)).toBe(0);
    expect(elapsedMs(5_000_000n, 5_000_000n)).toBe(0);
  });

  it("stays exact past the range a float would survive", () => {
    // 100 days in nanoseconds is far beyond Number.MAX_SAFE_INTEGER, which is
    // exactly why the input is a bigint.
    const hundredDaysNs = 100n * 24n * 60n * 60n * 1_000_000_000n;
    expect(elapsedMs(0n, hundredDaysNs)).toBe(8_640_000_000);
    expect(Number.isSafeInteger(elapsedMs(0n, hundredDaysNs))).toBe(true);
  });
});

describe("anomaly severities", () => {
  it("assign a §14.4 severity to every code", () => {
    const codes: CoinbaseAnomalyCode[] = [
      "COINBASE_FRAME_NOT_TEXT",
      "COINBASE_FRAME_NOT_JSON",
      "COINBASE_FRAME_SHAPE_INVALID",
      "COINBASE_UNKNOWN_CHANNEL",
      "COINBASE_UNKNOWN_EVENT_TYPE",
      "COINBASE_UNKNOWN_TRADE_SIDE",
      "COINBASE_ECONOMIC_FIELD_INVALID",
      "COINBASE_TIMESTAMP_INVALID",
      "COINBASE_DOMAIN_PAYLOAD_REJECTED",
      "COINBASE_SEQUENCE_GAP",
      "COINBASE_SEQUENCE_REGRESSED",
      "COINBASE_DUPLICATE_TRADE",
      "COINBASE_TOP_OF_BOOK_UNCHANGED",
      "COINBASE_HEARTBEAT_GAP",
      "COINBASE_HEARTBEAT_REGRESSED",
      "COINBASE_SNAPSHOT_NOT_APPLIED",
      "COINBASE_STALE_CONNECTION_ACTIVITY",
      "COINBASE_FEED_STALE",
      "COINBASE_TRADE_HISTORY_NOT_BACKFILLED",
    ];
    expect(Object.keys(COINBASE_ANOMALY_SEVERITY).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      expect(["LOG", "NOTIFY", "PAGE"], code).toContain(COINBASE_ANOMALY_SEVERITY[code]);
    }
  });

  it("reserve LOG for the two anomalies that lose nothing", () => {
    const logOnly = Object.entries(COINBASE_ANOMALY_SEVERITY)
      .filter(([, severity]) => severity === "LOG")
      .map(([code]) => code)
      .sort();
    expect(logOnly).toEqual(["COINBASE_DUPLICATE_TRADE", "COINBASE_TOP_OF_BOOK_UNCHANGED"]);
  });

  it("page for anything that means market data went missing", () => {
    expect(COINBASE_ANOMALY_SEVERITY.COINBASE_SEQUENCE_GAP).toBe("PAGE");
    expect(COINBASE_ANOMALY_SEVERITY.COINBASE_HEARTBEAT_GAP).toBe("PAGE");
    expect(COINBASE_ANOMALY_SEVERITY.COINBASE_FRAME_NOT_TEXT).toBe("PAGE");
  });
});
