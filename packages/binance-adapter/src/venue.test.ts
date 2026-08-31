import { CodeStringSchema } from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import { BINANCE_REASON_CODES } from "./incidents.js";
import { takerSideFor } from "./normalize.js";
import {
  BINANCE_DEFAULT_ENDPOINT,
  BINANCE_FRAMING_RULING,
  BINANCE_LIMITS,
  BINANCE_PUBLIC_STREAM_ENDPOINTS,
  BINANCE_RESOLVED,
  BINANCE_SBE_ENDPOINT_HOST,
  BINANCE_UNVERIFIED,
  explainNonPublicEndpoint,
} from "./venue.js";

describe("public endpoint guard", () => {
  it("accepts every documented public market-data endpoint", () => {
    for (const endpoint of BINANCE_PUBLIC_STREAM_ENDPOINTS) {
      expect(explainNonPublicEndpoint(endpoint)).toBeNull();
    }
  });

  it("defaults to the market-data-only endpoint", () => {
    // The venue documents that this host carries market data only and that the
    // user data stream is NOT available from it: the right default for a
    // process that holds no credential.
    expect(BINANCE_DEFAULT_ENDPOINT).toBe("wss://data-stream.binance.vision");
  });

  it("refuses the credential-gated SBE host by name", () => {
    const refusal = explainNonPublicEndpoint(`wss://${BINANCE_SBE_ENDPOINT_HOST}`);
    expect(refusal).toContain("API key");
    expect(refusal).toContain("binary");
  });

  it("fails closed on an unrecognized endpoint", () => {
    expect(explainNonPublicEndpoint("wss://stream.example.test")).toContain(
      "documented public market-data endpoints",
    );
  });
});

describe("documented limits", () => {
  it("records the venue's published numbers", () => {
    expect(BINANCE_LIMITS.maxStreamsPerConnection).toBe(1024);
    expect(BINANCE_LIMITS.maxClientMessagesPerSecond).toBe(5);
    expect(BINANCE_LIMITS.maxConnectionAttemptsPer5Minutes).toBe(300);
    expect(BINANCE_LIMITS.connectionLifetimeMs).toBe(86_400_000);
    expect(BINANCE_LIMITS.serverPingIntervalMs).toBe(20_000);
    expect(BINANCE_LIMITS.serverPongDeadlineMs).toBe(60_000);
  });
});

describe("framing ruling (the ADR-004 §1 open item)", () => {
  it("separates what is verified from what is not", () => {
    expect(BINANCE_FRAMING_RULING.jsonPayloadsOnStreamEndpoint).toBe(true);
    expect(BINANCE_FRAMING_RULING.binaryPathIsCredentialGatedAndExcluded).toBe(true);
    // The frame OPCODE is not documented for the JSON endpoint, so this package
    // must not claim it. If a later phase finds the venue documenting it, this
    // flag flips in the same change that adds the citation.
    expect(BINANCE_FRAMING_RULING.opcodeOnJsonEndpointDocumented).toBe(false);
  });
});

describe("unverified register", () => {
  it("is non-empty and uniquely identified", () => {
    expect(BINANCE_UNVERIFIED.length).toBeGreaterThan(0);
    const ids = BINANCE_UNVERIFIED.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("states a conservative behavior for every entry", () => {
    for (const entry of BINANCE_UNVERIFIED) {
      expect(entry.conservativeBehavior.length).toBeGreaterThan(20);
      expect(entry.documented.length).toBeGreaterThan(20);
    }
  });
});

describe("resolved register", () => {
  it("no longer carries BNC-U5 as an open item", () => {
    // It was open only because the FROZEN CONTRACT's vocabulary was unstated.
    // ADR-014 stated it, so keeping the item open would misreport this package
    // as still guessing.
    const openIds: readonly string[] = BINANCE_UNVERIFIED.map((entry) => entry.id);
    expect(openIds).not.toContain("BNC-U5");
  });

  it("keeps BNC-U5 discoverable, with its authority and its date", () => {
    const entry = BINANCE_RESOLVED.find((candidate) => candidate.id === "BNC-U5");
    if (entry === undefined) {
      throw new Error("BNC-U5 must remain in the resolved register, not vanish");
    }
    expect(entry.closedAt).toBe("2026-08-28");
    // The ruling's date and this package's remediation date are separate facts.
    expect(entry.remediatedAt).toBe("2026-08-30");
    expect(entry.closedBy).toContain("ADR-014");
    expect(entry.closedBy).toContain("m = true → ASK");
    expect(entry.closedBy).toContain("m = false → BID");
    expect(entry.wasOpenBecause.length).toBeGreaterThan(20);
  });

  it("records what changed in this package, not merely that something did", () => {
    const entry = BINANCE_RESOLVED.find((candidate) => candidate.id === "BNC-U5");
    if (entry === undefined) {
      throw new Error("BNC-U5 is missing from the resolved register");
    }
    // The three things ADR-014's §7 follow-up required, each visible in the text.
    expect(entry.whatChanged).toContain("BOOK_SIDE_CONSUMED");
    expect(entry.whatChanged).toContain("DELETED");
    expect(entry.whatChanged).toContain("takerSideConvention");
    // Item 3: the default had to be decided AND stated.
    expect(entry.defaultDecision).toContain("DECIDED");
    // Item 4: the raw venue value survives either way.
    expect(entry.preserved).toContain("buyerIsMaker");
  });

  it("describes the mapping the code actually implements", () => {
    // The register is checked against behavior, so prose and code cannot drift:
    // if `takerSideFor` were inverted, this fails with the register unchanged.
    const entry = BINANCE_RESOLVED.find((candidate) => candidate.id === "BNC-U5");
    if (entry === undefined) {
      throw new Error("BNC-U5 is missing from the resolved register");
    }
    expect(entry.whatChanged).toContain(`m = true → ${takerSideFor(true)}`);
    expect(entry.whatChanged).toContain(`m = false → ${takerSideFor(false)}`);
    expect(takerSideFor(true)).toBe("ASK");
  });

  it("shares no id with the open register", () => {
    const open = new Set<string>(BINANCE_UNVERIFIED.map((entry) => entry.id));
    for (const entry of BINANCE_RESOLVED) {
      expect(open.has(entry.id), `${entry.id} is both open and resolved`).toBe(false);
    }
  });
});

describe("reason codes", () => {
  it("every emitted reason code satisfies the frozen CodeString grammar", () => {
    for (const code of Object.values(BINANCE_REASON_CODES)) {
      expect(CodeStringSchema.safeParse(code).success).toBe(true);
    }
  });

  it("uses a distinct code per condition", () => {
    const codes = Object.values(BINANCE_REASON_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
