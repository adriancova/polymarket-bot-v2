/**
 * Prometheus text-exposition rendering, generic over a metric-family table.
 *
 * ## Why this is not `recorder/render.ts`
 *
 * `WP-140`'s renderer is bound to `RECORDER_METRIC_FAMILIES` by closure: it
 * looks a sample's family up in that one table and iterates that one table for
 * render order. It is correct and it is under test; it is also not reusable for
 * a second family table, which is exactly what `WP-240` needs.
 *
 * This module is the same rendering CONTRACT parameterised by the table. It
 * does not modify `recorder/render.ts` and does not change a single recorder
 * test — `WP-240`'s grant is to extend `packages/observability`, never to break
 * what is there. **Collapsing `recorder/render.ts` onto this function is
 * recorded as a follow-up** for a later `packages/observability` grant, because
 * doing it here would put a refactor of `WP-140`'s shipped exporter inside a
 * package whose review is about a control API.
 *
 * ## The invariant, restated
 *
 * A sample whose family is not in the supplied table **throws**, and a label
 * the family does not declare **throws**. Silently emitting an undeclared
 * series is how a dashboard binds to a name nobody owns; silently dropping one
 * is how a panel goes blank without a failure. Neither is available here.
 *
 * Families with no samples are omitted entirely, so absence stays distinguishable
 * from zero.
 */

export interface MetricFamilyLike {
  readonly name: string;
  readonly type: string;
  readonly help: string;
  readonly labels?: readonly string[];
}

export type MetricLabels = Readonly<Record<string, string>>;

export interface MetricSample {
  readonly name: string;
  readonly value: number;
  readonly labels?: MetricLabels;
}

function escapeHelp(text: string): string {
  return text.replace(/\\/gu, "\\\\").replace(/\n/gu, "\\n");
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"').replace(/\n/gu, "\\n");
}

function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

function renderSampleLine(family: MetricFamilyLike, sample: MetricSample): string {
  const labels = sample.labels ?? {};
  const keys = Object.keys(labels);
  const declared = family.labels ?? [];
  for (const key of keys) {
    if (!declared.includes(key)) {
      throw new Error(`metric ${family.name} does not declare label "${key}"`);
    }
  }
  if (keys.length === 0) return `${family.name} ${formatValue(sample.value)}`;
  const rendered = keys
    .map((key) => `${key}="${escapeLabelValue(labels[key] ?? "")}"`)
    .join(",");
  return `${family.name}{${rendered}} ${formatValue(sample.value)}`;
}

/**
 * Renders samples as exposition text, in table order, with HELP/TYPE headers.
 *
 * TOTAL over the table it is given; NOT total over its samples, by design (see
 * the module header — an undeclared family is a programming error the caller
 * must see, not a line to skip).
 */
export function renderExpositionFor(
  families: readonly MetricFamilyLike[],
  samples: readonly MetricSample[],
): string {
  const byName = new Map<string, MetricFamilyLike>(
    families.map((entry) => [entry.name, entry]),
  );
  const bucketed = new Map<string, MetricSample[]>();
  for (const sample of samples) {
    if (!byName.has(sample.name)) {
      throw new Error(`metric ${sample.name} is not declared in the supplied family table`);
    }
    const bucket = bucketed.get(sample.name);
    if (bucket === undefined) bucketed.set(sample.name, [sample]);
    else bucket.push(sample);
  }

  const lines: string[] = [];
  for (const family of families) {
    const bucket = bucketed.get(family.name);
    if (bucket === undefined) continue;
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    for (const sample of bucket) lines.push(renderSampleLine(family, sample));
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
