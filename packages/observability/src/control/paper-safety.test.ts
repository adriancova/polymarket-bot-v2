/**
 * The shared PAPER safety vocabulary and its scanner.
 *
 * The scanner is pure over the record it is GIVEN — nothing here touches a real
 * environment — so a test cannot accidentally prove the check by arranging the
 * very thing it is meant to detect.
 */

import { describe, expect, it } from "vitest";

import {
  ALL_PRODUCTION_NAMES,
  BUILDER_ATTRIBUTION_NAMES,
  CREDENTIAL_NAME_PATTERNS,
  LIVE_MODE_CONTROL_TOKENS,
  PRODUCTION_ACCOUNT_NAMES,
  PRODUCTION_SECRET_NAMES,
  productionNamesInText,
  scanEnvironmentForProductionNames,
} from "./paper-safety.js";

const codes = (env: Readonly<Record<string, string | undefined>>): readonly string[] =>
  scanEnvironmentForProductionNames(env).map((finding) => finding.code);

describe("the enumerated names", () => {
  it("are frozen, non-empty and unique", () => {
    for (const list of [
      PRODUCTION_SECRET_NAMES,
      PRODUCTION_ACCOUNT_NAMES,
      BUILDER_ATTRIBUTION_NAMES,
      CREDENTIAL_NAME_PATTERNS,
      LIVE_MODE_CONTROL_TOKENS,
    ]) {
      expect(Object.isFrozen(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it("concatenate into ALL_PRODUCTION_NAMES with no overlap between the three classes", () => {
    expect([...ALL_PRODUCTION_NAMES]).toEqual([
      ...PRODUCTION_SECRET_NAMES,
      ...PRODUCTION_ACCOUNT_NAMES,
      ...BUILDER_ATTRIBUTION_NAMES,
    ]);
    expect(new Set(ALL_PRODUCTION_NAMES).size).toBe(ALL_PRODUCTION_NAMES.length);
  });
});

describe("scanEnvironmentForProductionNames", () => {
  it("passes a clean paper environment", () => {
    expect(
      codes({
        RUN_MODE: "PAPER",
        MAX_RUN_MODE: "PAPER",
        CONTROL_API_BIND_HOST: "127.0.0.1",
      }),
    ).toEqual([]);
  });

  it("REFUSES an enumerated secret name even when its value is empty", () => {
    // §15 is about the NAME. An exported-but-empty POLYMARKET_PRIVATE_KEY is a
    // deployment one edit away from exporting the real one.
    expect(codes({ POLYMARKET_PRIVATE_KEY: "" })).toEqual([
      "PAPER_PRODUCTION_SECRET_NAME_PRESENT",
    ]);
    expect(codes({ POLYMARKET_PRIVATE_KEY: undefined })).toEqual([
      "PAPER_PRODUCTION_SECRET_NAME_PRESENT",
    ]);
  });

  it("REFUSES a deployment-prefixed spelling of an enumerated name", () => {
    expect(codes({ PROD_POLYMARKET_PRIVATE_KEY: "x" })).toEqual([
      "PAPER_PRODUCTION_SECRET_NAME_PRESENT",
    ]);
    expect(codes({ staging_poly_api_key: "x" })).toEqual([
      "PAPER_PRODUCTION_SECRET_NAME_PRESENT",
    ]);
  });

  it("REFUSES an account-identifying name under its own code (ADR-010 §3 rule 1)", () => {
    expect(codes({ POLYMARKET_WALLET_ADDRESS: "0x0" })).toEqual([
      "PAPER_PRODUCTION_ACCOUNT_NAME_PRESENT",
    ]);
  });

  it("REFUSES public builder attribution without calling it a credential (rule 2)", () => {
    const findings = scanEnvironmentForProductionNames({ POLYMARKET_BUILDER_CODE: "abc" });
    expect(findings.map((finding) => finding.code)).toEqual([
      "PAPER_BUILDER_ATTRIBUTION_PRESENT",
    ]);
    expect(findings[0]?.detail).toContain("PUBLIC builder attribution and not a credential");
  });

  it("REFUSES a credential-shaped name nobody enumerated, but only with a value", () => {
    expect(codes({ PROD_SIGNER_KEY: "material" })).toEqual([
      "PAPER_CREDENTIAL_SHAPED_NAME_PRESENT",
    ]);
    expect(codes({ KEYSTORE_PATH: "" })).toEqual([]);
    expect(codes({ KEYSTORE_PATH: undefined })).toEqual([]);
  });

  it("does not double-report a name both lists match", () => {
    expect(codes({ POLYMARKET_PRIVATE_KEY: "material" })).toEqual([
      "PAPER_PRODUCTION_SECRET_NAME_PRESENT",
    ]);
  });

  it("is TOTAL: it reports EVERY violation, not the first", () => {
    expect(
      [
        ...codes({
          POLYMARKET_PRIVATE_KEY: "a",
          POLY_ADDRESS: "b",
          POLYMARKET_BUILDER_CODE: "c",
          SOME_MNEMONIC: "d",
        }),
      ].sort(),
    ).toEqual(
      [
        "PAPER_BUILDER_ATTRIBUTION_PRESENT",
        "PAPER_CREDENTIAL_SHAPED_NAME_PRESENT",
        "PAPER_PRODUCTION_ACCOUNT_NAME_PRESENT",
        "PAPER_PRODUCTION_SECRET_NAME_PRESENT",
      ].sort(),
    );
  });

  it("NEVER prints a scanned value", () => {
    const secret = "this-string-must-never-appear-in-a-finding";
    const findings = scanEnvironmentForProductionNames({
      POLYMARKET_PRIVATE_KEY: secret,
      PROD_SIGNER_KEY: secret,
      POLY_ADDRESS: secret,
      POLYMARKET_BUILDER_CODE: secret,
    });
    expect(findings.length).toBe(4);
    for (const finding of findings) {
      expect(finding.detail).not.toContain(secret);
    }
  });

  it("reads only OWN keys: an inherited name does not refuse a start", () => {
    const inherited = Object.create({ POLYMARKET_PRIVATE_KEY: "x" }) as Record<string, string>;
    inherited["RUN_MODE"] = "PAPER";
    expect(codes(inherited)).toEqual([]);
  });
});

describe("productionNamesInText", () => {
  it("finds an enumerated name in an artifact, case-insensitively", () => {
    expect(productionNamesInText("environment:\n  - polymarket_private_key=x")).toEqual([
      "POLYMARKET_PRIVATE_KEY",
    ]);
  });

  it("finds nothing in a clean artifact", () => {
    expect(productionNamesInText('{"title":"operations (paper)"}')).toEqual([]);
  });
});
