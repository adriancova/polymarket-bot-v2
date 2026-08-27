import { describe, expect, it } from "vitest";

import { EventBusCheckpointError, EventBusUnavailableError } from "../errors.js";
import {
  assertPositionAccepted,
  isAcceptedPosition,
  parsePositionJudgement,
} from "./position.js";
import { ACCEPTED_POSITION_VERDICTS, REFUSED_POSITION_VERDICTS } from "./scripts.js";

const UNAVAILABLE = new Set(["origin-unreadable", "stream-key-type", "counter-unreadable"]);

describe("parsePositionJudgement", () => {
  it("reads a verdict and its detail", () => {
    expect(parsePositionJudgement(["exact", ""])).toStrictEqual({ verdict: "exact", detail: "" });
    expect(parsePositionJudgement(["ordinal-mismatch", "7"])).toStrictEqual({
      verdict: "ordinal-mismatch",
      detail: "7",
    });
  });

  it("refuses a reply it cannot read rather than assuming acceptance", () => {
    expect(() => parsePositionJudgement(null)).toThrow(EventBusUnavailableError);
    expect(() => parsePositionJudgement("exact")).toThrow(EventBusUnavailableError);
    expect(() => parsePositionJudgement([])).toThrow(EventBusUnavailableError);
    expect(() => parsePositionJudgement([1, ""])).toThrow(EventBusUnavailableError);
  });
});

describe("assertPositionAccepted", () => {
  it("accepts exactly the verdicts that name a position the stream holds or held", () => {
    for (const verdict of ACCEPTED_POSITION_VERDICTS) {
      expect(isAcceptedPosition(verdict)).toBe(true);
      expect(() => {
        assertPositionAccepted({ verdict, detail: "" }, { stream: "market" });
      }).not.toThrow();
    }
  });

  it("refuses every other verdict, and says which position problem it was", () => {
    for (const verdict of REFUSED_POSITION_VERDICTS) {
      expect(isAcceptedPosition(verdict)).toBe(false);
      const expected = UNAVAILABLE.has(verdict)
        ? EventBusUnavailableError
        : EventBusCheckpointError;

      expect(() => {
        assertPositionAccepted({ verdict, detail: "detail" }, { stream: "market" });
      }).toThrow(expected);

      try {
        assertPositionAccepted({ verdict, detail: "detail" }, { stream: "market" });
        throw new Error(`expected \`${verdict}\` to be refused`);
      } catch (error) {
        if (!(error instanceof EventBusCheckpointError || error instanceof EventBusUnavailableError)) {
          throw error;
        }
        expect(error.details["verdict"]).toBe(verdict);
        expect(error.details["stream"]).toBe("market");
        // The message must explain the refusal, not merely name a code.
        expect(error.message.length).toBeGreaterThan(verdict.length + 20);
      }
    }
  });

  it("treats a verdict it has never heard of as a refusal", () => {
    expect(() => {
      assertPositionAccepted(
        { verdict: "something-a-newer-server-said" as never, detail: "" },
        { stream: "market" },
      );
    }).toThrow(EventBusCheckpointError);
  });
});
