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
 * 3. the WP-120-obligated charts exist by name, and the alert rules declare
 *    EXACTLY the expected alert-name set (both directions — a rename fails
 *    as missing and unexpected at once; remediation round 1, M-1).
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

  it("the declared alert-name set matches the expected set EXACTLY, both directions", () => {
    // Remediation round 1, M-1: substring matching accepted prefix renames
    // (`RecorderExitedRenamed` passed). Parse the actual `alert:` declarations
    // and require set equality — a rename now fails twice: the old name is
    // missing AND the new name is unexpected.
    const declared = [...alertsSource.matchAll(/^\s*-\s*alert:\s*(?<name>\S+)\s*$/gmu)]
      .map((match) => match.groups?.["name"] ?? "")
      .filter((name) => name !== "");
    expect(new Set(declared).size, "duplicate alert names declared").toBe(declared.length);

    const expected = [
      // WP-120: alarm on recorder EXIT.
      "RecorderExited",
      // §14.4 page: unable to record or publish.
      "RecorderPublicationHalted",
      // WP-120 round 1 queue signals. The age alarm is BEST-EFFORT early
      // warning (advisory lead time); the enforced guarantee is the
      // in-process terminal halt + PAGE incident on overflow (WP-120).
      "RecorderPublishQueueAgeHigh",
      "RecorderPublishQueueNearBound",
      "RecorderPublishAdmissionRefusals",
      "RecorderWalFaulted",
      "RecorderWalRefusals",
      "RecorderWalDroppedMessages",
      "RecorderWalUnmanifestedSegments",
      // ADR-004 §3: the data-loss bound is only true while fsync runs.
      "RecorderFsyncOverdue",
      // Feed halts.
      "RecorderFeedStalls",
      "RecorderRtdsHalted",
      "RecorderPolymarketSnapshotFailures",
      // WP-130 signals.
      "RecorderCompactionLagHigh",
      "RecorderCompactionFailing",
      "RecorderUploadFailed",
      "RecorderRetentionFailures",
      "RecorderValidationFindings",
      "RecorderValidationNotOk",
      // Soak-evidence honesty.
      "RecorderSoakEvidenceInvalid",
    ];
    const declaredSet = new Set(declared);
    const expectedSet = new Set(expected);
    const missing = expected.filter((name) => !declaredSet.has(name));
    const unexpected = declared.filter((name) => !expectedSet.has(name));
    expect(missing, `expected alerts missing from the rules file`).toEqual([]);
    expect(
      unexpected,
      `alerts declared in the rules file but not in the expected set — update BOTH together`,
    ).toEqual([]);
  });

  it("documents the log-based FAILED-to-exit alarm instead of faking it as PromQL", () => {
    expect(alertsSource).toContain("cleanup deadline");
    expect(alertsSource).toContain("[disposal]");
    expect(alertsSource).toContain("FAILED to exit");
  });

  it("the queue-age alarm promises only what it can keep: best-effort early warning", () => {
    // Remediation round 1, M-3 (orchestrator authority): a "fires BEFORE the
    // admission bound" claim is unenforceable — a fast burst can fill the
    // 1024-entry/8 MiB queue inside the age threshold + scrape interval +
    // `for:` window. The alarm is BEST-EFFORT advisory lead time; the
    // ENFORCED guarantee is the in-process terminal halt + PAGE incident on
    // overflow (WP-120's machinery). This test pins the honest wording AND
    // the (reasoned, soak-pending) threshold value so neither can quietly
    // drift back into a guarantee nobody enforces.
    const rule = /- alert: RecorderPublishQueueAgeHigh[\s\S]*?(?=- alert: |$)/u.exec(
      alertsSource,
    );
    expect(rule).not.toBeNull();
    const ruleText = rule?.[0] ?? "";
    const match = /expr:\s*recorder_publisher_oldest_queued_age_ms\s*>\s*(?<ms>\d+)/u.exec(
      ruleText,
    );
    expect(match).not.toBeNull();
    // The reasoned threshold, pending sizing from real soak data (runbook §5).
    expect(Number(match?.groups?.["ms"])).toBe(5_000);
    // The honest framing is present…
    expect(ruleText).toContain("Best-effort early warning");
    expect(ruleText).toContain("advisory lead time");
    expect(ruleText).toContain("in-process terminal halt");
    // …and the unenforceable guarantee wording is absent.
    expect(ruleText.toLowerCase()).not.toContain("before the bound");
    expect(ruleText.toLowerCase()).not.toContain("guarantees");
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
