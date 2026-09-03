/**
 * Safety and purity pins for the two WP-200 packages.
 *
 * `pnpm check:deps` enforces the IMPORT graph (F1-F16). These assertions pin
 * the properties that live inside a module rather than in its import list,
 * and that a ledger in particular must not lose:
 *
 * - no clock, no randomness, no ambient process state — identifiers and
 *   timestamps are caller-supplied, which is what makes replay deterministic
 *   (§12.4) and rebuild reproducible;
 * - no credential, signer, order-placement, or network surface exists or is
 *   representable in these APIs (`MAX_RUN_MODE=PAPER` and friends are the
 *   repository's floor; this package has nothing that could raise it);
 * - no economic value passes through a JavaScript number, anywhere.
 *
 * The source scan is deliberately textual: it fails on the SPELLING of a
 * capability, so adding one is a visible, deliberate act rather than a
 * reviewer's catch.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  Ledger,
  allocateFill,
  projectLedger,
  serializeProjection,
} from "../../../packages/ledger/src/index.js";
import {
  computePnlSnapshot,
  foldPnlRecords,
  serializePnlState,
} from "../../../packages/pnl/src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Every non-test source file of a package, recursively. */
function sourceFiles(packageDir: string): readonly string[] {
  const root = join(REPO_ROOT, "packages", packageDir, "src");
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "testing") {
          walk(full);
        }
      } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

const LEDGER_SOURCES = sourceFiles("ledger");
const PNL_SOURCES = sourceFiles("pnl");
const ALL_SOURCES = [...LEDGER_SOURCES, ...PNL_SOURCES];

/**
 * Capability spellings that must not appear in these packages' runtime source.
 * Each entry says WHY, so a future reader can tell a real violation from a
 * false positive worth re-stating.
 */
const FORBIDDEN: readonly (readonly [RegExp, string])[] = [
  [/\bDate\.now\b/u, "reads a clock; timestamps are caller-supplied (§12.4 determinism)"],
  [/\bnew Date\b/u, "reads a clock"],
  [/\bMath\.random\b/u, "unseeded randomness; identifiers are caller-minted"],
  [/\bcrypto\.randomUUID\b/u, "mints an identifier; this package validates, never generates"],
  [/\bprocess\.env\b/u, "ambient process state"],
  [/\bfetch\s*\(/u, "network I/O"],
  [/\brequire\s*\(/u, "module-loading capability (F14)"],
  [/\beval\s*\(/u, "evaluator (F14)"],
  [/\bnode:fs\b/u, "filesystem I/O"],
  [/\bnode:net\b|\bnode:http\b|\bnode:https\b/u, "network I/O"],
  [/\bprivateKey\b|\bapiSecret\b|\bpassphrase\b|\bmnemonic\b/iu, "credential surface"],
  [/\bsignOrder\b|\bplaceOrder\b|\bsubmitOrder\b/iu, "order-placement surface"],
  [/\bparseFloat\b|\bparseInt\b|\bNumber\s*\(/u, "coerces a value through a JS number"],
];

describe("the packages carry no capability they are forbidden", () => {
  it("scans a non-empty set of source files", () => {
    expect(LEDGER_SOURCES.length).toBeGreaterThan(5);
    expect(PNL_SOURCES.length).toBeGreaterThan(3);
  });

  for (const [pattern, reason] of FORBIDDEN) {
    it(`contains no ${pattern.source} — ${reason}`, () => {
      const offenders = ALL_SOURCES.filter((file) =>
        pattern.test(readFileSync(file, "utf8")),
      ).map((file) => file.slice(REPO_ROOT.length + 1));
      expect(offenders).toEqual([]);
    });
  }
});

describe("no economic value passes through a JavaScript number", () => {
  const fill = {
    fillId: "018f3a5c-5555-7000-8000-000000000001",
    marketId: "018f3a5c-1111-7000-8000-000000000001",
    environment: "PAPER",
    accountRef: "acct-paper-1",
    tokenAssetId: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
    denominationAssetId: "pUSD",
    side: "BUY",
    shares: "10",
    price: "0.4",
    source: "polymarket",
    occurredAt: "2026-09-02T12:00:00.000Z",
  };

  it("refuses a numeric fill quantity", () => {
    expect(allocateFill({ ...fill, shares: 10 }, []).ok).toBe(false);
  });

  it("refuses a numeric fill price", () => {
    expect(allocateFill({ ...fill, price: 0.4 }, []).ok).toBe(false);
  });

  it("refuses a numeric ledger entry amount", () => {
    const result = Ledger.empty("PAPER").append({
      ledgerTransactionId: "018f3a5c-4444-7000-8000-000000000001",
      eventType: "MANUAL_ADJUSTMENT",
      environment: "PAPER",
      accountRef: "acct-paper-1",
      source: "internal",
      occurredAt: "2026-09-02T12:00:00.000Z",
      entries: [
        {
          scope: "EXTERNAL_CLEARING",
          accountRef: "clearing-venue",
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: 5,
        },
      ],
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a numeric PnL amount and a numeric mark", () => {
    const owner = { scope: "ACTUAL_ACCOUNT", accountRef: "acct-paper-1" } as const;
    expect(
      foldPnlRecords(owner, [
        {
          kind: "FEE",
          ref: "018f3a5c-6666-7000-8000-000000000001",
          owner,
          denominationAsset: "pUSD",
          amount: 0.05,
        },
      ]).ok,
    ).toBe(false);

    const empty = foldPnlRecords(owner, []);
    expect(empty.ok).toBe(true);
    if (!empty.ok) {
      return;
    }
    expect(
      computePnlSnapshot(empty.value, {
        asOf: "2026-09-02T12:00:00.000Z",
        marks: { token: { midpoint: 0.5 } },
      }).ok,
    ).toBe(false);
  });
});

describe("the same inputs always produce the same outputs", () => {
  const transaction = {
    ledgerTransactionId: "018f3a5c-4444-7000-8000-000000000001",
    eventType: "DEPOSIT_OBSERVED",
    environment: "PAPER",
    accountRef: "acct-paper-1",
    source: "internal",
    occurredAt: "2026-09-02T12:00:00.000Z",
    entries: [
      {
        scope: "ACTUAL_ACCOUNT",
        accountRef: "acct-paper-1",
        assetId: "pUSD",
        assetKind: "COLLATERAL",
        amount: "100",
      },
      {
        scope: "EXTERNAL_CLEARING",
        accountRef: "clearing-venue",
        assetId: "pUSD",
        assetKind: "COLLATERAL",
        amount: "-100",
      },
      {
        scope: "UNATTRIBUTED",
        accountRef: "acct-paper-1",
        assetId: "pUSD",
        assetKind: "COLLATERAL",
        amount: "100",
      },
      {
        scope: "EXTERNAL_CLEARING",
        accountRef: "clearing-attribution",
        assetId: "pUSD",
        assetKind: "COLLATERAL",
        amount: "-100",
      },
    ],
  };

  function build(): string {
    const result = Ledger.empty("PAPER").append(transaction);
    if (!result.ok) {
      throw new Error(`append refused: ${JSON.stringify(result.refusals)}`);
    }
    return serializeProjection(projectLedger(result.value.ledger));
  }

  it("serializes a ledger projection identically across runs", () => {
    expect(build()).toBe(build());
  });

  it("serializes a PnL state identically across runs", () => {
    const owner = { scope: "ACTUAL_ACCOUNT", accountRef: "acct-paper-1" } as const;
    const records = [
      {
        kind: "FEE",
        ref: "018f3a5c-6666-7000-8000-000000000001",
        owner,
        denominationAsset: "pUSD",
        amount: "0.05",
        scheduleVersionRef: "fees-v1",
      },
    ];
    const first = foldPnlRecords(owner, records);
    const second = foldPnlRecords(owner, records);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }
    expect(serializePnlState(first.value)).toBe(serializePnlState(second.value));
  });
});
