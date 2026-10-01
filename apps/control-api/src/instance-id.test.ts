/**
 * The strategy-instance id as a route parameter (`CONTROL-1`, closing `WP-240`
 * r1 L-1 and L-2): TOTAL, and one grammar applied to the DECODED id.
 */

import { describe, expect, it } from "vitest";

import { InMemoryControlAuditLog } from "@polymarket-bot/observability";

import { ControlPlane } from "./control-plane.js";
import { MAX_INSTANCE_ID_LENGTH, instanceIdProblem, readInstanceIdParameter } from "./instance-id.js";

describe("L-1: a malformed percent-escape is a refusal, never a throw", () => {
  it.each(["%", "%E0%A4%A", "%ZZ", "sb-%G1", "%ED%A0%80", "%C0%AF", "%FF"])("refuses %s", (raw) => {
    expect(() => readInstanceIdParameter(raw)).not.toThrow();
    expect(readInstanceIdParameter(raw)).toEqual({
      ok: false,
      detail: "the strategy instance id is not valid percent-encoded UTF-8",
    });
  });

  it("does not echo the caller's bytes in the refusal", () => {
    const result = readInstanceIdParameter("%E0%A4%A-secret-looking-bytes");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).not.toContain("secret-looking-bytes");
  });
});

describe("L-2: the grammar is applied AFTER decoding", () => {
  it.each(["a%2Fb", "a%2fb", "%2F", "%2Fv1%2Frun-state"])("refuses %s, which decodes to a '/'", (raw) => {
    const result = readInstanceIdParameter(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain("'/'");
  });

  it.each(["%00", "sb%0A1", "sb%7F", "sb%C2%85"])("refuses %s, which decodes to a control character", (raw) => {
    const result = readInstanceIdParameter(raw);
    expect(result).toEqual({ ok: false, detail: "the strategy instance id contains a control character" });
  });

  it("refuses an id longer than the scopeRef bound, and accepts one exactly at it", () => {
    expect(readInstanceIdParameter("x".repeat(MAX_INSTANCE_ID_LENGTH)).ok).toBe(true);
    expect(readInstanceIdParameter("x".repeat(MAX_INSTANCE_ID_LENGTH + 1)).ok).toBe(false);
    expect(MAX_INSTANCE_ID_LENGTH).toBe(256);
  });

  it("refuses an id that decodes to nothing", () => {
    expect(instanceIdProblem("")).toBe("the strategy instance id is empty");
  });

  it.each([
    ["sb-1", "sb-1"],
    ["sb%20one", "sb one"],
    ["01930000-0000-7000-8000-000000000001", "01930000-0000-7000-8000-000000000001"],
    ["%252F", "%2F"],
    ["caf%C3%A9", "café"],
  ])("ACCEPTS %s as %s — nothing else is narrowed", (raw, decoded) => {
    expect(readInstanceIdParameter(raw)).toEqual({ ok: true, value: decoded });
  });
});

describe("register() applies the SAME grammar: a known instance is an addressable one", () => {
  const plane = (): ControlPlane =>
    new ControlPlane({
      audit: new InMemoryControlAuditLog(8),
      runMode: "PAPER",
      maximumRunMode: "PAPER",
      repositoryMaximumRunMode: "PAPER",
    });

  it.each(["", "a/b", "sb\u0000", "x".repeat(MAX_INSTANCE_ID_LENGTH + 1)])(
    "THROWS at composition for %j rather than registering an instance no route can address",
    (id) => {
      const control = plane();
      expect(() => control.register(id, "2026-10-01T00:00:00.000Z")).toThrow(RangeError);
      expect(control.strategies()).toEqual([]);
    },
  );

  it("registers an id the route can carry, a space included", () => {
    const control = plane();
    control.register("sb one", "2026-10-01T00:00:00.000Z");
    expect(control.strategies().map((entry) => entry.instanceId)).toEqual(["sb one"]);
  });
});
