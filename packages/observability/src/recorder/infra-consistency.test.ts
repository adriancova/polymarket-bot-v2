/**
 * Machine-checks WP-140 acceptance 1 — "Dashboard exposes queue depth, lag,
 * gaps, fsync, compaction, and upload status" — and pins the infra artifacts
 * to the exporter:
 *
 * 1. every `recorder_*` series referenced by a Grafana panel or a Prometheus
 *    alert expression is a family the exporter emits (the canonical table in
 *    `metric-families.ts`, every entry of which `render.test.ts` proves
 *    reachable);
 * 2. each acceptance-1 category has at least one dashboard panel bound to a
 *    metric of that category;
 * 3. the WP-120-obligated charts and alarms exist by name.
 *
 * The dashboard JSON and rules YAML are read from the repository — they ARE
 * the artifacts under test, so a private copy here would defeat the point.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ACCEPTANCE_1_CATEGORIES,
  recorderMetricFamily,
  recorderMetricNamesByCategory,
} from "./metric-families.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const dashboardPath = resolve(repoRoot, "infra/grafana/recorder/recorder-dashboard.json");
const alertsPath = resolve(repoRoot, "infra/prometheus/recorder-alerts.yaml");
const scrapePath = resolve(repoRoot, "infra/prometheus/recorder-scrape.yaml");

interface DashboardTarget {
  readonly expr?: string;
}
interface DashboardPanel {
  readonly id?: number;
  readonly type?: string;
  readonly title?: string;
  readonly targets?: readonly DashboardTarget[];
}
interface Dashboard {
  readonly title?: string;
  readonly panels?: readonly DashboardPanel[];
}

const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8")) as Dashboard;
const alertsSource = readFileSync(alertsPath, "utf8");

function recorderSeries(expr: string): string[] {
  return [...expr.matchAll(/\brecorder_[a-z0-9_]+/gu)].map((match) => match[0]);
}

function dataPanels(): DashboardPanel[] {
  return (dashboard.panels ?? []).filter((panel) => panel.type !== "row");
}

function allDashboardExprs(): string[] {
  return dataPanels().flatMap((panel) =>
    (panel.targets ?? []).flatMap((target) => (target.expr === undefined ? [] : [target.expr])),
  );
}

describe("the recorder dashboard", () => {
  it("parses and has data panels, each with at least one expression", () => {
    expect(dataPanels().length).toBeGreaterThanOrEqual(15);
    for (const panel of dataPanels()) {
      const exprs = (panel.targets ?? []).map((target) => target.expr ?? "");
      expect(exprs.length, `panel "${panel.title ?? "?"}" has no targets`).toBeGreaterThan(0);
      for (const expr of exprs) {
        expect(expr, `panel "${panel.title ?? "?"}" has an empty expr`).not.toBe("");
      }
    }
  });

  it("has unique panel ids", () => {
    const ids = (dashboard.panels ?? []).map((panel) => panel.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("binds every recorder_* series to a metric the exporter emits", () => {
    for (const expr of allDashboardExprs()) {
      for (const name of recorderSeries(expr)) {
        expect(
          recorderMetricFamily(name),
          `dashboard references ${name}, which the exporter does not emit`,
        ).toBeDefined();
      }
    }
  });

  it("uses no series other than recorder_* families and `up`", () => {
    for (const expr of allDashboardExprs()) {
      const stripped = expr
        .replaceAll(/\brecorder_[a-z0-9_]+/gu, " ")
        .replaceAll(/\b(?:rate|increase|sum|absent|by|avg|max|min)\b/gu, " ")
        .replaceAll(/\{[^}]*\}/gu, " ")
        .replaceAll(/\[[^\]]*\]/gu, " ");
      const leftovers = [...stripped.matchAll(/[a-zA-Z_][a-zA-Z0-9_]*/gu)].map(
        (match) => match[0],
      );
      for (const token of leftovers) {
        expect(
          token,
          `dashboard expr "${expr}" references unexpected series/function "${token}"`,
        ).toBe("up");
      }
    }
  });

  it("ACCEPTANCE 1: exposes queue depth, lag, gaps, fsync, compaction, and upload status", () => {
    const referenced = new Set(allDashboardExprs().flatMap(recorderSeries));
    for (const category of ACCEPTANCE_1_CATEGORIES) {
      const bound = recorderMetricNamesByCategory(category).filter((name) =>
        referenced.has(name),
      );
      expect(
        bound.length,
        `no dashboard panel is bound to any "${category}" metric`,
      ).toBeGreaterThan(0);
    }
  });

  it("charts the WP-120 round-1 obligation gauges", () => {
    const referenced = new Set(allDashboardExprs().flatMap(recorderSeries));
    for (const name of [
      "recorder_publisher_queue_depth",
      "recorder_publisher_queue_max_depth_observed",
      "recorder_publisher_queue_bytes",
      "recorder_publisher_oldest_queued_age_ms",
      "recorder_publisher_admission_refusals_total",
    ]) {
      expect(referenced.has(name), `obligated gauge ${name} is not charted`).toBe(true);
    }
  });

  it("charts the process-up series for the EXIT alarm view", () => {
    expect(allDashboardExprs().some((expr) => expr.includes('up{job="recorder"}'))).toBe(true);
  });
});

describe("the recorder alert rules", () => {
  const exprs = [...alertsSource.matchAll(/^\s*expr:\s*(?<expr>.+)$/gmu)]
    .map((match) => match.groups?.["expr"] ?? "")
    // fold the >- block scalars: collect indented continuation lines
    .concat(
      [...alertsSource.matchAll(/expr:\s*>-\n(?<block>(?:\s{2,}.+\n)+)/gu)].map(
        (match) => match.groups?.["block"] ?? "",
      ),
    );

  it("finds alert expressions at all", () => {
    expect(exprs.length).toBeGreaterThanOrEqual(10);
  });

  it("binds every recorder_* series in every rule to an emitted metric", () => {
    for (const expr of exprs) {
      for (const name of recorderSeries(expr)) {
        expect(
          recorderMetricFamily(name),
          `alert rule references ${name}, which the exporter does not emit`,
        ).toBeDefined();
      }
    }
  });

  it("contains the obligated alarms by name", () => {
    for (const alert of [
      // WP-120: alarm on recorder EXIT.
      "RecorderExited",
      // WP-120 round 1: alarm on oldest-queued-age BEFORE the bound.
      "RecorderPublishQueueAgeHigh",
      "RecorderPublishQueueNearBound",
      "RecorderPublishAdmissionRefusals",
      // §14.4 page: unable to record or publish.
      "RecorderPublicationHalted",
      "RecorderWalFaulted",
      "RecorderWalRefusals",
      "RecorderWalDroppedMessages",
      // ADR-004 §3: the data-loss bound is only true while fsync runs.
      "RecorderFsyncOverdue",
      // Feed halts.
      "RecorderRtdsHalted",
      "RecorderFeedStalls",
      // WP-130 signals.
      "RecorderCompactionLagHigh",
      "RecorderUploadFailed",
      "RecorderValidationFindings",
      // Soak-evidence honesty.
      "RecorderSoakEvidenceInvalid",
    ]) {
      expect(alertsSource, `alert ${alert} is missing`).toContain(`- alert: ${alert}`);
    }
  });

  it("documents the log-based FAILED-to-exit alarm instead of faking it as PromQL", () => {
    expect(alertsSource).toContain("cleanup deadline");
    expect(alertsSource).toContain("[disposal]");
    expect(alertsSource).toContain("FAILED to exit");
  });

  it("the oldest-age alarm threshold sits BELOW what the bound implies", () => {
    // The obligation is warning BEFORE the halt. 5s of head age with the
    // default 1024-deep/8MiB queue is early; this pin keeps a future edit
    // from quietly moving the alarm to after the horse has left.
    const match = /RecorderPublishQueueAgeHigh[\s\S]*?expr:\s*recorder_publisher_oldest_queued_age_ms\s*>\s*(?<ms>\d+)/u.exec(
      alertsSource,
    );
    expect(match).not.toBeNull();
    expect(Number(match?.groups?.["ms"])).toBeLessThanOrEqual(30_000);
  });
});

describe("the scrape fragment", () => {
  const scrapeSource = readFileSync(scrapePath, "utf8");

  it("targets loopback only and wires the rules file", () => {
    for (const target of scrapeSource.matchAll(/targets:\s*\[(?<list>[^\]]*)\]/gu)) {
      expect(target.groups?.["list"] ?? "").toMatch(/^\s*"127\.0\.0\.1:\d+"\s*$/u);
    }
    expect(scrapeSource).toContain("recorder-alerts.yaml");
    expect(scrapeSource).toContain('job_name: "recorder"');
  });

  it("carries no credential-shaped keys", () => {
    for (const forbidden of [
      "password",
      "bearer_token",
      "authorization",
      "basic_auth",
      "secret",
    ]) {
      expect(scrapeSource.toLowerCase()).not.toContain(forbidden);
    }
  });
});
