import { describe, expect, it } from "vitest";

import {
  ACCEPTANCE_1_CATEGORIES,
  RECORDER_METRIC_FAMILIES,
  recorderMetricFamily,
  recorderMetricNamesByCategory,
} from "./metric-families.js";
import {
  compactionMetricSamples,
  gatewayMetricSamples,
  renderExposition,
  renderRecorderMetrics,
  validationMetricSamples,
  type MetricSample,
} from "./render.js";
import { evaluateSoakEvidence } from "./soak-evidence.js";
import {
  fullyPopulatedCompactionSnapshot,
  fullyPopulatedGatewaySnapshot,
} from "./testing.js";

/** Parse sample lines (name, labels-raw, value) out of exposition text. */
function sampleLines(text: string): { name: string; labels: string; value: string }[] {
  const out: { name: string; labels: string; value: string }[] = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = /^(?<name>[a-zA-Z_:][a-zA-Z0-9_:]*)(?<labels>\{[^}]*\})? (?<value>\S+)$/u.exec(
      line,
    );
    expect(match, `unparseable exposition line: ${line}`).not.toBeNull();
    out.push({
      name: match?.groups?.["name"] ?? "",
      labels: match?.groups?.["labels"] ?? "",
      value: match?.groups?.["value"] ?? "",
    });
  }
  return out;
}

describe("the metric-family table", () => {
  it("prefixes every family recorder_ and uses _total only on counters", () => {
    for (const family of RECORDER_METRIC_FAMILIES) {
      expect(family.name).toMatch(/^recorder_[a-z0-9_]+$/u);
      if (family.name.endsWith("_total")) {
        expect(family.type, `${family.name} ends _total but is not a counter`).toBe("counter");
      }
    }
  });

  it("covers every acceptance-1 category with at least one family", () => {
    for (const category of ACCEPTANCE_1_CATEGORIES) {
      expect(
        recorderMetricNamesByCategory(category).length,
        `no metric family carries category ${category}`,
      ).toBeGreaterThan(0);
    }
  });

  it("declares the WP-120 round-1 obligation gauges", () => {
    // "WP-140 should chart the new publisher gauges (queueDepth,
    // queueMaxDepthObserved, oldestQueuedAgeMs, admissionRefusals)" —
    // docs/handoffs/WP-120.md, follow_up (remediation round 1) 1; queueBytes
    // per the dispatch packet.
    for (const name of [
      "recorder_publisher_queue_depth",
      "recorder_publisher_queue_max_depth_observed",
      "recorder_publisher_queue_bytes",
      "recorder_publisher_oldest_queued_age_ms",
      "recorder_publisher_admission_refusals_total",
    ]) {
      expect(recorderMetricFamily(name), `${name} missing from the table`).toBeDefined();
    }
  });
});

describe("renderExposition", () => {
  it("renders HELP/TYPE headers and samples in table order", () => {
    const text = renderExposition([
      { name: "recorder_wal_queue_depth", value: 3 },
      { name: "recorder_wal_faulted", value: 0 },
    ]);
    expect(text).toBe(
      [
        "# HELP recorder_wal_queue_depth WAL queue current depth (frames accepted, not yet handed to the segment writer).",
        "# TYPE recorder_wal_queue_depth gauge",
        "recorder_wal_queue_depth 3",
        "# HELP recorder_wal_faulted 1 when the WAL writer is in the faulted state, else 0.",
        "# TYPE recorder_wal_faulted gauge",
        "recorder_wal_faulted 0",
        "",
      ].join("\n"),
    );
  });

  it("refuses a sample whose family is not in the table", () => {
    expect(() =>
      renderExposition([{ name: "recorder_not_a_real_metric", value: 1 }]),
    ).toThrowError(/not declared/u);
  });

  it("refuses an undeclared label key", () => {
    expect(() =>
      renderExposition([
        { name: "recorder_wal_queue_depth", value: 1, labels: { feed: "polymarket" } },
      ]),
    ).toThrowError(/does not declare label/u);
  });

  it("escapes label values", () => {
    const text = renderExposition([
      {
        name: "recorder_publisher_halt_info",
        value: 1,
        labels: { cause: 'quo"te\\back\nline' },
      },
    ]);
    expect(text).toContain('cause="quo\\"te\\\\back\\nline"');
  });

  it("refuses NaN values", () => {
    expect(() =>
      renderExposition([{ name: "recorder_wal_queue_depth", value: Number.NaN }]),
    ).toThrowError(/NaN/u);
  });

  it("renders an empty sample set as an empty document", () => {
    expect(renderExposition([])).toBe("");
  });
});

describe("gatewayMetricSamples", () => {
  const snapshot = fullyPopulatedGatewaySnapshot();
  const samples = gatewayMetricSamples(snapshot);
  const byName = new Map<string, MetricSample[]>();
  for (const sample of samples) {
    const bucket = byName.get(sample.name) ?? [];
    bucket.push(sample);
    byName.set(sample.name, bucket);
  }

  it("maps the §14.3 recorder family fields faithfully", () => {
    const value = (name: string): number | undefined => byName.get(name)?.[0]?.value;
    expect(value("recorder_wal_queue_depth")).toBe(3);
    expect(value("recorder_wal_queue_oldest_message_age_ms")).toBe(21);
    expect(value("recorder_wal_bytes_written_total")).toBe(512_000);
    expect(value("recorder_wal_fsync_last_duration_ms")).toBe(3);
    expect(value("recorder_wal_active_segment_age_ms")).toBe(1_234);
    expect(value("recorder_wal_data_loss_bound_ms")).toBe(1_000);
    expect(value("recorder_publisher_queue_depth")).toBe(7);
    expect(value("recorder_publisher_queue_max_depth_observed")).toBe(64);
    expect(value("recorder_publisher_oldest_queued_age_ms")).toBe(45);
    expect(value("recorder_publisher_admission_refusals_total")).toBe(2);
    expect(value("recorder_publisher_halted")).toBe(1);
    expect(value("recorder_rtds_halted")).toBe(1);
    expect(value("recorder_wal_faulted")).toBe(0);
  });

  it("labels the halt with its cause", () => {
    const halt = byName.get("recorder_publisher_halt_info")?.[0];
    expect(halt?.labels).toEqual({ cause: "EVENT_BUS_UNAVAILABLE" });
    expect(halt?.value).toBe(1);
  });

  it("exposes pendingConnectionId as a labeled info gauge", () => {
    const pending = byName.get("recorder_feed_pending_connection_info")?.[0];
    expect(pending?.labels).toEqual({ feed: "binance", connection_id: "binance-conn-7" });
  });

  it("emits per-feed families for all four feeds", () => {
    const feeds = byName
      .get("recorder_feed_frames_recorded_total")
      ?.map((sample) => sample.labels?.["feed"])
      .sort();
    expect(feeds).toEqual(["binance", "coinbase", "polymarket", "rtds"]);
  });

  it("omits null-able gauges instead of rendering 0", () => {
    const nullable = {
      ...snapshot,
      wal: {
        ...snapshot.wal,
        activeSegmentAgeMs: null,
        lastFsyncDurationMs: null,
        msSinceLastFsync: null,
        capacityBytes: null,
        capacityRemainingBytes: null,
      },
    };
    const names = new Set(gatewayMetricSamples(nullable).map((sample) => sample.name));
    expect(names.has("recorder_wal_active_segment_age_ms")).toBe(false);
    expect(names.has("recorder_wal_fsync_last_duration_ms")).toBe(false);
    expect(names.has("recorder_wal_ms_since_last_fsync")).toBe(false);
    expect(names.has("recorder_wal_capacity_bytes")).toBe(false);
    expect(names.has("recorder_wal_capacity_remaining_bytes")).toBe(false);
  });

  it("omits absent feed and directory sections entirely", () => {
    const bare = {
      gatewayEpoch: snapshot.gatewayEpoch,
      wal: snapshot.wal,
      publisher: { ...snapshot.publisher, halted: false, halt: undefined },
      dispatcher: snapshot.dispatcher,
      incidents: snapshot.incidents,
    };
    const names = new Set(gatewayMetricSamples(bare).map((sample) => sample.name));
    expect(names.has("recorder_feed_frames_recorded_total")).toBe(false);
    expect(names.has("recorder_directory_known_markets")).toBe(false);
    expect(names.has("recorder_publisher_halt_info")).toBe(false);
    expect(names.has("recorder_rtds_halted")).toBe(false);
  });
});

describe("compactionMetricSamples", () => {
  it("maps compaction lag and one-hot upload status", () => {
    const samples = compactionMetricSamples(fullyPopulatedCompactionSnapshot());
    const lag = samples.find((sample) => sample.name === "recorder_compaction_lag_ms");
    expect(lag?.value).toBe(65_000);
    const statuses = samples
      .filter((sample) => sample.name === "recorder_upload_status")
      .map((sample) => [sample.labels?.["status"], sample.value]);
    expect(statuses).toEqual([
      ["idle", 0],
      ["succeeded", 0],
      ["failed", 1],
    ]);
    const failed = samples.find((sample) => sample.name === "recorder_upload_failed");
    expect(failed?.value).toBe(1);
  });

  it("omits compaction lag when the last cycle left nothing behind (null is not zero)", () => {
    const samples = compactionMetricSamples({
      ...fullyPopulatedCompactionSnapshot(),
      objectUploadStatus: "succeeded",
      compactionLagMs: null,
    });
    expect(samples.some((sample) => sample.name === "recorder_compaction_lag_ms")).toBe(false);
    const failed = samples.find((sample) => sample.name === "recorder_upload_failed");
    expect(failed?.value).toBe(0);
  });
});

describe("validationMetricSamples", () => {
  it("counts findings by class and severity", () => {
    const samples = validationMetricSamples({
      job: "dataset-validation",
      ok: false,
      findings: [
        { check: "payload-digest", severity: "error" },
        { check: "payload-digest", severity: "error" },
        { check: "retention-receipt", severity: "warning" },
      ],
    });
    const ok = samples.find((sample) => sample.name === "recorder_validation_ok");
    expect(ok?.value).toBe(0);
    expect(ok?.labels).toEqual({ job: "dataset-validation" });
    const digest = samples.find(
      (sample) =>
        sample.name === "recorder_validation_findings" &&
        sample.labels?.["class"] === "payload-digest",
    );
    expect(digest?.value).toBe(2);
    expect(digest?.labels?.["severity"]).toBe("error");
  });
});

describe("renderRecorderMetrics (the combined document)", () => {
  it("reaches every family in the table from fully-populated inputs", () => {
    const soak = evaluateSoakEvidence([], Date.parse("2026-09-01T00:00:00Z"));
    const text = renderRecorderMetrics({
      gateway: fullyPopulatedGatewaySnapshot(),
      compaction: fullyPopulatedCompactionSnapshot(),
      validation: [
        {
          job: "dataset-validation",
          ok: true,
          findings: [{ check: "object-read", severity: "error" }],
        },
        {
          job: "book-comparison",
          ok: true,
          findings: [{ check: "book-divergence", severity: "error" }],
        },
      ],
      soak,
    });
    const emitted = new Set(sampleLines(text).map((line) => line.name));
    for (const family of RECORDER_METRIC_FAMILIES) {
      expect(emitted.has(family.name), `family ${family.name} was never emitted`).toBe(true);
    }
  });

  it("every emitted TYPE header matches the table", () => {
    const text = renderRecorderMetrics({
      gateway: fullyPopulatedGatewaySnapshot(),
      compaction: fullyPopulatedCompactionSnapshot(),
    });
    for (const line of text.split("\n")) {
      if (!line.startsWith("# TYPE ")) {
        continue;
      }
      const [, , name, type] = line.split(" ");
      expect(recorderMetricFamily(name ?? "")?.type).toBe(type);
    }
  });
});
