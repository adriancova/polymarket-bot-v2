/**
 * The generic renderer's contract: it refuses what it cannot describe.
 */

import { describe, expect, it } from "vitest";

import { renderExpositionFor, type MetricFamilyLike } from "./exposition.js";

const families: readonly MetricFamilyLike[] = [
  { name: "control_first", type: "gauge", help: "First family." },
  { name: "control_second_total", type: "counter", help: "Second family.", labels: ["code"] },
  { name: "control_third", type: "gauge", help: "Third family, never sampled." },
];

describe("renderExpositionFor", () => {
  it("renders HELP/TYPE headers and samples in TABLE order, not sample order", () => {
    expect(
      renderExpositionFor(families, [
        { name: "control_second_total", value: 2, labels: { code: "B" } },
        { name: "control_first", value: 1 },
        { name: "control_second_total", value: 3, labels: { code: "A" } },
      ]),
    ).toBe(
      [
        "# HELP control_first First family.",
        "# TYPE control_first gauge",
        "control_first 1",
        "# HELP control_second_total Second family.",
        "# TYPE control_second_total counter",
        'control_second_total{code="B"} 2',
        'control_second_total{code="A"} 3',
        "",
      ].join("\n"),
    );
  });

  it("OMITS a family with no samples — absence is not zero", () => {
    expect(renderExpositionFor(families, [{ name: "control_first", value: 0 }])).not.toContain(
      "control_third",
    );
  });

  it("renders the empty string when nothing was sampled", () => {
    expect(renderExpositionFor(families, [])).toBe("");
  });

  it("THROWS on a sample whose family the table does not declare", () => {
    expect(() => renderExpositionFor(families, [{ name: "control_ghost", value: 1 }])).toThrow(
      /control_ghost is not declared/u,
    );
  });

  it("THROWS on a label the family does not declare", () => {
    expect(() =>
      renderExpositionFor(families, [
        { name: "control_second_total", value: 1, labels: { unknown: "x" } },
      ]),
    ).toThrow(/does not declare label "unknown"/u);
  });

  it("escapes backslashes, quotes and newlines in label values", () => {
    expect(
      renderExpositionFor(families, [
        { name: "control_second_total", value: 1, labels: { code: 'a"b\\c\nd' } },
      ]),
    ).toContain('control_second_total{code="a\\"b\\\\c\\nd"} 1');
  });

  it("escapes newlines in HELP so a multi-line help string cannot break the format", () => {
    expect(
      renderExpositionFor(
        [{ name: "control_first", type: "gauge", help: "line one\nline two" }],
        [{ name: "control_first", value: 1 }],
      ),
    ).toContain("# HELP control_first line one\\nline two");
  });

  it("renders the non-finite values Prometheus defines", () => {
    const single: readonly MetricFamilyLike[] = [
      { name: "control_first", type: "gauge", help: "First family." },
    ];
    expect(renderExpositionFor(single, [{ name: "control_first", value: Number.NaN }])).toContain(
      "control_first NaN",
    );
    expect(
      renderExpositionFor(single, [{ name: "control_first", value: Number.POSITIVE_INFINITY }]),
    ).toContain("control_first +Inf");
    expect(
      renderExpositionFor(single, [{ name: "control_first", value: Number.NEGATIVE_INFINITY }]),
    ).toContain("control_first -Inf");
  });

  it("does not modify WP-140's recorder renderer: this one takes its table as an argument", () => {
    // A structural statement, asserted rather than claimed: the same samples
    // render against two DIFFERENT tables, which the recorder renderer cannot
    // do because its table is a closure.
    const other: readonly MetricFamilyLike[] = [
      { name: "control_first", type: "gauge", help: "A different table entirely." },
    ];
    expect(renderExpositionFor(other, [{ name: "control_first", value: 1 }])).toContain(
      "A different table entirely.",
    );
    expect(renderExpositionFor(families, [{ name: "control_first", value: 1 }])).toContain(
      "First family.",
    );
  });
});
