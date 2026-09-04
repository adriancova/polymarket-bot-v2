/**
 * The hand-rolled input validator: strict keys, explicit config (no
 * defaults), grammar checks, and the temporal no-future rule.
 */

import { describe, expect, it } from "vitest";

import { materializeInput } from "./materialize.js";
import { validateFeatureInput } from "./inputs.js";
import { fixtureInput } from "./testing/fixture.js";

/** Materializes then validates, the same path the engine takes. */
function validate(input: unknown): ReturnType<typeof validateFeatureInput> {
  const read = materializeInput(input, "input");
  if (!read.ok) throw new Error("fixture did not materialize");
  return validateFeatureInput(read.value);
}

function mutate(edit: (input: Record<string, unknown>) => void): ReturnType<typeof validateFeatureInput> {
  const input = fixtureInput();
  edit(input);
  return validate(input);
}

function expectProblem(
  result: ReturnType<typeof validateFeatureInput>,
  pathFragment: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.problems.map((problem) => problem.path).join(" | ")).toContain(pathFragment);
}

describe("validateFeatureInput", () => {
  it("accepts the complete fixture and derives epoch milliseconds", () => {
    const result = validate(fixtureInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.asOfEpochMs).toBe(Date.UTC(2026, 8, 3, 12, 0, 0));
    expect(result.input.book.parsed.bids).toHaveLength(3);
    expect(result.input.trades?.window).toHaveLength(4);
    expect(result.input.reference.binance?.trades).toHaveLength(4);
  });

  it("accepts a minimal input (only required sections)", () => {
    const result = validate({
      subject: (fixtureInput() as { subject: unknown }).subject,
      asOf: "2026-09-03T12:00:00Z",
      trigger: (fixtureInput() as { trigger: unknown }).trigger,
      config: (fixtureInput() as { config: unknown }).config,
      book: (fixtureInput() as { book: unknown }).book,
      quality: { activeIncidents: [] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.trades).toBeUndefined();
    expect(result.input.reference).toEqual({});
    expect(result.input.lifecycle).toBeUndefined();
  });

  it("refuses an unknown key anywhere (strict contract)", () => {
    expectProblem(
      mutate((input) => {
        input["extra"] = 1;
      }),
      "input.extra",
    );
    expectProblem(
      mutate((input) => {
        (input["config"] as Record<string, unknown>)["surprise"] = true;
      }),
      "input.config.surprise",
    );
  });

  it("refuses a missing required section rather than defaulting it", () => {
    for (const key of ["subject", "asOf", "trigger", "config", "book", "quality"]) {
      const result = mutate((input) => {
        delete input[key];
      });
      expect(result.ok, key).toBe(false);
    }
  });

  it("refuses identifier-grammar violations", () => {
    expectProblem(
      mutate((input) => {
        (input["subject"] as Record<string, unknown>)["internalMarketId"] = "018F4D2E-0000-7000-8000-000000000001";
      }),
      "input.subject.internalMarketId",
    );
    expectProblem(
      mutate((input) => {
        (input["subject"] as Record<string, unknown>)["tokenId"] = "0123";
      }),
      "input.subject.tokenId",
    );
    expectProblem(
      mutate((input) => {
        (input["trigger"] as Record<string, unknown>)["gatewayEpoch"] = "not-a-uuid";
      }),
      "input.trigger.gatewayEpoch",
    );
    expectProblem(
      mutate((input) => {
        (input["trigger"] as Record<string, unknown>)["ingestSeq"] = "007";
      }),
      "input.trigger.ingestSeq",
    );
  });

  it("refuses config violations: empty lists, non-ascending entries, lambda bounds", () => {
    expectProblem(
      mutate((input) => {
        (input["config"] as Record<string, unknown>)["depthLevels"] = [];
      }),
      "input.config.depthLevels",
    );
    expectProblem(
      mutate((input) => {
        (input["config"] as Record<string, unknown>)["depthLevels"] = [5, 2];
      }),
      "input.config.depthLevels[1]",
    );
    expectProblem(
      mutate((input) => {
        (input["config"] as Record<string, unknown>)["executableShares"] = ["50", "50"];
      }),
      "input.config.executableShares[1]",
    );
    expectProblem(
      mutate((input) => {
        (input["config"] as Record<string, unknown>)["executableShares"] = ["0.10"];
      }),
      "input.config.executableShares[0]",
    );
    expectProblem(
      mutate((input) => {
        (input["config"] as Record<string, unknown>)["ewmaLambda"] = "1";
      }),
      "input.config.ewmaLambda",
    );
    expectProblem(
      mutate((input) => {
        (input["config"] as Record<string, unknown>)["ewmaLambda"] = "0";
      }),
      "input.config.ewmaLambda",
    );
    expectProblem(
      mutate((input) => {
        (input["config"] as Record<string, unknown>)["primaryReferenceVenue"] = "kraken";
      }),
      "input.config.primaryReferenceVenue",
    );
    expectProblem(
      mutate((input) => {
        (input["config"] as Record<string, unknown>)["tradeWindowMs"] = 0;
      }),
      "input.config.tradeWindowMs",
    );
    expectProblem(
      mutate((input) => {
        (input["config"] as Record<string, unknown>)["tradeWindowMs"] = 60_000.5;
      }),
      "input.config.tradeWindowMs",
    );
  });

  it("refuses economic values as numbers (§7.3: decimal strings only)", () => {
    expectProblem(
      mutate((input) => {
        const trades = input["trades"] as { window: Record<string, unknown>[] };
        const first = trades.window[1];
        if (first !== undefined) first["price"] = 0.5;
      }),
      "input.trades.window[1].price",
    );
    expectProblem(
      mutate((input) => {
        (input["config"] as Record<string, unknown>)["executableShares"] = [50];
      }),
      "input.config.executableShares[0]",
    );
  });

  it("refuses non-canonical decimal spellings rather than normalizing", () => {
    expectProblem(
      mutate((input) => {
        const trades = input["trades"] as { window: Record<string, unknown>[] };
        const first = trades.window[1];
        if (first !== undefined) first["price"] = "0.50";
      }),
      "input.trades.window[1].price",
    );
  });

  it("refuses information from the future (§6 invariant 15)", () => {
    expectProblem(
      mutate((input) => {
        const trades = input["trades"] as { window: Record<string, unknown>[] };
        trades.window.push({ price: "0.5", size: "1", observedAt: "2026-09-03T12:00:00.001Z" });
      }),
      "observedAt",
    );
    expectProblem(
      mutate((input) => {
        const reference = input["reference"] as { binance: { trades: Record<string, unknown>[] } };
        reference.binance.trades.push({ price: "1", observedAt: "2026-09-03T12:00:01Z" });
      }),
      "observedAt",
    );
    expectProblem(
      mutate((input) => {
        const reference = input["reference"] as { chainlink: { twaps: Record<string, unknown>[] } };
        reference.chainlink.twaps.push({
          feedId: "btc.usd",
          value: "1",
          windowSeconds: 30,
          windowEndAt: "2026-09-03T12:00:00.500Z",
        });
      }),
      "windowEndAt",
    );
  });

  it("allows a feed stamp AFTER asOf (diagnostic; the age is negative, reported as-is)", () => {
    const result = mutate((input) => {
      (input["book"] as Record<string, unknown>)["lastEventAt"] = "2026-09-03T12:00:01Z";
    });
    expect(result.ok).toBe(true);
  });

  it("refuses out-of-order series and windows", () => {
    expectProblem(
      mutate((input) => {
        const trades = input["trades"] as { window: unknown[] };
        trades.window.reverse();
      }),
      "observedAt",
    );
    expectProblem(
      mutate((input) => {
        const reference = input["reference"] as { binance: { trades: unknown[] } };
        reference.binance.trades.reverse();
      }),
      "observedAt",
    );
  });

  it("refuses duplicate incident ids and duplicate TWAP observations", () => {
    expectProblem(
      mutate((input) => {
        const quality = input["quality"] as { activeIncidents: Record<string, unknown>[] };
        quality.activeIncidents.push({ incidentId: "inc-1", reasonCode: "OTHER", severity: "LOG" });
      }),
      "incidentId",
    );
    expectProblem(
      mutate((input) => {
        const reference = input["reference"] as { chainlink: { twaps: Record<string, unknown>[] } };
        reference.chainlink.twaps.push({
          feedId: "btc.usd",
          value: "999",
          windowSeconds: 30,
          windowEndAt: "2026-09-03T11:59:30Z",
        });
      }),
      "twaps",
    );
  });

  it("refuses a close before the open", () => {
    expectProblem(
      mutate((input) => {
        (input["lifecycle"] as Record<string, unknown>)["closesAt"] = "2026-09-03T11:00:00Z";
      }),
      "input.lifecycle.closesAt",
    );
  });

  it("classifies timestamp problems as TIMESTAMP", () => {
    const result = mutate((input) => {
      input["asOf"] = "2026-09-03T12:00:00+00:00";
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("TIMESTAMP");
  });

  it("classifies a subject/book identity disagreement as SUBJECT_MISMATCH", () => {
    const result = mutate((input) => {
      (input["subject"] as Record<string, unknown>)["tokenId"] = "999";
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("SUBJECT_MISMATCH");
  });

  it("refuses an incident severity outside the §14.4 vocabulary", () => {
    expectProblem(
      mutate((input) => {
        const quality = input["quality"] as { activeIncidents: Record<string, unknown>[] };
        const first = quality.activeIncidents[0];
        if (first !== undefined) first["severity"] = "CRITICAL";
      }),
      "severity",
    );
  });
});
