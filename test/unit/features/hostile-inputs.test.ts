/**
 * The recorded cross-package schema risk, driven against the feature engine:
 * prototype ADOPTION, field LOSS, defeated defaults, the inherited
 * format-check kill switch, and descriptor poisoning. The engine's remedy is
 * structural (materialize prototype-free, hand-validate, no schema library),
 * so every attack here must land as a clean refusal or a clean computation —
 * never as an adopted value, a lost field, or an escaped throw.
 *
 * Pollution hygiene: every test that touches `Object.prototype` captures its
 * observations as PRIMITIVES inside the polluted region and asserts after
 * cleanup, because the assertion library itself is not pollution-proof.
 */

import { describe, expect, it } from "vitest";

import { computeFeatureSnapshot } from "../../../packages/features/src/index.js";
import { validInput } from "./fixtures.js";

function withPollution<T>(pollute: () => void, run: () => T, cleanup: () => void): T {
  pollute();
  try {
    return run();
  } finally {
    cleanup();
  }
}

describe("prototype pollution against the input boundary", () => {
  it("does NOT adopt an inherited optional section: recent_trades stays INPUT_MISSING", () => {
    const input = validInput();
    delete input["trades"];
    const observed = withPollution(
      () => {
        (Object.prototype as Record<string, unknown>)["trades"] = {
          lastEventAt: "2026-09-03T11:59:58Z",
          window: [{ price: "0.99", size: "1000000", takerSide: "BID", observedAt: "2026-09-03T11:59:59Z" }],
        };
      },
      () => {
        const result = computeFeatureSnapshot(input);
        if (!result.ok) return `refused:${result.refusal.code}`;
        const entry = result.snapshot.features.find((feature) => feature.id === "polymarket.recent_trades");
        return `${entry?.status ?? "?"}:${entry?.status === "ABSENT" ? entry.reason ?? "?" : "?"}`;
      },
      () => {
        delete (Object.prototype as Record<string, unknown>)["trades"];
      },
    );
    expect(observed).toBe("ABSENT:INPUT_MISSING");
  });

  it("does NOT adopt an inherited lifecycle section: the features stay ABSENT", () => {
    const input = validInput();
    delete input["lifecycle"];
    const observed = withPollution(
      () => {
        (Object.prototype as Record<string, unknown>)["lifecycle"] = {
          openedAt: "2026-09-03T00:00:00Z",
          closesAt: "2026-09-03T23:00:00Z",
        };
      },
      () => {
        const result = computeFeatureSnapshot(input);
        if (!result.ok) return `refused:${result.refusal.code}`;
        const entry = result.snapshot.features.find((feature) => feature.id === "lifecycle.time_to_close_ms");
        return entry?.status ?? "?";
      },
      () => {
        delete (Object.prototype as Record<string, unknown>)["lifecycle"];
      },
    );
    expect(observed).toBe("ABSENT");
  });

  it("format checks still run under the inherited skipChecks kill switch", () => {
    // The recorded zod hazard: one inherited parse-context flag disables ALL
    // format checks repo-wide. This engine runs no zod, so a malformed UUID
    // must STILL refuse with the flag present.
    const input = validInput();
    (input["trigger"] as Record<string, unknown>)["gatewayEpoch"] = "not-a-uuid";
    const observed = withPollution(
      () => {
        (Object.prototype as Record<string, unknown>)["skipChecks"] = true;
        (Object.prototype as Record<string, unknown>)["skipFormatChecks"] = true;
      },
      () => {
        const result = computeFeatureSnapshot(input);
        return result.ok ? "ACCEPTED" : `refused:${result.refusal.code}`;
      },
      () => {
        delete (Object.prototype as Record<string, unknown>)["skipChecks"];
        delete (Object.prototype as Record<string, unknown>)["skipFormatChecks"];
      },
    );
    expect(observed).toBe("refused:FEATURES_INPUT_INVALID");
  });

  it("computes an untouched fixture identically under heavy ambient pollution", () => {
    const clean = computeFeatureSnapshot(validInput());
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    const observed = withPollution(
      () => {
        for (const name of ["when", "values", "fallback", "message", "path", "input", "deferred", "optional", "ok", "status", "reason"]) {
          (Object.prototype as Record<string, unknown>)[name] = `polluted-${name}`;
        }
      },
      () => {
        const result = computeFeatureSnapshot(validInput());
        if (!result.ok) return `refused:${result.refusal.code}`;
        return result.serialization === clean.serialization && result.snapshot.contentAddress === clean.snapshot.contentAddress
          ? "IDENTICAL"
          : "DIVERGED";
      },
      () => {
        for (const name of ["when", "values", "fallback", "message", "path", "input", "deferred", "optional", "ok", "status", "reason"]) {
          delete (Object.prototype as Record<string, unknown>)[name];
        }
      },
    );
    expect(observed).toBe("IDENTICAL");
  });

  it("refuses cleanly (no escaped throw) when descriptor fields are poisoned via accessors", () => {
    // The WP-180 round-8 hazard: inherited get/set on Object.prototype makes
    // every object-literal property descriptor invalid. The engine builds
    // descriptors prototype-free, so both computation and refusal must
    // complete without a TypeError escaping.
    const good = validInput();
    const bad = validInput();
    (bad["config"] as Record<string, unknown>)["depthLevels"] = [];
    const observed = withPollution(
      () => {
        Object.defineProperty(Object.prototype, "get", {
          configurable: true,
          get() {
            return "1000";
          },
        });
        Object.defineProperty(Object.prototype, "set", {
          configurable: true,
          get() {
            return () => undefined;
          },
        });
      },
      () => {
        try {
          const okResult = computeFeatureSnapshot(good);
          const badResult = computeFeatureSnapshot(bad);
          return `${okResult.ok ? "ok" : `refused:${okResult.refusal.code}`}|${badResult.ok ? "ok" : `refused:${badResult.refusal.code}`}`;
        } catch (cause) {
          return `THREW:${cause instanceof Error ? cause.message : "?"}`;
        }
      },
      () => {
        delete (Object.prototype as Record<string, unknown>)["get"];
        delete (Object.prototype as Record<string, unknown>)["set"];
      },
    );
    expect(observed).toBe("ok|refused:FEATURES_INPUT_INVALID");
  });

  it("a null-prototype input computes identically to an ordinary one", () => {
    function stripPrototypes(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(stripPrototypes);
      if (value !== null && typeof value === "object") {
        const out = Object.create(null) as Record<string, unknown>;
        for (const key of Object.keys(value)) {
          out[key] = stripPrototypes((value as Record<string, unknown>)[key]);
        }
        return out;
      }
      return value;
    }
    const ordinary = computeFeatureSnapshot(validInput());
    const stripped = computeFeatureSnapshot(stripPrototypes(validInput()));
    expect(ordinary.ok).toBe(true);
    expect(stripped.ok).toBe(true);
    if (!ordinary.ok || !stripped.ok) return;
    expect(stripped.serialization).toBe(ordinary.serialization);
  });

  it("the snapshot's own absent fields stay absent under later pollution (prototype-free output)", () => {
    const result = computeFeatureSnapshot(validInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const midpoint = result.snapshot.features.find((feature) => feature.id === "polymarket.midpoint");
    expect(midpoint).toBeDefined();
    const observed = withPollution(
      () => {
        (Object.prototype as Record<string, unknown>)["reason"] = "ADOPTED_REASON";
        (Object.prototype as Record<string, unknown>)["detail"] = "ADOPTED_DETAIL";
      },
      () => `${String((midpoint as unknown as Record<string, unknown>)["reason"])}|${String((midpoint as unknown as Record<string, unknown>)["detail"])}`,
      () => {
        delete (Object.prototype as Record<string, unknown>)["reason"];
        delete (Object.prototype as Record<string, unknown>)["detail"];
      },
    );
    // An OK entry has no reason/detail; with a prototype they would read as
    // the polluted values. The output tree has NO prototype, so they stay
    // absent.
    expect(observed).toBe("undefined|undefined");
  });
});
