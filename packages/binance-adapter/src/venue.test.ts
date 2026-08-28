import { CodeStringSchema } from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import { BINANCE_REASON_CODES } from "./incidents.js";
import {
  BINANCE_DEFAULT_ENDPOINT,
  BINANCE_FRAMING_RULING,
  BINANCE_LIMITS,
  BINANCE_PUBLIC_STREAM_ENDPOINTS,
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
