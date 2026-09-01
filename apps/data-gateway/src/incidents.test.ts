import { describe, expect, it } from "vitest";

import { IncidentRegistry } from "./incidents.js";

const AT_MS = 1_772_400_000_000;

describe("IncidentRegistry", () => {
  // ROUND-1 REVIEW L5: the `(scope, reasonCode)` key separator is a NUL, and
  // round 1 wrote it as a LITERAL NUL BYTE in the source — which made Git
  // classify the module as binary and hide its diff from review. The escape
  // that replaced it produces the identical runtime string, and this pins the
  // runtime property that made a NUL the right separator in the first place:
  // no printable delimiter can be forged out of a scope or a reason code, so
  // two distinct pairs can never share a key. Under a `:` separator the two
  // pairs below collide and the second incident would be suppressed as a
  // repeat of the first — a silently dropped incident.
  it("cannot collide two distinct (scope, reasonCode) pairs on one key", () => {
    const registry = new IncidentRegistry();
    const first = registry.open({
      scope: "feed",
      reasonCode: "A:B",
      severity: "NOTIFY",
      detail: "one",
      atMs: AT_MS,
    });
    const second = registry.open({
      scope: "feed:A",
      reasonCode: "B",
      severity: "NOTIFY",
      detail: "two",
      atMs: AT_MS,
    });
    expect(first.opened).toBe(true);
    expect(second.opened).toBe(true);
    expect(first.incidentId).not.toBe(second.incidentId);
    expect(registry.metrics().incidentsOpened).toBe(2);
    expect(registry.metrics().repeatsSuppressed).toBe(0);
    // And each key is independently addressable afterwards.
    expect(registry.isOpen("feed", "A:B")).toBe(true);
    expect(registry.isOpen("feed:A", "B")).toBe(true);
    registry.markClosed("feed", "A:B");
    expect(registry.isOpen("feed", "A:B")).toBe(false);
    expect(registry.isOpen("feed:A", "B")).toBe(true);
  });

  it("opens an incident with a complete internal-source draft", () => {
    const registry = new IncidentRegistry();
    const outcome = registry.open({
      scope: "binance-reference",
      reasonCode: "GATEWAY_WAL_FRAME_REFUSED",
      severity: "PAGE",
      detail: "queue overflow",
      atMs: AT_MS,
      feedId: "binance-reference",
    });
    expect(outcome.opened).toBe(true);
    if (!outcome.opened) return;
    expect(outcome.draft.eventType).toBe("DataQualityIncidentOpened");
    expect(outcome.draft.source).toBe("internal");
    const payload = outcome.draft.payload as { incidentId: string; reasonCode: string };
    expect(payload.incidentId).toBe(outcome.incidentId);
    expect(payload.reasonCode).toBe("GATEWAY_WAL_FRAME_REFUSED");
  });

  it("suppresses (and counts) repeats while the incident is open, and reopens after close", () => {
    const registry = new IncidentRegistry();
    const first = registry.open({
      scope: "feed",
      reasonCode: "R",
      severity: "NOTIFY",
      detail: "d",
      atMs: AT_MS,
    });
    expect(first.opened).toBe(true);
    const repeat = registry.open({
      scope: "feed",
      reasonCode: "R",
      severity: "NOTIFY",
      detail: "d again",
      atMs: AT_MS + 1,
    });
    expect(repeat.opened).toBe(false);
    if (repeat.opened) return;
    expect(repeat.repeatCount).toBe(1);
    expect(registry.metrics().repeatsSuppressed).toBe(1);

    registry.markClosed("feed", "R");
    const reopened = registry.open({
      scope: "feed",
      reasonCode: "R",
      severity: "NOTIFY",
      detail: "recurred",
      atMs: AT_MS + 2,
    });
    expect(reopened.opened).toBe(true);
    if (!reopened.opened) return;
    expect(reopened.incidentId).not.toBe(first.opened ? first.incidentId : "");
  });

  it("mints unique incident ids per open", () => {
    const registry = new IncidentRegistry();
    const ids = new Set<string>();
    for (let index = 0; index < 20; index += 1) {
      const outcome = registry.open({
        scope: `scope-${String(index)}`,
        reasonCode: "R",
        severity: "LOG",
        detail: "d",
        atMs: AT_MS,
      });
      expect(outcome.opened).toBe(true);
      ids.add(outcome.incidentId);
    }
    expect(ids.size).toBe(20);
  });

  // §8.3: every queue is bounded, including this registry's key memory. The
  // eviction prefers closed keys, so dedup for open incidents survives.
  it("bounds tracked keys, evicting closed keys first", () => {
    const registry = new IncidentRegistry({ maxTrackedKeys: 3 });
    registry.open({ scope: "a", reasonCode: "R", severity: "LOG", detail: "", atMs: AT_MS });
    registry.markClosed("a", "R");
    registry.open({ scope: "b", reasonCode: "R", severity: "LOG", detail: "", atMs: AT_MS });
    registry.open({ scope: "c", reasonCode: "R", severity: "LOG", detail: "", atMs: AT_MS });
    registry.open({ scope: "d", reasonCode: "R", severity: "LOG", detail: "", atMs: AT_MS });
    const metrics = registry.metrics();
    expect(metrics.trackedKeys).toBe(3);
    expect(metrics.evictedKeys).toBe(1);
    // The OPEN keys kept their dedup: a repeat on "b" is still suppressed.
    const repeat = registry.open({
      scope: "b",
      reasonCode: "R",
      severity: "LOG",
      detail: "",
      atMs: AT_MS,
    });
    expect(repeat.opened).toBe(false);
  });

  it("truncates over-long detail to the domain bound", () => {
    const registry = new IncidentRegistry();
    const outcome = registry.open({
      scope: "feed",
      reasonCode: "R",
      severity: "LOG",
      detail: "x".repeat(5000),
      atMs: AT_MS,
    });
    expect(outcome.opened).toBe(true);
    if (!outcome.opened) return;
    const payload = outcome.draft.payload as { detail?: string };
    expect(payload.detail?.length).toBe(2000);
  });
});
