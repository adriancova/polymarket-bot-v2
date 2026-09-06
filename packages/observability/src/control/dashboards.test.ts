/**
 * Machine-checks the three shipped Grafana dashboards against the metric tables
 * and the paper-safety vocabulary — the `WP-140` `infra-consistency.test.ts`
 * precedent, applied to `WP-240`'s deliverable.
 *
 * The dashboards are READ FROM THE REPOSITORY: they ARE the artifacts under
 * test, so a private copy here would defeat the point.
 *
 * `node:fs` in a TEST file is outside F17, which governs a layer-1 package's
 * **production** import surface (`docs/contracts/dependency-direction.md` §2.2:
 * "the production-only scope is part of the rule"). `WP-140`'s
 * `infra-consistency.test.ts` reads its dashboard the same way.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CONTROL_DASHBOARDS,
  PENDING_PRODUCER_MARKER,
  PENDING_PRODUCER_OWNER_MARKER,
  PENDING_PRODUCER_PANELS,
  type ControlDashboardId,
} from "./dashboards.js";
import { PLATFORM_METRIC_FAMILIES, platformMetricFamily } from "./metric-families.js";
import { ALL_PRODUCTION_NAMES, LIVE_MODE_CONTROL_TOKENS } from "./paper-safety.js";
import { recorderMetricFamily } from "../recorder/metric-families.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const dashboardDir = resolve(repoRoot, "infra/grafana/control");

interface Target {
  readonly expr?: string;
  readonly refId?: string;
}
interface Panel {
  readonly id?: number;
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
  readonly targets?: readonly Target[];
  readonly options?: { readonly content?: string; readonly mode?: string };
  readonly links?: readonly unknown[];
  readonly url?: string;
}
interface TemplatingVariable {
  readonly name?: string;
  readonly type?: string;
  readonly label?: string;
  readonly query?: string;
}
interface Dashboard {
  readonly uid?: string;
  readonly title?: string;
  readonly description?: string;
  readonly editable?: boolean;
  readonly panels?: readonly Panel[];
  readonly templating?: { readonly list?: readonly TemplatingVariable[] };
  readonly links?: readonly unknown[];
  readonly annotations?: unknown;
}

function load(id: ControlDashboardId): { readonly raw: string; readonly dashboard: Dashboard } {
  const spec = CONTROL_DASHBOARDS.find((entry) => entry.id === id);
  if (spec === undefined) throw new Error(`no spec for dashboard ${id}`);
  const raw = readFileSync(resolve(dashboardDir, spec.file), "utf8");
  return { raw, dashboard: JSON.parse(raw) as Dashboard };
}

const LOADED = CONTROL_DASHBOARDS.map((spec) => ({ spec, ...load(spec.id) }));

function seriesIn(expr: string): readonly string[] {
  return [...expr.matchAll(/\b(?:trader|control|recorder)_[a-z0-9_]+/gu)].map((m) => m[0]);
}

function allSeries(dashboard: Dashboard): readonly string[] {
  return (dashboard.panels ?? []).flatMap((panel) =>
    (panel.targets ?? []).flatMap((target) => seriesIn(target.expr ?? "")),
  );
}

function dataPanels(dashboard: Dashboard): readonly Panel[] {
  return (dashboard.panels ?? []).filter((panel) => panel.type !== "text" && panel.type !== "row");
}

function textPanels(dashboard: Dashboard): readonly Panel[] {
  return (dashboard.panels ?? []).filter((panel) => panel.type === "text");
}

describe.each(LOADED)("$spec.id dashboard", ({ spec, raw, dashboard }) => {
  it("parses, carries the declared title, and is not UI-editable", () => {
    expect(dashboard.title).toBe(spec.title);
    expect(dashboard.uid, "a stable uid so a re-import replaces rather than duplicates").toMatch(
      /^pmb-control-[a-z]+$/u,
    );
    // The repository copy is the source of truth; an edit made in the UI is an
    // edit this suite never sees.
    expect(dashboard.editable).toBe(false);
  });

  it("has unique panel ids", () => {
    const ids = (dashboard.panels ?? []).map((panel) => panel.id);
    expect(ids).not.toContain(undefined);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("contains every required panel by title", () => {
    const titles = (dashboard.panels ?? []).map((panel) => panel.title ?? "");
    for (const required of spec.requiredPanels) {
      expect(titles, `${spec.id} must keep the "${required}" panel`).toContain(required);
    }
  });

  it("gives every data panel at least one expression, and every panel a description", () => {
    for (const panel of dataPanels(dashboard)) {
      expect((panel.targets ?? []).length, `panel "${panel.title ?? ""}"`).toBeGreaterThan(0);
      for (const target of panel.targets ?? []) {
        expect((target.expr ?? "").length, `panel "${panel.title ?? ""}"`).toBeGreaterThan(0);
      }
    }
    for (const panel of dashboard.panels ?? []) {
      expect((panel.description ?? "").length, `panel "${panel.title ?? ""}"`).toBeGreaterThan(20);
    }
  });

  it("binds every series to a family one of the two exporters actually emits", () => {
    for (const series of allSeries(dashboard)) {
      const known =
        platformMetricFamily(series) !== undefined || recorderMetricFamily(series) !== undefined;
      expect(known, `${series} is bound by a panel but declared by no exporter`).toBe(true);
    }
  });

  it("uses no series outside the two declared exporters", () => {
    for (const panel of dataPanels(dashboard)) {
      for (const target of panel.targets ?? []) {
        const expr = target.expr ?? "";
        // Strip every known series, PromQL function, duration and punctuation;
        // whatever identifier survives is a series nobody declared.
        const stripped = seriesIn(expr).reduce((text, series) => text.split(series).join(" "), expr);
        const leftovers = [...stripped.matchAll(/[A-Za-z_][A-Za-z0-9_]*/gu)]
          .map((match) => match[0])
          .filter(
            (token) =>
              !["rate", "increase", "sum", "by", "avg", "max", "min", "m", "h", "d"].includes(
                token,
              ),
          );
        expect(leftovers, `panel "${panel.title ?? ""}" expr "${expr}"`).toEqual([]);
      }
    }
  });

  it("applies NO PromQL arithmetic to an `_info` family (§6 invariant 1)", () => {
    for (const panel of dataPanels(dashboard)) {
      for (const target of panel.targets ?? []) {
        const expr = target.expr ?? "";
        const infoSeries = seriesIn(expr).filter(
          (series) => platformMetricFamily(series)?.infoOnly === true,
        );
        if (infoSeries.length === 0) continue;
        expect(
          expr,
          `panel "${panel.title ?? ""}" must not compute over an exact-decimal info series`,
        ).toBe(infoSeries[0]);
      }
    }
  });

  it("declares exactly one template variable, and it is the datasource selector", () => {
    const variables = dashboard.templating?.list ?? [];
    expect(variables).toHaveLength(1);
    // A `textbox` or `custom` variable is a place an operator types a value
    // that reaches a query. There is no such thing on a read-only surface.
    expect(variables[0]?.type).toBe("datasource");
    expect(variables[0]?.name).toBe("DS_PROMETHEUS");
  });

  it("carries NO production secret name (ADR-010 §3)", () => {
    const upper = raw.toUpperCase();
    for (const name of ALL_PRODUCTION_NAMES) {
      expect(upper, `${spec.file} references ${name}`).not.toContain(name);
    }
  });

  it("carries NO live-mode control token in any control-bearing field", () => {
    // Scanned: the dashboard title, every panel title, and every templating
    // name/label/query. NOT scanned: descriptions and text-panel bodies, which
    // must stay free to SAY that this surface has no live-mode control — the
    // same distinction WP-140's guarantee-wording scan draws.
    const controlBearing = [
      dashboard.title ?? "",
      ...(dashboard.panels ?? []).map((panel) => panel.title ?? ""),
      ...(dashboard.templating?.list ?? []).flatMap((variable) => [
        variable.name ?? "",
        variable.label ?? "",
        variable.query ?? "",
      ]),
    ]
      .join("\n")
      .toLowerCase();
    for (const token of LIVE_MODE_CONTROL_TOKENS) {
      expect(controlBearing, `${spec.file} control-bearing text contains "${token}"`).not.toContain(
        token,
      );
    }
  });

  it("navigates nowhere: no dashboard link, no panel link, no panel url", () => {
    expect(dashboard.links ?? []).toEqual([]);
    for (const panel of dashboard.panels ?? []) {
      expect(panel.links ?? [], `panel "${panel.title ?? ""}"`).toEqual([]);
      expect(panel.url, `panel "${panel.title ?? ""}"`).toBeUndefined();
    }
  });
});

describe("the pending-producer panels", () => {
  const declared = PENDING_PRODUCER_PANELS.map((entry) => `${entry.dashboard}/${entry.panel}`);

  const shipped = LOADED.flatMap(({ spec, dashboard }) =>
    textPanels(dashboard).map((panel) => ({
      key: `${spec.id}/${panel.title ?? ""}`,
      content: panel.options?.content ?? "",
    })),
  );

  it("the shipped set and the declared set match EXACTLY, both directions", () => {
    expect(shipped.map((entry) => entry.key).sort()).toEqual([...declared].sort());
  });

  it("every one states the grammar: a producer AND an owner", () => {
    for (const entry of shipped) {
      expect(entry.content.startsWith(PENDING_PRODUCER_MARKER), entry.key).toBe(true);
      expect(entry.content, entry.key).toContain(PENDING_PRODUCER_OWNER_MARKER);
      const owner = entry.content.split(PENDING_PRODUCER_OWNER_MARKER)[1] ?? "";
      expect(owner.trim().length, `${entry.key} names no owner`).toBeGreaterThan(20);
    }
  });

  it("the panel text matches the declaration in dashboards.ts, word for word", () => {
    for (const entry of PENDING_PRODUCER_PANELS) {
      const panel = shipped.find((candidate) => candidate.key === `${entry.dashboard}/${entry.panel}`);
      expect(panel, `${entry.dashboard}/${entry.panel}`).toBeDefined();
      expect(panel?.content).toContain(entry.producer);
      expect(panel?.content).toContain(entry.owner);
    }
  });

  it("names NO platform metric family — a pending panel binds nothing", () => {
    for (const entry of shipped) {
      for (const family of PLATFORM_METRIC_FAMILIES) {
        expect(entry.content, `${entry.key} binds ${family.name}`).not.toContain(
          `${family.name} `,
        );
      }
    }
  });
});

describe("coverage in the other direction", () => {
  const boundEverywhere = new Set(LOADED.flatMap(({ dashboard }) => allSeries(dashboard)));

  it("EVERY declared platform family appears on at least one dashboard", () => {
    const orphans = PLATFORM_METRIC_FAMILIES.map((family) => family.name).filter(
      (name) => !boundEverywhere.has(name),
    );
    expect(orphans, "declared families no dashboard shows").toEqual([]);
  });

  it("every `recorder_*` series the fidelity dashboard binds is a WP-140 family", () => {
    const { dashboard } = load("fidelity");
    const recorderSeries = allSeries(dashboard).filter((series) => series.startsWith("recorder_"));
    expect(recorderSeries.length).toBeGreaterThan(5);
    for (const series of recorderSeries) {
      expect(recorderMetricFamily(series), series).toBeDefined();
    }
  });
});

describe("the dashboard README", () => {
  const readme = readFileSync(resolve(dashboardDir, "README.md"), "utf8");

  it("carries no production secret name", () => {
    const upper = readme.toUpperCase();
    for (const name of ALL_PRODUCTION_NAMES) {
      expect(upper, `README references ${name}`).not.toContain(name);
    }
  });

  it("lists every dashboard file and every pending panel", () => {
    for (const spec of CONTROL_DASHBOARDS) {
      expect(readme).toContain(spec.file);
    }
    for (const entry of PENDING_PRODUCER_PANELS) {
      expect(readme, `README omits the pending panel "${entry.panel}"`).toContain(entry.panel);
    }
  });

  it("states the composition obligation rather than claiming the trader endpoint exists", () => {
    expect(readme).toContain("does not expose an HTTP health endpoint today");
    // Line-wrapped in the Markdown, so the assertion takes the tail of the
    // sentence rather than a phrase a reflow could split.
    expect(readme).toContain("a claim that it exists");
  });
});
